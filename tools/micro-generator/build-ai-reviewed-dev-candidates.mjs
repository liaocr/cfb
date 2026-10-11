#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inputSha256, readJsonl, sha256, stableCaseId, validateAnnotation,
  validateFamilyIsolation, writeJsonl,
} from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const QUEUE_FILE = path.join(ROOT, 'transfer/models/micro-generator-review-queue.jsonl')
const DISPOSITIONS_FILE = path.join(ROOT, 'transfer/models/micro-generator-ai-review-dispositions.jsonl')
const CANDIDATES_FILE = path.join(ROOT, 'transfer/models/micro-generator-ai-reviewed-dev-candidates.jsonl')
const MANIFEST_FILE = path.join(ROOT, 'transfer/models/micro-generator-ai-reviewed-dev-candidates.manifest.json')
const SPLITS_FILE = path.join(ROOT, 'tools/micro-generator/family-splits.template.json')
const REVIEWED_AT = '2026-10-07'
const REVIEWER_ID = 'arena-agent-mode'
const REVIEW_PROVENANCE = {
  mode: 'ai-single-reviewer',
  reviewerType: 'ai',
  reviewerId: REVIEWER_ID,
  reviewerCount: 1,
  humanReviewerCount: 0,
  independentSecondReview: false,
  reviewedAt: REVIEWED_AT,
  scope: 'raw-context-facts-and-reference-claims',
  limitations: [
    'The rewritten targets were authored and reviewed in the same Arena.ai Agent Mode session; no independent human review is claimed.',
    'Only the salient facts cited by each candidate draft are annotated here; sourceCoverage remains partial and these rows are not training-eligible.',
    'All three families are previously used development families and remain dev-only.',
    'No scenario source code was edited and no real scenario CI, replay, model inference, or training was run.',
  ],
}

const CASE_REVIEW = {
  'flaky-timeout-27ad98621b224ab9': {
    disposition: 'rewrite-required',
    rationale: 'Original target elevates a 100 ms scheduling hypothesis to a source-level conclusion and proposes an unverified fix/acceptance path.',
  },
  'flaky-timeout-445555c31e8f51b1': {
    disposition: 'rewrite-required',
    rationale: 'Original target calls the mechanism confirmed while the transcript still leaves alternatives and test evidence unresolved.',
  },
  'flaky-timeout-516ae841af7e4451': {
    disposition: 'reject-original',
    rationale: 'Original target claims a helpers-only edit and verify result without an edit receipt or post-change test result.',
  },
  'flaky-timeout-618b42a02b6aa205': {
    disposition: 'reject-original',
    rationale: 'Original target repeats the helpers-only change and unverified acceptance claim.',
  },
  'flaky-timeout-abc7c84a60543747': {
    disposition: 'reject-original',
    rationale: 'Full 29,903-character raw has no edit receipt or post-change test result; proposed helpers change is not an executed fix.',
  },
  'flaky-timeout-b79f3481defb4912': {
    disposition: 'reject-original',
    rationale: 'Original target promotes a helpers change and `node verify.mjs` result that are not evidenced as completed actions.',
  },
  'flaky-timeout-f008aed867a41545': {
    disposition: 'reject-original',
    rationale: 'Original target turns a timing hypothesis into a settled cause and an unverified test change.',
  },
  'perf-regression-1b5bf68718d1be80': {
    disposition: 'rewrite-conflicting-original',
    conflictGroup: 'perf-regression-identical-input-two-targets',
    rationale: 'Same raw+ctx as the next row but a different draft; neither original target is selected. Rollback and causal claims lack a post-change trace.',
  },
  'perf-regression-b658aaee22057ecf': {
    disposition: 'rewrite-conflicting-original',
    conflictGroup: 'perf-regression-identical-input-two-targets',
    rationale: 'Same raw+ctx as the prior row but a different draft; neither original target is selected. Rollback and causal claims lack a post-change trace.',
  },
  'perf-regression-bf171c05465d1bab': {
    disposition: 'reject-original',
    rationale: 'Original target presents a causal chain as established and proposes configuration verification without a config edit or new trace.',
  },
  'perf-regression-c5a46f633a734bab': {
    disposition: 'rewrite-required',
    rationale: 'Rollback is proposed but the same target acknowledges that post-change trace validation is pending.',
  },
  'sse-truncated-2c6c7d60c10b5d86': {
    disposition: 'reject-original',
    rationale: 'Original target limits the fix to a test file despite the production transport/settle path being unresolved.',
  },
  'sse-truncated-36a50e856e426f8e': {
    disposition: 'reject-original',
    rationale: 'Original target claims a production fix is ready but has no edit receipt or replay-after-change evidence.',
  },
  'sse-truncated-8b948358cca4b9e7': {
    disposition: 'reject-original',
    rationale: 'Original target misplaces the fix in a test-only file and has no post-change replay.',
  },
  'sse-truncated-95fd0d6633ab9b19': {
    disposition: 'reject-original',
    rationale: 'Original target leaves a nonempty-output success fallback and proposes test-only verification; no production change is shown.',
  },
  'sse-truncated-9cf468008d803a3a': {
    disposition: 'rewrite-required',
    rationale: 'The proposed settle rule is more complete but remains a proposed change without production edit or replay validation.',
  },
  'sse-truncated-ab9f32022400104e': {
    disposition: 'reject-original',
    rationale: 'Original target claims two edit_file calls in this turn; the complete raw contains analysis/proposals and an older replay, not those edit receipts or a new replay.',
  },
}

