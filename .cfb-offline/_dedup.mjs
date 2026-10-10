#!/usr/bin/env node
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import path from 'node:path'
const CENSUS = 'transfer/models/micro-generator-v4flash-scenarios'
const files = fs.readdirSync(CENSUS).filter((f) => /^birth-units-census-batch\d+\.jsonl\.gz$/.test(f)).sort()
const rows = []
for (const f of files) {
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(CENSUS, f)))
  for (const line of buf.toString('utf8').split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)) } catch {} }
}
const h = (s) => crypto.createHash('sha256').update(s).digest('hex')

// 1) 同一 unitId 的多行是否字节相同？
const byUnit = new Map()
for (const r of rows) { if (!byUnit.has(r.unitId)) byUnit.set(r.unitId, []); byUnit.get(r.unitId).push(r) }
let sameParty = 0, diffRaw = 0, diffCtx = 0, diffAfter = 0
for (const [, g] of byUnit) {
  if (g.length < 2) continue
  sameParty++
  const raws = new Set(g.map((x) => h(x.raw || '')))
  const ctxs = new Set(g.map((x) => h(x.ctx || '')))
  const afters = new Set(g.map((x) => h(JSON.stringify(x.after || {}))))
  if (raws.size > 1) diffRaw++
  if (ctxs.size > 1) diffCtx++
  if (afters.size > 1) diffAfter++
}
console.log('=== 同 unitId 重复行（' + sameParty + ' 组）===')
console.log('  raw 不同的组: ' + diffRaw + ' | ctx 不同: ' + diffCtx + ' | after 不同: ' + diffAfter)

// 2) 内容级去重：raw 的 sha 有多少唯一值
const rawHashes = new Set(rows.map((r) => h(r.raw || '')))
const pairHashes = new Set(rows.map((r) => h((r.raw || '') + '\u0000' + (r.ctx || ''))))
console.log('\n=== 内容级去重 ===')
console.log('  行数            ' + rows.length)
console.log('  unitId 唯一     ' + byUnit.size)
console.log('  raw 内容唯一    ' + rawHashes.size)
console.log('  (raw,ctx) 唯一  ' + pairHashes.size)

// 3) 每轨迹一单元后，再按 raw 内容去重
const byTraj = new Map()
for (const r of rows) { const t = (r.source || {}).trajectoryId || r.unitId; if (!byTraj.has(t)) byTraj.set(t, []); byTraj.get(t).push(r) }
const lens = [...byUnit.values()].map((g) => g[0].rawChars).sort((a, b) => a - b)
const med = lens[Math.floor(lens.length / 2)]
const reps = []
for (const [, g] of byTraj) { g.sort((a, b) => Math.abs(a.rawChars - med) - Math.abs(b.rawChars - med) || String(a.unitId).localeCompare(String(b.unitId))); reps.push(g[0]) }
const repRawHashes = new Set(reps.map((r) => h(r.raw || '')))
console.log('  每轨迹1单元     ' + reps.length)
console.log('  其中 raw 唯一   ' + repRawHashes.size + '  （内容级再去重还能砍掉 ' + (reps.length - repRawHashes.size) + '）')

// 4) 指示符 / verdict 分布
const q = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? { min: a[0], q25: a[Math.floor(a.length * .25)], med: a[Math.floor(a.length * .5)], q75: a[Math.floor(a.length * .75)], max: a[a.length - 1] } : {} }
const ids = reps.map((r) => ((r.offlineSignals || {}).identifiersInRaw || []).length)
const vd = reps.map((r) => ((r.offlineSignals || {}).verdictLinesInRaw || []).length)
const rc = reps.map((r) => r.rawChars)
console.log('\n=== 分布（' + reps.length + ' 条，每轨迹1单元）===')
console.log('  identifiersInRaw ' + JSON.stringify(q(ids)))
console.log('  verdictLinesInRaw ' + JSON.stringify(q(vd)))
console.log('  rawChars         ' + JSON.stringify(q(rc)))
console.log('  verdict==0 的条数 ' + vd.filter((x) => x === 0).length + ' / ' + vd.length)
console.log('  identifiers<3    ' + ids.filter((x) => x < 3).length)
console.log('  rawChars>12000   ' + rc.filter((x) => x > 12000).length)
console.log('  rawChars<800     ' + rc.filter((x) => x < 800).length)
