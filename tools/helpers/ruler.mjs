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
  const start = Number.isInteger(row.startRound) ? row.startRound : 1   // v4.3 子状态续跑：到修好轮数从起始轮算
  return { solved, roundsToFix: solved && Number.isInteger(row.fixedAtRound) ? row.fixedAtRound - start + 1 : solved ? (row.fixedAtRound ?? null) : null, rounds: row.rounds ?? null, startRound: start, fromState: row.fromState ?? null, calls: row.calls ?? null, repeats: row.repeats ?? 0,
    falseClaim: row.claim === 'fixed' && !solved, verifiedAfterFix: !!row.verifiedAfterFix, claimJustified: row.claimJustified ?? null, cleanFinish: solved && row.claim === 'fixed' && !!row.claimJustified, promptTokens: row.promptTokens ?? null }
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
  const by = (arm) => rows.filter((r) => r.arm === arm).map((r) => ({ task: r.task, unit: r.fromState || r.task, sample: r.sample ?? 0, o: episodeOutcome(r) }))   // v4.3：子状态续跑按状态配对，task 仍是家族（曝光账按家族记）
  const [prev, champ] = arms.map(by)
  const summ = (xs) => ({ n: xs.length, solved: xs.length ? +(xs.filter((x) => x.o.solved).length / xs.length).toFixed(3) : null, meanRoundsToFix: xs.filter((x) => x.o.roundsToFix).length ? +(xs.filter((x) => x.o.roundsToFix).reduce((a, x) => a + x.o.roundsToFix, 0) / xs.filter((x) => x.o.roundsToFix).length).toFixed(2) : null, falseClaims: xs.filter((x) => x.o.falseClaim).length, verified: xs.filter((x) => x.o.verifiedAfterFix).length, repeats: xs.reduce((a, x) => a + (x.o.repeats || 0), 0) })
  const outcomes = []
  for (const c of champ) {
    const p = prev.find((x) => x.unit === c.unit && x.sample === c.sample); if (!p) continue
    // 分层成对比较（Finkelstein–Schoenfeld / Buyse GPC；Pocock 胜比）：修好 > 到修好轮数（少者胜）> 假宣称 > 修后验证 > 规范收工（claim=fixed ∧ claimJustified）；上一层平手才看下一层
    const key = (o) => (o.solved ? 1000 - (o.roundsToFix || 0) * 10 - (o.falseClaim ? 5 : 0) + (o.verifiedAfterFix ? 1 : 0) + (o.cleanFinish ? 0.5 : 0) : (o.falseClaim ? -10 : 0))
    const a = key(c.o), b = key(p.o)
    outcomes.push({ task: c.task, unit: c.unit, sample: c.sample, outcome: a > b ? 'win' : a < b ? 'loss' : 'tie', champion: c.o, previous: p.o })
  }
  const w = outcomes.filter((o) => o.outcome === 'win').length, l = outcomes.filter((o) => o.outcome === 'loss').length
  return { previous: summ(prev), champion: summ(champ), pairs: outcomes, e: +eValueWins(w, l).toFixed(3), eReject: +eValueWins(l, w).toFixed(3),
    winRatio: l ? +(w / l).toFixed(3) : (w ? Infinity : null), netBenefit: outcomes.length ? +((w - l) / outcomes.length).toFixed(3) : null, method: 'hierarchical-GPC(solved>roundsToFix>falseClaim>verified)' }
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

// ── 5. v4.3：主结局 = 到修好的轮数（右删失）；ICC 从已有数据估；六旗标权重由结局回归；泛化差距 ───────────
/**
 * Harrell C 指数：pairs = [{proxy, time: roundsToFix 或删失时刻 rounds, event: 1 修好 / 0 未修好}]。
 * 可比对 = 至少一方有事件且其时间更早（删失者只能作「活得更久」的一方）；一致 = 代理分更高者修得更早。
 */
