import fs from 'node:fs'
import { scoreUnitWithWeights, scoreDraftPreferenceFeatures, loadV5MicroWeights, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'
const repo = '/home/user/cfb'
const ds = JSON.parse(fs.readFileSync(`${repo}/transfer/models/micro-dev-dataset.json`,'utf8'))
const fam = v => String(v||'').replace(/^pool:/,'').split(':',1)[0]
const U = ds.unitSamples
const mk = i => ({ vec: U[i].features, tok: U[i].tokenCount, temptationT: U[i].temptationT ?? U[i].features[9], cueExcluded: U[i].features[15] })
console.log('— 单元对读数（生产权重，应与历史 24/33, 20/39, 27/97 一致）—')
for (const f of ['flaky-timeout','perf-regression','sse-truncated']) {
  let ok=0,n=0
  for (const p of ds.unitStepPairs) { if (!p.trainingEligible||fam(p.family)!==f||!p.lengthMatch) continue
    const w=scoreUnitWithWeights(mk(p.winIdx),V5_MICRO_WEIGHTS), l=scoreUnitWithWeights(mk(p.loseIdx),V5_MICRO_WEIGHTS); ok+=w.v>l.v?1:0; n++ }
  console.log(`   ${f}: ${ok}/${n}`)
}
console.log('— draft 读数（judge 权重，带 prefMlpHead；验证我的顺序修复不改变读数）—')
const judge = loadV5MicroWeights(`${repo}/transfer/models/v5-micro-weights.judge-4764fd2.json`)
let ok=0,n=0
for (const p of ds.stepSimpoPairs) { if (!p.trainingEligible) continue
  const c=scoreDraftPreferenceFeatures(p.chosenPref,judge), r=scoreDraftPreferenceFeatures(p.rejectedPref,judge); ok+=c>r?1:0; n++ }
console.log(`   judge 在 dev draft 对上: ${ok}/${n} = ${(ok/n).toFixed(4)}`)
console.log('— 键顺序脆弱性修复的有效性检验：人为重排 prefWeights 的键，读数必须不变 —')
const shuffled = { ...judge, prefWeights: Object.fromEntries(Object.entries(judge.prefWeights).reverse()) }
let ok2=0
for (const p of ds.stepSimpoPairs) { if (!p.trainingEligible) continue
  const c=scoreDraftPreferenceFeatures(p.chosenPref,shuffled), r=scoreDraftPreferenceFeatures(p.rejectedPref,shuffled); ok2+=c>r?1:0 }
console.log(`   键序打乱后: ${ok2}/${n} ${ok2===ok?'（一致 ✓ 修复生效）':'（不一致 ✗ 仍有顺序依赖）'}`)
