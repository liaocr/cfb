#!/usr/bin/env node
import fs from 'node:fs'
const rep = JSON.parse(fs.readFileSync('.cfb-offline/ruler/report-hand.json', 'utf8'))
// L2 真读数（来自 .cfb-runtime/**/results.jsonl 的 raw/hand 两臂）
const MUST_PASS = [/^hand:eacces-config_long-horizon/, /^hand:sse-truncated_decoy/, /^hand:sse-truncated_long-horizon/, /^hand:wrong-model_long-horizon/]
const MUST_FAIL = [/^hand:sse-truncated-s\d/]
let tp = 0, fp = 0, tn = 0, fn = 0
const lines = []
for (const r of rep.rows) {
  const id = r.id
  let expect = null
  if (MUST_FAIL.some((x) => x.test(id))) expect = 'fail'
  else if (MUST_PASS.some((x) => x.test(id))) expect = 'pass'
  if (!expect) continue
  const got = r.pass ? 'pass' : 'fail'
  const agree = expect === got
  if (expect === 'fail' && got === 'fail') tn++
  if (expect === 'fail' && got === 'pass') fn++
  if (expect === 'pass' && got === 'pass') tp++
  if (expect === 'pass' && got === 'fail') fp++
  lines.push((agree ? ' AGREE ' : '  MISS ') + id.padEnd(46) + ' expect=' + expect + ' got=' + got + ' score=' + r.score + ' failed=[' + r.failed.join(',') + ']')
}
console.log('=== 与 L2 真读数对齐（n=' + lines.length + '） ===')
console.log(lines.join('\n'))
console.log('\n必须拒/真拒=' + tn + '  必须拒/漏放=' + fn + '  必须过/真过=' + tp + '  必须过/误拒=' + fp)
console.log('\n=== 全部 61 条 ===')
for (const r of rep.rows) {
  console.log((r.pass ? ' PASS ' : ' REJ  ') + String(r.id).padEnd(48) + ' s=' + String(r.score).padEnd(7) + ' ratio=' + String(r.ratio).padEnd(7) + ' copy=' + String(r.copy).padEnd(7) + (r.pass ? '' : ' ' + r.failed.join(',')))
}
