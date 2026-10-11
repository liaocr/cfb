#!/usr/bin/env python3
"""检查语料隔离性：仓库级是否隔离 + 有没有字面重叠（记忆捷径）。

用途：回答「模型会不会只是记住训练稿、在 dev 上抄近道」。
两件事：
  1) repo 字段交集（应为 0）
  2) 64/200 字符 shingle 覆盖率：dev 的答案文本有多少能在 train 里原样找到
     —— 覆盖率低 ⇒ 记忆无法伪造 dev 分数

用法：
  python3 audit-corpus-isolation.py --corpus transfer/models/micro-generator-gen-v3
"""
from __future__ import annotations

import argparse, gzip, json, re, sys
from array import array
from pathlib import Path

try:
    import numpy as np
except Exception:  # numpy 可选：没有就退化为纯 Python（慢一点但能跑）
    np = None


def rows(p: Path):
    with gzip.open(p, "rt") as f:
        return [json.loads(l) for l in f if l.strip()]


def repo_of(r: dict):
    for k in ("repo", "repository", "sourceRepo", "repoName"):
        if r.get(k):
            return r[k]
    md = r.get("metadata") or {}
    for k in ("repo", "repository", "sourceRepo", "repoName"):
        if md.get(k):
            return md[k]
    for k in ("caseId", "unitId", "id"):
        v = r.get(k) or md.get(k)
        if isinstance(v, str) and "/" in v:
            return "/".join(v.split("/")[:2])
    return None


def answer_of(r: dict) -> str:
    msgs = r.get("messages") or []
    return msgs[-1].get("content", "") if msgs else ""


def shingle_hashes(text: str, n: int, out: array) -> None:
    t = re.sub(r"\s+", " ", text)
    for i in range(0, max(0, len(t) - n + 1)):
        out.append(hash(t[i : i + n]))


def coverage(train_hashes, dev_text: str, n: int) -> float:
    t = re.sub(r"\s+", " ", dev_text)
    m = max(0, len(t) - n + 1)
    if m == 0:
        return 0.0
    hit = 0
    for i in range(m):
        if hash(t[i : i + n]) in train_hashes:
            hit += 1
    return hit / m


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="transfer/models/micro-generator-gen-v3")
    ap.add_argument("--lens", default="64,200")
    args = ap.parse_args()
    root = Path(args.corpus)
    tr, dv = rows(root / "train.jsonl.gz"), rows(root / "dev.jsonl.gz")
    lens = [int(x) for x in args.lens.split(",")]

    tr_repos = {r for r in (repo_of(x) for x in tr) if r}
    dv_repos = {r for r in (repo_of(x) for x in dv) if r}
    print(json.dumps(dict(trainRows=len(tr), devRows=len(dv),
                          trainRepos=len(tr_repos), devRepos=len(dv_repos),
                          repoOverlap=sorted(tr_repos & dv_repos)[:5],
                          repoOverlapCount=len(tr_repos & dv_repos),
                          sampleKeys=sorted(tr[0].keys())), ensure_ascii=False))

    for n in lens:
        hashes = array("q")
        for r in tr:
            shingle_hashes(answer_of(r), n, hashes)
        if np is not None:
            arr = np.frombuffer(hashes.tobytes(), dtype=np.int64)
            arr = np.unique(np.sort(arr))
            hitset = set(arr.tolist())
        else:
            hitset = set(hashes)
        covs = [coverage(hitset, answer_of(r), n) for r in dv]
        covs_sorted = sorted(covs)
        print(json.dumps(dict(
            shingleLen=n, trainShingles=len(hitset),
            devCoverageMean=round(sum(covs) / len(covs), 5),
            devCoverageMax=round(covs_sorted[-1], 5),
            devRowsOver10pct=sum(1 for c in covs if c > 0.10),
            devRowsOver30pct=sum(1 for c in covs if c > 0.30),
            nDev=len(covs)), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
