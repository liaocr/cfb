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
//   · v11.13 r2（docs/RESEARCH-PERFORMANCE.md）：死分支折叠（过程删、结论与原因留）、失败信号保留、
//     按块类型的目标长度、状态行去重。依据：表现 = 去噪收益 − 离策略代价；逐字抽取让后者最小。
//
// 纯函数、零网络、同步。任何异常都应由调用方转成「原文放行」。

import { scriptCounts } from './tokens.js'
import { fidelity } from './fidelity.js'

export const EXTRACTIVE_VERSION = 'x1'
// v11.13 修订号：r2 = 死分支折叠 + 失败信号保留 + 按块类型目标长度 + 状态行去重（docs/RESEARCH-PERFORMANCE.md P1–P4）。
//   提示词与拼装规则变了 ⇒ promptVersion 必须变，trace 才能把 r1 / r2 分桶比较。
export const EXTRACTIVE_REVISION = 2

/**
 * 按块类型的目标长度（「选中句 + 尾巴」/ 原文字符）。**只写进提示词作为上限提示**，不做本地硬裁剪：
 * 超目标时本地拒绝只会退回原文（更长），所以唯一的硬上限仍是 extractiveMaxKeepRatio。
 *   closed：结论已出，过程对后续基本无用 ⇒ 最狠；exec：照计划执行 ⇒ 次之；explore：过程仍在被使用 ⇒ 最宽。
 *   依据：AgentSwing（2603.27490，按情况选择保留策略）；Step Entropy（2508.03346，低熵步骤可大删、高熵不能删）。
 */
