
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * q)] : 0; };
const line = (label, a) => console.log(label.padEnd(30) + 'p10 ' + String(pct(a, 0.1)).padEnd(7) +
  'p50 ' + String(pct(a, 0.5)).padEnd(7) + 'p90 ' + String(pct(a, 0.9)).padEnd(7) +
  '均值 ' + (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0));

const train = rd('.cfb-offline/sft/train.jsonl');
const dev = rd('.cfb-offline/sft/dev.jsonl');
const len = (r) => [...String(r)].length;

console.log('=== 字数分布（字符）===');
line('train.raw', train.map((r) => len(r.raw)));
line('train.ctx', train.map((r) => len(r.ctx)));
line('train.draft（训练目标）', train.map((r) => len(r.assistant)));
console.log('');
line('dev.raw', dev.map((r) => len(r.raw)));
line('dev.ctx', dev.map((r) => len(r.ctx)));
line('dev.draft（教师，未过滤）', dev.map((r) => len(r.assistant)));

console.log('');
console.log('=== 尺子过滤对长度的选择效应（教师池 2484 条）===');
const pool = rd('.cfb-offline/teacher/v4-full.jsonl');
const kept = [], drop = [];
let gateFail = 0;
for (const r of pool) {
  if (!r.raw || !r.ctx || !r.draft) continue;
  const j = judge({ raw: r.raw, ctx: r.ctx, draft: r.draft });
  if (!j.gaugeable) continue;
  if (j.pass) kept.push(len(r.draft)); else { drop.push(len(r.draft)); gateFail++; }
}
console.log('  过门（进训练集）n=' + kept.length + '  vs  未过门 n=' + drop.length);
line('  过门稿长度', kept);
line('  未过门稿长度', drop);
console.log('  → 过门稿比未过门稿' + (pct(kept,0.5) < pct(drop,0.5) ? '短' : '长') +
  ' ' + Math.abs(pct(kept,0.5) - pct(drop,0.5)) + ' 字（p50）');

console.log('');
console.log('=== 训练目标 vs dev 目标的长度对比 ===');
const tl = train.map((r) => len(r.assistant));
const dl = dev.map((r) => len(r.assistant));
console.log('  train.draft p50 = ' + pct(tl, 0.5) + '   dev.draft p50 = ' + pct(dl, 0.5));
console.log('  → dev 目标比训练目标' + (pct(dl,0.5) > pct(tl,0.5) ? '长' : '短') + ' ' +
  Math.abs(pct(dl, 0.5) - pct(tl, 0.5)) + ' 字');
console.log('');
console.log('  学生实际产出（v10 p50 515 字）比训练目标 p50 ' + pct(tl,0.5) + ' 字短 ' +
  (pct(tl, 0.5) - 515) + ' 字 —— 训练时从没见过这么短的目标，是模型自己收敛到的。');
