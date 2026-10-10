
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

// 「孤儿片段」：被标点隔开、内容只剩连接词/助词的小句。
// 它是**删除式修复**留下的指纹：drop 把引号里的东西挖走，留下「是 ，」「和 这类」这种残骸。
// 正常文本里这种小句极少（中文会写「是……的」但不会写「是 ，」）。
const PART = '是的和与在把被对为了或而就也都还又再才即如若则由从向给让使以及跟同';
const ORPHAN_RX = new RegExp('(?:^|[，。；、：,;:!?！？\\s])\\s*[' + PART + ']?\\s*(?=[，。；、：,;:])', 'g');
const orphanCount = (t) => (String(t).match(ORPHAN_RX) || []).length;

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));
const rows = dev.map(d=>({d, s:(gById.get(d.id)||{}).draft||''}));

const modes=['off','strip','drop','sentence'];
console.log('mode     过门/73  软分    孤儿小句总数  有孤儿稿数  孤儿>=3稿数  空稿');
for (const mode of modes) {
  let pass=0, soft=[], orph=0, rowsOrph=0, bad=0, empty=0;
  for (const {d,s} of rows) {
    const g = guardDraft(d.raw,d.ctx,s,{mode});
    const j = judge({raw:d.raw,ctx:d.ctx,draft:g.draft});
    if (!j.gaugeable) continue;
    if (j.pass) pass++;
    soft.push(j.score);
    const o = orphanCount(g.draft);
    orph += o; if (o>0) rowsOrph++; if (o>=3) bad++;
    if (!g.draft) empty++;
  }
  const mean=a=>+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4);
  console.log(mode.padEnd(9), String(pass+'/73').padEnd(7), String(mean(soft)).padEnd(8), String(orph).padEnd(13), String(rowsOrph).padEnd(11), String(bad).padEnd(12), empty);
}
// 教师原稿做对照（教师稿没被改过，这是「正常文本」的孤儿基线）
let torph=0,trows=0;
for (const {d} of rows) { const o=orphanCount(d.assistant); torph+=o; if(o>0)trows++; }
console.log('教师原稿（对照）孤儿小句', torph, '有孤儿稿数', trows);
// raw 对照
let rorph=0;
for (const {d} of rows) rorph += orphanCount(d.raw);
console.log('raw 原文（对照）孤儿小句', rorph);