export const EXTRACTIVE_KIND_TARGETS = Object.freeze({ closed: 0.25, exec: 0.3, explore: 0.5 })

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
// v11.13 自我否定：abandoned 支线的 why 句必须含有作者**自己的**否定原话，否则不折叠（防止副模型随手挑一句当理由）。
//   这只是合理性核对，不是证明；拿不准时的后果是「不折叠」= 回到 r1 行为。
const RE_SELF_REFUTE = /(不对|不行|不是|并非|不成立|行不通|走不通|说不通|排除|放弃|错了|搞错|不可能|没用|无效|无关|不相关|否定|推翻|\bnot\b|\bno\b|n't\b|\bwrong\b|ruled? out|dead end|give up|abandon|irrelevant|unrelated)/i
// v11.13 失败信号：含报错/失败且指向具体对象的句子。摘要丢掉失败信号会让 agent 在无效循环里打转
//   （Complexity Trap, 2508.21433）；search loop 是最稳定的失败信号（TraceProbe, 2607.06184）。
const RE_FAILURE = /(报错|出错|错误|失败|异常|崩溃|超时|找不到|不存在|拒绝访问|权限不足|未通过|\berror\b|\bexception\b|traceback|\bfail(?:s|ed|ure)?\b|exit(?:ed)?(?: with)? (?:code|status) *[1-9]|non-zero exit|not found|no such file|permission denied|timed? ?out|\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|segfault|\bpanic\b)/i
function isFailureSentence(text) {
  const t = String(text || '')
  if (t.length > 300 || !RE_FAILURE.test(t)) return false
  // 必须指向具体对象（标识符 / 数字 / 引号或反引号里的片段），否则「这个思路是错误的」之类也会被当成失败信号
  return hardIdentifiers(t).size > 0 || /\d/.test(t) || /["'`「“]/.test(t)
}
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
 * @param ctx { evidence?, guideline?, tailFrom?, fold?, kindTargets? } tailFrom = 本地已决定逐字保留的尾巴起点（尾巴不必再选）；
 *   fold=false 不要求 branches；kindTargets=false 不写按块类型的长度上限（两者缺省都开）
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
  const fold = ctx.fold !== false
  lines.push('只输出一个 JSON 对象，不要代码围栏，不要解释：')
  lines.push('{"kind":"explore|closed|exec","plan":[编号],"keep":[编号],"tags":[{"i":编号,"s":"verified|refuted|unverified","seq":证据seq,"quote":"证据原文片段"}],'
    + (fold ? '"branches":[{"from":编号,"to":编号,"head":编号,"why":编号,"s":"refuted|abandoned|parked","seq":证据seq,"quote":"证据原文片段"}],' : '')
    + '"state":[{"k":"名","v":"原文逐字值"}]}')
  lines.push('· kind：explore=仍在探索/排错；closed=本段已得出结论、子目标完成；exec=照计划执行、几乎没有推理。')
  lines.push('· plan：开头的计划句（最多 2 个）。keep：其余要留的句子。顺序无所谓，程序会按原文排序。')
  lines.push('· tags：verified/refuted 必须给出下方证据里的 seq 和一段**逐字**引用（6~80 字符；输出本身很短时引用全文），程序会核对，对不上一律降级。只是推测、没有证据的断言标 unverified。没有就给空数组。')
  if (fold) {
    lines.push('· branches：本段里**已经放下**的尝试或假设（支线）。from/to=支线首尾句编号，head=提出该假设的那句，why=说明它为什么不成立的那句。'
      + 's=refuted（被工具结果否定，须给 seq 和逐字 quote）/ abandoned（作者自己推翻了它，why 句里要有「不对、不是、排除、放弃」这类原话）/ parked（没被否定，只是暂时放下）。'
      + 'refuted/abandoned 支线内部的句子会被删掉，只留 head 和 why；parked 只加标记。支线里得到的、后续仍有用的事实不要放进支线范围。没有就给空数组。')
  }
  lines.push('· state：最多 8 条；只记正文留不下来的变量（已留下的句子里逐字出现过的不必重复）；v 必须能在原文或用户输入里逐字找到。')
  if (ctx.kindTargets !== false) {
    const T = EXTRACTIVE_KIND_TARGETS
    lines.push('· 长度上限（留下的句子 + 尾巴占原文字符的比例，按 kind）：closed ≈' + Math.round(T.closed * 100) + '%，exec ≈' + Math.round(T.exec * 100)
      + '%，explore ≈' + Math.round(T.explore * 100) + '%。能更短就更短；决定、发现、否定理由、未决问题优先。')
  }
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
const BRANCH_STATUSES = new Set(['refuted', 'abandoned', 'parked'])
const MAX_BRANCHES = 6
const toIdx = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)
const normSeq = (seq) => {
  if (seq == null) return null
  const v = typeof seq === 'string' ? seq.replace(/^seq/i, '') : seq
  return v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : String(v))
}

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
 * @returns {{kind, plan:number[], keep:number[], tags:Array<{i,s,seq,quote}>, branches:Array<{from,to,head,why,s,seq,quote}>, state:Array<{k,v}>, dropped:number}|null}
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
    tags.push({ i, s, seq: normSeq(t.seq), quote: t.quote == null ? '' : String(t.quote) })
  }
  // v11.13 支线：区间非法 / 状态未知 ⇒ 丢弃；head 不在区间内 ⇒ 取 from；why 必须在 head 之后或等于 head（否定理由不会出现在假设之前）。
  //   区间重叠的只收先出现的那条（按 from 排序后贪心），最多 MAX_BRANCHES 条。
  const rawBranches = []
  for (const b of Array.isArray(o.branches) ? o.branches : []) {
    let from = b && toIdx(b.from), to = b && toIdx(b.to)
    const st = b && String(b.s || b.status || '').toLowerCase()
    if (!Number.isInteger(from) || !Number.isInteger(to) || !BRANCH_STATUSES.has(st)) { dropped++; continue }
    if (from > to) [from, to] = [to, from]
    if (from < 0 || to >= n) { dropped++; continue }
    let head = toIdx(b.head)
    if (!Number.isInteger(head) || head < from || head > to) head = from
    let why = toIdx(b.why)
    if (!Number.isInteger(why) || why < head || why >= n) why = null
    rawBranches.push({ from, to, head, why, s: st, seq: normSeq(b.seq), quote: b.quote == null ? '' : String(b.quote) })
  }
  rawBranches.sort((a, b) => a.from - b.from || a.to - b.to)
  const branches = []
  for (const b of rawBranches) {
    if (branches.length >= MAX_BRANCHES || (branches.length && b.from <= branches[branches.length - 1].to)) { dropped++; continue }
    branches.push(b)
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
    tags, branches, state, dropped,
  }
}

