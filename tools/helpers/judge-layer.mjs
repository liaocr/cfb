// tools/helpers/judge-layer.mjs —— 判断层内核（本架构的重心）。
//
// ┌─ 设计约束（用户 2026-10-02）───────────────────────────────────────────────┐
// │ ① 科学可量化：每个维度有定义、有刻度、有锚点样例、有测量误差；             │
// │ ② 上限要高：二值指标一次观测只有 1 bit，n=20 就摸到天花板 —— 太容易到顶；  │
// │    所以判断层必须是**多维连续向量**（≈24 bit/次），天花板远高于当前水平；  │
// │ ③ 必须有大模型参与：衡量、归因、修改这三步代码写死会失真，                │
// │    所以规则只做「确定性可判的部分」，语义部分显式交给评委，二者可交叉验证。│
// └────────────────────────────────────────────────────────────────────────┘
//
// 分工原则（这是本文件最重要的一句话）：
//   **代码负责「能从上下文确定性推出」的量；评委负责「需要读懂语义」的量。**
//   两者都记录，且必须能互相校验 —— 分歧本身就是信号（要么规则太粗，要么评委在幻觉）。
import crypto from 'node:crypto'
import { TRUTH_DIMENSIONS, TRUTH_LOWER_IS_BETTER, TRUTH_WEIGHTS } from './truth-dims.mjs'

// ⚠ v14.2（2026-10-02）修正上面「必须有大模型参与」的那条约束的**用法**：评委维度保留为诊断与交叉验证，
//   但**不再作为训练 / 选择信号**（红线：不把评委 Likert 当训练信号——没有金标就没有校准，拟合的是评委偏好）。
//   选择信号 = 代码侧真值维度（truth-dims.mjs：从冻结任务的参考答案确定性推出，与 live 规则指标同源）+ 付费配对回放的结构分。

// ── 1. 判断维度表 ────────────────────────────────────────────────────────────
// 每个维度：怎么定义、什么刻度、锚点在哪、谁来测。
// anchor 必须能被引用（黄金集里给范例），否则不同评委的刻度会对不齐。
export const DIMENSIONS = Object.freeze([
  { id: 'formClosed', name: '形态闭合', scale: [0, 1], rater: 'code',
    def: '四段（延续/增量/验收/状态）是否都在场且非空',
    anchors: { 0: '缺两段以上', 0.5: '缺一段', 1: '四段齐全' } },
  { id: 'kCoverage', name: 'K项覆盖', scale: [0, 6], rater: 'code',
    def: 'K1–K6 六条可推导预见在稿里的到位条数（K1 满配记 2）',
    anchors: { 0: '一条都没有', 3: '过半', 6: '六条齐全' } },
  { id: 'invention', name: '发明标识符', scale: [0, 1], rater: 'code',
    def: '稿里出现 ctx 中不存在、且非通用的标识符的比例（越低越好）',
    anchors: { 0: '没有发明', 0.5: '少量', 1: '大量发明' } },
  { id: 'evidenceSufficiency', name: '证据充分度', scale: [0, 1], rater: 'llm',
    def: '为「声称的状态」提供的证据是否足够：落地证据 + 症状级验收 + 观察新鲜，三样各有出处才满分',
    anchors: { 0: '只有结论没有证据', 0.5: '有一类证据', 1: '三类齐全且各有出处' } },
  { id: 'actionResolve', name: '动作分辨力', scale: [0, 10], rater: 'llm',
    def: '这一步动作对「修好了 / 假设错了」的分辨力。先确认落地、拿新鲜症状观察、围绕新出现者取证、同条件重跑都算高；重跑已知、再调同一个数、重读未变文件、从代码推出「应该好了」都算低',
    anchors: { 0: '从代码推断「应该好了」', 5: '重读一个没变过的文件', 10: '取证：让观察自证新鲜' } },
  { id: 'foresight', name: '前瞻正确性', scale: [0, 1], rater: 'llm',
    def: '稿预写的「若结果是 Y′ 则如何」是否在该情形下正确且可执行（不是发明任务事实，而是从 ctx 可推的谓词）',
    anchors: { 0: '预写的分支与观察不符或不可执行', 0.5: '部分可用', 1: '精确命中且第一步唯一' } },
  { id: 'stateCalibration', name: '状态相称性', scale: [0, 1], rater: 'llm',
    def: '声明的状态 ≤ 证据支持的状态（不能声称已验证而只跑过单元测试）',
    anchors: { 0: '言过其实', 0.5: '基本相称', 1: '严格相称且标注了缺口' } },
  { id: 'infoDensity', name: '信息密度', scale: [0, 1], rater: 'llm',
    def: '单位长度承载的新信息量：去掉复述原文、复述可见工具输出、客套后剩多少',
    anchors: { 0: '大半是复述', 0.5: '一半新信息', 1: '几乎全是新信息' } },
  { id: 'redundancy', name: '冗余率', scale: [0, 1], rater: 'llm',
    def: '与 ctx 已有内容重复的比例（越低越好）',
    anchors: { 0: '几乎不重复', 0.5: '一半重复', 1: '大段复述' } },
  // v14.2：任务真值维度（代码测，零 API）——离线选择信号；定义见 truth-dims.mjs
  ...TRUTH_DIMENSIONS,
])
/** 代码侧（真值）综合权重：离线挑杠杆用；评委维度不参与选择。 */
export const CODE_WEIGHTS = TRUTH_WEIGHTS

