#!/usr/bin/env node
// Deterministic, reversible quarantine for historical flywheel pair targets.
// Default: preview only. --apply archives non-clean/non-dev rows and annotates exact clean targets.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { auditMode1Pair } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const activePath = path.join(ROOT, 'transfer/models/dev-flywheel-pairs.json')
const archivePath = path.join(ROOT, 'transfer/models/rejected/dev-flywheel-pairs-mode1-apparatus.json')
const APPLY = process.argv.includes('--apply')
const DEV_FAMILIES = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const familyOf = (row) => String(row?.task || row?.taskId || row?.family || '')
  .replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')

if (!fs.existsSync(activePath)) throw new Error(`flywheel registry missing: ${activePath}`)
const sourceBytes = fs.readFileSync(activePath)
const doc = JSON.parse(sourceBytes.toString('utf8'))
const rows = Array.isArray(doc) ? doc : (doc.pairs || [])
const active = []
const rejected = []
for (const row of rows) {
  const contentAudit = auditMode1Pair(row, { reviewer: 'mode1-flywheel-lint/1' })
  const family = familyOf(row)
  const reasons = []
  if (!DEV_FAMILIES.has(family) || row.split !== 'dev') reasons.push('not-allowlisted-dev-family-or-explicit-dev-split')
  if (contentAudit.issues.some((issue) => issue.category === 'incomplete-target-text')) reasons.push('incomplete-target-text')
  for (const issue of contentAudit.issues) if (!reasons.includes(issue.category)) reasons.push(issue.category)
  if (reasons.length) rejected.push({ ...row, contentAudit, quarantineReason: reasons })
  else active.push({ ...row, contentAudit })
}
const directBanRows = rejected.filter((row) => row.contentAudit.issues.some((issue) => issue.category === 'executor-tool-or-check-prohibition')).length
const manualReviewSummary = {
  schema: 'cfb.mode1-manual-review/1',
  status: 'reviewed-active-rows-only',
  reviewer: 'agent-semantic-review/1',
  reviewedAt: '2026-10-04',
  reviewedUniqueTargetTexts: 26,
  reviewedSourcePairRows: rows.length,
  checkedClasses: ['environment-permission-assertion', 'experiment-round-or-budget-control', 'executor-tool-or-check-prohibition', 'task-scoped-exclusions'],
  findings: {
    environmentClaims: 'none found in the 38 tracked legacy pairs',
    experimentRoundBudgetControls: 'none; 第1轮/上一轮 references are task-history and validation context, not Mode 1 run-budget controls',
    directExecutorToolBans: `${directBanRows} pair rows quarantined; the repeated hard ban on post-edit read_file/sed verification is not task-valid`,
    taskScopedAdvice: 'conditional debugging branches and exclusions retained only where tied to concrete task evidence and accompanied by task-specific validation',
  },
  limitation: 'This review clears only the identified apparatus-contamination classes; it does not certify semantic correctness, score quality, blind review, or training performance.',
}
for (const row of active) row.manualReview = {
  schema: 'cfb.mode1-manual-review/1',
  status: 'clear-of-apparatus',
  reviewer: manualReviewSummary.reviewer,
  reviewedAt: manualReviewSummary.reviewedAt,
  pairTextSha256: row.contentAudit.textSha256,
  method: 'full-text contextual review of unique legacy targets; see document-level manualReview summary',
}
const byTask = {}
for (const row of active) byTask[row.task || row.family] = (byTask[row.task || row.family] || 0) + 1
const distinctScorePairs = new Set(active.map((row) => `${row.chosenScore}|${row.rejectedScore}`))
const audit = {
  schema: 'cfb.mode1-flywheel-quarantine/1',
  sourceFile: path.relative(ROOT, activePath),
  sourceSha256: sha256(sourceBytes),
  activeCount: active.length,
  quarantinedCount: rejected.length,
  quarantined: rejected.map((row) => ({ task: row.task || row.family, source: row.source || null, reason: row.quarantineReason, contentAudit: row.contentAudit })),
}
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'preview', ...audit }, null, 2))
if (!APPLY) process.exit(0)
if (fs.existsSync(archivePath)) throw new Error(`refusing to overwrite existing archive: ${path.relative(ROOT, archivePath)}`)

fs.mkdirSync(path.dirname(archivePath), { recursive: true })
fs.writeFileSync(archivePath, JSON.stringify({ ...doc, schema: 'cfb.quarantined-flywheel-pairs/1', audit, manualReview: manualReviewSummary, pairs: rejected }, null, 2) + '\n')
const activeDoc = {
  ...doc,
  schema: Array.isArray(doc) ? 'cfb.dev-flywheel-pairs/2' : doc.schema,
  note: '仅保留当前 dev 家族且 chosen/rejected 两端通过内容审计的目标；历史被隔离行见 transfer/models/rejected/dev-flywheel-pairs-mode1-apparatus.json。训练器会对两端复核静态质量并要求字节绑定的 contentAudit；清洁不等于确认性证据。',
  pairCount: active.length,
  distinctScorePairs: distinctScorePairs.size,
  byTask,
  dropped: { ...(doc.dropped || {}), mode1ApparatusOrIncompleteRows: rejected.length },
  contentAudit: {
    schema: 'cfb.mode1-content-audit/1',
    reviewer: 'mode1-flywheel-lint/1',
    status: 'clean-active-rows-only',
    sourceSha256: sha256(sourceBytes),
    activeRows: active.length,
    quarantinedRows: rejected.length,
    archiveFile: path.relative(ROOT, archivePath),
  },
  manualReview: manualReviewSummary,
  pairs: active,
}
fs.writeFileSync(activePath, JSON.stringify(activeDoc, null, 2) + '\n')
console.log(`[quarantine-mode1-flywheel] active=${active.length}; quarantined=${rejected.length}; archive=${path.relative(ROOT, archivePath)}`)
