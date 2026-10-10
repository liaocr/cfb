
import fs from 'node:fs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const devRows = rd('.cfb-offline/sft/dev.jsonl');
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const v9  = rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl');

const HEDGE = '落点原文未定';
function countHedge(rows, key) {
  let n = 0;
  for (const r of rows) if (String(r[key] || '').includes(HEDGE)) n++;
  return n;
}
console.log('=== 「' + HEDGE + '」的出现次数 ===');
console.log('  教师 dev 89 条      :', countHedge(devRows, 'assistant'));
console.log('  v9  学生 89 条      :', countHedge(v9, 'draft'));
console.log('  v10 学生 89 条      :', countHedge(v10, 'draft'));

const trainRows = rd('.cfb-offline/sft/train.jsonl');
console.log('  教师 train 1461 条  :', countHedge(trainRows, 'assistant'));
console.log('  教师 train 占比     :', (100 * countHedge(trainRows, 'assistant') / trainRows.length).toFixed(1) + '%');
console.log('  v10 学生占比        :', (100 * countHedge(v10, 'draft') / v10.length).toFixed(1) + '%');

const N = 10;
const grams = (t) => { const s = String(t).replace(/\s+/g, ''); const o = new Set();
  for (let i = 0; i + N <= s.length; i++) o.add(s.slice(i, i + N)); return o; };
const jac = (a, b) => { if (!a.size || !b.size) return null;
  let i = 0; for (const g of a) if (b.has(g)) i++; return i / (a.size + b.size - i); };

console.log('');
console.log('=== 天花板：教师对同一输入采样两次，两次之间有多像？ ===');
const CAND = ['.cfb-offline/teacher/v4-100.jsonl', '.cfb-offline/teacher/v4-30.jsonl',
              '.cfb-offline/teacher/v4-full.jsonl', '.cfb-offline/teacher/v4-extra-434.jsonl'];
const files = CAND.filter((f) => fs.existsSync(f));
console.log('  可用文件:', files.join(' '));
const sets = {};
for (const f of files) { const rows = rd(f); const m = new Map();
  for (const r of rows) m.set(r.id, r); sets[f] = m; console.log('   ', f, rows.length, '条'); }
if (sets['.cfb-offline/teacher/v4-100.jsonl'] && sets['.cfb-offline/teacher/v4-full.jsonl']) {
  const a = sets['.cfb-offline/teacher/v4-100.jsonl'], b = sets['.cfb-offline/teacher/v4-full.jsonl'];
  const js = [];
  for (const [id, r] of a) { const q = b.get(id); if (!q) continue;
    const v = jac(grams(r.assistant), grams(q.assistant)); if (v !== null) js.push(v); }
  js.sort((x, y) => x - y);
  console.log('  教师 vs 教师（同输入两次采样）p50 =', js[Math.floor(js.length / 2)].toFixed(3),
              ' p10 =', js[Math.floor(js.length * 0.1)].toFixed(3), ' n =', js.length);
}
const devById = new Map(devRows.map((d) => [d.id, d]));
for (const pair of [['v9', v9], ['v10', v10]]) {
  const js = [];
  for (const r of pair[1]) { const d = devById.get(r.id); if (!d) continue;
    const v = jac(grams(r.draft), grams(d.assistant)); if (v !== null) js.push(v); }
  js.sort((x, y) => x - y);
  console.log('  ' + pair[0] + ' vs 教师 p50 =', js[Math.floor(js.length / 2)].toFixed(3),
              ' p90 =', js[Math.floor(js.length * 0.9)].toFixed(3));
}
