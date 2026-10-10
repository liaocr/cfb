
import fs from 'node:fs';
for (const p of ['.cfb-offline/teacher/drafts.jsonl','.cfb-offline/teacher/gen.jsonl','.cfb-offline/teacher/state.json']) {
  try { const st = fs.statSync(p); console.log(p, st.size, 'bytes'); } catch { console.log(p, 'MISSING'); }
}
const ls = fs.readdirSync('.cfb-offline/teacher');
console.log('teacher dir:', ls.join(' | '));
const L = fs.readFileSync('.cfb-offline/teacher/drafts.jsonl','utf8').trim().split('\n');
console.log('drafts lines =', L.length);
const o = JSON.parse(L[0]);
console.log('keys =', Object.keys(o).join(','));
console.log('sample meta =', JSON.stringify({id:o.id, family:o.family, repository:o.repository, raw: (o.raw||'').length, ctx:(o.ctx||'').length, draft:(o.draft||'').length, license:o.license, usage:o.usage}));
