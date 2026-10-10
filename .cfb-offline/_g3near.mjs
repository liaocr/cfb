
import fs from 'node:fs';
import { judge, norm, anchorsOf, hasAnchor, loadAnchors } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));

// 对每条 G3 失败的稿：丢失的承重标识符，在稿子里有没有「近似串」？
// 近似 = 稿子里某个锚点 b，满足 b!==a 且 (b.includes(a) || a.includes(b))，或编辑距离小。
const lev = (x,y) => {
  const m=x.length,n=y.length; if(!m)return n; if(!n)return m;
  let prev=Array.from({length:n+1},(_,j)=>j);
  for(let i=1;i<=m;i++){ const cur=[i]; for(let j=1;j<=n;j++){
    cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(x[i-1]===y[j-1]?0:1)); } prev=cur; }
  return prev[n];
};

let rows=0, lostTotal=0, nearInDraft=0, closeLev=0, absent=0;
const cases=[];
for (const d of dev) {
  const s0 = (gById.get(d.id)||{}).draft||'';
  const g = guardDraft(d.raw, d.ctx, s0, {mode:'strip'});
  const j = judge({raw:d.raw, ctx:d.ctx, draft:g.draft});
  if (!j.gaugeable || !j.failed.includes('G3 anchors-kept')) continue;
  rows++;
  const load = loadAnchors(d.raw, d.ctx);
  const loadIds = load.filter(a=>!(/\w\.\w/.test(a)||a.includes('/')));
  const draftAnchors = anchorsOf(g.draft);
  const lost = loadIds.filter(a=>!hasAnchor(g.draft,a));
  lostTotal += lost.length;
  for (const a of lost) {
    const near = draftAnchors.filter(b=>b!==a && (b.includes(a)||a.includes(b)));
    if (near.length) nearInDraft++;
    else {
      const close = draftAnchors.filter(b=>lev(b.toLowerCase(), a.toLowerCase()) <= Math.max(1, Math.floor(a.length*0.34)));
      if (close.length) closeLev++; else absent++;
    }
  }
  if (cases.length<10) cases.push({id:d.id, loadIds, lost:lost.slice(0,3),
    draftAnchors: draftAnchors.slice(0,10), draftHead: g.draft.slice(0,160).replace(/\n/g,' ')});
}
console.log(JSON.stringify({rows, lostTotal, nearInDraft, closeLev, absent}, null, 1));
console.log(JSON.stringify(cases, null, 1));
