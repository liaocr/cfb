
import fs from 'node:fs';
const rows = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const n = rows.length;
const sp = rows.reduce((s,o)=>s+(o.usage?.prompt||0),0);
const sc = rows.reduce((s,o)=>s+(o.usage?.completion||0),0);
console.log('条数', n, 'prompt 合计', sp, 'completion 合计', sc, '均摊', Math.round(sp/n), Math.round(sc/n));
// batch.py 的估价公式
console.log('按 batch.py 公式 低谷 $', ((sp*0.15 + sc*0.60)/1e6).toFixed(4));
console.log('单条 $', ((sp*0.15 + sc*0.60)/1e6/n).toFixed(5));
// 未用池 3942 条，按同样均摊估
const perP = sp/n, perC = sc/n;
const est = 3942*(perP*0.15 + perC*0.60)/1e6;
console.log('3942 条预估 低谷 $', est.toFixed(2));
console.log('但短名单 raw 长度 p50 2352 vs 已用 722 的 p50:', (()=>{const L=rows.map(o=>o.raw.length).sort((a,b)=>a-b);return L[Math.floor(L.length/2)]})());