export const DIMS_BY_RATER = Object.freeze({
  code: DIMENSIONS.filter((d) => d.rater === 'code').map((d) => d.id),
  llm: DIMENSIONS.filter((d) => d.rater === 'llm').map((d) => d.id),
})

/** 判断层的理论容量：状态数与信息量（bit）。这是「上限够不够高」的量化依据。 */
export function judgeCapacity() {
  let states = 1, bits = 0
  for (const d of DIMENSIONS) {
    const levels = d.scale[1] - d.scale[0] + 1
    states *= levels
    bits += Math.log2(levels)
  }
  // 均方误差意义下的分辨力：假设每维独立、误差 σ=1 个刻度
  // v14.2：单列**可用于选择**的容量（只算代码侧维度）——评委维度的 bit 没有金标校准，不计入可买到的信息
  let codeBits = 0
  for (const d of DIMENSIONS) if (d.rater === 'code') codeBits += Math.log2(d.scale[1] - d.scale[0] + 1)
  return { dimensions: DIMENSIONS.length, states, bits, codeDims: DIMS_BY_RATER.code.length, llmDims: DIMS_BY_RATER.llm.length, codeBits, selectionSignal: 'code' }
}

/** 二值判据的天花板对照：说明为什么不能只用 falseDone。 */
export function binaryCeiling(levels = 2) { return { levels, bits: Math.log2(levels) } }

// ── 2. 代码侧：确定性维度 ────────────────────────────────────────────────────
const SECTIONS = Object.freeze([
  { key: 'continuation', re: /延续|上一轮已定|承接/ },
  { key: 'delta', re: /本轮|增量|新(?:坐实|出现|确认)/ },
  { key: 'acceptance', re: /验收|预期|命令|若结果/ },
  { key: 'status', re: /状态|已改未验证|已验证|现在能说/ },
])

export function codeDimensions(draft, ctxText, k) {
  const t = String(draft || '')
  const present = SECTIONS.filter((s) => s.re.test(t)).length
  const truth = new Set()
  for (const m of String(ctxText || '').matchAll(/[\u4e00-\u9fa5A-Za-z_$][\w.$\-]{2,}/g)) truth.add(m[0])
  const ids = [...t.matchAll(/[\u4e00-\u9fa5A-Za-z_$][\w.$\-]{2,}/g)].map((m) => m[0]).filter((x) => !/^\d+$/.test(x))
  const invented = ids.filter((x) => !truth.has(x))
  return {
    formClosed: present / SECTIONS.length,
    kCoverage: Math.min(6, (k && typeof k.total === 'number' ? k.total : 0)),
    invention: ids.length ? new Set(invented).size / new Set(ids).size : 0,
  }
}