export function concordanceIndex(pairs, { crossClusterOnly = false } = {}) {
  let conc = 0, comp = 0
  for (let i = 0; i < pairs.length; i++) for (let j = 0; j < pairs.length; j++) {
    if (i === j) continue
    const a = pairs[i], b = pairs[j]
    if (crossClusterOnly && (a.cluster ?? a.task) === (b.cluster ?? b.task)) continue   // 同一轨迹内「早的步剩余轮数必然更多」是构造出来的，不算
    if (!a.event || !(a.time < b.time)) continue   // a 先到事件，b 更晚（或删失于更晚）
    comp++; conc += a.proxy > b.proxy ? 1 : a.proxy === b.proxy ? 0.5 : 0
  }
  return comp ? { c: conc / comp, comparable: comp } : { c: null, comparable: 0 }
}
/** 到修好轮数口径的效度（簇自助）：C 下界 ≥ 0.6 valid；C ≤ 0.55 invalid；少数类 / 可比对不足 unvalidated。 */
export function rulerValidityTTF(pairs, { minPairs = 12, minEvents = 5, boots = 1000, seed = 11 } = {}) {
  const n = pairs.length, events = pairs.filter((p) => p.event).length, cens = n - events
  const cross = pairs.some((p) => p.cluster != null)
  const pt = concordanceIndex(pairs, { crossClusterOnly: cross })
  if (n < minPairs || pt.c == null || events < minEvents || cens < 3) return { n, events, censored: cens, c: pt.c == null ? null : +pt.c.toFixed(3), comparable: pt.comparable, ci95: null, status: 'unvalidated', why: n < minPairs ? `配对 ${n} < ${minPairs}` : events < minEvents ? `事件 ${events} < ${minEvents}` : cens < 3 ? `删失（未修好）只有 ${cens} 条，C 指数会过于乐观` : '无可比对' }
  const clusters = [...new Set(pairs.map((p) => p.cluster ?? p.task ?? String(Math.random())))]
  let s = seed >>> 0; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const byC = Object.fromEntries(clusters.map((c) => [c, pairs.filter((p) => (p.cluster ?? p.task) === c)]))
  const vals = []
  for (let b = 0; b < boots; b++) { const smp = []; for (let i = 0; i < clusters.length; i++) { const c = clusters[Math.floor(rnd() * clusters.length)]; smp.push(...byC[c].map((p) => ({ ...p, cluster: c + '#' + i }))) } const v = concordanceIndex(smp, { crossClusterOnly: cross }).c; if (v != null) vals.push(v) }
  vals.sort((a, b) => a - b)
  const lo = vals[Math.floor(vals.length * 0.025)], hi = vals[Math.floor(vals.length * 0.975)]
  const status = lo >= 0.6 ? 'valid' : pt.c <= 0.55 ? 'invalid' : 'suspect'
  return { n, events, censored: cens, c: +pt.c.toFixed(3), comparable: pt.comparable, crossClusterOnly: cross, ci95: [+lo.toFixed(3), +hi.toFixed(3)], clusters: clusters.length, status, why: status === 'valid' ? '代理分高者确实修得更早（簇自助 CI 下界 ≥ 0.6）' : status === 'invalid' ? '代理分与到修好的轮数无关' : '方向存疑（CI 跨 0.6）' }
}
/** 单因素 ICC(1)：groups = [[x, x, …], …]（同题同臂的重复样本）。 */
export function iccOneWay(groups) {
  const g = groups.filter((x) => x.length >= 2); if (g.length < 2) return { icc: null, groups: g.length, why: '≥2 个组、每组 ≥2 个重复样本才可估' }
  const all = g.flat(), N = all.length, k = g.length, grand = all.reduce((a, b) => a + b, 0) / N
  const n0 = (N - g.reduce((a, x) => a + x.length * x.length, 0) / N) / (k - 1)
  const msb = g.reduce((a, x) => { const m = x.reduce((p, q) => p + q, 0) / x.length; return a + x.length * (m - grand) ** 2 }, 0) / (k - 1)
  const msw = g.reduce((a, x) => { const m = x.reduce((p, q) => p + q, 0) / x.length; return a + x.reduce((p, q) => p + (q - m) ** 2, 0) }, 0) / (N - k)
  const icc = (msb - msw) / (msb + (n0 - 1) * msw)
  return { icc: +Math.max(0, Math.min(1, Number.isFinite(icc) ? icc : 0)).toFixed(3), groups: k, samples: N, msb: +msb.toFixed(4), msw: +msw.toFixed(4) }
}
/** 六旗标 → 结局的逻辑回归（CPU，确定性）：pairs = [{flags:{next,…}, outcome: 1|0, cluster}]；按簇留一交叉验证 AUC；与手工 ±1 的 AUC 并列报告。诊断用，不进采纳。 */
export function fitFlagWeights(pairs, { epochs = 400, lr = 0.1, l2 = 0.02 } = {}) {
  const K = ['next', 'avoid', 'falseDone', 'bump', 'reEdit', 'repeat']
  const X = pairs.map((p) => [...K.map((k) => (p.flags?.[k] === 1 ? 1 : 0)), 1]), y = pairs.map((p) => (p.outcome ? 1 : 0))
  const fit = (idx) => {
    let w = new Array(K.length + 1).fill(0)
    const nPos = idx.filter((i) => y[i] === 1).length || 1
    const nNeg = idx.filter((i) => y[i] === 0).length || 1
    for (let e = 0; e < epochs; e++) {
      const g = new Array(w.length).fill(0)
      for (const i of idx) {
        const cw = y[i] === 1 ? idx.length / (2 * nPos) : idx.length / (2 * nNeg)
        const z = X[i].reduce((s, x, j) => s + x * w[j], 0), p = 1 / (1 + Math.exp(-z))
        for (let j = 0; j < w.length; j++) g[j] += cw * (p - y[i]) * X[i][j]
      }
      for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / Math.max(1, idx.length) + (j < K.length ? l2 * w[j] : 0))
    }
    return w
  }
  const quantW = (w) => {
    const norm = K.reduce((s, _, j) => s + Math.abs(w[j]), 0) || 1
    return K.map((_, j) => Math.round((w[j] / norm) * 10) / 10)
  }
  const score = (w, i) => { const qw = quantW(w); return K.reduce((s, _, j) => s + X[i][j] * qw[j], 0) }
  const hand = [1, 1, -1, -1, -1, -1, 0]
  const n = pairs.length; if (n < 12 || !y.includes(0) || !y.includes(1)) return { n, status: 'unvalidated', why: '配对 < 12 或单一类别' }
  const clusters = [...new Set(pairs.map((p, i) => p.cluster ?? i))]
  const cvScores = new Array(n).fill(0)
  for (const c of clusters) { const test = pairs.map((_, i) => i).filter((i) => (pairs[i].cluster ?? i) === c), train = pairs.map((_, i) => i).filter((i) => (pairs[i].cluster ?? i) !== c); const w = fit(train); for (const i of test) cvScores[i] = score(w, i) }
  const w = fit(pairs.map((_, i) => i))
  const aucOf = (sc) => auc(pairs.map((p, i) => ({ proxy: sc[i], outcome: y[i] })))
  const learnedCv = aucOf(cvScores), handAuc = aucOf(pairs.map((_, i) => K.reduce((s, _, j) => s + X[i][j] * hand[j], 0)))
  return { n, clusters: clusters.length, weights: Object.fromEntries(K.map((k, j) => [k, +w[j].toFixed(3)])), bias: +w[K.length].toFixed(3), aucLearnedCv: learnedCv == null ? null : +learnedCv.toFixed(3), aucHand: handAuc == null ? null : +handAuc.toFixed(3), status: 'diagnostic', why: learnedCv != null && handAuc != null && learnedCv > handAuc + 0.05 ? '学到的权重在簇留一下优于手工 ±1：可作候选尺，但须在新家族上复验才能替换' : '学到的权重不优于手工 ±1（或样本不足）：保留 ±1' }
}
/** 泛化差距（Ladder 视角）：dev 胜率 − 留出胜率；差距大且留出不显著 ⇒ suspected-overfit。 */
export function generalizationGap({ dev, holdout }) {
  if (!dev?.n || !holdout?.n) return { gap: null, flag: 'n/a' }
  const dr = (dev.wins - dev.losses) / dev.n, hr = (holdout.wins - holdout.losses) / holdout.n
  const gap = +(dr - hr).toFixed(3)
  return { gap, devNet: +dr.toFixed(3), holdoutNet: +hr.toFixed(3), flag: holdout.n >= 4 && gap >= 0.5 ? 'suspected-overfit' : 'ok', note: 'Ladder（Blum–Hardt 2015）：留出只通过「采纳 / 否决」这一比特泄漏，更新次数 O(log k)；e 值已是显著性阶梯，这里只报 dev 过度乐观的迹象' }
}

