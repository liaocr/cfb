
import fs from 'node:fs'
const L = fs.readFileSync(new URL('./sft/dev.jsonl', import.meta.url),'utf8').split(/\r?\n/).filter(x=>x.trim()).map(JSON.parse)
const { judge } = await import('../tools/gen-ruler.mjs')
// 复现 judge 的门，只把 G7 阈值换掉
const rows = L.map(r => ({ r, j: judge({raw:r.raw, ctx:r.ctx, draft:r.assistant}) }))
console.log('G7 阈值  全体通过   有受力点子集通过')
for (const th of [0.55, 0.60, 0.65, 0.70, 0.80, 1.00, 99]) {
  let all=0, sc=0, scn=0
  for (const {r,j} of rows) {
    const f = j.failed.filter(x => x !== 'G7 compressed')
    if (th < 99 && j.detail.compression.tokenRatio > th) f.push('G7 compressed')
    const pass = f.length === 0
    if (pass) all++
    if (!j.failed.includes('G0 no-leverage')) { scn++; if (pass) sc++ }
  }
  console.log('  ' + (th<99?th.toFixed(2):'不限').padEnd(7) + '  ' + (all+'/89').padEnd(9) + '  ' + sc+'/'+scn)
}
