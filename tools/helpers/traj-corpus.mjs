// Legacy hand-capture research corpus, not generative SFT admission.
// Structural lint clean != factual review. Time order never establishes preference.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { goldRulerOk } from './three-mode.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CORPUS_ROOT = path.resolve(HERE, '..', '..')
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
export function defaultTrajDirs(root = CORPUS_ROOT) {
  const base = path.join(root, '.cfb-runtime', 'traj')
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).sort().map((d) => path.join(base, d)).filter((d) => fs.existsSync(path.join(d, 'hand-samples.jsonl')))
}
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { throw new Error(`invalid-hand-corpus-json:${file}:${i + 1}`) }
})

/** Revision preference must be explicitly content-bound and reviewed.
 * This preserves the legacy API for research callers; trainingApproved stays false.
 * Ruler identifiers are excluded first, with explicit counters (or an error).
 */
export function loadTrajTrainingSamples({ root = CORPUS_ROOT, dirs = null, rulerIds = new Set(), families = null, minRawChars = 0, onRulerId = 'skip' } = {}) {
  if (onRulerId !== 'skip' && onRulerId !== 'throw') throw new Error('traj-corpus-onRulerId:' + onRulerId)
  const roots = dirs && dirs.length ? dirs.map((d) => path.resolve(root, d)) : defaultTrajDirs(root)
  const byId = new Map()
  const stats = { files: 0, rows: 0, droppedIneligible: 0, droppedAudit: 0, droppedFamily: 0, droppedShort: 0, revised: 0, asRuler: 0, rulerIds: [], exactDuplicates: 0, conflicts: 0, quarantined: [] }
  for (const dir of roots) {
    const file = path.join(dir, 'hand-samples.jsonl')
    if (!fs.existsSync(file)) continue
    stats.files++
    const planId = path.basename(dir)
    for (const r of readJsonl(file)) {
      stats.rows++
      const id = String(r.id || '')
      if (!id) { stats.droppedIneligible++; continue }
      if (rulerIds.has(id)) {
        if (onRulerId === 'throw') throw new Error(`ruler-leakage-into-train:${id}（标尺数据不能进训练）`)
        stats.asRuler++
        if (!stats.rulerIds.includes(id)) stats.rulerIds.push(id)
        continue
      }
      if (r.trainingEligible !== true) { stats.droppedIneligible++; continue }
      if (r.qualityAudit?.status !== 'clean') { stats.droppedAudit++; continue }
      const family = String(r.task || r.family || '').replace(/^pool:/, '')
      if (families && families.length && !families.includes(family.split(/[:_]/)[0])) { stats.droppedFamily++; continue }
      const raw = String(r.raw || '')
      if (raw.length < minRawChars) { stats.droppedShort++; continue }
      const hand = String(r.draft || r.gold || r.hand || ''), ctx = String(r.ctx || '')
      if (!raw || !hand) { stats.droppedIneligible++; continue }
      const item = {
        id, family, split: 'train', use: 'train', raw, ctx, draft: hand, hand,
        plan: planId, source: 'traj:' + planId, sourceFile: path.relative(root, file),
        at: r.at || null, round: r.round ?? null, gate: r.gate ?? null,
        rawChars: r.rawChars ?? raw.length, draftChars: r.draftChars ?? hand.length,
        revisionReview: r.revisionReview || null,
        scope: 'legacy-structural-research-only', trainingApproved: false,
      }
      if (!byId.has(id)) byId.set(id, [])
      byId.get(id).push(item)
    }
  }
  const samples = [], pairs = []
  const quarantine = (id, why) => { stats.conflicts++; stats.quarantined.push({ id, why }) }
  for (const [id, events] of byId) {
    const inputSignatures = new Set(events.map((v) => sha(JSON.stringify([v.raw, v.ctx, v.family]))))
    if (inputSignatures.size !== 1) { quarantine(id, 'same-id-different-input-or-family'); continue }
    const versions = new Map(events.map((v) => [sha(v.hand), v]))
    stats.exactDuplicates += events.length - versions.size
    if (versions.size === 1) { samples.push(events[0]); continue }
    stats.revised += versions.size - 1
    const approved = new Map()
    for (const event of events) {
      const r = event.revisionReview
      if (!r || r.schema !== 'cfb.revision-review/1' || r.status !== 'approved' || typeof r.reviewerId !== 'string' || !r.reviewerId.trim()) continue
      if (r.rawSha256 !== sha(event.raw) || r.ctxSha256 !== sha(event.ctx) || !versions.has(r.chosenSha256)) continue
      const losers = [...versions.keys()].filter((h) => h !== r.chosenSha256)
      if (!Array.isArray(r.rejectedSha256) || r.rejectedSha256.length !== losers.length || !losers.every((h) => r.rejectedSha256.includes(h))) continue
      approved.set(r.chosenSha256, r)
    }
    if (approved.size !== 1) { quarantine(id, approved.size ? 'conflicting-revision-reviews' : 'unreviewed-revisions-time-is-not-quality'); continue }
    const [chosenSha, review] = [...approved][0]
    const chosen = versions.get(chosenSha)
    samples.push({ ...chosen, revisionReview: review })
    for (const [rejectedSha, rejected] of versions) if (rejectedSha !== chosenSha) pairs.push({
      kind: 'revision', chosen: chosen.hand, rejected: rejected.hand, id, family: chosen.family,
      chosenAt: chosen.at, rejectedAt: rejected.at,
      preferenceSource: 'content-bound-review-not-time', revisionReview: review,
      chosenSha256: chosenSha, rejectedSha256: rejectedSha, trainingApproved: false,
    })
  }
  return { samples: samples.sort((a, b) => (a.family + a.id).localeCompare(b.family + b.id)), pairs, stats, dirs: roots.map((d) => path.relative(root, d)), trainingApproved: false }
}
export function rulerIdSet(goldItems) { return new Set(goldItems.filter(goldRulerOk).map((g) => g.id)) }
