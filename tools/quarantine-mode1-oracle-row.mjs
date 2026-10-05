#!/usr/bin/env node
// Default: preview. --apply archives flagged rows from the active, hand-curated Mode 1 oracle map.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { auditMode1Output } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(ROOT, 'transfer/oracle/M.json')
const archivePath = path.join(ROOT, 'transfer/oracle/rejected/M-mode1-apparatus.json')
const APPLY = process.argv.includes('--apply')
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
if (!fs.existsSync(sourcePath)) throw new Error(`oracle map missing: ${sourcePath}`)
const sourceBytes = fs.readFileSync(sourcePath)
const doc = JSON.parse(sourceBytes.toString('utf8'))
const rows = Array.isArray(doc.rows) ? doc.rows : []
const active = []
const rejected = []
for (const row of rows) {
  const qualityAudit = auditMode1Output(row?.text ?? '')
  if (qualityAudit.status !== 'clean') rejected.push({ ...row, qualityAudit, quarantineReason: 'executor-tool-or-check-prohibition' })
  else active.push(row)
}
const audit = {
  schema: 'cfb.mode1-oracle-quarantine/1',
  sourceFile: path.relative(ROOT, sourcePath),
  sourceSha256: sha256(sourceBytes),
  originalRows: rows.length,
  activeRows: active.length,
  quarantinedRows: rejected.length,
  quarantined: rejected.map((row) => ({ id: row.id || null, issues: row.qualityAudit.issues })),
  limitation: 'Deterministic target-content audit only; this is not semantic validation or a blind-review claim.',
}
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'preview', ...audit }, null, 2))
if (!APPLY) process.exit(0)
if (fs.existsSync(archivePath)) throw new Error(`refusing to overwrite existing oracle archive: ${path.relative(ROOT, archivePath)}`)
fs.mkdirSync(path.dirname(archivePath), { recursive: true })
fs.writeFileSync(archivePath, JSON.stringify({ schema: 'cfb.quarantined-oracle-rows/1', audit, rows: rejected }, null, 2) + '\n')
fs.writeFileSync(sourcePath, JSON.stringify({
  ...doc,
  contentAudit: {
    schema: 'cfb.mode1-content-audit/1',
    status: 'clean-active-rows-only',
    sourceSha256: sha256(sourceBytes),
    activeRows: active.length,
    quarantinedRows: rejected.length,
    archiveFile: path.relative(ROOT, archivePath),
  },
  rows: active,
}, null, 2) + '\n')
console.log(`[quarantine-mode1-oracle-row] active=${active.length}; quarantined=${rejected.length}; archive=${path.relative(ROOT, archivePath)}`)
