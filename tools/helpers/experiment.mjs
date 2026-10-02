// tools/helpers/experiment.mjs —— 实验经济学（v14.2）：按比特买证据。零 API，纯算术。
//
// 用户只有几块钱 ⇒ 每一次付费请求都要先回答三个问题：(1) 这一对观察能买到多少信息（bit）；
// (2) 现在的后验离「采纳 / 否决」还差多少对；(3) 这一轮预占多少、预计实付多少。
// 判据：每任务一对（candidate vs control，同 r1、同 red 观察、仅第 2 轮 reasoning 不同）的**结构分**
//   structuralScore = next + avoid − falseDone − bump − reEdit − repeat   （与 live 规则指标同源；无 Likert / 无评委）
// 胜 = 候选结构分更高；平局各记半。p = P(候选胜)，先验 Beta(1,1)，序贯更新：
//   P(p > 0.5) ≥ adoptAt(0.95) ⇒ adopt；≤ rejectAt(0.10) ⇒ reject；否则 continue（下一轮再买 ≤5 对）；累计 25 对仍未判 ⇒ stop-undecided。
// 这是**预算形状的决策规则，不是假设检验**：可选停止会抬高名义错误率。pairsToDecide() 的种子 MC（2000 次、平局率 0.1）给出的真实运行特性：
//   p=0.3（有害）  adopt 1%  reject 87%  中位 8 对        p=0.4  adopt 5%
//   p=0.5（无差别）adopt 15% reject 30%  其余撞 25 对上限 —— 误采纳一个 p=0.5 的旋钮按定义不改变结构分，且是一行配置、可回滚
//   p=0.7          adopt 72% 中位 12 对（实付 ≈ USD 0.15–0.25）    p=0.8  adopt 93% 中位 7 对
// 采纳门槛比否决门槛严（0.95 vs 0.10）：错误采纳会进生产 champion，错误否决只是少试一个旋钮。

const clamp01 = (x) => Math.max(0, Math.min(1, x))

// ── 1. Beta 后验 ────────────────────────────────────────────────────────────
function logGamma(z) {
  // Lanczos (g=7, n=9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  z -= 1
  let x = c[0]
  for (let i = 1; i < 9; i++) x += c[i] / (z + i)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300
  const qab = a + b, qap = a + 1, qam = a - 1
  let c = 1, d = 1 - qab * x / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d; h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}
/** 正则化不完全 Beta 函数 I_x(a,b) = P(X ≤ x)，X ~ Beta(a,b)。 */
export function betaCdf(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b
}
/** P(p > x) 。 */
export const betaTail = (a, b, x = 0.5) => clamp01(1 - betaCdf(x, a, b))
/** Beta 分位数（二分）。 */
export function betaQuantile(q, a, b) {
  let lo = 0, hi = 1
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (betaCdf(mid, a, b) < q) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

// ── 2. 配对判据 ─────────────────────────────────────────────────────────────
export const STRUCTURAL_METRICS = Object.freeze(['next', 'avoid', 'falseDone', 'bump', 'reEdit', 'repeat'])
/** 结构分：好的加、坏的减；全部来自 ruleMetrics（与 v8 收据同口径）。range [−4, 2]。 */
export function structuralScore(rule) {
  if (!rule) return null
  const v = (k) => (rule[k] === 1 ? 1 : 0)
  return v('next') + v('avoid') - v('falseDone') - v('bump') - v('reEdit') - v('repeat')
}
/** 一对的结果：'win' | 'loss' | 'tie'（候选相对控制）。 */
export function pairOutcome(candidateRule, controlRule) {
  const a = structuralScore(candidateRule), b = structuralScore(controlRule)
  if (a == null || b == null) return null
  return a > b ? 'win' : a < b ? 'loss' : 'tie'
}
/** 从 reportEvaluation 的逐样本结果里配对（同 task、同 sample、两臂齐）。 */
export function pairResults(results, { arms = ['control', 'candidate'] } = {}) {
  const [ctrlArm, candArm] = arms
  const pairs = []
  const byKey = new Map()
  for (const r of results || []) byKey.set(`${r.task}|${r.variant}|${r.sample}`, r)
  for (const r of results || []) {
    if (r.variant !== candArm) continue
    const c = byKey.get(`${r.task}|${ctrlArm}|${r.sample}`)
    if (!c) continue
    pairs.push({ task: r.task, sample: r.sample, outcome: pairOutcome(r.rule, c.rule), candidate: structuralScore(r.rule), control: structuralScore(c.rule), candidateAction: r.action, controlAction: c.action })
  }
  return pairs
}

// ── 3. 序贯设计 ─────────────────────────────────────────────────────────────
export const DEFAULT_DESIGN = Object.freeze({ adoptAt: 0.95, rejectAt: 0.1, prior: [1, 1], maxPairs: 25, pairsPerRound: 5 })
/**
 * 序贯配对分析：outcomes = ['win'|'loss'|'tie', …]（跨轮累计，同一假设）。
 * 返回后验、判定与「还需要多少对」。
 */
export function sequentialPaired(outcomes, design = DEFAULT_DESIGN) {
  const d = { ...DEFAULT_DESIGN, ...design }
  const xs = (outcomes || []).filter((o) => o === 'win' || o === 'loss' || o === 'tie')
  const wins = xs.filter((o) => o === 'win').length, losses = xs.filter((o) => o === 'loss').length, ties = xs.length - wins - losses
  const a = d.prior[0] + wins + ties / 2, b = d.prior[1] + losses + ties / 2
  const pWin = betaTail(a, b, 0.5)
  const decision = xs.length === 0 ? 'continue' : pWin >= d.adoptAt ? 'adopt' : pWin <= d.rejectAt ? 'reject' : xs.length >= d.maxPairs ? 'stop-undecided' : 'continue'
  return { n: xs.length, wins, losses, ties, alpha: a, beta: b, mean: +(a / (a + b)).toFixed(4), ci95: [+betaQuantile(0.025, a, b).toFixed(4), +betaQuantile(0.975, a, b).toFixed(4)], pWin: +pWin.toFixed(4), decision, design: d }
}
const h2 = (p) => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)))
/** 再看一对能买到的期望信息（bit）：关于「候选是否更好」这个二值命题的期望熵减（预后验）。 */
export function expectedBitsNextPair(a, b, { x = 0.5 } = {}) {
  const now = h2(betaTail(a, b, x))
  const pw = a / (a + b)
  const after = pw * h2(betaTail(a + 1, b, x)) + (1 - pw) * h2(betaTail(a, b + 1, x))
  return +Math.max(0, now - after).toFixed(4)
}
/** 到目前为止累计买到的信息：先验熵 1 bit − 当前熵。 */
export function bitsBought(a, b, { x = 0.5, prior = [1, 1] } = {}) { return +Math.max(0, h2(betaTail(prior[0], prior[1], x)) - h2(betaTail(a, b, x))).toFixed(4) }

