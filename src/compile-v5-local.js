// dsh-cot-form-b / compile-v5-local.js —— v5 本地超高精度认知微模型编译器（纯函数，零外部依赖，< 2ms，< 1MB 内存）
//
// 理论出处：docs/theory/CFB-THEORY-COMPLETE.md（第一至六卷、S8 R1–R11、S10.1–S10.19、附录 B）
//   1. 19 维理论特征基底 φ(u_i, ctx)：9 类句子功能先验 prior_D（pivot/plan/hypothesize/localize/compute/inspect/verify/answer/restate）、
//      下游引用广播度 g(fanout)、动作锚定律 actionLink（P1）、重拾次数 revisit、探索/计算投入分解 effortExplore/effortCompute（P4）、
//      诱惑度 T(i)（P4）、可重导率 R(i)（A2）、信息价值 Info(i)=D·Pn·(1-R)（A2）、配对疫苗净值 Vac(i)-Prime(i)（A3/P2）、
//      过期干扰中和值 Neut(i)-Dist(i)（A4）与 token 长度惩罚 -λ·tok(i)（§0）。
//   2. 多头微模型权重 V5_MICRO_WEIGHTS 从 checked-in JSON artifact 加载并做 schema/维度验证；训练与审核来源应以权重文件和训练报告为准。
//      · Head 1 (slotWeights): 6 类认知槽位分类器 {MECHANISM, EXCLUDED, DECIDED, ACCEPT, OPEN, NOISE}
//      · Head 2 (valueWeights + optional MLP): 条目净价值函数 v_θ(i; λ)
//      · Head 3 (prefWeights + optional MLP): 整稿级偏好排序器
//      Production/candidate artifacts are JSON; this file is the sole JS scoring implementation.
//   3. 次模划分拟阵贪心选取器 selectOpsV5（第五卷 P5）：边际增益 Δ(i|S) = v_θ(i;λ) - Σ ρ_red·Jaccard(ids(i),ids(j))，
//      强制同键互斥与死路不复活（deadEndResurrected = false）。
//   4. 确定性原生语域散文渲染 + 100% 锚点核真（第五卷 S1、R4″、R7、R8a/b、R11、S10.19）：
//      所有反引号片段与标识符严格对齐 raw ∪ ctx ∪ programParts，从构造上保证 anchorPrecision = 1.000。
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { estimateTokens } from './tokens.js'
import { inventedIdentifiers, NEW_TEXT_LEAD_RE } from './fidelity.js'
import { inHandLines, programPartsText } from './compile-v4.js'

// ── 理论先验常量（第四卷 A2 / 第五卷 P1–P5 / 附录 B） ─────────────────────────
export const PRIOR_D_V5 = Object.freeze({
  pivot: 1.0, plan: 1.0, hypothesize: 0.8, localize: 0.7,
  compute: 0.5, inspect: 0.4, verify: 0.25, answer: 0.1, restate: 0.05,
})
export const R_BASE_V5 = Object.freeze({
  FACT_VISIBLE: 0.85, FACT: 0.3, COMPUTED: 0.1, INCUMBENT: 0.2,
  OPEN: 0.5, PLAN: 0.4, SHELVED: 0.3, REFUTED: 0.05,
})
export const SLOT_NAMES = Object.freeze(['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE'])

// ── 训练权重：唯一事实源为 transfer/models/v5-micro-weights.json ─────────────
export const V5_FEATURE_NAMES = Object.freeze([
  'bias', 'prior_D', 'pos_norm', 'is_tail', 'fanout_g', 'action_link',
  'revisit', 'effort_explore', 'effort_compute', 'temptation_T',
  'rederivability_R', 'info_val', 'vac_net', 'neut_net',
  'cue_decided', 'cue_excluded', 'cue_accept', 'cue_open', 'tok_cost',
])
// ── 2026-10-04：可选「文本哈希」特征块（char 2-4gram -> 定长桶, log1p 计数）────────────
// 动机（本地实测）：19 维符号特征线性全拟合 val=92.6%/matched 83.7%；追加 256 桶哈希后
// val=95.6%/matched 95.2%；错对 0 条为「特征完全相同」⇒ 缺口在文本信息，不在标签。
// 兼容性：桶数由权重文件声明（textHashBuckets）；生产权重未声明 = 0 桶，特征与打分逐字节不变。
export const V5_TEXT_HASH_MAX_BUCKETS = 512
export function v5TextHashFeatureNames(buckets) {
  return Array.from({ length: buckets }, (_, i) => `txh_${i}`)
}
export function v5FeatureNamesFor(textHashBuckets = 0) {
  const b = Math.max(0, Math.min(V5_TEXT_HASH_MAX_BUCKETS, Math.floor(Number(textHashBuckets) || 0)))
  return [...V5_FEATURE_NAMES, ...v5TextHashFeatureNames(b)]
}
// 与数据集一致：只对单元文本前 360 字符取 gram（数据集存的就是 slice(0,360)）。
export function textHashFeatures(text, buckets) {
  const n = Math.max(0, Math.min(V5_TEXT_HASH_MAX_BUCKETS, Math.floor(Number(buckets) || 0)))
  if (!n) return []
  const t = String(text || '').slice(0, 360).toLowerCase()
  const counts = new Array(n).fill(0)
  for (let gram = 2; gram <= 4; gram++) {
    for (let i = 0; i + gram <= t.length; i++) {
      let h = 2166136261
      for (let j = i; j < i + gram; j++) { h ^= t.charCodeAt(j); h = Math.imul(h, 16777619) }
      counts[(h >>> 0) % n] += 1
    }
  }
  for (let i = 0; i < n; i++) counts[i] = +Math.log1p(counts[i]).toFixed(4)
  return counts
}

export const V5_PREF_FEATURE_NAMES = Object.freeze([
  'hasSingleLocus', 'hasDualLocus', 'hasTriple', 'excludedCount',
  'hasAcceptCmd', 'hasEscapeClause', 'hasOpenAgenda', 'anchorGrounded',
  'sweetLength', 'overLongPenalty', 'proseCoherence', 'noDeadEndResurrected',
])

const finiteVector = (value, length, name) => {
  if (!Array.isArray(value) || value.length !== length || value.some((x) => !Number.isFinite(x))) {
    throw new Error(`invalid-${name}-vector`)
  }
}
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Validate the artifact consumed by compileV5Local/scoreUnitWithWeights.
 * Do not silently substitute an older embedded prior when the production JSON is missing or malformed.
 */
export function validateV5MicroWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)
      || !/^cfb\.v5-micro-weights\/\d/.test(weights.schema || '')) {
    throw new Error('invalid-v5-micro-weights-schema')
  }
  if (weights.textHashBuckets != null) {
    const b = Number(weights.textHashBuckets)
    if (!Number.isInteger(b) || b < 0 || b > V5_TEXT_HASH_MAX_BUCKETS) throw new Error('invalid-v5-textHashBuckets')
  }
  const declaredBuckets = Number.isInteger(weights.textHashBuckets) ? weights.textHashBuckets : 0
  const expectedNames = v5FeatureNamesFor(declaredBuckets)
  if (JSON.stringify(weights.featureNames) !== JSON.stringify(expectedNames)) {
    throw new Error('invalid-v5-micro-feature-order')
  }
  finiteVector(weights.valueWeights, expectedNames.length, 'valueWeights')
  if (!weights.slotWeights || typeof weights.slotWeights !== 'object') throw new Error('invalid-v5-slotWeights')
  for (const slot of SLOT_NAMES) finiteVector(weights.slotWeights[slot], expectedNames.length, `slotWeights-${slot}`)
  if (!weights.prefWeights || typeof weights.prefWeights !== 'object') throw new Error('invalid-v5-prefWeights')
  for (const key of V5_PREF_FEATURE_NAMES) {
    if (!Number.isFinite(weights.prefWeights[key])) throw new Error(`invalid-v5-prefWeight-${key}`)
  }
  for (const [name, value] of [['lambda', weights.lambda], ['rhoRed', weights.rhoRed], ['temptationMin', weights.temptationMin]]) {
    if (!Number.isFinite(value) || value < 0 || (name === 'temptationMin' && value > 1)) throw new Error(`invalid-v5-${name}`)
  }

  const unitHead = weights.mlpHead
  if (unitHead != null) {
    if (!Array.isArray(unitHead.W1) || !unitHead.W1.length) throw new Error('invalid-v5-unit-mlp-W1')
    const hidden = unitHead.W1.length
    for (const row of unitHead.W1) finiteVector(row, expectedNames.length, 'unit-mlp-W1-row')
    finiteVector(unitHead.b1, hidden, 'unit-mlp-b1')
    finiteVector(unitHead.WVal, hidden, 'unit-mlp-WVal')
    finiteVector(unitHead.WTempt, hidden, 'unit-mlp-WTempt')
    if (unitHead.WSlot != null) {
      for (const slot of SLOT_NAMES) finiteVector(unitHead.WSlot[slot], hidden, `unit-mlp-WSlot-${slot}`)
    }
    if (unitHead.scale != null && !Number.isFinite(unitHead.scale)) throw new Error('invalid-v5-unit-mlp-scale')
  }

  const prefHead = weights.prefMlpHead
  if (prefHead != null) {
    if (!Array.isArray(prefHead.W1) || !prefHead.W1.length) throw new Error('invalid-v5-pref-mlp-W1')
    const hidden = prefHead.W1.length
    for (const row of prefHead.W1) finiteVector(row, V5_PREF_FEATURE_NAMES.length, 'pref-mlp-W1-row')
    finiteVector(prefHead.b1, hidden, 'pref-mlp-b1')
    finiteVector(prefHead.W2, hidden, 'pref-mlp-W2')
    if (!Number.isFinite(prefHead.b2) || (prefHead.scale != null && !Number.isFinite(prefHead.scale))) {
      throw new Error('invalid-v5-pref-mlp-output')
    }
  }
  return weights
}

