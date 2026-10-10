
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'

const rd = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const dev = rd('.cfb-offline/sft/dev.jsonl')
const gen = new Map(rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl').map((r) => [r.id, r]))

let sInv = 0, tInv = 0, sRows = 0, tRows = 0
const sAnchor = new Map(), tAnchor = new Map()
const sFid = [], tFid = []
for (const d of dev) {
  const g = gen.get(d.id); if (!g) continue
  const tj = judge({ raw: d.raw, ctx: d.ctx, draft: d.assistant })
  const sj = judge({ raw: d.raw, ctx: d.ctx, draft: g.draft })
  const si = sj.detail.quotes.inventedAnchors, ti = tj.detail.quotes.inventedAnchors
  if (si.length) { sRows++; sInv += si.length; for (const a of si) sAnchor.set(a, (sAnchor.get(a) || 0) + 1) }
  if (ti.length) { tRows++; tInv += ti.length; for (const a of ti) tAnchor.set(a, (tAnchor.get(a) || 0) + 1) }
  sFid.push(sj.detail.quotes.fidelity); tFid.push(tj.detail.quotes.fidelity)
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] }
console.log('=== G1 抓到的「凭空锚点」 ===')
console.log('  学生：有凭空锚点的行 ' + sRows + '/89 · 锚点总数 ' + sInv)
console.log('  教师：有凭空锚点的行 ' + tRows + '/89 · 锚点总数 ' + tInv)
console.log('  引用保真度(S6) p50：学生 ' + q(sFid,.5).toFixed(3) + ' · 教师 ' + q(tFid,.5).toFixed(3))
console.log('  学生 top10：')
;[...sAnchor.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([a,n])=>console.log('    '+JSON.stringify(a)+' x'+n))
console.log('  教师 top10：')
;[...tAnchor.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([a,n])=>console.log('    '+JSON.stringify(a)+' x'+n))

const ID = 'adamtheturtle_sybil-extras_pr297#b11'
const d = dev.find((x)=>x.id===ID), g = gen.get(ID)
const sj = judge({ raw:d.raw, ctx:d.ctx, draft:g.draft })
console.log()
console.log('=== ' + ID + ' ===')
console.log('  学生 quotes ' + sj.detail.quotes.total + ' · verbatim ' + sj.detail.quotes.verbatim + ' · fidelity ' + sj.detail.quotes.fidelity)
console.log('  学生凭空锚点：' + JSON.stringify(sj.detail.quotes.inventedAnchors))
for (const a of sj.detail.quotes.inventedAnchors) {
  const i = d.raw.indexOf(a)
  console.log('    ' + JSON.stringify(a) + ' -> raw.indexOf=' + i + (i>=0 ? '  (在！)' : '  (不在)'))
}