// 端到端：任意文本 → compileV5Local 真实输出（生产权重），同时产出 greedy/lead 对照文本
import fs from 'node:fs'
import { compileV5Local, splitDiscourseUnits, extractAnchorsV5, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'

const docs = []
for (const f of ['math_cot.jsonl', 'multihop_qa.jsonl']) {
  const parsed = JSON.parse(fs.readFileSync(`/home/user/probes/corpus/${f}`, 'utf8'))
  for (const d of parsed) docs.push(d)
}
for (const [rel, tag] of [['transfer/HANDOFF.md', 'repo-handoff'], ['docs/KAGGLE-MICRO-RUN.md', 'repo-runbook']]) {
  if (fs.existsSync(`/home/user/cfb/${rel}`)) docs.push({ id: rel.replace(/\W+/g, '_'), domain: tag, text: fs.readFileSync(`/home/user/cfb/${rel}`, 'utf8').slice(0, 20000) })
}
const out = []
for (const d of docs) {
  let rendered = '', err = null, meta = null
  try {
    const r = compileV5Local(d.text, {}, V5_MICRO_WEIGHTS)
    rendered = r.text; meta = r.meta
  } catch (e) { err = String(e.message || e).slice(0, 160) }
  out.push({ id: d.id, domain: d.domain, chars: d.text.length, rendered, renderedChars: rendered.length, selectedOps: meta?.selectedOps ?? null, totalUnits: meta?.totalUnits ?? null, archetype: meta?.archetype ?? null, prefScore: meta?.prefScore ?? null, err })
}
fs.writeFileSync('/home/user/probes/e2e_out.jsonl', out.map(o => JSON.stringify(o)).join('\n'))
console.log('done', out.length, '| 报错:', out.filter(o => o.err).length)
