// tools/helpers/ranker.mjs —— 飞轮偏好对上的 CPU 可训练排序器（Bradley–Terry 逻辑回归，纯 JS，秒级）。
//
// 定位（说清楚，不夸大）：它**不是**压缩器的权重训练，也不替代真模型评委；它只是把飞轮里「真模型读稿后谁动作更对」的
// 偏好对学成一个 20 维线性打分，用来**在付费之前**给候选压缩稿排序（Hyperband 式赛马：先把预算投给最可能赢的臂）。
// 配对 < MIN_PAIRS 或留一交叉验证准确率 < 0.6 时它自动失效（status: untrained / weak），计划器照旧按杠杆顺序走。
import { roughTokens } from './experiment.mjs'

export const MIN_PAIRS = 20
const RX = {
  path: /(?:^|[\s(（「"'`])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+/g, codeSpan: /`[^`\n]{2,}`/g, oldText: /old_text|逐字|原文/g, verb: /(先|下一步|接着|然后)[^。\n]{0,12}(读|看|核对|grep|搜|跑|运行|执行|改|写)/g,
  hedge: /(可能|也许|大概|应该是|似乎|估计)/g, claim: /(已修复|修好了|已经解决|问题解决|done|fixed)/gi, number: /\d+(?:\.\d+)?/g, neg: /(不要|别|避免|勿|不能)/g, question: /[?？]/g,
  heading: /(^|\n)\s*(#+|\d+[.、)]|[-*•])\s/g, forbid: /(【|】)/g, state: /(状态|进度|已做|未做|待办|下一步)/g, error: /(error|Error|ENOENT|EACCES|timeout|失败|报错)/g, file: /\.(?:js|mjs|ts|json|md|yml|yaml|py)\b/g
}
const count = (rx, s) => (s.match(rx) || []).length
/** 20 维特征（全部可解释，无外部模型）。 */
export function features(text = '') {
  const t = String(text), tok = roughTokens(t) || 1, lines = t.split('\n').filter((l) => l.trim()).length || 1
  const nOldSpan = count(/old_text\s*(?:是\s*)?`[^`\n]+`/g, t), nOldRaw = count(RX.oldText, t)
  const oldCommit = nOldRaw >= 5 ? -0.5 : (nOldSpan >= 1 && nOldSpan <= 2 ? 1 : nOldRaw >= 1 && nOldRaw <= 3 ? 0.5 : 0)
  const f = [Math.log1p(tok) / 8, lines / 40, count(RX.path, t) / 5, count(RX.codeSpan, t) / 5, oldCommit, count(RX.verb, t) / 3, count(RX.hedge, t) / 3, count(RX.claim, t) / 2, count(RX.number, t) / 10, count(RX.neg, t) / 3,
    count(RX.question, t) / 2, count(RX.heading, t) / 10, count(RX.forbid, t) / 4, count(RX.state, t) / 4, count(RX.error, t) / 4, count(RX.file, t) / 5, (t.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(1, t.length), t.trim().endsWith('。') || t.trim().endsWith('.') ? 1 : 0, /\n\s*\n/.test(t) ? 1 : 0, 1]
  return f.map((x) => Math.max(-3, Math.min(3, x)))
}
export const FEATURE_NAMES = Object.freeze(['logTokens', 'lines', 'paths', 'codeSpans', 'oldText', 'nextStepVerb', 'hedges', 'doneClaims', 'numbers', 'negations', 'questions', 'headings', 'brackets', 'stateWords', 'errorTokens', 'fileExt', 'cjkRatio', 'endsSentence', 'hasBlank', 'bias'])
const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
/** 训练：pairs = [{chosenText, rejectedText}] → 权重 w，使 σ(w·(f_c − f_r)) 最大化；L2 正则，固定步数，确定性。 */
export function fit(pairs, { epochs = 300, lr = 0.1, l2 = 0.01 } = {}) {
  const diffs = pairs.map((p) => { const a = features(p.chosenText), b = features(p.rejectedText); return a.map((x, i) => x - b[i]) })
  const dim = FEATURE_NAMES.length; let w = new Array(dim).fill(0)
  for (let ep = 0; ep < epochs; ep++) {
    const g = new Array(dim).fill(0)
    for (const d of diffs) { const p = sigmoid(dot(w, d)); for (let i = 0; i < dim; i++) g[i] += (p - 1) * d[i] }
    for (let i = 0; i < dim; i++) w[i] -= lr * (g[i] / Math.max(1, diffs.length) + l2 * w[i])
  }
  const acc = diffs.length ? diffs.filter((d) => dot(w, d) > 0).length / diffs.length : null
  return { w, trainAcc: acc == null ? null : +acc.toFixed(3) }
}
/** 留一交叉验证准确率（n ≤ 200 时逐个留；更大时 10 折）。 */
export function crossValidate(pairs, opts) {
  const n = pairs.length; if (n < 2) return null
  const folds = n <= 200 ? n : 10; let hit = 0, tot = 0
  for (let k = 0; k < folds; k++) {
    const test = pairs.filter((_, i) => i % folds === k), train = pairs.filter((_, i) => i % folds !== k)
    if (!test.length || !train.length) continue
    const { w } = fit(train, opts)
    for (const p of test) { const a = features(p.chosenText), b = features(p.rejectedText); if (dot(w, a) > dot(w, b)) hit++; tot++ }
  }
  return tot ? +(hit / tot).toFixed(3) : null
}
/** 训练 + 自评 → 模型对象（可 JSON 持久化）。 */
export function trainRanker(pairs, { minPairs = MIN_PAIRS, weakBelow = 0.6, ...opts } = {}) {
  const usable = (pairs || []).filter((p) => p && typeof p.chosenText === 'string' && typeof p.rejectedText === 'string' && p.chosenText !== p.rejectedText)
  if (usable.length < minPairs) return { schema: 'cfb.ranker/1', status: 'untrained', pairs: usable.length, minPairs, w: null, cvAcc: null, note: `偏好对 ${usable.length} < ${minPairs}：排序器不参与计划` }
  const cvAcc = crossValidate(usable, opts), { w, trainAcc } = fit(usable, opts)
  const status = cvAcc != null && cvAcc >= weakBelow ? 'ready' : 'weak'
  const top = w.map((x, i) => ({ name: FEATURE_NAMES[i], w: +x.toFixed(3) })).filter((x) => x.name !== 'bias').sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 5)
  return { schema: 'cfb.ranker/1', status, pairs: usable.length, minPairs, w: w.map((x) => +x.toFixed(5)), cvAcc, trainAcc, top, note: status === 'ready' ? `留一 CV 准确率 ${cvAcc} ≥ ${weakBelow}：用于候选预排序（不替代评委）` : `留一 CV 准确率 ${cvAcc} < ${weakBelow}：特征不够或偏好对太杂，排序器不参与计划` }
}
export const scoreText = (model, text) => (model?.w ? +dot(model.w, features(text)).toFixed(4) : null)
/** 给候选稿排序（分高在前）；模型未就绪时原样返回并标注。 */
export function rankCandidates(model, candidates) {
  if (!model || model.status !== 'ready') return { ranked: candidates.map((c) => ({ ...c, rankerScore: null })), used: false }
  return { ranked: candidates.map((c) => ({ ...c, rankerScore: scoreText(model, c.text) })).sort((a, b) => b.rankerScore - a.rankerScore), used: true }
}
