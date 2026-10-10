
import fs from 'node:fs';
import { TASKS } from '../tools/v4-live.mjs';

const recs = JSON.parse(fs.readFileSync('transfer/recordings.json', 'utf8'));
const specs = JSON.parse(fs.readFileSync('tools/effect-specs.json', 'utf8'));
const system = fs.readFileSync('transfer/prompts/teacher2-zh.txt', 'utf8');

const taskById = new Map(TASKS.map((t) => [t.id, t]));
const recById = new Map(recs.map((r) => [r.id, r]));

const baseIds = [...new Set(specs.map((s) => s.base || s.id))];
const out = [];
console.log('唯一录音单元:', baseIds.length, '->', baseIds.join(', '));
console.log('');
console.log('id'.padEnd(20) + 'ctx 字'.padEnd(10) + 'raw 字'.padEnd(10) + 'user 字'.padEnd(10) + 'system 字');
for (const id of baseIds) {
  const t = taskById.get(id), r = recById.get(id);
  if (!t || !r) { console.log(id + '  缺: task=' + !!t + ' rec=' + !!r); continue; }
  const raw = r.events.filter((e) => e.k === 'r').map((e) => e.s).join('');
  const ctx = t.user || '';
  const user = '[题面]\n' + ctx + '\n\n[思考过程]\n' + raw;
  out.push({ id, ctx, raw, system, user });
  console.log(id.padEnd(20) + String(ctx.length).padEnd(10) + String(raw.length).padEnd(10) +
    String(user.length).padEnd(10) + String(system.length));
}
fs.mkdirSync('.cfb-offline/effect', { recursive: true });
fs.writeFileSync('.cfb-offline/effect/pairs.jsonl',
  out.map((o) => JSON.stringify({ id: o.id, ctx: o.ctx, raw: o.raw, system: o.system, user: o.user })).join('\n') + '\n');
console.log('');
console.log('已写 .cfb-offline/effect/pairs.jsonl (' + out.length + ' 条)');
console.log('录音里 reasoning 事件的键:', Object.keys(recs[0].events[0]).join(','));
