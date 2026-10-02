import fs from 'node:fs';
const file = process.argv[2];
const keys = process.argv.slice(3);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const byStep = new Map();
for (const line of lines) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== 'reasoning-chunks' || !Array.isArray(e.data?.texts)) continue;
  const arr = byStep.get(e.data.step) || [];
  arr.push(...e.data.texts);
  byStep.set(e.data.step, arr);
}
const re = new RegExp(keys.join('|'), 'i');
let count = 0;
for (const [step, texts] of [...byStep.entries()].sort((a,b)=>a[0]-b[0])) {
  const txt = texts.join('');
  if (!re.test(txt)) continue;
  count++;
  console.log(`\n===== step ${step} =====`);
  const matches = [];
  let m;
  const r2 = new RegExp(keys.join('|'), 'ig');
  while ((m = r2.exec(txt)) !== null) {
    const start = Math.max(0, m.index - 250);
    const end = Math.min(txt.length, m.index + m[0].length + 350);
    matches.push(txt.slice(start, end).replace(/\s+/g, ' '));
    if (matches.length >= 3) break;
  }
  for (const s of matches) console.log('…' + s + '…');
  if (count >= 40) break;
}
if (count === 0) console.log('no matches');
