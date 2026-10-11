#!/usr/bin/env node
/**
 * merge-unit-reviews.mjs —— 把历次语义复核合并成一份「绑定当前数据集」的正式复核文件。
 *
 * 为什么需要：复核文件按 (sourceId, unitIdx) + 内容摘要 (sha256) join；数据集重建后旧的
 * datasetSha256AtReview 已过时，按 id（u<globalIdx>）resume 会错配。本工具只认内容摘要：
 * 旧条目里内容仍存在 → 保留；否则丢弃。新复核（对当前数据集跑的）直接并入。
 *
 * 用法：node tools/merge-unit-reviews.mjs [--dataset <path>] [--old <path>] [--fresh <path>] [--out <path>] [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const argValue = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DATASET = path.resolve(argValue('--dataset', path.join(REPO, 'transfer/models/micro-dev-dataset.json')))
const OLD = path.resolve(argValue('--old', path.join(REPO, 'transfer/models/unit-label-review.json')))
const FRESH = path.resolve(argValue('--fresh', path.join(REPO, 'transfer/models/unit-label-review-fresh.json')))
const OUT = path.resolve(argValue('--out', path.join(REPO, 'transfer/models/unit-label-review.json')))
const DRY = process.argv.includes('--dry-run')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const digestOf = (u) => sha256(JSON.stringify({ sourceId: u.sourceId, unitIdx: u.unitIdx, text: u.text }))
const SLOTS = new Set(['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE'])

const ds = JSON.parse(fs.readFileSync(DATASET, 'utf8'))
const datasetSha = sha256(fs.readFileSync(DATASET))
const units = ds.unitSamples.map((u) => ({ ...u, digest: digestOf(u) }))
const byDigest = new Map(units.map((u) => [u.digest, u]))

const load = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)
const oldDoc = load(OLD), freshDoc = load(FRESH)
const digestOfRow = (row) => row.digest || sha256(JSON.stringify({ sourceId: row.sourceId, unitIdx: row.unitIdx, text: byDigest.get(row.digest)?.text ?? '' }))
const pick = (doc, tag) => {
  const kept = [], dropped = []
  for (const row of doc?.items || []) {
    if (!row || !row.id || !SLOTS.has(String(row.slot || '').toUpperCase()) || !Number.isFinite(row.yVal) || !Number.isFinite(row.yTempt)) { dropped.push(row?.id || '?'); continue }
    const u = byDigest.get(row.digest)
    if (!u) { dropped.push(row.id); continue }
    kept.push({ ...row, globalIdx: u.globalIdx, sourceId: u.sourceId, unitIdx: u.unitIdx, digest: u.digest })
  }
  console.log(`[merge] ${tag}: 有效 ${kept.length} / 丢弃（内容已不存在或字段无效）${dropped.length}`)
  return kept
}
const oldKept = oldDoc ? pick(oldDoc, `旧复核 ${path.basename(OLD)}`) : []
const freshKept = freshDoc ? pick(freshDoc, `新复核 ${path.basename(FRESH)}`) : []
const byKey = new Map(oldKept.map((r) => [r.digest, r]))
for (const r of freshKept) byKey.set(r.digest, r)   // 新复核优先（同一单元内容以新复核为准）
const merged = [...byKey.values()].sort((a, b) => a.globalIdx - b.globalIdx)
const conf = (c) => merged.filter((r) => r.confidence === c).length
const payload = {
  schema: 'cfb.unit-label-review/1',
  reviewer: freshDoc?.reviewer || oldDoc?.reviewer || 'unknown',
  reviewerKind: 'independent-llm',
  reviewedAt: freshDoc?.reviewedAt || oldDoc?.reviewedAt || new Date().toISOString(),
  datasetPath: path.relative(REPO, DATASET),
  datasetSha256AtReview: datasetSha,
  selectionRule: 'trainingEligible=false && text.length>=8',
  counts: {
    oldKept: oldKept.length, freshKept: freshKept.length, merged: merged.length,
    confidence: { high: conf('high'), medium: conf('medium'), low: conf('low') },
    freshCostMeter: freshDoc?.costMeter || null,
  },
  note: '由 tools/merge-unit-reviews.mjs 合并：join 键 = (sourceId#unitIdx, 内容摘要)，不按 id；旧条目只有内容仍存在才保留',
  items: merged,
}
if (!DRY) fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`[merge] → ${path.relative(REPO, OUT)}${DRY ? '（dry-run 未写盘）' : ''}`)
console.log(JSON.stringify(payload.counts.confidence), 'merge 前 old=', oldKept.length, 'fresh=', freshKept.length, '⚑ merged=', merged.length)
