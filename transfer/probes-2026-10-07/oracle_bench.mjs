// 金标 oracle 验证：必需事实保留率（math=链式中间量；multihop=官方支撑句）
import fs from 'node:fs'
import { splitDiscourseUnits, compileV5Local, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'
import { compressUniversal, renderUniversalUnits } from '/home/user/cfb/src/universal-select.js'

const docs = [
  ...JSON.parse(fs.readFileSync('/home/user/probes/corpus/math_cot_labelled.json', 'utf8')),
  ...JSON.parse(fs.readFileSync('/home/user/probes/corpus/multihop_qa_labelled.json', 'utf8')),
]
const out = []
for (const d of docs) {
  const units = splitDiscourseUnits(d.text)
  if (units.length < 4) continue
  const budget = Math.max(100, Math.round(0.30 * d.text.length))
  let prod = ''
  try { prod = compileV5Local(d.text, {}, V5_MICRO_WEIGHTS).text } catch { prod = '' }
  const uni = compressUniversal(d.text, { charBudget: budget })
  // 随机与 lead 对照
  const rndOrder = [...units.keys()].sort(() => Math.random() - 0.5)
  const fill = (order) => { let used = 0; const s = []; for (const i of order) { const L = units[i].length; if (used + L > budget && s.length) continue; s.push(i); used += L; if (used >= budget) break } return s }
  out.push({
    id: d.id, domain: d.domain, chars: d.text.length,
    prod, uni: uni.text, uniIdx: uni.indices,
    rnd: renderUniversalUnits(units, fill(rndOrder)),
    lead: renderUniversalUnits(units, fill([...units.keys()])),
    chainResults: d.chain_results || null,
    support: d.supporting_facts ? { title: d.supporting_facts.title, sent: d.supporting_facts.sent_id } : null,
    context: d.supporting_facts ? d.text : null,
  })
}
fs.writeFileSync('/home/user/probes/oracle_out.json', JSON.stringify(out))
console.log('docs:', out.length, '| math:', out.filter(o => o.domain === 'math-cot').length, '| multihop:', out.filter(o => o.domain === 'multihop-qa').length)