// ── 拼装 ───────────────────────────────────────────────────────────────────
const LABELS = {
  zh: { verified: (seq) => '⟨证实·seq' + seq + '⟩', refuted: (seq) => '⟨已否定·seq' + seq + '⟩', unverified: () => '⟨未验证⟩', abandoned: () => '⟨已放弃⟩', parked: () => '⟨搁置⟩', state: '[状态]', handle: (h) => '〔原文 ' + h + ' · 删去的句子可按句柄取回〕' },
  en: { verified: (seq) => '⟨verified·seq' + seq + '⟩', refuted: (seq) => '⟨refuted·seq' + seq + '⟩', unverified: () => '⟨unverified⟩', abandoned: () => '⟨abandoned⟩', parked: () => '⟨parked⟩', state: '[state]', handle: (h) => '[full text ' + h + ' · omitted sentences retrievable by handle]' },
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
 *   ④ 原文里的逐字标识符缺失 ⇒ 把含它的首个句子补回（至多 min(repairMax, 15% 句数) 句；优先支线外的句子）；
 *   ⑤ 转折句（explore 类）强制保留——**被折叠支线内部的除外**（v11.13）；
 * v11.13（r2，docs/RESEARCH-PERFORMANCE.md P1/P2/P4）：
 *   ⑥ 死分支折叠（opts.fold，缺省开；exec 块不适用）：
 *      refuted  = 工具证据逐字命中 ⇒ head 标 ⟨已否定·seqN⟩，内部句删掉，只留 head + why；
 *      abandoned = why 句含作者自己的否定原话（RE_SELF_REFUTE）⇒ head 标 ⟨已放弃⟩，同上折叠；
 *                  refuted 证据对不上但 why 合格 ⇒ 降级为 abandoned；两者都不合格 ⇒ 不折叠（= r1 行为）；
 *      parked   = head 标 ⟨搁置⟩，内部句**不删**（没被证伪的思路可能还要回来），只是不再强制保留其中的转折/失败句；
 *      支线内被**证实**的句子（正知识）与计划句永不折叠。
 *   ⑦ 失败信号保留（opts.keepFailures，缺省开）：含报错/失败且指向具体对象的句子补回，至多 min(4, 10% 句数)，
 *      从后往前（越近越相关），跳过折叠/搁置支线内部。
 *   ⑧ 状态行去重（opts.stateDedupe，缺省开）：值（≥6 字符）已在保留句或尾巴里逐字出现 ⇒ 不再重复；
 *      用户原话约束（带引号的）永不去重。依据：SKILL.state「状态 + 完整历史」反而最差。
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
  const fold = opts.fold !== false
  const keepFailures = opts.keepFailures !== false
  const stateDedupe = opts.stateDedupe !== false
  const failMax = Math.min(4, Math.max(1, Math.ceil(n * 0.1)))
  const kind = sel && KINDS.has(sel.kind) ? sel.kind : 'explore'
  const stats = { kind, sentences: n, kept: 0, forced: 0, repaired: 0, tailSentences: 0, tagsVerified: 0, tagsRefuted: 0, tagsUnverified: 0,
    tagsDowngraded: 0, stateKept: 0, stateDropped: 0, lang,
    branchesFolded: 0, branchesParked: 0, branchesRejected: 0, foldedSentences: 0, foldRepaired: 0, failuresKept: 0, stateDeduped: 0,
    target: EXTRACTIVE_KIND_TARGETS[kind] }
  if (!n) return { text: '', stats }

  // 尾巴起点必须与 prepareExtractive 告诉模型的一致（否则夹缝里的句子既没被选、也不在尾巴里）
  const tailFrom = tailStartIndex(sentences, tailChars)
  stats.tailSentences = n - tailFrom

  // 证据核对（标签与 refuted 支线共用）：引用须逐字命中；极短的工具输出（如 SQL 只回 "1"）允许整段引用
  const toolBySeq = new Map()
  for (const t of ev.tools || []) toolBySeq.set(String(t.seq), collapse(t.text))
  const grounded = (seq, quote) => {
    const body = seq == null ? null : toolBySeq.get(String(seq))
    const q = collapse(quote)
    return !!body && q.length > 0 && ((q.length >= 4 && q.length <= 200 && body.includes(q)) || q === body)
  }
  // 标签先定级（最终是否显示取决于句子是否留下）：none = refuted 无证据 ⇒ 去标签
  const tagGrade = new Map()
  for (const t of (sel && sel.tags) || []) {
    if (t.s === 'unverified') tagGrade.set(t.i, { s: 'unverified', downgraded: false })
    else if (grounded(t.seq, t.quote)) tagGrade.set(t.i, { s: t.s, seq: t.seq, downgraded: false })
    else tagGrade.set(t.i, { s: t.s === 'verified' ? 'unverified' : 'none', downgraded: true })
  }

  const keep = new Set()
  const plan = new Set()
  if (kind !== 'exec') {
    for (const i of sel.plan || []) if (i < tailFrom) { keep.add(i); plan.add(i) }
    for (const i of sel.keep || []) if (i < tailFrom) keep.add(i)
  }
  // 被标为证实/否定的句子就是「验证」句（思维锚点）⇒ 标了就留（标签随后仍要过硬校验）
  if (kind !== 'exec') for (const t of (sel && sel.tags) || []) if (t.s !== 'unverified' && t.i < tailFrom) keep.add(t.i)

  // ⑥ 死分支折叠
  const folded = new Set()     // refuted/abandoned 支线内部（已删）
  const noForce = new Set()    // 不强制保留转折/失败句的位置 = folded ∪ parked 内部
  const branchTag = new Map()
  if (fold && kind !== 'exec') {
    // 两遍：先定级并收集「必须留」的 head/why（某条支线的 why 可能落在后一条支线的范围里），再删内部句
    const accepted = []
    const protect = new Set()
    for (const b of (sel && sel.branches) || []) {
      if (b.from >= tailFrom || b.head >= tailFrom) { stats.branchesRejected++; continue }   // 尾巴是逐字原文，不折
      const whyOk = b.why != null && RE_SELF_REFUTE.test(sentences[b.why].text)
      let grade = null
      if (b.s === 'refuted' && grounded(b.seq, b.quote)) grade = 'refuted'
      else if ((b.s === 'refuted' || b.s === 'abandoned') && whyOk) grade = 'abandoned'
      else if (b.s === 'parked') grade = 'parked'
      if (!grade) { stats.branchesRejected++; continue }
      accepted.push({ ...b, to: Math.min(b.to, tailFrom - 1), grade })
      protect.add(b.head)
      if (grade !== 'parked' && b.why != null) protect.add(b.why)
    }
    for (const b of accepted) {
      keep.add(b.head)
      if (b.grade === 'parked') {
        branchTag.set(b.head, L.parked())
        for (let i = b.from; i <= b.to; i++) if (i !== b.head) noForce.add(i)
        stats.branchesParked++
        continue
      }
      branchTag.set(b.head, b.grade === 'refuted' ? L.refuted(b.seq) : L.abandoned())
      if (b.why != null && b.why < tailFrom) keep.add(b.why)
      for (let i = b.from; i <= b.to; i++) {
        if (protect.has(i) || plan.has(i)) continue
        const g = tagGrade.get(i)
        if (g && g.s === 'verified') continue          // 支线里被证实的事实是正知识，留
        folded.add(i); noForce.add(i); keep.delete(i)
      }
      stats.branchesFolded++
    }
  }

  // ⑤ 转折句
  if (kind === 'explore') {
    for (let i = 0; i < tailFrom; i++) {
      const t = sentences[i].text
      if (!keep.has(i) && !noForce.has(i) && t.length <= 300 && RE_TRANSITION.test(t)) { keep.add(i); stats.forced++ }
    }
  }
  // ⑦ 失败信号（从后往前）
  if (keepFailures) {
    for (let i = tailFrom - 1; i >= 0 && stats.failuresKept < failMax; i--) {
      if (keep.has(i) || noForce.has(i)) continue
      if (isFailureSentence(sentences[i].text)) { keep.add(i); stats.failuresKept++ }
    }
  }

  // ③ 状态硬校验
  const rawC = collapse(s)
  const askC = (ev.asks || []).map((a) => collapse(a.text))
  let stateEntries = []
  const seenK = new Set()
  for (const e of (sel && sel.state) || []) {
    if (stateEntries.length >= 8) { stats.stateDropped++; continue }
    const v = collapse(e.v)
    if (!v || v.length > 160 || seenK.has(e.k)) { stats.stateDropped++; continue }
    if (rawC.includes(v)) { stateEntries.push({ k: e.k, v, user: false }); seenK.add(e.k) }
    else if (askC.some((a) => a.includes(v))) { stateEntries.push({ k: e.k, v, user: true }); seenK.add(e.k) }
    else stats.stateDropped++
  }
  const renderState = (e) => e.k + '=' + (e.user ? '"' + e.v + '"' : e.v)

  // ④ 标识符修复：原文逐字标识符在「保留句 + 尾巴 + 状态」里都找不到 ⇒ 补回首个含它的句子（优先支线外）
  const tailText = s.slice(sentences[tailFrom] ? sentences[tailFrom].start : s.length)
  const present = () => [...keep].map((i) => sentences[i].text).join('\n') + '\n' + tailText + '\n' + stateEntries.map(renderState).join(' ')
  let hay = present()
  for (const id of hardIdentifiers(s)) {
    if (stats.repaired >= repairMax) break
    if (hay.includes(id)) continue
    let at = sentences.findIndex((x, i) => i < tailFrom && !folded.has(i) && x.text.includes(id))
    if (at < 0) at = sentences.findIndex((x, i) => i < tailFrom && x.text.includes(id))
    if (at < 0 || keep.has(at)) continue
    keep.add(at); stats.repaired++
    if (folded.has(at)) stats.foldRepaired++
    hay = present()
  }

  // ⑧ 状态行去重（在修复之后：被去重的值必然仍在保留句/尾巴里，标识符不会因此丢失）
  if (stateDedupe && stateEntries.length) {
    const keptC = collapse([...keep].map((i) => sentences[i].text).join('\n') + '\n' + tailText)
    stateEntries = stateEntries.filter((e) => {
      if (!e.user && e.v.length >= 6 && keptC.includes(e.v)) { stats.stateDeduped++; return false }
      return true
    })
  }
  stats.stateKept = stateEntries.length
  const stateParts = stateEntries.map(renderState)

  // ② 标签定稿：只给最终可见的句子（留下的或尾巴里的）；支线标签优先于普通标签
  const visible = (i) => keep.has(i) || i >= tailFrom
  const tagOf = new Map()
  for (const [i, lab] of branchTag) if (visible(i)) tagOf.set(i, lab)
  for (const t of (sel && sel.tags) || []) {
    if (!visible(t.i) || tagOf.has(t.i)) continue
    const g = tagGrade.get(t.i)
    if (g.downgraded) stats.tagsDowngraded++
    if (g.s === 'none') continue
    if (g.s === 'unverified') { tagOf.set(t.i, L.unverified()); stats.tagsUnverified++; continue }
    tagOf.set(t.i, g.s === 'verified' ? L.verified(g.seq) : L.refuted(g.seq))
    if (g.s === 'verified') stats.tagsVerified++; else stats.tagsRefuted++
  }
  stats.foldedSentences = [...folded].filter((i) => !keep.has(i)).length

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
  stats.overTarget = stats.ratio != null && Number.isFinite(stats.target) ? stats.ratio > stats.target : null
  return { text, stats }
}

