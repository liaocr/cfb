
import fs from 'node:fs';
import { judge, RULER_VERSION } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const gen = rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl');
const gById = new Map(gen.map(g=>[g.id,g]));
console.log('尺子', RULER_VERSION, '| dev', dev.length, '| v9 生成', gen.length);

function run(guard) {
  let tG=0,tP=0,sG=0,sP=0,tS=[],sS=[];
  let sMark=[], tMark=[], sOrd=[], tOrd=[];
  const sFail={}, tFail={};
  for (const d of dev) {
    const jt = judge({raw:d.raw, ctx:d.ctx, draft:d.assistant});
    let sd = (gById.get(d.id)||{}).draft || '';
    if (guard) sd = guardDraft(d.raw, d.ctx, sd, {mode:'strip'}).draft;
    const js = judge({raw:d.raw, ctx:d.ctx, draft:sd});
    if (jt.gaugeable) { tG++; if (jt.pass) tP++; tS.push(jt.score); tMark.push(jt.sub.S3_decisionCoverage); tOrd.push(jt.sub.S7_orderPreserved);
      for (const f of jt.failed) tFail[f]=(tFail[f]||0)+1; }
    if (js.gaugeable) { sG++; if (js.pass) sP++; sS.push(js.score); sMark.push(js.sub.S3_decisionCoverage); sOrd.push(js.sub.S7_orderPreserved);
      for (const f of js.failed) sFail[f]=(sFail[f]||0)+1; }
  }
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  console.log('\n'+(guard?'【过 G1 门】':'【原始】'));
  console.log('  教师 %d/%d = %s · 软分 %s', tP, tG, (tP/tG*100).toFixed(1)+'%', avg(tS).toFixed(4));
  console.log('  学生 %d/%d = %s · 软分 %s', sP, sG, (sP/sG*100).toFixed(1)+'%', avg(sS).toFixed(4));
  console.log('  S3 决策覆盖 教师 %s / 学生 %s', avg(tMark).toFixed(3), avg(sMark).toFixed(3));
  console.log('  S7 顺序     教师 %s / 学生 %s', avg(tOrd).toFixed(3), avg(sOrd).toFixed(3));
  console.log('  教师失败项', JSON.stringify(tFail));
  console.log('  学生失败项', JSON.stringify(sFail));
}
run(false);
run(true);
