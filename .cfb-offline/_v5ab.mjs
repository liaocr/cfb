
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
const rd = f => fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const v4 = rd('.cfb-offline/teacher/v4-30.jsonl');
const v5 = rd('.cfb-offline/teacher/v5-30.jsonl');
console.log('v4 n =', v4.length, '| v5 n =', v5.length);
const m5 = new Map(v5.map(o=>[o.id,o]));
const pairs = v4.filter(o=>m5.has(o.id));
console.log('配对 =', pairs.length, '| 同 id 同序:', v4.map(o=>o.id).join()===v5.map(o=>o.id).join());
const p50=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*0.5)]:null};
const mean=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4):0;
const G = {v4:[], v5:[]};
const per=[];
for (const a of pairs) {
  const b = m5.get(a.id);
  const ja = judge({raw:a.raw,ctx:a.ctx,draft:a.draft});
  const jb = judge({raw:b.raw,ctx:b.ctx,draft:b.draft});
  if (!ja.gaugeable) continue;
  G.v4.push({...ja, id:a.id}); G.v5.push({...jb, id:b.id});
  per.push({id:a.id, a:ja, b:jb, da:a.draft, db:b.draft});
}
const fc = (arr) => { const m={}; for(const j of arr) for(const f of j.failed) m[f]=(m[f]||0)+1; return m; };
const fmt=m=>Object.entries(m).sort((x,y)=>y[1]-x[1]).map(([k,v])=>k+' x'+v).join('、')||'（无）';
for (const k of ['v4','v5']) {
  const A=G[k]; const pass=A.filter(j=>j.pass).length;
  console.log(k+': gaugeable '+A.length+' | 过门 '+pass+' = '+(pass/A.length*100).toFixed(1)+'% | 软分 '+mean(A.map(j=>j.score))+' | token比p50 '+p50(A.map(j=>j.detail.compression.tokenRatio))+' | 字符p50 '+p50(A.map(j=>j.draftChars||0)));
  console.log('   失败：'+fmt(fc(A)));
  console.log('   软标准(压缩<=0.5且过门)：'+A.filter(j=>j.pass&&j.detail.compression.meetsTarget).length);
}
console.log('');
console.log('配对 4 格（v5 相对 v4）：都过', per.filter(p=>p.a.pass&&p.b.pass).length, '| 只v5过', per.filter(p=>!p.a.pass&&p.b.pass).length, '| 只v4过', per.filter(p=>p.a.pass&&!p.b.pass).length, '| 都不过', per.filter(p=>!p.a.pass&&!p.b.pass).length);
const w=per.filter(p=>p.b.score>p.a.score).length, l=per.filter(p=>p.b.score<p.a.score).length;
console.log('软分逐条：v5 赢', w, '输', l, '平', per.length-w-l);
// McNemar
const b01=per.filter(p=>!p.a.pass&&p.b.pass).length, b10=per.filter(p=>p.a.pass&&!p.b.pass).length;
console.log('McNemar 硬门 b='+b01+' c='+b10+' chi2='+((Math.abs(b01-b10)-1)**2/Math.max(1,b01+b10)).toFixed(3));
// 逐门对比
console.log('');
console.log('逐门命中  v4 -> v5');
for (const g of ['G1 quote-grounded','G3 anchors-kept','G4 actionable','G6 not-copy','G0 no-leverage']) {
  console.log('  '+g.padEnd(20), G.v4.filter(j=>j.failed.includes(g)).length, '->', G.v5.filter(j=>j.failed.includes(g)).length);
}
// 语言
const cjk = s => { const m=String(s).match(/[\u4e00-\u9fff]/g); return m?m.length/String(s).length:0 };
console.log('');
console.log('v4 稿中文字符占比 p50', p50(pairs.map(o=>+cjk(o.draft).toFixed(3))), '| v5', p50(v5.map(o=>+cjk(o.draft).toFixed(3))));
console.log('v4 字符 p50', p50(pairs.map(o=>o.draft.length)), '| v5 字符 p50', p50(v5.map(o=>o.draft.length)));
fs.writeFileSync('.cfb-offline/_v5ab.json', JSON.stringify({summary:{v4:{n:G.v4.length,pass:G.v4.filter(j=>j.pass).length,soft:mean(G.v4.map(j=>j.score))},v5:{n:G.v5.length,pass:G.v5.filter(j=>j.pass).length,soft:mean(G.v5.map(j=>j.score))}},per:per.map(p=>({id:p.id,aPass:p.a.pass,bPass:p.b.pass,aSoft:p.a.score,bSoft:p.b.score,aFail:p.a.failed,bFail:p.b.failed}))},null,1));
