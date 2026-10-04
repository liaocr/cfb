// tools/build-change-dataset.mjs —— 造「改动候选 → 金标方向」数据集（微模型判读头的监督出口，$0）
// 用途：① 记录可用监督的真实规模（当前 11 条金标 → 19 正例 / 3 条可用条目）；
//      ② 作为教师标注（副模型）与后续微模型训练的输入格式；③ 训练器/评估器的公共入口。
// 用法：node tools/build-change-dataset.mjs [--out transfer/models/change-candidate-dataset.json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGold } from './helpers/three-mode.mjs'
import { slotsOf, anchorsOf } from './helpers/hand-draft.mjs'
import { mineChangeCandidates, parseGoldDirections, candidateFeatures, CHANGE_FEATURE_NAMES } from './helpers/mine-change.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEV_IDS = ['flaky-timeout_long-horizon-s0-r4','flaky-timeout-s0-r4','flaky-timeout-s0-r5','perf-regression-s0-r6','sse-truncated_decoy-s0-r3','sse-truncated_long-horizon-s0-r5','sse-truncated-s0-r5']
const argOut = process.argv.indexOf('--out')
const OUT = path.resolve(ROOT, argOut >= 0 ? process.argv[argOut + 1] : 'transfer/models/change-candidate-dataset.json')

const toks = (s) => new Set([...anchorsOf(s)].map((x) => x.toLowerCase()))
const overlap = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.min(A.size, B.size) }

const gold = loadGold(path.join(ROOT, 'transfer/gold')).map((g) => ({ ...g, hand: g.draft || g.gold || g.hand || '' }))
const items = []
for (const g of gold) {
  const hay = String(g.raw) + '\n' + String(g.ctx || '')
  const G = slotsOf(g.hand)
  const dirs = parseGoldDirections(G.decided || [], G.triples || [])
  const cands = mineChangeCandidates(hay)
  const rows = cands.map((c) => {
    const f = candidateFeatures(hay, c)
    const label = dirs.some((d) => overlap(c.old, d.from) >= 0.6 && overlap(c.nw, d.to) >= 0.6) ? 1 : 0
    return { kind: c.kind, old: c.old.slice(0, 200), new: c.nw.slice(0, 200), label, x: f.values }
  })
  items.push({
    id: g.id, family: g.family,
    split: DEV_IDS.includes(g.id) ? 'dev' : 'holdout',
    goldDirections: dirs.map((d) => ({ from: d.from.slice(0, 200), to: d.to.slice(0, 200) })),
    candidates: rows.length, positives: rows.filter((r) => r.label).length, rows,
  })
}
const dev = items.filter((i) => i.split === 'dev'), hold = items.filter((i) => i.split === 'holdout')
const report = {
  schema: 'cfb.change-candidate-dataset/1',
  at: new Date().toISOString(),
  purpose: '监督规模的真实记录：微模型要学「在候选改动里挑对方向」，当前 11 条金标能提供多少标注',
  featureNames: CHANGE_FEATURE_NAMES,
  stats: {
    items: items.length, devItems: dev.length, holdoutItems: hold.length,
    candidates: items.reduce((a, x) => a + x.candidates, 0),
    positives: items.reduce((a, x) => a + x.positives, 0),
    devPositives: dev.reduce((a, x) => a + x.positives, 0), holdoutPositives: hold.reduce((a, x) => a + x.positives, 0),
    itemsWithDirections: items.filter((x) => x.goldDirections.length).length,
    itemsWithUsableLabels: items.filter((x) => x.positives).length,
    itemsWithNoCandidates: items.filter((x) => !x.candidates).length,
  },
  limitations: [
    '可用监督只有 3 条条目 19 个正例；留出（4 条）正例为 0，无法在留出上评估方向挑选',
    '按条目留一的实测：3 条里 2 条选对（其中 1 条 p=0.05，近似运气）⇒ 现有规模训不出可信判读头',
    '4 条条目挖不到任何候选（eacces×2 / wrong-model_decoy / sse-r5）—— 候选挖掘本身在代码类改动上召回不足',
  ],
  items,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`change-candidate-dataset → ${path.relative(ROOT, OUT)}`)
console.log(JSON.stringify(report.stats))
