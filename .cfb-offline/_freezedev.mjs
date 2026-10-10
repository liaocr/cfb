
import fs from 'node:fs';
const rows = fs.readFileSync('deploy/kaggle/data/sft-dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const ids = rows.map(o=>o.id);
fs.writeFileSync('.cfb-offline/sft/dev-ids.txt', ids.join('\n')+'\n');
console.log('冻结 dev id 数', ids.length);
console.log('仓库数', new Set(rows.map(o=>o.repo)).size);
console.log('前3', ids.slice(0,3).join(' | '));
