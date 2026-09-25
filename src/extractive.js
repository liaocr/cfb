// dsh-cot-form-b / extractive.js —— 抽取式压缩（compress-x1，缺省关闭）
//
// 人话：副模型**不写摘要**，只回「留哪几句、哪句被证实/否定、状态变量是什么」；
//       正文由本地代码从原文**逐字**拼出来。模型写不出原文里没有的句子，也就编不出事实。
//
//   segmentSentences     原文 → 句子切片（每片都是 raw.slice(start,end)，可逐字复原）
//   buildExtractivePrompt  编号句子 + 近期证据索引 + 可进化的准则（guideline）→ 提示词
//   parseExtractiveOutput  模型 JSON → 规范化选择（越界/重复/非法一律丢弃，绝不抛给主流）
//   assembleExtractive     选择 + 原文 + 证据 → 最终文本（硬校验在这里）
//   extractiveHandleLine   句柄行（只在 birthFinish 句柄已验证后才拼上）
//   extractiveEvidence     宿主证据 → 本模块使用的最小证据形状（seq / 工具名 / 退出码 / 正文）
//
// 设计依据（docs/RESEARCH-COT-SHAPING.md §10）：
//   · 顺序即信息：保留句一律按原文顺序输出（打乱步骤顺序的伤害远大于内容错误，arXiv 2502.07374）
//   · 开头计划 + 逐字尾巴：续写只需「计划 + 最近上下文」（Markovian Thinker / Delethink, arXiv 2510.06557）
//   · 转折句必留：「等等 / 不对 / wait」处是信息量峰值（arXiv 2506.02867）
//   · 丢掉的部分留句柄可取回（ReadAgent, arXiv 2402.09727）
//   · 不对称纪律：「已证实」必须有逐字证据；缺证据只允许**降级**，永不升级
//
// 纯函数、零网络、同步。任何异常都应由调用方转成「原文放行」。

import { scriptCounts } from './tokens.js'
import { fidelity } from './fidelity.js'

export const EXTRACTIVE_VERSION = 'x1'

// ── 句子切分 ───────────────────────────────────────────────────────────────
const HARD_END = new Set(['。', '！', '？', '；', '!', '?', '\n'])
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '"', "'", '】', ']'])
const SOFT_BREAK = new Set(['，', ',', '：', ':', '、', ';'])
const SOFT_SPLIT_AT = 240

/**
 * 把原文切成句子。每个元素 { i, start, end, text }，text === raw.slice(start, end)，
 * 已去掉首尾空白（start/end 同步收缩）。``` 围栏代码块整体算一句（绝不切进代码里）。
 */
export function segmentSentences(raw) {
  const s = String(raw == null ? '' : raw)
  const cuts = []                     // [start, end) 片段
  let i = 0
  let segStart = 0
  const push = (a, b) => { if (b > a) cuts.push([a, b]) }
  while (i < s.length) {
    // 围栏代码块：从 ``` 到下一个 ```（含）整体为一段
    if (s.startsWith('```', i) && (i === 0 || s[i - 1] === '\n')) {
      push(segStart, i)
      const close = s.indexOf('```', i + 3)
      const end = close < 0 ? s.length : close + 3
      push(i, end)
      i = end
      segStart = i
      continue
    }
    const ch = s[i]
    let boundary = false
    if (HARD_END.has(ch)) boundary = true
    else if (ch === '.' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) boundary = true
    if (boundary) {
      let j = i + 1
      while (j < s.length && CLOSERS.has(s[j])) j++
      push(segStart, j)
      i = j
      segStart = j
      continue
    }
    // 超长句按软分隔切开（英文长行 / 一逗到底的中文）
    if (i - segStart >= SOFT_SPLIT_AT && SOFT_BREAK.has(ch)) {
      push(segStart, i + 1)
      i += 1
      segStart = i
      continue
    }
    i++
  }
  push(segStart, s.length)
  const out = []
  for (const [a0, b0] of cuts) {
    let a = a0, b = b0
    while (a < b && /\s/.test(s[a])) a++
    while (b > a && /\s/.test(s[b - 1])) b--
    if (b > a) out.push({ i: out.length, start: a, end: b, text: s.slice(a, b) })
  }
  return out
}

