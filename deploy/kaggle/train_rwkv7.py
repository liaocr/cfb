#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prospective pretrained RWKV7 SFT trainer, not a production compressor.

Flat data = id/repo/system/user/assistant. Stage local files and provide an immutable
model revision; real training additionally requires hash-bound declared admission.
--preflight-only uses only Python stdlib: no torch, weights, network or writes.
--smoke checks a pipeline, never certifies training data or model quality.

Training/generation share the explicit non-thinking native prefix. EOS must be a
valid vocabulary id; a tokenizer/config mismatch requires --eos-token-id rather
than silent fallback to 0. Window, decoding, CUDA/fused-loss/cache/DDP and CPU
resource behaviour need actual smoke; old window/latency numbers are not evidence
for this revised recipe. This audit did not run GPU or download base weights.
"""

from __future__ import annotations

import argparse
import hashlib
import random
import re
import datetime
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODEL_ID = "fla-hub/rwkv7-0.1B-g1"
DEFAULT_MAX_LEN = 6144  # 不是 config 里的 2048，理由见模块 docstring（真实分词器实测 99.8%）


# ─────────────────────────── 数据 ───────────────────────────

def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"FATAL: {path}:{i} 不是合法 JSON：{exc}")
    return rows


def fetch(src: str, dest: Path, world: int = 1, is_main: bool = True) -> Path:
    """支持 http(s) URL 与本地路径。

    Kaggle 的 script kernel 不保证 cwd 就是代码所在目录，所以相对路径要依次试：
    当前 cwd → 本脚本所在目录。都不在就报清楚，不要静默读空文件。

    多卡时**只让 0 号下载**，其余 rank 在 barrier 上等（真机实测过的 bug）：
    两个 rank 各自 fetch 到同一个 dest，一个 open("wb") 截断、另一个正在读 ——
    rank1 读到半截文件，read_jsonl 返回 0 行，报 "FATAL: _train.jsonl 是空的"
    然后整轮 torchrun 被 SIGTERM 掉。冒烟 v5 只有 48 行没撞上，真数据集 3.2MB 必撞。
    下载还改成先写 .part 再原子 replace，即使将来有别的读者也不会看到半截文件。
    """
    if src.startswith(("http://", "https://")):
        import urllib.request
        import torch
        dest.parent.mkdir(parents=True, exist_ok=True)
        if world > 1 and not is_main:
            torch.distributed.barrier()   # 等 0 号下完
            return dest
        last = None
        # 真实训练集有近 10MB，raw.githubusercontent 这条链路会偶发重置；
        # 一次就放弃等于白烧一整轮 kernel（含排队 + 装 fla + 载模型）。
        for i in range(4):
            try:
                req = urllib.request.Request(src, headers={"User-Agent": "cfb-rwkv7-trainer"})
                tmp = dest.with_name(dest.name + ".part")
                with urllib.request.urlopen(req, timeout=180) as r, tmp.open("wb") as w:
                    w.write(r.read())
                tmp.replace(dest)
                print(f"· 下载 {src} -> {dest} ({dest.stat().st_size} bytes)", flush=True)
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
                if i < 3:
                    print(f"· 下载失败（{exc!r}），{2 ** i}s 后重试 {i + 2}/4", flush=True)
                    time.sleep(2 ** i)
        else:
            raise SystemExit(f"FATAL: 下载失败 4 次：{src}\n  最后错误：{last!r}")
        if world > 1:
            torch.distributed.barrier()   # 通知其余 rank 可以读了
        return dest
    p = Path(src)
    if p.is_file():
        return p
    alt = Path(__file__).resolve().parent / src
    if alt.is_file():
        print(f"· 相对路径落到脚本目录：{alt}", flush=True)
        return alt
    raise SystemExit(f"FATAL: 找不到数据文件 {src}（试过 {p.resolve()} 与 {alt}）")


def file_sha256(p: Path) -> str:
    digest = hashlib.sha256()
    with p.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_sft_rows(train: list[dict], dev: list[dict], *, smoke: bool = False) -> dict:
    """CPU-only integrity checks. These do not prove semantic quality."""
    if not train or (not dev and not smoke):
        raise ValueError("sft-empty-train-or-dev")
    seen_ids, inputs, repos, prompts = set(), {}, {"train": set(), "dev": set()}, set()
    for split, rows in (("train", train), ("dev", dev)):
        for i, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                raise ValueError(f"sft-row-not-object:{split}:{i}")
            for field in ("id", "repo", "system", "user", "assistant"):
                if not isinstance(row.get(field), str) or not row[field].strip():
                    raise ValueError(f"sft-field-not-nonempty-string:{split}:{i}:{field}")
            if row["repo"].lower() in {"unknown", "null", "none"}:
                raise ValueError(f"sft-unknown-repository:{split}:{i}")
            if row["id"] in seen_ids:
                raise ValueError(f"sft-duplicate-id:{row['id']}")
            seen_ids.add(row["id"])
            key = hashlib.sha256(json.dumps([row["system"], row["user"]], ensure_ascii=False).encode()).hexdigest()
            if key in inputs:
                why = "conflicting-target" if inputs[key] != row["assistant"] else "duplicate-input"
                raise ValueError(f"sft-{why}:{split}:{i}")
            inputs[key] = row["assistant"]
            repos[split].add(row["repo"])
            prompts.add(hashlib.sha256(row["system"].encode()).hexdigest())
    overlap = repos["train"] & repos["dev"]
    if overlap:
        raise ValueError("sft-repository-leakage:" + ",".join(sorted(overlap)))
    if len(prompts) != 1:
        raise ValueError("sft-mixed-system-prompts")
    return {"trainRows": len(train), "devRows": len(dev),
            "trainRepos": len(repos["train"]), "devRepos": len(repos["dev"]),
            "promptSha256": next(iter(prompts))}


def js_utf8(text: str) -> bytes:
    # JS UTF-8 replaces lone UTF-16 surrogates with U+FFFD. Valid pairs merge.
    return text.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace").encode("utf-8")


def compact_json(value) -> str:
    """JSON.stringify-compatible wire representation for JSON-only bindings.

    Float exponent padding, decimal/scientific cutoffs, -0, integral floats,
    Unicode surrogates and JS array-index property order are handled explicitly.
    No NaN/Infinity/unsafe arbitrary-precision integer silently changes meaning.
    """
    from decimal import Decimal
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is str:
        merged = value.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="surrogatepass")
        quoted = json.dumps(merged, ensure_ascii=False)
        return "".join("\\u%04x" % ord(c) if 0xD800 <= ord(c) <= 0xDFFF else c for c in quoted)
    if type(value) is int:
        if abs(value) > 9007199254740991:
            # Accept a canonical JS Number wire numeral (e.g. JSON.stringify(1e20))
            # only if its decimal representation round-trips without new rounding.
            try:
                rendered = compact_json(float(value))
            except (OverflowError, ValueError) as exc:
                raise ValueError("sft-formal-unsafe-integer:store-material-large-values-as-source-text") from exc
            if Decimal(rendered) != Decimal(value):
                raise ValueError("sft-formal-unsafe-integer:store-material-large-values-as-source-text")
            return rendered
        return str(value)
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("sft-formal-nonfinite-JSON-number")
        if value == 0:
            return "0"
        decimal = Decimal(repr(value))
        exponent = decimal.copy_abs().adjusted()
        if -6 <= exponent < 21:
            rendered = format(decimal, "f")
            return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered
        sign = "-" if value < 0 else ""
        digits = "".join(map(str, decimal.copy_abs().as_tuple().digits)).rstrip("0")
        coefficient = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
        return sign + coefficient + "e" + ("+" if exponent >= 0 else "") + str(exponent)
    if isinstance(value, list):
        return "[" + ",".join(compact_json(x) for x in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value):
            raise ValueError("sft-formal-JSON-object-key-not-string")
        indexed = sorted((k for k in value if re.fullmatch(r"0|[1-9][0-9]*", k) and int(k) < 4294967295), key=int)
        keys = indexed + [k for k in value if k not in indexed]
        return "{" + ",".join(compact_json(k) + ":" + compact_json(value[k]) for k in keys) + "}"
    raise ValueError("sft-formal-not-JSON-data")


def compact_sha256(value) -> str:
    return hashlib.sha256(compact_json(value).encode("utf-8")).hexdigest()


def bound_local_file(base: Path, ref: dict, label: str) -> Path:
    rel = ref.get("path") if isinstance(ref, dict) else None
    if not isinstance(rel, str) or not rel or "\\" in rel or Path(rel).is_absolute() or any(x in {"", ".", ".."} for x in rel.split("/")):
        raise ValueError("sft-formal-binding-path:" + label)
    full = (base / rel).resolve()
    if not full.is_relative_to(base.resolve()) or not full.is_file() or file_sha256(full) != ref.get("sha256"):
        raise ValueError("sft-formal-binding-drift:" + label)
    return full


def utf16_span(text: str, span: dict, label: str) -> tuple:
    data = text.encode("utf-16-le", errors="surrogatepass")
    start, end = span.get("start"), span.get("end")
    if type(start) is not int or type(end) is not int or start < 0 or end <= start or 2 * end > len(data):
        raise ValueError("sft-formal-UTF16-span:" + label)
    quote = data[2 * start:2 * end].decode("utf-16-le", errors="surrogatepass")
    if quote != span.get("quote"):
        raise ValueError("sft-formal-span-quote:" + label)
    return start, end


def js_nonwhitespace(text: str) -> bool:
    # ECMAScript TrimString, not Python str.strip (e.g. U+0085 vs U+FEFF).
    whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    return any(c not in whitespace for c in text)


def complete_text_units(text: str, units: list, label: str):
    if not isinstance(units, list):
        raise ValueError("sft-formal-coverage-array:" + label)
    encoded = text.encode("utf-16-le", errors="surrogatepass")
    spans = sorted(utf16_span(text, u, label) for u in units)
    cursor = 0
    for start, end in spans:
        if start < cursor or js_nonwhitespace(encoded[2 * cursor:2 * start].decode("utf-16-le", errors="surrogatepass")):
            raise ValueError("sft-formal-source-coverage-gap-or-overlap:" + label)
        cursor = end
    if js_nonwhitespace(encoded[2 * cursor:].decode("utf-16-le", errors="surrogatepass")):
        raise ValueError("sft-formal-source-coverage-gap-or-overlap:" + label)


def validate_attached_complete_review(annotation: dict, review: dict):
    if annotation.get("sourceCoverage") != "complete" or annotation.get("annotationStatus") != "adjudicated" or annotation.get("trainingEligible") is not True:
        raise ValueError("sft-formal-annotation-incomplete")
    raw, ctx, draft = annotation.get("raw"), annotation.get("ctx"), annotation.get("referenceDraft")
    if not isinstance(raw, str) or not raw or not isinstance(ctx, str) or not isinstance(draft, str) or not draft:
        raise ValueError("sft-formal-source-strings")
    sh = lambda text: hashlib.sha256(js_utf8(text)).hexdigest()
    hashes = annotation.get("sourceHashes", {})
    if hashes != {"rawSha256": sh(raw), "ctxSha256": sh(ctx), "referenceSha256": sh(draft)}:
        raise ValueError("sft-formal-annotation-hashes")
    provenance = annotation.get("reviewProvenance", {})
    if annotation.get("reviewers") != ["arena-agent-mode"] or provenance.get("mode") != "ai-single-reviewer" or provenance.get("reviewerType") != "ai" or provenance.get("reviewerId") != "arena-agent-mode" or provenance.get("reviewerCount") != 1 or provenance.get("humanReviewerCount") != 0 or provenance.get("independentSecondReview") is not False:
        raise ValueError("sft-formal-review-provenance")
    if review.get("schema") != "cfb.compression-review/1" or review.get("caseId") != annotation.get("caseId") or review.get("annotationSha256") != compact_sha256(annotation):
        raise ValueError("sft-formal-review-binding")
    input_digest = sh(sh(raw) + ":" + sh(ctx))
    if review.get("inputSha256") != input_digest or review.get("draftSha256") != sh(draft) or review.get("status") != "complete-ai-single-review" or review.get("semanticCertification") is not False or review.get("targetReadbackVerified") is not False:
        raise ValueError("sft-formal-review-status")
    if review.get("reviewerId") != "arena-agent-mode" or review.get("humanReviewerCount") != 0 or review.get("independentSecondReview") is not False or not review.get("limitations"):
        raise ValueError("sft-formal-review-provenance")
    facts = annotation.get("facts", [])
    ids = [f.get("factId") for f in facts]
    if not facts or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("sft-formal-atomic-facts")
    outcomes = annotation.get("referenceReview", {})
    statuses = outcomes.get("factStatuses", [])
    by_id = {x.get("factId"): x.get("status") for x in statuses}
    if len(statuses) != len(facts) or set(by_id) != set(ids) or any(v not in {"preserved", "omitted", "contradicted", "uncertain"} for v in by_id.values()) or outcomes.get("allMustPreserveFactsSatisfied") is not True or outcomes.get("unsupportedClaimsReviewed") is not True or outcomes.get("unsupportedClaimsCount") != 0:
        raise ValueError("sft-formal-reference-facts")
    sources = review.get("sourceUnits", {})
    for field in ["raw", "ctx"]:
        complete_text_units(annotation[field], sources.get(field), field)
        for unit in sources[field]:
            if unit.get("classification") not in {"material", "repetition", "deliberation", "quoted-code", "ctx-retained", "nonmaterial"} or not unit.get("rationale") or not isinstance(unit.get("factIds"), list) or any(i not in ids for i in unit["factIds"]):
                raise ValueError("sft-formal-source-unit")
            if unit["classification"] in {"material", "quoted-code"} and not unit["factIds"]:
                raise ValueError("sft-formal-material-unit-without-facts")
    for fact in facts:
        span = fact.get("sourceSpan", {}); field = span.get("field")
        if field not in {"raw", "ctx"}:
            raise ValueError("sft-formal-fact-field")
        start, end = utf16_span(annotation[field], span, "fact")
        if not any(u["start"] <= start and u["end"] >= end and fact["factId"] in u["factIds"] for u in sources[field]):
            raise ValueError("sft-formal-fact-unit-binding")
        if type(fact.get("mustPreserve")) is not bool or (fact["mustPreserve"] and by_id[fact["factId"]] != "preserved"):
            raise ValueError("sft-formal-must-preserve-fact")
    claims = review.get("draftClaims")
    complete_text_units(draft, claims, "draft")
    claim_ids = set()
    for claim in claims:
        cid = claim.get("claimId")
        if not cid or cid in claim_ids or claim.get("status") not in {"supported", "nonfactual"} or not claim.get("rationale"):
            raise ValueError("sft-formal-unsafe-or-duplicate-claim")
        claim_ids.add(cid)
        refs = claim.get("sourceFactIds")
        if not isinstance(refs, list) or any(i not in ids for i in refs) or (claim["status"] == "supported" and not refs):
            raise ValueError("sft-formal-claim-source-binding")


def validate_formal_lineage(args, admission: dict, admission_path: Path) -> dict:
    formal = admission.get("formalLineage", {})
    if formal.get("schema") != "cfb.formal-sft-lineage-bundle/1":
        raise ValueError("sft-formal-lineage-required:no-declaration-only-admission")
    base = admission_path.parent
    lineage_file = bound_local_file(base, formal, "lineage")
    lineage = read_jsonl(lineage_file)
    bindings = formal.get("bindings", {})
    files = {key: bound_local_file(base, bindings.get(key, {}), key) for key in ["annotations", "reviews", "registry", "contract", "prompt"]}
    annotations = read_jsonl(files["annotations"]); reviews = read_jsonl(files["reviews"])
    registry = json.loads(files["registry"].read_text(encoding="utf-8"))
    contract = json.loads(files["contract"].read_text(encoding="utf-8"))
    prompt = files["prompt"].read_text(encoding="utf-8")
    if registry.get("schema") != "cfb.source-registry/1" or registry.get("errors") or contract.get("schema") != "cfb.compression-task-contract/1" or contract.get("resources", {}).get("resourceBudgetConfirmed") is not True:
        raise ValueError("sft-formal-registry-contract-budget")
    annos = {r["caseId"]: r for r in annotations}; revs = {r["caseId"]: r for r in reviews}; source = {r["inputSha256"]: r for r in registry.get("entries", [])}
    rows = [(split, r) for split, file in [("train", args.data), ("dev", args.dev)] for r in read_jsonl(Path(file))]
    if len(annos) != len(annotations) or len(revs) != len(reviews) or len(source) != len(registry.get("entries", [])) or len(lineage) != len(rows) or formal.get("rows") != len(rows):
        raise ValueError("sft-formal-lineage-count-or-duplicate")
    by_id = {r.get("id"): r for r in lineage}
    if len(by_id) != len(lineage) or set(by_id) != {r["id"] for _, r in rows} or set(annos) != set(by_id) or set(revs) != set(by_id):
        raise ValueError("sft-formal-lineage-case-set")
    families = {}
    exposed_families = {family for entry in registry.get("entries", []) for family in entry.get("families", []) if any(any(word in exposure for word in ["dev", "exposed", "blind"]) for exposure in entry.get("exposure", []))}
    source_refs = formal.get("sourceReviews", {})
    if not isinstance(source_refs, dict) or not source_refs:
        raise ValueError("sft-formal-source-proof-files-required")
    for digest, ref in source_refs.items():
        if digest != ref.get("sha256"):
            raise ValueError("sft-formal-source-proof-reference")
        bound_local_file(base, ref, "source-review:" + digest)
    for split, row in rows:
        item = by_id[row["id"]]; a = annos[row["id"]]; review = revs[row["id"]]
        expected = compact_sha256([row[k] for k in ["id", "repo", "system", "user", "assistant"]])
        if item.get("schema") != "cfb.flat-sft-lineage/1" or item.get("flatRowSha256") != expected or item.get("split") != split or item.get("repo") != row["repo"] or item.get("annotationSha256") != compact_sha256(a) or item.get("completeReviewSha256") != compact_sha256(review) or item.get("annotation") != a or item.get("completeReview") != review:
            raise ValueError("sft-formal-flat-row-or-review-binding")
        validate_attached_complete_review(a, review)
        if a.get("finalSplit") != split or json.loads(row["user"]) != {"raw": a["raw"], "ctx": a["ctx"]} or row["assistant"] != a["referenceDraft"] or row["system"] != prompt or item.get("family") != a.get("family"):
            raise ValueError("sft-formal-flat-content-mismatch")
        if a["family"] in families and families[a["family"]] != split:
            raise ValueError("sft-formal-family-leakage")
        families[a["family"]] = split
        if item.get("inputSha256") != review.get("inputSha256") or item.get("rawSha256") != a["sourceHashes"]["rawSha256"] or item.get("ctxSha256") != a["sourceHashes"]["ctxSha256"] or item.get("targetSha256") != a["sourceHashes"]["referenceSha256"]:
            raise ValueError("sft-formal-row-source-hashes")
        entry = source.get(item.get("inputSha256"), {})
        if a.get("family") not in entry.get("families", []) or entry.get("repo") != row["repo"] or not any(r.get("caseId") == row["id"] and r.get("recordSha256") == compact_sha256(a) for r in entry.get("records", [])):
            raise ValueError("sft-formal-registry-row-binding")
        if split == "train" and (a["family"] in exposed_families or any(any(word in x for word in ["dev", "exposed", "blind"]) for x in entry.get("exposure", []))):
            raise ValueError("sft-formal-prior-exposure-leakage")
        admission_review = entry.get("sourceAdmission", {})
        if any(admission_review.get(k) is not True for k in ["admitted", "modelVersionVerified", "temporalBoundaryVerified", "licenseReviewed", "privacyReviewed"]):
            raise ValueError("sft-formal-source-not-admitted")
        source_ref = source_refs.get(item.get("sourceReviewSha256"))
        if source_ref != admission_review.get("reviewRef") or source_ref != item.get("sourceReviewRef"):
            raise ValueError("sft-formal-source-proof-reference")
        source_file = bound_local_file(base, source_ref, "source-review-row")
        source_review = json.loads(source_file.read_text(encoding="utf-8"))
        if source_review != item.get("sourceReview"):
            raise ValueError("sft-formal-source-proof-inline-mismatch")
        if item.get("sourceReviewSha256") != admission_review.get("reviewRef", {}).get("sha256") or source_review.get("rawSha256") != a["sourceHashes"]["rawSha256"] or source_review.get("ctxSha256") != a["sourceHashes"]["ctxSha256"]:
            raise ValueError("sft-formal-source-proof-hashes")
        source_model = source_review.get("sourceModel", {})
        if source_model.get("id") != contract.get("receiver", {}).get("id") or not isinstance(source_model.get("servedVersion"), str) or not source_model["servedVersion"].strip():
            raise ValueError("sft-formal-source-model-not-attested-in-initial-target-scope")
        if item.get("sourceReviewRecordSha256") != compact_sha256(source_review) or source_review.get("schema") != "cfb.source-admission-review/1" or source_review.get("inputSha256") != item.get("inputSha256") or source_review.get("status") != "admitted" or source_review.get("fixtureOnly") is not False:
            raise ValueError("sft-formal-source-proof")
    evidence = formal.get("evidence", {})
    receipts = {k: bound_local_file(base, evidence.get(k, {}), k) for k in ["preregistration", "ruler", "readerStudy", "cpu"]}
    if admission.get("ruler") != {"report": evidence["ruler"]["path"], "sha256": evidence["ruler"]["sha256"]}:
        raise ValueError("sft-formal-ruler-reference-mismatch")
    prereg = json.loads(receipts["preregistration"].read_text(encoding="utf-8"))
    reader = json.loads(receipts["readerStudy"].read_text(encoding="utf-8"))
    cpu = json.loads(receipts["cpu"].read_text(encoding="utf-8"))
    ruler = json.loads(receipts["ruler"].read_text(encoding="utf-8"))
    thresholds = prereg.get("promotionThresholds", {})
    if prereg.get("status") != "frozen-for-content-and-original-reader-evaluation" or not thresholds or any(v is None for v in thresholds.values()):
        raise ValueError("sft-formal-thresholds-not-frozen")
    if ruler.get("preregSha256") != evidence["preregistration"]["sha256"] or ruler.get("originalReaderValidated") is not True or ruler.get("fixtureOnly") is not False:
        raise ValueError("sft-formal-ruler-not-reader-bound")
    if reader.get("schema") != "cfb.original-reader-study/1" or reader.get("actualExecution") is not True or reader.get("fixtureOnly") is not False or reader.get("receiver") != contract.get("receiver", {}).get("id") or reader.get("aAControlExecuted") is not True or reader.get("allRegisteredCasesAccounted") is not True or reader.get("referenceUtilityVerified") is not True or reader.get("preregSha256") != evidence["preregistration"]["sha256"] or not reader.get("readerVersion"):
        raise ValueError("sft-formal-reader-study")
    if cpu.get("kind") != "cpuQualityAndLatencyVerified" or cpu.get("verified") is not True or cpu.get("actualExecution") is not True or cpu.get("fixtureOnly") is not False or cpu.get("model") != {"id": args.model, "revision": args.model_revision}:
        raise ValueError("sft-formal-CPU-candidate")
    return {"formalLineageSha256": formal["sha256"], "completeReviewRows": len(rows), "familyCount": len(families)}


def preflight_sft(args) -> dict:
    """Local-only: no torch, model downloads, API calls, or writes.

    A declared admission record binds the files, model revision and evaluator receipt.
    Complete attached source/fact/claim records are checked, not just review Booleans.
    Their integrity is not independent proof of semantic correctness or execution.
    """
    if not re.fullmatch(r"[0-9a-f]{40}", args.model_revision or ""):
        raise ValueError("model-revision-must-be-immutable-40-hex")
    train_path = Path(args.data)
    dev_path = Path(args.dev) if args.dev else None
    if not train_path.is_file() or (dev_path is not None and not dev_path.is_file()):
        raise ValueError("sft-stage-local-files-first:no-mutable-main-URLs")
    summary = validate_sft_rows(read_jsonl(train_path), read_jsonl(dev_path) if dev_path else [], smoke=args.smoke)
    summary.update(trainSha256=file_sha256(train_path), devSha256=file_sha256(dev_path) if dev_path else None,
                   model=args.model, modelRevision=args.model_revision, trainingApproved=False,
                   trainerSha256=file_sha256(Path(__file__)))
    if args.smoke:
        summary["scope"] = "pipeline-smoke-only-not-training-admission"
        return summary
    if not args.admission or not Path(args.admission).is_file():
        raise ValueError("sft-admission-required:current-v9-is-INVALID")
    admission_path = Path(args.admission)
    admission = json.loads(admission_path.read_text(encoding="utf-8"))
    if admission.get("schema") != "cfb.sft-admission/1" or admission.get("status") != "admitted":
        raise ValueError("sft-not-admitted")
    if admission.get("model") != {"id": args.model, "revision": args.model_revision}:
        raise ValueError("sft-admission-model-mismatch")
    for split in ("train", "dev"):
        expected = admission.get("artifacts", {}).get(split, {})
        if expected.get("sha256") != summary[split + "Sha256"] or expected.get("rows") != summary[split + "Rows"]:
            raise ValueError("sft-admission-artifact-mismatch:" + split)
    review = admission.get("review", {})
    if review.get("status") != "complete" or not isinstance(review.get("reviewerId"), str) or not review["reviewerId"].strip():
        raise ValueError("sft-review-incomplete")
    ruler = admission.get("ruler", {})
    report_path = (admission_path.parent / str(ruler.get("report", ""))).resolve()
    if not report_path.is_file() or file_sha256(report_path) != ruler.get("sha256"):
        raise ValueError("sft-ruler-report-missing-or-drifted")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    validity = report.get("validity", {})
    checks = {k: v for k, v in validity.items() if k != "VALID"}
    if validity.get("VALID") != "VALID" or not checks or any(v != "PASS" for v in checks.values()):
        raise ValueError("sft-ruler-invalid")
    summary.update(validate_formal_lineage(args, admission, admission_path))
    summary.update(trainingApproved=True, admissionSha256=file_sha256(admission_path),
                   rulerReportSha256=ruler["sha256"], scope="attached-complete-review-integrity-not-independent-semantic-certification")
    return summary


def resolve_eos_id(tokenizer_eos, model_eos, vocab_size: int, override=None) -> int:
    selected = tokenizer_eos if override is None else override
    if type(selected) is not int or not 0 <= selected < vocab_size:
        raise ValueError("invalid-eos-vocabulary-id")
    if override is None and model_eos is not None and selected != model_eos:
        raise ValueError("tokenizer-model-eos-mismatch:explicit-tested-override-required")
    return selected


def epoch_batches(rows: list, batch_size: int, accum: int, world: int, rank: int, seed: int, epoch: int):
    """Deterministic length-bucket shuffle, equal DDP steps; no permanent long-tail cut."""
    if min(batch_size, accum, world) <= 0 or not 0 <= rank < world:
        raise ValueError("invalid-batch-or-rank")
    order = sorted(range(len(rows)), key=lambda i: len(rows[i][0]))
    rng = random.Random(seed + epoch)
    width = batch_size * 16
    for start in range(0, len(order), width):
        bucket = order[start:start + width]
        rng.shuffle(bucket)
        order[start:start + width] = bucket
    batches = [[rows[i] for i in order[start:start + batch_size]] for start in range(0, len(order), batch_size)]
    rng.shuffle(batches)
    alignment = accum * world
    kept = len(batches) // alignment * alignment
    if not kept:
        raise ValueError("not-enough-microbatches-for-one-optimizer-step")
    return batches[:kept][rank::world], len(batches) - kept


# ─────────────────────────── 分词 ───────────────────────────

def render(tok, messages, add_gen: bool) -> str:
    """底座原生 chat_template。

    RWKV7 g1 的模板把思考开关放在 add_generation_prompt 分支里：
        {% if add_generation_prompt %}
          {% if enable_thinking is defined and enable_thinking == False %}
            Assistant: <think\\n</think>
          {% else %}
            Assistant: <think
    不显式传 enable_thinking=False 就会渲染出**未闭合**的 'Assistant: <think'，
    与关思考产出的教师稿错配。所以这里必须传。
    """
    try:
        return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_gen,
                                       enable_thinking=False)
    except TypeError as exc:
        raise ValueError("tokenizer-must-support-explicit-enable_thinking-false") from exc


def encode(tok, row: dict, max_len: int, eos_id: int, vocab_size=None):
    """Match the actual inference prefix exactly; never supervise prompt tokens.

    Tokenize the already-rendered inference prompt and completion separately.
    The previous longest-common-prefix fallback could silently supervise part of
    the prompt when a template/tokenizer drifted. Return drift=0 by construction.
    """
    prompt = render(tok, [{"role": "system", "content": row["system"]},
                          {"role": "user", "content": row["user"]}], True)
    pids = tok(prompt, add_special_tokens=False)["input_ids"]
    target = tok(row["assistant"] + "\n\n", add_special_tokens=False)["input_ids"]
    if not pids or not target:
        raise ValueError("empty-prompt-or-target-tokens")
    if vocab_size is not None and any(type(x) is not int or x < 0 or x >= vocab_size for x in pids + target):
        raise ValueError("tokenizer-id-outside-pinned-model-vocabulary")
    if eos_id in target[:-1]:
        raise ValueError("target-has-interior-eos:would-terminate-before-reviewed-content")
    if target[-1] != eos_id:
        target = target + [eos_id]
    ids = pids + target
    if len(ids) > max_len:
        return None, 0
    labels = [-100] * len(pids) + target
    return (ids, labels), 0


def batch_rows(rows: list, batch_size: int):
    """按长度排序后切批，减少 padding 浪费。"""
    order = sorted(range(len(rows)), key=lambda i: len(rows[i][0]))
    out = []
    for s in range(0, len(order), batch_size):
        out.append([rows[i] for i in order[s:s + batch_size]])
    return out


def fix_tied_weight_keys(model):
    """把 `_tied_weights_keys` 从 fla 的 list 归一成 transformers 5.x 要的 dict。

    transformers>=5 的 `_get_tied_weight_keys()` 会对每个子模块取
    `_tied_weights_keys` 然后调 `.keys()`（5.x 里它的类型是 dict[str, str]），
    而 fla 0.5.2 全线给的是 list（`_tied_weights_keys = ["lm_head.weight"]`）。
    于是 `save_pretrained` -> `remove_tied_weights_from_state_dict` ->
    `AttributeError: 'list' object has no attribute 'keys'`，**训练完好的一轮全丢**。
    （v8 就是这么没的：训练 10.6 分钟跑完，存档那一步炸了。）

    `from_pretrained` 之所以没事：5.x 的 `get_expanded_tied_weights_keys()` 在
    `if not tie_word_embeddings: return {}` 处提前返回，根本没走到 `.keys()`；
    而 `_get_tied_weight_keys()` 没有这道闸，所以只有存档会炸。

    为什么不无脑填 `{}`：万一 lm_head 与输入嵌入真的共享存储，声明"没有共享"
    只是把同一块写两遍（冗余，不致命）；反过来，把**不**共享的两块谎报成共享，
    save 会删掉 lm_head.weight，重新加载后 LM 头变随机数，而且全程不报错。
    所以先实测是否共享，再决定映射。
    """
    tied = {}
    shared = None
    try:
        out_w = model.get_output_embeddings().weight
        in_w = model.get_input_embeddings().weight
        shared = out_w.data_ptr() == in_w.data_ptr()
        if shared:
            tied = {"lm_head.weight": "model.embeddings.weight"}
    except Exception as e:  # 探测失败不该挡住存档
        print(f"! 共享存储探测失败（按不共享处理）：{type(e).__name__}: {e}", flush=True)
    n = 0
    for _, sub in model.named_modules():
        if isinstance(getattr(sub, "_tied_weights_keys", None), (list, tuple)):
            sub._tied_weights_keys = dict(tied)
            n += 1
    return n, shared


def verify_saved_weights(model, md: Path) -> str:
    """把刚写出去的权重读回来跟内存里的逐块对齐，返回一行摘要。

    `save_pretrained` 有太多"悄悄少写一块"的路径（tied 判定、dtype 转换、分片），
    只看它没抛异常是不够的 —— 少一块 lm_head 它也不抛。
    """
    from safetensors.torch import load_file
    live = model.state_dict()
    got = {}
    for f in sorted(md.glob("*.safetensors")):
        got.update(load_file(str(f)))
    if not got:
        raise RuntimeError(f"{md} 里没有任何 *.safetensors")
    missing = sorted(set(live) - set(got))
    extra = sorted(set(got) - set(live))
    shape_bad = sorted(k for k in got if k in live and tuple(got[k].shape) != tuple(live[k].shape))
    if missing or extra or shape_bad:
        raise RuntimeError(
            f"权重不齐：缺 {len(missing)} {missing[:4]} / 多 {len(extra)} {extra[:4]} / "
            f"形状不符 {len(shape_bad)} {shape_bad[:4]}")
    worst, worst_k, dt = 0.0, None, []
    for k, v in got.items():
        if v.dtype != live[k].dtype:
            dt.append(f"{k}:{live[k].dtype}->{v.dtype}")
        d = float((v.float() - live[k].detach().float().cpu()).abs().max())
        if d > worst:
            worst, worst_k = d, k
    note = f" · {len(dt)} 块 dtype 变了 {dt[:2]}" if dt else ""
    if worst > 1e-3:
        raise RuntimeError(f"写出去后对不上：max|Δ|={worst:.3e} @ {worst_k}{note}")
    return f"{len(got)} 块 · max|Δ|={worst:.2e} @ {worst_k}{note}"


def fixup_tokenizer_dir(md: Path, tok) -> str:
    """把词表补成 `vocab_files_names` 声明的那个文件名。

    fla-hub 的 `RwkvTokenizer.save_vocabulary()` 把词表**硬编码**写成 `vocab.txt`，
    可它自己声明的 `VOCAB_FILES_NAMES = {"vocab_file": "rwkv_vocab_v20230424.txt"}`；
    而 `PreTrainedTokenizer.save_pretrained()` 又会把 `vocab_file` 这个键从
    tokenizer_config.json 里 pop 掉（tokenization_utils_base.py:2067-2068 —— 它属于
    "按约定解析"的文件名，不该写进配置）。
    两边对不上：存出来的目录 `AutoTokenizer.from_pretrained(dir)` 会去找
    `rwkv_vocab_v20230424.txt`，而目录里只有 `vocab.txt`，**而且这一步不报错**，
    只在真正加载时才炸。所以这里按它声明的名字把原始词表补一份。
    """
    vfn = getattr(type(tok), "vocab_files_names", None) or {}
    name = vfn.get("vocab_file")
    if not name:
        return "词表未补（拿不到 vocab_files_names）"
    cands = []
    ik = getattr(tok, "init_kwargs", None) or {}
    if ik.get("vocab_file"):
        cands.append(Path(ik["vocab_file"]))
    hub = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))) / "hub"
    if hub.is_dir():  # 兜底：直接去 HF 缓存里翻
        cands += sorted(hub.glob(f"**/{name}"))
    srcp = next((c for c in cands if c.is_file()), None)
    if srcp is None:
        return f"词表未补（找不到源，试过 {[str(c) for c in cands[:3]]}）"
    dst = md / name
    shutil.copyfile(srcp, dst)
    return f"词表 {dst.name} <- {srcp}（{dst.stat().st_size} B）"


# ─────────────────────────── 主流程 ───────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser(allow_abbrev=False, description="RWKV7-0.1B 通用思维链压缩器 SFT")
    ap.add_argument("--data", required=True, help="训练 jsonl（build-sft.mjs 的 train.jsonl）")
    ap.add_argument("--dev", default=None, help="验证 jsonl")
    ap.add_argument("--out", default="/kaggle/working/rwkv7-compressor")
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--model-revision", help="必填：底座不可变的 40 位提交（不是 main）")
    ap.add_argument("--admission", help="cfb.sft-admission/1 准入记录；非 smoke 训练必填")
    ap.add_argument("--preflight-only", action="store_true", help="仅本地数据/准入核验；不导入 torch、不联网")
    ap.add_argument("--eos-token-id", type=int, help="tokenizer/config 不一致时必须显式给出已测的结束 id")
    ap.add_argument("--max-len", type=int, default=DEFAULT_MAX_LEN)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--warmup", type=float, default=0.03)
    ap.add_argument("--dtype", default="fp16", choices=["fp16", "bf16", "fp32"])
    ap.add_argument("--seed", type=int, default=20261007)
    ap.add_argument("--grad-ckpt", action="store_true", default=True)
    ap.add_argument("--no-grad-ckpt", dest="grad_ckpt", action="store_false")
    ap.add_argument("--gpus", type=int, default=0,
                    help="用几张卡。0=自动（有几张用几张，上限 2）")
    ap.add_argument("--chunk-size", type=int, default=16,
                    help="RWKV7 chunk 模式的 chunk_size。<=0 表示不改，用 fla 默认的 64")
    ap.add_argument("--smoke", action="store_true", help="只验证环境：编码 + 前向 + 一步反传 + 一次生成")
    ap.add_argument("--smoke-steps", type=int, default=3)
    ap.add_argument("--gen-n", type=int, default=20, help="训练后在 dev 上生成多少条稿子供本地尺子打分")
    ap.add_argument("--gen-max-new", type=int, default=768)
    ap.add_argument("--gen-budget", type=float, default=0,
                    help="生成阶段的时间预算（秒），0=不限。缓存不生效时防止生成阶段拖垮整轮")
    ap.add_argument("--ckpt-steps", default="",
                    help="学习曲线快照的步数，逗号分隔（如 40,120）。到点就 dev loss + 生成一次，然后接着训。空=不快照")
    ap.add_argument("--ckpt-gen-n", type=int, default=0,
                    help="快照点生成多少条（0=用 --gen-n）。曲线上的点要同 n 才能相比")
    ap.add_argument("--no-gen-cache", dest="gen_cache", action="store_false", default=True,
                    help="生成时不用状态缓存（慢一个数量级，只在缓存自检失败时才有意义）")
    return ap.parse_args(argv)


def reexec_under_torchrun(nproc: int, raw_argv: list) -> int:
    """在 torchrun 下把自己重开 nproc 份，用满所有卡。

    为什么必须这么做（Kaggle 实测，不是推演）：
      Kaggle 的 T4 x2 给的是**两张独立的卡**，torch.cuda.device_count() 报 2；
      但 script kernel 只跑一个进程，model.to("cuda") 和 tensor(device="cuda")
      全都落在 cuda:0 —— 第二张卡从头到尾空转。
      配额是按 session 挂钟时间扣的，不是按 GPU 秒，所以空转一张卡等于白扔一半配额。

    torchrun --standalone 会自己挑一个空闲端口、设好 MASTER_ADDR/LOCAL_RANK，
    然后每个 rank 各自跑一遍本脚本。CFB_DDP=1 用来防止无限递归重开。
    """
    env = dict(os.environ, CFB_DDP="1")
    cmd = [sys.executable, "-m", "torch.distributed.run",
           "--nproc_per_node", str(nproc),
           "--standalone",
           "--master_port", "29517",
           os.path.abspath(__file__)] + list(raw_argv)
    print(f"· 检测到 {nproc} 张卡 —— 单进程只会用 cuda:0，用 torchrun 重开跑满：", flush=True)
    print("  " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, env=env)
    return r.returncode


def main(argv=None) -> int:
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    args = parse_args(raw_argv)

    try:
        for name in ("epochs", "lr"):
            value = getattr(args, name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError("invalid-positive-hyperparameter:" + name)
        if min(args.batch, args.accum, args.max_len) <= 0:
            raise ValueError("invalid-positive-batch-accum-window")
        preflight = preflight_sft(args)
    except (ValueError, OSError, SystemExit) as exc:
        print(f"FATAL: preflight: {exc}", file=sys.stderr)
        return 2
    if args.preflight_only:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0
    # ---- 1. 环境：没有 CUDA 直接拒绝，不在 CPU 上假装训练 ----
    import torch
    if not torch.cuda.is_available():
        print("FATAL: 没有 CUDA。Kaggle 请把 Accelerator 设为 GPU T4 x2（P100 是 sm_60，"
              "fla 的 Triton kernel 不支持，会失败）。", file=sys.stderr)
        return 2
    ngpu = torch.cuda.device_count()
    if args.gpus <= 0:
        args.gpus = min(ngpu, 2)
    # 还没进 DDP、且要多卡 ⇒ 先重开自己。必须在建模型之前。
    if args.gpus > 1 and os.environ.get("CFB_DDP") != "1":
        return reexec_under_torchrun(args.gpus, raw_argv)

    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    world = int(os.environ.get("WORLD_SIZE", "1"))
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)
    is_main = local_rank == 0
    if world > 1:
        # 超时必须显式给。默认 30 分钟，而生成阶段只让 0 号跑，其余 rank 全挂在
        # 第 840 行那个 barrier 上等 —— 生成一超 30 分钟，rank1 先超时死，整轮在
        # 最后一步翻车（产物还在，但 report.json 写不下去）。
        torch.distributed.init_process_group(
            backend="nccl", timeout=datetime.timedelta(hours=3))
        # 非 0 号 rank 的 stdout 丢进 devnull：日志只留一份，stderr 不动（报错要看得到）
        if not is_main:
            sys.stdout = open(os.devnull, "w")

    gpu = torch.cuda.get_device_name(local_rank)
    cap = torch.cuda.get_device_capability(local_rank)
    print(f"· GPU {gpu} · sm_{cap[0]}{cap[1]} · torch {torch.__version__} · "
          f"{ngpu} 卡中用了 {world} 张（rank {local_rank}）", flush=True)
    if cap[0] < 7:
        print(f"FATAL: 计算能力 sm_{cap[0]}{cap[1]} < sm_70，fla 的 Triton kernel 无法编译。"
              "换 T4。", file=sys.stderr)
        return 2

    # ---- 2. fla：Kaggle 镜像里**没有** fla，必须自己装 ----
    # 装哪个包有讲究（实测 PyPI wheel 内容，不是猜）：
    #   · fla-core 0.5.2               = fla/ops + fla/modules + fla/utils，**没有 fla/models**
    #   · flash-linear-attention 0.5.2 = fla/layers + fla/models，依赖 fla-core==0.5.2
    # 而 HF 仓库 fla-hub/rwkv7-0.1B-g1 的 modeling_rwkv7.py 只是个 157 字符的转发
    # （from fla.models.rwkv7 import RWKV7ForCausalLM, RWKV7Model, RWKV7Config），
    # 所以 trust_remote_code=True 也救不了 —— 只有 flash-linear-attention 带 fla/models。
    # 用 --no-deps + 显式列依赖，避免 pip 顺手升级 torch/transformers 把镜像搞坏。
    def _fla_ready() -> bool:
        try:
            from fla.models.rwkv7 import RWKV7Config, RWKV7ForCausalLM  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False

    if _fla_ready():
        print("· fla.models.rwkv7 镜像里已有", flush=True)
    else:
        # 多卡时**只让 0 号装**。两个 rank 同时往同一个 site-packages 里 pip install
        # 是在赌 pip 的原子性：赢了没奖，输了整轮白跑（排队 + 下载 + 编译全废）。
        # 共享文件系统 ⇒ 两边 _fla_ready() 结果必然一致 ⇒ 分支对称，barrier 不会错配。
        if world > 1 and not is_main:
            torch.distributed.barrier()   # 等 0 号装完
        else:
            print("· fla.models.rwkv7 缺失 -> 装 flash-linear-attention==0.5.2", flush=True)
            # --progress-bar off：pip 的进度条里有 ▋ 这类字形，会让 Windows 上的
            # kaggle CLI 在按 GBK 落盘日志时崩掉（日志变成 0 字节，白跑一轮）。
            cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps",
                   "--progress-bar", "off",
                   "flash-linear-attention==0.5.2", "fla-core==0.5.2", "einops"]
            r = subprocess.run(cmd, capture_output=True, text=True)
            print(f"· pip install -> exit {r.returncode}", flush=True)
            if r.stdout.strip():
                print(r.stdout[-1500:], flush=True)
            if r.returncode != 0:
                print("FATAL: 装 flash-linear-attention 失败：\n" + r.stderr[-3000:],
                      file=sys.stderr)
                # 失败也要走到 barrier：否则非 0 号会一直挂在上面，直到 torchrun 超时。
                if world > 1:
                    torch.distributed.barrier()
                return 2
            if world > 1:
                torch.distributed.barrier()   # 通知其余 rank 可以导入了
        if not _fla_ready():
            print("FATAL: 装完仍导不进 fla.models.rwkv7", file=sys.stderr)
            return 2
    import transformers
    print(f"· fla ok · transformers {transformers.__version__}", flush=True)

    # ---- 2b. 把 RWKV7 的 chunk_size 从 64 压到 16（T4 上必须）----
    # fla/layers/rwkv7.py:310 在训练时写死 chunk_rwkv7(..., safe_gate=True, chunk_size=64)。
    # safe_gate=True 会让 chunk_A_bwd.py:505 选 tensorcore 版的 intra 反向 kernel，
    # 那个 kernel 里有 4 个 [BT,BT] 的 dA 矩阵，BT=64 时每个 8KB，加上 q/k/a/b/gi/ge
    # 共 6 个 [BT,BK]，合计 ~96KB。T4 每块只有 64KB shared memory ⇒
    #   triton OutOfResources: Required 98304, Hardware limit 65536
    # 而且那个 kernel 的 @triton.autotune 只扫 num_warps/num_stages，BK 是外部算好传进去的
    # 常量（chunk_A_bwd.py:490），autotune 碰不到 ⇒ 12 个配置全部超限，必然失败。
    # fla 自己在 dplr/chunk.py:156 写着 "we only support chunk_size=16 when safe_gate=True"，
    # 层里却写死 64。降到 16 是回到 fla 自己认可的配置，不是绕过。
    if args.chunk_size and args.chunk_size > 0:
        import fla.layers.rwkv7 as _fla_layer_rwkv7
        _orig_chunk_rwkv7 = _fla_layer_rwkv7.chunk_rwkv7

        def _chunk_rwkv7_small(*a, **kw):
            kw["chunk_size"] = args.chunk_size
            return _orig_chunk_rwkv7(*a, **kw)

        _fla_layer_rwkv7.chunk_rwkv7 = _chunk_rwkv7_small
        print(f"· chunk_size {args.chunk_size}"
              f"（T4 的 64KB 共享内存装不下 fla 默认的 64）", flush=True)
    else:
        print("· chunk_size 保持 fla 默认（64）—— T4 上会 OutOfResources", flush=True)

    from transformers import AutoModelForCausalLM, AutoTokenizer, AutoConfig

    torch.manual_seed(args.seed)

    # ---- 3. 分词器 ----
    tok = AutoTokenizer.from_pretrained(args.model, revision=args.model_revision, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    if tok.pad_token_id is None:
        print("FATAL: 分词器没有 pad/eos token，无法构造训练批次。", file=sys.stderr)
        return 2
    source_model_config = AutoConfig.from_pretrained(args.model, revision=args.model_revision, trust_remote_code=True)
    eos_id = resolve_eos_id(tok.eos_token_id, source_model_config.eos_token_id, source_model_config.vocab_size, args.eos_token_id)
    tokenizer_contract = {"tokenizerEos": tok.eos_token_id, "sourceModelEos": source_model_config.eos_token_id,
                          "selectedEos": eos_id, "explicitOverride": args.eos_token_id is not None,
                          "chatTemplateSha256": hashlib.sha256(str(tok.chat_template).encode()).hexdigest(),
                          "enableThinking": False}
    print(f"· tokenizer {type(tok).__name__} · vocab {tok.vocab_size} · "
          f"eos={tok.eos_token_id} pad={tok.pad_token_id}", flush=True)

    # ---- 4. 数据 ----
    data_path = fetch(args.data, Path("/kaggle/working/_train.jsonl"), world, is_main)
    if file_sha256(data_path) != preflight["trainSha256"]:
        raise SystemExit("FATAL: train changed after preflight")
    rows_raw = read_jsonl(data_path)
    if not rows_raw:
        print(f"FATAL: {data_path} 是空的。", file=sys.stderr)
        return 2
    for r in rows_raw:
        for k in ("system", "user", "assistant"):
            if not str(r.get(k, "")).strip():
                print(f"FATAL: 数据行缺字段 {k}：{r.get('id')}", file=sys.stderr)
                return 2
    print(f"· 读入 {len(rows_raw)} 行", flush=True)

    t0 = time.time()
    encoded, drifts, lens = [], [], []
    for r in rows_raw:
        pair, drift = encode(tok, r, args.max_len, eos_id, source_model_config.vocab_size)
        if pair is None:
            continue
        encoded.append(pair)
        drifts.append(drift)
        lens.append(len(pair[0]))
    print(f"· 编码完成 {len(encoded)}/{len(rows_raw)} 条（{time.time()-t0:.1f}s）"
          f"· 超窗丢弃 {len(rows_raw)-len(encoded)}", flush=True)
    if not encoded:
        print(f"FATAL: 全部超窗（max_len={args.max_len}）。放宽 --max-len 或换更小的单元。",
              file=sys.stderr)
        return 2
    lens.sort()
    n = len(lens)
    print(f"· token 长度 min {lens[0]} p50 {lens[n//2]} p90 {lens[int(n*0.9)]} max {lens[-1]}"
          f" · 窗口 {args.max_len} 占用 p50 {lens[n//2]/args.max_len:.1%}", flush=True)
    nz = [d for d in drifts if d != 0]
    print(f"· 掩码边界偏差：{len(nz)}/{len(drifts)} 条非零，max {max(drifts) if drifts else 0}"
          f"（持续偏大说明模板/分词器与预期不符，是必须看见的信号）", flush=True)

    dev_encoded = []
    if args.dev:
        dev_path = fetch(args.dev, Path("/kaggle/working/_dev.jsonl"), world, is_main)
        if file_sha256(dev_path) != preflight["devSha256"]:
            raise SystemExit("FATAL: dev changed after preflight")
        for r in read_jsonl(dev_path):
            pair, _ = encode(tok, r, args.max_len, eos_id, source_model_config.vocab_size)
            if pair is not None:
                dev_encoded.append((r, pair))
        print(f"· dev {len(dev_encoded)} 条", flush=True)

    if not args.smoke and len(dev_encoded) != preflight["devRows"]:
        raise SystemExit("FATAL: dev window filtering would change the frozen evaluation set; revise the prospective admission, not the old receipt")

    # ---- 5. 模型 ----
    # 为什么不是"把权重直接载成 fp16"（Kaggle T4 上真跑出来过，不是推演）：
    #   (a) 纯 fp16 权重 + 无 loss scaling -> 浅层梯度大量下溢成 0；AdamW 的 eps=1e-8
    #       也远小于 fp16 在 1e-2 附近的分辨率 -> 学不动。正确配方是 fp32 主权重 +
    #       autocast(fp16) + GradScaler（T4 是 sm_75，只有 fp16 有张量核）。
    #   (b) fla 0.5.2 的 l2_warp 在 fp16/bf16 logits 下 backward 必崩：
    #         fla/modules/l2warp.py:47  glogits.scatter_(-1, ids, maxx * grad_output)
    #         RuntimeError: scatter(): Expected self.dtype to be equal to src.dtype
    #       （glogits 跟着 logits 是 fp16，maxx*grad_output 是 fp32）。
    #       config.json 里根本没有 use_l2warp 这个键，dataclass 默认 True，必须显式关。
    #       复现环境：Kaggle T4 · torch 2.11.0+cu128 · transformers 5.16.1 · fla 0.5.2。
    amp_dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": None}[args.dtype]
    print(f"· 载入 {args.model}（主权重 fp32 · autocast {args.dtype}）…", flush=True)
    model = AutoModelForCausalLM.from_pretrained(args.model, revision=args.model_revision, trust_remote_code=True, dtype=torch.float32)
    model.config.use_l2warp = False
    model.config.eos_token_id = eos_id
    if getattr(model, "generation_config", None) is not None:
        model.generation_config.eos_token_id = eos_id
    # config.json 里 max_position_embeddings=2048 是配置残留（RWKV7 无位置编码，
    # fla 的代码路径从不读它），但 transformers 的 generate 会拿它当"预定义最大长度"
    # 报越界警告 —— 冒烟里 3522 token 的 prompt 就触发了。改成我们的真实窗口，
    # 既消掉噪音，也避免将来某个版本真去强制它。
    model.config.max_position_embeddings = max(args.max_len, 2048)
    model.to(device)
    if args.grad_ckpt:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False
    nparam = sum(p.numel() for p in model.parameters())
    if world > 1:
        # find_unused_parameters=True：开了 gradient checkpointing 之后，DDP 在第一次
        # 反传前推断不出完整的参数使用图，不打开会直接报 unused parameter 而崩。
        model = torch.nn.parallel.DistributedDataParallel(
            model, device_ids=[local_rank], output_device=local_rank,
            find_unused_parameters=True)
    # generate / dev 一律走未包裹的句柄：DDP 在 forward 里会 broadcast buffer，
    # 那是集合通信 —— 只有 0 号 rank 调 generate 的话，0 号会一直等 1 号，直接挂死。
    base_model = model.module if world > 1 else model
    torch.cuda.reset_peak_memory_stats()
    print(f"· 参数量 {nparam/1e6:.1f}M（全参微调 · fp32 主权重）"
          f"{f' · DDP {world} 卡' if world > 1 else ' · 单卡'}", flush=True)

    def collate(batch):
        maxlen = max(len(x[0]) for x in batch)
        ids, lab, am = [], [], []
        for i, l in batch:
            pad = maxlen - len(i)
            ids.append(i + [tok.pad_token_id] * pad)
            lab.append(l + [-100] * pad)
            am.append([1] * len(i) + [0] * pad)
        return (torch.tensor(ids, device=device), torch.tensor(lab, device=device),
                torch.tensor(am, device=device))

    batches, dropped = epoch_batches(encoded, args.batch, args.accum, world, local_rank, args.seed, 0)
    n_micro = len(batches) * world
    per_step = args.accum * world
    print(f"· 有种子的长度桶洗牌：rank {local_rank} 每轮 {len(batches)} 微批，"
          f"为对齐暂略 {dropped} 批（每轮重新洗牌，不固定丢最长样本）", flush=True)
    steps_per_epoch = max(1, n_micro // per_step)
    total_steps = max(1, int(steps_per_epoch * args.epochs))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                            lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    warm = max(1, int(total_steps * args.warmup))

    scaler = torch.amp.GradScaler("cuda", enabled=amp_dtype is not None)

    def forward_loss(ids, lab, am, scale=1.0):
        with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
            return model(input_ids=ids, attention_mask=am, labels=lab).loss * scale

    def lr_at(step):
        if step < warm:
            return args.lr * (step + 1) / warm
        prog = (step - warm) / max(1, total_steps - warm)
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * prog)))

    print(f"· 批 {args.batch} × 累积 {args.accum} = 有效批 {args.batch*args.accum}"
          f" · 每轮 {len(batches)} 微批 -> {steps_per_epoch} 步 · 共 {total_steps} 步", flush=True)

    # ---- 5b. 把 dev loss 与生成抽成函数 ----
    # 为什么必须抽出来：学习曲线要在每个快照点跑**同一段**代码。
    # 各写一份的后果不是报错，是"曲线上的点和终点用了不同的判据"，而那种差异
    # 在图上看起来就像"训练中途变差了"。同源测量是这套东西的底线。
    def dev_loss():
        if not (dev_encoded and is_main):
            return None
        base_model.eval()
        tot, cnt = 0.0, 0
        with torch.no_grad():
            for i in range(0, len(dev_encoded), args.batch):
                chunk = [p for _, p in dev_encoded[i:i + args.batch]]
                ids, lab, am = collate(chunk)
                with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
                    count = int((lab[:, 1:] != -100).sum().item())
                    if count <= 0:
                        raise ValueError("dev-batch-without-supervised-tokens")
                    loss_value = float(base_model(input_ids=ids, attention_mask=am, labels=lab).loss)
                    if not math.isfinite(loss_value):
                        raise ValueError("dev-loss-not-finite")
                    tot += loss_value * count
                cnt += count
        return tot / max(1, cnt)

    def gen_once(row, max_new, cache):
        prompt = render(tok, [{"role": "system", "content": row["system"]},
                              {"role": "user", "content": row["user"]}], True)
        enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
        t = time.time()
        with torch.no_grad(), torch.autocast("cuda", dtype=amp_dtype,
                                             enabled=amp_dtype is not None):
            o = base_model.generate(**enc, max_new_tokens=max_new, do_sample=False,
                                    use_cache=cache, pad_token_id=tok.pad_token_id,
                                    eos_token_id=eos_id)
        return (tok.decode(o[0][enc["input_ids"].shape[1]:], skip_special_tokens=True),
                time.time() - t)

    def generate(n, path):
        """生成 n 条稿子。**必须能被重复调用** —— 学习曲线每个点都调一次。"""
        if not (dev_encoded and is_main and n > 0):
            return 0
        base_model.eval()
        written, t_gen = 0, time.time()
        with path.open("w", encoding="utf-8") as f:
            for r, _ in dev_encoded[:n]:
                if args.gen_budget and time.time() - t_gen > args.gen_budget:
                    print(f"  · 生成到时间预算 {args.gen_budget:.0f}s，余 "
                          f"{n - written} 条不生成（样本变少，尺子上的置信区间会变宽）", flush=True)
                    break
                try:
                    txt, dt = gen_once(r, args.gen_max_new, args.gen_cache)
                except Exception as exc:  # noqa: BLE001
                    if not args.gen_cache:
                        raise
                    print(f"  · 缓存生成失败（{exc!r}）-> 回退到不开缓存", flush=True)
                    args.gen_cache = False
                    txt, dt = gen_once(r, args.gen_max_new, False)
                f.write(json.dumps({"id": r.get("id"), "raw": r.get("raw", ""),
                                    "ctx": r.get("ctx", ""), "draft": txt.strip()},
                                   ensure_ascii=False) + "\n")
                f.flush()
                written += 1
                print(f"  gen {written}/{n} · {len(txt)} 字 · {dt:.1f}s", flush=True)
        print(f"  · 生成 {written} 条 -> {path.name}（{time.time() - t_gen:.0f}s）", flush=True)
        return written

    # 缓存自检：只在**真要生成**的时候跑。
    # v9 的实测结论是反的：开缓存 31.0s / 不开 6.7s，**开缓存慢 4.6 倍**，
    # 而输出逐字一致。当时的代码只在"输出不一致"时才关缓存，从不在"变慢"时关 ——
    # 于是 v9 全程跑的是慢路径，生成阶段 34,687 token / 1164s = 29.8 token/s。
    # 所以这里加上"变慢就关"。两条判据都不能省：一条保正确性，一条保速度。
    if args.gen_n > 0 and dev_encoded and is_main and args.gen_cache:
        try:
            # ⚠ 必须**先热一次**再计时。v9 的自检拿到的是
            #   不开 6.7s / 开 31.0s，看起来“开缓存慢 4.6 倍”，
            #   但同一轮全量生成实测只有 29.8 token/s —— 比那个自检快 3 倍。
            #   两个数字打架，说明 6.7s 里大头是 **Triton 首次编译**，不是吞吐。
            #   拿没热过的数字去比快慢，得到的是编译时间的差，不是吞吐的差。
            gen_once(dev_encoded[0][0], 16, False)
            gen_once(dev_encoded[0][0], 16, True)
            a, ta = gen_once(dev_encoded[0][0], 64, False)
            b, tb = gen_once(dev_encoded[0][0], 64, True)
            same = a == b
            print(f"· 缓存自检 64 token：不开 {ta:.1f}s / 开 {tb:.1f}s"
                  f"（开/不开 = {tb / max(ta, 1e-6):.2f}x，热机后）· 输出{'逐字一致' if same else '不一致'}",
                  flush=True)
            if not same:
                print("  警告：开缓存后输出变了 -> 回退到不开缓存（慢，但不冒正确性的险）",
                      flush=True)
                args.gen_cache = False
            elif tb > ta * 1.2:
                # 20% 宽容：这两次采样本身就有抖动，卡在 1.0 会把噪声当信号。
                print("  开缓存确实更慢（热机后对比）-> 关掉", flush=True)
                args.gen_cache = False
        except Exception as exc:  # noqa: BLE001
            print(f"· 缓存自检就崩了（{exc!r}）-> 全程不开缓存", flush=True)
            args.gen_cache = False
        finally:
            torch.cuda.empty_cache()

    # ---- 6. 冒烟：把"能不能跑"和"跑得好不好"分开 ----
    if args.smoke:
        print("\\n=== 冒烟模式：只验证环境，不训练 ===", flush=True)
        model.train()
        losses, times = [], []
        for step in range(args.smoke_steps):
            ids, lab, am = collate(batches[step % len(batches)])
            torch.cuda.synchronize()
            t1 = time.time()
            loss = forward_loss(ids, lab, am, 1.0 / args.accum)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            opt.zero_grad(set_to_none=True)
            torch.cuda.synchronize()
            dt = time.time() - t1
            times.append(dt)
            losses.append(float(loss.detach()) * args.accum)
            print(f"  step {step+1}/{args.smoke_steps} loss {losses[-1]:.4f} · {dt:.1f}s"
                  f" · 峰值显存 {torch.cuda.max_memory_allocated()/2**30:.2f} GiB", flush=True)
        steady = min(times)
        print(f"· 前向+反传 合计 {sum(times):.1f}s · 首步 {times[0]:.1f}s（含 Triton 首次编译）"
              f" · 最快 {steady:.1f}s/步", flush=True)
        total_micro = total_steps * args.accum
        print(f"· 外推：全量 {total_steps} 步 × 累积 {args.accum} = 每卡 {total_micro} 微批"
              f" 约 {steady*total_micro/60:.0f} 分钟（按最快一步算，首步编译不计；Kaggle 上限 12 小时）",
              flush=True)
        if not all(math.isfinite(x) for x in losses):
            print("FATAL: 损失非有限值。", file=sys.stderr)
            return 3
        # 生成一条，验证 chat_template 与 generate 通路
        if dev_encoded and is_main:
            r, _ = dev_encoded[0]
            base_model.eval()
            with torch.no_grad(), torch.autocast("cuda", dtype=amp_dtype,
                                                 enabled=amp_dtype is not None):
                prompt = render(tok, [{"role": "system", "content": r["system"]},
                                      {"role": "user", "content": r["user"]}], True)
                enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
                g = time.time()
                out = base_model.generate(**enc, max_new_tokens=min(256, args.gen_max_new),
                                     do_sample=False, pad_token_id=tok.pad_token_id,
                                     eos_token_id=eos_id)
                txt = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
            print(f"· 生成通路 ok（{time.time()-g:.1f}s / 256 token）", flush=True)
            print("  ── 未训练模型的输出（应当是一堆不通顺的话，这是对的）──")
            print("  " + txt.strip().replace("\\n", " ")[:400], flush=True)
        # rank1 会先走到这里，rank0 还在生成。加个 barrier 对齐，
        # 否则 rank1 先退出进程，rank0 收尾时 NCCL 会报通信失败。
        if world > 1:
            torch.distributed.barrier()
        print("\\n=== 冒烟通过 ===", flush=True)
        if world > 1:
            torch.distributed.destroy_process_group()
        return 0

    # ---- 7c. 学习曲线点 ----
    #
    # 为什么要有这个：上一轮只有**一个终点**（步数 40），于是“欠训”和“目标函数不对”
    # 这两个完全不同的诊断在数据上**不可分离**。一条曲线就能分开：
    #   曲线还在上升  => 欠训，加步数/加数据有用；
    #   曲线平了    => 不是欠训，问题在目标函数（交叉熵表达不了“这一个 token 是致命的”）。
    # 曲线上每个点都要同 n 才能相比 —— n 不同的两点没有可比性，这一点必须写死在这里。
    ckpt_set = set()
    if args.ckpt_steps:
        try:
            ckpt_set = {int(x) for x in str(args.ckpt_steps).replace("，", ",").split(",") if x.strip()}
        except ValueError:
            print(f"FATAL: --ckpt-steps 解析不了：{args.ckpt_steps!r}", file=sys.stderr)
            return 2
        ckpt_set = {x for x in ckpt_set if 0 < x < total_steps}
        print(f"· 学习曲线快照步数：{sorted(ckpt_set)}（共 {total_steps} 步）", flush=True)
    curve = []
    ckpt_gen_n = args.ckpt_gen_n or args.gen_n
    # out_dir 必须在循环**之前**就存在 —— 曲线点要往里写文件。
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    def curve_point(at_step):
        """在一个步数上采一个点。**两个 rank 都必须调用** —— 里面有 barrier。"""
        was_training = model.training
        dl = dev_loss()
        # 生成期间必须关梯度检查点：transformers 会因为它与 use_cache 不兼容而把状态缓存一并关掉，
        # 于是每吐一个 token 都重算整段 prompt（O(n^2)）。这不是推演，是冒烟 v5 实测：256 token 37.5s。
        if args.grad_ckpt:
            base_model.gradient_checkpointing_disable()
        try:
            n = generate(ckpt_gen_n, out_dir / f"dev-generations-step{at_step}.jsonl")
        finally:
            if args.grad_ckpt:
                base_model.gradient_checkpointing_enable()
        if is_main:
            checkpoint = out_dir / f"checkpoint-step{at_step}"
            checkpoint.mkdir(parents=True, exist_ok=True)
            temporary_weights = checkpoint / "weights.pt.tmp"
            torch.save(base_model.state_dict(), temporary_weights)
            os.replace(temporary_weights, checkpoint / "weights.pt")
            base_model.config.save_pretrained(checkpoint)
            rec = {"weightsFile": f"checkpoint-step{at_step}/weights.pt",
                   "weightsSha256": file_sha256(checkpoint / "weights.pt"),
                   "weightSnapshotOnly": True, "resumeTrainingState": False,
                   "modelRevision": args.model_revision, "dataPreflight": preflight, "tokenizerContract": tokenizer_contract,
                   "requestedGenN": min(ckpt_gen_n, len(dev_encoded)), "step": at_step, "devLoss": None if dl is None else round(dl, 4),
                   "genRows": n, "genFile": f"dev-generations-step{at_step}.jsonl",
                   "minutes": round((time.time() - t0) / 60, 1)}
            curve.append(rec)
            print(f"· 【学习曲线】step {at_step} · dev loss "
                  f"{rec['devLoss']} · 生成 {n} 条 · 已用 {rec['minutes']}m", flush=True)
            (out_dir / "learning-curve.json").write_text(
                json.dumps(curve, ensure_ascii=False, indent=2), encoding="utf-8")
        # 回到训练模式。不恢复的话后面的 step 全在 eval 模式下跑 ——
        # 不会报错，只是 BatchNorm/Dropout 行为变了，而 RWKV7 里 dropout 确实存在。
        if was_training:
            model.train()
        if world > 1:
            torch.distributed.barrier()

    # ---- 7. 训练 ----
    model.train()
    step, micro, epoch = 0, 0, 0
    running, hist = 0.0, []
    t0 = time.time()
    done = False
    while not done:
        batches, _ = epoch_batches(encoded, args.batch, args.accum, world, local_rank, args.seed, epoch)
        for b in batches:
            ids, lab, am = collate(b)
            loss = forward_loss(ids, lab, am, 1.0 / args.accum)
            scaler.scale(loss).backward()
            running += float(loss.detach())
            micro += 1
            if micro % args.accum == 0:
                for gp in opt.param_groups:
                    gp["lr"] = lr_at(step)
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(opt)
                scaler.update()
                opt.zero_grad(set_to_none=True)
                hist.append((step, running, lr_at(step)))
                if step % 10 == 0 or step == total_steps - 1:
                    print(f"  step {step+1}/{total_steps} loss {running:.4f} "
                          f"lr {lr_at(step):.2e} elapsed {(time.time()-t0)/60:.1f}m", flush=True)
                running = 0.0
                step += 1
                # 快照点插在**参数已更新之后、下一步之前**，否则读到的是上一步的权重。
                # 这种偏一步的错不会报错，只会让曲线整体左移。
                if step in ckpt_set:
                    curve_point(step)
                if step >= total_steps:
                    done = True
                    break
        epoch += 1
        if epoch > 100:
            break
    print(f"· 训练结束 {step} 步，{(time.time()-t0)/60:.1f} 分钟", flush=True)

    # ---- 7b. 先存档，再做 dev / 生成 ----
    # 顺序是有意的：生成阶段要跑十几分钟，中途任何异常（OOM、缓存不兼容、
    # 下载被打断）都会让一整轮训练白跑。先把权重落盘，后面崩了模型也还在。
    # 两个 rank 同时 save_pretrained 到同一目录会互相踩，只让 0 号写。
    #
    # 但存档**绝不能反过来杀掉评测**。v8 的教训：save_pretrained 抛了
    # AttributeError（fla 的 _tied_weights_keys 是 list，transformers 5.x 要 dict），
    # 异常一路穿出 main()，把已经跑完的 10.6 分钟训练和还没跑的 dev/生成一起带走。
    # 所以：先修根因，再整块兜住，最后还有一条 torch.save 的兜底。
    # out_dir 已在 7c 里建好（曲线点要用）。
    if world > 1:
        torch.distributed.barrier()
    if is_main:
        md = out_dir / "model"
        md.mkdir(parents=True, exist_ok=True)
        n_fix, tied_shared = fix_tied_weight_keys(base_model)
        print(f"· _tied_weights_keys 归一 {n_fix} 个模块 · "
              f"lm_head 与输入嵌入共享存储={tied_shared}", flush=True)
        ok = False
        try:
            base_model.save_pretrained(md)
            tok.save_pretrained(md)
            print(f"· {fixup_tokenizer_dir(md, tok)}", flush=True)
            print(f"· 存档校验 {verify_saved_weights(base_model, md)}", flush=True)
            print(f"· 已存档 {md}", flush=True)
            ok = True
        except Exception as e:
            print(f"! save_pretrained 失败：{type(e).__name__}: {e}", flush=True)
        if not ok:
            # 兜底：至少把原始权重留下来，别让一整轮训练白跑。
            try:
                raw = out_dir / "model_raw_state_dict.pt"
                torch.save(base_model.state_dict(), raw)
                base_model.config.save_pretrained(md)
                tok.save_pretrained(md)
                fixup_tokenizer_dir(md, tok)
                print(f"· 兜底存档 {raw}（标准布局没写成，推理端要改读法）", flush=True)
            except Exception as e:
                print(f"! 兜底存档也失败：{type(e).__name__}: {e}", flush=True)

    # 关掉梯度检查点。它在 eval 下本来就不生效，但 transformers 会因为
    # "gradient checkpointing 与 use_cache 不兼容" 把生成的状态缓存一并关掉 ——
    # 于是每吐一个 token 都要把整段 prompt 重算一遍（O(n^2)）。
    # 冒烟 v5 里 256 token 花了 37.5s（约 6.8 token/s）就是这么来的。
    if args.grad_ckpt:
        base_model.gradient_checkpointing_disable()

    # ---- 8. dev 损失（只 0 号 rank，走未包裹句柄）----
    dl_final = dev_loss()
    if dl_final is not None:
        print(f"· dev loss {dl_final:.4f}（{len(dev_encoded)} 条）", flush=True)

    # ---- 9. 生成稿子，交给本地尺子打分（不在这里自评）----
    # 路径与学习曲线终点一致，不另起一个名字 —— 名字不一致的后果是本地脚本拿不到文件，
    # 而拿不到文件不会报错，只会静默地去评一个不存在的东西。
    gen_path = out_dir / "dev-generations.jsonl"
    gen_rows = generate(args.gen_n, gen_path)
    if gen_rows:
        print(f"· 生成 {gen_rows} 条 -> {gen_path}（用 tools/eval-sft.mjs 本地打分）", flush=True)

    report = {
        "model": args.model, "modelRevision": args.model_revision, "dataPreflight": preflight, "tokenizerContract": tokenizer_contract,
        "shuffle": "seeded-length-buckets-per-epoch", "params": nparam, "maxLen": args.max_len, "dtype": args.dtype,
        "trainRows": len(rows_raw), "kept": len(encoded), "overWindow": len(rows_raw) - len(encoded),
        "devRows": len(dev_encoded), "steps": step, "epochs": args.epochs, "lr": args.lr,
        "batch": args.batch, "accum": args.accum, "gpu": gpu, "sm": f"sm_{cap[0]}{cap[1]}",
        "minutes": round((time.time() - t0) / 60, 1), "lossTail": hist[-10:],
        "maskDriftNonZero": len(nz),
        "genRows": gen_rows, "genCache": bool(args.gen_cache), "genBudget": args.gen_budget,
        "devLossFinal": None if dl_final is None else round(dl_final, 4),
        "curve": curve, "ckptSteps": sorted(ckpt_set), "ckptGenN": ckpt_gen_n,
    }
    # rank1 跳过了 dev 损失和生成，会先到这里 —— 对齐后再收尾，理由同上。
    if world > 1:
        torch.distributed.barrier()
    if is_main:
        (out_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"· 产出 {out_dir}", flush=True)
    if world > 1:
        torch.distributed.destroy_process_group()
    return 0


if __name__ == "__main__":
    sys.exit(main())
