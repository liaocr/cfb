#!/usr/bin/env node
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
let shown = 0
const agg = {}
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass) continue
  for (const f of r.failed) (agg[f] = agg[f] || []).push(o.id)
  if (shown < 6) {
    shown++
    console.log('─'.repeat(70))
    console.log(o.id, '| failed:', r.failed.join(', '), '| ratio', r.detail.compression.ratio)
    if (r.detail.quotes.invented.length) console.log('  INVENTED:', JSON.stringify(r.detail.quotes.invented, null, 1).slice(0, 900))
    if (r.detail.anchors.lostPaths) console.log('  LOST PATHS:', JSON.stringify(r.detail.anchors.lostPaths))
    console.log('  locus:', JSON.stringify(r.detail.locus))
  }
}
console.log('\n=== failure -> ids ===')
for (const [k, v] of Object.entries(agg)) console.log(k, 'x' + v.length, v.slice(0, 8).join(','))
