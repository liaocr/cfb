// tools/build-change-dataset.mjs —— 造「改动候选 → 金标方向」数据集（微模型判读头的监督出口，$0）
// 用途：记录当前通过内容审计、且具备有效谱系的金标所能提供的方向监督规模；历史 11 条记录已被污染审计否定，不纳入训练或评估。
// 用法：node tools/build-change-dataset.mjs [--out transfer/models/change-candidate-dataset.json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGold, goldUse, goldTrainOk } from './helpers/three-mode.mjs'
import { isMode1GoldEligible } from './helpers/mode1-quality.mjs'
import { slotsOf, anchorsOf } from './helpers/hand-draft.mjs'
import { mineChangeCandidates, parseGoldDirections, candidateFeatures, CHANGE_FEATURE_NAMES } from './helpers/mine-change.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEV_FAMS = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
const argOut = process.argv.indexOf('--out')
const OUT = path.resolve(ROOT, argOut >= 0 ? process.argv[argOut + 1] : 'transfer/models/change-candidate-dataset.json')

const toks = (s) => new Set([...anchorsOf(s)].map((x) => x.toLowerCase()))
const overlap = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.min(A.size, B.size) }

// 用途隔离（v14.21.0）：金标注册表默认全是标尺料（use=ruler），这里只能吃显式放行成 train/both 的条目
const activeGold = loadGold(path.join(ROOT, 'transfer/gold')).filter(goldTrainOk)   // 被尺子降级的也收进来当料（降级不等于作废）
const contaminatedGoldExcluded = activeGold.filter((g) => !isMode1GoldEligible(g) || g.qualityAudit?.status !== 'clean').length
const gold = activeGold.filter((g) => isMode1GoldEligible(g) && g.qualityAudit?.status === 'clean'
  && ['dev', 'holdout'].includes(g.split)
  && (g.split !== 'dev' || DEV_FAMS.has(String(g.family || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, ''))))
  .map((g) => ({ ...g, hand: g.draft || g.gold || g.hand || '' }))
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
    split: g.split,
    goldDirections: dirs.map((d) => ({ from: d.from.slice(0, 200), to: d.to.slice(0, 200) })),
    candidates: rows.length, positives: rows.filter((r) => r.label).length, rows,
  })
}
const dev = items.filter((i) => i.split === 'dev'), hold = items.filter((i) => i.split === 'holdout')
const report = {
  schema: 'cfb.change-candidate-dataset/1',
  at: new Date().toISOString(),
  purpose: '仅对当前内容审计 clean、已验证、谱系允许的金标记录候选方向监督规模；报告是描述性数据，不构成效果或晋级证据',
  featureNames: CHANGE_FEATURE_NAMES,
  stats: {
    activeGoldItems: activeGold.length, contaminatedOrUnreviewedGoldExcluded: contaminatedGoldExcluded,
    items: items.length, devItems: dev.length, holdoutItems: hold.length,
    candidates: items.reduce((a, x) => a + x.candidates, 0),
    positives: items.reduce((a, x) => a + x.positives, 0),
    devPositives: dev.reduce((a, x) => a + x.positives, 0), holdoutPositives: hold.reduce((a, x) => a + x.positives, 0),
    itemsWithDirections: items.filter((x) => x.goldDirections.length).length,
    itemsWithUsableLabels: items.filter((x) => x.positives).length,
    itemsWithNoCandidates: items.filter((x) => !x.candidates).length,
  },
  limitations: [
    `当前经过本轮污染审计的金标仅 ${gold.length} 条；不足以支持跨家族结论或确认性评估`,
    '历史 11 条金标及其旧基准结论已失效；只有重新独立采集的 clean 家族数据才可建立新的证据',
  ],
  items,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`change-candidate-dataset → ${path.relative(ROOT, OUT)}`)
console.log(JSON.stringify(report.stats))
