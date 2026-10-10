
import fs from 'node:fs';
import { judge, splitSentences } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const base = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) base.push(o); if(base.length>=40) break; }

function sub(d,o){ const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); return j.sub||{}; }
const keys = Object.keys(sub(base[0].draft, base[0]));
console.log('软分项:', JSON.stringify(keys));
const acc = {}; for (const k of keys) acc[k]={L0:[],L4:[]};
for (const o of base) {
  const s=splitSentences(o.draft); 
  for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;}
  const a=sub(o.draft,o), b=sub(s.join(''),o);
  for (const k of keys) { acc[k].L0.push(a[k]??0); acc[k].L4.push(b[k]??0); }
}
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
console.log('');
console.log('软分项'.padEnd(22)+'原稿'.padEnd(11)+'打乱句序'.padEnd(11)+'差');
for (const k of keys) console.log(k.padEnd(20)+avg(acc[k].L0).toFixed(4).padEnd(11)+avg(acc[k].L4).toFixed(4).padEnd(11)+(avg(acc[k].L4)-avg(acc[k].L0)).toFixed(4));
