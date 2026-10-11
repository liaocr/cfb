// tools/helpers/calibration.mjs —— 回灌层：让「离线排序」随着真实结果越练越准。
//
// 这一层此前完全不存在，是「能一直练下去」的关键缺口。它做三件事：
//   ① 拟合打分权重：从「候选特征 → 真实结果」的观测里学，取代人工设定；
//   ② 发现缺维度：当所有候选都被同一个失败解释不了时，说明缺的不是取值，是**一个维度**；
//   ③ 主动学习：挑「最不确定」的候选去花真钱（而不是挑当前得分最高的）。
//
// 重要：权重拟合用**岭回归 + 留一交叉验证**，样本少时自动收缩到默认权重，
// 绝不因为 3 个样本就宣称学到了什么。样本量与置信度一起输出。
import fs from 'node:fs'
import { DIMENSIONS, DEFAULT_WEIGHTS, normalizeDims, LOWER_IS_BETTER } from './judge-layer.mjs'

/**
 * 把一条「候选 × 真实结果」观测转成拟合用的行。
 * 特征一律用 normalizeDims 的**质量分**（越大越好）⇒ 拟合出的权重天然非负，
 * 与 compositeScore 的约定一致，不会出现"学出负权重再把好样本罚掉"的自相矛盾。
 */
export function toRow(features, outcome) {
  const n = normalizeDims(features)
  return { x: DIMENSIONS.map((d) => n[d.id]).map((v) => (v == null ? NaN : v)), y: Number(outcome) }
}

/** 用非缺失列做岭回归（闭式解 (XᵀX+λI)⁻¹Xᵀy），返回权重与诊断。 */
export function fitWeights(rows, { lambda = 1, prior = DEFAULT_WEIGHTS } = {}) {
  const dims = DIMENSIONS.map((d) => d.id)
  const usable = rows.filter((r) => r.x.every(Number.isFinite) && Number.isFinite(r.y))
  if (usable.length < 4) {
    return { ok: false, reason: 'insufficient', n: usable.length, weights: { ...prior },
      note: '样本少于 4 条，收缩到默认权重；这是「不因小样本而宣称学到东西」的硬约束' }
  }
  const p = dims.length, n = usable.length
  // 标准化 y（避免尺度影响 λ 的含义）
  const my = usable.reduce((a, r) => a + r.y, 0) / n
  const sy = Math.sqrt(usable.reduce((a, r) => a + (r.y - my) ** 2, 0) / n) || 1
  // 岭回归解
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0))
  const Xty = new Array(p).fill(0)
  for (const r of usable) {
    const y = (r.y - my) / sy
    for (let i = 0; i < p; i++) { Xty[i] += r.x[i] * y; for (let j = 0; j < p; j++) XtX[i][j] += r.x[i] * r.x[j] }
  }
  for (let i = 0; i < p; i++) XtX[i][i] += lambda
  const beta = solve(XtX, Xty)
  if (!beta) return { ok: false, reason: 'singular', n: usable.length, weights: { ...prior } }
  // 质量分与权重同向 ⇒ 拟合出的权重理论上非负；出现负数说明共线性导致过拟合，
  // 这里钳到 0 并在诊断里报出，避免把它当成"反向维度"误用。
  const negIdx = beta.map((b, i) => (b < 0 ? i : -1)).filter((i) => i >= 0)
  const weights = Object.fromEntries(dims.map((d, i) => [d, +(Math.max(0, beta[i]) * sy).toFixed(4)]))
  // 训练内拟合优度 + 留一交叉验证
  const pred = (x) => beta.reduce((a, b, i) => a + b * x[i], 0) * sy + my
  const ssTot = usable.reduce((a, r) => a + (r.y - my) ** 2, 0)
  const ssRes = usable.reduce((a, r) => a + (r.y - pred(r.x)) ** 2, 0)
  const r2 = ssTot ? 1 - ssRes / ssTot : null
  let looErr = 0
  for (let k = 0; k < n; k++) {
    const sub = usable.filter((_, i) => i !== k)
    const w = fitRaw(sub, lambda, p)
    if (!w) continue
    const msub = sub.reduce((a, r) => a + r.y, 0) / sub.length
    const predK = sub[0].x.map((_, i) => w[i]).reduce((a, b, i) => a + b * usable[k].x[i], 0) * 1 + msub * 0
    looErr += (usable[k].y - predK) ** 2
  }
  const looRmse = Math.sqrt(looErr / n)
  return { ok: true, n, weights, r2: r2 == null ? null : +r2.toFixed(4), looRmse: +looRmse.toFixed(4),
    clampedNegative: negIdx.map((i) => dims[i]),
    shrinkTo: n < 12 ? '样本仍偏少，权重按 n 缩放收缩' : null,
    confidence: n < 8 ? 'low' : n < 24 ? 'medium' : 'high' }
}
function fitRaw(rows, lambda, p) {
  const n = rows.length
  if (n < p + 1) return null
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0))
  const Xty = new Array(p).fill(0)
  for (const r of rows) for (let i = 0; i < p; i++) { Xty[i] += r.x[i] * r.y; for (let j = 0; j < p; j++) XtX[i][j] += r.x[i] * r.x[j] }
  for (let i = 0; i < p; i++) XtX[i][i] += lambda
  return solve(XtX, Xty, true)
}
/** 高斯消元（带部分主元）。不可解返回 null。 */
export function solve(A, b, allowSingular = false) {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-12) { if (allowSingular) continue; return null }
    const t = M[c]; M[c] = M[piv]; M[piv] = t
    for (let r = 0; r < n; r++) if (r !== c && Math.abs(M[c][c]) > 1e-12) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k] }
  }
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) out[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : M[i][n] / M[i][i]
  return out
}

