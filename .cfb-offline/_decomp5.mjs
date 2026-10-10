
import fs from 'node:fs';
import { judge, splitSentences } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const base = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) base.push(o); if(base.length>=60) break; }
const levels = {
  'L0 原稿': d=>d,
  'L1 去末25%': d=>{const s=splitSentences(d);return s.slice(0,Math.max(1,Math.floor(s.length*0.75))).join('');},
  'L4 打乱': d=>{const s=splitSentences(d);for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;}return s.join('');},
};
const names=Object.keys(levels);
const subKeys=Object.keys(judge({raw:base[0].raw,ctx:base[0].ctx,draft:base[0].draft}).sub);
const W={S1:0.28,S2:0.18,S3:0.18,S4:0.13,S5:0.13,S6:0.10,S7:0.15};
const agg={}; for(const n of names){agg[n]={};for(const k of subKeys)agg[n][k]=[];agg[n].score=[];agg[n].tok=[];}
for(const o of base) for(const n of names){const d=levels[n](o.draft);
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d});
  for(const k of subKeys) agg[n][k].push(j.sub[k]??0);
  agg[n].score.push(j.score); agg[n].tok.push(j.detail.compression.tokenRatio);}
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
console.log('档'.padEnd(13)+subKeys.map(k=>k.split('_')[0].padEnd(7)).join('')+'tokR'.padEnd(8)+'总分');
for(const n of names){const a=agg[n];
  console.log(n.padEnd(11)+subKeys.map(k=>avg(a[k]).toFixed(3).padEnd(7)).join('')
    +avg(a.tok).toFixed(3).padEnd(8)+avg(a.score).toFixed(4));}
console.log('\nL1 - L0 的逐项贡献（权重 x 差 / 1.15）：');
const WSUM=Object.values(W).reduce((a,b)=>a+b,0);
let tot=0;
for(const k of subKeys){const key=k.split('_')[0];
  const d=avg(agg['L1 去末25%'][k])-avg(agg['L0 原稿'][k]);
  const c=d*W[key]/WSUM; tot+=c;
  console.log('  '+k.padEnd(22)+d.toFixed(4).padStart(9)+'  x'+String(W[key]).padEnd(6)+'= '+c.toFixed(5));}
console.log('  合计 '+tot.toFixed(5)+'  （实测总分差 '+(avg(agg['L1 去末25%'].score)-avg(agg['L0 原稿'].score)).toFixed(5)+'）');
