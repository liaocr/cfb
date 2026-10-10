
import fs from 'node:fs';
const F = 'tools/eval-sft.mjs';
let s = fs.readFileSync(F, 'utf8');
const A = 'const scoreable = rows.filter((r) => r.gaugeable)';
if (s.split(A).length - 1 !== 1) { console.log('MISS'); process.exit(1); }
s = s.replace(A, 'const scoreable = rows.filter((r) => r.teacherGaugeable)');
fs.writeFileSync(F, s);
console.log('ok');
