// tools/helpers/ruler.mjs —— 闭环 v4「尺子」：任意时刻有效的采纳检验（e 值）、三层度量的效度账本、留出题曝光退役。
//
// 问题（v3 评审第 1 条）：A/A 只证明尺子**对称**（不偏向某一臂），不证明尺子**有效**（量的是不是「任务真的解决了」）。
// v4 的办法：
//   L1 = 下一步结构分（真模型读稿后的动作：next+avoid−falseDone−bump−reEdit−repeat；13 请求/轮）—— 便宜的代理尺
//   L2 = 端到端结局（tools/traj-run.mjs 的全轨迹：修好 / 到修好的轮数 / 假宣称 / 重复 / 修好后验收 / tokens）—— 理论 S9 的终局度量
//   效度账本：每个既被 L1 打过分、又跑到 L2 结局的样本 → (proxy, outcome) 一对；AUC(L1→修好) 及其自助 CI 决定尺子状态
//   unvalidated / valid / suspect / invalid；L1 单独采纳只能是 provisional，L2 确认后才 confirmed；invalid 时 L1 退为预筛。
// 统计（v3 评审第 2 条）：固定阈值 Beta 后验在反复看数据时没有类型 I 保证；v4 用 e 值（testing by betting）：
//   H0: p ≤ 0.5 vs H1: p > 0.5，先验 q ~ Uniform(0.5,1)，E_n = 2^{n+1}·B(w+1,l+1)·[1 − I_{0.5}(w+1,l+1)]，任意停时 P_H0(E ≥ 1/α) ≤ α。
import { betaCdf, sequentialPaired, taskTally, distinctRecord, effectiveN, DEFAULT_DESIGN_V3 } from './experiment.mjs'

// ── 1. e 值 ────────────────────────────────────────────────────────────────
function lgamma(x) {
  // Lanczos (g=7, n=9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]; const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
const lnBeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b)
/** 单边 e 值：胜 w 负 l（平局不计）；E ≥ 1/α ⇒ 在任意停时下以 α 的类型 I 误差拒绝 H0: p ≤ 0.5。 */
export function eValueWins(wins, losses) {
  const w = Math.max(0, wins | 0), l = Math.max(0, losses | 0), n = w + l
  if (!n) return 1
  const tail = 1 - betaCdf(0.5, w + 1, l + 1)
  return Math.exp((n + 1) * Math.LN2 + lnBeta(w + 1, l + 1)) * tail
}
/** 达到 E ≥ 1/α 最少需要连胜几场（给人看预算）。 */
export function winsNeeded(alpha, losses = 0) { for (let w = 0; w <= 60; w++) if (eValueWins(w, losses) >= 1 / alpha) return w; return null }

// ── 2. v4 判定：e 值 + 留出闸门 + provisional/confirmed ─────────────────────
export const DEFAULT_DESIGN_V4 = Object.freeze({ ...DEFAULT_DESIGN_V3, alphaHoldout: 0.1, alphaAll: 0.1, alphaReject: 0.1, maxPairs: 30, minHoldoutTasks: 2 })
/**
 * pairs: [{task, outcome: win|loss|tie, split?}]；split: {task → dev|holdout}；aa: 校准轮。
 * 决策：adopt-provisional（L1 证据够，待 L2 确认）| reject | continue | stop-undecided | calibrated。
 */
