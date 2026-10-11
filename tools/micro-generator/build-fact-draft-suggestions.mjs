#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonl, sha256, validateAnnotation } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_QUEUE = 'transfer/models/micro-generator-review-queue.jsonl'
const DEFAULT_OUT = 'transfer/models/micro-generator-fact-draft-suggestions.jsonl'
const DEFAULT_MANIFEST = 'transfer/models/micro-generator-fact-draft-suggestions.manifest.json'

// These proposals intentionally cover only explicit task/context preamble statements.
// They are not exhaustive source annotations and must not be treated as reviewed gold.
const PROPOSALS = {
  'flaky-timeout': [
    { quote: 'CI 里 test/hedge.selftest.mjs 大约每 5 次失败 1 次，本地从不失败。', proposition: '用户报告 test/hedge.selftest.mjs 在 CI 中约每五次失败一次，而本地未复现。', importance: 'high', polarity: 'positive', modality: 'reported', entities: ['test/hedge.selftest.mjs', 'CI'], tags: ['number', 'identifier'] },
    { quote: 'CI 机器 2 核，本地 16 核。', proposition: '用户报告 CI 机器为 2 核，本地机器为 16 核。', importance: 'high', polarity: 'positive', modality: 'reported', entities: ['CI machine', 'local machine'], tags: ['number'] },
    { quote: '最近 5 次 CI 日志在 ci/last5.log。', proposition: '用户指出最近五次 CI 日志位于 ci/last5.log。', importance: 'medium', polarity: 'positive', modality: 'reported', entities: ['ci/last5.log'], tags: ['time', 'identifier'] },
    { quote: '请找出原因并修好，修好后说明依据。', proposition: '任务要求定位并修复原因，并说明证据依据。', importance: 'critical', polarity: 'positive', modality: 'required', entities: ['cause', 'fix', 'evidence'], tags: ['decision'] },
  ],
  'perf-regression': [
    { quote: '从 v11.9 升级到 v11.10 之后，birth 收网的平均等待从 900ms 涨到 2400ms。', proposition: '用户报告 v11.9 升至 v11.10 后，birth 收网平均等待由 900ms 增至 2400ms。', importance: 'high', polarity: 'positive', modality: 'reported', entities: ['v11.9', 'v11.10', 'birth'], tags: ['number', 'time', 'identifier'] },
    { quote: '可用 `analyze-trace`（支持 --compare v11.9 v11.10 --steps birth --fields …，以及 --last N）。', proposition: '用户指出可用 analyze-trace 比较两个版本的 birth 步骤，并限制最近 N 条记录。', importance: 'medium', polarity: 'positive', modality: 'reported', entities: ['analyze-trace'], tags: ['identifier'] },
    { quote: '请找出原因并修好，修好后说明依据。', proposition: '任务要求定位并修复原因，并说明证据依据。', importance: 'critical', polarity: 'positive', modality: 'required', entities: ['cause', 'fix', 'evidence'], tags: ['decision'] },
  ],
  'sse-truncated': [
    { quote: '线上偶发：压缩结果被截断却被当成成功写进了会话。', proposition: '用户报告线上偶发截断的压缩结果被当成成功并写入会话。', importance: 'high', polarity: 'positive', modality: 'reported', entities: ['compression result', 'session'], tags: ['causality'] },
    { quote: 'trace 片段在 trace/last.log，网关说明在 docs/gateway.md。', proposition: '用户指出 trace 片段和网关说明的位置分别为 trace/last.log 与 docs/gateway.md。', importance: 'medium', polarity: 'positive', modality: 'reported', entities: ['trace/last.log', 'docs/gateway.md'], tags: ['identifier'] },
    { quote: '`npm test` 目前是绿的（测试没覆盖这个情况）。', proposition: '用户报告 npm test 当前通过，但测试未覆盖该截断情形。', importance: 'high', polarity: 'mixed', modality: 'reported', entities: ['npm test'], tags: ['exception'] },
    { quote: '可用 `node scripts/replay-truncated.mjs` 复现（回放一条被切断的流，打印 trace）。', proposition: '用户指出可用 node scripts/replay-truncated.mjs 回放截断流并打印 trace。', importance: 'high', polarity: 'positive', modality: 'reported', entities: ['scripts/replay-truncated.mjs'], tags: ['identifier'] },
    { quote: '验收：被切断的流（只补 [DONE]、或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。', proposition: '验收要求：仅有 [DONE] 或完全无结束信号的截断流须 settled ok:false 并让 birth passthrough；完整且带 finish_reason=length 的流仍须 condensed。', importance: 'critical', polarity: 'positive', modality: 'required', entities: ['[DONE]', 'finish_reason=length', 'birth'], tags: ['condition', 'exception', 'decision', 'identifier'] },
  ],
}

