#!/usr/bin/env node
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync('.cfb-offline/ruler/pairs-hand.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
let g1 = 0, g2 = 0
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (r.pass) continue
  if (r.failed.includes('G1 quote-grounded') && g1 < 5) {
    g1++
    console.log('[G1]', o.id, 'inventedAnchors=', JSON.stringify(r.detail.quotes.inventedAnchors), 'fidelity=', r.detail.quotes.fidelity)
  }
  if (r.failed.includes('G2 locus-grounded') && g2 < 6) {
    g2++
    console.log('[G2]', o.id, 'locus=', r.detail.locus.path, 'why=', r.detail.locus.why, 'grounded=', r.detail.locus.grounded, 'actionable=', r.detail.locus.actionable)
  }
}
console.log('\n=== L2 对齐（按家族标签，注意：同 id 多轮 draft，只有部分进过 L2 臂）===')
const rep = JSON.parse(fs.readFileSync('.cfb-offline/ruler/report-hand.json', 'utf8'))
const MUST_PASS = [/^hand:eacces-config_long-horizon/, /^hand:sse-truncated_decoy/, /^hand:sse-truncated_long-horizon/, /^hand:wrong-model_long-horizon/]
const MUST_FAIL = [/^hand:sse-truncated-s\d/]
let tn = 0, fn = 0, tp = 0, fp = 0
for (const r of rep.rows) {
  let expect = null
  if (MUST_FAIL.some((x) => x.test(r.id))) expect = 'fail'
  else if (MUST_PASS.some((x) => x.test(r.id))) expect = 'pass'
  if (!expect) continue
  const got = r.pass ? 'pass' : 'fail'
  if (expect === 'fail' && got === 'fail') tn++
  else if (expect === 'fail') fn++
  else if (got === 'pass') tp++
  else fp++
}
console.log('必须拒真拒=' + tn + ' 漏放=' + fn + ' | 必须过真过=' + tp + ' 误拒=' + fp)