export function decideV4({ pairs, split = {}, design = DEFAULT_DESIGN_V4, aa = false }) {
  const all = sequentialPaired(pairs.map((p) => p.outcome))
  const hold = pairs.filter((p) => (p.split || split[p.task]) === 'holdout'), dev = pairs.filter((p) => (p.split || split[p.task]) !== 'holdout')
  const h = sequentialPaired(hold.map((p) => p.outcome)), d = sequentialPaired(dev.map((p) => p.outcome))
  const e = { all: +eValueWins(all.wins, all.losses).toFixed(3), holdout: +eValueWins(h.wins, h.losses).toFixed(3), reject: +eValueWins(all.losses, all.wins).toFixed(3) }
  const record = distinctRecord(hold), nEff = effectiveN(pairs, design.icc)
  const base = { all, dev: dev.length ? d : null, holdout: hold.length ? h : null, holdoutRecord: record, e, nEff, thresholds: { adopt: +(1 / design.alphaHoldout).toFixed(1), reject: +(1 / design.alphaReject).toFixed(1) }, replicatesPerTask: Object.values(taskTally(pairs)).map((t) => t.n) }
  if (aa) {
    const tieRate = pairs.length ? +(pairs.filter((p) => p.outcome === 'tie').length / pairs.length).toFixed(3) : null
    const winRate = pairs.length ? +(pairs.filter((p) => p.outcome === 'win').length / pairs.length).toFixed(3) : null
    const suspect = pairs.length >= 4 && Math.abs(all.pWin - 0.5) > design.aaSuspectBand / 2
    return { ...base, decision: 'calibrated', tieRate, winRate, instrument: suspect ? 'instrument-suspect' : 'ok', why: suspect ? '两臂同文却一边倒：通道 / 顺序 / 判据偏置，先修仪器' : 'A/A 在噪声带内（只证明对称，不证明有效；有效看 rulerValidity）' }
  }
  if (e.reject >= 1 / design.alphaReject) return { ...base, decision: 'reject', why: `全部配对的「更差」e 值 ${e.reject} ≥ ${base.thresholds.reject}（α=${design.alphaReject}，任意停时有效）` }
  const missing = []
  if (record.tasks < design.minHoldoutTasks) missing.push(`不同留出题 ${record.tasks} < ${design.minHoldoutTasks}`)
  if (record.lost > 0) missing.push(`${record.lost} 道留出题净负`)
  if (e.holdout < 1 / design.alphaHoldout) missing.push(`留出 e 值 ${e.holdout} < ${base.thresholds.adopt}（还需连胜 ≈ ${Math.max(0, (winsNeeded(design.alphaHoldout, h.losses) ?? 99) - h.wins)} 场留出）`)
  if (e.all < 1 / design.alphaAll) missing.push(`全部 e 值 ${e.all} < ${+(1 / design.alphaAll).toFixed(1)}`)
  if (!missing.length) return { ...base, decision: 'adopt-provisional', why: `留出 e=${e.holdout}、全部 e=${e.all}（α=${design.alphaHoldout}；6 个假设全错采纳的上界 ≈ ${(6 * design.alphaHoldout * 100).toFixed(0)}%）；L1 证据够，待 L2 结局确认后才 confirmed` }
  if (all.n >= design.maxPairs) return { ...base, decision: 'stop-undecided', why: `累计 ${all.n} 对到上限仍未判：效应 < 可判下限` }
  return { ...base, decision: 'continue', why: '还缺：' + missing.join('；') }
}

// ── 3. 效度账本：L1 代理分 vs L2 结局 ─────────────────────────────────────
/** 从 traj-run 的结果行提取 L2 结局（理论 S9 度量）。 */
export function episodeOutcome(row) {
  const solved = !!(row.fixed || (Number.isInteger(row.fixedAtRound) && row.fixedAtRound > 0))
  return { solved, roundsToFix: solved ? (row.fixedAtRound ?? null) : null, rounds: row.rounds ?? null, calls: row.calls ?? null, repeats: row.repeats ?? 0,
    falseClaim: row.claim === 'fixed' && !solved, verifiedAfterFix: !!row.verifiedAfterFix, claimJustified: row.claimJustified ?? null, promptTokens: row.promptTokens ?? null }
}
/** AUC（Mann–Whitney，平手 0.5）。 */
export function auc(pairs) {
  const pos = pairs.filter((p) => p.outcome === 1).map((p) => p.proxy), neg = pairs.filter((p) => p.outcome === 0).map((p) => p.proxy)
  if (!pos.length || !neg.length) return null
  let s = 0
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0
  return s / (pos.length * neg.length)
}
/**
 * 尺子效度：pairs = [{proxy, outcome: 1|0}]。AUC 自助 95% CI（种子固定）；状态：
 * unvalidated（n < minPairs 或单类）/ valid（CI 下界 ≥ 0.6）/ invalid（AUC ≤ 0.55）/ suspect（其余）。
 */