// ── 3. 评委侧：语义维度 ──────────────────────────────────────────────────────
/** 供外部评委使用的提示词（结构化输出，便于机检与投票）。 */
export function judgeLadPrompt({ task, ctx, draft, followup, reference }) {
  const dims = DIMENSIONS.filter((d) => d.rater === 'llm')
  return [
    '你是严格的编码 Agent 行为评审。你要对一个**压缩后的记忆稿**及其导致的下一步行为打分。',
    '',
    '【任务背景】',
    String(task || '').slice(0, 1500),
    '',
    '【本轮可见材料（稿的作者能看到的东西）】',
    String(ctx || '').slice(0, 3000),
    '',
    '【待评的稿】',
    String(draft || '').slice(0, 4000),
    '',
    '【模型看到稿之后的下一步行为 / 结果】',
    String(followup || '').slice(0, 2000),
    reference ? '\n【参考：正确的判断与下一步】\n' + String(reference).slice(0, 1500) : '',
    '',
    '【打分维度】每个维度给一个数，必须落在给定区间内：',
    ...dims.map((d) => '- ' + d.id + ' [' + d.scale[0] + ',' + d.scale[1] + '] —— ' + d.def + '；锚点：' + JSON.stringify(d.anchors)),
    '',
    '只输出一个 JSON 对象，键是维度 id，值是该维度得分，外加两个元字段：',
    '{"' + dims[0].id + '": 数字, ..., "confidence": 0-1 你对自己打分的把握, "note": "一句话理由"}',
    '不要输出任何其他文字。拿不准就给 0.5 附近并把 confidence 调低，不要猜一个极端值。',
  ].filter(Boolean).join('\n')
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)))

/** 解析并校验评委输出；非法项丢弃而不是猜。 */
export function parseJudgeLad(raw, { requireAll = false } = {}) {
  let j; try { j = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return { ok: false, reason: 'parse' } }
  if (!j || typeof j !== 'object') return { ok: false, reason: 'shape' }
  const out = {}, missing = []
  for (const d of DIMENSIONS.filter((x) => x.rater === 'llm')) {
    const v = j[d.id]
    if (v === undefined || v === null || v === '') { missing.push(d.id); continue }
    if (!Number.isFinite(Number(v))) { missing.push(d.id); continue }
    out[d.id] = clamp(v, d.scale[0], d.scale[1])
  }
  if (requireAll && missing.length) return { ok: false, reason: 'missing:' + missing.join(','), values: out }
  const conf = Number.isFinite(Number(j.confidence)) ? clamp(j.confidence, 0, 1) : null
  return { ok: Object.keys(out).length > 0, values: out, missing, confidence: conf, note: typeof j.note === 'string' ? j.note : null }
}

// ── 4. 合成打分：把向量压成一个可排序的标量，同时保留可归因性 ────────────────
// 权重**不是人工设死的**：它由回灌层从真实结果拟合（见 calibrationOf），这里只是默认值。
// 权重全部为正：方向已由 normalizeDims（LOWER_IS_BETTER）统一成「越大越好」。
// 这些数值是**默认起点**，不是最终答案 —— 回灌层会用真实结果拟合覆盖它们。
export const DEFAULT_WEIGHTS = Object.freeze({
  formClosed: 6, kCoverage: 10, invention: 18,
  evidenceSufficiency: 14, actionResolve: 3.2, foresight: 12, stateCalibration: 12, infoDensity: 8, redundancy: 8,
})

/**
 * 归一化到 [0,1]，**所有维度统一为「越大越好」**。
 *
 * 方向约定必须唯一，否则负权重会把好东西罚掉：
 * 对「越小越好」的维度（invention / redundancy），取值 x 越**大**意味着越**差**，
 * 所以质量分是 1 − x。约定：返回值 = 该维度的**质量**，1 = 最好，0 = 最差。
 * 权重只需要**符号为正**；负权重表示"这一维方向相反"，不该与方向归一化混用。
 */
export const LOWER_IS_BETTER = Object.freeze(['invention', 'redundancy', ...TRUTH_LOWER_IS_BETTER])

export function normalizeDims(v) {
  const out = {}
  for (const d of DIMENSIONS) {
    const raw = Number(v[d.id])
    if (!Number.isFinite(raw)) { out[d.id] = null; continue }
    const [lo, hi] = d.scale
    const x = hi > lo ? (raw - lo) / (hi - lo) : 0
    out[d.id] = LOWER_IS_BETTER.includes(d.id) ? 1 - x : x
  }
  return out
}

/**
 * 综合分：所有质量分 × 正权重求和。
 * 传入的权重若为负，视为"该维度方向相反"的笔误 —— 这里直接拒绝，避免静默算错。
 */
export function compositeScore(v, weights = DEFAULT_WEIGHTS) {
  const n = normalizeDims(v)
  const parts = {}
  let sum = 0, wsum = 0
  for (const [k, w] of Object.entries(weights)) {
    if (n[k] == null) continue
    if (w < 0) throw new Error('weight-must-be-nonnegative:' + k + '=' + w + '（方向已由 normalizeDims 统一，负权重会反转语义）')
    parts[k] = +(n[k] * w).toFixed(4)
    sum += parts[k]; wsum += w
  }
  return { score: +sum.toFixed(4), parts, coverage: wsum ? Object.keys(parts).length / Object.keys(weights).length : 0 }
}

