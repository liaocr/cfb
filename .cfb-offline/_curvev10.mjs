
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';
const D = '.cfb-offline/kaggle-out/v10/rwkv7-compressor/';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const tById = new Map(dev.map(d=>[d.id,d]));
const files = [['step72','dev-generations-step72.jsonl'],['step144','dev-generations-step144.jsonl'],
               ['step216','dev-generations-step216.jsonl'],['final(288)','dev-generations.jsonl']];
console.log('行键:', Object.keys(rd(D+'dev-generations.jsonl')[0]).join(','));
console.log('');
console.log('档'.padEnd(12)+'n'.padEnd(5)+'学生过门'.padEnd(11)+'教师过门'.padEnd(11)+'学生软分'.padEnd(11)+'G1门后'.padEnd(10)+'S3决策'.padEnd(9)+'S7顺序'.padEnd(9)+'平均字数');
for (const [name, f] of files) {
  const rows = rd(D+f);
  let sP=0,sG=0,tP=0,tG=0,sS=[],tS=[],s3=[],t3=[],s7=[],t7=[],ch=[];
  for (const g of rows) {
    const d = tById.get(g.id); if(!d) continue;
    const sd = String(g.draft||'');
    const jt = judge({raw:d.raw, ctx:d.ctx, draft:d.assistant});
    const gg = guardDraft(d.raw, d.ctx, sd, {mode:'strip'});
    const js = judge({raw:d.raw, ctx:d.ctx, draft:gg.draft});
    if (jt.gaugeable){tG++; if(jt.pass)tP++; tS.push(jt.score); t3.push(jt.sub.S3_decisionCoverage); t7.push(jt.sub.S7_orderPreserved);}
    if (js.gaugeable){sG++; if(js.pass)sP++; sS.push(js.score); s3.push(js.sub.S3_decisionCoverage); s7.push(js.sub.S7_orderPreserved);}
    ch.push(gg.draft.length);
  }
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  console.log(name.padEnd(12)+String(rows.length).padEnd(5)
    +((sP+'/'+sG)+' '+(sG?(sP/sG*100).toFixed(0):'-')+'%').padEnd(11)
    +((tP+'/'+tG)+' '+(tG?(tP/tG*100).toFixed(0):'-')+'%').padEnd(11)
    +avg(sS).toFixed(4).padEnd(11)+avg(sS).toFixed(4).padEnd(10)
    +avg(s3).toFixed(3).padEnd(9)+avg(s7).toFixed(3).padEnd(9)+Math.round(avg(ch)));
}
