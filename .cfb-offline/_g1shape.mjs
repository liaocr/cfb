
import fs from 'node:fs';
import { anchorsOf, hasAnchor, norm, quoteSpans } from '../tools/gen-ruler.mjs';
import { g1Spans } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));
const full = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));

// 「标识符形状」：含下划线/点/斜杠/驼峰，或全大写，或长度>=3 且无空格
const isIdentShaped = (a) => {
  if (/\s/.test(a)) return false;                       // 含空格 => 散文片段
  if (/[\/._\\]/.test(a)) return true;                  // 路径/模块/点号
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(a)) return true;      // ALL_CAPS
  if (/[a-z][A-Z]/.test(a)) return true;                // camelCase
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) return true;  // 单个词（英文标识符）
  if (/[\u4e00-\u9fff]/.test(a)) return false;          // 中文散文
  return false;
};

function classify(rows, getDraft, label) {
  let rowsHit=0, total=0, ident=0, prose=0;
  const proseEx=[], identEx=[];
  for (const o of rows) {
    const draft = getDraft(o); if (!draft || !draft.trim()) continue;
    const g = g1Spans(o.raw, o.ctx, draft);
    if (!g.detected.length) continue;
    rowsHit++;
    for (const h of g.detected) for (const a of h.invented) {
      total++;
      if (isIdentShaped(a)) { ident++; if(identEx.length<8) identEx.push(a); }
      else { prose++; if(proseEx.length<8) proseEx.push(a); }
    }
  }
  console.log('== ' + label + ' ==');
  console.log(JSON.stringify({rowsHit, anchors: total, identShaped: ident, proseShaped: prose,
    proseShare: total? +(prose/total).toFixed(3):0}, null, 1));
  console.log('  prose 例:', JSON.stringify(proseEx));
  console.log('  ident 例:', JSON.stringify(identEx));
  return {rowsHit, total, ident, prose};
}

classify(dev, o=>o.assistant, 'dev 教师稿');
classify(dev.map(o=>({...o, _d:(gById.get(o.id)||{}).draft||''})), o=>o._d, 'dev 学生稿');
classify(full, o=>o.draft, '722 教师稿');