// ── 行业官方基准融合（SWE-bench Pro / Terminal-Bench 2.0 / TAU-bench pass^k / LMArena Elo / Artificial Analysis 性价比前沿）──

const comb = (n, k) => {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i
  return r
}
/** OpenAI Codex / SWE-bench 无偏估计量 pass@k：k 次尝试至少 1 次严苛解决的概率 = 1 - C(n-c, k)/C(n, k)。 */
export function passAtK(n, c, k = 1) {
  if (!Number.isFinite(n) || n < k || k < 1) return null
  return +(1 - comb(n - c, k) / comb(n, k)).toFixed(3)
}
/** TAU-bench / Terminal-Bench 2.0 工程可靠性指标 pass^k：k 次独立尝试【全部】严苛解决的概率 = C(c, k)/C(n, k)。 */
export function passHatK(n, c, k = 2) {
  if (!Number.isFinite(n) || n < k || k < 1) return null
  return +(comb(c, k) / comb(n, k)).toFixed(3)
}

/** LMArena / Chatbot Arena 标准 Bradley-Terry 最大似然 Elo 评级（含平局 0.5 权重与簇自助 95% CI，锚定 anchor = 1000 Elo）。
 *  pairs = [{ armA, armB, outcome: 'win'|'loss'|'tie', cluster? }]（outcome 从 armA 视角：win=armA 胜）。 */
