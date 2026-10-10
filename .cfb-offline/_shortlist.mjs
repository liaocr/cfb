
import fs from 'node:fs';
const p = '.cfb-offline/ruler/raw-mine-shortlist.jsonl';
const rows = fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
console.log('shortlist 行数', rows.length);
console.log('字段', Object.keys(rows[0]));
console.log('样例 unitId', rows.slice(0,3).map(o=>o.unitId));
const used = new Set(fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l).id));
const unused = rows.filter(o=>!used.has(o.unitId));
console.log('已用', used.size, '未用', unused.length);
// 未用的那些长度分布
const lens = unused.map(o=>o.raw.length).sort((a,b)=>a-b);
const q = (p)=>lens[Math.floor(lens.length*p)]||0;
console.log('未用 raw 长度 p10/p50/p90', q(.1), q(.5), q(.9));
// 仓库分布
const fam = {};
for (const o of rows) fam[o.repository]=(fam[o.repository]||0)+1;
console.log('仓库数', Object.keys(fam).length, '最多:', Object.entries(fam).sort((a,b)=>b[1]-a[1]).slice(0,6));
