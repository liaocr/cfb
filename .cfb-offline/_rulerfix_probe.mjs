
import fs from 'node:fs';
import { judge, splitSentences, anchorsWithPos, anchorsOf, norm } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const pool = [];
for (const o of full) { const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d}); if(j.gaugeable&&j.pass) pool.push(o); if(pool.length>=40) break; }

// L1 删掉的是什么？看被删句子的锚点数与长度
let delSents=0, delAnchors=0, delChars=0, keepSents=0, keepAnchors=0, keepChars=0;
const samples=[];
for (const o of pool) {
  const s = splitSentences(o.draft);
  const cut = Math.max(1, Math.floor(s.length*0.75));
  const kept = s.slice(0,cut), gone = s.slice(cut);
  keepSents += kept.length; delSents += gone.length;
  keepAnchors += kept.reduce((a,x)=>a+anchorsOf(x).length,0);
  delAnchors  += gone.reduce((a,x)=>a+anchorsOf(x).length,0);
  keepChars += kept.join('').length; delChars += gone.join('').length;
  if (samples.length<3 && gone.length) samples.push({id:o.id, nSent:s.length, gone:gone.slice(0,4).map(x=>x.slice(0,110))});
}
console.log('L1 删掉的句子: '+delSents+' 句 / 保留 '+keepSents+' 句');
console.log('删掉的字数占比: '+(delChars/(delChars+keepChars)*100).toFixed(1)+'%');
console.log('删掉的锚点占比: '+(delAnchors/(delAnchors+keepAnchors)*100).toFixed(1)+'%  ('+delAnchors+'/'+(delAnchors+keepAnchors)+')');
console.log('每句锚点数: 保留 '+(keepAnchors/keepSents).toFixed(2)+' · 删掉 '+(delAnchors/Math.max(1,delSents)).toFixed(2));
console.log('\n被删掉的句子长什么样：');
console.log(JSON.stringify(samples, null, 1));

// ── 顺序度量候选：句级质心 ──
function lnds(arr){const t=[];for(const x of arr){let lo=0,hi=t.length;while(lo<hi){const m=(lo+hi)>>1;if(t[m]<=x)lo=m+1;else hi=m;}t[lo]=x;}return t.length;}
function centers(raw, draft) {
  const nraw = norm(raw); const out = [];
  for (const s of splitSentences(draft)) {
    const a = anchorsOf(s).map(x => nraw.indexOf(x)).filter(i => i >= 0);
    if (a.length) out.push(a.reduce((x,y)=>x+y,0)/a.length);
  }
  return out;
}
function tauVsIndex(p) { let c=0,d=0; for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){ if(p[i]<p[j])c++; else if(p[i]>p[j])d++; } const n=p.length*(p.length-1)/2; return n? (c-d)/n : 1; }
function anchorPos(raw,draft){const nraw=norm(raw);const seen=new Set();const pos=[];
  for(const {a} of anchorsWithPos(draft)){if(seen.has(a))continue;seen.add(a);const at=nraw.indexOf(a);if(at>=0)pos.push(at);}return pos;}
const measures = {
  'A 锚点位置LNDS': (raw,d)=>{const p=anchorPos(raw,d);return p.length<3?1:lnds(p)/p.length;},
  'C 句质心LNDS':   (raw,d)=>{const p=centers(raw,d);return p.length<3?1:lnds(p)/p.length;},
  'D 句质心tau':    (raw,d)=>{const p=centers(raw,d);return p.length<3?1:tauVsIndex(p);},
  'E 锚点tau':      (raw,d)=>{const p=anchorPos(raw,d);return p.length<3?1:tauVsIndex(p);},
};
const levels = {
  'L0 原稿': d=>d,
  'L4 打乱句序': d=>{const s=splitSentences(d);for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;}return s.join('');},
};
const vals = {}; for (const m of Object.keys(measures)) { vals[m]={L0:[],L4:[]}; }
for (const o of pool) for (const lv of Object.keys(levels)) {
  const d = levels[lv](o.draft);
  for (const m of Object.keys(measures)) vals[m][lv].push(measures[m](o.raw, d));
}
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
function auc(a,b){let w=0,t=0;for(const x of a)for(const y of b){t++;if(x>y)w++;else if(x===y)w+=0.5;}return w/t;}
console.log('\n顺序度量的判别力（L0 vs L4，AUC=0.5 等于瞎猜）：');
console.log('度量'.padEnd(20)+'L0'.padEnd(9)+'L4'.padEnd(9)+'差'.padEnd(9)+'AUC');
for (const m of Object.keys(measures)) {
  const a=avg(vals[m].L0), b=avg(vals[m].L4);
  console.log(m.padEnd(18)+a.toFixed(3).padEnd(9)+b.toFixed(3).padEnd(9)+(a-b).toFixed(3).padEnd(9)+auc(vals[m].L0,vals[m].L4).toFixed(3));
}
