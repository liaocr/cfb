#!/usr/bin/env node
import fs from 'node:fs'
import { judge, stripFmt, norm, quotedFragments } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
let n = 0
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass || !r.failed.includes('G1 quote-grounded')) continue
  if (n >= 5) break
  n++
  console.log('='.repeat(72))
  console.log(o.id, 'rawLen', o.raw.length)
  const ev = stripFmt(o.raw + '\n' + o.ctx)
  for (const f of quotedFragments(o.draft)) {
    const sf = stripFmt(f)
    if (sf.length < 4 || ev.includes(sf)) continue
    // try looser matches
    const loose = sf.replace(/[\u2014\u2013\-,.;:()"'\u201c\u201d\u300c\u300d]/g, '').replace(/\s+/g, '')
    const evLoose = ev.replace(/[\u2014\u2013\-,.;:()"'\u201c\u201d\u300c\u300d]/g, '').replace(/\s+/g, '')
    console.log('  FRAG:', JSON.stringify(f).slice(0, 200))
    console.log('   strict-in-ev:', ev.includes(sf), ' loose-in-ev:', evLoose.includes(loose))
    if (evLoose.includes(loose)) {
      const at = evLoose.indexOf(loose)
      console.log('   loose ctx:', JSON.stringify(ev.slice(Math.max(0, at - 30), at + loose.length + 30)).slice(0, 260))
    }
  }
}
