
import fs from 'node:fs';
const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
console.log('dev n =', dev.length);
console.log('dev keys =', Object.keys(dev[0]).join(','));
for (const k of Object.keys(dev[0])) { const v = dev[0][k]; console.log('  ', k, '=', typeof v, typeof v === 'string' ? ('len ' + v.length) : JSON.stringify(v).slice(0,150)); }
const ev = JSON.parse(fs.readFileSync('.cfb-offline/kaggle-out/eval-sft.json','utf8'));
console.log('eval top keys =', Object.keys(ev).join(','));
console.log('eval.rows n =', (ev.rows||[]).length);
if (ev.rows && ev.rows[0]) { console.log('eval row keys =', Object.keys(ev.rows[0]).join(',')); console.log(JSON.stringify(ev.rows[0]).slice(0,700)); }
console.log('report =', JSON.stringify(ev.report||{}).slice(0,600));
