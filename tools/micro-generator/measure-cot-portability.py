#!/usr/bin/env python3
"""Measure how transferable published coding-agent chain-of-thought (CoT) is.

Reads pinned NVIDIA Open-SWE-Traces parquet shards over HTTP and reports, per
(model, harness) cell: trajectory counts, assistant turns, reasoning characters,
visible content characters, and stylistic markers inside the reasoning channel.

Marker statistics concatenate each assistant message's reasoning text, falling back to
the visible content text in cells where the model did not use a reasoning channel.

The comparison cells hold two axes fixed at a time:
  * same harness + same task sources, different model family  -> v1.1/openhands
  * same harness + same task sources, different model version -> minisweagent v1.1 vs v1.2
That is evidence about CoT portability across models and versions; it is not
evidence about DeepSeek-V4.1-Flash, whose CoT is not published.

Memory note: each parquet shard is hundreds of megabytes, so every shard is
measured in its own short-lived subprocess (one row-group limit plus projection).
Parent process only aggregates numbers.

Requires: duckdb, network access to huggingface.co. No model API is used.
Usage:
  python3 measure-cot-portability.py            # supervise all cells, write JSON
  python3 measure-cot-portability.py --one URL  # measure a single shard, print JSON
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REVISION = "f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef"
DATASET = "nvidia/Open-SWE-Traces"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "transfer/models/micro-generator-target-model-survey/cot-portability.json"
LOG = ROOT / "transfer/models/micro-generator-target-model-survey/run.log"

SHARDS = "https://huggingface.co/api/datasets/{ds}/parquet/{config}/{split}"

CELLS = [
    ("v1.1/openhands", "v1.1", "openhands"),
    ("v1.1/minisweagent", "v1.1", "minisweagent"),
    ("v1.2/minisweagent", "v1.2", "minisweagent"),
    ("v1.0/openhands", "v1.0", "openhands"),
]

MARKERS = {
    "wait": r"\bwait\b",
    "let_me": r"\blet me\b",
    "actually": r"\bactually\b",
    "hmm": r"\bhmm+\b",
    "therefore": r"\btherefore\b",
    "i_actions": r"\bi (should|need to|will|'ll)\b",
    "test_words": r"\btests?\b",
    "error_words": r"\berrors?\b",
    "verify": r"\bverif(y|ies|ication)\b",
    "fence": r"```",
    "cjk": r"[\u4e00-\u9fff]",
}

SAMPLE_ROWS_PER_SHARD = 80
SHARDS_PER_CELL = 12

PER_SHARD_SQL = """
WITH sampled AS (
  SELECT metadata.teacher_model.name AS teacher, messages
  FROM read_parquet('{url}')
  LIMIT {limit}
)
SELECT teacher,
       count(*) AS traj,
       sum(list_count(list_filter(messages, m -> m.role='assistant'))) AS assistant_msgs,
       sum(list_reduce(list_transform(messages, m -> CASE WHEN m.role='assistant' THEN coalesce(length(m.reasoning_content),0) ELSE 0 END), (a,b)->a+b, 0)) AS reasoning_chars,
       sum(list_reduce(list_transform(messages, m -> CASE WHEN m.role='assistant' THEN coalesce(length(m.content),0) ELSE 0 END), (a,b)->a+b, 0)) AS content_chars
FROM sampled
GROUP BY 1
"""

MARKER_SQL = """
SELECT metadata.teacher_model.name AS teacher,
       list_reduce(list_transform(messages, m -> CASE WHEN m.role='assistant' THEN coalesce(m.reasoning_content,'') || CASE WHEN coalesce(m.reasoning_content,'')='' THEN coalesce(m.content,'') ELSE '' END ELSE '' END), (a,b)->a||b, '') AS text