/** 句柄行（语言跟随原文）。只能在句柄已被证实可读回后调用。 */
export function extractiveHandleLine(handle, raw) {
  const L = LABELS[isWideText(raw) ? 'zh' : 'en']
  return L.handle(String(handle))
}

/**
 * 版本号：compress-x1r<修订号>；关掉的 r2 特性各带一个后缀（:-fold / :-fail / :-tgt / :-dedupe）；准则非空时带 8 位指纹。
 * ⇒ trace 自动按「修订 + 特性开关 + 准则」分桶做 A/B / 消融。
 */
export function extractivePromptVersion(cfg) {
  const c = cfg || {}
  const g = String(c.extractiveGuideline || '').trim()
  const off = extractiveFeatures(c)
  return 'compress-' + EXTRACTIVE_VERSION + 'r' + EXTRACTIVE_REVISION
    + (off.fold ? '' : ':-fold') + (off.keepFailures ? '' : ':-fail') + (off.kindTargets ? '' : ':-tgt') + (off.stateDedupe ? '' : ':-dedupe')
    + (g ? ':g' + fnv1a(g) : '')
}

/** r2 特性开关（缺省全开；只有显式 false 才关）。 */
export function extractiveFeatures(cfg) {
  const c = cfg || {}
  return { fold: c.extractiveFoldBranches !== false, keepFailures: c.extractiveKeepFailures !== false,
    kindTargets: c.extractiveKindTargets !== false, stateDedupe: c.extractiveStateDedupe !== false }
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
  const f = extractiveFeatures(cfg)
  const prompt = buildExtractivePrompt(sentences, { evidence, guideline: cfg.extractiveGuideline, tailFrom, fold: f.fold, kindTargets: f.kindTargets })
  return { sentences, tailFrom, prompt }
}

