
import fs from 'node:fs';
const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
console.log('dev ids =', dev.length, 'gen ids =', gen.length);
const a = dev.map(d=>d.id).join('|'), b = gen.map(g=>g.id).join('|');
console.log('id 序列完全一致:', a===b);
const s = new Set(dev.map(d=>d.id));
console.log('gen 中不在 dev 的:', gen.filter(g=>!s.has(g.id)).length);
// raw 一致性
let bad=0; const gm=new Map(gen.map(g=>[g.id,g]));
for(const d of dev){ const g=gm.get(d.id); const i=d.user.indexOf('\n\n[思考过程]\n'); const raw=d.user.slice(i+8); if(g.raw!==raw) bad++; }
console.log('raw 不一致条数:', bad);
// train 规模
const tr = fs.readFileSync('.cfb-offline/sft/train.jsonl','utf8').trim().split('\n').filter(Boolean);
console.log('train =', tr.length);
