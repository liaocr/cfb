
import fs from 'node:fs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const f100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const f30  = rd('.cfb-offline/teacher/v4-30.jsonl');
const v30  = rd('.cfb-offline/teacher/v5-30.jsonl');
const byId = new Map(full.map(o=>[o.id,o]));

function cmp(pairs, label) {
  const d = [];
  for (const a of pairs) {
    const b = byId.get(a.id); if (!b) continue;
    d.push((a.usage?.prompt||0) - (b.usage?.prompt||0));
  }
  const uniq = [...new Set(d)];
  console.log(label + ': n=' + d.length + ' 差值种类=' + JSON.stringify(uniq.slice(0,8)) +
              ' 全等=' + (uniq.length===1 && uniq[0]===0));
  return d;
}
cmp(f100, 'v4-100 vs v4-full 的 usage.prompt 差');
cmp(f30,  'v4-30  vs v4-full 的 usage.prompt 差');
cmp(v30,  'v5-30  vs v4-full 的 usage.prompt 差');

// raw/ctx 是否逐字相同（排除"同一 id 但内容不同"）
let sameRaw=0, sameCtx=0, n=0;
for (const a of f100) { const b=byId.get(a.id); if(!b) continue; n++;
  if (a.raw===b.raw) sameRaw++; if (a.ctx===b.ctx) sameCtx++; }
console.log('v4-100 vs v4-full: raw 相同 ' + sameRaw + '/' + n + ' · ctx 相同 ' + sameCtx + '/' + n);
