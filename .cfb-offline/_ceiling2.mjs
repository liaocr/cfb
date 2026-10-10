
import fs from 'node:fs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const N = 10;
const grams = (t) => { const s = String(t == null ? '' : t).replace(/\s+/g, ''); const o = new Set();
  for (let i = 0; i + N <= s.length; i++) o.add(s.slice(i, i + N)); return o; };
const jac = (a, b) => { if (!a.size || !b.size) return null;
  let i = 0; for (const g of a) if (b.has(g)) i++; return i / (a.size + b.size - i); };
const stat = (js, label) => { if (!js.length) { console.log(label + ' 无数据'); return; }
  js.sort((x, y) => x - y);
  console.log(label.padEnd(44) + 'p10 ' + js[Math.floor(js.length*0.1)].toFixed(3) +
    '  p50 ' + js[Math.floor(js.length*0.5)].toFixed(3) +
    '  p90 ' + js[Math.floor(js.length*0.9)].toFixed(3) + '  n=' + js.length); };

const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const fullById = new Map(full.map((r) => [r.id, r]));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const devById = new Map(dev.map((r) => [r.id, r]));

console.log('=== 同一输入、两次采样之间的相似度（10-gram Jaccard）===');
console.log('  尺度锚点：随机两条**不同**输入的教师稿，应当接近 0');
const rand = [];
for (let i = 0; i < 400; i++) {
  const x = full[Math.floor(Math.random() * full.length)];
  const y = full[Math.floor(Math.random() * full.length)];
  if (x.id === y.id) continue;
  const v = jac(grams(x.draft), grams(y.draft)); if (v !== null) rand.push(v);
}
stat(rand, '  教师 vs 教师（不同输入，对照基线）');

for (const f of ['.cfb-offline/teacher/v4-100.jsonl', '.cfb-offline/teacher/v4-30.jsonl']) {
  if (!fs.existsSync(f)) continue;
  const a = rd(f); const js = [];
  for (const r of a) { const q = fullById.get(r.id); if (!q) continue;
    const v = jac(grams(r.draft), grams(q.draft)); if (v !== null) js.push(v); }
  stat(js, '  教师 vs 教师（同输入两次采样）' + f.split('/').pop());
}

const v9 = rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl');
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
for (const pair of [['v9  ', v9], ['v10 ', v10]]) {
  const js = [];
  for (const r of pair[1]) { const d = devById.get(r.id); if (!d) continue;
    const v = jac(grams(r.draft), grams(d.assistant)); if (v !== null) js.push(v); }
  stat(js, '  ' + pair[0] + '学生 vs 教师（同输入）');
}
console.log('');
console.log('读法：学生的数若远低于「教师 vs 教师（同输入）」，说明学生产出的东西');
console.log('      跟教师对同一个输入的产出都对不上 —— 那不是做得差，是没在做这件事。');
