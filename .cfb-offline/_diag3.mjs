#!/usr/bin/env node
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const STRONG = /\b(fix|fixes|fixed|minimal|correct fix|the fix|should use|should be|should only|instead of|rather than|replace|revert|change|edit|remove|drop)\b|\u6539|\u4fee|\u6362\u6210|\u5220\u6389/
const SYM = /EACCES|ENOENT|EPERM|denied|read-only|\u53ea\u8bfb|root-owned|\u6743\u9650|permission|\u65e0\u6cd5|\u4e0d\u80fd|throw|throws|crash|\u62a5\u9519/i
let n = 0
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass) continue
  const g2 = r.failed.includes('G2 locus-grounded'), g3 = r.failed.includes('G3 anchors-kept')
  if (!g2 && !g3) continue
  if (n >= 8) break
  n++
  console.log('='.repeat(74))
  console.log(o.id, '|', r.failed.join(','))
  if (g2) {
    const p = r.detail.locus.path
    console.log('  LOCUS:', p, '| actionable:', r.detail.locus.actionable, r.detail.locus.why)
    const base = p.split('/').pop()
    const needle = o.raw.includes(p) ? p : base
    let i = 0, shown = 0
    for (;;) {
      const at = o.raw.indexOf(needle, i); if (at < 0 || shown >= 3) break
      shown++
      const w = o.raw.slice(Math.max(0, at - 120), at + needle.length + 120)
      console.log('    win strong=' + STRONG.test(w) + ' sym=' + SYM.test(w) + ' :: ' + JSON.stringify(w).slice(0, 330))
      i = at + needle.length
    }
  }
  if (g3) {
    const a = r.detail.anchors
    console.log('  ANCHORS load=' + a.loadBearing + ' kept=' + a.kept + ' sample=' + JSON.stringify(a.sample))
    console.log('    lostPaths=' + JSON.stringify(a.lostPaths))
    for (const x of a.sample) {
      const inD = o.draft.includes(x) || o.draft.includes(x.split('/').pop())
      if (!inD) console.log('      LOST:', JSON.stringify(x))
    }
  }
}
