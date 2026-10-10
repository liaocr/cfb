
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const f100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const byId = new Map(full.map(o=>[o.id,o]));

let n=0, exact=0, passBoth=0, failBoth=0, flipP2F=0, flipF2P=0;
let sameLang=0;
const softD=[], lenRatio=[], charD=[];
const flips=[];
for (const a of f100) {
  const b = byId.get(a.id); if (!b) continue;
  n++;
  const d1 = (a.draft||'').trim(), d2 = (b.draft||'').trim();
  if (d1 === d2) exact++;
  const j1 = judge({raw:a.raw, ctx:a.ctx, draft:d1});
  const j2 = judge({raw:b.raw, ctx:b.ctx, draft:d2});
  const p1 = j1.gaugeable && j1.pass, p2 = j2.gaugeable && j2.pass;
  if (p1 && p2) passBoth++; else if (!p1 && !p2) failBoth++;
  else if (p1 && !p2) { flipP2F++; if(flips.length<6) flips.push({id:a.id, dir:'过->不过', s1:+j1.score.toFixed(3), s2:+j2.score.toFixed(3), f1:j1.failed, f2:j2.failed}); }
  else { flipF2P++; if(flips.length<6) flips.push({id:a.id, dir:'不过->过', s1:+j1.score.toFixed(3), s2:+j2.score.toFixed(3), f1:j1.failed, f2:j2.failed}); }
  if (j1.gaugeable && j2.gaugeable) { softD.push(Math.abs(j1.score-j2.score)); }
  lenRatio.push(Math.min(d1.length,d2.length)/Math.max(1,Math.max(d1.length,d2.length)));
  charD.push(Math.abs(d1.length-d2.length));
  // 语言
  const zh = s => (s.match(/[\u4e00-\u9fff]/g)||[]).length;
  const zh1 = zh(d1)/(d1.length||1), zh2 = zh(d2)/(d2.length||1);
  if ((zh1>0.15) === (zh2>0.15)) sameLang++;
}
const q = (arr,p)=>{const s=[...arr].sort((x,y)=>x-y);return s[Math.floor(s.length*p)]??0};
const avg = a => a.reduce((x,y)=>x+y,0)/Math.max(1,a.length);
console.log(JSON.stringify({
  配对单元: n,
  逐字完全相同: exact,
  逐字相同率: +(exact/n).toFixed(3),
  两次都过门: passBoth,
  两次都不过: failBoth,
  过门结果翻转: flipP2F+flipF2P,
  翻转率: +((flipP2F+flipF2P)/n).toFixed(3),
  '过->不过': flipP2F,
  '不过->过': flipF2P,
  语言判定一致: sameLang,
  语言一致率: +(sameLang/n).toFixed(3),
  软分差_均值: +avg(softD).toFixed(4),
  软分差_p50: +q(softD,.5).toFixed(4),
  软分差_p90: +q(softD,.9).toFixed(4),
  长度相似度_p50: +q(lenRatio,.5).toFixed(3),
  长度相似度_p10: +q(lenRatio,.1).toFixed(3),
  字数差_p50: q(charD,.5),
  字数差_p90: q(charD,.9),
}, null, 1));
console.log(JSON.stringify(flips, null, 1));