const DRAFTS = {
  'flaky-timeout': 'CI 报告指出，test/hedge.selftest.mjs 约五次失败一次；2 核 CI 上间歇失败，而 16 核本地未复现。讨论中的计时参数为 primary 约 1500 ms、hedge deadline 1600 ms，100 ms 间隔值得作为时序假设验证；下一步应在 2 核条件下记录 primary settle 与 hedge start，再决定调整测试裕量还是源码逻辑。',
  'perf-regression': '记录报告 v11.9→v11.10 后 birth 收网平均等待由 900 ms 升至 2400 ms。讨论把 compressTargetMax 从 450 放宽至 1800 与更长生成视为可能原因；应先用匹配版本和 birth 步骤的 analyze-trace 样本复核，再考虑回滚，而不把候选方案写成已验证修复。',
  'sse-truncated': '记录报告截断的 SSE 压缩结果曾以 ok:true 写入会话。验收要求仅有 [DONE] 或没有结束信号时 settled ok:false 并 passthrough；带真实 finish_reason=length 的完整流仍应 condensed。讨论中的代码假设是 [DONE] 被合成为 stop、非空 out 也可能触发 ok；应先用 replay 覆盖这两类边界，再声称修复。',
}

function exactSpan(record, field, quote, label) {
  const text = record[field]
  const start = text.indexOf(quote)
  if (start < 0) throw new Error(`${record.caseId}: cannot locate ${label} span in ${field}: ${quote}`)
  return { field, start, end: start + quote.length, quote }
}

function spanWithBoth(text, left, right, maxDistance = 600) {
  let best = null
  let at = text.indexOf(left)
  while (at >= 0) {
    const after = text.indexOf(right, at + left.length)
    if (after >= 0 && after - at <= maxDistance) {
      const start = Math.max(0, at - 42)
      const end = Math.min(text.length, after + right.length + 42)
      const candidate = text.slice(start, end)
      if (!best || candidate.length < best.length) best = candidate
    }
    at = text.indexOf(left, at + 1)
  }
  if (!best) throw new Error(`unable to find nearby ${left} / ${right} in source`)
  return best
}

function regexSpan(text, regex, label, before = 70, after = 100) {
  const match = regex.exec(text)
  if (!match) throw new Error(`unable to find ${label}`)
  const start = Math.max(0, match.index - before)
  const end = Math.min(text.length, match.index + match[0].length + after)
  return text.slice(start, end)
}

function fact(record, n, proposition, span, { importance = 'high', polarity = 'positive', modality = 'reported', entities = [], tags = [], mustPreserve = true } = {}) {
  return {
    factId: `${record.caseId}-f${n}`,
    proposition,
    sourceSpan: span,
    importance,
    polarity,
    modality,
    conditions: [],
    entities,
    mustPreserve,
    ...(tags.length ? { tags } : {}),
  }
}

