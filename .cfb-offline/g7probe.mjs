
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const L = fs.readFileSync(new URL('./sft/dev.jsonl', import.meta.url),'utf8').split(/\r?\n/).filter(x=>x.trim()).map(JSON.parse)
const rs = []
for (const r of L) {
  const j = judge({ raw: r.raw, ctx: r.ctx, draft: r.assistant })
  rs.push({ id: r.id, tok: j.detail.compression.tokenRatio, chr: j.detail.compression.ratio,
            rawTok: j.detail.compression.rawTokensEst, draftTok: j.detail.compression.draftTokensEst,
            pass: j.pass, failed: j.failed })
}
const q = (a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.floor((s.length-1)*p)]}
const t = rs.map(r=>r.tok)
console.log('教师 dev token 比：p10',q(t,.1).toFixed(3),'p25',q(t,.25).toFixed(3),'p50',q(t,.5).toFixed(3),'p75',q(t,.75).toFixed(3),'p90',q(t,.9).toFixed(3),'max',q(t,1).toFixed(3))
const g7 = rs.filter(r=>r.failed.includes('G7 compressed')).map(r=>r.tok)
console.log('G7 失败',g7.length,'条的 token 比：min',Math.min(...g7).toFixed(3),'p50',q(g7,.5).toFixed(3),'max',Math.max(...g7).toFixed(3))
for (const b of [0.5,0.55,0.6,0.65,0.7,0.8,1.0]) {
  const n = t.filter(x=>x>b).length
  console.log('  > '+b.toFixed(2)+' : '+n+'/'+t.length+' ('+(100*n/t.length).toFixed(1)+'%)')
}
const only7 = rs.filter(r=>!r.pass && r.failed.length===1 && r.failed[0]==='G7 compressed')
console.log('--- 教师"除 G7 外全过"的单元 ---')
if (only7.length) console.log('  数量',only7.length,'token 比 min',Math.min(...only7.map(r=>r.tok)).toFixed(3),'p50',q(only7.map(r=>r.tok),.5).toFixed(3),'max',Math.max(...only7.map(r=>r.tok)).toFixed(3))
const byFail={}
for (const r of rs) for (const f of r.failed) byFail[f]=(byFail[f]||0)+1
console.log('失败分布', JSON.stringify(byFail))
