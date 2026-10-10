
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));

console.log('=== drop 模式前后对照（只挑「原本只挂 G1」的）===');
let shown=0;
for (const d of dev) {
  const s = (gById.get(d.id)||{}).draft||'';
  const j0 = judge({raw:d.raw,ctx:d.ctx,draft:s});
  if (!(j0.gaugeable && j0.failed.length===1 && j0.failed[0]==='G1 quote-grounded')) continue;
  const g = guardDraft(d.raw,d.ctx,s,{mode:'drop'});
  const j1 = judge({raw:d.raw,ctx:d.ctx,draft:g.draft});
  if (!j1.pass) continue;
  if (shown++ >= 3) continue;
  console.log('--- '+d.id+'  凭空锚点: '+JSON.stringify(g.invented)+'  删 '+g.removedChars+' 字 ---');
  console.log('前: '+s.slice(0,300).replace(/\n/g,' | '));
  console.log('后: '+g.draft.slice(0,300).replace(/\n/g,' | '));
  console.log('软分 '+j0.score+' -> '+j1.score+'   token比 '+j0.detail.compression.tokenRatio+' -> '+j1.detail.compression.tokenRatio);
  console.log('');
}

console.log('=== 教师全量 722：drop 前后 ===');
const full = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const stat = {off:{pass:0,gauge:0,soft:[],tok:[]}, drop:{pass:0,gauge:0,soft:[],tok:[]}};
const newlyPass = [];
for (const o of full) {
  const raw=o.raw, ctx=o.ctx, dr=o.draft;
  if (!dr || !dr.trim()) continue;
  const j0 = judge({raw,ctx,draft:dr});
  const g = guardDraft(raw,ctx,dr,{mode:'drop'});
  const j1 = judge({raw,ctx,draft:g.draft});
  stat.off.gauge += j0.gaugeable?1:0; stat.off.pass += j0.pass?1:0;
  stat.drop.gauge += j1.gaugeable?1:0; stat.drop.pass += j1.pass?1:0;
  if (j0.gaugeable) { stat.off.soft.push(j0.score); stat.off.tok.push(j0.detail.compression.tokenRatio); }
  if (j1.gaugeable) { stat.drop.soft.push(j1.score); stat.drop.tok.push(j1.detail.compression.tokenRatio); }
  if (j1.pass && !j0.pass) newlyPass.push(o.id);
}
const mean=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(4):0;
console.log('总行', full.length);
console.log('off  : gaugeable', stat.off.gauge, '过门', stat.off.pass, '软分', mean(stat.off.soft));
console.log('drop : gaugeable', stat.drop.gauge, '过门', stat.drop.pass, '软分', mean(stat.drop.soft));
console.log('新过门（原本不过）', newlyPass.length);
