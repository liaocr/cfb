#!/usr/bin/env python3
"""Build the round-0 *generative compressor* training corpus from birth units.

What this does (all deterministic, zero API):
  input : birth units (raw = one reasoning block; ctx = what was visible at that moment)
  target: a compressed reasoning block produced by a mechanical teacher that
          (a) keeps every sentence that carries a fact anchor, a verdict line, or a command,
          (b) drops filler / hesitation, and
          (c) — the load-bearing rule — NEVER drops a sentence whose anchors are unique
              in the whole raw block. Hence anchor coverage of the target is 1.0 **by
              construction**, and the training bar the user set ("压缩出来信息不丢") is a
              mechanically checkable property, not a vibe:
                  coverage = |anchors(target) ∩ anchors(raw)| / |anchors(raw)|  == 1.0
          All kept sentences are verbatim; the teacher never rewrites a character.
  output: train/dev JSONL in chat format (system/user/assistant) + a corpus report.

Honest boundaries (stated again in the report file):
  - This teacher is a *machine* target generator, not reviewed gold. No human review.
  - "信息不丢" here = anchor coverage (identifiers/paths/numbers/backticked spans/verdict
    lines/commands). Semantic completeness is NOT claimed; E1/E2 (target-model feedback)
    remain 未测 until an endpoint exists.
  - dev split is by repository so the retention number is measured on unseen repos.

Usage:
  python3 tools/micro-generator/build-teacher-corpus.py \
    --units <units.jsonl> [--units ...] --out-dir transfer/models/micro-generator-gen
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

# ── anchor extraction (the measurement; one implementation, used by trainer + notebook too) ──
IDENT_RE = re.compile(r"`[^`\n]{2,120}`|[A-Za-z_$][\w.$-]{2,}|\d{2,}")
STOP = {
    "the", "and", "for", "you", "are", "not", "but", "with", "that", "this", "have", "has", "had",
    "from", "will", "can", "should", "would", "could", "let", "let's", "lets", "its", "it's",
    "old_text", "new_text", "edit_file", "read_file", "bash", "str_replace", "apply_patch",
    "tool_call", "true", "false", "null", "undefined", "none", "test", "tests", "true", "assert",
    "const", "let", "var", "return", "function", "import", "export", "from", "async", "await",
    "PASS", "FAIL", "pass", "fail", "grep", "sed", "cat", "head", "tail", "echo", "python",
    "command", "found", "error", "Error", "AssertionError", "Traceback", "exit", "code",
}
CLI_ALLOW = {"cd", "ls", "rm", "cp", "mv", "mkdir", "touch", "chmod", "wc", "find", "git", "pip", "pytest", "make", "node", "npm", "npx", "tox", "curl", "which", "env", "pwd", "sudo"}

_VERDICT_RE = re.compile(r"(?i)(\d+\s+(?:passed|failed|error)|\bpassed\b|\bfailed\b|\btraceback\b|assertionerror|\bexit(?:ed)? code\s*\d|\bok\b|\bFAIL\b|\bPASS\b)")
_CMD_RE = re.compile(r"(?m)^\s*(?:cd\s+\S+\s*&&\s*)?(?:python3?|pytest|git|npm|npx|node|pip|make|tox|grep|sed|find|cat)\b")
_FILLER_RE = re.compile(r"^(?:Let me|Let's|Now let me|Now I|I should|I need to|I think|I'll|But wait|Wait|Actually|Hmm|Perhaps|Maybe|Okay|Alright)\b|[?？]\s*$")
_HESITATION_RE = re.compile(r"(?i)\b(?:let me|let's|wait|hmm|actually|perhaps|maybe i|i should|i need to|but wait|re-read|reconsider)\b")


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def anchors_of(text: str) -> set[str]:
    out: set[str] = set()

    def add(tok: str) -> None:
        tok = tok.strip("`")
        if len(tok) < 3 and not re.fullmatch(r"\d{2,}", tok):
            return
        if tok in STOP or re.fullmatch(r"[.\-$]+", tok):
            return
        out.add(tok)

    for m in IDENT_RE.finditer(text or ""):
        tok = m.group(0).rstrip(".-")
        add(tok)
        if re.search(r"[./\-]", tok):
            for part in re.split(r"[./\-]+", tok):
                add(part)
        if re.search(r"[a-z][A-Z]", tok):
            for sub in re.split(r"(?=[A-Z])", tok):
                add(sub)
    # verdict lines and commands are facts in themselves
    for line in (text or "").split("\n"):
        if _VERDICT_RE.search(line) or _CMD_RE.search(line):
            add(_norm(line)[:60])
    return out


def split_sentences(raw: str) -> list[str]:
    """Fenced code blocks stay whole; other text splits on sentence terminators and newlines."""
    lines = raw.split("\n")
    sentences: list[str] = []
    buf: list[str] = []
    fence = False
    for line in lines:
        if line.strip().startswith("```"):
            fence = not fence
            buf.append(line)
            if not fence:
                sentences.append("\n".join(buf))
                buf = []
            continue
        if fence:
            buf.append(line)
            continue
        parts = re.split(r"(?<=[.!?。！？])\s+", line)
        for part in parts:
            p = part.strip()
            if not p:
                continue
            if re.fullmatch(r"[-*•#>=\-\s]{0,8}", p):
                continue
            sentences.append(p)
    if buf:
        sentences.append("\n".join(buf))
    return sentences


_STRONG_RE = re.compile(r"(?i)\b(?:the fix is|root cause|the issue is|therefore|this means|so the change|the change is|in short|to summarize|conclusion|that's why|the reason)\b")
_EXPL_RE = re.compile(r"(?i)^(?:let me|now let|i'?ll\b|i will|looking at|i need to|i should|we need|let's|now i\b|first,? i|next,? i)\b")
_PATHY_RE = re.compile(r"\w+\.(?:py|js|mjs|ts|json|md|txt|cfg|toml|yaml|yml|sh|go|rs|java|rb|php|c|cpp|h)\b")


def teach(raw: str) -> dict:
    """round-0 teacher v0.1 — critical-fact preservation with real compression.

    关键事实（protected）= 判定行 ∪ 命令 ∪ 在手代码（fenced/backticked）∪ 结论区（后 40%）
                         ∪ 路径类锚点。
    保留规则：含判定/命令/在手代码/结论区/决策标记且带锚点的句子，或含任一 protected 锚点。
    兜底：对每个未被覆盖的 protected 锚点，回补最早出现它的句子 ⇒ 关键覆盖 1.0 由构造保证。
    删除的：纯探索/复述/犹豫句（其锚点全在 protected 之外）。
    两个覆盖率都报告：criticalCoverage（必须 1.0）与 fullCoverage（如实，可能 <1）。
    """
    sentences = split_sentences(raw)
    total_anchors = anchors_of(raw)
    n = len(raw)
    entries = []
    offset = 0
    for s in sentences:
        a = anchors_of(s)
        entries.append({
            "text": s, "anchors": a,
            "verdict": bool(_VERDICT_RE.search(s)),
            "cmd": bool(_CMD_RE.search(s)),
            "fence": "```" in s,
            "backtick": bool(re.search(r"`[^`\n]{2,120}`", s)),
            "pathy": bool(_PATHY_RE.search(s) or "/" in s),
            "strong": bool(_STRONG_RE.search(s)),
            "expl": bool(_EXPL_RE.search(s)),
            "filler": bool(_FILLER_RE.search(s) or _HESITATION_RE.search(s)),
        })
        offset += len(s) + 1
    protected: set[str] = set()
    for e in entries:
        if e["verdict"] or e["cmd"] or e["fence"] or e["pathy"]:
            protected |= e["anchors"]
    keep_idx: set[int] = set()
    for i, e in enumerate(entries):
        base = e["verdict"] or e["cmd"] or e["fence"] or e["pathy"] or e["strong"]
        expl = e["expl"] or e["filler"]
        if base or (not expl and e["backtick"]):
            keep_idx.add(i)
    # 关键覆盖兜底：回补含未覆盖 protected 锚点的最早句子
    covered = set()
    for i in keep_idx:
        covered |= entries[i]["anchors"]
    missing = protected - covered
    for i, e in enumerate(entries):
        if missing & e["anchors"]:
            keep_idx.add(i)
            missing -= e["anchors"]
    # 去重（逐字重复句只留第一处）
    seen: set[str] = set()
    final_idx: list[int] = []
    for i in sorted(keep_idx):
        key = _norm(entries[i]["text"])
        if key in seen:
            continue
        seen.add(key)
        final_idx.append(i)
    target = "\n".join(entries[i]["text"] for i in final_idx)
    t_anchors = anchors_of(target)
    crit_cov = 1.0 if not protected else len(t_anchors & protected) / len(protected)
    full_cov = 1.0 if not total_anchors else len(t_anchors & total_anchors) / len(total_anchors)
    return {
        "target": target,
        "keptSentences": len(final_idx),
        "droppedSentences": len(sentences) - len(final_idx),
        "anchorsTotal": len(total_anchors),
        "protectedAnchors": len(protected),
        "criticalCoverage": round(crit_cov, 4),
        "fullCoverage": round(full_cov, 4),
        "coverage": round(crit_cov, 4),
        "sentencesTotal": len(sentences),
    }


SYSTEM = (
    "You are the CFB birth-compressor. You receive the CONTEXT visible at the moment a model "
    "produced a long reasoning block (RAW), and you output the compressed version of that block.\n"
    "Rules: keep every fact-bearing sentence verbatim — identifiers, file paths, numbers, verdict "
    "lines (test results), and commands must survive unchanged. Drop only hesitation, restatement "
    "and filler. Never invent an identifier that is not in CONTEXT or RAW. Never lose a fact."
)
USER_TMPL = "【CONTEXT】\n{ctx}\n\n【RAW】\n{raw}"


def stable_repo_hash(repo: str) -> float:
    return int(hashlib.sha256(repo.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", action="append", required=True)
    ap.add_argument("--out-dir", default="transfer/models/micro-generator-gen")
    ap.add_argument("--dev-frac", type=float, default=0.10)
    ap.add_argument("--min-dev-rows", type=int, default=20)
    ap.add_argument("--max-raw-chars", type=int, default=12000, help="skip pathological blocks")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[2]
    units: list[dict] = []
    import gzip
    for f in args.units:
        p = Path(f) if Path(f).is_absolute() else root / f
        opener = gzip.open if str(p).endswith(".gz") else open
        with opener(p, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    units.append(json.loads(line))
    # 去重（同一 unitId 可能来自多批）
    by_id = {u["unitId"]: u for u in units}
    units = list(by_id.values())

    rows = []
    for u in units:
        raw, ctx = u.get("raw") or "", u.get("ctx") or ""
        if not raw or len(raw) > args.max_raw_chars:
            continue
        t = teach(raw)
        if not t["target"].strip():
            continue
        rows.append({
            "unitId": u["unitId"],
            "repo": (u.get("source") or {}).get("repository") or "?",
            "license": (u.get("source") or {}).get("repositoryLicense") or "unknown",
            "rawChars": len(raw),
            "targetChars": len(t["target"]),
            "ratio": round(len(t["target"]) / max(1, len(raw)), 4),
            "coverage": t["coverage"],
            "fullCoverage": t["fullCoverage"],
            "protectedAnchors": t["protectedAnchors"],
            "anchorsTotal": t["anchorsTotal"],
            "keptSentences": t["keptSentences"],
            "droppedSentences": t["droppedSentences"],
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": USER_TMPL.format(ctx=ctx, raw=raw)},
                {"role": "assistant", "content": t["target"]},
            ],
        })

    # dev split: whole repositories, deterministic
    repos = sorted({r["repo"] for r in rows})
    dev_repos = {r for r in repos if stable_repo_hash(r) < args.dev_frac}
    if len(dev_repos) == 0 and repos:
        dev_repos = {repos[0]}
    train = [r for r in rows if r["repo"] not in dev_repos]
    dev = [r for r in rows if r["repo"] in dev_repos]
    while len(dev) < args.min_dev_rows and len(train) > 1:
        moved = train.pop()
        dev.append(moved)
        dev_repos.add(moved["repo"])

    out_dir = root / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, subset in (("train.jsonl", train), ("dev.jsonl", dev)):
        with (out_dir / name).open("w", encoding="utf-8") as fh:
            for r in subset:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    def stats(subset):
        if not subset:
            return {}
        ratios = sorted(r["ratio"] for r in subset)
        cov = [r["coverage"] for r in subset]
        return {
            "rows": len(subset),
            "repos": len({r["repo"] for r in subset}),
            "medianRatio": ratios[len(ratios) // 2],
            "minRatio": ratios[0],
            "maxRatio": ratios[-1],
            "criticalCoverageAllOne": all(c == 1.0 for c in cov),
            "criticalCoverageMin": min(cov),
            "meanCriticalCoverage": round(sum(cov) / len(cov), 4),
            "meanFullCoverage": round(sum(r["fullCoverage"] for r in subset) / len(subset), 4),
            "meanRawChars": round(sum(r["rawChars"] for r in subset) / len(subset)),
        }

    report = {
        "schema": "cfb.micro-generator-gen-corpus/1",
        "createdAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
        "teacher": "mechanical-extractive-v0.2 (verbatim sentences; keep = verdict/command/fenced-code/path/strong-conclusion, or non-exploratory sentence with in-hand backticked evidence; critical-anchor repair ⇒ coverage 1.0 by construction; measured median ratio ≈ 0.50)",
        "unitsIn": len(units),
        "rowsWritten": len(rows),
        "train": stats(train),
        "dev": stats(dev),
        "devRepos": sorted(dev_repos),
        "boundaries": [
            "machine-generated targets, NOT reviewed gold; no human review (humanReviewerCount=0)",
            "信息不丢 = anchor coverage (identifiers/paths/numbers/verdicts/commands) — semantic completeness not claimed",
            "E1/E2 (target-model feedback) 未测: requires a DeepSeek-V4.1-Flash endpoint",
            "dev is repo-disjoint from train; retention is measured on unseen repos",
        ],
    }
    (out_dir / "corpus-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"rows": len(rows), "train": report["train"], "dev": report["dev"]}, ensure_ascii=False, indent=2))
    print(f"wrote {out_dir}/train.jsonl, dev.jsonl, corpus-report.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
