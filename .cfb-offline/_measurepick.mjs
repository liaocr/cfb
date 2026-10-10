
import fs from 'node:fs';
import { judge, splitSentences, anchorsWithPos, anchorsOf, norm } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const pool = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) pool.push(o); if(pool.length>=40) break; }
function lnds(arr){const t=[];for(const x of arr){let lo=0,hi=t.length;while(lo<hi){const m=(lo+hi)>>1;if(t[m]<=x)lo=m+1;else hi=m;}t[lo]=x;}return t.length;}
function tau(p){let c=0,d=0;for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){if(p[i]<p[j])c++;else if(p[i]>p[j])d++;}const n=p.length*(p.length-1)/2;return n?(c-d)/n:1;}
function anchorPos(raw,draft){const nr=norm(raw);const seen=new Set();const pos=[];
  for(const {a} of anchorsWithPos(draft)){if(seen.has(a))continue;seen.add(a);const at=nr.indexOf(a);if(at>=0)pos.push(at);}return pos;}
function centers(raw,draft){const nr=norm(raw);const out=[];
  for(const s of splitSentences(draft)){const a=anchorsOf(s).map(x=>nr.indexOf(x)).filter(i=>i>=0);
    if(a.length)out.push(a.reduce((x,y)=>x+y,0)/a.length);}return out;}
const orderMeasures = {
  'A 锚点位置LNDS': (raw,d)=>{const p=anchorPos(raw,d);return p.length<3?1:lnds(p)/p.length;},
  'C 句质心LNDS':   (raw,d)=>{const p=centers(raw,d);return p.length<3?1:lnds(p)/p.length;},
  'D 句质心tau':    (raw,d)=>{const p=centers(raw,d);return p.length<3?1:(tau(p)+1)/2;},
  'E 锚点tau':      (raw,d)=>{const p=anchorPos(raw,d);return p.length<3?1:(tau(p)+1)/2;},
};
// 决策句覆盖率
const DECISION_RX = /如果|那么|一旦|否则|万一|下一步|然后|接着|首先|其次|最后|先[^，。]{0,12}再|\bif\b|\bthen\b|\botherwise\b|\bunless\b|\bnext\b|\bfirst\b|\bfinally\b/i;
function ngramCov(sentence, draft, n){const s=norm(sentence),d=norm(draft);
  if(!s)return 1; if(s.length<=n)return d.includes(s)?1:0;
  let hit=0,tot=0; for(let i=0;i+n<=s.length;i++){tot++;if(d.includes(s.slice(i,i+n)))hit++;}
  return tot?hit/tot:1;}
function decCov(raw,draft,n){const sents=splitSentences(norm(raw)).filter(s=>DECISION_RX.test(s));
  if(!sents.length)return 1; return sents.reduce((a,s)=>a+ngramCov(s,draft,n),0)/sents.length;}
const decMeasures = {};
for (const n of [4,6,8,12]) decMeasures['F 决策句'+n+'-gram'] = (raw,d)=>decCov(raw,d,n);
// 对照：现有 S3 的做法（锚点保留率）
const ACTION_RX = /\b(fix|fixes|use|uses|should|instead|replace|revert|set|change|drop|remove|edit|must|prefer|correct|minimal)\b|改|修|换成|删|落点|应该/;
decMeasures['S3现状 锚点保留'] = (raw,draft)=>{
  const nr=norm(raw); const acts=splitSentences(nr).filter(s=>ACTION_RX.test(s));
  if(!acts.length) return 1;
  return acts.reduce((a,s)=>{const an=anchorsOf(s); if(!an.length)return a+1;
    return a + an.filter(x=>norm(draft).includes(x)).length/an.length;},0)/acts.length;};

const levels = {
  'L0': d=>d,
  'L1': d=>{const s=splitSentences(d);return s.slice(0,Math.max(1,Math.floor(s.length*0.75))).join('');},
  'L2': d=>{const s=splitSentences(d);return s.slice(0,Math.max(1,Math.floor(s.length*0.5))).join('');},
  'L4': d=>{const s=splitSentences(d);for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;}return s.join('');},
};
const lvNames = Object.keys(levels);
function run(measures, label, pairs) {
  const vals={}; for(const m of Object.keys(measures)){vals[m]={};for(const lv of lvNames)vals[m][lv]=[];}
  for(const o of pool) for(const lv of lvNames){const d=levels[lv](o.draft);
    for(const m of Object.keys(measures)) vals[m][lv].push(measures[m](o.raw,d));}
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  function auc(a,b){let w=0,t=0;for(const x of a)for(const y of b){t++;if(x>y)w++;else if(x===y)w+=0.5;}return w/t;}
  console.log('\n=== '+label+' ===');
  console.log('度量'.padEnd(22)+'L0'.padEnd(8)+'L1'.padEnd(8)+'L2'.padEnd(8)+'L4'.padEnd(8)+pairs.map(p=>('AUC '+p).padEnd(11)).join(''));
  for(const m of Object.keys(measures)){
    const v=vals[m];
    console.log(m.padEnd(20)+lvNames.map(lv=>avg(v[lv]).toFixed(3).padEnd(8)).join('')
      +pairs.map(p=>auc(v[p[0]],v[p[1]]).toFixed(3).padEnd(11)).join(''));
  }
}
run(orderMeasures, '顺序度量', [['L0','L4']]);
run(decMeasures, '决策保留度量', [['L0','L1'],['L0','L2']]);
// 决策句占比
let ds=0, all=0; for(const o of pool){const s=splitSentences(norm(o.raw)); all+=s.length; ds+=s.filter(x=>DECISION_RX.test(x)).length;}
console.log('\nraw 里决策句占比 '+(ds/all*100).toFixed(1)+'% ('+ds+'/'+all+')');