export function rulerValidity(pairs, { minPairs = 12, minPerClass = 5, boots = 1000, seed = 11 } = {}) {
  const n = pairs.length, point = auc(pairs), pos = pairs.filter((p) => p.outcome === 1).length, neg = n - pos
  if (n < minPairs || point == null || Math.min(pos, neg) < minPerClass) return { n, pos, neg, auc: point == null ? null : +point.toFixed(3), ci95: null, status: 'unvalidated', why: n < minPairs ? `效度配对 ${n} < ${minPairs}` : point == null ? '结局只有单一类别' : `少数类只有 ${Math.min(pos, neg)} 条（< ${minPerClass}）：AUC 点估计 ${point.toFixed(3)} 但功效不足` }
  let s = seed >>> 0; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const vals = []
  for (let b = 0; b < boots; b++) { const smp = Array.from({ length: n }, () => pairs[Math.floor(rnd() * n)]); const a = auc(smp); if (a != null) vals.push(a) }
  vals.sort((a, b) => a - b)
  const lo = vals[Math.floor(vals.length * 0.025)], hi = vals[Math.floor(vals.length * 0.975)]
  const status = lo >= 0.6 ? 'valid' : point <= 0.55 ? 'invalid' : 'suspect'
  return { n, pos, neg, auc: +point.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)], status, why: status === 'valid' ? '代理尺与端到端结局同向且 CI 下界 ≥ 0.6' : status === 'invalid' ? '代理尺与结局无关：L1 退为预筛，选择只认 L2' : '方向存疑：继续攒效度配对，采纳一律 provisional' }
}
/** 尺子状态 → 采纳规则。 */
export function adoptionPolicy(validity) {
  const st = validity?.status || 'unvalidated'
  return st === 'valid' ? { l1Adopts: true, confirmEvery: 3, note: 'L1 可采纳；每 3 次采纳做 1 次 L2 抽检' }
    : st === 'invalid' ? { l1Adopts: false, confirmEvery: 1, note: 'L1 只预筛；每次采纳必须 L2 确认' }
      : { l1Adopts: false, confirmEvery: 1, note: '尺子未验：L1 采纳 provisional，必须 L2 确认才进生产' }
}
/** L2 对照汇总（champion vs previous）：修好率 / 轮数 / 假宣称 / 验收；配对 e 值按「同题同样本谁先修好」计。 */
export function outcomeComparison(rows, { arms = ['previous', 'champion'] } = {}) {
  const by = (arm) => rows.filter((r) => r.arm === arm).map((r) => ({ task: r.task, sample: r.sample ?? 0, o: episodeOutcome(r) }))
  const [prev, champ] = arms.map(by)
  const summ = (xs) => ({ n: xs.length, solved: xs.length ? +(xs.filter((x) => x.o.solved).length / xs.length).toFixed(3) : null, meanRoundsToFix: xs.filter((x) => x.o.roundsToFix).length ? +(xs.filter((x) => x.o.roundsToFix).reduce((a, x) => a + x.o.roundsToFix, 0) / xs.filter((x) => x.o.roundsToFix).length).toFixed(2) : null, falseClaims: xs.filter((x) => x.o.falseClaim).length, verified: xs.filter((x) => x.o.verifiedAfterFix).length, repeats: xs.reduce((a, x) => a + (x.o.repeats || 0), 0) })
  const outcomes = []
  for (const c of champ) {
    const p = prev.find((x) => x.task === c.task && x.sample === c.sample); if (!p) continue
    const key = (o) => (o.solved ? 1000 - (o.roundsToFix || 0) * 10 - (o.falseClaim ? 5 : 0) + (o.verifiedAfterFix ? 1 : 0) : (o.falseClaim ? -10 : 0))
    const a = key(c.o), b = key(p.o)
    outcomes.push({ task: c.task, sample: c.sample, outcome: a > b ? 'win' : a < b ? 'loss' : 'tie', champion: c.o, previous: p.o })
  }
  const w = outcomes.filter((o) => o.outcome === 'win').length, l = outcomes.filter((o) => o.outcome === 'loss').length
  return { previous: summ(prev), champion: summ(champ), pairs: outcomes, e: +eValueWins(w, l).toFixed(3), eReject: +eValueWins(l, w).toFixed(3) }
}

