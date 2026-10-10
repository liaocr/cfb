
import fs from 'node:fs';
import { judge, RULER_VERSION } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const tById = new Map(dev.map(d=>[d.id,d]));
const runs = {
  'v9 (256行/4轮)':  '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl',
  'v10 (412行/24轮)':'.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl',
};
console.log('尺子', RULER_VERSION, '| dev', dev.length, '\n');
console.log('轮次'.padEnd(20)+'学生过门'.padEnd(13)+'过G1门'.padEnd(12)+'学生软分'.padEnd(11)+'S3决策'.padEnd(9)+'S7顺序'.padEnd(9)+'字数');
for (const [name, f] of Object.entries(runs)) {
  if (!fs.existsSync(f)) { console.log(name+' 缺文件'); continue; }
  const rows = rd(f);
  let sP=0,gP=0,sG=0,tP=0,tG=0,sS=[],s3=[],s7=[],ch=[];
  for (const g of rows) {
    const d = tById.get(g.id); if(!d) continue;
    const jt = judge({raw:d.raw,ctx:d.ctx,draft:d.assistant});
    const gg = guardDraft(d.raw, d.ctx, String(g.draft||''), {mode:'strip'});
    const js = judge({raw:d.raw,ctx:d.ctx,draft:gg.draft});
    if (jt.gaugeable){tG++; if(jt.pass)tP++;}
    if (js.gaugeable){sG++; if(js.pass)sP++; if(gg.draft===String(g.draft||'')){} 
      const raw = judge({raw:d.raw,ctx:d.ctx,draft:String(g.draft||'')});
      if (raw.pass) gP++;
      sS.push(js.score); s3.push(js.sub.S3_decisionCoverage); s7.push(js.sub.S7_orderPreserved); ch.push(gg.draft.length);}
  }
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  console.log(name.padEnd(20)+((sP+'/'+sG)+' '+(sP/sG*100).toFixed(1)+'%').padEnd(13)
    +((gP+'/'+sG)+' '+(gP/sG*100).toFixed(1)+'%').padEnd(12)
    +avg(sS).toFixed(4).padEnd(11)+avg(s3).toFixed(3).padEnd(9)+avg(s7).toFixed(3).padEnd(9)+Math.round(avg(ch)));
}
console.log('\n（教师同 89 条基线：55/73 = 75.3%）');
