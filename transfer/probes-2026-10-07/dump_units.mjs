// 任意文本 → 单元 + 19维特征 + 生产打分 + selectOpsV5 选材（部署路径复刻）
import fs from 'node:fs'
import path from 'node:path'
import { splitDiscourseUnits, extractUnitFeatures, scoreUnitWithWeights, selectOpsV5, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'

const OUT = '/home/user/probes/units.jsonl'
const docs = []
for (const f of ['math_cot.jsonl', 'multihop_qa.jsonl']) {
  const parsed = JSON.parse(fs.readFileSync(`/home/user/probes/corpus/${f}`, 'utf8'))
  for (const d of (Array.isArray(parsed) ? parsed : [parsed])) docs.push(d)
}
// 本地技术文档（中文 CoT 风格的真实 trace/笔记）
const repoDocs = [
  ['transfer/HANDOFF.md', 'repo-handoff'],
  ['docs/KAGGLE-MICRO-RUN.md', 'repo-runbook'],
]
for (const [rel, tag] of repoDocs) {
  const p = `/home/user/cfb/${rel}`
  if (fs.existsSync(p)) docs.push({ id: rel.replace(/\W+/g, '_'), domain: tag, text: fs.readFileSync(p, 'utf8').slice(0, 20000) })
}

const w = fs.createWriteStream(OUT)
let kept = 0
for (const d of docs) {
  const units = splitDiscourseUnits(d.text)
  if (units.length < 4) continue
  const ctxInfo = { raw: d.text, toolText: '', targetAnchors: new Set(), offsets: [] }
  const feats = units.map((u, i) => extractUnitFeatures(u, i, units.length, ctxInfo, { textHashBuckets: 0 }))
  const scores = feats.map(f => scoreUnitWithWeights(f, V5_MICRO_WEIGHTS))
  const chosenIdx = selectOpsV5(units, feats, scores, V5_MICRO_WEIGHTS, 24)
    .map(c => units.indexOf(c.text))
  w.write(JSON.stringify({
    id: d.id, domain: d.domain, docChars: d.text.length,
    units: units.map((t, i) => ({ t, tok: feats[i].tok, v: scores[i].v, slot: scores[i].slot })),
    chosenIdx,
  }) + '\n')
  kept++
}
w.end()
console.log('docs dumped:', kept)
