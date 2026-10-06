// 一次性小工具：只打印「规则没锚点却抬成正例」的可训练单元（盲审：不给规则名/槽位/旗标）
import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync('transfer/models/micro-dev-dataset.json', 'utf8'))
const sus = j.unitSamples.filter((u) => u.trainingEligible && ((u.labelAudit?.labelRule) === 'mechanism-heuristic-only' && u.slot !== 'NOISE')
  || (u.labelAudit?.labelRule) === 'no-slot-cue-or-gold-anchor' && u.slot !== 'NOISE')
const done = new Set((JSON.parse(fs.readFileSync('transfer/models/unit-label-review-blind-v3.json', 'utf8')).items || []).map((r) => r.id))
const open = sus.filter((u) => !done.has('u' + u.globalIdx))
const off = Number(process.argv[2] || 0), n = Number(process.argv[3] || 40)
fs.writeFileSync('.cfb-offline/review/suspect-ids.txt', open.map((u) => 'u' + u.globalIdx).join('\n'))
console.error(`可疑 ${sus.length} 条，我已审过的 ${sus.length - open.length} 条跳过 ⇒ 待审 ${open.length}；打印 ${off + 1}–${off + Math.min(n, open.length - off)}`)
for (const u of open.slice(off, off + n)) console.log(`[u${u.globalIdx}] ${u.text.replace(/\s+/g, ' ').trim()}`)
