import fs from 'node:fs'
import { scoreUnitWithWeights, selectOpsV5, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'
const repo='/home/user/cfb'
const ds=JSON.parse(fs.readFileSync(`${repo}/transfer/models/micro-dev-dataset.json`,'utf8'))
const fam=v=>String(v||'').replace(/^pool:/,'').split(':',1)[0]
const byDoc=new Map()
for (const u of ds.unitSamples) { const k=`${fam(u.family)}|${u.sourceId}`
  if(!byDoc.has(k)) byDoc.set(k,{family:fam(u.family),units:[]}); byDoc.get(k).units.push(u) }
// 承重集：labelAudit.overlap 有任一槽位匹配到金标锚点
const goldHits=u=>{const o=u.labelAudit?.overlap||{};let n=0;for(const k of ['DECIDED','EXCLUDED','ACCEPT','OPEN'])n+=(o[k]?.matchedAnchors||[]).length;return n}
function run(weights,label){
  let docs=0,rec=0,load=0,pick=0,pickNoise=0,oracleRec=0
  for (const [k,d] of byDoc) {
    const U=d.units; if (U.length<4) continue
    const loadIdx=U.map((u,i)=>goldHits(u)>0?i:-1).filter(i=>i>=0)
    if (!loadIdx.length) continue
    docs++; load+=loadIdx.length
    const feats=U.map((u,i)=>({vec:u.features,tok:u.tokenCount,temptationT:u.temptationT??u.features[9],cueExcluded:u.features[15],ids:new Set()}))
    const scores=feats.map(f=>scoreUnitWithWeights(f,weights))
    const budget=Math.max(3,Math.round(U.length*0.30))
    const chosen=selectOpsV5(U.map(u=>u.text),feats,scores,weights,budget)
    const sel=new Set(chosen.map(c=>U.findIndex(u=>u.text===c.text)))
    for (const i of sel) { pick++; const u=U[i]; if (goldHits(u)>0) rec++; else if ((u.yVal??1)<=0.10) pickNoise++ }
    const topR=[...scores.keys()].sort((a,b)=>scores[b].v-scores[a].v).slice(0,budget)
    oracleRec += topR.filter(i=>goldHits(U[i])>0).length
  }
  const pct=x=>(100*x).toFixed(1)
  console.log(`${label}  文档 ${docs} | 承重单元 ${load} | 选中 ${pick} | 承重召回 ${pct(rec/Math.max(1,load))}% | 纯噪声注入率 ${pct(pickNoise/Math.max(1,pick))}% | 纯按v排序的召回上界 ${pct(oracleRec/Math.max(1,load))}%`)
}
console.log('=== 压缩质量（预算=每文档 30% 单元；选材器=生产 selectOpsV5）===')
run(V5_MICRO_WEIGHTS,'生产权重 ')
// 随机基线：固定种子抽样
let rng=42; const rnd=()=>((rng=(rng*1103515245+12345)&0x7fffffff)/0x7fffffff)
let load=0,rec=0;
for (const [k,d] of byDoc){ const U=d.units; const loadIdx=U.map((u,i)=>goldHits(u)>0?i:-1).filter(i=>i>=0); if(!loadIdx.length||U.length<4)continue
  load+=loadIdx.length; const b=Math.max(3,Math.round(U.length*0.30)); const sel=new Set(); while(sel.size<b) sel.add(Math.floor(rnd()*U.length))
  for(const i of sel) if (goldHits(U[i])>0) rec++ }
console.log(`随机基线       承重召回 ${(100*rec/Math.max(1,load)).toFixed(1)}%`)