// ── 功能标记 ───────────────────────────────────────────────────────────────
// 转折 / 回溯 / 自检：信息量峰值（MI peaks）与「思维锚点」最集中的句型。强制保留。
const RE_TRANSITION = /(等等|等一下|慢着|不对|不过|但是|可是|然而|其实|原来|糟糕|看来不|重新|换个思路|换一种|改用|再想想|再检查|回头看|我错了|搞错|\bwait\b|\bhmm+\b|\bactually\b|\bhowever\b|\bbut\b|\bhold on\b|\boh[,!]|\bno,|\binstead\b|\blet me re-?check\b|\bdouble-check|\bre-?think|\bi was wrong\b|\bmistake\b)/i
// 逐字标识符：丢了就推不回来。缺失时把含它的句子补回（修复上限见 repairMax）。
const RE_HARD_IDS = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`,;)]+/gi,                  // scheme://
  /(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g,                    // a/b/c
  /`[^`\n]{2,80}`/g,                                         // `code`
  /\b[A-Za-z_][\w-]*\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|json|ya?ml|toml|md|sh|sql|css|html|c|cc|cpp|h)\b(?::\d+)?/g, // file.ext[:line]
  /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/g,                 // TypeError
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,                            // camelCase
  /\b[a-zA-Z]+_[A-Za-z0-9_]+\b/g,                            // snake_case
]
export function hardIdentifiers(text) {
  const s = String(text || '')
  const set = new Set()
  for (const re of RE_HARD_IDS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      const t = m[0].trim()
      if (t.length >= 3) set.add(t)
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return set
}

const collapse = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim()
const isWideText = (raw) => { const c = scriptCounts(raw); return c.wide >= c.other * 0.25 }

// ── 证据（最小形状）────────────────────────────────────────────────────────
/**
 * 宿主证据（adaptEvidence 的 frozen events，或 collectEvidence 的 events）→ 本模块形状：
 *   { tools: [{ seq, name, text, isError, exitCode }], asks: [{ seq, text }] }
 * 只取最近 limit 条工具结果与最近 2 条人类输入。调用名按 toolCallId 关联。
 */
export function extractiveEvidence(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const limit = Number.isFinite(opts.limit) && opts.limit >= 0 ? opts.limit : 12
  const names = new Map()
  const tools = []
  const asks = []
  for (const e of list) {
    if (!e) continue
    if (e.type === 'assistant/message' && Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) if (tc && tc.id) names.set(String(tc.id), tc.name || null)
    } else if (e.type === 'tool/result' && e.seq != null) {
      tools.push({ seq: e.seq, name: names.get(String(e.toolCallId)) || null, text: String(e.text || ''),
        isError: !!e.isError, exitCode: typeof e.exitCode === 'number' ? e.exitCode : null })
    } else if (e.type === 'user/message' && e.source === 'human' && String(e.text || '').trim()) {
      asks.push({ seq: e.seq, text: String(e.text) })
    }
  }
  return { tools: limit ? tools.slice(-limit) : [], asks: asks.slice(-2) }
}

// ── 提示词 ─────────────────────────────────────────────────────────────────
/**
 * 缺省准则 = 研究结论落成的选择规则。它是 ACON/GEPA 回路（tools/acon-optimize.mjs）的进化对象：
 * 回路产出的新准则经 cfg.extractiveGuideline **追加**在这之后，缺省规则本身不被覆盖。
 */
export const EXTRACTIVE_BASE_RULES = [
  '留：开头的计划/分解句；转折与回溯（等等、不对、wait、but）；验证与检查；新发现；已做的决定及理由；被否定的路径及否定原因；仍悬而未决的问题。',
  '删：复述题目或用户原话；已经被后文结论覆盖的中间计算；重复的犹豫；逐字复读的工具输出。',
  '拿不准时宁可留：删错一句会让后续推理重走一遍，多留一句只多花几十个字符。',
  '状态只记下一步真正要用的变量（文件、行号、出错点、已确认的值、约束），值必须从原文或用户输入里逐字复制。',
]

/**
 * @param sentences segmentSentences 的结果
 * @param ctx { evidence?, guideline?, tailFrom? } tailFrom = 本地已决定逐字保留的尾巴起点（尾巴不必再选）
 */
