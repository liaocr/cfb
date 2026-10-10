import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync('.cfb-offline/_stage1_drafts.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass) continue
  console.log('='.repeat(74))
  console.log(o.id, '|', r.failed.join(','), '| ratio', r.detail.compression.ratio)
  if (r.detail.quotes.inventedAnchors.length) {
    console.log('  INVENTED ANCHORS (不在 raw∪ctx 里):', JSON.stringify(r.detail.quotes.inventedAnchors))
    for (const a of r.detail.quotes.inventedAnchors) {
      // 找出它出现在稿子的哪句话里
      const i = o.draft.indexOf(a)
      console.log('    ' + JSON.stringify(a) + '  稿中上下文: ' + JSON.stringify(o.draft.slice(Math.max(0, i - 70), i + a.length + 40)))
      // raw 里有没有近似的东西
      const base = a.split('/').pop()
      const near = o.raw.includes(base)
      console.log('      raw 里有 basename ' + JSON.stringify(base) + ' ? ' + near)
    }
  }
  if (r.failed.includes('G7')) console.log('  ratio ' + r.detail.compression.ratio + ' > 0.55 (draft ' + o.draft.length + ' / raw ' + o.raw.length + ')')
}
