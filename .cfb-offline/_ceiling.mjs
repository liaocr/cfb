
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';

const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const ev = JSON.parse(fs.readFileSync('.cfb-offline/kaggle-out/eval-sft.json','utf8'));
const byId = new Map(ev.rows.map(r=>[r.id,r]));
const GATES = ['G0 no-leverage','G1 quote-grounded','G2 locus-grounded','G3 anchors-kept','G4 actionable','G5 no-cause-inversion','G6 not-copy','G7 compressed'];
const has = (a,g)=>a.includes(g);

const rows = dev.map(d=>{
  const e = byId.get(d.id);
  const t = judge({raw:d.raw, ctx:d.ctx, draft:d.assistant});
  const s = judge({raw:d.raw, ctx:d.ctx, draft:e?e.studentDraft:''});
  return {id:d.id, repo:d.repo, rawLen:d.raw.length, ctxLen:d.ctx.length,
    tF:t.failed, sF:s.failed, tScore:t.score, sScore:s.score,
    tTok:t.detail.compression.tokenRatio, sTok:s.detail.compression.tokenRatio,
    tSub:t.sub, sSub:s.sub};
});

const out = {};
out.n = rows.length;
out.repro = { teacherPass: rows.filter(r=>r.tF.length===0).length, studentPass: rows.filter(r=>r.sF.length===0).length };

// G0 draft-independence
out.g0DraftIndependent = rows.filter(r=>has(r.tF,'G0 no-leverage')!==has(r.sF,'G0 no-leverage')).length;
const g0rows = rows.filter(r=>has(r.tF,'G0 no-leverage'));
out.g0rows = g0rows.length;
out.g0rawLen = { min: Math.min(...g0rows.map(r=>r.rawLen)), p50: g0rows.map(r=>r.rawLen).sort((a,b)=>a-b)[Math.floor(g0rows.length/2)], max: Math.max(...g0rows.map(r=>r.rawLen)) };
out.scoreable = rows.length - g0rows.length;

// ablation
out.ablation = GATES.map(g=>({
  gate: g,
  tHit: rows.filter(r=>has(r.tF,g)).length,
  sHit: rows.filter(r=>has(r.sF,g)).length,
  tGainIfRemoved: rows.filter(r=>r.tF.every(x=>x===g)).length,
  sGainIfRemoved: rows.filter(r=>r.sF.every(x=>x===g)).length,
  tPassSFail: rows.filter(r=>!has(r.tF,g)&&has(r.sF,g)).length,
  tFailSPass: rows.filter(r=>has(r.tF,g)&&!has(r.sF,g)).length,
}));

// minimal failing sets (teacher)
const sets = {};
for (const r of rows) if (r.tF.length) { const k = [...r.tF].sort().join(' + '); sets[k]=(sets[k]||0)+1; }
out.teacherFailSets = Object.entries(sets).sort((a,b)=>b[1]-a[1]).slice(0,14);

// only-G7 rows: soft score
const onlyG7 = rows.filter(r=>r.tF.length===1 && r.tF[0]==='G7 compressed');
out.onlyG7 = { n: onlyG7.length, tScoreMean: +(onlyG7.reduce((a,r)=>a+r.tScore,0)/Math.max(1,onlyG7.length)).toFixed(4),
  tTok: onlyG7.map(r=>r.tTok).sort((a,b)=>a-b).slice(0,5),
  minScore: Math.min(...onlyG7.map(r=>r.tScore)), maxScore: Math.max(...onlyG7.map(r=>r.tScore)) };

// G7 threshold sweep on scoreable set (exclude G0 rows from denominator)
const sc = rows.filter(r=>!has(r.tF,'G0 no-leverage'));
out.sweepOnScoreable = [0.40,0.45,0.50,0.55,0.60,0.70,0.85,1.01,99].map(T=>{
  const ok = (r,key,tok)=>{ let f=r[key].filter(x=>x!=='G7 compressed'); if (r.rawLen>=800 && tok>T) f.push('G7 compressed'); return f.length===0; };
  const tp = sc.filter(r=>ok(r,'tF',r.tTok)).length;
  const sp = sc.filter(r=>ok(r,'sF',r.sTok)).length;
  return { T, teacher:+ (tp/sc.length).toFixed(4), student:+ (sp/sc.length).toFixed(4) };
});

// soft score on scoreable
out.softOnScoreable = {
  teacher: +(sc.reduce((a,r)=>a+r.tScore,0)/sc.length).toFixed(4),
  student: +(sc.reduce((a,r)=>a+r.sScore,0)/sc.length).toFixed(4),
};
out.softAll = {
  teacher: +(rows.reduce((a,r)=>a+r.tScore,0)/rows.length).toFixed(4),
  student: +(rows.reduce((a,r)=>a+r.sScore,0)/rows.length).toFixed(4),
};

// sub-score breakdown on scoreable
const W = ['S1_anchorsKept','S2_groundingDensity','S3_decisionCoverage','S4_compressionGain','S5_tailRetention','S6_quoteFidelity'];
out.subOnScoreable = Object.fromEntries(W.map(k=>[k, {
  t: +(sc.reduce((a,r)=>a+r.tSub[k],0)/sc.length).toFixed(4),
  s: +(sc.reduce((a,r)=>a+r.sSub[k],0)/sc.length).toFixed(4),
}]));

fs.writeFileSync('.cfb-offline/_ceiling.json', JSON.stringify(out,null,1));
console.log('ok');
