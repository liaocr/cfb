"""Pure-Python mirror of tools/helpers/mode1-quality.mjs target-text audit.

Keep these patterns in lockstep: the Kaggle trainer uses this preflight before fitting,
while the repository's builders and JS evaluator use the canonical JavaScript helper.
Source raw/context is intentionally not scanned; only produced targets are audited.
"""

import re

MODE1_APPARATUS_PATTERNS = [
    re.compile(r"沙箱[^。！？\n]{0,48}(?:白名单|直接放行|已内置|直接可用|可用|无需|不用|禁止新建|不支持)", re.I),
    re.compile(r"白名单[^。！？\n]{0,40}(?:直接放行|直接可用|无需|不用|不要再试探)", re.I),
    re.compile(r"(?:不要|无需|不用)[^。！？\n]{0,32}(?:试探|检查)[^。！？\n]{0,24}(?:沙箱|环境)", re.I),
    re.compile(r"(?:our|this|current)\s+(?:sandbox|environment)[^.!?\n]{0,64}(?:allowlist|white.?list|directly allowed|already allowed|no need to test|no need to probe)", re.I),
    re.compile(r"(?:sandbox|environment)[^.!?\n]{0,56}(?:allowlist|white.?list)[^.!?\n]{0,32}(?:enabled|active|already allowed|directly allowed|无需测试|不要再试探)", re.I),
    re.compile(r"下一轮\s*(?:是|到)?\s*第\s*\d+\s*轮[^。！？\n]{0,100}(?:最后一轮|没有第\s*\d+\s*轮|严禁|禁止|必须|不再|预算)", re.I),
    re.compile(r"第\s*\d+\s*轮[^。！？\n]{0,100}(?:严禁|禁止|最后一轮|没有第\s*\d+\s*轮|不再发起|工具调用|预算上限)", re.I),
    re.compile(r"(?:最后一轮|轮数预算|实验预算)[^。！？\n]{0,80}(?:没有第\s*\d+\s*轮|不再|必须|严禁|禁止|上限)", re.I),
    re.compile(r"(?:last|final)\s+(?:experiment\s+)?round[^.!?\n]{0,80}(?:no more rounds?|must not|forbid|budget)", re.I),
    re.compile(r"(?:本轮|下一轮|第\s*\d+\s*轮)[^。！？\n]{0,56}(?:最多|至多|仅限|只允许|预算上限|不得再|禁止再|不再发起)[^。！？\n]{0,24}\d+\s*(?:轮|次|个工具调用)", re.I),
    re.compile(r"(?:this|next|final|last)\s+(?:experiment\s+)?round[^.!?\n]{0,64}(?:only|limit|budget|no more|must stop)", re.I),
    re.compile(r"(?:严禁|禁止|不要|不准|不许|别)(?:先|再|继续|重复|任何)?(?:发起|调用|使用|用|读|读取|重读|查看|打开|运行|执行|检查|试跑|试探)\s*(?:任何)?(?:工具调用|调用工具|工具|read_file|edit_file|bash|grep|sed|shell|命令|文件|沙箱|环境)", re.I),
    re.compile(r"(?:严禁|禁止|不要|不准|不许|别)(?:任何)?(?:工具调用|调用工具|工具使用|发起工具调用|read_file|edit_file)", re.I),
    re.compile(r"(?:不需要|无需|不必)(?:任何)?(?:工具调用|调用工具|工具使用)", re.I),
    re.compile(r"(?:do not|don't|must not|never|no need to|don't need to)\s+(?:call|use|invoke|read|open|probe|run)\s+(?:any\s+)?(?:tools?|read_file|edit_file|files?\s+first|sandbox|shell|commands?|bash|grep)", re.I),
    re.compile(r"(?:do not|don't|must not|never|no need to)\s+(?:call any tools|invoke tools|read the file first|re-read files|probe the sandbox|run a test first)", re.I),
]


def mode1_apparatus_issues(text):
    value = str(text or "")
    return [str(i) for i, pattern in enumerate(MODE1_APPARATUS_PATTERNS) if pattern.search(value)]


def _squeeze(value):
    return "".join(str(value or "").split())


RULE_PATTERN_RANGES = [(0, 5), (5, 11), (11, 16)]   # environment-permission / round-budget / tool-prohibition
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？；;])|(?<=\n)")
# 定界引用（「…」/“…”/`…`）——只有被这样框住、且在证据里原样出现的片段才算「报告观测」
QUOTE_RES = [re.compile(r"「([^」]{6,400})」"), re.compile(r"“([^”]{6,400})”"), re.compile(r"`([^`\n]{6,400})`")]


def _split_sentences(value):
    return [x.strip() for x in _SENTENCE_SPLIT.split(str(value or "")) if x.strip()]


