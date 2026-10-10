
import fs from 'node:fs';
import { judge, anchorsOf } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- 1. 目标本身可不可靠：同一输入两次教师采样，尺子给的分差多少 ----
const a100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const fullById = new Map(full.map((r) => [r.id, r]));
console.log('=== 目标可靠性：同一输入、两次教师采样，尺子打分 ===');
const A = [], B = [], deltas = [];
let bothPass = 0, flip = 0, bothFail = 0;
for (const r of a100) {
  const q = fullById.get(r.id); if (!q) continue;
  const ja = judge({ raw: r.raw, ctx: r.ctx, draft: r.draft });
  const jb = judge({ raw: q.raw, ctx: q.ctx, draft: q.draft });
  if (!ja.gaugeable || !jb.gaugeable) continue;
  A.push(ja.score); B.push(jb.score); deltas.push(Math.abs(ja.score - jb.score));
  if (ja.pass && jb.pass) bothPass++;
  else if (!ja.pass && !jb.pass) bothFail++;
  else flip++;
}
const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
const sd = (x) => { const m = mean(x); return Math.sqrt(x.reduce((p, q) => p + (q - m) ** 2, 0) / x.length); };
const corr = (x, y) => { const mx = mean(x), my = mean(y);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { const a = x[i] - mx, b = y[i] - my; n += a * b; dx += a * a; dy += b * b; }
  return n / Math.sqrt(dx * dy); };
deltas.sort((x, y) => x - y);
console.log('  n=' + A.length + '  软分A均值 ' + mean(A).toFixed(3) + '  软分B均值 ' + mean(B).toFixed(3));
console.log('  两次采样的软分相关系数 r = ' + corr(A, B).toFixed(3));
console.log('  |Δ软分| p50 = ' + deltas[Math.floor(deltas.length / 2)].toFixed(3) +
            '  p90 = ' + deltas[Math.floor(deltas.length * 0.9)].toFixed(3));
console.log('  过门：两次都过 ' + bothPass + ' · 翻转 ' + flip + ' (' + (100 * flip / A.length).toFixed(0) + '%) · 都不过 ' + bothFail);
console.log('  → 翻转率就是"标签噪声"：拿同一个输入问两次，有 ' + (100 * flip / A.length).toFixed(0) + '% 的概率得到相反的答案。');

// ---- 2. 学生是不是"输入越复杂越崩" ----
console.log('');
console.log('=== 学生分数 vs 输入复杂度 ===');
const dev = rd('.cfb-offline/sft/dev.jsonl');
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const v10ById = new Map(v10.map((r) => [r.id, r]));
const buckets = [[0, 15, '锚点 <15'], [15, 25, '15-25'], [25, 35, '25-35'], [35, 999, '>=35']];
const acc = buckets.map(() => ({ n: 0, ssum: 0, psum: 0, tsum: 0 }));
for (const d of dev) {
  const r = v10ById.get(d.id); if (!r) continue;
  const j = judge({ raw: d.raw, ctx: d.ctx, draft: String(r.draft || '') });
  const jt = judge({ raw: d.raw, ctx: d.ctx, draft: d.assistant });
  if (!j.gaugeable || !jt.gaugeable) continue;
  const na = new Set(anchorsOf(d.raw)).size;
  for (let i = 0; i < buckets.length; i++) {
    if (na >= buckets[i][0] && na < buckets[i][1]) {
      acc[i].n++; acc[i].ssum += j.score; acc[i].psum += (j.pass ? 1 : 0); acc[i].tsum += jt.score; break;
    }
  }
}
console.log('输入锚点数'.padEnd(16) + 'n'.padEnd(6) + '学生软分'.padEnd(11) + '教师软分'.padEnd(11) + '学生过门率');
for (let i = 0; i < buckets.length; i++) {
  const a = acc[i]; if (!a.n) continue;
  console.log(buckets[i][2].padEnd(16) + String(a.n).padEnd(6) + (a.ssum / a.n).toFixed(3).padEnd(11) +
    (a.tsum / a.n).toFixed(3).padEnd(11) + (100 * a.psum / a.n).toFixed(0) + '%');
}
