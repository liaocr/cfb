import crypto from 'node:crypto'; import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync('transfer/models/micro-dev-dataset.json','utf8'))
const done = new Set((JSON.parse(fs.readFileSync('transfer/models/unit-label-review-blind-v3.json','utf8')).items||[]).map(r=>r.id))
const neg = j.unitSamples.filter(u=>u.trainingEligible && u.slot==='NOISE' && !done.has('u'+u.globalIdx))
// 确定性抽样：按 sha256(seed+id) 排序取前 K，避免我挑好看的
const seed='cfb-neg-spot-2026-10-06'
const keyed=neg.map(u=>({u,k:crypto.createHash('sha256').update(seed+':u'+u.globalIdx).digest('hex')})).sort((a,b)=>a.k<b.k?-1:1)
const take=keyed.slice(0,Number(process.argv[2]||15))
console.error(`未审负例 ${neg.length} 条 ⇒ 确定性抽 ${take.length}`)
for(const {u} of take) console.log(`[u${u.globalIdx}] ${u.family} · ${u.text.replace(/\s+/g,' ').trim().slice(0,260)}`)
