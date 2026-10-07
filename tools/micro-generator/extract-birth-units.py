#!/usr/bin/env python3
"""Cut BIRTH UNITS from pinned DeepSeek-V4-Flash SWE trajectories.

Correct grain for the CFB micro-compiler: in production the compressor sees one
`reasoning` block at the moment it is born, together with whatever context the
model had in front of it, and must emit the compressed block that the same model
will read back on later turns. So one training/inspection unit is:

  raw   = one assistant message's verbatim `reasoning_content`
  ctx   = the context visible at that moment (task prompt + preceding actions and
          tool outputs, clipped)
  after = what actually happened next in the same trajectory (compressed), used
          ONLY as an offline retention proxy — it is not the real-machine check.

Gold axes E1/E2 ("fixed in <=6 rounds", "not worse than raw") cannot be computed
from this data: they require running the target model with the compressed block
fed back. Every unit produced here is therefore `未测` on E1/E2.

Source: nvidia/Open-SWE-Traces@f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef, v1.1/openhands,
shards 25-33 (DeepSeek-V4-Flash rows only).

Usage:
  python3 extract-birth-units.py --shards 25 --row 0 --max-units 3 --out /tmp/units.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

REVISION = "f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef"
DATASET = "nvidia/Open-SWE-Traces"
CONFIG = "v1.1"
SPLIT = "openhands"
SHARD_URL = f"https://huggingface.co/api/datasets/{DATASET}/parquet/{CONFIG}/{SPLIT}/{{index}}.parquet"
ROOT = Path(__file__).resolve().parents[2]

MIN_RAW_CHARS = 1200          # below this a block is not worth compressing (host uses 3100/1800/1200 adaptive floors)
CTX_BUDGET = 4000             # chars of preceding context kept verbatim-ish
AFTER_STEPS = 6               # continuation steps recorded as the offline proxy
AFTER_CLIP = 400              # chars per continuation step
VERDICT_RE = re.compile(r"(?i)(\d+ (passed|failed|error)|passed\b|failed\b|traceback|assertionerror|ok\b)")
IDENT_RE = re.compile(r"`[^`\n]{2,60}`|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z]{2,6}|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]*\b")


def duckdb_connect():
    import duckdb

    con = duckdb.connect()
    con.execute("SET extension_directory='/tmp/ddb/ext'; SET home_directory='/tmp/ddb';")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    # 2026-10-07: 1400MB 在本沙箱（~2GB）上对较大 shard 会 rc137 OOM；352MB + 磁盘溢写稳定通过。
    con.execute("SET memory_limit='384MB'; SET threads=1; SET preserve_insertion_order=false;")
    con.execute("SET temp_directory='/tmp/ddb/tmp';")
    return con


def clip(text: str | None, limit: int) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n")
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return text[:head].rstrip() + f"\n…[{len(text) - limit} chars omitted]…\n" + text[-max(limit - head, 0):].lstrip()


def flatten_ctx(messages: list[dict], upto: int) -> str:
    """Context the model had when message[index] was being produced: task + everything before it."""
    parts: list[str] = []
    for message in messages[:upto]:
        role = message.get("role")
        if role == "system":
            continue  # harness scaffolding, not the task; kept out of ctx on purpose
        if role == "user":
            parts.append("[task]\n" + (message.get("content") or ""))
        elif role == "assistant":
            calls = []
            for call in message.get("tool_calls") or []:
                fn = (call or {}).get("function") or {}
                calls.append(f"{fn.get('name') or 'tool'}({clip(fn.get('arguments') or '', 160)})")
            if calls:
                parts.append("[did] " + "; ".join(calls))
        elif role == "tool":
            parts.append("[got] " + clip(message.get("content") or "", 500))
    joined = "\n".join(parts)
    if len(joined) <= CTX_BUDGET:
        return joined
    # keep the task head and the most recent history tail
    head = joined[: CTX_BUDGET // 3]
    tail = joined[-CTX_BUDGET * 2 // 3:]
    return head.rstrip() + "\n…[middle of the visible history omitted]…\n" + tail.lstrip()


def continuation_summary(messages: list[dict], after: int) -> dict:
    steps: list[str] = []
    commands: list[str] = []
    verdicts: list[str] = []
    files: list[str] = []
    for message in messages[after:after + AFTER_STEPS]:
        role = message.get("role")
        if role == "assistant":
            for call in message.get("tool_calls") or []:
                fn = (call or {}).get("function") or {}
                args = clip(fn.get("arguments") or "", AFTER_CLIP)
                steps.append(f"[call:{fn.get('name') or 'tool'}] {args}")
                commands.extend(re.findall(r"(?:cd [^\s\"]+ && )?[a-z0-9_.\-/]+ (?:-m )?[a-z0-9_.\-]+[^\n\"]{0,80}", args or "")[:4])
                files.extend(re.findall(r"[\w./\-]+\.(?:py|md|txt|json|cfg|toml|yaml|yml)", args or "")[:6])
            say = clip(message.get("content") or "", AFTER_CLIP)
            if say:
                steps.append(f"[say] {say}")
        elif role == "tool":
            body = message.get("content") or ""
            steps.append("[result] " + clip(body, AFTER_CLIP))
            for line in body.split("\n"):
                if VERDICT_RE.search(line):
                    verdicts.append(clip(line, 160))
    return {
        "steps": steps,
        "signals": {
            "commands": sorted(set(commands))[:8],
            "verdicts": verdicts[:8],
            "filePaths": sorted(set(files))[:10],
        },
    }


def build_units(row: dict, shard_index: int, rowid: int, max_units: int, min_raw_chars: int) -> list[dict]:
    messages = row["messages"] or []
    units: list[dict] = []
    step = 0
    for index, message in enumerate(messages):
        if message.get("role") != "assistant":
            continue
        step += 1
        raw = message.get("reasoning_content") or ""
        if len(raw) < min_raw_chars:
            continue
        if not (message.get("tool_calls") or message.get("content")):
            continue  # a block that produced no action/answer is not a compression candidate
        after = continuation_summary(messages, index + 1)
        ctx = flatten_ctx(messages, index)
        units.append({
            "unitId": f"{row.get('instance_id')}#b{step}",
            "source": {
                "dataset": DATASET,
                "revision": REVISION,
                "config": CONFIG,
                "split": SPLIT,
                "shardUrl": SHARD_URL.format(index=shard_index),
                "fileRowNumber": rowid,
                "repository": row.get("repo"),
                "repositoryLicense": row.get("license"),
                "instanceId": row.get("instance_id"),
                "trajectoryId": row.get("trajectory_id"),
                "teacherModel": ((row.get("metadata") or {}).get("teacher_model") or {}).get("name"),
                "reasoningEffort": ((row.get("metadata") or {}).get("teacher_model") or {}).get("reasoning_effort"),
            },
            "birthStep": step,
            "raw": raw,
            "rawChars": len(raw),
            "ctx": ctx,
            "ctxChars": len(ctx),
            "visibleAtBirth": {
                "contentChars": len(message.get("content") or ""),
                "toolCalls": [((c or {}).get("function") or {}).get("name") for c in (message.get("tool_calls") or [])],
            },
            "after": after,
            "offlineSignals": {
                "identifiersInRaw": sorted(set(IDENT_RE.findall(raw)))[:40],
                "verdictLinesInRaw": [clip(l, 160) for l in raw.split("\n") if VERDICT_RE.search(l)][:8],
            },
            "notes": {
                "e1e2": "未测 — fixedAtRound / vsRaw require running the target model with the compressed block fed back",
                "rawIsVerbatim": True,
                "ctxIsClipped": True,
                "afterIsOfflineProxyOnly": True,
            },
        })
        if len(units) >= max_units:
            break
    return units


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards", default="25")
    parser.add_argument("--rows", default="0", help="comma-separated file_row_number values")
    parser.add_argument("--max-units", type=int, default=3)
    parser.add_argument("--min-raw-chars", type=int, default=MIN_RAW_CHARS)
    parser.add_argument("--out", default="/tmp/birth-units.jsonl")
    args = parser.parse_args()

    con = duckdb_connect()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with out_path.open("w", encoding="utf-8") as handle:
        for shard_index in [int(x) for x in args.shards.split(",")]:
            url = SHARD_URL.format(index=shard_index)
            for rowid in [int(x) for x in args.rows.split(",")]:
                fetch = ("SELECT repo, instance_id, trajectory_id, license, language, messages, resolved, metadata "
                         f"FROM read_parquet('{url}', file_row_number=true) WHERE file_row_number = {rowid}")
                values = con.execute(fetch).fetchone()
                if values is None:
                    print(f"shard {shard_index} row {rowid}: not found", flush=True)
                    continue
                columns = ["repo", "instance_id", "trajectory_id", "license", "language", "messages", "resolved", "metadata"]
                row = dict(zip(columns, values))
                units = build_units(row, shard_index, rowid, args.max_units, args.min_raw_chars)
                for unit in units:
                    handle.write(json.dumps(unit, ensure_ascii=False) + "\n")
                written += len(units)
                print(f"shard {shard_index} row {rowid} ({row['repo']}): {len(units)} units", flush=True)
                for unit in units:
                    print(f"   {unit['unitId']:<44} raw={unit['rawChars']:<6} ctx={unit['ctxChars']:<5} "
                          f"after={len(unit['after']['steps'])} steps, "
                          f"{len(unit['after']['signals']['verdicts'])} verdicts, "
                          f"{len(unit['offlineSignals']['identifiersInRaw'])} identifiers", flush=True)
                time.sleep(0.5)
    print(f"wrote {written} birth units to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
