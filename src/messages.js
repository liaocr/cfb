// dsh-cot-form-b / messages.js —— 出站消息的只读工具（纯函数，绝不修改消息）
//
//   provenanceOf       最终请求里每条消息的来源画像（看板 / 人类 user / 工具结果），只观测
//   mapMessagesToSeqs  出站消息 → 源事件 seq 的映射；数量对不上时整批不写（错位比缺失更糟）
//   textOfContent / reasoningTextOf  content 双兼容取文本 / 取 reasoning 块文本
// 旧版 checkpoint 看板的开标记（v12.1 已不再发射；保留识别，便于读含旧看板的历史会话）
const LEDGER_OPEN = '<cot-ledger>'

/**
 * ★★ 2026-09-21 消息溯源（外部审计 P0-3）★★
 * 回答"最终请求里那些连续 user 到底是什么"，而**不是**数 role。
 *
 * 设计要点：
 *   ① 逐条给出 role / 字符数 / 是否看板 / 人类 user 的开头片段；
 *   ② 把"连续同 role 的游程"单独列出来（只报 n>1 的），这正是要看的东西；
 *   ③ **不删上下文、不改 role、不合并消息** —— 这一步只观测。
 *   ④ runtime context 的识别不靠猜标记：只报 head，由人看 trace 判断。
 *
 * @param {Array} messages 出站请求的消息数组
 * @returns {{items:Array, runs:Array}}
 */
export function provenanceOf(messages, opts = {}) {
  const arr = Array.isArray(messages) ? messages : []
  // v11.10：片段长度可配（cfg.tracePreviewChars）；0 = 不记录任何正文片段。缺省 48 与旧行为一致。
  const previewChars = Number.isInteger(opts.previewChars) && opts.previewChars >= 0 ? opts.previewChars : 48
  const items = []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i] || {}
    const role = m.role == null ? null : String(m.role)
    let text = ''
    try { text = textOfContent(m.content) || '' } catch { text = '' }
    const reasoningChars = (() => { try { return reasoningTextOf(m).length } catch { return 0 } })()
    const isLedger = text.includes(LEDGER_OPEN)
    // ★ chars:0 ≠ 整条消息为空（外部审计）：把 content 的【结构】也记下来，
    //   否则"非文本块（图片/文件/工具结果）"会被误判成"空壳"。
    const c = m.content
    let contentType = 'other', blockCount = 0, blockTypes = []
    if (typeof c === 'string') { contentType = 'string'; blockCount = 1; blockTypes = ['text'] }
    else if (Array.isArray(c)) {
      contentType = 'array'; blockCount = c.length
      blockTypes = c.map((b) => {
        if (typeof b === 'string') return 'text'
        if (b && typeof b.type === 'string') return b.type
        return b && typeof b.text === 'string' ? 'text' : 'unknown'
      })
    } else if (c == null) { contentType = 'null' }
    const nonTextBlocks = blockTypes.filter((t) => t !== 'text').length
    // ★★ 2026-09-21 真机裁决（类别 A：探针语义不完整，不是消息为空）★★
    //   tool/result 事件的 message 形如：
    //     { role:'user', content:[ { type:'tool-result', toolCallId, content:[{type:'text',text}], isError } ] }
    //   ⇒ 文本在**嵌套 content** 里，而 textOfContent 只看顶层块的 .text ⇒ 读到 0。
    //   这不是"空壳 user"，是**工具结果**。补一个递归提取，只用于观测。
    let nestedChars = 0
    if (Array.isArray(c)) {
      for (const blk of c) {
        if (blk && Array.isArray(blk.content)) {
          for (const inner of blk.content) {
            if (inner && typeof inner.text === 'string') nestedChars += inner.text.length
            else if (typeof inner === 'string') nestedChars += inner.length
          }
        }
      }
    }
    const it = { i, role, chars: text.length, nestedChars, reasoningChars, isLedger, contentType, blockCount, blockTypes, nonTextBlocks }
    // 工具关联：tool_calls / tool_call_id（是否有配对信息）
    if (m.tool_calls !== undefined) it.hasToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.length : true
    if (m.tool_call_id !== undefined) it.toolCallId = String(m.tool_call_id).slice(0, 24)
    // 人类 user 的开头片段：用于区分"真用户发言"与"宿主注入的 runtime context"。
    // 只取 48 字符，足以辨认，不足以泄露大段内容。
    // 人类 user 才取开头片段；tool-result 的 user 没有顶层文本，取嵌套文本开头。
    if (role === 'user' && !isLedger && previewChars > 0) {
      const src = text || (Array.isArray(c) ? c.map((blk) => (blk && Array.isArray(blk.content) ? blk.content.map((x) => (x && x.text) || '').join('') : '')).join('') : '')
      if (src) it.head = src.slice(0, previewChars).replace(/\s+/g, ' ')
    }
    items.push(it)
  }
  const runs = []
  let start = 0
  for (let i = 1; i <= items.length; i++) {
    if (i === items.length || items[i].role !== items[start].role) {
      const n = i - start
      if (n > 1) runs.push({ role: items[start].role, n, from: start, to: i - 1 })
      start = i
    }
  }
  return { items, runs }
}

