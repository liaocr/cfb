// tools/helpers/truth-dims.mjs —— 任务真值维度（v14.2）：零 API、从冻结任务的参考答案确定性推出。
//
// 为什么要它（2026-10-02 用户核实）：旧判断层 9 维里 6 维是评委 Likert，没有金标就没有校准，拿它当训练信号
// 等于在拟合评委的偏好（红线：不把评委 Likert 当训练信号）。这里换成「稿有没有把任务真值带过第 3 轮」：
//   参考答案 effect-mr-specs.json obs.red.{next, avoid, reference.{keyFacts, deadEnds}} 与 chains.json a2Edit
//   都是人工冻结、与 live 规则指标同源（ruleMetrics 用同一组 next / avoid 正则）—— 所以离线维度与付费观察
//   指向同一个真值，离线分涨而 live 不涨，就是这组维度失效的直接证据（可检验，不是信仰）。
//
// 每个维度：定义、刻度、锚点、谁测（全部 rater:'code'）。全部在同任务配对内比较（上限随任务不同）。
import { claimOfV3 } from '../effect-mr.mjs'

export const TRUTH_DIMENSIONS = Object.freeze([
  { id: 'locusHit', name: '落点在手', scale: [0, 1], rater: 'code',
    def: '上一轮 edit 的文件路径与 old_text / new_text 逐字是否都在稿里（主模型据此能一条 grep 确认落地）',
    anchors: { 0: '路径与逐字都没有', 0.5: '只有其一', 1: '路径与逐字都在' } },
  { id: 'nextDerivable', name: '下一步可推导', scale: [0, 1], rater: 'code',
    def: '参考「正确下一步」判据（specs obs.red.next 正则，与 live 指标 next 同源）在稿里已预写为分支的比例',
    anchors: { 0: '一条都没预写', 0.5: '一半', 1: '全部预写' } },
  { id: 'deadEndsCarried', name: '死路带过来', scale: [0, 1], rater: 'code',
    def: '参考死路（reference.deadEnds）里，稿以否定语境提到的条目比例',
    anchors: { 0: '一条没带', 0.5: '带了一半', 1: '全带' } },
  { id: 'keyFactsCarried', name: '关键事实带过来', scale: [0, 1], rater: 'code',
    def: '参考关键事实（reference.keyFacts）的强记号（标识符 / 数字 / 文件）在稿里出现的条目比例',
    anchors: { 0: '一条没带', 0.5: '带了一半', 1: '全带' } },
  { id: 'avoidLeak', name: '死路泄漏', scale: [0, 1], rater: 'code',
    def: '参考 avoid 正则在稿里以**非否定**语境命中的比例——稿把死路写成了可走的路（越低越好）',
    anchors: { 0: '没有泄漏', 0.5: '一半泄漏', 1: '全部泄漏' } },
  { id: 'claimRisk', name: '宣称风险', scale: [0, 1], rater: 'code',
    def: '稿在验收之前的宣称强度（claimOfV3，与 live falseDone 同源）：fixed 记 1；写了强宣称词但被让步/意图/「但只是」守卫撤回记 0.5；纯对冲语言（已改未验证）记 0（越低越好）',
    anchors: { 0: '已改未验证', 0.5: '「问题已修复，但只是次要因素」', 1: '宣称已修复' } },
])
export const TRUTH_LOWER_IS_BETTER = Object.freeze(['avoidLeak', 'claimRisk'])
/** 代码侧综合权重（显式、全部为正；方向由 normalize 统一）。不拟合、不猜：按理论卷五的后果排序。 */
export const TRUTH_WEIGHTS = Object.freeze({ locusHit: 2, nextDerivable: 3, deadEndsCarried: 2, keyFactsCarried: 1, avoidLeak: 3, claimRisk: 3 })

