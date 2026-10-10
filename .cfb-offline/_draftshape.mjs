
import fs from 'node:fs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(dev.map(d=>[d.id,d]));
const runs = {
  'v9(40步)':  '.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl',
  'v10(288步)':'.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl',
  'v10@72':    '.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations-step72.jsonl',
};
// 最长重复子串的粗测：找重复出现 >=3 次的最长 8-gram 比例
function rep(t, n=8) {
  const s = t.replace(/\s+/g,'');
  if (s.length < n*3) return 0;
  const c = new Map();
  for (let i=0;i+n<=s.length;i++){ const k=s.slice(i,i+n); c.set(k,(c.get(k)||0)+1); }
  let dup=0; for (const v of c.values()) if (v>=3) dup++;
  return dup / Math.max(1, c.size);
}
console.log('档'.padEnd(12)+'n'.padEnd(5)+'字数p50'.padEnd(9)+'结尾标点%'.padEnd(12)+'重复8gram%'.padEnd(12)+'以\\n\\n结尾%'.padEnd(11)+'空稿');
for (const [name,f] of Object.entries(runs)) {
  if(!fs.existsSync(f)) { console.log(name+' 缺'); continue; }
  const gen = rd(f);
  const L=[], goodEnd=0, repv=[], nn=[]; let empty=0;
  for (const g of gen) {
    const d = String(g.draft||'');
    if (!d.trim()) { empty++; continue; }
    L.push([...d].length);
    if (/[。！？.!?"')\]]$/.test(d.trimEnd())) goodEnd++;
    if (d.endsWith('\n\n')) nn.push(1);
    repv.push(rep(d));
  }
  L.sort((a,b)=>a-b); repv.sort((a,b)=>a-b);
  const p=(a,q)=>a.length?a[Math.floor(a.length*q)]:0;
  console.log(name.padEnd(12)+String(gen.length).padEnd(5)+String(p(L,0.5)).padEnd(9)
    +(100*goodEnd/gen.length).toFixed(0).padEnd(12)
    +(100*p(repv,0.5)).toFixed(1).padEnd(12)
    +(100*nn.length/gen.length).toFixed(0).padEnd(11)+empty);
}
console.log('\n=== 逐条对照（v10 最差 3 条 + 最好 1 条）===');
const v10 = rd(runs['v10(288步)']);
import { judge } from '../tools/gen-ruler.mjs';
const scored = v10.map(g=>{ const d=byId.get(g.id); const j=judge({raw:d.raw,ctx:d.ctx,draft:String(g.draft||'')}); return {g,d,j}; })
  .filter(x=>x.j.gaugeable).sort((a,b)=>a.j.score-b.j.score);
for (const x of [scored[0], scored[scored.length-1]]) {
  console.log('\n--- id ' + x.g.id + ' | 学生软分 ' + x.j.score.toFixed(3) + ' | 教师软分 ' + judge({raw:x.d.raw,ctx:x.d.ctx,draft:x.d.assistant}).score.toFixed(3));
  console.log('[教师 ' + [...x.d.assistant].length + ' 字] ' + x.d.assistant.slice(0,300).replace(/\n/g,' '));
  console.log('[学生 ' + [...String(x.g.draft)].length + ' 字] ' + String(x.g.draft).slice(0,300).replace(/\n/g,' '));
}
