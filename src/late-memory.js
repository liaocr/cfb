// dsh-cot-form-b / late-memory.js —— 迟到结果暂存区（Deferred Claim，实验，缺省关）
//
// 没赶上 finish 收网的压缩结果在这里暂存（进程内、按 会话+分支 隔离、容量与 TTL 有界），
// 下一轮 pre-step 由 plugin.js 认领：要求【全覆盖】—— 本消息每个推理块都有就绪结果且逐字拼回原文；
// 先 peek，只有发射成功才 acknowledge。已知缺陷 B（多块匹配）见 docs/AUDIT-V11.5.md §四。
import { normalizeBranchId } from './snapshot-store.js'
import { renderCheckpoint } from './state-memory.js'

// ════════════════════════════════════════════════════════════════════════════
// ★★ 方案二：迟到结果暂存（2026-09-21 用户令）★★
//
// 背景（实测）：`birth-fired → birth-finish-enter` 的 gapMs 只有 **4 / 5 / 23 ms**，
//   即「推理块结束」与「流结束」几乎同时发生 ⇒ **distill 没有任何预热余地**。
//   所以旧结构只有两种结局：在 finishWaitMs 内跑完（替换），或干等到底（原文）。
//   用户令：**不加预算，但要减少实际等待。**
//
// 做法：零等待放行原文（finishWaitMs<=0），distill 继续在后台跑完；
//   其结果**不再丢弃**，而是暂存，在**下一次请求**的信封里作为 priorMemory 进入模型输入。
//   ⇒ 实际等待 = 0；压缩从下一轮生效。
//
// ⚠ 铁律不变：只暂存**成功**的结果；失败/取消一律不存（绝不把半成品当记忆）。
// ⚠ 一旦被某个信封消费就移除，绝不重复注入（防止同一结论反复占位）。
// 按 sessionId + branchId 隔离；相同 raw 不证明相同源任务。
// ════════════════════════════════════════════════════════════════════════════
// ⚠ 按【原始推理文本】索引 —— 收网器只能从 assistant 事件里拿到 raw 文本，
//   没有可靠宿主消息 ID；raw 仅用于候选匹配，已知歧义必须拒绝。
export const lateMemory = new Map()      // JSON([sessionId, branchId]) -> bounded records
export const lateKey = (sid, opts = {}) => JSON.stringify([String(sid), normalizeBranchId(opts.branchId)])
const LATE_MEMORY_KEYS_MAX = 128
const LATE_MEMORY_BYTES_MAX = 8 * 1024 * 1024
const LATE_MEMORY_ITEM_BYTES_MAX = 256 * 1024
const LATE_MEMORY_MAX = 8         // 每个会话最多暂存 8 个块，防止无界增长
// ★ 过期清理：放行后继续跑的任务不等于无限保留。超过 TTL 的结果一律丢弃，
//   绝不把十分钟前的旧状态当成「当前记忆」注入。
const LATE_MEMORY_TTL_MS = 10 * 60 * 1000

/** 丢弃过期项。就地修改，纯本地。 */
function pruneLateMemory(q) {
  if (!q || !q.length) return
  const now = Date.now()
  for (let i = q.length - 1; i >= 0; i--) if (now - q[i].at > LATE_MEMORY_TTL_MS) q.splice(i, 1)
}

