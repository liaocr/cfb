
import fs from 'node:fs';
import { judge, quotedFragments, anchorsOf, hasAnchor, norm } from '../tools/gen-ruler.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const evj = JSON.parse(fs.readFileSync('.cfb-offline/kaggle-out/eval-sft.json','utf8'));
const byId = new Map(evj.rows.map(r=>[r.id,r]));

const cases = [];
let totalInv = 0, nearMiss = 0, noNear = 0, rowsWithFrag = 0;
const examples = [];
for (const d of dev) {
  const e = byId.get(d.id); if (!e) continue;
  const j = judge({raw:d.raw, ctx:d.ctx, draft:e.studentDraft});
  if (!j.failed.includes('G1 quote-grounded')) continue;
  const ev = norm(d.raw + '\n' + d.ctx);
  const rawAnchors = anchorsOf(d.raw + '\n' + d.ctx);
  const frags = quotedFragments(e.studentDraft).filter(f=>f.length>=4);
  const inv = [];
  for (const f of frags) for (const a of anchorsOf(f)) if (!hasAnchor(ev, a)) inv.push({a, frag:f.slice(0,70)});
  if (inv.length) rowsWithFrag++;
  for (const it of inv) {
    totalInv++;
    const near = rawAnchors.some(b => b !== it.a && (b.includes(it.a) || it.a.includes(b)));
    if (near) nearMiss++; else noNear++;
  }
  if (examples.length < 12) examples.push({id:d.id, nInv: inv.length, inv: inv.slice(0,3)});
}
fs.writeFileSync('.cfb-offline/_g1.json', JSON.stringify({g1Rows: rowsWithFrag, totalInv, nearMiss, noNear, examples}, null, 1));
console.log('ok');
