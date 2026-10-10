
import fs from 'node:fs';
import { judge, splitSentences, norm } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const pool = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) pool.push(o); if(pool.length>=40) break; }
const MK = /如果|那么|一旦|否则|万一|下一步|然后|接着|首先|其次|最后|先[^，。]{0,10}再|\bif\b|\bthen\b|\botherwise\b|\bunless\b|\bnext\b|\bfirst\b|\bfinally\b|\bcase\b/gi;
const cnt = s => (norm(s).match(MK)||[]).length;
function auc(a,b){let w=0,t=0;for(const x of a)for(const y of b){t++;if(x>y)w++;else if(x===y)w+=0.5;}return w/t;}
const levels = {
  'L0': d=>d,
  'L1': d=>{const s=splitSentences(d);return s.slice(0,Math.max(1,Math.floor(s.length*0.75))).join('');},
  'L2': d=>{const s=splitSentences(d);return s.slice(0,Math.max(1,Math.floor(s.length*0.5))).join('');},
  'L4': d=>{const s=splitSentences(d);for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;}return s.join('');},
};
const M = {
  '决策标记数':        (raw,d)=>cnt(d),
  '决策标记密度/百字':  (raw,d)=>{const n=norm(d).length;return n? cnt(d)/n*100 : 0;},
  '稿/raw 标记数比':    (raw,d)=>cnt(raw)? cnt(d)/cnt(raw) : 1,
  '稿标记密度/raw密度': (raw,d)=>{const nr=norm(raw).length, nd=norm(d).length;
      if(!nr||!nd)return 1; const dr=cnt(raw)/nr, dd=cnt(d)/nd; return dr? Math.min(1, dd/dr) : 1;},
};
const vals={}; for(const m of Object.keys(M)){vals[m]={};for(const lv of Object.keys(levels))vals[m][lv]=[];}
for(const o of pool) for(const lv of Object.keys(levels)){const d=levels[lv](o.draft);
  for(const m of Object.keys(M)) vals[m][lv].push(M[m](o.raw,d));}
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
console.log('度量'.padEnd(24)+Object.keys(levels).map(l=>l.padEnd(9)).join('')+'AUC L0vsL1'.padEnd(13)+'AUC L0vsL2');
for(const m of Object.keys(M)){const v=vals[m];
  console.log(m.padEnd(22)+Object.keys(levels).map(l=>avg(v[l]).toFixed(3).padEnd(9)).join('')
    +auc(v.L0,v.L1).toFixed(3).padEnd(13)+auc(v.L0,v.L2).toFixed(3));}
console.log('\nraw 决策标记数均值 '+avg(pool.map(o=>cnt(o.raw))).toFixed(1)+' · 稿 '+avg(pool.map(o=>cnt(o.draft))).toFixed(1));