/**
 * ★★ 2026-09-21 建立"出站消息 → 源事件 seq"的链条（外部审计 P0-3）★★
 *
 * 依据（已读源码确认）：
 *   dsh-agent-loop:1204 `session.deriveMessages()` → dsh-session:1269 遍历
 *   `surface.nodes`（**元素就是 seq**）→ 对每个 seq 调 `deriveEventMessage(log[seq])`，
 *   投影为 null 的节点被**丢弃**（例如 content 为空的 assistant/message）。
 *
 * 因此映射规则是确定性的：按 surface.nodes 顺序走，跳过投影为 null 的节点，
 * 剩下的与出站 messages **一一对应**。不需要用正文反查（空串会匹配一大堆节点）。
 *
 * @returns {{map:Array|null, note:string}} map[i] = 第 i 条出站消息的来源 seq
 */
export function mapMessagesToSeqs(session, messageCount) {
  try {
    if (!session || !session.surface || !Array.isArray(session.surface.nodes)) {
      return { map: null, note: 'no-surface' }
    }
    if (typeof session.eventAt !== 'function') return { map: null, note: 'no-eventAt' }
    const nodes = session.surface.nodes
    const map = []
    for (const seq of nodes) {
      let ev = null
      try { ev = session.eventAt(seq) } catch { ev = null }
      if (!ev) continue
      // 与 dsh-session:209 deriveEventMessage 同规则
      if (ev.type === 'user/message') { map.push(seq); continue }
      if (ev.type === 'assistant/message' || ev.type === 'system/message') {
        const c = ev.data && ev.data.message && ev.data.message.content
        if (Array.isArray(c) && c.length === 0) continue   // 空内容 assistant 不投影
        map.push(seq); continue
      }
      if (ev.type === 'tool/result') { map.push(seq); continue }
    }
    // ⚠ 数量一致**不能**排除重排；映射边界由 deriveMessages 的代码路径保证（见函数头注释）。
    return { map, note: map.length === messageCount ? 'aligned' : 'mapping-mismatch', count: map.length, expected: messageCount }
  } catch (e) {
    return { map: null, note: 'error:' + String((e && e.message) || e) }
  }
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (typeof b === 'string' || typeof b.text === 'string'))
    .map((b) => (typeof b === 'string' ? b : b.text))
    .join('\n')
}


/**
 * v12.7（理论 S8-R5 / R7 的生产前提）：从出站消息构造压缩器的「当前任务与观察」上下文（cfg.compressCtx）。
 *   逐字锚点与改动落点来自**工具观察**，压缩器必须能对着观察核真；评测一直有 ctx（tools/compile-direct 注入任务原文），
 *   生产此前恒为空 ⇒ 只有推理里复述过的片段才算逐字，观察里的代码行会被程序门当编造剥掉、分支也没有落点可绑。
 * 取**当前回合**：最后一条人类 user（非 tool-result）之后的全部工具调用与结果。格式与 tools/v4-live.mjs 的 TASKS 一致：
 *   <人类 user 原文>\n\n[tool: name] <参数摘要>\n<结果文本>\n…
 * 只读，不改任何消息；形状不认识就跳过（不猜）。预算：maxChars（缺省 8000）；每条结果 perResultChars（缺省 3000，超过取头 2/3 + 尾 1/3）；
 * 人类 user 原文最多 userChars（缺省 2000）；超总预算先丢最旧的结果。没有人类 user 也没有结果 ⇒ ''。
 */
