
import fs from 'node:fs';
import { judge, splitSentences } from '../tools/gen-ruler.mjs';
const BT = String.fromCharCode(96);
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const base = [];
for (const o of full) {
  const d=(o.draft||'').trim(); if(!d) continue;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d});
  if (j.gaugeable && j.pass) base.push(o);
  if (base.length>=60) break;
}
console.log('基准条数', base.length);
const Q = /[\u300c\u300d\u201c\u201d]/;
const degrade = {
  'L0 原稿':              d => d,
  'L1 去掉末 25% 句':     d => { const s=splitSentences(d); return s.slice(0, Math.max(1,Math.floor(s.length*0.75))).join(''); },
  'L2 去掉后一半':        d => { const s=splitSentences(d); return s.slice(0, Math.max(1,Math.floor(s.length*0.5))).join(''); },
  'L3 只留第一句':        d => { const s=splitSentences(d); return s[0]||''; },
  'L4 打乱句序':          d => { const s=splitSentences(d); for(let i=s.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));const t=s[i];s[i]=s[k];s[k]=t;} return s.join(''); },
  'L5 删掉含标识符的句子': d => { const s=splitSentences(d); return s.filter(x=>!Q.test(x) && !/[A-Za-z_]{3,}/.test(x)).join(''); },
  'L6 尾部加凭空标识符':   d => d + ' 另外要改 ' + BT + 'zzz_fabricated_symbol_9x' + BT + ' 里的 ' + BT + 'totally_made_up_field' + BT + '。',
  'L7 只留最后一句':      d => { const s=splitSentences(d); return s[s.length-1]||''; },
  'L8 整段翻成英文占位':   d => { const s=splitSentences(d); return s.map(x=>'We need to update the relevant file and verify the tests pass.').join(''); },
};
const names = Object.keys(degrade);
const res = {};
for (const nm of names) res[nm] = {pass:0, gauge:0, n:0, soft:[], chars:0};
for (const o of base) {
  for (const nm of names) {
    const d = degrade[nm](o.draft);
    const j = judge({raw:o.raw, ctx:o.ctx, draft:d});
    const r = res[nm]; r.n++; r.chars += d.length;
    if (j.gaugeable) { r.gauge++; if (j.pass) r.pass++; r.soft.push(j.score); }
  }
}
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
console.log('');
console.log('阶梯'.padEnd(26) + '过门'.padEnd(11) + '过门率'.padEnd(9) + '软分均值'.padEnd(11) + '平均字数');
for (const nm of names) {
  const r = res[nm];
  console.log(nm.padEnd(24) + (r.pass+'/'+r.gauge).padEnd(11) +
    (r.gauge?(r.pass/r.gauge).toFixed(3):'n/a').padEnd(9) +
    avg(r.soft).toFixed(4).padEnd(11) + Math.round(r.chars/r.n));
}