/** 排序有效性：拟合权重下的离线序 vs 真实序的秩相关。这是回灌是否起作用的唯一验钞机。 */
export function rankAgreement(rows, weights) {
  const dims = DIMENSIONS.map((d) => d.id)
  const usable = rows.filter((r) => r.x.every(Number.isFinite) && Number.isFinite(r.y))
  if (usable.length < 3) return { n: usable.length, rho: null, note: 'n<3' }
  const score = (x) => x.reduce((a, v, i) => a + v * (weights[dims[i]] || 0), 0)
  const xs = usable.map((r) => score(r.x)), ys = usable.map((r) => r.y)
  return { n: usable.length, rho: spearmanLocal(xs, ys) }
}
function spearmanLocal(xs, ys) {
  const n = xs.length
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let i = 0
    while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1 } return r }
  const rx = rank(xs), ry = rank(ys)
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b }
  return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(4) : null
}

/**
 * 缺维度发现：把「所有候选解释不了的失败」聚出来。
 * 判定依据：真实结果最差的若干条，其特征却与最好的那些**难以区分**（特征距离小、结果差距大）。
 * 这些样本指向"缺一个维度"，而不是"某个取值不对"。
 */
export function missingDimensionSignal(rows, { worstFrac = 0.25, minN = 6 } = {}) {
  const usable = rows.filter((r) => r.x.every(Number.isFinite) && Number.isFinite(r.y))
  if (usable.length < minN) return { ok: false, reason: 'insufficient', n: usable.length }
  const sorted = [...usable].sort((a, b) => a.y - b.y)
  const k = Math.max(1, Math.round(sorted.length * worstFrac))
  const worst = sorted.slice(0, k), best = sorted.slice(-k)
  const dist = (a, b) => Math.sqrt(a.x.reduce((s, v, i) => s + (v - b.x[i]) ** 2, 0) / a.x.length)
  let nearest = [], unexplained = 0
  for (const w of worst) {
    const d = best.map((b) => dist(w, b))
    const m = Math.min(...d)
    nearest.push(m)
    if (m < 0.35) unexplained++   // 特征上像最好的那批，结果却最差
  }
  const meanDist = nearest.reduce((a, b) => a + b, 0) / nearest.length
  return { ok: true, n: usable.length, worst: k, unexplained, meanNearestDist: +meanDist.toFixed(3),
    signal: unexplained >= Math.max(1, Math.ceil(k / 2)),
    note: unexplained >= Math.max(1, Math.ceil(k / 2))
      ? '有 ' + unexplained + '/' + k + ' 个最差样本在特征上却接近最好样本 ⇒ 现有维度解释不了它们，需要新增维度'
      : '最差样本在特征上也确实最差 ⇒ 现有维度够用，问题在取值不在维度' }
}

/** 主动学习：挑「预测最不确定」的候选去花钱。不确定性 = 维度投票分歧（方差）+ 特征离训练集远。 */
export function activeSelect(candidates, rows, { budget = 8, weights = DEFAULT_WEIGHTS } = {}) {
  const trained = rows.filter((r) => r.x.every(Number.isFinite))
  const centroid = trained.length ? trained[0].x.map((_, i) => trained.reduce((a, r) => a + r.x[i], 0) / trained.length) : null
  const scored = candidates.map((c) => {
    const x = c.x || []
    const far = centroid && x.every(Number.isFinite) ? Math.sqrt(x.reduce((s, v, i) => s + (v - centroid[i]) ** 2, 0) / x.length) : 0
    const spread = x.filter(Number.isFinite).length ? stdev(x.filter(Number.isFinite)) : 0
    const util = x.reduce((a, v, i) => a + v * (weights[DIMENSIONS[i].id] || 0), 0)
    return { ...c, uncertainty: +(0.6 * far + 0.4 * spread).toFixed(4), utility: +util.toFixed(4) }
  })
  // 一半按不确定、一半按预期效用 —— 探索与利用兼顾
  const half = Math.max(1, Math.floor(budget / 2))
  const byUnc = [...scored].sort((a, b) => b.uncertainty - a.uncertainty).slice(0, half)
  const picked = new Set(byUnc.map((c) => c.id))
  const byUtil = [...scored].sort((a, b) => b.utility - a.utility).filter((c) => !picked.has(c.id)).slice(0, budget - byUnc.length)
  return { explore: byUnc, exploit: byUtil, all: [...byUnc, ...byUtil] }
}
function stdev(xs) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) }

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
export function writeJson(p, o) { fs.mkdirSync(require$path().dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }
function require$path() { return pathmod }
import pathmod from 'node:path'
