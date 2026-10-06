import fs from 'node:fs'
import { scoreUnitWithWeights, selectOpsV5, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'
const repo='/home/user/cfb'
const ds=JSON.parse(fs.readFileSync(`${repo}/transfer/models/micro-dev-dataset.json`,'utf8'))
const fam=v=>String(v||'').replace(/^pool:/,'').split(':',1)[0]
const byDoc=new Map()
for (const u of ds.unitSamples){const k=`${fam(u.family)}|${u.sourceId}`;if(!byDoc.has(k))byDoc.set(k,{f:fam(u.family),units:[]});byDoc.get(k).units.push(u)}
const hits=u=>{const o=u.labelAudit?.overlap||{};let n=0;for(const k of ['DECIDED','EXCLUDED','ACCEPT','OPEN'])n+=(o[k]?.matchedAnchors||[]).length;return n}
const DEFS={
  'A 金标锚点≥1': u=>hits(u)>0,
  'B 规则价值yVal≥0.75': u=>(u.yVal??0)>=0.75,
  'C 锚点≥1 且 yVal≥0.75': u=>hits(u)>0&&(u.yVal??0)>=0.75,
}
let rng=12345; const rnd=()=>((rng=(rng*1103515245+12345)&0x7fffffff)/0x7fffffff)
for (const [dn,isLoad] of Object.entries(DEFS)) {
  let load=0,recSel=0,recTop=0,recRnd=0,pick=0,noise=0,docs=0
  for (const [k,d] of byDoc) {
    const U=d.units; if (U.length<4) continue
    const L=U.map((u,i)=>isLoad(u)?i:-1).filter(i=>i>=0); if(!L.length) continue
    docs++; load+=L.length
    const chars=U.reduce((s,u)=>s+String(u.text||'').length,0)
    const charBudget=Math.max(700,Math.min(1700,Math.round(chars*0.30)))
    const feats=U.map(u=>({vec:u.features,tok:u.tokenCount,temptationT:u.temptationT??u.features[9],cueExcluded:u.features[15],ids:new Set()}))
    const scores=feats.map(f=>scoreUnitWithWeights(f,V5_MICRO_WEIGHTS))
    // 选材：与真实渲染同口径（字符预算内填充）
    const chosen=selectOpsV5(U.map(u=>u.text),feats,scores,V5_MICRO_WEIGHTS,24)
    let used=0; const sel=[]
    for (const c of chosen){const len=String(c.text||'').length; if(used+len>charBudget && sel.length) break; sel.push(U.findIndex(u=>u.text===c.text)); used+=len}
    for (const i of sel){pick++; if(isLoad(U[i]))recSel++; if((U[i].yVal??1)<=0.10)noise++}
    const top=[...scores.keys()].sort((a,b)=>scores[b].v-scores[a].v); let u2=0
    for (const i of top){const len=String(U[i].text||'').length; if(u2+len>charBudget&&u2>0)break; if(isLoad(U[i]))recTop++; u2+=len}
    const selR=new Set(); let u3=0
    while(u3<charBudget){const i=Math.floor(rnd()*U.length); if(selR.has(i))continue; selR.add(i); u3+=String(U[i].text||'').length; if(isLoad(U[i]))recRnd++}
  }
  const p=x=>(100*x).toFixed(1)
  console.log(`${dn.padEnd(22)} 文档${docs} 承重${load} | selectOpsV5 召回 ${p(recSel/load)}% (选${pick}, 噪声注入 ${p(noise/Math.max(1,pick))}%) | 纯v排序 ${p(recTop/load)}% | 随机 ${p(recRnd/load)}%`)
}