export function buildExtractivePrompt(sentences, ctx = {}) {
  const ev = ctx.evidence || { tools: [], asks: [] }
  const lines = []
  lines.push('你是推理记录的「选句器」。下面是 Agent 上一段思维链，已按句编号。')
  lines.push('你**不写任何新句子**：只选出后续推理还需要的句子编号，标注哪些句子的断言已被工具结果证实或否定，并抽出状态变量。最终文本由程序按原文顺序逐字拼接。')
  lines.push('')
  lines.push('选择规则：')
  EXTRACTIVE_BASE_RULES.forEach((r, k) => lines.push((k + 1) + '. ' + r))
  const g = String(ctx.guideline || '').trim()
  if (g) {
    lines.push('')
    lines.push('补充准则（来自离线评测的失败分析，优先级同上）：')
    lines.push(g)
  }
  lines.push('')
  lines.push('只输出一个 JSON 对象，不要代码围栏，不要解释：')
  lines.push('{"kind":"explore|closed|exec","plan":[编号],"keep":[编号],"tags":[{"i":编号,"s":"verified|refuted|unverified","seq":证据seq,"quote":"证据原文片段"}],"state":[{"k":"名","v":"原文逐字值"}]}')
  lines.push('· kind：explore=仍在探索/排错；closed=本段已得出结论、子目标完成；exec=照计划执行、几乎没有推理。')
  lines.push('· plan：开头的计划句（最多 2 个）。keep：其余要留的句子。顺序无所谓，程序会按原文排序。')
  lines.push('· tags：verified/refuted 必须给出下方证据里的 seq 和一段**逐字**引用（6~80 字符；输出本身很短时引用全文），程序会核对，对不上一律降级。只是推测、没有证据的断言标 unverified。没有就给空数组。')
  lines.push('· state：最多 8 条；v 必须能在原文或用户输入里逐字找到。')
  if (Number.isInteger(ctx.tailFrom) && ctx.tailFrom < sentences.length) {
    lines.push('· 第 ' + ctx.tailFrom + ' 句及之后会被逐字保留，不必再选。')
  }
  if (ev.tools && ev.tools.length) {
    lines.push('')
    lines.push('【近期工具结果（证据索引，只供标注 tags 引用）】')
    for (const t of ev.tools) {
      const status = t.isError ? ' error' : (t.exitCode != null ? ' exit=' + t.exitCode : '')
      lines.push('seq' + t.seq + ' ' + (t.name || 'tool') + status + '：' + collapse(t.text).slice(0, 160))
    }
  }
  if (ev.asks && ev.asks.length) {
    lines.push('')
    lines.push('【用户输入（state 可逐字引用其中的约束）】')
    for (const a of ev.asks) lines.push('seq' + a.seq + '：' + collapse(a.text).slice(0, 300))
  }
  lines.push('')
  lines.push('【编号思维链】')
  for (const s of sentences) lines.push('[' + s.i + '] ' + s.text)
  return lines.join('\n')
}

// ── 解析 ───────────────────────────────────────────────────────────────────
const KINDS = new Set(['explore', 'closed', 'exec'])
const STATUSES = new Set(['verified', 'refuted', 'unverified'])

function firstJsonObject(text) {
  const s = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  if (a < 0) return null
  // 平衡括号扫描（跳过字符串里的括号）
  let depth = 0, inStr = false, esc = false
  for (let i = a; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(a, i + 1)) } catch { return null } } }
  }
  return null
}

/**
 * 模型输出 → 规范化选择。非法字段丢弃；整体不可解析 ⇒ null（调用方原文放行）。
 * @returns {{kind, plan:number[], keep:number[], tags:Array<{i,s,seq,quote}>, state:Array<{k,v}>, dropped:number}|null}
 */