function buildFactDraftSuggestions(rows) {
  const suggestions = []
  for (const row of rows) {
    const templates = PROPOSALS[row.family]
    if (!templates) throw new Error(`no context proposal template for family ${row.family}`)
    const facts = templates.map((candidate, index) => {
      const start = row.ctx.indexOf(candidate.quote)
      if (start < 0) throw new Error(`${row.caseId}: expected context quote not found: ${candidate.quote}`)
      return {
        factId: `${row.caseId}-proposal-${String(index + 1).padStart(2, '0')}`,
        proposition: candidate.proposition,
        sourceSpan: { field: 'ctx', start, end: start + candidate.quote.length, quote: candidate.quote },
        importance: candidate.importance,
        polarity: candidate.polarity,
        modality: candidate.modality,
        conditions: [],
        entities: candidate.entities,
        mustPreserve: true,
        tags: candidate.tags,
      }
    })
    const proposal = {
      ...row,
      sourceCoverage: 'partial',
      annotationStatus: 'draft',
      reviewers: [],
      facts,
      referenceReview: { status: 'pending', factStatuses: [], allMustPreserveFactsSatisfied: null,
        unsupportedClaimsReviewed: false, unsupportedClaimsCount: null },
      trainingEligible: false,
      reviewOnlyReason: 'Assistant-proposed context-preamble facts only; the full raw/context has not been exhaustively reviewed; never training-eligible without the complete AI single-reviewer review required by policy.',
      draftingProvenance: { method: 'assistant-context-preamble-proposal/1', scope: 'ctx-preamble-snippets-only', aiSingleReviewerReviewRequired: true },
    }
    const errors = validateAnnotation(proposal)
    if (errors.length) throw new Error(`${row.caseId}: invalid draft proposal: ${errors.join('; ')}`)
    suggestions.push(proposal)
  }
  return suggestions
}

export { buildFactDraftSuggestions }

function parseArgs(argv) {
  const out = { queue: DEFAULT_QUEUE, output: DEFAULT_OUT, manifest: DEFAULT_MANIFEST, write: false, check: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--queue') out.queue = argv[++i]
    else if (argv[i] === '--out') out.output = argv[++i]
    else if (argv[i] === '--manifest') out.manifest = argv[++i]
    else if (argv[i] === '--write') out.write = true
    else if (argv[i] === '--check') out.check = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (out.write && out.check) throw new Error('--write and --check are mutually exclusive')
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const queuePath = path.resolve(ROOT, args.queue)
    const outputPath = path.resolve(ROOT, args.output)
    const manifestPath = path.resolve(ROOT, args.manifest)
    const queueText = fs.readFileSync(queuePath, 'utf8')
    const proposals = buildFactDraftSuggestions(readJsonl(queuePath))
    const proposalText = proposals.map((row) => JSON.stringify(row)).join('\n') + (proposals.length ? '\n' : '')
    const manifest = {
      schema: 'cfb.micro-generator-fact-review-starter-manifest/1',
      sourceQueueSha256: sha256(queueText),
      suggestionsSha256: sha256(proposalText),
      reviewPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
      counts: { cases: proposals.length, candidateFacts: proposals.reduce((n, row) => n + row.facts.length, 0), families: [...new Set(proposals.map((row) => row.family))].length, aiSingleReviewerApprovedCases: 0, trainingEligibleCases: 0 },
      status: 'draft-context-only-not-gold',
      limitations: ['only exact task/context preamble snippets were proposed', 'raw histories were not exhaustively fact-reviewed', 'importance and mustPreserve are provisional suggestions', 'reference claims and duplicate-target choice remain unadjudicated'],
      trainingReady: false,
    }
    const manifestText = JSON.stringify(manifest, null, 2) + '\n'
    if (args.check) {
      const outputOk = fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8') === proposalText
      const manifestOk = fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, 'utf8') === manifestText
      console.log(JSON.stringify({ outputOk, manifestOk, cases: proposals.length, candidateFacts: manifest.counts.candidateFacts, trainingReady: false }))
      if (!outputOk || !manifestOk) process.exitCode = 1
    } else if (args.write) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
      fs.writeFileSync(outputPath, proposalText, 'utf8')
      fs.writeFileSync(manifestPath, manifestText, 'utf8')
      console.log(`[micro-generator-fact-starter] wrote ${proposals.length} draft-only cases / ${manifest.counts.candidateFacts} context fact proposals; trainingReady=false`)
    } else console.log(manifestText)
  } catch (error) {
    console.error(`[micro-generator-fact-starter] ${error.message}`)
    process.exitCode = 1
  }
}
