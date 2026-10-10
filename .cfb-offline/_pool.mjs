
import fs from 'node:fs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const dev  = rd('deploy/kaggle/data/sft-dev.jsonl');
const tr   = rd('deploy/kaggle/data/sft-train.jsonl');
console.log('v4-full 行数', full.length, '有稿', full.filter(o=>o.draft&&o.draft.trim()).length);
console.log('sft-train', tr.length, 'sft-dev', dev.length, '合计', tr.length+dev.length);
console.log('v4-full 的 id 集合 vs train+dev:');
const a = new Set(full.map(o=>o.id)), b = new Set([...tr,...dev].map(o=>o.id));
console.log('  只在 v4-full:', [...a].filter(x=>!b.has(x)).length);
console.log('  只在 sft:', [...b].filter(x=>!a.has(x)).length);
console.log('  v4-full 里有稿但没进 sft 的:', [...a].filter(x=>!b.has(x)).length);
console.log('样本 id:', full.slice(0,3).map(o=>o.id));
console.log('字段:', Object.keys(full[0]));
