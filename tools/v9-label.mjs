// tools/v9-label.mjs —— 对样本池做 PREREG-v9 标注（只写标签，不写正文）。
// 输出 data-v9/labelled-pool.jsonl：每个唯一 unitId 一行，含切分、尺子判定、软分、来源行号与哈希。
// 正文不复制：按 source + sourceLine 从原文件取回，并用 sourceLineSha256 校验。
// 用法：node tools/v9-label.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { grade, RULER_V9, assertFrozen } from './ruler-v9.mjs'
import { readLines, parseSample } from './v9-inventory.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'data-v9')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h >>> 0 }
const splitOf = (repo) => { const m = fnv1a(String(repo)) % 10; return m <= 1 ? 'test' : m === 2 ? 'dev' : 'train' }

const thr = JSON.parse(fs.readFileSync(path.join(OUT, 'thresholds.json'), 'utf8'))
assertFrozen({ genRulerSha256: thr.genRulerSha256, negativesSha256: thr.negativesSha256 })

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (/node_modules|\.git[\\/]|\/traj\/|archive|pending|drafts/.test(p)) continue
    if (e.isDirectory()) walk(p); else if (/\.jsonl(\.gz)?$/.test(e.name)) files.push(p)
  }
}
walk(path.join(ROOT, 'transfer', 'models'))
files.sort()

const seen = new Map()
const dupLog = []
for (const f of files) {
  let lines
  try { lines = readLines(f) } catch { continue }
  lines.forEach((l, i) => {
    const s = parseSample(l)
    if (!s || !s.unitId) return
    if (seen.has(s.unitId)) { dupLog.push({ unitId: s.unitId, kept: seen.get(s.unitId).source, dropped: path.relative(ROOT, f), sameTarget: seen.get(s.unitId).targetSha === sha(s.target) }); return }
    seen.set(s.unitId, { ...s, source: path.relative(ROOT, f), sourceLine: i + 1, lineSha: sha(l), targetSha: sha(s.target) })
  })
}

const rows = []
const agg = { total: 0, unscorable: 0, pass: 0, failCounts: {} }
for (const u of seen.values()) {
  const g = grade({ raw: u.raw, ctx: u.ctx, draft: u.target })
  agg.total++
  if (g.gaugeable !== true) agg.unscorable++
  else if (g.pass === true) agg.pass++
  for (const f of g.hardFailed || []) agg.failCounts[f] = (agg.failCounts[f] || 0) + 1
  rows.push({
    unitId: u.unitId, repo: u.repo, license: u.license || null, split: splitOf(u.repo),
    source: u.source, sourceLine: u.sourceLine, sourceLineSha256: u.lineSha, targetSha256: u.targetSha,
    v9: { gaugeable: g.gaugeable, pass: g.pass, softScore: g.softScore, hardFailed: g.hardFailed },
    ruler: RULER_V9, trainable: false,
    trainableReason: 'PREREG-v9 验证结果为 INVALID（见 validation.json），标签仅供分析，不得用于训练',
  })
}
fs.writeFileSync(path.join(OUT, 'labelled-pool.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const summary = {
  ruler: RULER_V9, uniqueUnits: agg.total, duplicateRows: dupLog.length, duplicateSameTarget: dupLog.filter((d) => d.sameTarget).length,
  unscorable: agg.unscorable, gaugeable: agg.total - agg.unscorable, hardPass: agg.pass,
  hardPassRateOfGaugeable: +(agg.pass / (agg.total - agg.unscorable)).toFixed(4),
  hardFailCountsAmongAll: agg.failCounts,
  bySplit: Object.fromEntries(['train', 'dev', 'test'].map((sp) => { const r = rows.filter((x) => x.split === sp); const gg = r.filter((x) => x.v9.gaugeable); return [sp, { units: r.length, gaugeable: gg.length, hardPass: gg.filter((x) => x.v9.pass === true).length }] })),
  filesScanned: files.map((f) => path.relative(ROOT, f)).length,
  filesContributing: [...new Set([...seen.values()].map((u) => u.source))].sort(),
}
fs.writeFileSync(path.join(OUT, 'labelled-pool.summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