/** 给定真实胜率，模拟到判定所需对数（种子固定，可复现）；用来给用户看「值不值得继续买」。 */
export function pairsToDecide({ pTrue = 0.7, tieRate = 0.1, design = DEFAULT_DESIGN, sims = 400, cap = 60, seed = 7 } = {}) {
  let s = (seed >>> 0) || 1
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const d = { ...DEFAULT_DESIGN, ...design, maxPairs: cap }
  const ns = [], decisions = { adopt: 0, reject: 0, 'stop-undecided': 0 }
  for (let i = 0; i < sims; i++) {
    const out = []
    let res
    for (let n = 1; n <= cap; n++) {
      const u = rnd()
      out.push(u < tieRate ? 'tie' : rnd() < pTrue ? 'win' : 'loss')
      res = sequentialPaired(out, d)
      if (res.decision !== 'continue') break
    }
    ns.push(out.length); decisions[res.decision] = (decisions[res.decision] || 0) + 1
  }
  ns.sort((x, y) => x - y)
  return { pTrue, tieRate, sims, cap, medianPairs: ns[Math.floor(ns.length / 2)], p90Pairs: ns[Math.floor(ns.length * 0.9)], decisions }
}

// ── 4. 成本 ─────────────────────────────────────────────────────────────────
/** CJK 为主的文本的 token 粗估：≈0.6 token/字（deepseek tokenizer 对中文的经验值；ASCII 代码段按 0.3/字节）。 */
export function roughTokens(text) {
  const t = String(text || '')
  let cjk = 0, other = 0
  for (const ch of t) { if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++; else other++ }
  return Math.ceil(cjk * 0.6 + other * 0.3)
}
/**
 * 一轮的费用：预占（auditApiPlan 的报价之和——账本按它锁钱）与预计实付（粗估 token × 单价）。
 * medianCompletionTokens 来自既往收据（v8：主请求中位数 ≈ 2500）；没有就用 2500。
 */
export function costEstimate({ plan, audit, pricing, medianCompletionTokens = 2500 }) {
  const jobs = (plan?.jobs || [])
  const inUsd = pricing?.inputUsdPerMillion, outUsd = pricing?.outputUsdPerMillion, fee = pricing?.requestFeeUsd || 0
  const priced = Number.isFinite(inUsd) && Number.isFinite(outUsd)
  let expected = 0
  const perJob = []
  for (const j of jobs) {
    const inTok = roughTokens(JSON.stringify(j.body.messages))
    const outTok = j.kind === 'probe' ? 64 : Math.min(j.body.max_tokens || 0, medianCompletionTokens)
    const usd = priced ? (inTok * inUsd + outTok * outUsd) / 1e6 + fee : null
    perJob.push({ key: j.key, inputTokensRough: inTok, outputTokensExpected: outTok, expectedUsd: usd == null ? null : +usd.toFixed(4) })
    if (usd != null) expected += usd
  }
  const reserved = audit?.totalReservedUsd ?? null
  return { requests: jobs.length, main: jobs.filter((j) => j.kind === 'main').length, reservedUsd: reserved == null ? null : +reserved.toFixed(4), expectedUsd: priced ? +expected.toFixed(4) : null, perJob, note: '预占是账本锁定的上限（JSON 字节 + 4096 输入界 × 8192 输出界）；实付按既往收据的中位完成 token 估，二者差 5–10 倍是正常的' }
}
/** 每 bit 的价格：这一轮预计实付 / 这一轮能买到的期望 bit（逐对预后验叠加）。 */
export function usdPerBit({ alpha, beta, pairs, expectedUsd }) {
  let a = alpha, b = beta, bits = 0
  for (let i = 0; i < pairs; i++) { const g = expectedBitsNextPair(a, b); bits += g; const pw = a / (a + b); a += pw; b += 1 - pw }
  return { pairs, expectedBits: +bits.toFixed(4), usdPerBit: bits > 0 && Number.isFinite(expectedUsd) ? +(expectedUsd / bits).toFixed(4) : null }
}
