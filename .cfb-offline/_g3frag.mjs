
import fs from 'node:fs';
import { judge, norm, anchorsOf, hasAnchor, loadAnchors, retention, ANCHOR_FLOOR } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));

// 「碎片锚点」：它是 raw∪ctx 里另一个更长锚点的真子串。
// 保住长的那条 ⇒ 短的那条自动命中（hasAnchor 用的就是 includes）。
// 所以碎片不进承重集也不丢信息，只会把保留率的分母灌水、把 G3 弄脏。
const isFragment = (a, all) => all.some(b => b !== a && b.includes(a));
// 「不可匹配锚点」：含反斜杠的碎片（Windows 路径中段），几乎不可能被稿子逐字复现
const isUnmatchable = (a) => /\\/.test(a) && !/[/.]/.test(a);

let rows=0, stillFail=0, onlyFrag=0, onlyUnmatch=0;
let fragAnchorsTotal=0, unmatchTotal=0, loadTotal=0;
const examples=[];
for (const d of dev) {
  const s0 = (gById.get(d.id)||{}).draft||'';
  const g = guardDraft(d.raw, d.ctx, s0, {mode:'strip'});
  const j = judge({raw:d.raw, ctx:d.ctx, draft:g.draft});
  if (!j.gaugeable || !j.failed.includes('G3 anchors-kept')) continue;
  rows++;
  const all = anchorsOf(d.raw+'\n'+d.ctx);
  const load = loadAnchors(d.raw, d.ctx);
  const loadIds = load.filter(a=>!(/\w\.\w/.test(a)||a.includes('/')));
  const lost = loadIds.filter(a=>!hasAnchor(g.draft,a));
  const lostFrag = lost.filter(a=>isFragment(a, all));
  const lostUnmatch = lost.filter(a=>isUnmatchable(a));
  const lostReal = lost.filter(a=>!isFragment(a,all) && !isUnmatchable(a));
  loadTotal += loadIds.length;
  fragAnchorsTotal += lostFrag.length;
  unmatchTotal += lostUnmatch.length;
  if (!lostReal.length && lost.length) { onlyFrag++; if(examples.length<6) examples.push({id:d.id, loadIds, lost, lostFrag, lostUnmatch, idRet:+retention(loadIds,g.draft).toFixed(2)}); }
  // 去掉碎片/不可匹配之后还丢吗？
  const kept = loadIds.filter(a=>!isFragment(a,all) && !isUnmatchable(a));
  const ret2 = kept.length ? kept.filter(a=>hasAnchor(g.draft,a)).length/kept.length : 1;
  if (kept.length && ret2 < ANCHOR_FLOOR) stillFail++;
  else if (kept.length===0) stillFail++;
}
console.log(JSON.stringify({
  有受力点的G3失败行: rows,
  承重标识符总数: loadTotal,
  其中丢失: fragAnchorsTotal+unmatchTotal,
  丢失的碎片锚点: fragAnchorsTotal,
  丢失的不可匹配锚点: unmatchTotal,
  仅因碎片/不可匹配而判失败: onlyFrag,
  清洗后仍失败: stillFail,
  清洗后不再失败: rows-stillFail,
}, null, 1));
console.log(JSON.stringify(examples, null, 1));
