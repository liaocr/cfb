import fs from 'node:fs';
const file = process.argv[2];
const ranges = process.argv.slice(3).map(s => {
  if (s.includes('-')) { const [a,b]=s.split('-').map(Number); return [a,b]; }
  const n=Number(s); return [n,n];
});
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const byStep = new Map();
for (const line of lines) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== 'reasoning-chunks' || !Array.isArray(e.data?.texts)) continue;
  const step = e.data.step;
  const arr = byStep.get(step) || [];
  arr.push(...e.data.texts);
  byStep.set(step, arr);
}
for (const [a,b] of ranges) {
  for (let s=a; s<=b; s++) {
    const txt = (byStep.get(s) || []).join('');
    if (!txt) { console.log(`\n===== step ${s}: (no reasoning) =====`); continue; }
    console.log(`\n===== step ${s} =====`);
    console.log(txt.slice(0, 1800));
  }
}