function makeFacts(record) {
  if (record.family === 'flaky-timeout') {
    const reportQuote = 'CI 里 test/hedge.selftest.mjs 大约每 5 次失败 1 次，本地从不失败。CI 机器 2 核，本地 16 核。'
    const timingQuote = spanWithBoth(record.raw, '1500', '1600')
    const requestQuote = '请找出原因并修好，修好后说明依据。'
    return [
      fact(record, 1, '任务上下文报告 CI 中 test/hedge.selftest.mjs 约每五次失败一次，2 核 CI 与 16 核本地表现不同。', exactSpan(record, 'ctx', reportQuote, 'flaky report'), { importance: 'high', modality: 'reported', entities: ['test/hedge.selftest.mjs', 'CI'], tags: ['number', 'identifier'] }),
      fact(record, 2, '对话比较约 1500 ms 的 primary 响应与 1600 ms 的 hedge deadline。', exactSpan(record, 'raw', timingQuote, 'flaky timing'), { importance: 'high', modality: 'reported', entities: ['primary', 'hedge deadline'], tags: ['number', 'time'] }),
      fact(record, 3, '任务要求根据证据定位并修复原因。', exactSpan(record, 'ctx', requestQuote, 'flaky task requirement'), { importance: 'critical', modality: 'required', entities: ['cause', 'fix', 'evidence'], tags: ['decision'] }),
    ]
  }
  if (record.family === 'perf-regression') {
    const waitQuote = '从 v11.9 升级到 v11.10 之后，birth 收网的平均等待从 900ms 涨到 2400ms。'
    const targetQuote = regexSpan(record.raw, /compressTargetMax[^\n]{0,140}(?:450|1800)|(?:450[^\n]{0,60}1800)[^\n]{0,80}compressTargetMax/i, 'perf target-change quote', 45, 70)
    const toolQuote = '可用 `analyze-trace`（支持 --compare v11.9 v11.10 --steps birth --fields …，以及 --last N）。'
    return [
      fact(record, 1, '任务上下文报告 v11.9 升至 v11.10 后 birth 平均收网等待由 900 ms 增至 2400 ms。', exactSpan(record, 'ctx', waitQuote, 'perf wait change'), { importance: 'high', modality: 'reported', entities: ['v11.9', 'v11.10', 'birth'], tags: ['number', 'time', 'identifier'] }),
      fact(record, 2, '分析稿提到 compressTargetMax 从 450 放宽到 1800，并把更长输出视为可能的耗时驱动因素。', exactSpan(record, 'raw', targetQuote, 'perf target change'), { importance: 'high', modality: 'possible', entities: ['compressTargetMax'], tags: ['number', 'causality', 'identifier'] }),
      fact(record, 3, '上下文提供 analyze-trace 的版本比较和 birth 步骤查询方式。', exactSpan(record, 'ctx', toolQuote, 'perf trace tool'), { importance: 'medium', modality: 'reported', entities: ['analyze-trace'], tags: ['identifier'] }),
    ]
  }
  if (record.family === 'sse-truncated') {
    const issueQuote = '线上偶发：压缩结果被截断却被当成成功写进了会话。'
    const acceptanceQuote = record.ctx.slice(record.ctx.indexOf('验收：'), record.ctx.indexOf('\n', record.ctx.indexOf('验收：')))
    const synthQuote = regexSpan(record.raw, /done\s*\?\s*'stop'\s*:\s*null/, 'SSE finish fallback', 45, 55)
    const nonemptyQuote = regexSpan(record.raw, /out\.length\s*>\s*0/, 'SSE nonempty fallback', 55, 55)
    return [
      fact(record, 1, '上下文报告截断的 SSE 压缩结果曾被当成成功写入会话。', exactSpan(record, 'ctx', issueQuote, 'SSE issue report'), { importance: 'critical', modality: 'reported', entities: ['SSE', 'session'], tags: ['identifier'] }),
      fact(record, 2, '验收要求截断流必须失败并 passthrough，而带真实 finish_reason=length 的完整流仍应 condensed。', exactSpan(record, 'ctx', acceptanceQuote, 'SSE acceptance'), { importance: 'critical', modality: 'required', entities: ['[DONE]', 'finish_reason', 'passthrough', 'condensed'], tags: ['condition', 'identifier'] }),
      fact(record, 3, '对话引用了把 done 映射成 stop 的 finish fallback 作为待核验机制。', exactSpan(record, 'raw', synthQuote, 'SSE finish fallback'), { importance: 'high', modality: 'possible', entities: ['[DONE]', 'stop'], tags: ['causality', 'identifier'] }),
      fact(record, 4, '对话还引用了非空输出可让 settle 判为成功的 fallback。', exactSpan(record, 'raw', nonemptyQuote, 'SSE nonempty fallback'), { importance: 'high', modality: 'possible', entities: ['settle', 'out'], tags: ['causality', 'identifier'] }),
    ]
  }
  throw new Error(`unsupported family ${record.family}`)
}