const RE_TOOL_RESULT_TYPE = /tool[-_]?result/i
const isToolResultBlock = (b) => !!b && typeof b === 'object' && typeof b.type === 'string' && RE_TOOL_RESULT_TYPE.test(b.type)
const nestedText = (c) => {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => (typeof x === 'string' ? x : x && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
}
const clip = (t, max) => {
  if (t.length <= max) return t
  const head = Math.floor(max * 2 / 3), tail = Math.max(0, max - head - 1)
  return t.slice(0, head) + '\n…\n' + (tail ? t.slice(-tail) : '')
}
const argsSummary = (a, max = 200) => {
  let v = a
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return v.slice(0, max) } }
  if (v && typeof v === 'object') {
    const parts = []
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') parts.push(k + '=' + String(x).replace(/\s+/g, ' ').trim())
    return parts.join(' ').slice(0, max)
  }
  return v == null ? '' : String(v).slice(0, max)
}
export function buildCompressCtx(messages, opts = {}) {
  const arr = Array.isArray(messages) ? messages : []
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 8000
  const perResultChars = Number.isFinite(opts.perResultChars) && opts.perResultChars > 0 ? Math.floor(opts.perResultChars) : 3000
  const userChars = Number.isFinite(opts.userChars) && opts.userChars > 0 ? Math.floor(opts.userChars) : 2000
  const isToolResultMsg = (m) => !!m && (m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.some(isToolResultBlock)) || (m.role === 'user' && /^\s*\[tool:/.test(textOfContent(m.content))))   // v12.9.0：纯文本回灌的「[tool: …]」也算工具结果
  // 最后一条人类 user：role user、不是工具结果、有正文
  let ui = -1
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (m && m.role === 'user' && !isToolResultMsg(m) && textOfContent(m.content).trim()) { ui = i; break }
  }
  const user = ui >= 0 ? textOfContent(arr[ui].content).trim() : ''
  const calls = new Map()   // toolCallId → { name, args }
  const results = []
  for (let i = ui + 1; i < arr.length; i++) {
    const m = arr[i]
    if (!m || typeof m !== 'object') continue
    if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.id != null) calls.set(String(c.id), { name: (c.function && c.function.name) || c.name || '', args: (c.function && c.function.arguments) ?? c.arguments ?? c.input })
      if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b.type === 'string' && RE_TOOL_CALL_TYPE.test(b.type) && b.id != null) calls.set(String(b.id), { name: b.name || b.toolName || (b.function && b.function.name) || '', args: b.arguments ?? b.input ?? b.args ?? (b.function && b.function.arguments) })
      continue
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id != null ? String(m.tool_call_id) : ''
      results.push({ id, name: m.name || '', text: textOfContent(m.content) })
      continue
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!isToolResultBlock(b)) continue
        const id = b.toolCallId ?? b.tool_call_id ?? b.tool_use_id ?? b.id
        const text = nestedText(b.content) || (typeof b.text === 'string' ? b.text : '') || (typeof b.result === 'string' ? b.result : '') || (typeof b.output === 'string' ? b.output : '')
        results.push({ id: id != null ? String(id) : '', name: b.name || b.toolName || '', text: String(text || '') })
      }
    }
  }
  const entries = results.map((r) => {
    const c = r.id ? calls.get(r.id) : null
    const name = (c && c.name) || r.name || '?'
    const head = '[tool: ' + name + ']' + (c && c.args != null ? ' ' + argsSummary(c.args) : '')
    return head.trimEnd() + '\n' + clip(String(r.text || '').trim(), perResultChars)
  })
  const userPart = clip(user, userChars)
  // v12.9.0：多轮台账（前几轮的稿 + 工具往来）放在 user 之后、本轮工具结果之前——它挂在任务陈述块下，不会被当成「在手的代码行」的文件块
  const ledger = opts.ledger === false ? '' : ledgerBlock(arr)
  // v12.9.2：延续段（程序按台账写的稿首段）紧跟台账
  const cont = opts.ledger === false || opts.continuation === false || !ledger ? '' : continuationBlock(arr, { path: opts.continuationPath })   // v14.12.3：continuationPath 'full' | 'bounded'（F6）
  if (!userPart && !entries.length && !ledger) return ''
  // 超总预算：先丢最旧的结果（最近的观察才是当前分支要绑的落点）
  const fixed = userPart.length + (ledger ? ledger.length + 2 : 0) + (cont ? cont.length + 2 : 0)
  const size = (parts) => parts.reduce((n, p) => n + p.length + 2, fixed)
  while (entries.length && size(entries) > maxChars) entries.shift()
  const out = [userPart, ledger, cont, ...entries].filter(Boolean).join('\n\n')
  return out.length > maxChars ? out.slice(0, maxChars) : out
}

/**
 * v12.9.0（理论 S10.2 多轮台账）：从**前几轮**的稿（assistant 的 reasoning_content / reasoning 块）与工具往来里逐字摘出台账：
 *   已定（落定句）/ 已排除 / 验收预注册 / 未解 / 已改（三元组 + 结果 + 其后跑过什么）/ 已走过的路（命令 → 结果首行）。
 *   代码算它能算的（P_t、C_t 状态），副模型只把本轮增量压进去；固定句式（v4d6）让稿机器可读，这是它的红利。
 *   只看**最后一条人类 user 之后**的消息（同一个任务）；每条 assistant 算一轮。返回 { rounds, edits, calls, decided, excluded, accept, open }。
 */