def mode1_output_issues(text, evidence_text=None):
    """Number of apparatus categories a produced target is guilty of.

    Mirrors the JS reference linter exactly: one hit per category (first matching pattern wins).
    With `evidence_text` (raw ∪ ctx) a hit is exempt when the whole sentence carrying it already
    appears verbatim in the evidence shown to the writer — that is the program echoing a tool result
    back (e.g. 「bash: 该沙箱不支持 shell 循环…」 inside 【延续段】), not a claim made by the drafter.
    """
    value = str(text or "")
    evidence = _squeeze(evidence_text) if evidence_text else ""
    sentences = _split_sentences(value) if evidence else []
    kept = 0
    for lo, hi in RULE_PATTERN_RANGES:
        matched = None
        host = None
        for idx in range(lo, hi):
            m = MODE1_APPARATUS_PATTERNS[idx].search(value)
            if m:
                matched = m
                break
        if matched is None:
            continue
        if evidence:
            for sentence in sentences:
                if matched.group(0) in sentence:
                    host = sentence
                    break
            if host is not None and _squeeze(host) in evidence:
                continue
            # 逐字引用免检：命中片段落在「…」/“…”/`…` 引号内，且引号内容原样出现在给作者的证据里
            if host is not None:
                at = host.find(matched.group(0))
                quoted = []
                for rx in QUOTE_RES:
                    for m in rx.finditer(host):
                        if m.start() <= at < m.end() and len(m.group(1)) >= 6:
                            quoted.append(m.group(1))
                if any(_squeeze(q) in evidence for q in quoted):
                    continue
        kept += 1
    return kept


def mode1_apparatus_categories(text):
    """Return the same deduplicated category names as the JS reference linter."""
    hits = {int(i) for i in mode1_apparatus_issues(text)}
    categories = []
    if any(i in hits for i in range(0, 5)):
        categories.append("environment-permission-assertion")
    if any(i in hits for i in range(5, 11)):
        categories.append("experiment-round-or-budget-control")
    if any(i in hits for i in range(11, 16)):
        categories.append("executor-tool-or-check-prohibition")
    return categories


def _compact_utf8_json_sha256(value):
    """Match Node JSON.stringify for the simple text-only audit payloads used here."""
    import hashlib
    import json

    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def mode1_pair_text_sha256(chosen_text, rejected_text):
    """Digest the exact chosen/rejected strings with the canonical JS audit encoding."""
    if not isinstance(chosen_text, str) or not isinstance(rejected_text, str):
        return None
    return _compact_utf8_json_sha256({"chosenText": chosen_text, "rejectedText": rejected_text})


def mode1_pair_content_audit_valid(pair):
    """Fail closed unless the clean contentAudit binds both exact target strings."""
    if not isinstance(pair, dict):
        return False
    chosen_text = pair.get("chosenText")
    rejected_text = pair.get("rejectedText")
    if not isinstance(chosen_text, str) or not isinstance(rejected_text, str):
        return False
    if not chosen_text.strip() or not rejected_text.strip():
        return False
    if mode1_apparatus_issues(chosen_text) or mode1_apparatus_issues(rejected_text):
        return False
    audit = pair.get("contentAudit")
    return (
        isinstance(audit, dict)
        and audit.get("schema") == "cfb.mode1-content-audit/1"
        and audit.get("status") == "clean"
        and audit.get("textSha256") == mode1_pair_text_sha256(chosen_text, rejected_text)
        and audit.get("checkedFields") == ["chosenText", "rejectedText"]
        and audit.get("issues") == []
    )


def mode1_capture_quality_audit_valid(sample):
    """Validate a trainable, self-contained capture's recorded draft/stored audit and exact text hash."""
    if not isinstance(sample, dict) or sample.get("trainingEligible") is not True or sample.get("gateEligible") is not True:
        return False
    target_count = sample.get("trainableTargetsAdded")
    if isinstance(target_count, bool) or not isinstance(target_count, int) or target_count < 1:
        return False
    if not isinstance(sample.get("raw"), str) or not sample["raw"].strip():
        return False
    if not isinstance(sample.get("ctx"), str) or not sample["ctx"].strip():
        return False
    draft = sample.get("draft")
    stored = sample.get("stored")
    if not isinstance(draft, str) or not isinstance(stored, str) or not draft.strip() or not stored.strip():
        return False
    evidence = (sample.get("raw") or "") + "\n" + (sample.get("ctx") or "")
    if mode1_output_issues(draft, evidence) or mode1_output_issues(stored, evidence):
        return False
    expected_hash = _compact_utf8_json_sha256({"draft": draft, "stored": stored})
    audit = sample.get("qualityAudit")
    return (
        isinstance(audit, dict)
        and audit.get("schema") == "cfb.mode1-content-audit/1"
        and audit.get("status") == "clean"
        and audit.get("textSha256") == expected_hash
        and audit.get("checkedFields") == ["draft", "stored"]
        and audit.get("issues") == []
    )