export function arenaElo(pairs, { anchor = 'raw', anchorElo = 1000, epochs = 300, lr = 0.25, boots = 200, seed = 42 } = {}) {
  const arms = [...new Set([anchor, ...pairs.flatMap((p) => [p.armA, p.armB]).filter(Boolean)])]
  if (!pairs.length || arms.length < 2) return Object.fromEntries(arms.map((a) => [a, { elo: anchorElo, ci95: [anchorElo, anchorElo], games: 0 }]))
  const idxOf = Object.fromEntries(arms.map((a, i) => [a, i]))
  const anchorIdx = idxOf[anchor] ?? 0
  const fitBT = (sample) => {
    const theta = new Array(arms.length).fill(0)
    const n = sample.length || 1
    for (let ep = 0; ep < epochs; ep++) {
      const grad = new Array(arms.length).fill(0)
      for (const p of sample) {
        const i = idxOf[p.armA], j = idxOf[p.armB]
        if (i == null || j == null || i === j) continue
        const s = p.outcome === 'win' ? 1 : p.outcome === 'loss' ? 0 : 0.5
        const prob = 1 / (1 + Math.exp(-(theta[i] - theta[j])))
        grad[i] += s - prob
        grad[j] += (1 - s) - (1 - prob)
      }
      for (let k = 0; k < arms.length; k++) theta[k] += (lr / n) * (grad[k] - 0.01 * theta[k])
      const shift = theta[anchorIdx]
      for (let k = 0; k < arms.length; k++) theta[k] -= shift
    }
    const scale = 400 / Math.LN10
    return theta.map((t) => anchorElo + t * scale)
  }
  const pt = fitBT(pairs)
  let s = seed >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const bootElo = arms.map(() => [])
  for (let b = 0; b < boots; b++) {
    const smp = Array.from({ length: pairs.length }, () => pairs[Math.floor(rnd() * pairs.length)])
    const eb = fitBT(smp)
    eb.forEach((v, i) => bootElo[i].push(v))
  }
  const out = {}
  arms.forEach((a, i) => {
    const arr = bootElo[i].sort((x, y) => x - y)
    const games = pairs.filter((p) => p.armA === a || p.armB === a).length
    const lo = arr.length ? Math.round(arr[Math.floor(arr.length * 0.025)]) : Math.round(pt[i])
    const hi = arr.length ? Math.round(arr[Math.floor(arr.length * 0.975)]) : Math.round(pt[i])
    out[a] = { elo: Math.round(pt[i]), deltaVsAnchor: Math.round(pt[i] - anchorElo), ci95: [lo, hi], games }
  })
  return out
}

/** 综合五大官方基准口径的轨迹记分卡（SWE-bench Pro 三重门 + TAU-bench pass^k + LMArena Elo + Artificial Analysis 性价比前沿）：
 *  - SWE-bench Verified-Resolved：F2P（隐藏症状消除）∧ P2P（可见测试未改坏）∧ !falseDone（无修好前假宣称），剔除 19.78% 伪修好水分；
 *  - TAU-bench / Terminal-Bench 2.0：pass@1（单次能力）vs pass^2 / pass^3（跨样本连续全对的工程可靠性）；
 *  - Artificial Analysis (AA) 性价比前沿：单次修好美元成本（$/Verified-Fix）、AgentDiet 轮数/推理字符缩减比与 AA 综合效率指数。 */