// ── 4. L1 值不值得存在：区分度 + 经济学（第四轮评审）────────────────────────
/** 规格代理（transfer/mr/run1–4 的 rule 旗标）区分度：结构分直方图、天花板率、raw vs 压缩稿同题同样本的平局率。 */
export function l1Discrimination(rows, { control = 'raw', candidates = ['auto', 'auto8', 'oracle3', 'oracle2', 'oracle'] } = {}) {
  const score = (r) => { const v = (k) => (r[k] === 1 ? 1 : 0); return v('next') + v('avoid') - v('falseDone') - v('bump') - v('reEdit') - v('repeat') }
  const ok = rows.filter((r) => r.rule && !r.error)
  const hist = {}; for (const r of ok) { const s = score(r.rule); hist[s] = (hist[s] || 0) + 1 }
  const by = {}; for (const r of ok) { const k = `${r.run || ''}|${r.task}|${r.sample}`; (by[k] = by[k] || {})[r.variant] = score(r.rule) }
  const pairs = { win: 0, loss: 0, tie: 0 }
  for (const b of Object.values(by)) { const c = candidates.map((v) => b[v]).find((x) => x != null); if (b[control] == null || c == null) continue; pairs[c > b[control] ? 'win' : c < b[control] ? 'loss' : 'tie']++ }
  const n = pairs.win + pairs.loss + pairs.tie
  const flags = Object.fromEntries(['next', 'avoid', 'falseDone', 'bump', 'reEdit', 'repeat'].map((f) => [f, ok.length ? +(ok.filter((r) => r.rule[f] === 1).length / ok.length).toFixed(3) : null]))
  return { n: ok.length, hist, ceilingRate: ok.length ? +((hist[2] || 0) / ok.length).toFixed(3) : null, pairs, tieRate: n ? +(pairs.tie / n).toFixed(3) : null, flags }
}
/**
 * 每美元买到的「可用于采纳的非平局配对」。L1 的配对只有在尺子 valid 时才计入采纳（否则 0）；L2 配对无条件计入。
 * 返回 L1 的角色：adoption-grade（valid 且更便宜）/ prescreen（valid 但不更便宜）/ diagnostic（未验）。
 */
export function rulerEconomics({ l1 = {}, l2 = {}, validity = { status: 'unvalidated' } } = {}) {
  const a = { usd: 0.126, pairs: 5, tieRate: 0.6, ...l1 }, b = { usd: 0.66, pairs: 6, tieRate: 0.3, validityPairs: 36, ...l2 }
  const valid = validity?.status === 'valid'
  const l1Info = a.pairs * (1 - a.tieRate), l2Info = b.pairs * (1 - b.tieRate)
  const L1 = { usd: a.usd, informativePairs: +l1Info.toFixed(2), usdPerInformativePair: +(a.usd / Math.max(1e-9, l1Info)).toFixed(3), adoptionGradePerUsd: +((valid ? l1Info : 0) / a.usd).toFixed(2) }
  const L2 = { usd: b.usd, informativePairs: +l2Info.toFixed(2), usdPerInformativePair: +(b.usd / Math.max(1e-9, l2Info)).toFixed(3), adoptionGradePerUsd: +(l2Info / b.usd).toFixed(2), validityPairsPerUsd: +(b.validityPairs / b.usd).toFixed(1) }
  const role = !valid ? 'diagnostic' : L1.usdPerInformativePair < L2.usdPerInformativePair ? 'prescreen' : 'redundant'
  const why = role === 'diagnostic' ? `尺子 ${validity?.status || 'unvalidated'}：v9 L1 轮每 $${a.usd} 只买到 ≈${L1.informativePairs} 个非平局对且一个都不计入采纳 ⇒ 只能当诊断 / A/A 校准，不是预筛尺；预算应给分叉轨迹（每 $1 ≈ ${L2.adoptionGradePerUsd} 个采纳级对 + ${L2.validityPairsPerUsd} 个效度对）`
    : role === 'prescreen' ? `尺子 valid：L1 每个非平局对 $${L1.usdPerInformativePair} < L2 的 $${L2.usdPerInformativePair} ⇒ 值得当预筛（淘汰用），采纳仍要 L2 确认` : `尺子 valid 但 L1 每个非平局对不比 L2 便宜 ⇒ 多余，直接用 L2`
  return { l1: L1, l2: L2, role, why }
}