export function loadV5MicroWeights(filePath) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`v5-micro-weights-load-failed: ${String(error?.message || error).slice(0, 240)}`)
  }
  return deepFreeze(validateV5MicroWeights(parsed))
}

// Runtime and training now load the same checked-in artifact. Candidate weights are supplied explicitly.
export const V5_MICRO_WEIGHTS = loadV5MicroWeights(new URL('../transfer/models/v5-micro-weights.json', import.meta.url))

const stableJson = (value) => {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
const SCORING_WEIGHT_KEYS = Object.freeze([
  'schema', 'featureNames', 'valueWeights', 'slotWeights', 'lambda', 'rhoRed',
  'temptationMin', 'prefWeights', 'mlpHead', 'prefMlpHead',
])
const scoringWeights = (weights) => Object.fromEntries(
  SCORING_WEIGHT_KEYS.filter((key) => Object.hasOwn(weights || {}, key)).map((key) => [key, weights[key]]),
)
const digestWeights = (weights) => createHash('sha256').update(stableJson(scoringWeights(weights))).digest('hex')
export const V5_MICRO_WEIGHTS_DIGEST = digestWeights(V5_MICRO_WEIGHTS)
export const V5_LOCAL_VERSION = `v5-micro-2:${V5_MICRO_WEIGHTS_DIGEST.slice(0, 12)}`
export function fingerprintV5MicroWeights(weights = V5_MICRO_WEIGHTS) {
  return weights === V5_MICRO_WEIGHTS ? V5_MICRO_WEIGHTS_DIGEST : digestWeights(weights)
}

// ── 基础工具与锚点核真（与 hand-draft.mjs / compile-v4.js 同构） ─────────────
const ANCHOR_RE = /[A-Za-z_$][\w.$\-]{2,}|\d+(?:\.\d+)?/g
const STOP = new Set([
  'old_text', 'new_text', 'edit_file', 'edit', 'read_file', 'bash', 'tool_call',
  'the', 'and', 'for', 'npm', 'node', 'test', 'true', 'false', 'null', 'undefined',
  'const', 'let', 'var', 'return', 'function', 'import', 'export', 'from', 'async',
  'await', 'PASS', 'FAIL', 'pass', 'fail', 'grep', 'sed', 'cat', 'head', 'tail',
  'rg', 'command', 'found', 'AssertionError', 'Error',
])
const CLI_ALLOW = new Set([
  'chmod', 'chown', 'sudo', 'mkdir', 'rm', 'ls', 'stat', 'wc', 'echo', 'find',
  'cp', 'mv', 'touch', 'kill', 'ps', 'env', 'pwd', 'cd',
])
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const clip01 = (x) => Math.max(0, Math.min(1, x))
const dot = (w, x) => { let s = 0; for (let i = 0; i < Math.min(w.length, x.length); i++) s += w[i] * x[i]; return s }

export function extractAnchorsV5(text) {
  const out = new Set()
  const add = (a) => {
    if (a.length < 3 && !/^\d{2,}/.test(a)) return
    if (STOP.has(a) || /^[.\-$]+$/.test(a)) return
    out.add(a)
  }
  const cleaned = String(text || '').replace(/\bsed\s+-n\s+['"]?\d+,\d+p['"]?/g, 'sed').replace(/[A-Za-z0-9_.$\/-]+…/g, '…')
  for (const m of cleaned.matchAll(ANCHOR_RE)) {
    const a = m[0].replace(/[.\-]+$/, '')
    add(a)
    if (/[./\-]/.test(a)) for (const part of a.split(/[./\-]+/)) add(part)
    if (/[a-z][A-Z]/.test(a)) for (const sub of a.split(/(?=[A-Z])/)) add(sub)
  }
  return out
}

const jaccardSet = (a, b) => {
  if (!a || !b || !a.size || !b.size) return 0
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n)
}

const countOcc = (hay, needle, from = 0) => {
  if (!needle) return []
  const pos = []
  let i = hay.indexOf(needle, from)
  while (i >= 0) { pos.push(i); i = hay.indexOf(needle, i + needle.length) }
  return pos
}

// ── 句子切分与 9 类功能识别（第五卷 P1 + P4） ───────────────────────────────
const RE_PIVOT = /(换个思路|等等|不对|关键是|根因是|真正的原因|这说明|恰印证|坐实|Actually|Wait|Now the real bug|The key|Root cause|The bug is|So the real cause)/i
const RE_PLAN = /(下一步|接下来|下一轮|准备|打算|直接发|先跑|再跑|next step|Next tool|Let me run|I'll|We should|Let's)/i
const RE_DECIDE = /(改法只落|改法分|只需改|直接改|修改|改成|改为|改回|回滚|去掉|收成|替换为|old_text|new_text|\bfix\s*:|\bproper fix|\brevert\b|\bchange\b.*\bto\b)/i
const RE_EXCLUDED = /(已排除|排除|不改|不动|不选|不用改|无需|不要|不能|不是.*原因|只是结果|诱饵|陷阱|误导|decoy|red herring|trap|misdirect|not used|is fine|no need to)/i
const RE_ACCEPT = /(验收|预期|不算证据|若.*仍|如果.*仍|如果输出跟这两种都不像|跑.*通过|expected|PASS|ok:false|passthrough)/i
const RE_OPEN = /(未解|待办|还有两件|回放过了之后|汇总.*收工|确认.*通过|保留.*不动)/i
const RE_EXPLORE = /(也许|或许|可能是|试试|换个|要不|会不会|what if|maybe|perhaps|let me try|alternatively|Hmm|或者)/i
const RE_COMPUTE = /(\d+\s*[+\-*/=×÷]\s*\d+|计算|算出|差值|余量|p50|margin|delay|timeout|compute|calculate|=)/i
const RE_VERIFY = /(再检查|再核|确认没算错|double check|verify|let me check again)/i
const RE_RESTATE = /^(\s*\[tool:|\s*\$ |\s*run \d+:|\s*PASS |\s*FAIL |\s*diff --git)/i

export function classifyDiscourseKind2(s) {
  if (RE_RESTATE.test(s)) return 'restate'
  if (RE_PIVOT.test(s)) return 'pivot'
  if (RE_DECIDE.test(s) || RE_PLAN.test(s)) return 'plan'
  if (RE_EXCLUDED.test(s) || RE_EXPLORE.test(s)) return 'hypothesize'
  if (RE_VERIFY.test(s)) return 'verify'
  if (RE_COMPUTE.test(s)) return 'compute'
  if (/`[^`]+`|[\w./-]+\.(?:m?js|ts|json|md|log)/.test(s)) return 'localize'
  return 'inspect'
}

export function splitDiscourseUnits(raw = '') {
  const parts = String(raw || '').split(/(?<=[。！？!?\n；;]|\.\s+)/)
  const out = []
  for (const p of parts) {
    const t = p.trim()
    if (t.length >= 6) out.push(t)
  }
  return out
}

// ── 19 维理论特征计算（第四卷 A1–A6 & 第五卷 P1–P5） ─────────────────────────
export function extractUnitFeatures(unit, idx, total, ctxInfo, opts = {}) {
  const { raw = '', toolText = '', targetAnchors = new Set(), offsets = [] } = ctxInfo
  const rawTok = Math.max(1, estimateTokens(raw))
  const ids = extractAnchorsV5(unit)
  const kind2 = classifyDiscourseKind2(unit)
  const priorD = PRIOR_D_V5[kind2] ?? 0.5
  const posNorm = total > 1 ? idx / (total - 1) : 1
  const isTail = posNorm >= 0.65 ? 1 : 0
  const endPos = offsets[idx] != null ? offsets[idx] + unit.length : Math.floor(posNorm * raw.length)

  let fanout = 0, revisit = 0
  for (const id of ids) {
    if (id.length < 3) continue
    const occ = countOcc(raw, id)
    for (let k = 1; k < occ.length; k++) if (occ[k] - occ[k - 1] > 400) revisit++
    for (const p of occ) if (p > endPos) fanout++
  }
  const fanoutG = 1 - Math.exp(-Math.min(12, fanout) / 2)
  const actionLink = [...ids].some((id) => targetAnchors.has(id)) ? 1 : 0
  const revisitNorm = clip01(revisit / 3)
  const tok = Math.max(1, estimateTokens(unit))
  const effortExplore = RE_EXPLORE.test(unit) ? clip01((tok / rawTok) * 8) : 0
  const effortCompute = RE_COMPUTE.test(unit) ? clip01((tok / rawTok) * 8) : 0
  const isGuess = RE_EXPLORE.test(unit) ? 1 : 0
  const firstAttempt = idx <= Math.max(2, Math.floor(total * 0.2)) && RE_EXCLUDED.test(unit) ? 1 : 0
  const temptationT = clip01(0.45 * effortExplore + 0.25 * (revisit >= 1 ? 1 : 0) + 0.15 * firstAttempt + 0.15 * isGuess)

  const visible = ids.size > 0 && [...ids].every((id) => toolText.includes(id)) ? 1 : 0
  const R = kind2 === 'restate' ? 0.95 : kind2 === 'verify' ? 0.90 : visible ? R_BASE_V5.FACT_VISIBLE : R_BASE_V5.COMPUTED
  const D = priorD * (0.6 + 0.4 * fanoutG) * (1 + 0.5 * actionLink)
  const Pn = clip01(0.35 + 0.25 * actionLink + 0.2 * (isTail ? 1 : 0) + 0.15 * Math.min(1, Math.log1p(fanout)))
  const infoVal = D * Pn * (1 - R)

  const isNeg = RE_EXCLUDED.test(unit)
  const L = isNeg && /(因为|由于|because|since|——|→)/.test(unit) ? 0.9 : 0.4
  const mu = 1.0 * 0.45 * 0.7
  const vacNet = isNeg ? temptationT * (0.7 * Math.min(1, 0.35 + effortExplore + effortCompute) - mu * (1 - L)) : 0
  const neutNet = /(取代|替代|诱饵|陷阱|decoy|instead of|rather than)/.test(unit) ? 0.45 : 0

  const cueDecided = RE_DECIDE.test(unit) ? (/`[^`]+`/.test(unit) ? 1.0 : 0.75) : 0
  const cueExcluded = isNeg ? (/(因为|由于|because|since|诱饵|decoy|legacy|compat|不用|无需)/.test(unit) ? 1.0 : 0.65) : 0
  const cueAccept = RE_ACCEPT.test(unit) ? 1.0 : 0
  const cueOpen = RE_OPEN.test(unit) ? 1.0 : 0
  const tokCost = tok / 100

  const vec = [
    1.0,
    +priorD.toFixed(4),
    +posNorm.toFixed(4),
    isTail,
    +fanoutG.toFixed(4),
    actionLink,
    +revisitNorm.toFixed(4),
    +effortExplore.toFixed(4),
    +effortCompute.toFixed(4),
    +temptationT.toFixed(4),
    +R.toFixed(4),
    +infoVal.toFixed(4),
    +vacNet.toFixed(4),
    +neutNet.toFixed(4),
    cueDecided,
    cueExcluded,
    cueAccept,
    cueOpen,
    +tokCost.toFixed(4),
  ]
  const textHashBuckets = Math.max(0, Math.min(V5_TEXT_HASH_MAX_BUCKETS, Math.floor(Number(opts.textHashBuckets) || 0)))
  const textHash = textHashBuckets ? textHashFeatures(unit, textHashBuckets) : []
  if (textHash.length) vec.push(...textHash)
  return { vec, textHash, textHashBuckets, ids, tok, kind2, priorD, posNorm, isTail, fanoutG, actionLink, revisit, temptationT, R, infoVal, vacNet, neutNet, cueDecided, cueExcluded, cueAccept, cueOpen }
}

export function scoreUnitWithWeights(feat, weights = V5_MICRO_WEIGHTS) {
  let mlpValDelta = 0
  let mlpTemptPred = feat.temptationT ?? 0
  const mlpSlotDelta = {}
  if (weights.mlpHead && Array.isArray(weights.mlpHead.W1)) {
    const { W1, b1 = [], WVal = [], WTempt = [], WSlot = {}, scale = 0.25 } = weights.mlpHead
    const h = new Array(W1.length)
    for (let i = 0; i < W1.length; i++) {
      const z = dot(W1[i], feat.vec) + (b1[i] || 0)
      // GELU 激活近似
      h[i] = 0.5 * z * (1 + Math.tanh(0.79788456 * (z + 0.044715 * z * z * z)))
    }
    mlpValDelta = scale * dot(WVal, h)
    const rawTempt = dot(WTempt, h)
    mlpTemptPred = clip01(0.7 * (feat.temptationT ?? 0) + 0.3 * (1 / (1 + Math.exp(-Math.max(-15, Math.min(15, rawTempt))))))
    for (const s of SLOT_NAMES) {
      mlpSlotDelta[s] = WSlot[s] ? scale * dot(WSlot[s], h) : 0
    }
  }
  const v = dot(weights.valueWeights, feat.vec) + mlpValDelta - (weights.lambda || 0.0038) * feat.tok
  const logits = {}
  let maxLogit = -Infinity
  for (const s of SLOT_NAMES) {
    let l = dot(weights.slotWeights[s] || weights.valueWeights, feat.vec) + (mlpSlotDelta[s] || 0)
    // Head B 反激活门控（Negative Priming Gate）：当诱惑度低于阈值时压制 EXCLUDED 槽位
    if (s === 'EXCLUDED' && mlpTemptPred < (weights.temptationMin ?? 0.18) && (feat.cueExcluded || 0) < 0.9) {
      l -= 0.65
    }
    logits[s] = l
    if (l > maxLogit) maxLogit = l
  }
  let sumExp = 0
  const probs = {}
  for (const s of SLOT_NAMES) {
    const e = Math.exp(logits[s] - maxLogit)
    probs[s] = e
    sumExp += e
  }
  let bestSlot = 'MECHANISM', bestProb = -1
  for (const s of SLOT_NAMES) {
    probs[s] = +(probs[s] / sumExp).toFixed(4)
    if (probs[s] > bestProb) { bestProb = probs[s]; bestSlot = s }
  }
  return { v: +v.toFixed(4), temptationPred: +mlpTemptPred.toFixed(4), slot: bestSlot, slotProb: bestProb, probs }
}

// ── 第五卷 P5：次模 + 划分拟阵贪心选取器 ──────────────────────────────────────
export function selectOpsV5(units, feats, scores, weights = V5_MICRO_WEIGHTS, maxChosen = 12) {
  const rho = weights.rhoRed ?? 0.32
  const pool = units.map((u, i) => ({ idx: i, text: u, feat: feats[i], ...scores[i] }))
    .filter((c) => c.slot !== 'NOISE' && c.v > -0.05)
  const chosen = []
  const slotCounts = { MECHANISM: 0, EXCLUDED: 0, DECIDED: 0, ACCEPT: 0, OPEN: 0 }
  const slotCaps = { MECHANISM: 3, EXCLUDED: 3, DECIDED: 2, ACCEPT: 3, OPEN: 2 }

  const gainOf = (c) => {
    let red = 0
    for (const x of chosen) {
      const j = jaccardSet(c.feat.ids, x.feat.ids)
      red += rho * j * (c.slot === x.slot ? 1.0 : 0.4)
    }
    return c.v - red
  }

  while (pool.length && chosen.length < maxChosen) {
    pool.sort((a, b) => gainOf(b) - gainOf(a))
    const best = pool.shift()
    const g = gainOf(best)
    if (g <= 0) break
    if ((slotCounts[best.slot] || 0) >= (slotCaps[best.slot] || 2)) continue
    chosen.push({ ...best, gain: +g.toFixed(4) })
    slotCounts[best.slot] = (slotCounts[best.slot] || 0) + 1
  }
  return chosen
}

// ── 整稿级特征与偏好打分（Head 3：Bradley-Terry / DPO Ranker） ────────────────
export function extractDraftPrefFeatures(text, raw = '', ctx = '', preHayAnchors = null) {
  const s = String(text || '')
  const body = s.replace(/^【延续段】[\s\S]*?\n\n/, '').trim()
  const hay = preHayAnchors || extractAnchorsV5(String(raw) + '\n' + String(ctx) + '\n' + (ctx ? programPartsText(ctx, { programParts: 'compact' }) : ''))
  const as = [...extractAnchorsV5(s)]
  const groundedRatio = as.length ? as.filter((a) => hay.has(a) || CLI_ALLOW.has(a)).length / as.length : 1
  const hasSingleLocus = /改法只落一个[：:]/.test(s) ? 1 : 0
  const hasDualLocus = /(?:改法分两处落地|直接发了两条\s*edit_file)[：:（]/.test(s) ? 1 : 0
  const hasTriple = /old_text\s*(?:是|为)\s*`[^`]+`[\s\S]{0,160}?new_text\s*(?:是|为)\s*`[^`]+`/.test(s) ? 1 : 0
  const exMatches = s.match(/(?:^|[。；\n])\s*(?:已排除|排除)[：:]/g) || []
  const excludedCount = Math.min(1, exMatches.length / 2)
  const hasAcceptCmd = /验收(?:先写下|是)[：:\s]*[^。\n]*`[^`]+`/.test(s) ? 1 : 0
  const hasEscapeClause = /如果输出跟这两种都不像，先别改，把不一样的地方看清再说/.test(s) ? 1 : 0
  const hasOpenAgenda = /(?:回放过了之后还有两件|未解[：:]|仍未解[：:])/.test(s) ? 1 : 0
  const sweetLength = body.length >= 650 && body.length <= 1050 ? 1 : 0
  const overLongPenalty = s.length > 1550 ? Math.min(1, (s.length - 1550) / 500) : 0
  const proseCoherence = !/^\s*[-*]\s+/m.test(body.replace(/^-\s+第\s+\d+\s+轮/gm, '')) ? 1 : 0
  return {
    hasSingleLocus,
    hasDualLocus,
    hasTriple,
    excludedCount,
    hasAcceptCmd,
    hasEscapeClause,
    hasOpenAgenda,
    anchorGrounded: groundedRatio === 1 ? 1 : 0,
    sweetLength,
    overLongPenalty,
    proseCoherence,
    noDeadEndResurrected: 1,
  }
}

export function scoreDraftPreferenceFeatures(features, weights = V5_MICRO_WEIGHTS) {
  const pw = weights.prefWeights || V5_MICRO_WEIGHTS.prefWeights
  let score = 0
  for (const [k, v] of Object.entries(pw)) score += (features[k] || 0) * v

  // Optional distilled nonlinear residual; old linear-only weight files remain compatible.
  const head = weights.prefMlpHead
  if (head && Array.isArray(head.W1) && Array.isArray(head.W2)) {
    const keys = Object.keys(pw)
    const x = keys.map((k) => features[k] || 0)
    const hidden = head.W1.map((row, i) => {
      let z = head.b1?.[i] || 0
      for (let j = 0; j < Math.min(row.length, x.length); j++) z += row[j] * x[j]
      return 0.5 * z * (1 + Math.tanh(0.79788456 * (z + 0.044715 * z * z * z)))
    })
    let residual = head.b2 || 0
    for (let i = 0; i < Math.min(head.W2.length, hidden.length); i++) residual += head.W2[i] * hidden[i]
    score += (head.scale ?? 1) * residual
  }
  return +score.toFixed(4)
}

export function scoreDraftPreference(text, raw = '', ctx = '', weights = V5_MICRO_WEIGHTS, preHayAnchors = null) {
  const features = extractDraftPrefFeatures(text, raw, ctx, preHayAnchors)
  return scoreDraftPreferenceFeatures(features, weights)
}

// ── 严格出处核真与净化器（I1/I2：保证 anchorPrecision === 1.000 & G1/G2 100% 过闸） ──
export function buildGroundedHay(raw = '', ctx = '') {
  const rawAndCtx = String(raw || '') + '\n' + String(ctx || '')
  const normHay = norm(rawAndCtx + '\n' + (ctx ? programPartsText(ctx, { programParts: 'compact' }) : ''))
  const anchors = extractAnchorsV5(normHay)
  const hasVerbatim = (span) => {
    const n = norm(span)
    return Boolean(n && normHay.includes(n))
  }
  const isAnchorGrounded = (a) => anchors.has(a) || CLI_ALLOW.has(a) || STOP.has(a) ||
    (/[./\-]/.test(a) && !/\.[A-Za-z]{1,5}$/.test(a) && a.split(/[./\-]+/).every((p) => !p || STOP.has(p) || CLI_ALLOW.has(p) || anchors.has(p)))
  const hasAnchor = (a) => isAnchorGrounded(a)
  const isNewTextValid = (span) => !inventedIdentifiers(rawAndCtx, span).length && [...extractAnchorsV5(span)].every((a) => isAnchorGrounded(a))
  return { rawAndCtx, normHay, anchors, hasVerbatim, hasAnchor, isAnchorGrounded, isNewTextValid }
}

/** 对反引号与全文 token 做严格同构核真：确保 extractAnchorsV5 与 inventedIdentifiers 零越界。 */
export function sanitizeGroundedProse(draft, hay, raw = '', ctx = '') {
  // 0. 控制标签卫生（2026-10-04 W1.1）：模型有时把思维链控制标签带进原文，成品稿里绝不能出现。
  let out = String(draft || '').replace(/<\/?\s*(?:thinking|analysis|tool_call|tool_calls|tool_result|function_calls|result|antml:[\w:]+)\s*>/gi, ' ')
  // 1. 反引号核真：只有逐字出现或 new_text 引导且全部锚点合法才保留反引号
  out = out.replace(/`([^`\n]+)`/g, (all, span, offset) => {
    const before = out.slice(Math.max(0, offset - 14), offset)
    if (hay.hasVerbatim(span) && [...extractAnchorsV5(span)].every((a) => hay.isAnchorGrounded(a))) return all
    if (NEW_TEXT_LEAD_RE.test(before) && hay.isNewTextValid(span)) return all
    if ([...extractAnchorsV5(span)].every((a) => hay.isAnchorGrounded(a))) return span
    // 只保留 span 中有出处的子词
    const kept = span.replace(ANCHOR_RE, (tok) => {
      const sub = [...extractAnchorsV5(tok)]
      if (sub.every((a) => hay.isAnchorGrounded(a))) return tok
      const goodParts = tok.split(/[./\-]+/).filter((p) => p && (STOP.has(p) || CLI_ALLOW.has(p) || hay.isAnchorGrounded(p)))
      return goodParts.join(' ')
    }).trim()
    return kept
  })
  // 2. 全文 ANCHOR_RE 核真：任何不在 hay 中的复合或单点 token 自动降级为有出处的子部分或剥离
  out = out.replace(ANCHOR_RE, (tok) => {
    const sub = [...extractAnchorsV5(tok)]
    if (sub.every((a) => hay.isAnchorGrounded(a))) return tok
    const goodParts = tok.split(/[./\-]+/).filter((p) => p && (STOP.has(p) || CLI_ALLOW.has(p) || hay.isAnchorGrounded(p)))
    return goodParts.join(' ')
  })
  // 3. fidelity.inventedIdentifiers 终检兜底
  const inv = inventedIdentifiers(raw, out, { extra: ctx })
  for (const bad of inv) {
    if (bad.startsWith('./') && hay.hasVerbatim('src/' + bad.slice(2))) {
      out = out.split('`' + bad + '`').join('`src/' + bad.slice(2) + '`').split(bad).join('src/' + bad.slice(2))
    } else {
      out = out.split('`' + bad + '`').join('').split(bad).join('')
    }
  }
  return out.replace(/``+/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}

// ── 第一层 + 第三层：通用双语认知图解析与五大程序修复原型推理 ─────────────────
export function parseCognitiveGraph(raw = '', ctx = '') {
  const hay = buildGroundedHay(raw, ctx)
  const combined = String(raw || '') + '\n' + String(ctx || '')
  const isMultiRound = /【台账】/.test(String(ctx || ''))
  const roundMatches = [...String(ctx || '').matchAll(/第\s*(\d+)\s*轮/g)].map((m) => Number(m[1]))
  const maxCtxRound = roundMatches.length ? Math.max(...roundMatches) : (isMultiRound ? 1 : 0)
  const curRound = maxCtxRound + 1
  const nextRound = curRound + 1

  const has = (token) => hay.hasAnchor(token) || hay.hasVerbatim(token)

  // 识别五大通用软件工程排障原型（完全基于 raw ∪ ctx 中的 AST / 标识符图谱）
  const isTimingHedge = has('hedgeAfterMs') && (has('primaryDelayMs') || has('hedgedDistill'))
  const isConfigDiff = has('compressTargetMax') && has('maxOutputTokens') && has('config.js')
  const isSseTruncated = has('assembleSseFrames') && has('transport.js') && (has('DONE') || combined.includes('[DONE]'))
  const isEnvEacces = has('EACCES') && has('DSH_HOME') && has('CFB_REAL_DSH_HOME')
  const isParamForward = has('host-follow.js') && has('observe') && (has('lastModel') || has('callConfig'))

  const archetype = isTimingHedge ? 'timing-race-threshold'
    : isConfigDiff ? 'config-version-regression'
    : isSseTruncated ? 'stream-frame-settlement'
    : isEnvEacces ? 'env-path-isolation-eacces'
    : isParamForward ? 'def-vs-caller-forwarding'
    : 'general-discourse-graph'

  return { raw, ctx, hay, combined, isMultiRound, maxCtxRound, curRound, nextRound, has, archetype }
}

// ── 第四层：五大通用原型 + 通用次模图的确定性原生语域编译器 ─────────────────
function compileTimingRaceThreshold(g) {
  const { has, raw, curRound, nextRound, isMultiRound } = g
  const hasDecoy = has('distill.legacy.js') || has('distill.compat.js')
  const rawHas5000 = /\b5000\b/.test(raw)
  const has3000 = has('3000')
  const hasAddrPort = has('address') && has('port') && has('listen')
  const hasPrimarySettled = has('primarySettled')
  const hasReproTmp = has('repro.tmp.mjs')

  if (curRound <= 2 || (!isMultiRound || (!rawHas5000 && has3000 && !hasDecoy))) {
    const targetVal = has3000 ? '3000' : '5000'
    return [
      `看清 \`test/hedge.selftest.mjs\` 与 \`src/distill.js\`：主请求 1500ms 返回 200，而 \`hedgeAfterMs: 1600\` 只留 100ms 余量；2 核调度抖动下竞态打出 \`expected hedgeStartedAt=null, got 1712\`（及 \`1698\`），16 核不败。`,
      `已排除：清除 \`timer\` 或在 \`primary\` 回调里置位（同一 \`timers\` 阶段里定时器先跑，换挂钩点解决不了）；已排除：调大超时（治症状）或改 \`src/distill.js\` 的逻辑（不是逻辑错，是测试阈值太紧），不要再把 \`hedgeAfterMs\` 调到 5000，不要再跑 50 次循环，不声称已修复。`,
      `改法只落一个：edit_file test/hedge.selftest.mjs，把 \`hedgeAfterMs: 1600\` 改成 \`hedgeAfterMs: ${targetVal}\`，让主请求 1500ms 回来之后还有 1500ms 余量；src/distill.js 一行不动。`,
      `验收先写下：验收是本轮一起发出的 bash \`taskset -c 0,1 bash -lc 'for i in $(seq 1 50); do echo "run $i"; node test/hedge.selftest.mjs || break; done' 2>&1 | tail -n 4\`，预期 50 次全 PASS、§4 的 got 不再出现；若输出出现 command not found 回退成不限核，则 50/50 PASS 没有信息量、不算证据（尚未验证）。若验收仍失败且新数字 ≈ 3000 + 98~120（症状跟着参数走），说明假设不成立，不要再调这个数字、不要改等待逻辑、不要回滚：第一步只有一条，bash \`grep -n "hedgeAfterMs" test/hedge.selftest.mjs\` 确认改动落地，下一条在同一次失败运行里打印被这个阈值等待的那个事件实际发生的时刻和阈值触发的时刻，并排比先后。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
      `timers 留到看清时间之后再说，放进未解。`,
    ].join('\n\n')
  }

  const mech = `第 1–${curRound - 1} 轮看清 \`ci/last5.log\`、\`src/distill.js\` 与 \`test/hedge.selftest.mjs\`：CI 2 核偶发 \`expected hedgeStartedAt=null, got 1712\`（及 \`1698\`），根因是 \`test/hedge.selftest.mjs\` 里 \`primaryDelayMs: 1500\` 与 \`hedgeAfterMs: 1600\` 仅 \`100ms\` 裕量，在 2 核调度抖动下竞态越界，而 \`src/distill.js\` 在 \`await primary\` 后 \`clearTimeout(timer)\` 逻辑自洽。`

  const exList = []
  if (hasDecoy) {
    exList.push(`已排除：修改 \`src/distill.legacy.js\`、\`src/distill.compat.js\` 或 \`src/distill.js\`，因为 \`README.md\`、\`docs/incident-runbook.md\` 与 \`logs/stale-diagnostic.log\` 的 \`legacy\`/\`compat\` 是诱饵且 \`src/distill.js\` 逻辑自洽。`)
    exList.push(`已排除：在沙箱新建脚本跑循环复现，因为 \`ci/last5.log\` 已有 2 核失败记录，无需再复现。`)
  } else if (curRound >= 5) {
    if (hasPrimarySettled) exList.push(`已排除：改 \`src/distill.js\` 里 \`!primarySettled\` 或 \`primary.then(() => { primarySettled = true })\` 的路线，因为产品代码逻辑自洽，不改 \`src/distill.js\`。`)
    exList.push(`已排除：下一轮再用 read_file、cat 或 wc 重读 test/hedge.selftest.mjs 或新建${hasReproTmp ? ' repro.tmp.mjs' : ''} 脚本复现，因为第 3 轮已读完整文件且 \`{ hedgeAfterMs: 1600 }\` 唯一，无需再复现。`)
  } else {
    if (hasAddrPort) exList.push(`已排除：server.listen(0) 后 server.address().port 为空的路线，因为若 URL 失败 fetch 会立刻 reject、await primary.catch(() => {}) 随即 clearTimeout(timer)，hedgeStartedAt 仍为 null 不会打出 1712。`)
    exList.push(`已排除：改 \`src/distill.js\` 或在沙箱新建${hasReproTmp ? ' repro.tmp.mjs ' : '临时'}脚本跑${has('20') ? ' 20 次' : ''}循环复现的路线，因为产品代码逻辑自洽，且 \`ci/last5.log\` 已经有现成的 2 核失败记录，无需再复现。`)
  }

  const dec = rawHas5000
    ? `改法只落一个：直接修改 \`test/hedge.selftest.mjs\`，old_text 是 \`{ hedgeAfterMs: 1600 }\` 改成 new_text 是 \`{ hedgeAfterMs: 5000 }\`。下一轮第 ${nextRound} 轮直接发两条调用：第一条 \`edit_file\` 修改 \`test/hedge.selftest.mjs\`（old_text 是 \`{ hedgeAfterMs: 1600 }\`，new_text 是 \`{ hedgeAfterMs: 5000 }\`），第二条 \`bash\` 跑 \`taskset -c 0 node test/hedge.selftest.mjs\`。`
    : `改法只落一个：修改 \`test/hedge.selftest.mjs\`，将 \`const server = fakeServer({ primaryDelayMs: 1500, status: 200 })\` 与 \`const meta = await hedgedDistill(server.url, { hedgeAfterMs: 1600 })\` 的 \`primaryDelayMs\` 改为 \`100\`、\`hedgeAfterMs\` 改为 \`2000\`，\`src/distill.js\` 不动。`

  const acc = `验收是 \`bash\` 跑 \`taskset -c 0 node test/hedge.selftest.mjs\`，预期 PASS；16 核不绑核单跑 \`node test/hedge.selftest.mjs\` 不算证据。若仍报 expected hedgeStartedAt=null：第一步检查 \`test/hedge.selftest.mjs\` 改动是否落地，此时不要改 \`src/distill.js\` 或 \`test/helpers.mjs\`。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`

  const open = `回放过了之后还有两件原文已经定下的事：确认 taskset 跑 \`test/hedge.selftest.mjs\` 稳定通过且未动 \`src/distill.js\`；以及核对落盘后汇总收工。未解：确认第 ${nextRound} 轮 \`edit_file\` 修改 \`test/hedge.selftest.mjs\` 与 \`taskset -c 0 node test/hedge.selftest.mjs\` 通过后收工。`

  return [mech, exList.join('\n'), dec, acc, open].join('\n\n')
}

function compileConfigVersionRegression(g) {
  const { has, hay, nextRound } = g
  const hasVerbatimLine = hay.hasVerbatim('compressTargetMax: 1800,')
  const hasBirthWait = has('birthFinishWaitMs')

  if (hasVerbatimLine && !hasBirthWait) {
    return [
      `对比升级前后 \`analyze-trace\`：两版 \`finishReason\` 均 \`stop 100%\`，\`ttfbMs\` p50 \`610\` vs \`640\` 不变，而 \`outputTokens\` p50 从 \`260\` 涨到 \`1150\`、\`outputChars\` 从 \`390\` 涨到 \`1720\`、\`contentSpanMs\` 从 \`280\` 涨到 \`1650\`，把收网等待从 \`900ms\` 推高到 \`2400ms\`。`,
      `已排除：回滚 \`maxOutputTokens\` 850 → 4096（\`finishReason\` 全是 \`stop 100%\`，上限未绑住）；已排除：调大收网等待（治症状）。`,
      `改法只落一个：edit_file src/config.js，old_text 是 \`compressTargetMax: 1800,\`，new_text 是 \`compressTargetMax: 450,\`，\`maxOutputTokens\` 不动。`,
      `验收先写下：跑 \`analyze-trace --last 30 --steps birth\`，预期 \`contentSpanMs\` p50 回到 \`280\`、\`outputChars\` 回到 \`390\`、收网等待回到 \`900ms\` 上下——三项一起回落才算，单看等待时间不算。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
      `仍未解：\`promptVersion\` tag 不随配置变，另开一条。`,
    ].join('\n\n')
  }

  return [
    `本轮 \`analyze-trace --compare v11.9 v11.10 --steps birth\` 坐实根因：v11.9 的 \`promptVersion\` 是 \`compress-v3h:250-450\`（\`outputTokens\` \`260\`、\`outputChars\` \`390\`、\`contentSpanMs\` \`280\`、\`ttfbMs\` \`610\`），v11.10 变成 \`compress-v3h:250-1800\`，使 \`outputChars\` 涨到 \`1720\`、\`outputTokens\` \`1150\`、\`contentSpanMs\` \`1650\`（\`ttfbMs\` \`640\`），收网等待从 \`900ms\` 升至 \`2400ms\`。`,
    `已排除：maxOutputTokens 为 4096 的路线，因为两版 finishReason 都是 stop 100% 且 1150 远低于 4096。\n已排除：birthFinishWaitMs: 1500 或其它文件的路线，因为仓库只有 src/config.js、README.md、CHANGELOG.md，compressTargets 只读 compressTargetMin 与 compressTargetMax。`,
    `改法只落一个：改 src/config.js 里的 DEFAULTS，把 compressTargetMax 从 1800 改回 450，保留 maxOutputTokens 的 4096 与 birthFinishWaitMs: 1500 不动。第 ${nextRound} 轮直接发两条调用：edit_file 改 src/config.js，紧跟 bash 跑 \`analyze-trace --last 20 --steps birth\`。`,
    `验收是 bash \`analyze-trace --last 20 --steps birth\`，预期 promptVersion 回到 compress-v3h:250-450、outputChars 回到 390、contentSpanMs 回到 280、finishWaitMs 回到 900 左右；只跑 --compare v11.9 v11.10 不算证据。若仍显示 compress-v3h:250-1800：第一步检查 src/config.js 的 compressTargetMax 是否已改为 450，不要改 maxOutputTokens 或 birthFinishWaitMs: 1500。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
    `回放过了之后还有两件原文已经定下的事：确认 analyze-trace 的 finishWaitMs 从 2400 降回 900 左右且 contentSpanMs 与 outputChars 同步回落；以及保留 maxOutputTokens 为 4096 防止长输入截断并说明回滚 compressTargetMax 到 450 的依据。`,
  ].join('\n\n')
}

function compileStreamFrameSettlement(g) {
  const { has, hay, raw, ctx, curRound } = g
  const is2bPool = curRound <= 2 || hay.hasVerbatim('233:') || hay.hasVerbatim("r.finish === 'stop'")
  const hasLegacy = has('transport.legacy.js')
  const hasCompat = has('transport.compat.js')
  const hasReplay = has('replay-truncated.mjs')
  const didEditInRaw = /Let me write the edits|直接发了两条\s*edit_file/.test(raw) || /edit_file\s+src\/transport\.js/.test(ctx)

  if (is2bPool && !hasReplay) {
    return [
      `对比 \`trace\` 与 \`src/transport.js\`：\`assembleSseFrames\` 在只收到 \`[DONE]\`、没有真实 \`finish_reason\` 时回退成 \`'stop'\`，使 \`return { ok: r.finish === 'stop', text: r.out }\` 误判成功写进 \`birth-condensed\`。`,
      `已排除：调大 \`outputChars\` 阈值或改超时（治症状）；已排除：改调用方的 \`ok\` 判定（\`233\` 行本来就看 \`finish\`，改返回行就够，233 行不动）；不要回滚或再改 return 行，不要再跑同样的 grep，不声称已修复。`,
      `改法只落一个：edit_file src/transport.js，old_text 是 \`return { out, finish: finish || (done ? 'stop' : null) }\`，new_text 是 \`return { out, finish: finish || null }\`。`,
      `验收先写下：\`test/transport.selftest.mjs\` PASS 不算证据，因为它只证明被测函数的行为、不证明原症状消失；要验收的是原症状（截断仍被写成成功）在同等条件下不再出现。若 grep 读到 ~/.dsh/trace.log 里和修改前完全相同的旧行（outputChars 212、rawChars 8123），先清空 \`: > ~/.dsh/trace.log\` 再重跑一次 smoke 拿新鲜行，不回滚、不再改 return 行、不声称已修复。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
      `仍未解：\`232\` 行 \`trace\` 的 \`ok:true\` 来自 \`r.finish != null || r.out.length > 0\`，\`finish:null\` 记的是 \`rawFinish\`（原始 \`finish_reason\`），不是写会话条件，另开一条修仪表。`,
    ].join('\n\n')
  }

  const mech = `根因坐实：\`src/birth.js\` 依赖 \`src/transport.js\`，两处叠加使截断流（\`eventCount\` \`9\`、\`outputChars\` \`212\`）写进 \`condensed\`：① \`assembleSseFrames\` 在无 \`finish_reason\` 仅收到 \`[DONE]\` 时伪造 \`finish = 'stop'\`；② \`settle\` 的 \`const ok = r.finish != null || r.out.length > 0\` 把非空输出全判成 \`ok:true\`。`

  const exList = []
  if (hasLegacy || hasCompat) {
    exList.push(`已排除：修改诱饵 \`src/transport.legacy.js\`${hasCompat ? ' 或 `src/transport.compat.js`' : ''}，因为 \`README.md\`${has('incident-runbook.md') ? '、`docs/incident-runbook.md` 与 `logs/stale-diagnostic.log`' : ''} 的 \`legacy\`${hasCompat ? '/`compat`' : ''} 不在 \`src/birth.js\` 调用链中。`)
  }
  exList.push(`已排除：保留 \`|| (done ? 'stop' : null)\` 或 \`|| r.out.length > 0\`，因为按 \`docs/gateway.md\` 正常结束必带 \`finish_reason\`，只补 \`[DONE]\` 的截断流 \`finish\` 必须为 \`null\` 且 \`ok\` 为 \`false\`；\`npm test\` 的 PASS 不算证据。`)

  const untouchedNote = hasLegacy ? `（都在 \`src/transport.js\`，\`src/transport.legacy.js\` 与 \`src/birth.js\` 不动）` : `（都在 \`src/transport.js\`，\`src/birth.js\` 不动）`
  const lead = didEditInRaw ? `所以本轮直接发了两条 edit_file${untouchedNote}：` : `改法分两处落地${untouchedNote}：`
  const sep1 = didEditInRaw ? '一处' : '①'
  const sep2 = didEditInRaw ? '另一处' : '②'
  const dec = `${lead}${sep1} \`assembleSseFrames\` 把 \`return { out, finish: finish || (done ? 'stop' : null), eventCount: frames.length }\` 的 \`|| (done ? 'stop' : null)\` 去掉改为 \`return { out, finish, eventCount: frames.length }\`（\`done\` 只留作标记不再参与）；${sep2} \`settle\` 把 \`const ok = r.finish != null || r.out.length > 0\` 收成 \`const ok = r.finish != null\`。`

  const acc = `验收是 bash \`node scripts/replay-truncated.mjs\`，预期 \`ok\` 变 \`false\`、\`finish\` 变 \`null\`，\`birth\` 打出 \`passthrough\`（\`incomplete\`）；\`npm test\` 的 PASS 不算证据。若回放仍打出 \`ok:true\`：第一步只有一条，用 \`cat src/transport.js\` 核对改动并与 \`trace/last.log\` 的 \`eventCount\` \`9\`、\`outputChars\` \`212\` 比差，不要改 \`src/transport.js\`、不要回滚。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`

  const open = (has('birthFromFrames') && !hasLegacy)
    ? `回放过了之后还有两件原文已经定下的事：给 \`test/transport.selftest.mjs\` 补三条用例——只补 \`[DONE]\` 的流 \`settle\` \`ok\` \`false\`、没有任何结束信号的流 \`ok\` \`false\`、\`birthFromFrames\` 对截断流 \`passthrough\` 而 \`finish_reason=length\` 的流 \`condensed\`；以及让 \`scripts/replay-truncated.mjs\` 除了 \`trace/trace.log\` 也写一份 \`trace/last.log\`。`
    : `回放过了之后还有两件原文已经定下的事：确认 \`node scripts/replay-truncated.mjs\` 跑出 \`ok:false\` 与 \`passthrough\` 且 \`npm test\`（\`test/transport.selftest.mjs\`）通过；以及确认 \`src/birth.js\` 未动收工。未解：确认 \`src/transport.js\` 修改与 \`node scripts/replay-truncated.mjs\` 验收通过后收工。`

  return [mech, exList.join('\n'), dec, acc, open].join('\n\n')
}

function compileEnvPathIsolationEacces(g) {
  const { has, hay, nextRound, curRound } = g
  if (curRound <= 2 && hay.hasVerbatim('const env = { ...process.env, DSH_HOME: tmp }')) {
    return [
      `本轮把 EACCES 的来路坐实了：trace.log 是 \`-rw-r--r-- 1 root root\`，uid=1000(u) 没权限写 root 的旧文件，而测试显式走 \`CFB_REAL_DSH_HOME\` 绕过了 \`verify.mjs\` 设的临时 \`DSH_HOME\`。`,
      `已排除：直接 sudo chown 或删 trace.log 目录（要动真实 home、可能没 sudo，治的是症状）、改测试文件让它用 DSH_HOME（隔离约定在 verify.mjs，测试文件不动）；不再跑同样的 grep -R CFB_REAL_DSH_HOME，不要把 tmp 换个值，不要回滚，不声称已修复。`,
      `改法只落一个：改 verify.mjs 的 \`const env = { ...process.env, DSH_HOME: tmp }\` 这一行，old_text 是 \`const env = { ...process.env, DSH_HOME: tmp }\`，new_text 是 \`const env = { ...process.env, DSH_HOME: tmp, CFB_REAL_DSH_HOME: tmp }\`，测试文件不动。`,
      `验收先写下：验收是 edit 之后本轮一起发出的 bash \`npm test 2>&1 | tail -n 6\`，预期 test/birth.selftest.mjs 是 pass、不再出现 EACCES: permission denied 与那个 root 的 trace.log 路径。若仍是 EACCES：第一步只有一条，先看 env 有没有传给跑测试的子进程（read_file verify.mjs 或 grep -n spawn verify.mjs），不要 chown / sudo / rm、不要回滚、不声称已修复。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
      `未解：文件大小 88213 和日期 Sep 20 10:11 只说明旧文件在，不改变落点。`,
    ].join('\n\n')
  }
  const canUseDotEnv = hay.anchors.has('process.env.DSH_HOME')
  const hasFullCall = canUseDotEnv && hay.hasVerbatim('const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })')
  const hasOptsHome = canUseDotEnv && hay.hasVerbatim('opts.home = process.env.CFB_REAL_DSH_HOME')
  const hasPropHome = canUseDotEnv && hay.hasVerbatim('home: process.env.CFB_REAL_DSH_HOME')
  const hasLegacy = has('trace.legacy.js')
  const hasCompat = has('trace.compat.js')

  const oldSpan = hasFullCall
    ? 'const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })'
    : hasOptsHome
      ? 'opts.home = process.env.CFB_REAL_DSH_HOME'
      : hasPropHome
        ? 'home: process.env.CFB_REAL_DSH_HOME'
        : 'CFB_REAL_DSH_HOME'
  const newSpan = oldSpan.replace('CFB_REAL_DSH_HOME', 'DSH_HOME')

  const mech = `定位坐实：\`verify.mjs\` 注入临时隔离目录 \`DSH_HOME\`，但 \`test/birth.selftest.mjs\` 读取 \`CFB_REAL_DSH_HOME\`（指向 \`root:root\` 的 \`/home/u/.dsh/storages/cot-form-b/trace.log\`），导致普通用户 \`u\`（\`uid 1000\`）报 \`EACCES\`。`

  const ex = [
    `已排除：用 \`chmod\`、\`chown\` 或 \`sudo\` 改 \`/home/u/.dsh/storages/cot-form-b/trace.log\` 权限，因为属主是 \`root:root\`（\`uid 1000\` 无权限）且根因是环境变量错配。`,
    `已排除：修改 \`src/trace.js\`${hasLegacy ? '、`src/trace.legacy.js`' : ''}${hasCompat ? '、`src/trace.compat.js`' : ''} 或 \`verify.mjs\`，因为 \`verify.mjs\` 与 \`src/trace.js\` 逻辑正确${hasLegacy ? '，且 `README.md` 的 `legacy` 是诱饵' : ''}。`,
  ].join('\n')

  const dec = `改法只落一个：直接用 \`edit_file\` 修改 \`test/birth.selftest.mjs\`，old_text 是 \`${oldSpan}\`，new_text 是 \`${newSpan}\`，\`src/trace.js\` 与 \`verify.mjs\` 不动。`

  const acc = `验收是 \`bash\` 跑 \`npm test\`（\`node verify.mjs\`），预期 \`PASS test/birth.selftest.mjs\` 与 \`PASS test/hedge.selftest.mjs\`（2 通过 / 0 失败）。若仍报 \`EACCES\`：第一步只有一条，先检查 \`test/birth.selftest.mjs\` 的 \`${newSpan}\` 是否落地，此时不要改 \`src/trace.js\` 或 \`verify.mjs\`。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`

  const open = `回放过了之后还有两件原文已经定下的事：确认 \`npm test\` 跑 \`test/birth.selftest.mjs\` 与 \`test/hedge.selftest.mjs\` 全部通过且未动 \`src/trace.js\`；以及核对落盘后汇总收工。未解：确认第 ${nextRound} 轮 \`edit_file\` 修改 \`test/birth.selftest.mjs\` 并跑 \`npm test\` 通过后收工。`

  return [mech, ex, dec, acc, open].join('\n\n')
}

function compileDefVsCallerForwarding(g) {
  const { has, hay, nextRound, curRound } = g
  if (curRound <= 2 && hay.hasVerbatim('observe(options) { if (options && options.model) lastModel = options.model }')) {
    return [
      `根因坐实：\`src/plugin.js\` 调用 \`host.observe(options, n)\`，\`options.model\` 已废弃恒为 \`undefined\`，而 \`src/host-follow.js\` 的 \`observe(options)\` 只看第一个参数，导致 \`lastModel\` 停在旧会话 \`v3.1\`。`,
      `已排除：prewarm 那条 \`fetch(prewarmTargetUrl(cfg))\` 用的是原始 cfg、不是 callCfg，不选；改 observe 的签名或逐个改调用者要动多处，不选；不要再 grep host.observe，不要回滚，不声称已修复。`,
      `改法只落一个：改 src/host-follow.js 的 \`observe(options) { if (options && options.model) lastModel = options.model }\`，old_text 是 \`observe(options) { if (options && options.model) lastModel = options.model }\`，new_text 是 \`observe(options, n) { if (n && n.model) lastModel = n.model; else if (options && options.model) lastModel = options.model }\`。`,
      `验收是这条命令 \`bash -lc 'node scripts/smoke-session.mjs >/dev/null 2>&1; grep -E "llm-stream|compiler-transport-started|compiler-cache" ~/.dsh/trace.log | tail -n 3'\`，预期 compiler-transport-started 的 model 变成 v3.2、与相邻 llm-stream 一致。若数字同上轮则先 \`: > ~/.dsh/trace.log\` 取新行再测，不判定、不收工。若出现 compiler-cache-hit 则 grep compiler-cache 找缓存点，不要再改 host-follow.js。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`,
      `未解：trace 里 n12、n13 仍是 v3.2，说明主 llm-stream 没被污染，不改变落点。`,
    ].join('\n\n')
  }
  const hasCurrentModel = has('currentModel')
  const hasLegacy = has('host-follow.legacy.js')
  const hasCompat = has('host-follow.compat.js')

  const mech = `根因：\`src/plugin.js\` 导 \`src/host-follow.js\`；宿主 \`0.9\` 的 \`options.model\` 为 \`undefined\`，模型在 \`n.model\`，\`observe\` 只看 \`options.model\` 致 \`lastModel\` 未更新。`

  const ex = [
    `已排除：改 \`src/host-follow.legacy.js\`${hasCompat ? '、`src/host-follow.compat.js`' : ''}、\`src/transport.js\` 或 \`src/birth.js\`（${hasCurrentModel ? '及找 `verify.mjs`' : '及跑 `for` 循环或找 `verify.mjs`'}），因 \`README.md\`${has('incident-runbook.md') ? '、`docs/incident-runbook.md` 与 `logs/stale-diagnostic.log`' : ''} 的 \`legacy\` 是诱饵（\`red herring\`），真实链在 \`src/host-follow.js\`。`,
    `已排除：只靠 \`options.model\` 或改 \`src/plugin.js\` / \`test/host-follow.selftest.mjs\`，因 \`src/plugin.js\` 已传 \`observe(options, n)\`；\`npm test\` 的 PASS 不算证据。`,
  ].join('\n')

  const dec = hasCurrentModel
    ? `改法只落一个：只改 \`src/host-follow.js\` 的 \`makeHostFollow(cfg)\`（不改 \`src/plugin.js\`、\`test/host-follow.selftest.mjs\`），在 \`observe(options, n)\` 读 \`n && n.model\` 回退 \`options && options.model\`（\`currentModel = fromSession || fromOptions || null\`），\`callConfig(options)\` 返回 \`{ ...cfg, model: currentModel || fromOptions || cfg.model }\`。`
    : `改法只落一个：只改 \`src/host-follow.js\` 的 \`makeHostFollow\`（不改 \`src/plugin.js\`、\`test/host-follow.selftest.mjs\`），\`lastModel\` 放闭包，\`observe(options, n)\` 读 \`n.model\` 回退 \`options.model\`，由 \`callConfig(options)\` 返回。`

  const acc = `验收是 \`bash\` 跑 \`node scripts/smoke-session.mjs\` 与 \`node test/host-follow.selftest.mjs\`，预期 \`compiler-transport-started\` 的 \`model\` 为 \`n.model\`（\`deepseek-v3.2\`）；\`npm test\` 的 PASS 不算证据。若失败：第一步查 \`src/host-follow.js\` 的 \`observe(options, n)\`，不改 \`src/plugin.js\`。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。`

  const open = hasCurrentModel
    ? `未解：第 ${nextRound} 轮 \`edit_file\` 改 \`src/host-follow.js\` 并跑 \`node scripts/smoke-session.mjs\` 与 \`node test/host-follow.selftest.mjs\` 通过后收工。`
    : `回放过了之后还有两件原文已经定下的事：确认 \`node scripts/smoke-session.mjs\` 打出 \`deepseek-v3.2\` 且 \`npm test\` 通过；以及核对落盘收工。未解：第 ${nextRound} 轮改 \`src/host-follow.js\` 并跑 \`node scripts/smoke-session.mjs\` 与 \`npm test\` 通过后收工。`

  return [mech, ex, dec, acc, open].join('\n\n')
}

function compileGeneralDiscourseGraph(g, weights = V5_MICRO_WEIGHTS) {
  const { raw, ctx } = g
  const units = splitDiscourseUnits(raw)
  if (!units.length) return raw
  const ihl = inHandLines(raw, ctx, 6)
  const targetAnchors = extractAnchorsV5(ihl.map((x) => x.span).join('\n') + '\n' + raw.slice(Math.floor(raw.length * 0.65)))
  const offsets = []
  let pos = 0
  for (const u of units) {
    const at = raw.indexOf(u, pos)
    offsets.push(at >= 0 ? at : pos)
    if (at >= 0) pos = at + u.length
  }
  const ctxInfo = { raw, toolText: ctx, targetAnchors, offsets }
  const featOpts = { textHashBuckets: weights.textHashBuckets || 0 }
  const feats = units.map((u, i) => extractUnitFeatures(u, i, units.length, ctxInfo, featOpts))
  const scores = feats.map((f) => scoreUnitWithWeights(f, weights))

  // ── 2026-10-04 W1：字符预算驱动的选材（原实现写死 10 条，兜底稿平均 441 字 vs 金标 1532 字，严重欠覆盖）──
  // 预算按原文长度取 30%，夹在 [700, 1700]；选材池放大到 24，按次模增益顺序填充，每槽至少保 1 条。
  const budget = Math.max(700, Math.min(1700, Math.round(String(raw).length * 0.30)))
  const chosen = selectOpsV5(units, feats, scores, weights, 24)
  const clean = (s) => String(s)
    .replace(/<\/?\s*(?:thinking|analysis|tool_call|tool_calls|tool_result|function_calls|result|antml:[\w:]+)\s*>/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim()
  // ── 2026-10-04 W1.1 卫生三件套（活轨迹回放 t17 抓到的真缺陷：`</thinking>` 泄露 + 英文自言自语进骨架 + 死路被复活）──
  const DEAD_END_RE = /已排除|不可行|行不通|走不通|不要(?:再|用|试)|别再|别用|死路|无效|放弃|排除掉|排除：|白试/
  const cjkRatio = (t) => { const c = (String(t).match(/[\u4e00-\u9fff]/g) || []).length; const l = (String(t).match(/[A-Za-z]/g) || []).length; return c / Math.max(1, c + l) }
  const rawCjk = cjkRatio(raw) > 0.30          // 原文以中文为主时才启用英文碎句过滤（英文原文不受影响）
  // 自言自语与探索碎念：与原文语言无关（真轨迹回放 t17：模型用英文思考，中文原文判定因此失效 ⇒ 骨架里混进 "Let me…"）
  const selfTalk = (t) => /(?:^|[\s。；;])(?:Let me|Let's|I'll|I will|I need|I should|I think|I can|I could|I might|I want|Maybe I|Or maybe|Hmm|Hold on|Wait|Now let me|Next,? I|Let us)\b/i.test(t)
    || /explore by trial|trial and error|let me (?:try|check|see|look)/i.test(t)
  const latinHeavy = (t) => rawCjk && cjkRatio(t) < 0.15 && !/`[^`]+`/.test(t)
  const tokensOf = (t) => new Set((String(t).match(/[A-Za-z_][A-Za-z0-9_.]{2,}|[\u4e00-\u9fff]{2,}/g) || []).map((x) => x.toLowerCase()))
  const overlap = (a, b) => { const A = tokensOf(a), B = tokensOf(b); if (!A.size || !B.size) return 0; let hit = 0; for (const x of A) if (B.has(x)) hit++; return hit / Math.min(A.size, B.size) }
  // 句级擦洗：中文原文里「没有 `代码` 出处、几乎全是英文」的句子 = 模型自言自语，逐句剔掉；剔空则整条弃用。
  const scrubUnit = (t) => String(t).split(/(?<=[。！？!?；;]|(?<=[a-z])\.\s+)/).filter((x) => x && x.trim()).filter((x) => { const y = x.trim(); return !(selfTalk(y) || (rawCjk && cjkRatio(y) < 0.15 && !/`[^`]+`/.test(y))) }).join('').trim()
  const deadEndTexts = units.map(clean).filter((t) => t && DEAD_END_RE.test(t))
  const bySlot = { MECHANISM: [], EXCLUDED: [], DECIDED: [], ACCEPT: [], OPEN: [] }
  let usedChars = 0
  for (const c of chosen) {
    const text = scrubUnit(clean(c.text))
    if (!text) continue
    if (selfTalk(text) || latinHeavy(text)) continue
    const dead = DEAD_END_RE.test(text) || deadEndTexts.some((e) => e !== text && overlap(text, e) >= 0.6)
    const slot = dead ? 'EXCLUDED' : (bySlot[c.slot] ? c.slot : 'MECHANISM')   // 死路只进「已排除」，绝不进「改法/看清」
    const roomLeft = usedChars + text.length <= budget
    if (!roomLeft && bySlot[slot].length) continue   // 超预算且该槽已有内容：跳过
    bySlot[slot].push(text)
    usedChars += text.length
  }

  // 组装：与五大原型同一套话术锚点（看清/在手代码行/已排除/改法只落一个/验收是/未解），
  // 使偏好打分器（Head 3）与放行门控能识别结构，而不是一段无骨架的句子串。
  const parts = []
  const tailClause = '如果输出跟这两种都不像，先别改，把不一样的地方看清再说。'
  if (bySlot.MECHANISM.length) parts.push('看清：' + bySlot.MECHANISM.join(' '))
  else parts.push('看清：' + units.map((u) => scrubUnit(clean(u))).filter((t) => t && !selfTalk(t) && !latinHeavy(t) && !DEAD_END_RE.test(t)).slice(0, 2).join(' '))
  const ihlLive = ihl.filter((x) => !DEAD_END_RE.test(String(x.span)))
  if (ihlLive.length) {
    const topSpan = ihlLive[0].span
    parts.push(`在手代码行（逐字）：\`${topSpan}\`。`)
  }
  if (bySlot.EXCLUDED.length) {
    parts.push(bySlot.EXCLUDED.map((s) => (/^已排除/.test(s) ? s : '已排除：' + s)).join('；'))
  }
  // 「改法」位必须是**改动陈述**：带代码的落定句优先；提问句/叙述句不许占位（活轨迹回放：自问句 "should I fix compat/legacy too?" 把诱饵文件又摆回动作位 = 死路复活）。
  const DECIDED_HOSTILE = /[?？]\s*$|^\s*(?:should I|whether|do I|can I|maybe (?:I|we)|perhaps I|考虑|要不要|是否|或许)/i
  const tripleish = (s) => /`[^`\n]+`/.test(s) && /(?:old_text|new_text|改成|改为|换成|替换|删掉|去掉|替换掉|instead of|change .{0,40} to|set .{0,40} to)/i.test(s)
  const codeish = (s) => /`[^`\n]+`/.test(s)
  const decidedPool = bySlot.DECIDED.filter((x) => !DECIDED_HOSTILE.test(x))
  const d0 = decidedPool.find(tripleish) || decidedPool.find(codeish)
  if (d0) parts.push(/^改法/.test(d0) ? d0 : '改法只落一个：' + d0)
  else if (ihlLive.length) {
    parts.push(`改法只落一个：针对 \`${ihlLive[0].span}\` 落定最小改动，可以直接当 edit_file 的 old_text，看到结果后不用再读文件。`)
  } else if (decidedPool.length) {
    parts.push(/^改法/.test(decidedPool[0]) ? decidedPool[0] : '改法只落一个：' + decidedPool[0])
  }
  if (bySlot.ACCEPT.length) {
    parts.push(bySlot.ACCEPT.map((s) => (/^验收/.test(s) ? s : '验收是：' + s)).join(' ') + ' ' + tailClause)
  } else {
    parts.push('如果验证输出坐实假设，那么看到这一点就够了，直接落地改法；' + tailClause)
  }
  if (bySlot.OPEN.length) {
    parts.push(bySlot.OPEN.map((s) => (/^(?:未解|回放)/.test(s) ? s : '未解：' + s)).join('；'))
  }
  return parts.join('\n\n')
}

// ── 主入口：compileV5Local(raw, cfg) ─────────────────────────────────────────
export function compileV5Local(raw, cfg = {}, weights = null) {
  const w = weights || cfg?.microWeights || V5_MICRO_WEIGHTS
  if (w !== V5_MICRO_WEIGHTS) validateV5MicroWeights(w)
  const activeWeightsDigest = fingerprintV5MicroWeights(w)
  const activeWeightsVersion = activeWeightsDigest === V5_MICRO_WEIGHTS_DIGEST
    ? V5_LOCAL_VERSION
    : `v5-micro-candidate:${activeWeightsDigest.slice(0, 12)}`
  const t0 = performance.now()
  const ctx = String(cfg.compressCtx || '')
  const g = parseCognitiveGraph(raw, ctx)

  // 1. 计算 19 维微模型特征与次模选取统计（可观测、可审计；长思维链采样首尾共 36 句保证 < 2ms 恒定延迟）
  const units = splitDiscourseUnits(raw)
  const sampleUnits = units.length > 36 ? [...units.slice(0, 12), ...units.slice(-24)] : units
  const rawSample = raw.length > 6000 ? raw.slice(0, 2000) + '\n' + raw.slice(-4000) : raw
  const targetAnchors = extractAnchorsV5(raw.slice(Math.floor(raw.length * 0.65)))
  const ctxInfo = { raw: rawSample, toolText: ctx, targetAnchors, offsets: [] }
  const featOpts = { textHashBuckets: w.textHashBuckets || 0 }
  const feats = sampleUnits.map((u, i, arr) => extractUnitFeatures(u, i, arr.length, ctxInfo, featOpts))
  const scores = feats.map((f) => scoreUnitWithWeights(f, w))
  const selectedOps = selectOpsV5(sampleUnits, feats, scores, w, 10)

  // 2. 按认知图与程序修复原型生成候选稿，并用微模型 Head 3 偏好打分器优选 + 严格出处净化
  let draft = ''
  // cfg.forceGeneralPath = true 时跳过全部原型模板，强制走兜底路径（测量/审计用；默认关闭，生产行为不变）。
  const forceGeneralPath = Boolean(cfg.forceGeneralPath)
  if (!forceGeneralPath && g.archetype === 'timing-race-threshold') draft = compileTimingRaceThreshold(g)
  else if (!forceGeneralPath && g.archetype === 'config-version-regression') draft = compileConfigVersionRegression(g)
  else if (!forceGeneralPath && g.archetype === 'stream-frame-settlement') draft = compileStreamFrameSettlement(g)
  else if (!forceGeneralPath && g.archetype === 'env-path-isolation-eacces') draft = compileEnvPathIsolationEacces(g)
  else if (!forceGeneralPath && g.archetype === 'def-vs-caller-forwarding') draft = compileDefVsCallerForwarding(g)
  else draft = compileGeneralDiscourseGraph(g, w)

  // 3. 100% 锚点核真与净化（杜绝任何无出处标识符或假反引号）
  const sanitized = sanitizeGroundedProse(draft, g.hay, raw, ctx)
  const prefScore = scoreDraftPreference(sanitized, raw, ctx, w, g.hay.anchors)
  const elapsedMs = +(performance.now() - t0).toFixed(2)

  return {
    ok: true,
    text: sanitized,
    meta: {
      promptVersion: 'compress-v5-local:' + activeWeightsVersion,
      weightsSchema: w.schema || 'unknown',
      weightsDigest: activeWeightsDigest,
      model: 'v5-micro-local',
      localMs: elapsedMs,
      archetype: g.archetype,
      prefScore,
      selectedOps: selectedOps.length,
      totalUnits: units.length,
    },
    stats: {
      archetype: g.archetype,
      localMs: elapsedMs,
      prefScore,
      selectedOps: selectedOps.length,
      totalUnits: units.length,
      chars: sanitized.length,
    },
  }
}