/** 暂存一个「没赶上自己那块」的编译结果。纯内存、绝不抛错。 */
export function pushLateMemory(sessionId, raw, entries, board, opts = {}) {
  try {
    if (sessionId == null || typeof raw !== 'string' || !raw) return false
    if (!Array.isArray(entries) || !entries.length) return false
    for (const [key, queue] of lateMemory) {
      pruneLateMemory(queue)
      if (!queue.length) lateMemory.delete(key)
    }
    const key = lateKey(sessionId, opts)
    let q = lateMemory.get(key)
    if (!q && lateMemory.size >= LATE_MEMORY_KEYS_MAX) return false
    if (!q) { q = []; lateMemory.set(key, q) }
    const taskId = opts.taskId == null ? null : String(opts.taskId)
    const at = taskId == null ? -1 : q.findIndex(x => x.taskId === taskId && x.raw === raw)
    const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
    const encoded = JSON.stringify(entries)
    const bytes = Buffer.byteLength(raw) + Buffer.byteLength(encoded) + Buffer.byteLength(String(board || ''))
    const used = [...lateMemory.values()].reduce((n, queue) => n + queue.reduce((m, x) => m + (x.bytes || 0), 0), 0)
    if (bytes > LATE_MEMORY_ITEM_BYTES_MAX || used - (at >= 0 ? q[at].bytes || 0 : 0) + bytes > LATE_MEMORY_BYTES_MAX) {
      if (!q.length) lateMemory.delete(key)
      return false
    }
    const safeEntries = freeze(JSON.parse(encoded))
    const item = { at: Date.now(), bytes, raw, taskId, entries: safeEntries, board: board == null ? null : String(board), chars: String(board || '').length }
    if (at >= 0) { item.ambiguous = q[at].ambiguous; q[at] = item }
    else {
      // Raw equality is not source identity. Keep a poison marker even if a
      // colliding candidate is later evicted by the capacity bound.
      for (const old of q) if (old.raw === raw) { old.ambiguous = true; item.ambiguous = true }
      q.push(item)
    }
    while (q.length > LATE_MEMORY_MAX) q.shift()
    return true
  } catch { return false }
}

// ⚠ 键匹配的坑（2026-09-21 实测发现）：
//   起火处（birthStart）拿的是 entry.text —— **单个** reasoning 块的文本；
//   收网处（pre-step）拿的是 reasoningTextOf(message) —— 把**所有** reasoning 块
//   用 '\n' 拼起来。单块时两者逐字相同；**多块时永远对不上 ⇒ 收网静默永不触发**。
//   长度下限 64 字符：短文本互相包含的概率太高，宁可漏收也不许张冠李戴。
const LATE_MATCH_MIN = 64

/** needle 是否以【整段】形式出现在 hay 里（段 = 被 '\n' 分隔的连续区间）。 */
function segmentAligned(hay, needle) {
  let i = hay.indexOf(needle)
  while (i >= 0) {
    const before = i === 0 || hay.charCodeAt(i - 1) === 10
    const j = i + needle.length
    const after = j === hay.length || hay.charCodeAt(j) === 10
    if (before && after) return true
    i = hay.indexOf(needle, i + 1)
  }
  return false
}

/**
 * ★★ 全覆盖匹配（2026-09-22）★★
 *
 * 为什么必须要求「全覆盖」而不是「找到一条」：
 *   收网用一条 ledger 替换**整条** assistant 消息的推理。而暂存的是**块级**结果。
 *   若一条消息有多个推理块、只有部分块就绪，就贸然收网 ⇒ **未就绪块的推理凭空消失**。
 *   这正是 emitter.js 里那条「信息不丢硬闸」在推理侧的对偶要求。
 *
 * 判据（全部满足才算匹配）：
 *   ① 把命中的各条按其在 fullRaw 中的位置升序排列；
 *   ② 首条必须从位置 0 开始，且各条**首尾相接、互不重叠**（间隔恰好一个 '\n'）；
 *   ③ 拼起来必须与 fullRaw **逐字相等**。
 * 任一条不满足 ⇒ 返回 null（不认领、**也不消费**，留待下轮或过期）。
 *
 * 同文多个任务被显式标为 ambiguous，包含容量淘汰后的存活项；不取第一个。
 *
 * @returns { idxs } 命中下标（升序）或 null
 */