export function industryScorecard(rows, { anchor = 'raw', mainUsd = 0.012, compressUsd = 0.004 } = {}) {
  const valid = (rows || []).filter((r) => r && r.task && !r.error && r.status !== 'awaiting-draft')
  const armOf = (r) => (r.policy ? 'policy:' + r.policy : r.variant || 'raw')
  const arms = [...new Set(valid.map(armOf))]
  const byArm = {}
  for (const a of arms) {
    const rs = valid.filter((r) => armOf(r) === a)
    const byTask = {}
    let f2p = 0, strict = 0, apparent = 0, roundsSum = 0, reasonCharsSum = 0, storedCharsSum = 0, compCalls = 0
    for (const r of rs) {
      const ep = episodeOutcome(r)
      const isF2P = !!ep.solved
      const isStrict = !!(ep.solved && !ep.falseClaim && !r.testTampered)
      const isApparent = !!(ep.solved || ep.falseClaim)
      if (isF2P) f2p++
      if (isStrict) strict++
      if (isApparent) apparent++
      roundsSum += ep.rounds || r.rounds || 0
      const tr = r.transcript || []
      for (const step of tr) {
        const rc = Number(step.reasoningChars || (step.reasoning || '').length || 0)
        const sc = Number(step.storedChars ?? step.storedReasoningChars ?? rc)
        reasonCharsSum += rc
        storedCharsSum += sc
        if (step.birthAccepted || (sc > 0 && sc < rc)) compCalls++
      }
      const fam = String(r.task).split(':')[0]
      if (!byTask[fam]) byTask[fam] = { n: 0, c: 0 }
      byTask[fam].n++
      if (isStrict) byTask[fam].c++
    }
    const n = rs.length || 1
    const fams = Object.values(byTask)
    const meanMetric = (fn) => {
      const vs = fams.map(fn).filter((v) => v != null)
      return vs.length ? +(vs.reduce((p, q) => p + q, 0) / vs.length).toFixed(3) : null
    }
    const estCostUsd = +(roundsSum * mainUsd + compCalls * compressUsd).toFixed(3)
    byArm[a] = {
      arm: a,
      n: rs.length,
      f2pRate: +(f2p / n).toFixed(3),
      verifiedResolvedRate: +(strict / n).toFixed(3),
      apparentSolvedRate: +(apparent / n).toFixed(3),
      rewardHackGap: +((apparent - strict) / n).toFixed(3),
      passAt1: meanMetric((x) => passAtK(x.n, x.c, 1)),
      passHat2: meanMetric((x) => passHatK(x.n, x.c, 2)),
      passHat3: meanMetric((x) => passHatK(x.n, x.c, 3)),
      meanRounds: +(roundsSum / n).toFixed(2),
      meanRawReasonChars: Math.round(reasonCharsSum / n),
      meanStoredReasonChars: Math.round(storedCharsSum / n),
      estUsdPerEpisode: +(estCostUsd / n).toFixed(4),
      usdPerVerifiedResolve: strict > 0 ? +(estCostUsd / strict).toFixed(4) : null,
    }
  }
  // 配对构建与 Arena Elo（按同批运行 dir + task + sample 配对）
  const mapped = valid.map((r) => ({ ...r, arm: armOf(r), fromState: (r.dir ? r.dir + ':' : '') + (r.fromState || r.task) }))
  const pairs = []
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = arms[i], b = arms[j]
      const cmp = outcomeComparison(mapped, { arms: [b, a] })
      for (const p of cmp.pairs) {
        pairs.push({ armA: a, armB: b, outcome: p.outcome, cluster: p.task })
      }
    }
  }
  const elos = arenaElo(pairs, { anchor })
  const baseArm = byArm[anchor]
  for (const a of arms) {
    const x = byArm[a]
    x.elo = elos[a]?.elo ?? 1000
    x.eloDelta = elos[a]?.deltaVsAnchor ?? 0
    x.eloCi95 = elos[a]?.ci95 ?? [1000, 1000]
    x.stepDietPct = baseArm && baseArm.meanRounds > 0 ? +(((baseArm.meanRounds - x.meanRounds) / baseArm.meanRounds) * 100).toFixed(1) : 0
    x.tokenDietPct = x.meanRawReasonChars > 0 ? +(((x.meanRawReasonChars - x.meanStoredReasonChars) / x.meanRawReasonChars) * 100).toFixed(1) : 0
    const relCost = baseArm && baseArm.estUsdPerEpisode > 0 ? x.estUsdPerEpisode / baseArm.estUsdPerEpisode : 1
    const baseRes = baseArm && baseArm.verifiedResolvedRate > 0 ? baseArm.verifiedResolvedRate : 0.5
    x.aaFrontierIndex = Math.round(100 * (x.verifiedResolvedRate / baseRes) / Math.max(0.25, relCost))
  }
  return { anchor, arms: byArm, pairsCount: pairs.length }
}