export function parseExtractiveOutput(text, n) {
  const o = firstJsonObject(text)
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  let dropped = 0
  const idx = (arr) => {
    const out = new Set()
    for (const x of Array.isArray(arr) ? arr : []) {
      const v = typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x
      if (Number.isInteger(v) && v >= 0 && v < n) out.add(v); else dropped++
    }
    return [...out].sort((a, b) => a - b)
  }
  const tags = []
  const seenTag = new Set()
  for (const t of Array.isArray(o.tags) ? o.tags : []) {
    const i = t && (typeof t.i === 'string' && /^\d+$/.test(t.i) ? Number(t.i) : t.i)
    const s = t && String(t.s || t.status || '').toLowerCase()
    if (!Number.isInteger(i) || i < 0 || i >= n || !STATUSES.has(s) || seenTag.has(i)) { dropped++; continue }
    seenTag.add(i)
    const seq = t.seq == null ? null : (typeof t.seq === 'string' ? t.seq.replace(/^seq/i, '') : t.seq)
    tags.push({ i, s, seq: seq == null || seq === '' ? null : (Number.isFinite(Number(seq)) ? Number(seq) : String(seq)), quote: t.quote == null ? '' : String(t.quote) })
  }
  const state = []
  for (const e of Array.isArray(o.state) ? o.state : []) {
    const pair = Array.isArray(e) ? { k: e[0], v: e[1] } : e
    const k = pair && collapse(pair.k).replace(/[=·|]/g, '').slice(0, 20)
    const v = pair && pair.v != null ? String(pair.v).trim() : ''
    if (!k || !v) { dropped++; continue }
    state.push({ k, v })
  }
  return {
    kind: KINDS.has(o.kind) ? o.kind : 'explore',
    plan: idx(o.plan).slice(0, 2),
    keep: idx(o.keep),
    tags, state, dropped,
  }
}

// ── 拼装 ───────────────────────────────────────────────────────────────────
const LABELS = {
  zh: { verified: (seq) => '⟨证实·seq' + seq + '⟩', refuted: (seq) => '⟨已否定·seq' + seq + '⟩', unverified: () => '⟨未验证⟩', state: '[状态]', handle: (h) => '〔原文 ' + h + ' · 删去的句子可按句柄取回〕' },
  en: { verified: (seq) => '⟨verified·seq' + seq + '⟩', refuted: (seq) => '⟨refuted·seq' + seq + '⟩', unverified: () => '⟨unverified⟩', state: '[state]', handle: (h) => '[full text ' + h + ' · omitted sentences retrievable by handle]' },
}

/** 本地决定逐字尾巴的起点：从末尾向前累加，不超过 tailChars；至少 1 句。 */
export function tailStartIndex(sentences, tailChars) {
  const n = sentences.length
  if (!n) return 0
  const budget = Number.isFinite(tailChars) && tailChars >= 0 ? tailChars : 400
  if (budget === 0) return n
  let used = 0
  let t = n
  while (t > 0) {
    const len = sentences[t - 1].end - sentences[t - 1].start
    if (t < n && used + len > budget) break
    used += len
    t--
  }
  return t
}

/**
 * 选择 + 原文 + 证据 → 最终文本。硬校验：
 *   ① 输出句子全部是原文逐字切片，按原文顺序；
 *   ② verified/refuted 必须能在所引 seq 的工具结果里逐字找到 quote，否则 verified→unverified、refuted→去标签；
 *   ③ state 值必须能在原文或用户输入里逐字找到，否则丢弃；
 *   ④ 原文里的逐字标识符缺失 ⇒ 把含它的首个句子补回（至多 min(repairMax, 15% 句数) 句）；
 *   ⑤ 转折句（explore 类）强制保留。
 * @returns {{ text, stats }}  text 为空串 ⇒ 调用方按失败处理
 */
