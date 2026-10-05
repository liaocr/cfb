import crypto from 'node:crypto'

export const MODE1_QUALITY_SCHEMA = 'cfb.mode1-content-audit/1'

const RULES = [
  {
    category: 'environment-permission-assertion',
    patterns: [
      /沙箱[^。！？\n]{0,48}(?:白名单|直接放行|已内置|直接可用|可用|无需|不用|禁止新建|不支持)/i,
      /白名单[^。！？\n]{0,40}(?:直接放行|直接可用|无需|不用|不要再试探)/i,
      /(?:不要|无需|不用)[^。！？\n]{0,32}(?:试探|检查)[^。！？\n]{0,24}(?:沙箱|环境)/i,
      /(?:our|this|current)\s+(?:sandbox|environment)[^.!?\n]{0,64}(?:allowlist|white.?list|directly allowed|already allowed|no need to test|no need to probe)/i,
      /(?:sandbox|environment)[^.!?\n]{0,56}(?:allowlist|white.?list)[^.!?\n]{0,32}(?:enabled|active|already allowed|directly allowed|无需测试|不要再试探)/i,
    ],
  },
  {
    category: 'experiment-round-or-budget-control',
    patterns: [
      /下一轮\s*(?:是|到)?\s*第\s*\d+\s*轮[^。！？\n]{0,100}(?:最后一轮|没有第\s*\d+\s*轮|严禁|禁止|必须|不再|预算)/i,
      /第\s*\d+\s*轮[^。！？\n]{0,100}(?:严禁|禁止|最后一轮|没有第\s*\d+\s*轮|不再发起|工具调用|预算上限)/i,
      /(?:最后一轮|轮数预算|实验预算)[^。！？\n]{0,80}(?:没有第\s*\d+\s*轮|不再|必须|严禁|禁止|上限)/i,
      /(?:last|final)\s+(?:experiment\s+)?round[^.!?\n]{0,80}(?:no more rounds?|must not|forbid|budget)/i,
      /(?:本轮|下一轮|第\s*\d+\s*轮)[^。！？\n]{0,56}(?:最多|至多|仅限|只允许|预算上限|不得再|禁止再|不再发起)[^。！？\n]{0,24}\d+\s*(?:轮|次|个工具调用)/i,
      /(?:this|next|final|last)\s+(?:experiment\s+)?round[^.!?\n]{0,64}(?:only|limit|budget|no more|must stop)/i,
    ],
  },
  {
    category: 'executor-tool-or-check-prohibition',
    patterns: [
      /(?:严禁|禁止|不要|不准|不许|别)(?:先|再|继续|重复|任何)?(?:发起|调用|使用|用|读|读取|重读|查看|打开|运行|执行|检查|试跑|试探)\s*(?:任何)?(?:工具调用|调用工具|工具|read_file|edit_file|bash|grep|sed|shell|命令|文件|沙箱|环境)/i,
      /(?:严禁|禁止|不要|不准|不许|别)(?:任何)?(?:工具调用|调用工具|工具使用|发起工具调用|read_file|edit_file)/i,
      /(?:不需要|无需|不必)(?:任何)?(?:工具调用|调用工具|工具使用)/i,
      /(?:do not|don't|must not|never|no need to|don't need to)\s+(?:call|use|invoke|read|open|probe|run)\s+(?:any\s+)?(?:tools?|read_file|edit_file|files?\s+first|sandbox|shell|commands?|bash|grep)/i,
      /(?:do not|don't|must not|never|no need to)\s+(?:call any tools|invoke tools|read the file first|re-read files|probe the sandbox|run a test first)/i,
    ],
  },
]

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex')

/** Sentence-level split used for the quoted-evidence exemption (keeps the terminator with the sentence). */
const splitSentences = (value) => String(value || '').split(/(?<=[。！？；;])|(?<=\n)/).map((s) => s.trim()).filter(Boolean)
const squeeze = (value) => String(value || '').replace(/\s+/g, '')
/** Delimited quotations inside a produced target: 「…」, "…", `…`. These are the only spans allowed to launder evidence. */
const QUOTE_RES = [/「([^」]{6,400})」/g, /“([^”]{6,400})”/g, /`([^`\n]{6,400})`/g]
/**
 * A produced target may quote text that the writer was actually shown — either the program's ledger
 * echo of the previous round's tool output (【延续段】/【台账】 quoting `bash: 该沙箱不支持 shell 循环…`)
 * or an explicit 「…」/`…` citation of that observation. Such text is a **report**, not a claim, and
 * HAND_PROTOCOL requires reporting the observation without extrapolating an environment guarantee.
 * So a flagged span is exempt iff either
 *   (a) the whole sentence carrying it appears verbatim in `evidenceText` (= raw ∪ ctx), or
 *   (b) the flagged span sits inside a delimited quote whose content appears verbatim in `evidenceText`.
 * Anything the drafter asserted in its own voice is never exempt.
 */
export function exemptQuotedIssues(value, issues, evidenceText) {
  const found = (issues || []).length ? issues : []
  const evidence = squeeze(evidenceText || '')
  if (!evidence || !found.length) return { issues: found, exempted: [] }
  const sentences = splitSentences(value)
  const kept = [], exempted = []
  for (const issue of found) {
    const excerpt = String(issue.excerpt || '')
    if (!excerpt) { kept.push(issue); continue }
    const host = sentences.find((s) => s.includes(excerpt))
    if (!host) { kept.push(issue); continue }
    if (evidence.includes(squeeze(host))) { exempted.push({ ...issue, sentence: host.slice(0, 160), basis: 'verbatim-sentence-from-raw-or-ctx' }); continue }
    const at = host.indexOf(excerpt)
    const quoted = []
    for (const re of QUOTE_RES) { re.lastIndex = 0; for (const m of host.matchAll(re)) if (m.index <= at && at < m.index + m[0].length) quoted.push(m[1]) }
    const hit = quoted.find((q) => q.length >= 6 && evidence.includes(squeeze(q)))
    if (hit) { exempted.push({ ...issue, sentence: host.slice(0, 160), basis: 'verbatim-quote-from-raw-or-ctx', quote: hit.slice(0, 140) }); continue }
    kept.push(issue)
  }
  return { issues: kept, exempted }
}

/**
 * Detect only the three experiment-apparatus leak classes identified in the gold audit.
 * The source transcript (raw/context) is deliberately not scanned: only produced targets
 * (draft/stored) can become training labels or be presented as the reusable gold standard.
 * Pass `evidenceText` (raw ∪ ctx) to exempt sentences that merely quote the evidence back.
 */
export function auditMode1Output(text, evidenceText = null) {
  const value = String(text || '')
  const issues = []
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(value)
      if (match) {
        issues.push({ category: rule.category, excerpt: match[0].slice(0, 120) })
        break
      }
    }
  }
  if (!evidenceText) return { status: issues.length ? 'quarantined' : 'clean', issues, exempted: [] }
  const exemptedResult = exemptQuotedIssues(value, issues, evidenceText)
  return { status: exemptedResult.issues.length ? 'quarantined' : 'clean', issues: exemptedResult.issues, exempted: exemptedResult.exempted }
}

export function auditMode1Pair(item, { reviewer = 'deterministic-mode1-audit/1', reviewedAt = null } = {}) {
  const chosenText = String(item?.chosenText ?? item?.chosen?.draft ?? item?.chosen ?? '')
  const rejectedText = String(item?.rejectedText ?? item?.rejected?.draft ?? item?.rejected ?? '')
  const issues = []
  if (!chosenText.trim() || !rejectedText.trim()) issues.push({ category: 'incomplete-target-text', field: !chosenText.trim() ? 'chosenText' : 'rejectedText' })
  issues.push(...auditMode1Output(chosenText).issues.map((issue) => ({ ...issue, field: 'chosenText' })))
  issues.push(...auditMode1Output(rejectedText).issues.map((issue) => ({ ...issue, field: 'rejectedText' })))
  return {
    schema: MODE1_QUALITY_SCHEMA,
    status: issues.length ? 'quarantined' : 'clean',
    reviewer,
    reviewedAt,
    checkedFields: ['chosenText', 'rejectedText'],
    textSha256: sha256(JSON.stringify({ chosenText, rejectedText })),
    issues,
  }
}

export function isMode1PairEligible(item, { requireRecorded = true, requireManualReview = false } = {}) {
  const computed = auditMode1Pair(item)
  if (computed.status !== 'clean') return false
  if (requireRecorded) {
    const recorded = item?.contentAudit
    if (recorded?.schema !== MODE1_QUALITY_SCHEMA
        || recorded?.status !== 'clean'
        || recorded?.textSha256 !== computed.textSha256
        || JSON.stringify(recorded?.checkedFields) !== JSON.stringify(['chosenText', 'rejectedText'])
        || !Array.isArray(recorded?.issues)
        || recorded.issues.length !== 0) return false
  }
  if (!requireManualReview) return true
  const manual = item?.manualReview
  return manual?.schema === 'cfb.mode1-manual-review/1'
    && manual?.status === 'clear-of-apparatus'
    && manual?.pairTextSha256 === computed.textSha256
}

/**
 * Gold eligibility audits **what the writer authored**. `stored` is the program-spliced artifact
 * (draft + 【延续段】/【状态部件】/【在手行】), so a flagged sentence there is judged on the same terms
 * as a draft sentence: it counts only when the writer claimed it, not when the program copied the
 * evidence back verbatim (the old behaviour convicted two clean hand drafts on a `bash: 该沙箱不支持…`
 * tool echo). `textSha256` still binds both byte-for-byte, so nothing can be swapped in silently.
 */
export function auditMode1Gold(item, { reviewer = 'deterministic-mode1-audit/1', reviewedAt = null } = {}) {
  const evidence = String(item?.raw ?? '') + '\n' + String(item?.ctx ?? '')
  const draftAudit = auditMode1Output(item?.draft ?? item?.gold ?? item?.hand ?? '', evidence)
  const storedAudit = item?.stored == null ? { status: 'not-present', issues: [], exempted: [] } : auditMode1Output(item.stored, evidence)
  const issues = [
    ...draftAudit.issues.map((issue) => ({ ...issue, field: 'draft' })),
    ...storedAudit.issues.map((issue) => ({ ...issue, field: 'stored' })),
  ]
  const textSha256 = sha256(JSON.stringify({ draft: item?.draft ?? '', stored: item?.stored ?? null }))
  return {
    schema: MODE1_QUALITY_SCHEMA,
    status: issues.length ? 'quarantined' : 'clean',
    reviewer,
    reviewedAt,
    checkedFields: item?.stored == null ? ['draft'] : ['draft', 'stored'],
    textSha256,
    issues,
    exempted: [...draftAudit.exempted.map((e) => ({ ...e, field: 'draft' })), ...storedAudit.exempted.map((e) => ({ ...e, field: 'stored' }))],
  }
}

export function isMode1GoldEligible(item) {
  if (!item || item.validated !== true) return false
  const audit = auditMode1Gold(item)
  if (audit.status !== 'clean') return false
  const recorded = item.qualityAudit
  // Legacy entries may be evaluated by the linter; a recorded audit is trusted only for
  // the exact draft/stored bytes and the supported audit schema.
  if (recorded && (recorded.schema !== MODE1_QUALITY_SCHEMA || recorded.status !== 'clean' || recorded.textSha256 !== audit.textSha256)) return false
  return true
}

export function allowedMode1Capture(sample) {
  const evidence = String(sample?.raw ?? '') + '\n' + String(sample?.ctx ?? '')
  const draftAudit = auditMode1Output(sample?.draft ?? '', evidence)
  const storedAudit = sample?.stored == null ? { status: 'not-present', issues: [], exempted: [] } : auditMode1Output(sample.stored, evidence)
  // A capture becomes a training label, so both authored targets must be clean; the quoted-evidence
  // exemption above is what keeps a program-spliced tool echo from disqualifying an otherwise good round.
  const issues = [
    ...draftAudit.issues.map((issue) => ({ ...issue, field: 'draft' })),
    ...storedAudit.issues.map((issue) => ({ ...issue, field: 'stored' })),
  ]
  const gatesPass = sample?.gate?.ok === true && sample?.production?.ok === true
  return {
    trainingEligible: gatesPass && issues.length === 0,
    gatesPass,
    qualityAudit: {
      schema: MODE1_QUALITY_SCHEMA,
      status: issues.length ? 'quarantined' : 'clean',
      checkedFields: sample?.stored == null ? ['draft'] : ['draft', 'stored'],
      textSha256: sha256(JSON.stringify({ draft: sample?.draft ?? '', stored: sample?.stored ?? null })),
      issues,
      exempted: [...draftAudit.exempted.map((e) => ({ ...e, field: 'draft' })), ...storedAudit.exempted.map((e) => ({ ...e, field: 'stored' }))],
    },
  }
}

export function isMode1CaptureAuditEligible(sample) {
  if (sample?.trainingEligible !== true || sample?.gateEligible !== true
      || !Number.isInteger(sample?.trainableTargetsAdded) || sample.trainableTargetsAdded < 1
      || typeof sample?.raw !== 'string' || !sample.raw.trim()
      || typeof sample?.ctx !== 'string' || !sample.ctx.trim()
      || typeof sample?.draft !== 'string' || !sample.draft.trim()
      || typeof sample?.stored !== 'string' || !sample.stored.trim()) return false
  const computed = allowedMode1Capture(sample)
  const recorded = sample?.qualityAudit
  return computed.trainingEligible
    && computed.qualityAudit.status === 'clean'
    && recorded?.schema === MODE1_QUALITY_SCHEMA
    && recorded?.status === 'clean'
    && recorded?.textSha256 === computed.qualityAudit.textSha256
    && JSON.stringify(recorded?.checkedFields) === JSON.stringify(computed.qualityAudit.checkedFields)
    && Array.isArray(recorded?.issues)
    && recorded.issues.length === 0
}
