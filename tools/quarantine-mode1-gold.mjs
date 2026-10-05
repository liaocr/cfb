#!/usr/bin/env node
// One-off, auditable Mode 1 gold quarantine. Default is a read-only preview; --apply performs moves.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { auditMode1Gold } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE = path.join(ROOT, 'transfer', 'gold')
const REJECTED = path.join(ROOT, 'transfer', 'gold-rejected')
// User's manual audit explicitly approved only the shorthand “sse_long”; this repository item
// is the unique SSE long-horizon entry. Never infer additional approvals from lexical cleanliness.
const APPROVED = new Map([
  ['sse-truncated_long-horizon-s0-r5', { family: 'sse-truncated', task: 'sse-truncated:long-horizon', shorthand: 'sse_long' }],
])
const apply = process.argv.includes('--apply')
const now = new Date().toISOString()
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const report = {
  schema: 'cfb.mode1-gold-quarantine/1',
  at: now,
  source: 'user-directed manual audit: only sse_long is clean; static apparatus-language checks cover draft/stored targets only',
  activeRegistry: path.relative(ROOT, ACTIVE),
  archive: path.relative(ROOT, REJECTED),
  approvedActiveIds: [...APPROVED.keys()],
  actions: [],
}

for (const family of fs.readdirSync(ACTIVE).sort()) {
  const familyDir = path.join(ACTIVE, family)
  if (!fs.statSync(familyDir).isDirectory()) continue
  for (const name of fs.readdirSync(familyDir).filter((n) => n.endsWith('.json')).sort()) {
    const source = path.join(familyDir, name)
    const raw = fs.readFileSync(source)
    const gold = JSON.parse(raw.toString('utf8'))
    const lint = auditMode1Gold(gold, { reviewer: 'user-directed-manual-audit+mode1-quality-lint/1', reviewedAt: now })
    const approval = APPROVED.get(gold.id)
    if (approval) {
      if (family !== approval.family || gold.family !== approval.family || gold.task !== approval.task || lint.status !== 'clean') {
        throw new Error(`approved-item-mismatch-or-lint-failure:${gold.id}`)
      }
      report.actions.push({
        id: gold.id,
        action: 'retain-active',
        originalFile: path.relative(ROOT, source),
        sourceSha256: sha256(raw),
        shorthand: approval.shorthand,
        manualApproval: 'user-specified sole clean item',
        qualityAudit: lint,
      })
      if (apply) {
        const updated = {
          ...gold,
          qualityAudit: lint,
          manualAuditApproval: {
            decision: 'retain-active',
            shorthand: approval.shorthand,
            source: 'user-directed manual audit communicated 2026-10-05',
            scope: 'draft/stored target text; historical score/benchmark claims remain invalidated',
            at: now,
          },
        }
        fs.writeFileSync(source, JSON.stringify(updated, null, 2) + '\n')
      }
      continue
    }

    const archived = path.join(REJECTED, family, name)
    const existing = fs.existsSync(archived) ? fs.readFileSync(archived) : null
    if (existing && sha256(existing) !== sha256(raw)) throw new Error(`archive-collision:${path.relative(ROOT, archived)}`)
    const categories = [...new Set(lint.issues.map((i) => i.category))]
    report.actions.push({
      id: gold.id,
      action: 'quarantine',
      originalFile: path.relative(ROOT, source),
      archiveFile: path.relative(ROOT, archived),
      sourceSha256: sha256(raw),
      staticAudit: lint,
      rationale: categories.length ? 'apparatus-language detected in draft/stored' : 'not the sole item approved by the user manual audit',
    })
    if (apply) {
      fs.mkdirSync(path.dirname(archived), { recursive: true })
      if (!existing) fs.copyFileSync(source, archived)
      fs.unlinkSync(source)
      if (fs.readdirSync(familyDir).length === 0) fs.rmdirSync(familyDir)
    }
  }
}

report.counts = {
  scanned: report.actions.length,
  retained: report.actions.filter((a) => a.action === 'retain-active').length,
  quarantined: report.actions.filter((a) => a.action === 'quarantine').length,
  staticLintMatches: report.actions.filter((a) => a.action === 'quarantine' && a.staticAudit.status !== 'clean').length,
  manualAuditOnlyQuarantines: report.actions.filter((a) => a.action === 'quarantine' && a.staticAudit.status === 'clean').length,
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', ...report }, null, 2))
if (apply) {
  fs.mkdirSync(REJECTED, { recursive: true })
  const manifest = path.join(REJECTED, 'audit.json')
  fs.writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(REJECTED, 'README.md'), [
    '# Quarantined Mode 1 gold',
    '',
    'These immutable source copies are not active gold and must not enter training, evaluation, flywheel promotion, or candidate examples.',
    'The machine-readable audit manifest is `audit.json`; it records source hashes, original paths, the user-directed sole approval, and static detector findings.',
    'Static checks inspect only `draft` and `stored` target text. A clean regex result does not override the manual audit.',
    '',
  ].join('\n'))
  console.log(`\nApplied: active gold ${report.counts.retained}; quarantined ${report.counts.quarantined}; archive manifest transfer/gold-rejected/audit.json`)
}
