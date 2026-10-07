#!/usr/bin/env python3
"""Batch-cut BIRTH UNITS across whole shards of the pinned V4-Flash SWE trajectories.

Why this exists (2026-10-07): `extract-birth-units.py` fetches rows through DuckDB
with `file_row_number = n`. That works on small shards but the `messages` column of
one row group is materialised as one big list-of-struct allocation — on shard 26 the
first row already needs > 900 MB and the sandbox (~2 GB) dies with rc137. Verified:
`SELECT repo, instance_id` on the same row costs ~10 MB, `SELECT …, messages` OOMs.

This scanner instead downloads a shard once to /tmp, streams it with pyarrow
`iter_batches` (2 rows at a time, messages decoded as Arrow, then converted per
row), and reuses `build_units()` from extract-birth-units.py verbatim so the unit
shape (raw / ctx / after / offlineSignals / notes) stays byte-identical to the
sample already cut.

Diversity caps keep the forgery workload sane: max units per row, per repo, and a
per-shard share of the total cap. Nothing here claims E1/E2: those still require
running the target model with the compressed block fed back → 未测.

Usage:
  PYTHONPATH=/tmp/ddb python3 tools/micro-generator/scan-birth-units.py \
      --shards 25,26 --total-cap 160 --out <path.jsonl> --manifest <path.json>
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# import the pinned extractor (dashed filename ⇒ importlib)
_spec = importlib.util.spec_from_file_location("birth_extract", HERE / "extract-birth-units.py")
birth = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(birth)

COLUMNS = ["repo", "instance_id", "trajectory_id", "license", "messages", "metadata"]
BATCH_ROWS = 2  # messages per batch decoded as Arrow before conversion


def download(url: str, dest: Path) -> float:
    t0 = time.time()
    subprocess.run(["curl", "-sSL", "--fail", "-o", str(dest), url], check=True)
    return round(time.time() - t0, 1)


def scan_shard(shard: int, per_shard_cap: int, min_raw_chars: int, max_units_per_row: int,
               repo_counts: dict, repo_cap: int, row_limit: int | None, keep: bool, log) -> dict:
    import pyarrow.parquet as pq

    url = birth.SHARD_URL.format(index=shard)
    local = Path(f"/tmp/shard{shard}.parquet")
    stats = {"shard": shard, "url": url, "downloadSeconds": None, "rowsScanned": 0,
             "rowsWithUnits": 0, "unitsFound": 0, "reposWithUnits": {}, "licensesFound": {},
             "reposKept": [], "licenses": {}, "stoppedEarly": False}
    if keep and local.exists():
        log(f"shard {shard}: reuse {local} ({local.stat().st_size // 1048576} MB)")
        stats["downloadSeconds"] = 0.0
    else:
        stats["downloadSeconds"] = download(url, local)
        log(f"shard {shard}: downloaded {local.stat().st_size // 1048576} MB in {stats['downloadSeconds']}s")

    t0 = time.time()
    units: list[dict] = []
    rowid = -1
    pf = pq.ParquetFile(local)
    for batch in pf.iter_batches(batch_size=BATCH_ROWS, columns=COLUMNS):
        for row in batch.to_pylist():
            rowid += 1
            if row_limit is not None and rowid >= row_limit:
                stats["stoppedEarly"] = True
                break
            stats["rowsScanned"] += 1
            repo = row.get("repo") or "?"
            # 普查：每行都跑 build_units，命中的单元计数；只有未触「每仓/每 shard」上限的才落盘。
            got = birth.build_units(row, shard, rowid, max_units_per_row, min_raw_chars)
            if not got:
                continue
            stats["rowsWithUnits"] += 1
            stats["unitsFound"] += len(got)
            stats["reposWithUnits"][repo] = stats["reposWithUnits"].get(repo, 0) + len(got)
            lic = row.get("license") or "unknown"
            stats["licensesFound"][lic] = stats["licensesFound"].get(lic, 0) + len(got)
            for unit in got:
                if len(units) >= per_shard_cap or repo_counts.get(repo, 0) >= repo_cap:
                    continue
                units.append(unit)
                repo_counts[repo] = repo_counts.get(repo, 0) + 1
                stats["reposKept"].append(repo)
                stats["licenses"][lic] = stats["licenses"].get(lic, 0) + 1
        if stats["stoppedEarly"]:
            break
    stats["decodeSeconds"] = round(time.time() - t0, 1)
    stats["units"] = units
    # 每仓计数降序，最多留 60 个（清单用；避免 manifest 膨胀）
    stats["reposWithUnits"] = dict(sorted(stats["reposWithUnits"].items(), key=lambda kv: -kv[1])[:60])
    log(f"shard {shard}: scanned {stats['rowsScanned']} rows, {stats['rowsWithUnits']} with units, "
        f"{stats['unitsFound']} units found ⇒ kept {len(units)} ({stats['decodeSeconds']}s decode)")
    if not keep:
        local.unlink(missing_ok=True)
    return stats


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--shards", default="25,26,27,28,29,30,31,32,33")
    p.add_argument("--out", required=True)
    p.add_argument("--manifest", default="")
    p.add_argument("--total-cap", type=int, default=160)
    p.add_argument("--min-raw-chars", type=int, default=1500)
    p.add_argument("--max-units-per-row", type=int, default=1)
    p.add_argument("--repo-cap", type=int, default=2)
    p.add_argument("--row-limit", type=int, default=None, help="stop each shard after N rows (smoke test)")
    p.add_argument("--keep-parquet", action="store_true")
    args = p.parse_args()

    shards = [int(x) for x in args.shards.split(",") if x.strip()]
    per_shard_cap = max(1, args.total_cap // max(1, len(shards)))
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)

    log_lines: list[str] = []

    def log(msg: str) -> None:
        print(msg, flush=True)
        log_lines.append(msg)

    started = time.time()
    repo_counts: dict[str, int] = {}
    all_units: list[dict] = []
    per_shard: list[dict] = []

    for shard in shards:
        stats = scan_shard(shard, per_shard_cap, args.min_raw_chars, args.max_units_per_row,
                           repo_counts, args.repo_cap, args.row_limit, args.keep_parquet, log)
        units = stats.pop("units")
        all_units.extend(units)
        per_shard.append(stats)
        # free disk between shards unless told to keep
        if not args.keep_parquet:
            Path(f"/tmp/shard{shard}.parquet").unlink(missing_ok=True)
        if len(all_units) >= args.total_cap:
            log(f"total cap {args.total_cap} reached; stopping")
            break

    with out_path.open("w", encoding="utf-8") as fh:
        for unit in all_units:
            fh.write(json.dumps(unit, ensure_ascii=False) + "\n")

    manifest = {
        "schema": "cfb.birth-units-scan/2",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {"dataset": birth.DATASET, "revision": birth.REVISION, "config": birth.CONFIG, "split": birth.SPLIT},
        "args": {k: getattr(args, k) for k in ("shards", "total_cap", "min_raw_chars", "max_units_per_row", "repo_cap", "row_limit")},
        "totals": {
            "units": len(all_units),
            "rowsScanned": sum(s["rowsScanned"] for s in per_shard),
            "repos": len({u["source"]["repository"] for u in all_units}),
            "unitsFoundCensus": sum(s["unitsFound"] for s in per_shard),
            "rowsWithUnitsCensus": sum(s["rowsWithUnits"] for s in per_shard),
            "licenses": {},
            "elapsedSeconds": round(time.time() - started, 1),
        },
        "perShard": per_shard,
        "notes": [
            "units are byte-shape-identical to extract-birth-units.py output (build_units reused verbatim)",
            "E1/E2 remain 未测: they need the target model to be run with the compressed block fed back",
            "after.* is an offline continuation proxy over the next 6 messages; not a real-machine reading",
        ],
    }
    for unit in all_units:
        lic = unit["source"].get("repositoryLicense") or "unknown"
        manifest["totals"]["licenses"][lic] = manifest["totals"]["licenses"].get(lic, 0) + 1

    if args.manifest:
        mpath = Path(args.manifest)
        if not mpath.is_absolute():
            mpath = ROOT / mpath
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (mpath.with_suffix(".log")).write_text("\n".join(log_lines) + "\n", encoding="utf-8")

    log(f"wrote {len(all_units)} units to {out_path} ({out_path.stat().st_size // 1024} KB) "
        f"in {manifest['totals']['elapsedSeconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