function makeCandidate(sourceRows, sourceCaseIds) {
  const source = sourceRows[0]
  const referenceDraft = DRAFTS[source.family]
  const caseId = stableCaseId({ family: source.family, raw: source.raw, ctx: source.ctx, draft: referenceDraft })
  const facts = makeFacts({ ...source, caseId })
  const sourceIds = [...new Set(sourceRows.map((row) => row.caseId))].sort()
  const referenceReview = {
    status: 'adjudicated',
    factStatuses: facts.map((row) => ({ factId: row.factId, status: 'preserved' })),
    allMustPreserveFactsSatisfied: true,
    unsupportedClaimsReviewed: true,
    unsupportedClaimsCount: 0,
  }
  const candidate = {
    schema: 'cfb.micro-generator-annotation/1',
    caseId,
    family: source.family,
    finalSplit: 'dev',
    provenanceSplit: 'existing-dev',
    sourceId: sourceIds.join('|'),
    source: 'transfer/models/micro-generator-review-queue.jsonl; raw+ctx retained from original candidate(s)',
    sourceKind: 'ai-reviewed-curated',
    sourceAudit: 'docs/MICRO-GENERATOR-AI-FIRST-REVIEW-2026-10-07.md; docs/MICRO-GENERATOR-FAMILY-INVENTORY-2026-10-07.md',
    referenceStatus: 'ai-reviewed-rewrite-candidate-dev-only',
    raw: source.raw,
    ctx: source.ctx,
    referenceDraft,
    sourceCoverage: 'partial',
    annotationStatus: 'reviewed',
    reviewers: [REVIEWER_ID],
    facts,
    referenceReview,
    reviewProvenance: structuredClone(REVIEW_PROVENANCE),
    sourceHashes: {
      rawSha256: sha256(source.raw),
      ctxSha256: sha256(source.ctx),
      referenceSha256: sha256(referenceDraft),
    },
    trainingEligible: false,
    reviewOnlyReason: 'AI-authored and AI-reviewed dev rewrite proposal. Claim support is reviewed for the listed facts, but overall source coverage remains partial; not eligible for train export or confirmatory evaluation.',
  }
  const errors = validateAnnotation(candidate)
  if (errors.length) throw new Error(`candidate ${caseId} invalid: ${errors.join('; ')}`)
  return { candidate, sourceCaseIds, sourceRows }
}