function coverageMatch(q, fullRaw) {
  if (typeof fullRaw !== 'string' || !fullRaw) return null
  const idxs = []
  const exact = q.map((x, i) => ({ x, i })).filter(({ x }) => x.raw === fullRaw)
  if (exact.length) return exact.length === 1 && !exact[0].x.ambiguous ? { idxs: [exact[0].i] } : null
  for (let i = 0; i < q.length; i++) {
    const a = q[i].raw
    // ① 逐字相同 ⇒ 单块即全覆盖（生产 583/583 都是这一支）
    if (a.length >= LATE_MATCH_MIN && segmentAligned(fullRaw, a)) {
      if (q[i].ambiguous) return null
      idxs.push(i)
    }
  }
  if (!idxs.length) return null
  // ② 按在 fullRaw 中的出现位置升序
  const withPos = idxs.map((i) => ({ i, p: fullRaw.indexOf(q[i].raw) }))
  withPos.sort((x, y) => x.p - y.p)
  // ③ 首尾相接校验（cursor 必须严格推进，且最终恰好覆盖 fullRaw）
  let cursor = 0
  for (const x of withPos) {
    if (x.p !== cursor) return null
    cursor += q[x.i].raw.length + 1
  }
  if (cursor - 1 !== fullRaw.length) return null
  return { idxs: withPos.map((x) => x.i) }
}

/**
 * 诊断：为什么这段 fullRaw 认领不了。纯只读，供 trace 用（"积压"与"丢弃"在漏斗里必须能区分）。
 * @returns 'empty' | 'no-candidate' | 'ambiguous' | 'partial-coverage' | 'ok'
 */
// ★ 放行但尚未有结果的块（in-flight）：no-candidate 时区分「编译还在飞」与「根本没这条记录」
const lateInFlight = new Map()   // lateKey -> Map(taskId -> { at, rawChars })
const LATE_INFLIGHT_MAX = 32
export function noteLateInFlight(sessionId, taskId, rawChars, opts = {}) {
  if (sessionId == null || taskId == null) return
  const key = lateKey(sessionId, opts)
  let m = lateInFlight.get(key)
  if (!m) { if (lateInFlight.size >= LATE_MEMORY_KEYS_MAX) return; m = new Map(); lateInFlight.set(key, m) }
  m.set(String(taskId), { at: Date.now(), rawChars })
  while (m.size > LATE_INFLIGHT_MAX) m.delete(m.keys().next().value)
}
export function settleLateInFlight(sessionId, taskId, opts = {}) {
  const m = lateInFlight.get(lateKey(sessionId, opts))
  if (!m) return
  m.delete(String(taskId))
  if (!m.size) lateInFlight.delete(lateKey(sessionId, opts))
}
export function lateInFlightCount(sessionId, opts = {}) {
  const m = lateInFlight.get(lateKey(sessionId, opts))
  if (!m) return 0
  const now = Date.now()
  for (const [k, v] of m) if (now - v.at > LATE_MEMORY_TTL_MS) m.delete(k)
  return m.size
}

export function explainLateMiss(sessionId, fullRaw, opts = {}) {
  try {
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return 'empty'
    if (coverageMatch(q, fullRaw)) return 'ok'
    const cands = q.filter(x => x.raw === fullRaw || (x.raw.length >= LATE_MATCH_MIN && segmentAligned(fullRaw, x.raw)))
    if (!cands.length) return 'no-candidate'
    if (cands.some(x => x.ambiguous)) return 'ambiguous'
    return 'partial-coverage'
  } catch { return 'no-candidate' }
}

/**
 * ★ 混合认领（opt-in：cfg.lateClaimPartial=true）。全覆盖失败时，把 fullRaw 按 '\n' 切段，
 *   已就绪的块用其摘要、其余段**逐字保留原文**，拼成一份文本。
 *   保证：① 只用非歧义、整段对齐的候选；② 未命中的原文一个字不丢；③ 至少命中 1 块才返回；
 *        ④ 回执只包含真正用到的记录（ack 时只消费这些）。
 *   全覆盖可用时**不走这里**（调用方先 peek）。默认关闭，因为它改变了「绝不部分认领」的既有铁律。
 */
