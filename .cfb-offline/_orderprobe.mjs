
import fs from 'node:fs';
import { judge, splitSentences, anchorsWithPos, anchorsOf, norm } from '../tools/gen-ruler.mjs';
const base = (p) => { const q = String(p).replace(/[/\\]+$/, ''); const s = q.split('/'); return s[s.length-1] || q; };
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const pool = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) pool.push(o); if(pool.length>=40) break; }

function lnds(arr) { const tails = [];
  for (const x of arr) { let lo=0, hi=tails.length;
    while (lo<hi) { const m=(lo+hi)>>1; if (tails[m]<=x) lo=m+1; else hi=m; }
    tails[lo]=x; } return tails.length; }
function orderA(raw, draft) {
  const nraw = norm(raw); const seen=new Set(); const pos=[];
  for (const { a } of anchorsWithPos(draft)) { if (seen.has(a)) continue; seen.add(a);
    let at = nraw.indexOf(a);
    if (at<0 && a.includes('/')) { const b=base(a); if(b) at=nraw.indexOf(b); }
    if (at>=0) pos.push(at); }
  if (pos.length<3) return 1;
  return lnds(pos)/pos.length;
}
function orderB(raw, draft) {
  const nraw = norm(raw); const sk=[];
  for (const s of splitSentences(nraw)) { const a=anchorsOf(s); if(a.length) sk.push(a[0]); }
  const nd = norm(draft);
  const hits = sk.map(a=>nd.indexOf(a)).filter(i=>i>=0);
  if (hits.length<3) return 1;
  return lnds(hits)/hits.length;
}
const levels = {
  'L0 原稿': d => d,
  'L1 去末25%句': d => { const s=splitSentences(d); return s.slice(0,Math.max(1,Math.floor(s.length*0.75))).join(''); },
  'L2 去后一半': d => { const s=splitSentences(d); return s.slice(0,Math.max(1,Math.floor(s.length*0.5))).join(''); },
  'L4 打乱句序': d => { const s=splitSentences(d); for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;} return s.join(''); },
  'L7 只留末句': d => { const s=splitSentences(d); return s[s.length-1]||''; },
};
const names = Object.keys(levels);
const subKeys = Object.keys(judge({raw:pool[0].raw,ctx:pool[0].ctx,draft:pool[0].draft}).sub);
const agg = {}; for (const n of names) { agg[n]={}; for(const k of subKeys) agg[n][k]=[]; agg[n].A=[]; agg[n].B=[]; agg[n].soft=[]; }
for (const o of pool) for (const n of names) {
  const d = levels[n](o.draft);
  const j = judge({raw:o.raw, ctx:o.ctx, draft:d});
  for (const k of subKeys) agg[n][k].push(j.sub[k] ?? 0);
  agg[n].A.push(orderA(o.raw, d)); agg[n].B.push(orderB(o.raw, d)); agg[n].soft.push(j.score);
}
const avg = a => a.reduce((x,y)=>x+y,0)/a.length;
console.log('档'.padEnd(15) + subKeys.map(k=>k.split('_')[0].padEnd(7)).join('') + '软分'.padEnd(8) + '顺序A'.padEnd(8) + '顺序B');
for (const n of names) {
  const a = agg[n];
  console.log(n.padEnd(13) + subKeys.map(k=>avg(a[k]).toFixed(3).padEnd(7)).join('')
    + avg(a.soft).toFixed(4).padEnd(8) + avg(a.A).toFixed(3).padEnd(8) + avg(a.B).toFixed(3));
}
console.log('\n顺序A = 稿中锚点在 raw 中位置的非降率(LNDS)；顺序B = raw 动作句骨架在稿中同序率');