function build() {
  const rows = readJsonl(QUEUE_FILE)
  const splitTemplate = JSON.parse(fs.readFileSync(SPLITS_FILE, 'utf8'))
  const splitAssignments = new Map((splitTemplate.currentlyKnownFamilies || []).map((row) => [row.family, row]))
  const byCase = new Map(rows.map((row) => [row.caseId, row]))
  const seen = new Set()
  const grouped = new Map()
  for (const row of rows) {
    const hash = inputSha256({ raw: row.raw, ctx: row.ctx })
    const group = grouped.get(hash) || []
    group.push(row)
    grouped.set(hash, group)
  }
  const candidates = []
  const dispositionRows = []
  for (const [inputHash, sourceRows] of grouped.entries()) {
    const family = sourceRows[0].family
    if (sourceRows.some((row) => row.family !== family || row.raw !== sourceRows[0].raw || row.ctx !== sourceRows[0].ctx)) throw new Error(`input hash collision or cross-family duplicate ${inputHash}`)
    const sourceIds = sourceRows.map((row) => row.caseId)
    for (const id of sourceIds) {
      if (seen.has(id)) throw new Error(`duplicate source case id ${id}`)
      seen.add(id)
      if (!CASE_REVIEW[id]) throw new Error(`missing AI disposition for ${id}`)
    }
    const { candidate } = makeCandidate(sourceRows, sourceIds)
    candidates.push(candidate)
    for (const sourceId of sourceIds) {
      const source = byCase.get(sourceId)
      const item = CASE_REVIEW[sourceId]
      dispositionRows.push({
        schema: 'cfb.micro-generator-review-disposition/1',
        originalCaseId: sourceId,
        family: source.family,
        originalInputSha256: inputHash,
        originalReferenceSha256: source.sourceHashes.referenceSha256,
        disposition: item.disposition,
        ...(item.conflictGroup ? { conflictGroup: item.conflictGroup } : {}),
        rationale: item.rationale,
        proposedCanonicalCaseId: candidate.caseId,
        proposedReferenceSha256: candidate.sourceHashes.referenceSha256,
        reviewerPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: REVIEWER_ID, reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
        reviewedAt: REVIEWED_AT,
        trainingEligible: false,
        splitDisposition: 'existing-development-family; dev-only candidate; no train or blind reassignment',
        sourceAudit: 'docs/MICRO-GENERATOR-AI-FIRST-REVIEW-2026-10-07.md',
      })
    }
  }
  if (seen.size !== rows.length || Object.keys(CASE_REVIEW).length !== rows.length) throw new Error(`expected one disposition for each of ${rows.length} original cases; got ${seen.size}`)
  for (const candidate of candidates) {
    const assigned = splitAssignments.get(candidate.family)
    if (!assigned || assigned.observedAs !== candidate.provenanceSplit || assigned.finalSplit !== candidate.finalSplit) {
      throw new Error(`candidate split ${candidate.family}=${candidate.finalSplit} does not match family-splits template`)
    }
  }
  const isolationErrors = validateFamilyIsolation(candidates)
  if (isolationErrors.length) throw new Error(`candidate family isolation failed: ${isolationErrors.join('; ')}`)
  const allErrors = candidates.flatMap((row) => validateAnnotation(row))
  if (allErrors.length) throw new Error(`candidate validation failed: ${allErrors.join('; ')}`)
  const manifest = {
    schema: 'cfb.micro-generator-ai-reviewed-dev-candidate-manifest/1',
    createdAt: new Date().toISOString(),
    sourceQueueSha256: sha256(JSON.stringify(rows)),
    familySplitTemplateSha256: sha256(JSON.stringify(splitTemplate)),
    familySplitTemplateStatus: splitTemplate.status,
    reviewPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: REVIEWER_ID, reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
    counts: {
      originalQueueRows: rows.length,
      uniqueRawCtxPairs: candidates.length,
      originalTargetConflictGroups: [...grouped.values()].filter((group) => new Set(group.map((row) => row.sourceHashes.referenceSha256)).size > 1).length,
      canonicalRewriteCandidates: candidates.length,
      sourceFamilies: [...new Set(candidates.map((row) => row.family))].sort(),
      train: 0,
      devOnlyCandidates: candidates.length,
      blind: 0,
      fullSourceCoverageRows: candidates.filter((row) => row.sourceCoverage === 'complete').length,
      trainingEligibleRows: candidates.filter((row) => row.trainingEligible).length,
    },
    readiness: {
      trainingReady: false,
      confirmatoryEvaluationReady: false,
      blockers: [
        'these are rewrites of existing development families, not new training families',
        'sourceCoverage is partial; complete atomized raw-source coverage remains outstanding',
        'no new-family blind set has been registered for this summary task',
      ],
    },
    candidateSha256: sha256(JSON.stringify(candidates)),
    dispositionSha256: sha256(JSON.stringify(dispositionRows)),
  }
  return { rows, candidates, dispositionRows, manifest }
}

const { candidates, dispositionRows, manifest } = build()
writeJsonl(CANDIDATES_FILE, candidates)
writeJsonl(DISPOSITIONS_FILE, dispositionRows)
fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`[micro-generator-ai-review] sourceRows=${manifest.counts.originalQueueRows} uniqueInputs=${manifest.counts.uniqueRawCtxPairs} rewrites=${manifest.counts.canonicalRewriteCandidates} families=${manifest.counts.sourceFamilies.length} train=0 devOnly=${manifest.counts.devOnlyCandidates} trainingReady=false`)