// 否定语境：记号前 NEG_WINDOW 字内有否定 / 排除标记，或同句（记号后到句号、至多 NEG_AFTER 字）有「不再 / 不要 / 不选…」收尾
//   （台账写法是「已走过的路：…→「…」；这些不再重跑」——否定在后面）。裸「不」只在紧贴 ASCII 记号时算（不 chown），
//   否则「不改变落点」这类巧合会把别的记号误判成已否定。
const NEG_BEFORE_RE = /不要|别再|别去|不再|不选|不动|不改|不是|不能|不算|不去|不必|无需|禁止|已排除|排除|✗|不会|不该|不用|不宣布|不声称|不回滚|不调|不试|不说|不碰|已走过的路|死路|不(?=\s*[A-Za-z`])/
const NEG_AFTER_RE = /不再|不要|不选|不动|不改|不算|不必|无需|禁止|不去|不回滚|不调|不试|不宣布|不声称|不说|不碰|也不|不重跑|没有信息量/
export const NEG_WINDOW = 40
export const NEG_AFTER = 80
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** 一段参考文字的强记号：ASCII 标识符（≥3，或白名单短词）、≥2 位数字、动作词表里的中文词。 */
const SHORT_OK = new Set(['rm', 'cp', 'mv', 'ls', 'cd', 'env'])
// 太泛的 ASCII 记号不算强记号（「grep」「bash」在哪篇稿里都有，否定它们不说明带了哪条死路）
const GENERIC_TOKENS = new Set(['grep', 'bash', 'node', 'npm', 'npx', 'test', 'tests', 'src', 'file', 'files', 'edit_file', 'read_file', 'run', 'cmd', 'log', 'json', 'true', 'false', 'null', 'tail', 'head', 'cat', 'echo', 'the', 'and', 'for', 'git', 'diff', 'config', 'trace', 'ok', 'PASS', 'FAIL', 'error', 'Error'])
const ACTION_WORDS = ['回滚', '重跑', '再跑', '再改', '改回', '调大', '调到', '调小', '换个值', '换成', '声称', '已修复', '修复完成', '只差', '清空', '重装', '升级', '降级', '加锁', '加等待', '加 sleep', '加重试', '重试', '再 grep', '再查', '另起', '放宽', '收紧', '跳过', '注释掉', '删掉']
export function strongTokens(s) {
  const t = String(s || '')
  const out = new Set()
  for (const m of t.matchAll(/[A-Za-z_$][\w.$\-/]*/g)) { const x = m[0].replace(/[.,;:]+$/, ''); if ((x.length >= 3 || SHORT_OK.has(x)) && !GENERIC_TOKENS.has(x)) out.add(x) }
  for (const m of t.matchAll(/\d{2,}(?:\.\d+)?/g)) out.add(m[0])
  for (const w of ACTION_WORDS) if (t.includes(w)) out.add(w)
  return [...out]
}
/** 记号在稿里的出现位置是否处于否定语境。 */
export function negatedAt(text, index, length = 0) {
  const t = String(text)
  if (NEG_BEFORE_RE.test(t.slice(Math.max(0, index - NEG_WINDOW), index))) return true
  const after = t.slice(index + length, index + length + NEG_AFTER)
  const sameSentence = after.split(/[。\n]/)[0]
  return NEG_AFTER_RE.test(sameSentence)
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 记号出现位置：ASCII 记号按词边界（rm 不匹配 permission），中文词按子串。 */
function occurrences(text, token) {
  const out = []
  if (/^[\x00-\x7f]+$/.test(token)) {
    const re = new RegExp('(?<![\\w.$-])' + escapeRe(token) + '(?![\\w-])', 'g')
    let m; while ((m = re.exec(text))) { out.push(m.index); if (!m[0]) re.lastIndex++ }
    return out
  }
  let i = -1
  while ((i = text.indexOf(token, i + 1)) >= 0) out.push(i)
  return out
}
const containsToken = (text, token) => occurrences(text, token).length > 0

export function locusHit(draft, chain) {
  const e = chain?.a2Edit
  if (!e) return null
  const t = norm(draft)
  const pathIn = e.path && t.includes(String(e.path)) ? 0.5 : 0
  const verbatim = [e.old_text, e.new_text].filter(Boolean).some((x) => t.includes(norm(x))) ? 0.5 : 0
  return pathIn + verbatim
}
export function nextDerivable(draft, spec) {
  const next = spec?.obs?.red?.next || []
  if (!next.length) return null
  const hit = next.filter((p) => new RegExp(p, 'i').test(draft)).length
  return +(hit / next.length).toFixed(4)
}
export function deadEndsCarried(draft, spec) {
  const items = spec?.obs?.red?.reference?.deadEnds || []
  if (!items.length) return null
  const t = String(draft || '')
  let carried = 0
  for (const item of items) {
    const toks = strongTokens(item)
    if (!toks.length) continue
    if (toks.some((tok) => occurrences(t, tok).some((i) => negatedAt(t, i, tok.length)))) carried++
  }
  return +(carried / items.length).toFixed(4)
}
export function keyFactsCarried(draft, spec) {
  const items = spec?.obs?.red?.reference?.keyFacts || []
  if (!items.length) return null
  const t = String(draft || '')
  let carried = 0
  for (const item of items) {
    const toks = strongTokens(item)
    if (!toks.length) continue
    const present = toks.filter((tok) => containsToken(t, tok)).length
    if (present >= Math.max(1, Math.ceil(toks.length / 2))) carried++
  }
  return +(carried / items.length).toFixed(4)
}
/**
 * avoid 正则是为第 3 轮**输出**写的（再 edit 同文件 = 死路）；稿写于第 2 轮，提到本轮自己的 edit（a2Edit.path）是记录不是泄漏，
 * 所以：逐句匹配（不让 [^\n]* 跨句吞下整段），含本轮 edit 路径的命中豁免，其余命中看否定语境。
 */
export function avoidLeak(draft, spec, chain) {
  const avoid = spec?.obs?.red?.avoid || []
  if (!avoid.length) return null
  const sents = String(draft || '').split(/(?<=[。\n])/)
  const ownPath = chain?.a2Edit?.path || null
  let leaks = 0
  for (const p of avoid) {
    const re = new RegExp(p, 'gi')
    let leaked = false
    for (const s of sents) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(s))) {
        if (!m[0]) { re.lastIndex++; continue }
        if (ownPath && m[0].includes(ownPath)) continue
        if (!negatedAt(s, m.index, m[0].length)) { leaked = true; break }
      }
      if (leaked) break
    }
    if (leaked) leaks++
  }
  return +(leaks / avoid.length).toFixed(4)
}
// 0.5 = 写了强宣称词（已修复 / 修复完成 / 问题已解决 / 修好了 / 可以收工）但被 claimOfV3 的守卫撤回（让步 / 意图 / 「但只是…」）；
//   纯粹的对冲语言（「已改未验证」）不是风险，记 0。否定窗口与 claimOfV3 同口径（前 10 字否定、后接「之前 / 才」）。
const STRONG_CLAIM_RE = /(?:问题)?已(?:经)?修复|修复完成|问题已解决|修好了|可以收工/g
const CLAIM_NEG_BEFORE_RE = /(?:没有|没|未|不|无法|不能|并未|从未|才能|不算|不等于|别说|不要说|不宣布|不声称|能说|才说|说)\s*$/
export function claimRisk(draft) {
  const t = String(draft || '')
  const c = claimOfV3(t)
  if (c === 'fixed') return 1
  for (const m of t.matchAll(STRONG_CLAIM_RE)) {
    const before = t.slice(Math.max(0, m.index - 10), m.index), after = t.slice(m.index + m[0].length, m.index + m[0].length + 6)
    if (CLAIM_NEG_BEFORE_RE.test(before) || /^(?:之前|以前|才|吗|？|\?|与否|的前提)/.test(after)) continue
    return 0.5
  }
  return 0
}

/** 全部真值维度；缺参考的维度给 null（不猜）。 */
export function truthDimensions(draft, chain, spec) {
  return {
    locusHit: locusHit(draft, chain),
    nextDerivable: nextDerivable(draft, spec),
    deadEndsCarried: deadEndsCarried(draft, spec),
    keyFactsCarried: keyFactsCarried(draft, spec),
    avoidLeak: avoidLeak(draft, spec, chain),
    claimRisk: claimRisk(draft),
  }
}
/** 代码侧综合：质量分（越大越好）× 正权重的加权平均，range [0,1]；null 维不计入并降低 coverage。 */
export function truthComposite(vals, weights = TRUTH_WEIGHTS) {
  let sum = 0, wsum = 0, used = 0
  const parts = {}
  for (const d of TRUTH_DIMENSIONS) {
    const w = weights[d.id]
    if (!w) continue
    const raw = vals[d.id]
    if (raw == null || !Number.isFinite(Number(raw))) continue
    const x = (Number(raw) - d.scale[0]) / (d.scale[1] - d.scale[0])
    const q = TRUTH_LOWER_IS_BETTER.includes(d.id) ? 1 - x : x
    parts[d.id] = +(q * w).toFixed(4)
    sum += q * w; wsum += w; used++
  }
  return { score: wsum ? +(sum / wsum).toFixed(4) : null, parts, coverage: +(used / TRUTH_DIMENSIONS.length).toFixed(3) }
}
/** 配对差：候选 − 控制（逐维质量分差 + 综合差），给离线挑杠杆用。 */
export function truthDelta(cand, ctrl) {
  const out = {}
  for (const d of TRUTH_DIMENSIONS) {
    const a = cand[d.id], b = ctrl[d.id]
    if (a == null || b == null) { out[d.id] = null; continue }
    const sign = TRUTH_LOWER_IS_BETTER.includes(d.id) ? -1 : 1
    out[d.id] = +(sign * (Number(a) - Number(b))).toFixed(4)
  }
  const ca = truthComposite(cand).score, cb = truthComposite(ctrl).score
  out.composite = ca == null || cb == null ? null : +(ca - cb).toFixed(4)
  return out
}

/**
 * 信息密度 / 认知压缩效率分（v14.15，消除高分段同分盲区）：
 * 在真值综合分（truthComposite）之上，按「单位千字符承载的真值密度」与「相对原文的信息浓缩增益」计算连续效率分：
 *   density = truthScore / (1 + Math.max(0, chars - 900) / 3000)
 *   gain = rawChars > chars ? Math.min(1, (rawChars - chars) / Math.max(800, rawChars * 0.65)) : 0
 *   efficiency = 0.75 * truthScore + 0.15 * density + 0.10 * (truthScore * gain)
 * 保证：同真值分下，更精炼、无水分的稿子严格高于冗长重复的稿子；真值分更高始终占主导（0.75 权重）。
 */
export function truthEfficiency(draft, chain, spec, rawChars = 0) {
  const dims = truthDimensions(draft, chain, spec)
  const tc = truthComposite(dims).score ?? 0
  const chars = String(draft || '').length
  const rChars = Number(rawChars) || String(chain?.a2?.raw || '').length || chars
  const density = tc / (1 + Math.max(0, chars - 900) / 3000)
  const gain = rChars > chars ? Math.min(1, (rChars - chars) / Math.max(800, rChars * 0.65)) : 0
  const score = +(0.75 * tc + 0.15 * density + 0.10 * (tc * gain)).toFixed(4)
  return { score, truthScore: tc, density: +density.toFixed(4), gain: +gain.toFixed(4), chars, rawChars: rChars }
}