const LEDGER_DECIDED_RE = /改法只落一个[^。！？\n]*[。！？]?/g
const LEDGER_ACCEPT_RE = /[^。！？\n]*(?:验收|改完后|预期)[^。！？\n]*[。！？]?/g
const LEDGER_OPEN_RE = /[^。！？\n]*(?:对不上|未解|不改变落点)[^。！？\n]*[。！？]?/g
const LEDGER_REJECT_RE = /[^。！？\n]*(?:不选|已排除|排除[:：]|搁置|不动它|不走这条|治症状)[^。！？\n]*[。！？]?/g
// v14.10：上面三条「整句」正则在没有关键词的长句（代码块、命令输出）上是二次方回溯（每个起点都把句子扫到底再回退）。
//   语义上一个匹配永远落在同一个 [。！？\n] 分段内，所以先按分段切、只对含关键词的分段跑原正则 ⇒ 结果逐字相同、复杂度线性。见 sentenceMatches。
const LEDGER_ACCEPT_KW = /验收|改完后|预期/
const LEDGER_OPEN_KW = /对不上|未解|不改变落点/
const LEDGER_REJECT_KW = /不选|已排除|排除[:：]|搁置|不动它|不走这条|治症状/
/** 与 text.matchAll(re) 等价（re 不跨 [。！？\n]、不含锚点/后顾），但只在含 kw 的分段上跑 re。 */
function* sentenceMatches(text, re, kw) {
  const s = String(text || '')
  let start = 0
  for (let i = 0; i <= s.length; i++) {
    const ch = i < s.length ? s[i] : '\n'
    if (ch !== '。' && ch !== '！' && ch !== '？' && ch !== '\n') continue
    const seg = s.slice(start, ch === '\n' ? i : i + 1)
    if (kw.test(seg)) for (const m of seg.matchAll(re)) yield m
    start = i + 1
  }
}
const TRIPLE_RE = /old_text 是 `([^`\n]{1,220})`[^`]{0,160}?new_text 是 `([^`\n]{1,220})`/g
function draftOf(m) {
  if (!m) return ''
  if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) return m.reasoning_content
  if (typeof m.reasoning === 'string' && m.reasoning.trim()) return m.reasoning
  return reasoningTextOf(m)
}
/** assistant 消息里的工具调用：结构化 tool_calls / 块形 / 正文里的「[tool_call name] {json}」「[tool: name] cmd」 */
function callsOfAssistant(m) {
  const out = []
  if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) out.push({ id: c && c.id != null ? String(c.id) : '', name: (c && c.function && c.function.name) || (c && c.name) || '', args: (c && c.function && c.function.arguments) ?? (c && c.arguments) ?? (c && c.input) })
  if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b.type === 'string' && RE_TOOL_CALL_TYPE.test(b.type)) out.push({ id: b.id != null ? String(b.id) : '', name: b.name || b.toolName || (b.function && b.function.name) || '', args: b.arguments ?? b.input ?? b.args ?? (b.function && b.function.arguments) })
  const text = textOfContent(m.content)
  for (const x of text.matchAll(/\[tool_call\s+([\w-]+)\]\s*(\{[\s\S]*?\})(?=\s*(?:\[tool_call|\n|$))/g)) out.push({ id: '', name: x[1], args: x[2] })
  for (const x of text.matchAll(/\[tool:\s*([\w-]+)\]\s*`?([^\n`]+)`?/g)) out.push({ id: '', name: x[1], args: x[2].trim() })
  return out
}
const argsText = (a) => { if (a == null) return ''; if (typeof a === 'string') { try { const j = JSON.parse(a); return argsText(j) } catch { return a } } if (typeof a === 'object') return a.command || a.cmd || a.path || JSON.stringify(a); return String(a) }
const firstLine = (t, n = 120) => {
  const lines = String(t || '').trim().split('\n').map((l) => l.trim()).filter(Boolean)
  const head = lines[0] || ''
  const bad = lines.slice(1).find((l) => /FAIL|ERR|Error|EACCES|Exception|got \d|expected /.test(l))
  const cut = (x) => (x.length > n ? x.slice(0, n) + '…' : x)
  return bad ? cut(head) + ' … ' + cut(bad) : cut(head)
}
export function buildLedger(messages) {
  const arr = Array.isArray(messages) ? messages : []
  const isToolResultMsg = (m) => !!m && (m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.some(isToolResultBlock)) || (m.role === 'user' && /^\s*\[tool:/.test(textOfContent(m.content))))
  let ui = -1
  for (let i = arr.length - 1; i >= 0; i--) { const m = arr[i]; if (m && m.role === 'user' && !isToolResultMsg(m) && textOfContent(m.content).trim()) { ui = i; break } }
  const L = { rounds: 0, edits: [], calls: [], decided: [], excluded: [], accept: [], open: [], lines: [] }
  const pick = (text, re, max, seen, kw) => { const out = []; for (const m of (kw ? sentenceMatches(text, re, kw) : String(text || '').matchAll(re))) { const t = m[0].trim(); if (t.length < 8 || t.length > 240 || seen.has(t)) continue; seen.add(t); out.push(t); if (out.length >= max) break } return out }
  const seen = new Set()
  let round = 0
  for (let i = ui + 1; i < arr.length; i++) {
    const m = arr[i]
    if (!m || m.role !== 'assistant') continue
    round++
    const d = draftOf(m)
    if (d) {
      for (const t of pick(d, LEDGER_DECIDED_RE, 1, seen)) L.decided.push({ round, text: t })
      for (const t of pick(d, LEDGER_REJECT_RE, 3, seen, LEDGER_REJECT_KW)) L.excluded.push({ round, text: t })
      for (const t of pick(d, LEDGER_ACCEPT_RE, 2, seen, LEDGER_ACCEPT_KW)) L.accept.push({ round, text: t })
      for (const t of pick(d, LEDGER_OPEN_RE, 2, seen, LEDGER_OPEN_KW)) L.open.push({ round, text: t })
      // v12.9.2：前几轮稿里逐字引用的代码行（「仍在依赖的事实」）——延续段由程序写时要用；只收像代码的段，三元组里的行不重复收
      // v14.12.3（F6c）：程序写的「已走过的路：…这些不再重跑」一段里的反引号是命令参数，不是事实行 —— 之前会被当成「仍在依赖的事实」再写回下一轮稿（自我放大）
      const pathSpans = []
      for (const pm of d.matchAll(/已走过的路[：:]/g)) { const e = d.indexOf('这些不再重跑', pm.index); pathSpans.push([pm.index, e > 0 ? e : d.length]) }
      for (const m2 of d.matchAll(/`([^`\n]{12,200})`/g)) {
        const t = m2[1].trim()
        if (pathSpans.some(([a, b]) => m2.index >= a && m2.index < b)) continue
        if (/^(?:cd|which|type|find|command|declare|alias|env|export|printf|xargs|awk|sort|uniq|wc|head|tail|which)\s|\s2>&1\b|2>\/dev\/null|\s\|\s(?:head|tail|grep|wc|sort|xargs|sed)\b/.test(t)) continue   // 像一条 shell 命令的不收（只看命令头 / 重定向 / 管道进过滤器；不碰代码里的 && ; env）
        if (!/[(){}=;:]|\.(?:js|mjs|ts|py|json|ya?ml)\b|\//.test(t) || /^https?:/.test(t)) continue
        // 只收像代码 / 记录的行：不含中文（注释里的中文只许出现在 // 之后）、不以标点开头、不是一条命令
        if (/[\u3400-\u9fff\uff0c\u3002\uff1a\u300c\u300d]/.test(t.replace(/\/\/.*$/, ''))) continue
        if (/^[，。：；、,.:;]/.test(t) || /^(?:bash|grep|node|npm|npx|git|tail|cat|sed|ls|cd|curl|docker|taskset|python3?|echo|rm|mkdir|nc|ping)\b/.test(t)) continue
        if (seen.has('L:' + t)) continue
        seen.add('L:' + t)
        const back = d.slice(Math.max(0, m2.index - 160), m2.index)
        if (/new_text\s*(?:是|为|[:：])?\s*$/.test(back)) continue   // 提议的新行不是观察到的事实
        const src = back.match(/(read_file\s+[\w./-]+|git diff[^`\n（(：:]{0,60}|grep[^`\n（(：:]{0,40})(?![\s\S]*(?:read_file|git diff|grep))/)
        L.lines.push({ round, text: t, via: src ? src[1].trim().replace(/[（(]逐字[)）]?[:：]?$/, '').replace(/[:：\s]+$/, '') : '' })
      }
    }
    // 这一轮的调用 + 紧随其后（下一条 assistant 之前）的结果
    const resTexts = []
    for (let j = i + 1; j < arr.length && arr[j] && arr[j].role !== 'assistant'; j++) {
      const r = arr[j]
      if (r.role === 'tool') resTexts.push(textOfContent(r.content))
      else if (r.role === 'user' && Array.isArray(r.content)) { for (const b of r.content) if (isToolResultBlock(b)) resTexts.push(nestedText(b.content) || (typeof b.text === 'string' ? b.text : '') || '') }
      else if (r.role === 'user') { const t = textOfContent(r.content); const parts = t.split(/\n(?=\[tool:)/).map((x) => x.replace(/^\s*\[tool:[^\]]*\]\s*/, '')).filter((x) => x.trim()); resTexts.push(...(parts.length ? parts : [t])) }
    }
    const calls = callsOfAssistant(m)
    const resultFor = (k) => resTexts.length === calls.length ? resTexts[k] : resTexts.join('\n')
    calls.forEach((c, k) => {
      const a = argsText(c.args)
      const res = firstLine(resultFor(k))
      if (/edit_file|str_replace|apply_patch|write_file|edit/i.test(c.name)) {
        let file = '', oldText = '', newText = ''
        try { const j = typeof c.args === 'string' ? JSON.parse(c.args) : c.args; file = j.path || j.file || j.file_path || ''; oldText = j.old_text || j.old_str || j.old_string || ''; newText = j.new_text || j.new_str || j.new_string || '' } catch {}
        L.edits.push({ round, file, oldText: String(oldText).slice(0, 220), newText: String(newText).slice(0, 220), result: res, verifiedBy: null })
      } else {
        L.calls.push({ round, name: c.name, args: a.length > 160 ? a.slice(0, 160) + '…' : a, result: res })
        for (const e of L.edits) if (e.round <= round && !e.verifiedBy && (e.round < round || calls.indexOf(c) > calls.findIndex((x) => /edit/i.test(x.name)))) e.verifiedBy = { round, args: a.length > 100 ? a.slice(0, 100) + '…' : a, result: res }
      }
    })
    // 稿里写了三元组但这一轮没真的 edit ⇒ 记为「提议」
    if (d) for (const t of d.matchAll(TRIPLE_RE)) { if (!L.edits.some((e) => e.oldText && t[1].includes(e.oldText.trim()))) L.edits.push({ round, file: '', oldText: t[1], newText: t[2], result: '', proposed: true, verifiedBy: null }); break }
  }
  L.rounds = round
  L.edits = L.edits.filter((e) => !e.proposed || !L.edits.some((x) => !x.proposed && x.oldText && e.oldText.includes(x.oldText.trim())))
  L.lines = L.lines.filter((l) => !L.edits.some((e) => (e.oldText && (l.text.includes(e.oldText.trim()) || e.oldText.includes(l.text))) || (e.newText && (l.text.includes(e.newText.trim()) || e.newText.includes(l.text)))))
  L.lines = [...L.lines.filter((l) => l.via), ...L.lines.filter((l) => !l.via)].slice(0, 3)
  return L
}
/**
 * v12.9.2：延续段由程序写（理论 S10.19）。第 t 轮稿的「上一轮已定 / 状态 / 仍在依赖的事实 / 已排除 / 未解 / 已走过的路」全部可从台账推出，
 *   此前让副模型抄一遍：多花 300–500 字、还是抄样例排除项（「换连接池重试」）与编状态的来源。程序写 = 逐字、确定、零副模型成本。
 *   返回一段散文（Agent 本人口吻）；没有前几轮或台账为空时返回空串。
 */
export function continuationText(messages, opts = {}) {
  const L = buildLedger(messages)
  if (!L.rounds || (!L.decided.length && !L.edits.length && !L.calls.length && !L.excluded.length)) return ''
  const pathMode = opts && opts.path === 'bounded' ? 'bounded' : 'full'
  const S = []
  const dec = L.decided[L.decided.length - 1]
  const lastEdit = L.edits[L.edits.length - 1]
  const trip = (e) => `old_text \`${e.oldText}\` → new_text \`${e.newText}\``
  if (dec) {
    const body = dec.text.replace(/^改法只落一个[：:]\s*/, '').replace(/[，,]?\s*落点已经在手[。！]?$/, '').replace(/[。！？]$/, '')
    let status = '还没有改法落地'
    if (lastEdit && lastEdit.proposed) status = `提议、未执行（${trip(lastEdit)}）`
    else if (lastEdit) status = `已改（edit_file ${lastEdit.file || ''}，${trip(lastEdit)}，结果 ${lastEdit.result || '未知'}）` + (lastEdit.verifiedBy ? `，其后跑过 \`${lastEdit.verifiedBy.args}\` → 「${lastEdit.verifiedBy.result || '（无输出）'}」，验收结果待判` : '，其后没有跑过任何验收，状态是已改未验证')
    S.push(`上一轮已定：${body}（第 ${dec.round} 轮）；状态：${status}。`)
  } else if (lastEdit) {
    S.push(lastEdit.proposed ? `上一轮提议、未执行：${trip(lastEdit)}。` : `上一轮已改：edit_file ${lastEdit.file || ''}，${trip(lastEdit)}（结果 ${lastEdit.result || '未知'}）` + (lastEdit.verifiedBy ? `，其后跑过 \`${lastEdit.verifiedBy.args}\` → 「${lastEdit.verifiedBy.result || '（无输出）'}」，验收结果待判。` : '，其后没有跑过任何验收，状态是已改未验证。'))
  }
  if (L.lines.length) {
    const byRound = [...new Set(L.lines.map((l) => l.round))].join('、')
    S.push(`仍在依赖的事实：${L.lines.map((l) => '`' + l.text + '`' + (l.via ? `（${l.via}）` : '')).join('、')}——第 ${byRound} 轮稿里逐字引用的行，本轮输出里不会再出现，出处仍有效。`)
  }
  if (L.excluded.length) S.push(`已排除：${L.excluded.map((x) => x.text.replace(/[。！？]$/, '') + `（第 ${x.round} 轮）`).join('；')}。`)
  if (L.open.length) S.push(`未解：${L.open.map((x) => x.text.replace(/^\s*(?:未解|待解|未定)[：:]\s*/, '').replace(/[。！？]$/, '')).join('；')}。`)
  if (L.calls.length) S.push(pathMode === 'bounded' ? boundedPathText(L) : `已走过的路：${L.calls.map((c) => `第 ${c.round} 轮 ${c.name} \`${c.args}\` → 「${c.result || '（无输出）'}」`).join('；')}；这些不再重跑，除非中间改过东西。`)
  return S.join('')
}
/**
 * v14.12.3（F6，有界的「已走过的路」）：full 模式把每一条历史调用连参数带结果首行全列出来，长度随调用数无界增长、每压一轮都原样进稿
 *   —— t8 perf-regression 第 6 轮实测：程序部件 ≈699 tokens = 原文 1143 tokens 的 61%，标准长度的手写稿（585 tokens）拼上它就过不了
 *   birthAccept 的 no-token-gain（估算 1192 > 1143）⇒ 压缩在探索重的轮次结构性失败；而它要防的「重复命令」在 29+4 条轨迹里全部为 0。
 *   bounded：最近两轮的调用保留原样（参数 ≤100 字、结果 ≤40 字），更早的按「工具 + 命令头」归并计数（ls×3、cat×2 …），整段 ≤ 600 字。
 *   缺省仍是 full（被测对象不变）；bounded 经 policy.config.continuationPath 或 cfg.continuationPath 启用，由模式 3 的证据决定是否转正。
 */
export const CONTINUATION_PATH_MODES = Object.freeze(['full', 'bounded', 'none'])
export function boundedPathText(L, { recentRounds = 2, maxChars = 600 } = {}) {
  const calls = L.calls || []
  if (!calls.length) return ''
  const cutoff = (L.rounds || 0) - recentRounds + 1
  const recent = calls.filter((c) => c.round >= cutoff), older = calls.filter((c) => c.round < cutoff)
  const headOf = (c) => {
    let a = String(c.args || '').replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').trim()
    const m = a.match(/^([A-Za-z0-9_.\/-]+)/)
    return m ? m[1].replace(/^.*\//, '') : (a.slice(0, 12) || c.name)
  }
  const parts = []
  if (older.length) {
    const byName = new Map()
    for (const c of older) { const k = c.name || '?'; if (!byName.has(k)) byName.set(k, new Map()); const h = byName.get(k); const hd = headOf(c); h.set(hd, (h.get(hd) || 0) + 1) }
    const rounds = [...new Set(older.map((c) => c.round))].sort((a, b) => a - b)
    const span = rounds.length > 1 ? `第 ${rounds[0]}–${rounds[rounds.length - 1]} 轮` : `第 ${rounds[0]} 轮`
    const fam = [...byName.entries()].map(([name, h]) => `${name}×${[...h.values()].reduce((a, b) => a + b, 0)}（${[...h.entries()].map(([hd, n]) => (n > 1 ? `${hd}×${n}` : hd)).join('、')}）`).join('，')
    parts.push(`${span}已跑 ${older.length} 条：${fam}`)
  }
  const clipArgs = (a, n) => (a.length > n ? a.slice(0, n) + '…' : a)
  const clipRes = (r) => { const t = String(r || '（无输出）'); return t.length > 40 ? t.slice(0, 40) + '…' : t }
  let argMax = 100
  let recentText = () => recent.map((c) => `第 ${c.round} 轮 ${c.name} \`${clipArgs(c.args, argMax)}\` → 「${clipRes(c.result)}」`).join('；')
  let out = `已走过的路：${[...parts, recentText()].filter(Boolean).join('；')}；这些不再重跑，除非中间改过东西。`
  if (out.length > maxChars) { argMax = 60; out = `已走过的路：${[...parts, recentText()].filter(Boolean).join('；')}；这些不再重跑，除非中间改过东西。` }
  return out
}
/** 【延续段】块（放进 compressCtx 的台账之后；compileV4Direct 会把这段散文原样接在稿的开头） */
export function continuationBlock(messages, opts = {}) {
  if (opts && opts.path === 'none') return ''   // v14.12.4：不写延续段（制度候选 / v12.9.1 以前的形态）；台账照旧
  const t = continuationText(messages, opts)
  if (!t) return ''
  return '【延续段】（程序按台账写好的稿首段，会原样放在稿的开头；你从「本轮增量」写起，不要重写它、不要与它矛盾）\n' + t
}
/** 【台账】块（放进 compressCtx 的开头、工具结果之前；没有前几轮时返回空串） */
export function ledgerBlock(messages) {
  const L = buildLedger(messages)
  if (!L.rounds || (!L.decided.length && !L.edits.length && !L.calls.length && !L.excluded.length)) return ''
  const lines = []
  for (const x of L.decided) lines.push(`- 第 ${x.round} 轮已定：${x.text}`)
  for (const e of L.edits) {
    if (e.proposed) { lines.push(`- 第 ${e.round} 轮提议（未执行）：old_text \`${e.oldText}\` → new_text \`${e.newText}\`；状态：提议`); continue }
    const v = e.verifiedBy ? `；其后跑过 ${e.verifiedBy.args} → 「${e.verifiedBy.result || '（无输出）'}」` : '；其后没有跑过任何验收'
    lines.push(`- 第 ${e.round} 轮已改：edit_file ${e.file || ''}，old_text \`${e.oldText}\` → new_text \`${e.newText}\`（结果：${e.result || '未知'}）${v}；状态：${e.verifiedBy ? '已改，验收结果待判' : '已改未验证'}`)
  }
  if (L.excluded.length) lines.push('- 已排除：' + L.excluded.map((x) => `${x.text}（第 ${x.round} 轮）`).join('；'))
  if (L.accept.length) lines.push('- 上一轮写下的验收：' + L.accept.map((x) => x.text).join('；'))
  if (L.open.length) lines.push('- 未解：' + L.open.map((x) => x.text.replace(/^\s*(?:未解|待解|未定)[：:]\s*/, '')).join('；'))
  if (L.calls.length) lines.push('- 已走过的路：' + L.calls.map((c) => `第 ${c.round} 轮 ${c.name} \`${c.args}\` → 「${c.result || '（无输出）'}」`).join('；'))
  return '【台账】（程序从前几轮的稿与工具往来里逐字摘出；本轮稿的延续段只引用这里的条目、不重猜；已走过的路不重走，除非中间改过东西）\n' + lines.join('\n')
}

// ── 消息工具 ────────────────────────────────────────────────────────────────
/**
 * v12.8.1（不同宿主）：从出站请求的 tools 里认出「编辑文件」工具及其参数名，让稿里的可用句说宿主真实的工具名
 *（`edit_file` / `old_text` 是本仓库评测里的名字；Claude Code 是 str_replace_based_edit_tool 的 old_str/new_str，Codex 是 apply_patch……
 *  稿里写错名字，主模型就得自己换算，短思考时就回头 read）。认不出 ⇒ null（保留缺省词）。
 * 兼容 OpenAI 形（{type:'function',function:{name,parameters}}）与 Anthropic 形（{name,input_schema}）。
 * @returns {{ name: string, oldKey: string, newKey: string } | null}
 */
const OLD_KEYS = ['old_text', 'old_string', 'oldText', 'oldString', 'old_str', 'oldStr', 'search', 'target_text', 'original']
const NEW_KEYS = ['new_text', 'new_string', 'newText', 'newString', 'new_str', 'newStr', 'replace', 'replacement', 'replacement_text']
export function editToolOf(tools) {
  if (!Array.isArray(tools)) return null
  let fallback = null
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const fn = t.function && typeof t.function === 'object' ? t.function : t
    const name = String(fn.name || '')
    if (!name) continue
    const schema = fn.parameters || fn.input_schema || fn.inputSchema || null
    const props = schema && schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : []
    const oldKey = OLD_KEYS.find((k) => props.includes(k))
    const newKey = NEW_KEYS.find((k) => props.includes(k))
    if (oldKey && newKey) return { name, oldKey, newKey }
    // 名字像编辑工具但参数认不全（如 apply_patch 只有 input）：记为兜底，只换工具名
    if (!fallback && /(?:^|[_-])(?:edit|replace|patch)|str_replace|apply_diff/i.test(name) && !/read|list|search|grep/i.test(name)) fallback = { name, oldKey: 'old_text', newKey: 'new_text' }
  }
  return fallback
}

