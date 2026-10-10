
import fs from 'node:fs';
import { anchorsOf, hasAnchor } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(dev.map((r) => [r.id, r]));

function ret(getDraft) {
  let rawT = 0, rawH = 0, ctxT = 0, ctxH = 0;
  for (const d of dev) {
    const draft = getDraft(d);
    if (draft == null) continue;
    for (const a of new Set(anchorsOf(d.raw))) { rawT++; if (hasAnchor(draft, a)) rawH++; }
    for (const a of new Set(anchorsOf(d.ctx))) { ctxT++; if (hasAnchor(draft, a)) ctxH++; }
  }
  return { raw: rawH / rawT, ctx: ctxH / ctxT, rawH, rawT, ctxH, ctxT };
}

const teacher = ret((d) => d.assistant);
const v10rows = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const v10ById = new Map(v10rows.map((r) => [r.id, r]));
const v9rows = rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl');
const v9ById = new Map(v9rows.map((r) => [r.id, r]));
const student = ret((d) => { const r = v10ById.get(d.id); return r ? r.draft : null; });
const student9 = ret((d) => { const r = v9ById.get(d.id); return r ? r.draft : null; });

console.log('=== 稿子保留的是 raw（思维过程）还是 ctx（题面）的锚点？ ===');
console.log('档'.padEnd(12) + 'raw 锚点保留'.padEnd(22) + 'ctx 锚点保留'.padEnd(22) + 'raw/ctx 比');
for (const pair of [['教师', teacher], ['v9 学生', student9], ['v10 学生', student]]) {
  const x = pair[1];
  console.log(pair[0].padEnd(12) +
    ((100 * x.raw).toFixed(1) + '%  (' + x.rawH + '/' + x.rawT + ')').padEnd(22) +
    ((100 * x.ctx).toFixed(1) + '%  (' + x.ctxH + '/' + x.ctxT + ')').padEnd(22) +
    (x.raw / x.ctx).toFixed(3));
}
console.log('');
console.log('读法：raw/ctx 比 <1 说明稿子更贴题面、更不像思维过程的压缩。');

// n-gram 重叠：学生的稿子跟 raw 像，还是跟 ctx 像
const N = 10;
const grams = (t) => { const s = String(t == null ? '' : t).replace(/\s+/g, ''); const o = new Set();
  for (let i = 0; i + N <= s.length; i++) o.add(s.slice(i, i + N)); return o; };
const jac = (a, b) => { if (!a.size || !b.size) return null; let i = 0;
  for (const g of a) if (b.has(g)) i++; return i / (a.size + b.size - i); };
console.log('');
console.log('=== 稿子与 raw / ctx 的 10-gram Jaccard ===');
console.log('档'.padEnd(12) + 'vs raw'.padEnd(12) + 'vs ctx'.padEnd(12) + 'raw/ctx');
for (const pair of [['教师', (d) => d.assistant],
                    ['v9 学生', (d) => { const r = v9ById.get(d.id); return r ? r.draft : null; }],
                    ['v10 学生', (d) => { const r = v10ById.get(d.id); return r ? r.draft : null; }]]) {
  const a = [], b = [];
  for (const d of dev) {
    const draft = pair[1](d); if (draft == null) continue;
    const g = grams(draft);
    const x = jac(g, grams(d.raw)); if (x !== null) a.push(x);
    const y = jac(g, grams(d.ctx)); if (y !== null) b.push(y);
  }
  const m = (z) => z.reduce((p, q) => p + q, 0) / z.length;
  console.log(pair[0].padEnd(12) + m(a).toFixed(4).padEnd(12) + m(b).toFixed(4).padEnd(12) + (m(a) / m(b)).toFixed(3));
}
