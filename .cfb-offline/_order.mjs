
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const short = rd('.cfb-offline/ruler/raw-mine-shortlist.jsonl');
const pos = new Map(short.map((o,i)=>[o.unitId,i]));
const S = new Set(short.map(o=>o.unitId));
console.log('v4-full 的 722 条都在当前短名单里:', full.every(o=>S.has(o.id)));
console.log('v4-full 在短名单里的位置: 最小', Math.min(...full.map(o=>pos.get(o.id))), '最大', Math.max(...full.map(o=>pos.get(o.id))));
console.log('是不是连续区间:', (()=>{const p=full.map(o=>pos.get(o.id)).sort((a,b)=>a-b);return p[p.length-1]-p[0]+1===p.length})());
console.log('短名单前 5 id:', short.slice(0,5).map(o=>o.unitId));
console.log('v4-full 前 5 id:', full.slice(0,5).map(o=>o.id));

// 短名单是否按某字段排序？
const f = ['teachScore','rawChars','proseRatio','fenceRatio'];
for (const k of f) {
  const v = short.map(o=>o[k]);
  const num = v.every(x=>typeof x==='number');
  if (!num) { console.log(k,'非数值'); continue; }
  let inc=0, dec=0;
  for (let i=1;i<v.length;i++){ if(v[i]>=v[i-1])inc++; else dec++; }
  console.log(k+': 递增 '+inc+' 递减 '+dec+' / '+(v.length-1));
}

// 过门率 vs 短名单位置（按 722 条在短名单中的位置分十档）
const rows = full.map(o=>({p:pos.get(o.id), o})).filter(r=>r.p!=null).sort((a,b)=>a.p-b.p);
const dec = 10, per = Math.ceil(rows.length/dec);
console.log('\n按短名单位置分档的教师过门率:');
for (let i=0;i<dec;i++){
  const seg = rows.slice(i*per,(i+1)*per); if(!seg.length) continue;
  let g=0,ps=0;
  for (const r of seg){ const j=judge({raw:r.o.raw,ctx:r.o.ctx,draft:(r.o.draft||'').trim()});
    if(j.gaugeable){g++; if(j.pass)ps++;} }
  console.log('  档'+i+' 位置'+seg[0].p+'-'+seg[seg.length-1].p+' n='+seg.length+' 过门率'+(g?(ps/g).toFixed(3):'n/a'));
}