export function assembleExtractive(raw, sentences, sel, opts = {}) {
  const s = String(raw || '')
  const n = sentences.length
  const lang = opts.lang || (isWideText(s) ? 'zh' : 'en')
  const L = LABELS[lang] || LABELS.zh
  const ev = opts.evidence || { tools: [], asks: [] }
  const tailChars = Number.isFinite(opts.tailChars) ? opts.tailChars : 400
  // 修复上限取「绝对上限」与「句数的 15%」中较小者：标识符密集的块里，无上限修复会把整段补回、压缩归零
  const repairMax = Math.min(Number.isFinite(opts.repairMax) ? opts.repairMax : 6, Math.max(1, Math.ceil(n * 0.15)))
  const kind = sel && KINDS.has(sel.kind) ? sel.kind : 'explore'
  const stats = { kind, sentences: n, kept: 0, forced: 0, repaired: 0, tailSentences: 0, tagsVerified: 0, tagsRefuted: 0, tagsUnverified: 0,
    tagsDowngraded: 0, stateKept: 0, stateDropped: 0, lang }
  if (!n) return { text: '', stats }

  // 尾巴起点必须与 prepareExtractive 告诉模型的一致（否则夹缝里的句子既没被选、也不在尾巴里）
  const tailFrom = tailStartIndex(sentences, tailChars)
  stats.tailSentences = n - tailFrom
  const keep = new Set()
  if (kind !== 'exec') {
    for (const i of sel.plan || []) if (i < tailFrom) keep.add(i)
    for (const i of sel.keep || []) if (i < tailFrom) keep.add(i)
  }
  // 被标为证实/否定的句子就是「验证」句（思维锚点）⇒ 标了就留（标签随后仍要过硬校验）
  if (kind !== 'exec') for (const t of (sel && sel.tags) || []) if (t.s !== 'unverified' && t.i < tailFrom) keep.add(t.i)
  if (kind === 'explore') {
    for (let i = 0; i < tailFrom; i++) {
      const t = sentences[i].text
      if (!keep.has(i) && t.length <= 300 && RE_TRANSITION.test(t)) { keep.add(i); stats.forced++ }
    }
  }

  // 标签硬校验
  const toolBySeq = new Map()
  for (const t of ev.tools || []) toolBySeq.set(String(t.seq), collapse(t.text))
  const tagOf = new Map()
  for (const t of (sel && sel.tags) || []) {
    if (!keep.has(t.i) && t.i < tailFrom) continue   // 没被留下的句子不需要标签
    if (t.s === 'unverified') { tagOf.set(t.i, L.unverified()); stats.tagsUnverified++; continue }
    const body = t.seq == null ? null : toolBySeq.get(String(t.seq))
    const q = collapse(t.quote)
    // 引用须逐字命中；极短的工具输出（如 SQL 只回 "1"）允许整段引用
    const grounded = !!body && q.length > 0 && ((q.length >= 4 && q.length <= 200 && body.includes(q)) || q === body)
    if (grounded) {
      tagOf.set(t.i, t.s === 'verified' ? L.verified(t.seq) : L.refuted(t.seq))
      if (t.s === 'verified') stats.tagsVerified++; else stats.tagsRefuted++
    } else {
      stats.tagsDowngraded++
      if (t.s === 'verified') { tagOf.set(t.i, L.unverified()); stats.tagsUnverified++ }
      // refuted 无证据 ⇒ 去掉标签，句子本身照原文保留
    }
  }

  // 状态硬校验
  const rawC = collapse(s)
  const askC = (ev.asks || []).map((a) => collapse(a.text))
  const stateParts = []
  const seenK = new Set()
  for (const e of (sel && sel.state) || []) {
    if (stateParts.length >= 8) { stats.stateDropped++; continue }
    const v = collapse(e.v)
    if (!v || v.length > 160 || seenK.has(e.k)) { stats.stateDropped++; continue }
    if (rawC.includes(v)) { stateParts.push(e.k + '=' + v); seenK.add(e.k) }
    else if (askC.some((a) => a.includes(v))) { stateParts.push(e.k + '="' + v + '"'); seenK.add(e.k) }
    else stats.stateDropped++
  }
  stats.stateKept = stateParts.length

  // 标识符修复：原文逐字标识符在「保留句 + 尾巴 + 状态」里都找不到 ⇒ 补回首个含它的句子
  const present = () => [...keep].map((i) => sentences[i].text).join('\n') + '\n' + s.slice(sentences[tailFrom] ? sentences[tailFrom].start : s.length) + '\n' + stateParts.join(' ')
  let hay = present()
  for (const id of hardIdentifiers(s)) {
    if (stats.repaired >= repairMax) break
    if (hay.includes(id)) continue
    const at = sentences.findIndex((x, i) => i < tailFrom && x.text.includes(id))
    if (at < 0 || keep.has(at)) continue
    keep.add(at); stats.repaired++
    hay = present()
  }

  // 拼装：连续句子按原文切片（保留原分隔符），断开处以「… 」起行；标签紧跟句末
  const order = [...keep].sort((a, b) => a - b)
  stats.kept = order.length
  const groups = []
  let cur = null
  for (const i of order) {
    if (cur && i === cur.last + 1) { cur.parts.push(i); cur.last = i }
    else { cur = { first: i, last: i, parts: [i] }; groups.push(cur) }
  }
  const renderGroup = (g) => {
    let out = ''
    for (let k = 0; k < g.parts.length; k++) {
      const i = g.parts[k]
      const sen = sentences[i]
      if (k > 0) out += s.slice(sentences[g.parts[k - 1]].end, sen.start).replace(/\n{2,}/g, '\n')
      out += sen.text + (tagOf.has(i) ? tagOf.get(i) : '')
    }
    return out
  }
  const lines = []
  // 组与组之间必有空缺；首组若不从第 0 句开始，前面也有空缺
  for (const g of groups) lines.push((g.first > 0 ? '… ' : '') + renderGroup(g))
  if (stateParts.length) lines.push(L.state + ' ' + stateParts.join(' · '))
  let tail = ''
  if (tailFrom < n) {
    // 尾巴是**逐字**原文；若尾巴里有被标注的句子，标签照样插在句末
    const tg = { first: tailFrom, last: n - 1, parts: Array.from({ length: n - tailFrom }, (_, k) => tailFrom + k) }
    const lastKept = order.length ? order[order.length - 1] : -1
    tail = (tailFrom > 0 && lastKept !== tailFrom - 1 ? '… ' : '') + renderGroup(tg)
  }
  const head = lines.join('\n')
  const text = head && tail ? head + '\n\n' + tail : (head || tail)
  try {
    const f = fidelity(s, text)
    stats.identifierRecall = f.stats.protectedTokens ? f.stats.tokenRecall : null
  } catch { stats.identifierRecall = null }
  stats.outChars = text.length
  stats.ratio = s.length ? +(text.length / s.length).toFixed(3) : null
  return { text, stats }
}

