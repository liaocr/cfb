import fs from 'node:fs'
import { extractAnchorsV5 } from '/home/user/cfb/src/compile-v5-local.js'
const rows = fs.readFileSync('/home/user/probes/e2e_out.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const DOCS = {}
for (const f of ['math_cot.jsonl', 'multihop_qa.jsonl']) for (const d of JSON.parse(fs.readFileSync(`/home/user/probes/corpus/${f}`, 'utf8'))) DOCS[d.id] = d
for (const [rel, tag] of [['transfer/HANDOFF.md', 'repo-handoff'], ['docs/KAGGLE-MICRO-RUN.md', 'repo-runbook']]) {
  if (fs.existsSync(`/home/user/cfb/${rel}`)) DOCS[rel.replace(/\W+/g, '_')] = { text: fs.readFileSync(`/home/user/cfb/${rel}`, 'utf8').slice(0, 20000) }
}
const by = {}
for (const o of rows) {
  const d = DOCS[o.id]; if (!d) continue
  const A = extractAnchorsV5(d.text), B = extractAnchorsV5(o.rendered)
  const covered = [...A].filter(a => B.has(a)).length
  const junk = [...B].filter(b => !A.has(b))
  const k = o.domain; by[k] = by[k] || { n: 0, cov: 0, junk: 0, aj: 0, bj: 0 }
  by[k].n++; by[k].cov += A.size ? covered / A.size : 0
  by[k].junk += B.size ? junk.length / B.size : 0
  by[k].aj += A.size; by[k].bj += B.size
}
console.log('（锚点口径 = 仓库自己的 extractAnchorsV5；junk = 输出里原文没有的锚点占比）')
for (const [k, v] of Object.entries(by)) {
  console.log(`  ${k.padEnd(14)} n=${v.n} 覆盖 ${(100 * v.cov / v.n).toFixed(1)}% | 幻觉锚点 ${(100 * v.junk / v.n).toFixed(1)}% | 源锚点均值 ${(v.aj / v.n).toFixed(1)} 输出锚点均值 ${(v.bj / v.n).toFixed(1)}`)
}
