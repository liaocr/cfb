#!/usr/bin/env python3
"""合并多个教师语料目录 → 一个训练语料（保持固定评测集的仓库隔离）。

为什么要它：语料会分批产出（v3、batch3、batch4…）。判读/评测必须用**固定的**
dev 集（跨轮可比），而每一批新语料的 train 行可以持续并入训练集——
但新语料的 dev 行不能并入（教师按仓库哈希划 dev，跨批次会重合）。

规则（机械、可审计）：
  1. eval（评测集）= --eval-dir 的 dev.jsonl.gz，原样保留；
  2. train = 各源目录 train.jsonl.gz 的全部行 + 各源目录 dev 中「全轴通过且仓库不在 eval」的行，
     按 unitId 去重；
  3. nonconforming = 各源目录 train-nonconforming + 各源 dev 中不合规的行；
  4. 硬校验：合并后 train 与 eval 的仓库交集必须为 0，否则**中止**；
  5. 报告写 corpus-report.json（含来源 sha256、逐轴统计、隔离校验结果）。

用法：
  python3 merge-corpora.py --eval-dir transfer/models/micro-generator-gen-v3 \
    --source transfer/models/micro-generator-gen-v3 \
    --source transfer/models/micro-generator-gen-batch3 \
    --out transfer/models/micro-generator-gen-v4
"""
from __future__ import annotations

import argparse, gzip, hashlib, json, statistics, sys, time
from pathlib import Path

AXES = ["M1", "M3", "M4", "M5", "M6", "M7", "M8"]


def read_rows(p: Path):
    if not p.exists():
        return []
    with gzip.open(p, "rt") as f:
        return [json.loads(l) for l in f if l.strip()]


def write_rows(p: Path, rows: list):
    p.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(p, "wt", compresslevel=9) as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def sha256(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:16]


def repo_set(rows):
    return {r.get("repo") for r in rows if r.get("repo")}


def summarize(rows: list, label: str) -> dict:
    ratios = [r["ratio"] for r in rows if isinstance(r.get("ratio"), (int, float))]
    axis_pass = {a: sum(1 for r in rows if (r.get("axes") or {}).get(a)) for a in AXES}
    return dict(label=label, rows=len(rows), repos=len(repo_set(rows)),
                axesAllPass=sum(1 for r in rows if r.get("axesAllPass")),
                axisPass=axis_pass,
                medianRatio=round(statistics.median(ratios), 4) if ratios else None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-dir", required=True, help="固定评测集来源（取其 dev.jsonl.gz）")
    ap.add_argument("--source", action="append", required=True, help="源语料目录（可重复）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    eval_dir, out = Path(args.eval_dir), Path(args.out)
    force = "--force" in sys.argv
    existing = out / "train.jsonl.gz"
    if existing.exists() and existing.stat().st_size > 256 and not force:
        print(f"拒绝覆盖：{existing} 已存在且非空；确认请加 --force", file=sys.stderr)
        return 3
    eval_rows = read_rows(eval_dir / "dev.jsonl.gz")
    assert eval_rows, f"评测集为空：{eval_dir/'dev.jsonl.gz'}"
    eval_repos = repo_set(eval_rows)

    train: dict[str, dict] = {}
    nonc: dict[str, dict] = {}
    provenance = []
    for src in args.source:
        d = Path(src)
        tr = read_rows(d / "train.jsonl.gz")
        dv = read_rows(d / "dev.jsonl.gz")
        nc = read_rows(d / "train-nonconforming.jsonl.gz")
        added = kept_dev = skipped_isolation = 0
        for r in tr:
            if r["unitId"] not in train:
                train[r["unitId"]] = r
                added += 1
        for r in dv:
            if r.get("repo") in eval_repos:
                skipped_isolation += 1          # 与固定评测集同仓库：不许进训练
                if not r.get("axesAllPass"):
                    nonc.setdefault(r["unitId"], r)
                continue
            if r.get("axesAllPass"):
                if r["unitId"] not in train:
                    train[r["unitId"]] = r
                    kept_dev += 1
            else:
                nonc.setdefault(r["unitId"], r)
        for r in nc:
            pass
        for r in nc:
            nonc.setdefault(r["unitId"], r)
        provenance.append(dict(dir=str(d), trainIn=len(tr), devIn=len(dv), nonconfIn=len(nc),
                               trainAdded=added, devRowsAdded=kept_dev,
                               devRowsBlockedByIsolation=skipped_isolation,
                               sha16=dict(train=sha256(d / 'train.jsonl.gz') if (d/'train.jsonl.gz').exists() else None,
                                          dev=sha256(d / 'dev.jsonl.gz') if (d/'dev.jsonl.gz').exists() else None)))

    train_rows = list(train.values())
    nonc_rows = list(nonc.values())
    overlap = repo_set(train_rows) & eval_repos
    if overlap:
        print(json.dumps(dict(status="ABORT", reason="train/eval repo overlap",
                              examples=sorted(overlap)[:5], count=len(overlap)), ensure_ascii=False))
        return 4

    # 按 unitId 排序，产物可复现
    train_rows.sort(key=lambda r: r["unitId"])
    nonc_rows.sort(key=lambda r: r["unitId"])
    eval_sorted = sorted(eval_rows, key=lambda r: r["unitId"])

    write_rows(out / "train.jsonl.gz", train_rows)
    write_rows(out / "dev.jsonl.gz", eval_sorted)
    write_rows(out / "train-nonconforming.jsonl.gz", nonc_rows)

    report = dict(
        schema="cfb.micro-generator-corpus/1",
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        builtBy="tools/micro-generator/merge-corpora.py",
        evalDir=str(eval_dir), sources=[s for s in args.source],
        provenance=provenance,
        isolation=dict(evalRepos=len(eval_repos), trainRepos=len(repo_set(train_rows)),
                       overlapCount=0, checked=True),
        train=summarize(train_rows, "merged-train"),
        dev=summarize(eval_sorted, "fixed-eval(=evalDir/dev)"),
        trainNonconforming=dict(rows=len(nonc_rows), repos=len(repo_set(nonc_rows))),
        boundaries=dict(
            note="只有全轴通过的行进入 train；评测集固定为 evalDir 的 dev，跨轮可比；"
                 "各源目录 dev 中与评测集同仓库的行被硬性排除（见 provenance.devRowsBlockedByIsolation）。",
            policy="cfb.micro-generator.dataset-policy/1"),
    )
    (out / "corpus-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(dict(status="OK", **{k: report[k] for k in ("train", "dev", "trainNonconforming", "isolation")},
                          blocked=[p["devRowsBlockedByIsolation"] for p in provenance]),
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
