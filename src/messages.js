// dsh-cot-form-b / messages.js —— 出站消息的只读工具（纯函数，绝不修改消息）
//
//   provenanceOf       最终请求里每条消息的来源画像（看板 / 人类 user / 工具结果），只观测
//   mapMessagesToSeqs  出站消息 → 源事件 seq 的映射；数量对不上时整批不写（错位比缺失更糟）
//   textOfContent / reasoningTextOf  content 双兼容取文本 / 取 reasoning 块文本
import { LEDGER_OPEN } from './emitter.js'

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
  }
}