export function peekLateMemoryPartial(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null || typeof fullRaw !== 'string' || !fullRaw) return null
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const hits = []
    for (const x of q) {
      if (x.ambiguous || x.raw.length < LATE_MATCH_MIN || !segmentAligned(fullRaw, x.raw)) continue
      const p = fullRaw.indexOf(x.raw)
      if (p < 0) continue
      hits.push({ x, p, e: p + x.raw.length })
    }
    if (!hits.length) return null
    hits.sort((a, b) => a.p - b.p)
    // 去重叠：按位置贪心，只保留互不重叠的命中
    const used = []
    let cursor = 0
    for (const h of hits) { if (h.p >= cursor) { used.push(h); cursor = h.e } }
    let text = '', pos = 0, replacedChars = 0
    for (const h of used) {
      if (h.p > pos) text += fullRaw.slice(pos, h.p)
      const board = String(h.x.board || '').trim() || renderCheckpoint(h.x.entries)
      if (!board) { text += fullRaw.slice(h.p, h.e); pos = h.e; continue }
      text += board; replacedChars += h.x.raw.length; pos = h.e
    }
    if (pos < fullRaw.length) text += fullRaw.slice(pos)
    if (!replacedChars) return null
    const receipt = used.map(h => h.x)
    return { count: receipt.length, receipt, texts: [text], entries: receipt.reduce((a, x) => a.concat(x.entries), []),
      partial: true, replacedChars, keptChars: fullRaw.length - replacedChars }
  } catch { return null }
}

/** 只查不取。找到返回 { texts, count, entries }，否则 null。 */
export function peekLateMemory(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null) return null
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const m = coverageMatch(q, fullRaw)
    if (!m) return null
    return {
      count: m.idxs.length,
      receipt: m.idxs.map((i) => q[i]),
      texts: m.idxs.map((i) => q[i].board).filter((t) => t && String(t).trim()),
      entries: m.idxs.reduce((acc, i) => acc.concat(q[i].entries), []),
    }
  } catch { return null }
}

/**
 * ★★ 认领（消费即移除，绝不重复收网）★★
 * 只有【全覆盖】时才消费；否则原样保留、返回 null。
 */
export function claimLateMemory(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null) return null
    const key = lateKey(sessionId, opts)
    const q = lateMemory.get(key)
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const m = coverageMatch(q, fullRaw)
    if (!m) return null
    const picked = m.idxs.map((i) => q[i])
    // 从后往前删，避免下标位移
    for (const i of [...m.idxs].sort((a, b) => b - a)) q.splice(i, 1)
    return {
      count: picked.length,
      texts: picked.map((x) => x.board).filter((t) => t && String(t).trim()),
      entries: picked.reduce((acc, x) => acc.concat(x.entries), []),
    }
  } catch { return null }
}

/** Acknowledge only the exact records that were successfully emitted.
 * New arrivals/replacements while archive awaits must never be consumed. */
export function lateReceiptValid(sessionId, receipt, opts = {}) {
  const q = lateMemory.get(lateKey(sessionId, opts))
  if (!q || !Array.isArray(receipt) || !receipt.length) return false
  pruneLateMemory(q)
  return receipt.every(item => q.includes(item) && !item.ambiguous)
}

export function acknowledgeLateMemory(sessionId, receipt, opts = {}) {
  const key = lateKey(sessionId, opts)
  const q = lateMemory.get(key)
  if (!q || !Array.isArray(receipt)) return 0
  const items = new Set(receipt)
  let removed = 0
  for (let i = q.length - 1; i >= 0; i--) {
    if (items.has(q[i])) { q.splice(i, 1); removed++ }
  }
  if (!q.length) lateMemory.delete(key)
  return removed
}

/** 兼容旧名：等价于 claimLateMemory，返回单条形状（自测与旧调用点用）。 */
export function takeLateMemory(sessionId, fullRaw, opts = {}) {
  const c = claimLateMemory(sessionId, fullRaw, opts)
  if (!c || !c.texts.length) return null
  return { board: c.texts.join('\n\n'), entries: c.entries, count: c.count }
}

/** 仅供自测/快速路径：观察暂存量，不消费（先清过期）。 */
export function lateMemorySize(sessionId, opts = {}) {
  try {
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q) return 0
    pruneLateMemory(q)
    return q.length
  } catch { return 0 }
}