export function reasoningTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((b) => b && b.type === 'reasoning').map((b) => String(b.text || '')).join('\n')
}

/**
 * v11.10：llm-stream 的 role 序列做游程编码 —— 旧的逐条数组随会话长度线性增长、且每轮都写一次（trace 体积 O(n²)）。
 *   ['system','user','assistant','tool','tool','tool'] → 'system user assistant tool*3'
 * 非字符串 role 记为 '?'。
 */
export function rolesRunLength(msgs) {
  const out = []
  let prev = null, n = 0
  const flush = () => { if (n) out.push(n > 1 ? prev + '*' + n : prev) }
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const r = m && typeof m.role === 'string' && m.role ? m.role : '?'
    if (r === prev) { n++; continue }
    flush(); prev = r; n = 1
  }
  flush()
  return out.join(' ')
}

/** v11.10：只列出 reasoning 非空的消息 [下标, 字符数]（绝大多数消息为 0，逐条数组纯属噪声）。 */
export function sparseLengths(lengths) {
  const out = []
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) out.push([i, lengths[i]])
  return out
}

/**
 * v11.13（docs/analysis/RESEARCH-PERFORMANCE.md P5）：句柄回取观测 —— 只数，不记内容，绝不改任何消息。
 *   handles   = 出站 reasoning 里出现的不同 art:// 句柄数（v3 句柄）
 *   handleLines = reasoning 含 art:// 的 assistant 消息数
 *   toolCalls = 参数里含 art:// 的工具调用条数（m.tool_calls[] 或 type 形如 tool-call / tool_use 的内容块）
 *   retrieved = 既出现在 reasoning、又出现在某次工具调用参数里的不同句柄数（= 模型真的回取过的句柄）
 * 计数是**本次请求的出站消息累计值**（历史每轮重发），跨请求取最大值即可；同一 trace 里混有多个会话时须按会话分。
 * 目的：句柄回取率长期为 0 ⇒ 句柄行只是噪声，可考虑去掉；回取频繁 ⇒ 压缩删掉了模型需要的东西。
 */
