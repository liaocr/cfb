import fs from 'node:fs';
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');

const count = (re) => (text.match(re) || []).length;

console.log('reasoning-chunks events:', count(/reasoning-chunks/g));
console.log('blockType counts:');
const bt = {};
for (const m of text.matchAll(/"blockType":"([^"]+)"/g)) bt[m[1]] = (bt[m[1]] || 0) + 1;
console.log(bt);
console.log('stopReason counts:');
const sr = {};
for (const m of text.matchAll(/"stopReason":"([^"]+)"/g)) sr[m[1]] = (sr[m[1]] || 0) + 1;
console.log(sr);
console.log('"reasoning" key occurrences:', count(/"reasoning"/g));

// find the actual system prompt sent
const reqs = text.split('\n').filter(l => l.includes('request/header'));
if (reqs.length) {
  for (const r of reqs.slice(0, 3)) {
    const m = r.match(/"system":"([^"]*)"/);
    if (m) console.log('system prompt (short):', JSON.stringify(m[1]));
  }
} else {
  console.log('no request/header events found');
}
