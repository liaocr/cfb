
import fs from 'node:fs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
for (const f of ['.cfb-offline/teacher/v4-100.jsonl', '.cfb-offline/teacher/v4-full.jsonl', '.cfb-offline/sft/dev.jsonl']) {
  const rows = rd(f);
  console.log('---', f, rows.length, '条');
  console.log('   keys:', Object.keys(rows[0]).join(','));
  console.log('   id[0..2]:', rows.slice(0, 3).map((r) => r.id).join(' | '));
}
const a = rd('.cfb-offline/teacher/v4-100.jsonl');
const b = rd('.cfb-offline/teacher/v4-full.jsonl');
const bi = new Set(b.map((r) => r.id));
const hit = a.filter((r) => bi.has(r.id)).length;
console.log('');
console.log('v4-100 的 id 在 v4-full 里命中:', hit, '/', a.length);
const a2 = rd('.cfb-offline/teacher/v4-30.jsonl');
const hit2 = a2.filter((r) => bi.has(r.id)).length;
console.log('v4-30  的 id 在 v4-full 里命中:', hit2, '/', a2.length);
console.log('v4-30  id 样例:', a2.slice(0,3).map(r=>r.id).join(' | '));
console.log('v4-100 id 样例:', a.slice(0,3).map(r=>r.id).join(' | '));
console.log('v4-full id 样例:', b.slice(0,3).map(r=>r.id).join(' | '));
