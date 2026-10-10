
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft, g1Spans } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));
const rows = dev.map(d=>({d, s: (gById.get(d.id)||{}).draft || ''})).filter(r=>r.s!==undefined);
console.log('n =', rows.length);

const modes = ['off','strip','drop','sentence'];
const res = {};
for (const mode of modes) {
  const per = [];
  for (const {d, s} of rows) {
    const g = guardDraft(d.raw, d.ctx, s, {mode});
    const j = judge({raw:d.raw, ctx:d.ctx, draft:g.draft});
    per.push({id:d.id, gaugeable:j.gaugeable, pass:j.pass, failed:j.failed, score:j.score, tok:j.detail.compression.tokenRatio, chars:g.draft.length, hits:g.hits, changed:g.changed, invented:g.invented||[]});
  }
  const G = per.filter(r=>r.gaugeable);
  const p = G.filter(r=>r.pass).length;
  const mean = a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4):0;
  const p50 = a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*0.5)]:null};
  const fc={}; for(const r of G) for(const f of r.failed) fc[f]=(fc[f]||0)+1;
  res[mode] = { gaugeable:G.length, pass:p, rate:+(p/G.length).toFixed(4), soft:mean(G.map(r=>r.score)),
    tokP50:p50(G.map(r=>r.tok)), charsP50:p50(G.map(r=>r.chars)),
    hits:per.filter(r=>r.hits).length, changed:per.filter(r=>r.changed).length,
    empty:per.filter(r=>!r.chars).length, failCount:fc, per };
}
const t = judge({raw:rows[0].d.raw, ctx:rows[0].d.ctx, draft:rows[0].d.assistant});
// 教师基线（同一批 dev）
const tper = rows.map(({d})=>{const j=judge({raw:d.raw,ctx:d.ctx,draft:d.assistant}); return {gaugeable:j.gaugeable,pass:j.pass,score:j.score,tok:j.detail.compression.tokenRatio};});
const TG = tper.filter(r=>r.gaugeable);
const mean = a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4):0;
const p50 = a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*0.5)]:null};
console.log('教师基线（gaugeable '+TG.length+'）：过门', TG.filter(r=>r.pass).length, '软分', mean(TG.map(r=>r.score)), 'token比p50', p50(TG.map(r=>r.tok)));
console.log('');
console.log('mode      过门/73   通过率   软分     token比p50  字符p50  命中  改动  空稿');
for (const mode of modes) {
  const r = res[mode];
  console.log(mode.padEnd(10), String(r.pass+'/'+r.gaugeable).padEnd(9), (r.rate*100).toFixed(1)+'%'.padEnd(2), ' ', String(r.soft).padEnd(8), String(r.tokP50).padEnd(11), String(r.charsP50).padEnd(8), String(r.hits).padEnd(5), String(r.changed).padEnd(5), r.empty);
}
console.log('');
for (const mode of modes) {
  if (mode==='off') continue;
  const f = res[mode].failCount;
  console.log(mode+' 失败分布：', Object.entries(f).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' x'+v).join('、')||'（无）');
}
fs.writeFileSync('.cfb-offline/_g1guard.json', JSON.stringify(Object.fromEntries(Object.entries(res).map(([k,v])=>[k,{...v, per:v.per.map(x=>({...x}))}])), null, 1));
console.log('');
console.log('off 命中的行数（有凭空锚点）:', res.off.hits);
console.log('off 中只挂 G1 的学生条数:', res.off.per.filter(r=>r.gaugeable && r.failed.length===1 && r.failed[0]==='G1 quote-grounded').length);
