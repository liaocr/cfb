#!/usr/bin/env python3
"""Build compact CFB scenario bundles from pinned DeepSeek-V4-Flash SWE trajectories.

Source: nvidia/Open-SWE-Traces@f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef, config v1.1,
split openhands, shards 25-33 (the only shards carrying `metadata.teacher_model.name =
"DeepSeek-V4-Flash"` rows; 21,208 rows, all Python, all permissive licenses).

Each bundle is a *scenario*: the task context plus a condensed step-by-step trace
(assistant reasoning digest, tool command, head/tail of tool output). Bundles are the
raw material from which a model-agnostic progress-state draft (the gold target) is
written; they are deliberately lossy and record exactly what was dropped.

Memory note: parquet shards are hundreds of MB, so rows are read with LIMIT per shard
and the parent process only writes files.

Usage:
  python3 extract-v4flash-scenarios.py --shards 25,29,33 --per-shard 60 --want 24
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

REVISION = "f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef"
DATASET = "nvidia/Open-SWE-Traces"
CONFIG = "v1.1"
SPLIT = "openhands"
SHARD_URL = "https://huggingface.co/api/datasets/" + DATASET + "/parquet/" + CONFIG + "/" + SPLIT + "/{index}.parquet"
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "transfer/models/micro-generator-v4flash-scenarios"

MAX_STEPS = 40
MAX_CTX_CHARS = 3000
MAX_REASONING_DIGEST = 260
MAX_OUTPUT_LINES_HEAD = 6
MAX_OUTPUT_LINES_TAIL = 6
MAX_OUTPUT_CHARS = 1200

TEST_HINT = re.compile(r"\b(pytest|unittest|tox|python -m pytest|\./run_tests|run_tests\.sh|nosetests)\b", re.I)
VERDICT_HINT = re.compile(r"(\d+ (passed|failed|error)|PASSED|FAILED|OK\b|FAILED\b|AssertionError|Traceback)", re.I)


def duckdb_connect():
    import duckdb

    con = duckdb.connect()
    con.execute("SET extension_directory='/tmp/ddb/ext'; SET home_directory='/tmp/ddb';")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET memory_limit='1400MB'; SET threads=1; SET preserve_insertion_order=false;")
    return con


def row_sha256(row: dict) -> str:
    canonical = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def clip(text: str | None, limit: int) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n")
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return text[:head].rstrip() + f"\n…[{len(text) - limit} chars omitted]…\n" + text[-(limit - head):].lstrip()


def output_digest(text: str | None) -> tuple[str, int]:
    """Head/tail digest of a tool output; returns (text, omitted_line_count)."""
    if not text:
        return "", 0
    lines = text.replace("\r\n", "\n").split("\n")
    kept = lines
    omitted = 0
    if len(lines) > MAX_OUTPUT_LINES_HEAD + MAX_OUTPUT_LINES_TAIL:
        kept = lines[:MAX_OUTPUT_LINES_HEAD] + [f"…[{len(lines) - MAX_OUTPUT_LINES_HEAD - MAX_OUTPUT_LINES_TAIL} lines omitted]…"] + lines[-MAX_OUTPUT_LINES_TAIL:]
        omitted = len(lines) - MAX_OUTPUT_LINES_HEAD - MAX_OUTPUT_LINES_TAIL
    return clip("\n".join(kept), MAX_OUTPUT_CHARS), omitted


def build_bundle(row: dict, shard_index: int, row_index: int) -> dict:
    messages = row["messages"] or []
    steps: list[str] = []
    step_no = 0
    for message in messages:
        role = message.get("role")
        if role == "assistant":
            step_no += 1
            if step_no > MAX_STEPS:
                steps.append(f"…[{len([m for m in messages if m.get('role') == 'assistant']) - MAX_STEPS} later assistant steps omitted]…")
                break
            reasoning = clip(message.get("reasoning_content") or "", MAX_REASONING_DIGEST)
            visible = clip(message.get("content") or "", 400)
            lines = [f"--- step {step_no} ---"]
            if reasoning:
                lines.append(f"[thinking] {reasoning}")
            if visible:
                lines.append(f"[say] {visible}")
            for call in message.get("tool_calls") or []:
                fn = (call or {}).get("function") or {}
                name = fn.get("name") or "tool"
                args = clip(fn.get("arguments") or "", 400)
                lines.append(f"[call:{name}] {args}")
            steps.append("\n".join(lines))
        elif role == "tool":
            digest, omitted = output_digest(message.get("content"))
            note = f" ({omitted} lines omitted)" if omitted else ""
            steps.append(f"[result{note}]\n{digest}")

    ctx_parts = []
    for message in messages:
        if message.get("role") == "user":
            ctx_parts.append(clip(message.get("content") or "", MAX_CTX_CHARS))
            break
    ctx = "\n".join(ctx_parts)

    test_evidence = sum(1 for m in messages if m.get("role") == "tool" and TEST_HINT.search(m.get("content") or ""))
    verdict_evidence = sum(1 for m in messages if m.get("role") == "tool" and VERDICT_HINT.search(m.get("content") or ""))
    assistant_steps = sum(1 for m in messages if m.get("role") == "assistant")
    reasoning_chars = sum(len(m.get("reasoning_content") or "") for m in messages if m.get("role") == "assistant")
    model_patch = ((row.get("metadata") or {}).get("model_patch") or {}).get("patch") or ""

    return {
        "scenarioId": row.get("trajectory_id"),
        "source": {
            "dataset": DATASET,
            "revision": REVISION,
            "config": CONFIG,
            "split": SPLIT,
            "shardUrl": SHARD_URL.format(index=shard_index),
            "rowIndexInShard": row_index,
            "repository": row.get("repo"),
            "instanceId": row.get("instance_id"),
            "repositoryLicense": row.get("license"),
            "language": row.get("language"),
            "rowSha256": row_sha256(row),
        },
        "traceStats": {
            "assistantSteps": assistant_steps,
            "messages": len(messages),
            "reasoningChars": reasoning_chars,
            "testToolOutputs": test_evidence,
            "verdictToolOutputs": verdict_evidence,
            "modelPatchChars": len(model_patch),
            "resolvedField": row.get("resolved"),
            "teacherModel": ((row.get("metadata") or {}).get("teacher_model") or {}).get("name"),
            "reasoningEffort": ((row.get("metadata") or {}).get("teacher_model") or {}).get("reasoning_effort"),
        },
        "ctx": ctx,
        "steps": "\n".join(steps),
        "curation": {
            "stepsIncluded": min(assistant_steps, MAX_STEPS),
            "reasoningDigestCharsPerStep": MAX_REASONING_DIGEST,
            "toolOutputKept": f"head {MAX_OUTPUT_LINES_HEAD} / tail {MAX_OUTPUT_LINES_TAIL} lines, max {MAX_OUTPUT_CHARS} chars",
            "ctxCharsKept": MAX_CTX_CHARS,
            "note": "Lossy condensation for drafting. The full row remains identified by rowSha256; nothing here is a verbatim complete trajectory.",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards", default="25,29,33")
    parser.add_argument("--per-shard", type=int, default=4)
    parser.add_argument("--want", type=int, default=24)
    parser.add_argument("--min-steps", type=int, default=10)
    parser.add_argument("--min-verdict-outputs", type=int, default=2)
    args = parser.parse_args()

    con = duckdb_connect()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bundles: list[dict] = []
    seen_repos: set[str] = set()
    summary: list[dict] = []
    chunk = 250

    # Phase A is cheap: one list_count per row, read in bounded chunks so the scan never
    # materialises a whole shard. Phase B fetches single rows, one at a time.
    chunk_sql = """
    SELECT file_row_number, repo, license, instance_id, trajectory_id,
           list_count(list_filter(messages, m -> m.role='assistant')) AS n_asst
    FROM read_parquet('{url}', file_row_number=true)
    WHERE metadata.teacher_model.name='DeepSeek-V4-Flash'
      AND file_row_number >= {lo} AND file_row_number < {hi}
    """
    fetch_sql = ("SELECT repo, instance_id, trajectory_id, license, language, messages, resolved, metadata "
                 "FROM read_parquet('{url}', file_row_number=true) WHERE file_row_number = {rowid}")

    for shard_index in [int(x) for x in args.shards.split(",")]:
        url = SHARD_URL.format(index=shard_index)
        print(f"shard {shard_index}: phase A screening", flush=True)
        candidates: list[tuple] = []
        lo = 0
        empty_chunks = 0
        while len(candidates) < args.per_shard * 6 and empty_chunks < 2 and lo < 20000:
            try:
                rows = con.execute(chunk_sql.format(url=url, lo=lo, hi=lo + chunk)).fetchall()
            except Exception as exc:  # noqa: BLE001
                print(f"  chunk {lo} failed: {type(exc).__name__}: {str(exc)[:100]}", flush=True)
                break
            rows = [r for r in rows if (r[1] or "") not in seen_repos and r[5] >= args.min_steps]
            rows.sort(key=lambda r: r[5], reverse=True)
            candidates.extend(rows)
            empty_chunks = empty_chunks + 1 if not rows else 0
            lo += chunk
            print(f"  chunk [{lo - chunk},{lo}) -> {len(rows)} candidates", flush=True)
            time.sleep(0.3)
        print(f"  phase A kept {len(candidates)} candidate rows", flush=True)

        picked = 0
        for candidate in candidates:
            if picked >= args.per_shard or len(bundles) >= args.want:
                break
            rowid, repo = candidate[0], candidate[1]
            if repo in seen_repos:
                continue
            try:
                values = con.execute(fetch_sql.format(url=url, rowid=rowid)).fetchone()
            except Exception as exc:  # noqa: BLE001
                print(f"  fetch row {rowid} failed: {type(exc).__name__}", flush=True)
                continue
            if values is None:
                continue
            columns = ["repo", "instance_id", "trajectory_id", "license", "language", "messages", "resolved", "metadata"]
            data = dict(zip(columns, values))
            bundle = build_bundle(data, shard_index, rowid)
            stats = bundle["traceStats"]
            if stats["verdictToolOutputs"] < args.min_verdict_outputs or stats["modelPatchChars"] <= 0:
                print(f"  row {rowid} rejected: verdicts={stats['verdictToolOutputs']} patch={stats['modelPatchChars']}", flush=True)
                continue
            bundles.append(bundle)
            summary.append({
                "scenarioId": bundle["scenarioId"],
                "repo": repo,
                "license": candidate[2],
                "steps": stats["assistantSteps"],
                "reasoningChars": stats["reasoningChars"],
                "testOutputs": stats["testToolOutputs"],
                "verdictOutputs": stats["verdictToolOutputs"],
                "patchChars": stats["modelPatchChars"],
                "shard": shard_index,
                "fileRowNumber": rowid,
            })
            seen_repos.add(repo)
            picked += 1
        time.sleep(1)
        if len(bundles) >= args.want:
            break

    with (OUT_DIR / "scenarios.jsonl").open("w", encoding="utf-8") as handle:
        for bundle in bundles:
            handle.write(json.dumps(bundle, ensure_ascii=False) + "\n")
    (OUT_DIR / "candidates.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(bundles)} bundles to {OUT_DIR}")
    for item in summary:
        print(f"  {item['repo']:<38} steps={item['steps']:<3} reason={item['reasoningChars']:<7} tests={item['testOutputs']:<3} verdicts={item['verdictOutputs']:<3} patch={item['patchChars']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
