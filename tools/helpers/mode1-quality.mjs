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

/**
 * Detect only the three experiment-apparatus leak classes identified in the gold audit.
 * The source transcript (raw/context) is deliberately not scanned: only produced targets
 * (draft/stored) can become training labels or be presented as the reusable gold standard.
 */
export function auditMode1Output(text) {
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
  return { status: issues.length ? 'quarantined' : 'clean', issues }
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

export function auditMode1Gold(item, { reviewer = 'deterministic-mode1-audit/1', reviewedAt = null } = {}) {
  const draftAudit = auditMode1Output(item?.draft ?? item?.gold ?? item?.hand ?? '')
  const storedAudit = item?.stored == null ? { status: 'not-present', issues: [] } : auditMode1Output(item.stored)
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
  const draftAudit = auditMode1Output(sample?.draft ?? '')
  const storedAudit = sample?.stored == null ? { status: 'not-present', issues: [] } : auditMode1Output(sample.stored)
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