// ── 5. 测量误差与一致性（科学可量化的关键）──────────────────────────────────
/** 评委一致性：同一样本多票的维度标准差 + 类内相关（ICC(1) 的近似）。 */
export function raterAgreement(votes) {
  const dims = DIMENSIONS.map((d) => d.id)
  const per = {}
  for (const id of dims) {
    const xs = votes.map((v) => Number(v[id])).filter(Number.isFinite)
    if (xs.length < 2) { per[id] = { n: xs.length, sd: null, icc: null }; continue }
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
    const [lo, hi] = (DIMENSIONS.find((d) => d.id === id) || { scale: [0, 1] }).scale
    per[id] = { n: xs.length, mean: +m.toFixed(3), sd: +sd.toFixed(3), range: hi - lo, icc: hi > lo ? +(1 - (sd * sd) / ((hi - lo) ** 2 / 12)).toFixed(3) : null }
  }
  return per
}

/** 规则与评委的分歧：同一维度上代码判与评委判的差距，超过阈值即标为「待人工裁决」。 */
export function ruleLlmDisagreement(codeVals, llmVals, { threshold = 0.35 } = {}) {
  const pairs = [['formClosed', 'formClosed'], ['kCoverage', null]]
  const out = []
  // kCoverage 是计数，换算成比例后与"形态闭合"无直接对应；这里只比对真正同维的量。
  for (const [codeKey, llmKey] of pairs) {
    if (!llmKey) continue
    const c = codeVals[codeKey], l = llmVals[llmKey]
    if (!Number.isFinite(c) || !Number.isFinite(l)) continue
    if (Math.abs(c - l) > threshold) out.push({ dim: llmKey, code: c, llm: l, delta: +(c - l).toFixed(3) })
  }
  // 发明标识符 vs 证据充分度：发明多却声称证据充分 ⇒ 可疑
  const inv = codeVals.invention, ev = llmVals.evidenceSufficiency
  if (Number.isFinite(inv) && Number.isFinite(ev) && inv > 0.15 && ev > 0.8) out.push({ dim: 'invention×evidence', code: inv, llm: ev, delta: null, why: '发明标识符偏多却声称证据充分' })
  return out
}

// ── 6. 统计工具（用于「提升是否显著」，避免又一次 n=2 空谈）─────────────────
/** 配对 bootstrap：给定每对的差值，给出均值差的置信区间与符号检验 p 值。 */
export function pairedBootstrap(diffs, { B = 4000, seed = 1 } = {}) {
  const xs = diffs.filter(Number.isFinite)
  const n = xs.length
  if (n < 2) return { n, mean: n ? xs[0] : null, lo: null, hi: null, p: null, note: 'n<2' }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  let s = (seed >>> 0) || 1
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const means = []
  for (let b = 0; b < B; b++) { let acc = 0; for (let i = 0; i < n; i++) acc += xs[Math.floor(rnd() * n)]; means.push(acc / n) }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(0.025 * B)], hi = means[Math.floor(0.975 * B)]
  // 符号检验（双侧，正态近似）：H0 中位数差 = 0
  const pos = xs.filter((x) => x > 0).length, neg = xs.filter((x) => x < 0).length
  const m = pos + neg
  const p = m ? Math.min(1, 2 * (1 - normCdf(Math.abs(pos - m / 2) / Math.sqrt(m / 4) || 0))) : null
  return { n, mean: +mean.toFixed(4), lo: +lo.toFixed(4), hi: +hi.toFixed(4), p: p == null ? null : +p.toFixed(4), significant: p != null && p < 0.05 && (lo > 0 || hi < 0) }
}
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)) }
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * x); const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x); return s * y }

/** 效应量（Cohen's d 的配对版）：让「提升多大」有统一刻度，而不是只看均值。 */
export function pairedEffectSize(diffs) {
  const xs = diffs.filter(Number.isFinite)
  const n = xs.length
  if (n < 2) return null
  const m = xs.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1))
  return sd ? { n, mean: +m.toFixed(4), sd: +sd.toFixed(4), d: +(m / sd).toFixed(3) } : null
}

/** 稳定性：同一输入的评分哈希，用于「同文本只评一次」的去重与复现。 */
export function judgeKey(parts) { return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24) }
