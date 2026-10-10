import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync('.cfb-offline/teacher/drafts.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const byFail = {}
const inv = []
const other = []
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass) continue
  const key = r.failed.join('+')
  byFail[key] = (byFail[key] || 0) + 1
  const d = r.detail
  if (r.failed.includes('G1 quote-grounded')) {
    inv.push({ id: o.id, ratio: d.compression.ratio, anchors: d.quotes.inventedAnchors, draft: o.draft, raw: o.raw, ctx: o.ctx })
  } else {
    other.push({ id: o.id, failed: r.failed, ratio: d.compression.ratio, a: d.anchors, q: d.quotes })
  }
}
console.log('=== 拒稿组合分布 ===')
console.log(JSON.stringify(byFail, null, 1))
console.log('\n=== G1 凭空引用：' + inv.length + ' 条，逐条看 anchor 在不在 raw/ctx ===')
for (const x of inv) {
  console.log('-'.repeat(70))
  console.log(x.id, 'ratio', x.ratio.toFixed(3))
  for (const a of x.anchors) {
    const base = a.split('/').pop()
    console.log('   ' + JSON.stringify(a) + '  raw含basename=' + x.raw.includes(base) + ' ctx含=' + x.ctx.includes(base) + ' raw原文含全串=' + x.raw.includes(a))
  }
}
console.log('\n=== 非 G1 拒稿 ===')
for (const x of other) console.log(x.id, '|', x.failed.join(','), '| ratio', x.ratio.toFixed(3), '|', JSON.stringify(x.a))
