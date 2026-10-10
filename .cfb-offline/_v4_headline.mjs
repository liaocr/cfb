
import fs from 'node:fs';
import { judge, RULER_VERSION, COMPRESSION_TARGET } from '../tools/gen-ruler.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const evj = JSON.parse(fs.readFileSync('.cfb-offline/kaggle-out/eval-sft.json','utf8'));
const byId = new Map(evj.rows.map(r=>[r.id,r]));

const rows = dev.map(d=>{
  const e = byId.get(d.id);
  const t = judge({raw:d.raw, ctx:d.ctx, draft:d.assistant});
  const s = judge({raw:d.raw, ctx:d.ctx, draft:e?e.studentDraft:''});
  return {id:d.id, t, s};
});
const n = rows.length;
const g = rows.filter(r=>r.t.gaugeable);
console.log('尺子', RULER_VERSION, '| COMPRESSION_TARGET', COMPRESSION_TARGET);
console.log('n =', n, '| gaugeable =', g.length, '| ungaugeable =', n-g.length);
const mism = rows.filter(r=>r.t.gaugeable!==r.s.gaugeable).length;
console.log('gaugeable 教师/学生不一致数 =', mism, '(必须是 0)');
const rate=(x,d)=>((x/d)*100).toFixed(1)+'%';
const tAll=rows.filter(r=>r.t.pass).length, sAll=rows.filter(r=>r.s.pass).length;
const tG=g.filter(r=>r.t.pass).length, sG=g.filter(r=>r.s.pass).length;
console.log('全体   教师', tAll+'/'+n, rate(tAll,n), ' 学生', sAll+'/'+n, rate(sAll,n));
console.log('受力点 教师', tG+'/'+g.length, rate(tG,g.length), ' 学生', sG+'/'+g.length, rate(sG,g.length));
const mean=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4):0;
console.log('软分(受力点) 教师', mean(g.map(r=>r.t.score)), ' 学生', mean(g.map(r=>r.s.score)));
console.log('软分(全体)   教师', mean(rows.map(r=>r.t.score)), ' 学生', mean(rows.map(r=>r.s.score)));
// 压缩软标准
const tT=g.filter(r=>!(r.t.advisory||[]).some(a=>a.startsWith('C1')) && r.t.pass).length;
const sT=g.filter(r=>!(r.s.advisory||[]).some(a=>a.startsWith('C1')) && r.s.pass).length;
console.log('软标准(过门+压缩<=0.5) 教师', tT, rate(tT,g.length), ' 学生', sT, rate(sT,g.length));
const p50=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*0.5)]:null};
console.log('token比 p50  教师', p50(rows.map(r=>r.t.detail.compression.tokenRatio)), ' 学生', p50(rows.map(r=>r.s.detail.compression.tokenRatio)));
const tOver=g.filter(r=>r.t.detail.compression.overRaw).length, sOver=g.filter(r=>r.s.detail.compression.overRaw).length;
console.log('比原文还长(受力点) 教师', tOver, ' 学生', sOver);
// 四格
const both=g.filter(r=>r.t.pass&&r.s.pass).length, so=g.filter(r=>!r.t.pass&&r.s.pass).length;
const to=g.filter(r=>r.t.pass&&!r.s.pass).length, ne=g.length-both-so-to;
console.log('四格(受力点)：都过',both,'只学生过',so,'只教师过',to,'都不过',ne);
// 软分逐条
const w=g.filter(r=>r.s.score>r.t.score).length, l=g.filter(r=>r.s.score<r.t.score).length;
console.log('软分逐条：学生赢',w,'输',l,'平',g.length-w-l);
// 失败分布
const fc=k=>{const m={};for(const r of g)for(const f of r[k].failed)m[f]=(m[f]||0)+1;return Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' x'+v).join('、')||'（无）'};
console.log('教师失败：', fc('t'));
console.log('学生失败：', fc('s'));
const ac=k=>{const m={};for(const r of g)for(const a of r[k].advisory){const p=a.split(' ')[0];m[p]=(m[p]||0)+1}return Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' x'+v).join('、')||'（无）'};
console.log('教师软标准：', ac('t'));
console.log('学生软标准：', ac('s'));
