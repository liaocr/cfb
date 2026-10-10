
import fs from 'node:fs';
const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gm=new Map(gen.map(g=>[g.id,g]));
const MARK='\n\n[\u601d\u8003\u8fc7\u7a0b]\n';
let bad=0, ctxBad=0;
for(const d of dev){ const g=gm.get(d.id); const i=d.user.indexOf(MARK);
  const raw=d.user.slice(i+MARK.length); const ctx=d.user.slice('[\u9898\u9762]\n'.length, i);
  if(g.raw!==raw) bad++; if(g.ctx!==ctx) ctxBad++; }
console.log('raw 不一致', bad, '| ctx 不一致', ctxBad, '| MARK.length', MARK.length);
