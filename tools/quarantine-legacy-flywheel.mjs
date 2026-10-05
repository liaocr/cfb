#!/usr/bin/env node
// Fail-closed local migration for the ignored historical .cfb-offline flywheel.
// Default: preview only. --apply archives the entire unreviewed legacy JSONL and seeds
// the active local flywheel only from the manually reviewed tracked dev registry.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { auditMode1Pair, isMode1PairEligible } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawPath = path.join(ROOT, '.cfb-offline/train/pairs.jsonl')
const registryPath = path.join(ROOT, 'transfer/models/dev-flywheel-pairs.json')
const APPLY = process.argv.includes('--apply')
const DEV_FAMILIES = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const familyOf = (row) => String(row?.task || row?.taskId || row?.family || '')
  .replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')

if (!fs.existsSync(rawPath)) throw new Error(`legacy local flywheel missing: ${rawPath}`)
if (!fs.existsSync(registryPath)) throw new Error(`reviewed tracked registry missing: ${registryPath}`)
const sourceBytes = fs.readFileSync(rawPath)
const sourceText = sourceBytes.toString('utf8')
const rows = sourceText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
const reviewedRows = (registry.pairs || []).filter((row) => familyAllowed(row)
  && isMode1PairEligible(row, { requireRecorded: true, requireManualReview: true }))
function familyAllowed(row) { return DEV_FAMILIES.has(familyOf(row)) && row.split === 'dev' }
if (!reviewedRows.length) throw new Error('no reviewed dev rows in tracked registry; refuse to replace active local flywheel')

const flaggedRows = []
const byFamily = {}
for (const [lineIndex, row] of rows.entries()) {
  const family = familyOf(row)
  const audit = auditMode1Pair(row)
  byFamily[family] ||= { total: 0, holdout: 0, dev: 0, staticFlagged: 0, withRecordedAudit: 0, withManualReview: 0 }
  const stats = byFamily[family]
  stats.total++
  if (row.split === 'holdout') stats.holdout++
  else stats.dev++
  if (row.contentAudit) stats.withRecordedAudit++
  if (row.manualReview) stats.withManualReview++
  if (audit.status !== 'clean') {
    stats.staticFlagged++
    flaggedRows.push({ lineIndex, task: row.task || row.family || null, split: row.split || null, source: row.source || null, issues: audit.issues })
  }
}
const digest = sha256(sourceBytes)
const archiveDir = path.join(ROOT, '.cfb-offline/train/quarantine')
const archivePath = path.join(archiveDir, `pairs-legacy-unreviewed-${digest.slice(0, 16)}.jsonl`)
const auditPath = path.join(archiveDir, `pairs-legacy-unreviewed-${digest.slice(0, 16)}.audit.json`)
const auditDoc = {
  schema: 'cfb.legacy-flywheel-quarantine/1',
  sourceFile: path.relative(ROOT, rawPath),
  sourceSha256: digest,
  totalRows: rows.length,
  staticFlaggedRows: flaggedRows.length,
  unannotatedLegacyRows: rows.filter((row) => !row.contentAudit).length,
  manuallyReviewedRows: rows.filter((row) => row.manualReview?.status === 'clear-of-apparatus').length,
  byFamily,
  flaggedRows,
  activeReplacementRows: reviewedRows.length,
  activeReplacementSource: path.relative(ROOT, registryPath),
  decision: 'Archive all original rows because the local JSONL is legacy and has no byte-bound quality or manual-review annotations. This is a fail-closed provenance decision; unflagged rows are not thereby labeled contaminated. Re-seed the active local JSONL only from the tracked dev pairs that passed static audit and explicit contextual apparatus review.',
  limitations: ['No semantic correctness or score-quality claim is made.', 'Holdout and unknown families are not copied into the active dev flywheel.'],
}
console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'preview',
  rawRows: rows.length,
  staticFlaggedRows: flaggedRows.length,
  unannotatedLegacyRows: auditDoc.unannotatedLegacyRows,
  activeReplacementRows: reviewedRows.length,
  archiveFile: path.relative(ROOT, archivePath),
  auditFile: path.relative(ROOT, auditPath),
  byFamily,
  flaggedExamples: flaggedRows.slice(0, 8),
}, null, 2))
if (!APPLY) process.exit(0)
if (fs.existsSync(archivePath) || fs.existsSync(auditPath)) throw new Error('refusing to overwrite existing legacy flywheel archive/audit')
fs.mkdirSync(archiveDir, { recursive: true })
fs.writeFileSync(archivePath, sourceBytes)
fs.writeFileSync(auditPath, JSON.stringify(auditDoc, null, 2) + '\n')
fs.writeFileSync(rawPath, reviewedRows.map((row) => JSON.stringify(row)).join('\n') + '\n')
console.log(`[quarantine-legacy-flywheel] archived=${rows.length}; active=${reviewedRows.length}; flagged=${flaggedRows.length}`)