export function finalizeExtractive(raw, prepared, modelText, cfg = {}, evidence = null) {
  const sel = parseExtractiveOutput(modelText, prepared.sentences.length)
  if (!sel) { const e = new Error('extractive: unparseable selection'); e.code = 'extractive-unparseable'; throw e }
  const f = extractiveFeatures(cfg)
  const r = assembleExtractive(raw, prepared.sentences, sel, {
    evidence, tailChars: Number.isFinite(cfg.extractiveTailChars) ? cfg.extractiveTailChars : 400,
    repairMax: Number.isFinite(cfg.extractiveRepairMax) ? cfg.extractiveRepairMax : 6,
    fold: f.fold, keepFailures: f.keepFailures, stateDedupe: f.stateDedupe,
  })
  const maxRatio = Number.isFinite(cfg.extractiveMaxKeepRatio) ? cfg.extractiveMaxKeepRatio : 0.7
  if (!r.text.trim()) { const e = new Error('extractive: empty assembly'); e.code = 'extractive-empty'; throw e }
  if (r.stats.ratio != null && r.stats.ratio > maxRatio) {
    const e = new Error('extractive: kept ratio ' + r.stats.ratio + ' > ' + maxRatio); e.code = 'extractive-too-long'; e.stats = r.stats; throw e
  }
  return { text: r.text, stats: { ...r.stats, dropped: sel.dropped } }
}
