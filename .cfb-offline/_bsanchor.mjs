
import fs from 'node:fs';
import { judge, anchorsOf, loadAnchors, hasAnchor, retention, ANCHOR_FLOOR } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));
const full = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));

// 反斜杠碎片：含 \ 但不含 / 或 . —— Windows 路径中段，几乎不可能被逐字复现，且不是「标识符」
const isBs = a => /\\/.test(a) && !/[/.]/.test(a);
// 这些锚点在整个语料里出现几次？只报一次的就是噪声
const cnt = {};
for (const o of full) for (const a of anchorsOf(o.raw+'\n'+o.ctx)) if (isBs(a)) cnt[a]=(cnt[a]||0)+1;
const top = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
console.log('反斜杠碎片锚点种类:', top.length, '总出现次数:', top.reduce((s,[,v])=>s+v,0));
console.log('样例:', JSON.stringify(top.slice(0,12)));

// 影响面：从承重集里剔掉这些碎片后，dev 教师/学生 与 722 教师 的 G3 判定变化
function judgeClean(raw, ctx, draft) {
  const j = judge({raw, ctx, draft});
  // 复算 G3：把反斜杠碎片从承重集里去掉
  const load = loadAnchors(raw, ctx).filter(a=>!isBs(a));
  const loadPaths = load.filter(a=>/\w\.\w/.test(a)||a.includes('/'));
  const loadIds = load.filter(a=>!(/\w\.\w/.test(a)||a.includes('/')));
  const lostPaths = loadPaths.filter(a=>!hasAnchor(draft, a));
  const ret = retention(loadIds, draft);
  const g3 = lostPaths.length>0 || (loadIds.length>=1 && ret < ANCHOR_FLOOR);
  const failed = j.failed.filter(f=>f!=='G3 anchors-kept');
  if (g3) failed.push('G3 anchors-kept');
  return {pass: failed.length===0, failed, g3was: j.failed.includes('G3 anchors-kept')};
}
let chgT=0, chgS=0, chgFull=0, changed=[];
for (const d of dev) {
  const t = judgeClean(d.raw, d.ctx, d.assistant);
  const s0 = (gById.get(d.id)||{}).draft||'';
  const gg = guardDraft(d.raw, d.ctx, s0, {mode:'strip'});
  const s = judgeClean(d.raw, d.ctx, gg.draft);
  if (t.g3was !== t.failed.includes('G3 anchors-kept')) { chgT++; changed.push(['dev-teacher', d.id, t.g3was, t.failed.includes('G3 anchors-kept')]); }
  if (s.g3was !== s.failed.includes('G3 anchors-kept')) { chgS++; changed.push(['dev-student', d.id, s.g3was, s.failed.includes('G3 anchors-kept')]); }
}
for (const o of full) {
  if (!o.draft || !o.draft.trim()) continue;
  const t = judgeClean(o.raw, o.ctx, o.draft);
  if (t.g3was !== t.failed.includes('G3 anchors-kept')) chgFull++;
}
console.log(JSON.stringify({devTeacherChanged: chgT, devStudentChanged: chgS, full722TeacherChanged: chgFull}, null, 1));
console.log(JSON.stringify(changed.slice(0,10)));