const RE_ART = /art:\/\/[A-Za-z0-9_-]{22}/g
const RE_TOOL_CALL_TYPE = /tool[-_]?(call|use)/i
export function artRefsOf(msgs) {
  const inReasoning = new Set()
  const inCalls = new Set()
  let handleLines = 0, toolCalls = 0
  const scan = (text, into) => { const m = String(text || '').match(RE_ART); if (m) for (const h of m) into.add(h); return !!m }
  const json = (x) => { try { return JSON.stringify(x) || '' } catch { return '' } }
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'assistant' && scan(reasoningTextOf(m), inReasoning)) handleLines++
    const calls = []
    if (Array.isArray(m.tool_calls)) calls.push(...m.tool_calls)
    if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b.type === 'string' && RE_TOOL_CALL_TYPE.test(b.type)) calls.push(b)
    for (const c of calls) if (scan(json(c), inCalls)) toolCalls++
  }
  let retrieved = 0
  for (const h of inCalls) if (inReasoning.has(h)) retrieved++
  return { handles: inReasoning.size, handleLines, toolCalls, retrieved }
}

/**
 * v11.11（从 plugin.js 抽出）：llm-stream trace 的内容 —— 出站消息溯源，只读，绝不改任何消息。
 * @param {{ n: number, options: any, session: any, previewChars?: number }} o
 */
