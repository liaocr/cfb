
import fs from 'node:fs';
import { judge, norm, anchorsOf, hasAnchor, commandsOf, locusOf, loadAnchors } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gen = fs.readFileSync('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const gById = new Map(gen.map(g=>[g.id,g]));

const stat = {g3rows:0, g3paths:0, g3near:0, g3noNear:0, g3idFloor:0, g4rows:0, g4fab:0, g4noground:0, g4noPathNoCmd:0};
const ex3=[], ex4=[];
for (const d of dev) {
  const s0 = (gById.get(d.id)||{}).draft||'';
  const g = guardDraft(d.raw, d.ctx, s0, {mode:'strip'});
  const j = judge({raw:d.raw, ctx:d.ctx, draft:g.draft});
  if (!j.gaugeable) continue;
  if (j.failed.includes('G3 anchors-kept')) {
    stat.g3rows++;
    const load = loadAnchors(d.raw, d.ctx);
    const loadPaths = load.filter(a=>/\w\.\w/.test(a)||a.includes('/'));
    const loadIds = load.filter(a=>!(/\w\.\w/.test(a)||a.includes('/')));
    const lostPaths = loadPaths.filter(a=>!hasAnchor(g.draft, a));
    const retIds = loadIds.length ? loadIds.filter(a=>hasAnchor(g.draft,a)).length/loadIds.length : 1;
    stat.g3paths += lostPaths.length;
    if (lostPaths.length) stat.g3rows;
    // 丢失的路径在 raw 里有没有近似串（说明是改写还是真丢）
    const evA = anchorsOf(d.raw+'\n'+d.ctx);
    for (const p of lostPaths) {
      const near = evA.some(b=>b!==p && (b.includes(p)||p.includes(b)));
      if (near) stat.g3near++; else stat.g3noNear++;
    }
    if (!lostPaths.length && retIds < 0.5) stat.g3idFloor++;
    if (ex3.length<8) ex3.push({id:d.id, lostPaths:lostPaths.slice(0,4), idRet:+retIds.toFixed(2), nIds:loadIds.length, nPaths:loadPaths.length});
  }
  if (j.failed.includes('G4 actionable')) {
    stat.g4rows++;
    const cmds = commandsOf(g.draft), cmdsEv = commandsOf(d.raw+'\n'+d.ctx);
    const fab = cmds.filter(c=>!norm(d.raw+'\n'+d.ctx).includes(c));
    const anyPath = (norm(g.draft).match(/[\w/][\w./\\-]*\.(?:mjs|js|mts|ts|tsx|json|jsonl|log|md|py|sh|yml|yaml|toml|txt)/g)||[]).some(p=>norm(d.raw+'\n'+d.ctx).includes(p));
    if (fab.length) stat.g4fab++;
    else if (!anyPath) stat.g4noPathNoCmd++;
    if (ex4.length<8) ex4.push({id:d.id, cmdsDraft:cmds.slice(0,3), cmdsEv:cmdsEv.slice(0,3), fab:fab.slice(0,3), anyPath});
  }
}
console.log('=== G3 失败（过 G1 门之后）===');
console.log(JSON.stringify(stat, null, 1));
console.log(JSON.stringify(ex3, null, 1));
console.log('=== G4 失败（过 G1 门之后）===');
console.log(JSON.stringify(ex4, null, 1));
