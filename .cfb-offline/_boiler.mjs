
import fs from 'node:fs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const devRows = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(devRows.map((d) => [d.id, d]));

const RUNS = [
  ['教师(dev 89)', devRows.map((d) => ({ id: d.id, draft: d.assistant }))],
  ['v9 学生',      rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl')],
  ['v10 学生',     rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl')],
];

const N = 10;
function grams(t) {
  const s = t.replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + N <= s.length; i++) out.add(s.slice(i, i + N));
  return out;
}

// 跨稿复用率：每篇稿子里，有多少比例的 N-gram 在**别的稿子**里也出现
function boilerplate(drafts) {
  const gs = drafts.map((d) => grams(String(d.draft || '')));
  const docFreq = new Map();
  for (const s of gs) for (const g of s) docFreq.set(g, (docFreq.get(g) || 0) + 1);
  const per = [];
  for (const s of gs) {
    if (!s.size) continue;
    let shared = 0;
    for (const g of s) if (docFreq.get(g) > 1) shared++;
    per.push(shared / s.size);
  }
  per.sort((a, b) => a - b);
  return { p50: per[Math.floor(per.length / 2)], p90: per[Math.floor(per.length * 0.9)], n: per.length };
}

console.log('=== 跨输入套话复用率（' + N + '-gram 出现在别的稿子里的比例，越高=越像模板）===');
console.log('档'.padEnd(16) + 'p50'.padEnd(10) + 'p90');
for (const pair of RUNS) {
  const b = boilerplate(pair[1]);
  console.log(pair[0].padEnd(16) + (100 * b.p50).toFixed(1).padEnd(10) + (100 * b.p90).toFixed(1));
}

// 学生 vs 教师：同一批 id，学生的稿子跟**教师稿**有多像？
console.log('');
console.log('=== 学生稿与教师稿的逐条相似度（10-gram Jaccard）===');
for (const pair of [['v9', '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl'],
                    ['v10', '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl']]) {
  const rows = rd(pair[1]);
  const js = [];
  for (const r of rows) {
    const d = byId.get(r.id); if (!d) continue;
    const a = grams(String(r.draft || '')), b = grams(d.assistant);
    if (!a.size || !b.size) continue;
    let inter = 0; for (const g of a) if (b.has(g)) inter++;
    js.push(inter / (a.size + b.size - inter));
  }
  js.sort((x, y) => x - y);
  console.log(pair[0].padEnd(8) + 'p50 ' + js[Math.floor(js.length / 2)].toFixed(3) +
              '  p90 ' + js[Math.floor(js.length * 0.9)].toFixed(3) + '  n=' + js.length);
}

// 学生稿里最常见的复用片段长什么样
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const df = new Map();
for (const r of v10) for (const g of grams(String(r.draft || ''))) df.set(g, (df.get(g) || 0) + 1);
const top = [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('');
console.log('=== v10 学生稿里跨稿出现最多的 10-gram ===');
for (const e of top) console.log('  x' + String(e[1]).padEnd(4) + e[0]);