/** 句柄行（语言跟随原文）。只能在句柄已被证实可读回后调用。 */
export function extractiveHandleLine(handle, raw) {
  const L = LABELS[isWideText(raw) ? 'zh' : 'en']
  return L.handle(String(handle))
}

/** 版本号：准则非空时带 8 位指纹 ⇒ trace 自动按准则分桶做 A/B。 */
export function extractivePromptVersion(cfg) {
  const g = String((cfg && cfg.extractiveGuideline) || '').trim()
  return 'compress-' + EXTRACTIVE_VERSION + (g ? ':g' + fnv1a(g) : '')
}

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/**
 * 一站式：原文 + 证据 → { prompt, sentences, tailFrom }（发请求之前）
 * 与 finalize（拿到模型输出之后）配对使用。birth 与离线评测共用这两步，保证评的就是线上那套。
 */
export function prepareExtractive(raw, cfg = {}, evidence = null) {
  const sentences = segmentSentences(raw)
  const tailChars = Number.isFinite(cfg.extractiveTailChars) ? cfg.extractiveTailChars : 400
  const tailFrom = tailStartIndex(sentences, tailChars)
  const prompt = buildExtractivePrompt(sentences, { evidence, guideline: cfg.extractiveGuideline, tailFrom })
  return { sentences, tailFrom, prompt }
}

export function finalizeExtractive(raw, prepared, modelText, cfg = {}, evidence = null) {
  const sel = parseExtractiveOutput(modelText, prepared.sentences.length)
  if (!sel) { const e = new Error('extractive: unparseable selection'); e.code = 'extractive-unparseable'; throw e }
  const r = assembleExtractive(raw, prepared.sentences, sel, {
    evidence, tailChars: Number.isFinite(cfg.extractiveTailChars) ? cfg.extractiveTailChars : 400,
    repairMax: Number.isFinite(cfg.extractiveRepairMax) ? cfg.extractiveRepairMax : 6,
  })
  const maxRatio = Number.isFinite(cfg.extractiveMaxKeepRatio) ? cfg.extractiveMaxKeepRatio : 0.7
  if (!r.text.trim()) { const e = new Error('extractive: empty assembly'); e.code = 'extractive-empty'; throw e }
  if (r.stats.ratio != null && r.stats.ratio > maxRatio) {
    const e = new Error('extractive: kept ratio ' + r.stats.ratio + ' > ' + maxRatio); e.code = 'extractive-too-long'; e.stats = r.stats; throw e
  }
  return { text: r.text, stats: { ...r.stats, dropped: sel.dropped } }
}
