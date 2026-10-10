
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';

const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const devRows = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(devRows.map((d) => [d.id, d]));

const RUNS = [
  ['v9(40步)',   '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl'],
  ['v10@72(6轮)','.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations-step72.jsonl'],
  ['v10@144',    '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations-step144.jsonl'],
  ['v10@216',    '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations-step216.jsonl'],
  ['v10(288步)', '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl'],
];

function repFrac(t) {
  const s = t.replace(/\s+/g, '');
  const n = 8;
  if (s.length < n * 3) return 0;
  const counts = new Map();
  for (let i = 0; i + n <= s.length; i++) {
    const k = s.slice(i, i + n);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let dup = 0;
  for (const v of counts.values()) if (v >= 3) dup++;
  return dup / Math.max(1, counts.size);
}

console.log('档'.padEnd(14) + 'n'.padEnd(5) + '字数p50'.padEnd(10) + '结尾是标点%'.padEnd(14) + '重复8gram%'.padEnd(13) + '空稿');
for (const pair of RUNS) {
  const name = pair[0], file = pair[1];
  if (!fs.existsSync(file)) { console.log(name + ' 缺文件'); continue; }
  const gen = rd(file);
  const lens = [];
  const reps = [];
  let goodEnd = 0, blank = 0;
  for (const row of gen) {
    const d = String(row.draft || '');
    if (!d.trim()) { blank++; continue; }
    lens.push([...d].length);
    if (/[。！？.!?）)"'\]]$/.test(d.trimEnd())) goodEnd++;
    reps.push(repFrac(d));
  }
  lens.sort((a, b) => a - b);
  reps.sort((a, b) => a - b);
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0);
  console.log(
    name.padEnd(14) + String(gen.length).padEnd(5) + String(med(lens)).padEnd(10) +
    ((100 * goodEnd) / gen.length).toFixed(0).padEnd(14) +
    ((100 * med(reps))).toFixed(1).padEnd(13) + blank
  );
}

console.log('');
console.log('=== v10 最差 / 最好各一条，对照教师 ===');
const v10 = rd(RUNS[4][1]);
const scored = [];
for (const row of v10) {
  const d = byId.get(row.id);
  if (!d) continue;
  const j = judge({ raw: d.raw, ctx: d.ctx, draft: String(row.draft || '') });
  if (j.gaugeable) scored.push({ row, d, j });
}
scored.sort((a, b) => a.j.score - b.j.score);
const picks = [scored[0], scored[1], scored[scored.length - 1]];
for (const x of picks) {
  const tj = judge({ raw: x.d.raw, ctx: x.d.ctx, draft: x.d.assistant });
  console.log('');
  console.log('--- ' + x.row.id + ' | 学生 ' + x.j.score.toFixed(3) + ' | 教师 ' + tj.score.toFixed(3));
  console.log('  [教师 ' + [...x.d.assistant].length + '字] ' + x.d.assistant.slice(0, 260).replace(/\n/g, ' '));
  console.log('  [学生 ' + [...String(x.row.draft)].length + '字] ' + String(x.row.draft).slice(0, 260).replace(/\n/g, ' '));
}
