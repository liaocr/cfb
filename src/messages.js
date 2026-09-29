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
  const isToolResultMsg = (m) => !!m && (m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.some(isToolResultBlock)))
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
  if (!userPart && !entries.length) return ''
  // 超总预算：先丢最旧的结果（最近的观察才是当前分支要绑的落点）
  const size = (parts) => parts.reduce((n, p) => n + p.length + 2, userPart.length)
  while (entries.length && size(entries) > maxChars) entries.shift()
  const out = [userPart, ...entries].filter(Boolean).join('\n\n')
  return out.length > maxChars ? out.slice(0, maxChars) : out
}

// ── 消息工具 ────────────────────────────────────────────────────────────────
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