export function streamProvenanceRecord({ n, options, session, previewChars }) {
  const msgs = (options && options.messages) || []
  // ★ 2026-09-21 消息溯源（外部审计 P0-3）：只观测，绝不删/改/合并任何消息。
  //   判据是"来源与时间线"，不是"role 数了几个"。
  const prov = provenanceOf(msgs, { previewChars })
  // ★ 建立"出站消息 → 源事件 seq"的链条（只读；不改任何事件）
  const seqMap = mapMessagesToSeqs(session, msgs.length)
  // ★ 2026-09-21 守住最危险的假阳性（外部审计）：**数量不一致时绝不按下标硬配** ——
  //   错位的 seq 比没有 seq 更糟，它会让人顺着错误的链条得出结论。
  //   只有 note==='aligned' 才写 seq；否则整批不写，只留 note 说明原因。
  if (seqMap.map && seqMap.note === 'aligned') {
    for (let i = 0; i < prov.items.length; i++) prov.items[i].seq = seqMap.map[i]
  }
  return {
    n,
    model: options && options.model,
    provider: options && options.provider,
    messageCount: msgs.length,
    // v11.10：游程编码 + 稀疏列表（旧的逐条数组让 trace 随会话长度平方增长）
    roles: rolesRunLength(msgs),
    reasoningChars: sparseLengths(msgs.map((m) => reasoningTextOf(m).length)),
    // 连续同 role 的游程（只报 n>1）
    runs: prov.runs,
    // 末尾若干条的溯源（看板 / 人类 user 开头 / 长度）
    tail: prov.items.slice(-8),
    // 开头一段（连续 user 游程所在），用于追溯注入来源
    head8: prov.items.slice(0, 8),
    seqMapNote: seqMap.note,
    seqMapCount: seqMap.count, seqMapExpected: seqMap.expected,
    ledgerCount: prov.items.filter((x) => x.isLedger).length,
    toolResultCount: prov.items.filter((x) => x.blockTypes && x.blockTypes.includes('tool-result')).length,
    userCount: prov.items.filter((x) => x.role === 'user').length,
    assistantCount: prov.items.filter((x) => x.role === 'assistant').length,
    // v11.13 句柄回取观测（只数不记内容）
    artRefs: artRefsOf(msgs),
  }
}

export const __ledgerInternals = Object.freeze({ sentenceMatches, LEDGER_ACCEPT_RE, LEDGER_OPEN_RE, LEDGER_REJECT_RE, LEDGER_ACCEPT_KW, LEDGER_OPEN_KW, LEDGER_REJECT_KW })   // v14.10：仅供等价性测试
