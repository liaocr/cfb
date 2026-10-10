
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const L = (t) => [...String(t == null ? '' : t)].length;
const dev = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(dev.map((r) => [r.id, r]));

function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length); idx.forEach((e, k) => { r[e[1]] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return num / Math.sqrt(dx * dy);
}

console.log('=== 输出长度 是否随 输入长度 变化？（真压缩器必须正相关）===');
console.log('档'.padEnd(14) + 'Spearman(稿长, raw长)'.padEnd(24) + 'Spearman(稿长, ctx长)'.padEnd(24) + '稿长 p50  稿长标准差');

const rows = [['教师(dev)', dev.map((r) => ({ id: r.id, draft: r.assistant, raw: r.raw, ctx: r.ctx }))]];
for (const f of [['v9 ', '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl'],
                 ['v10', '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl']]) {
  rows.push([f[0], rd(f[1]).filter((r) => byId.has(r.id)).map((r) => {
    const d = byId.get(r.id); return { id: r.id, draft: r.draft, raw: d.raw, ctx: d.ctx }; })]);
}
for (const pair of rows) {
  const name = pair[0], rs = pair[1];
  const dl = rs.map((r) => L(r.draft));
  const rl = rs.map((r) => L(r.raw));
  const cl = rs.map((r) => L(r.ctx));
  const mean = dl.reduce((a, b) => a + b, 0) / dl.length;
  const sd = Math.sqrt(dl.reduce((a, b) => a + (b - mean) ** 2, 0) / dl.length);
  const s = [...dl].sort((a, b) => a - b);
  console.log(name.padEnd(14) + spearman(dl, rl).toFixed(3).padEnd(24) +
    spearman(dl, cl).toFixed(3).padEnd(24) + String(s[Math.floor(s.length / 2)]).padEnd(9) + sd.toFixed(0));
}

console.log('');
console.log('=== 分数 是否随 稿长 变化？（学生是不是"越短越差"）===');
for (const f of [['v9 ', '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl'],
                 ['v10', '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl']]) {
  const rs = rd(f[1]);
  const lens = [], scores = [];
  for (const r of rs) { const d = byId.get(r.id); if (!d) continue;
    const j = judge({ raw: d.raw, ctx: d.ctx, draft: String(r.draft || '') });
    if (!j.gaugeable) continue; lens.push(L(r.draft)); scores.push(j.score); }
  console.log('  ' + f[0] + ' Spearman(稿长, 软分) = ' + spearman(lens, scores).toFixed(3) + '  n=' + lens.length);
}
const tl = [], ts = [];
for (const d of dev) { const j = judge({ raw: d.raw, ctx: d.ctx, draft: d.assistant });
  if (!j.gaugeable) continue; tl.push(L(d.assistant)); ts.push(j.score); }
console.log('  教师 Spearman(稿长, 软分) = ' + spearman(tl, ts).toFixed(3) + '  n=' + tl.length);
