
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const a100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const fullById = new Map(full.map((r) => [r.id, r]));

const S = [];
for (const r of a100) {
  const q = fullById.get(r.id); if (!q) continue;
  const ja = judge({ raw: r.raw, ctx: r.ctx, draft: r.draft });
  const jb = judge({ raw: q.raw, ctx: q.ctx, draft: q.draft });
  if (!ja.gaugeable || !jb.gaugeable) continue;
  S.push({ a: ja.score, b: jb.score, pa: ja.pass, pb: jb.pass });
}
const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
const A = S.map((s) => s.a), B = S.map((s) => s.b), MX = S.map((s) => Math.max(s.a, s.b));
console.log('=== 同一批 ' + S.length + ' 个单元：单次采样 vs best-of-2 ===');
console.log('  第 1 次采样软分均值        ' + mean(A).toFixed(4));
console.log('  第 2 次采样软分均值        ' + mean(B).toFixed(4));
console.log('  best-of-2 软分均值         ' + mean(MX).toFixed(4) + '   (+' + (mean(MX) - mean(A)).toFixed(4) + ')');
console.log('');
const pa = S.filter((s) => s.pa).length, pb = S.filter((s) => s.pb).length;
const por = S.filter((s) => s.pa || s.pb).length, pand = S.filter((s) => s.pa && s.pb).length;
console.log('  过门率：第1次 ' + (100 * pa / S.length).toFixed(1) + '% · 第2次 ' + (100 * pb / S.length).toFixed(1) + '%');
console.log('          至少一次过 ' + (100 * por / S.length).toFixed(1) + '% · 两次都过 ' + (100 * pand / S.length).toFixed(1) + '%');
console.log('');
console.log('  → best-of-2 把训练目标的过门率从 ' + (100 * pa / S.length).toFixed(1) + '% 抬到 ' +
            (100 * por / S.length).toFixed(1) + '%（+' + (100 * (por - pa) / S.length).toFixed(1) + ' 点）');
console.log('  → 代价：每个单元的教师调用从 1 次变 k 次。实测单价 $0.00063/次。');
console.log('     全量 4687 个单元做 best-of-4 ≈ $' + (4687 * 3 * 0.00063).toFixed(2) + '（增量 3 次/单元）');