FROM read_parquet('{url}')
LIMIT {limit}
"""


def log(message: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%H:%M:%S')} {message}\n")
    print(message, flush=True)


def http_json(url: str, tries: int = 6) -> object:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "cfb-cot-portability/1.0"})
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"persistent failure for {url}: {last!r}")


def shard_urls(config: str, split: str) -> list[str]:
    return list(http_json(SHARDS.format(ds=DATASET, config=config, split=split)))


def spread(urls: list[str], count: int) -> list[str]:
    if len(urls) <= count:
        return urls
    step = len(urls) / count
    return [urls[min(int(index * step), len(urls) - 1)] for index in range(count)]


def measure_one(url: str) -> dict:
    import duckdb

    connection = duckdb.connect()
    connection.execute("INSTALL httpfs; LOAD httpfs;")
    connection.execute("SET memory_limit='1300MB'; SET threads=1; SET enable_object_cache=false; SET preserve_insertion_order=false;")
    stats = connection.execute(PER_SHARD_SQL.format(url=url, limit=SAMPLE_ROWS_PER_SHARD)).fetchall()
    markers: dict[str, dict] = {}
    rows = connection.execute(MARKER_SQL.format(url=url, limit=SAMPLE_ROWS_PER_SHARD)).fetchall()
    per_teacher: dict[str, list[str]] = {}
    for teacher, text in rows:
        per_teacher.setdefault(teacher or "unknown", []).append(text or "")
    for teacher, texts in per_teacher.items():
        blob = "\n".join(texts)
        counts = {name: len(re.findall(pattern, blob, flags=re.IGNORECASE)) for name, pattern in MARKERS.items()}
        markers[teacher] = {
            "sampleRows": len(texts),
            "sampleChars": len(blob),
            "per100kChars": {name: round(100000 * value / max(len(blob), 1), 2) for name, value in counts.items()},
        }
    connection.close()
    return {"url": url, "stats": stats, "markers": markers}


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--one":
        print(json.dumps(measure_one(sys.argv[2]), ensure_ascii=False))
        return 0

    results: dict[str, dict] = {"revision": REVISION, "dataset": DATASET, "protocol": {
        "sampledRowsPerShard": SAMPLE_ROWS_PER_SHARD,
        "shardsSampledPerCell": SHARDS_PER_CELL,
        "note": "Rows sampled with LIMIT from evenly spaced shards; counts are sample-derived, not full-corpus totals.",
    }, "cells": {}}
    for label, config, split in CELLS:
        urls = shard_urls(config, split)
        selected = spread(urls, SHARDS_PER_CELL)
        log(f"cell {label}: {len(urls)} shards total, sampling {len(selected)}")
        by_teacher: dict[str, dict] = {}
        markers: dict[str, dict] = {}
        failures: list[str] = []
        for index, url in enumerate(selected, start=1):
            try:
                completed = subprocess.run(
                    [sys.executable, __file__, "--one", url],
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
                if completed.returncode != 0:
                    failures.append(f"shard {index}: rc={completed.returncode} {completed.stderr.strip()[-120:]}")
                    log(f"  shard {index}/{len(selected)} failed rc={completed.returncode}")
                    continue
                payload = json.loads(completed.stdout.strip().splitlines()[-1])
            except Exception as exc:  # noqa: BLE001
                failures.append(f"shard {index}: {type(exc).__name__}: {str(exc)[:100]}")
                log(f"  shard {index}/{len(selected)} failed {type(exc).__name__}")
                continue
            for teacher, traj, assistant, reasoning, content in payload["stats"]:
                cell = by_teacher.setdefault(teacher or "unknown", {"trajectories": 0, "assistantTurns": 0, "reasoningChars": 0, "visibleContentChars": 0})
                cell["trajectories"] += traj
                cell["assistantTurns"] += assistant or 0
                cell["reasoningChars"] += reasoning or 0
                cell["visibleContentChars"] += content or 0
            for teacher, marker in payload["markers"].items():
                target = markers.setdefault(teacher, {"sampleRows": 0, "sampleChars": 0, "weighted": {}})
                target["sampleRows"] += marker["sampleRows"]
                target["sampleChars"] += marker["sampleChars"]
                for name, value in marker["per100kChars"].items():
                    target["weighted"][name] = target["weighted"].get(name, 0.0) + value * marker["sampleChars"]
            log(f"  shard {index}/{len(selected)} ok")
            time.sleep(1)
        for teacher, cell in by_teacher.items():
            traj = max(cell["trajectories"], 1)
            cell["meanAssistantTurns"] = round(cell["assistantTurns"] / traj, 2)
            cell["meanReasoningCharsPerTrajectory"] = round(cell["reasoningChars"] / traj, 1)
            cell["meanReasoningCharsPerAssistantTurn"] = round(cell["reasoningChars"] / max(cell["assistantTurns"], 1), 1)
            cell["meanVisibleContentCharsPerTrajectory"] = round(cell["visibleContentChars"] / traj, 1)
        for teacher, marker in markers.items():
            total = max(marker["sampleChars"], 1)
            marker["per100kChars"] = {name: round(value / total, 2) for name, value in marker["weighted"].items()}
            marker.pop("weighted")
        results["cells"][label] = {
            "config": config,
            "split": split,
            "shardsTotal": len(urls),
            "shardsSampled": len(selected),
            "failedShards": failures,
            "byTeacherModel": by_teacher,
            "reasoningMarkers": markers,
        }
        log("  " + json.dumps(by_teacher, ensure_ascii=False))
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
