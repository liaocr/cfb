
import fs from 'node:fs';
import { judge, anchorsOf, hasAnchor, loadAnchors } from '../tools/gen-ruler.mjs';

const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const f100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const byId = new Map(full.map(o=>[o.id,o]));

// 1) 过门一致性的 kappa
let a=0,b=0,c=0,d=0;   // a=都过 b=A过B不过 c=A不过B过 d=都不过
const rows=[];
for (const A of f100) {
  const B = byId.get(A.id); if(!B) continue;
  const ja = judge({raw:A.raw, ctx:A.ctx, draft:(A.draft||'').trim()});
  const jb = judge({raw:B.raw, ctx:B.ctx, draft:(B.draft||'').trim()});
  const pa = ja.gaugeable && ja.pass, pb = jb.gaugeable && jb.pass;
  if(pa&&pb)a++; else if(pa&&!pb)b++; else if(!pa&&pb)c++; else d++;
  rows.push({id:A.id, A, B, ja, jb, pa, pb});
}
const n=a+b+c+d, Po=(a+d)/n;
const pA=(a+b)/n, pB=(a+c)/n, Pe=pA*pB+(1-pA)*(1-pB);
const kappa=(Po-Pe)/(1-Pe);
console.log('过门 2x2: 都过',a,'A过B不过',b,'A不过B过',c,'都不过',d);
console.log('单次过门率 A',+(pA).toFixed(3),'B',+(pB).toFixed(3));
console.log('观察一致率 Po',+Po.toFixed(3),'| 偶然一致 Pe',+Pe.toFixed(3),'| Cohen kappa',+kappa.toFixed(3));

// 2) 翻转由哪道门造成
const gateFlip={};
for (const r of rows) {
  if (r.pa === r.pb) continue;
  const onlyA = r.ja.failed.filter(x=>!r.jb.failed.includes(x));
  const onlyB = r.jb.failed.filter(x=>!r.ja.failed.includes(x));
  for (const g of new Set([...onlyA, ...onlyB])) gateFlip[g]=(gateFlip[g]||0)+1;
}
console.log('翻转涉及的门:', JSON.stringify(gateFlip));

// 3) 语言：同一输入的两次输出，中文占比
const zhf = s => { const t=(s||''); return t.length? (t.match(/[\u4e00-\u9fff]/g)||[]).length/t.length : 0; };
const zhA=[], zhB=[], langSwitch=[];
for (const r of rows) { const x=zhf(r.A.draft), y=zhf(r.B.draft); zhA.push(x); zhB.push(y);
  if ((x>0.15)!==(y>0.15)) langSwitch.push({id:r.id, A:+x.toFixed(3), B:+y.toFixed(3)}); }
const q=(arr,p)=>{const s=[...arr].sort((x,y)=>x-y);return s[Math.floor(s.length*p)]??0};
console.log('中文占比 A: p10',+q(zhA,.1).toFixed(3),'p50',+q(zhA,.5).toFixed(3),'p90',+q(zhA,.9).toFixed(3));
console.log('中文占比 B: p10',+q(zhB,.1).toFixed(3),'p50',+q(zhB,.5).toFixed(3),'p90',+q(zhB,.9).toFixed(3));
console.log('语言切换的条数', langSwitch.length, JSON.stringify(langSwitch.slice(0,10)));

// 4) raw 的语言（确认输入到底是什么语言）
const zhRaw = rows.map(r=>zhf(r.A.raw));
console.log('raw 中文占比 p50', +q(zhRaw,.5).toFixed(3), 'p90', +q(zhRaw,.9).toFixed(3));
