// dsh-cot-form-b / evidence.js —— 从宿主会话采集证据（只读，绝不改事件）
//
//   evidenceIndex         规范事件索引：按 surface 视图身份失效重建，未变的事件复用
//   collectEvidence       近期窗口（缺省 60 节点）+ 可选跨窗口结构性节点（stateStructuralFirst，缺省关）
//   filterCoveredTools    已被快照覆盖的旧工具证据不再重发（保留最近 COVER_TAIL_FLOOR 条）
//   fullyVisibleResultSeqs  只有完整可见的终态结果才能获得「可省略」资格
import {
  normalizeEvidenceEvent, SOURCE, LEDGER_MARKERS, RUNTIME_MARKERS, assembleEvidence,
} from './state-memory.js'

/**
 * ★★ 证据索引（2026-09-21 运行效率）★★
 *
 * 每个 reasoning block 都重扫全部 session 是真实成本。这里维护**只读轻量索引**：
 *   seq → 事件位置 ｜ toolCallId → { 调用, 结果 } ｜ 已确认来源的用户要求
 * 每块只装配相关证据。**少装配相关对象，比复制整段历史再冻结更有效。**
 *
 * 索引按 (session, 节点数) 失效重建；节点数不变即复用。
 */
// ════════════════════════════════════════════════════════════════════════
// ★★ 证据层（2026-09-21 收敛：唯一解释出口）★★
// ════════════════════════════════════════════════════════════════════════
//
// 曾经的问题：索引路径与回退扫描**各自解释「事件是什么」**，同一段会话在不同
// 运行条件下会形成不同证据（T28 就是这样抓到 tool/result 被漏掉的）。
//
// 现在：所有路径都必须经过 normalizeEvidenceEvent()，索引只负责「更快找到事件」。
//
// 缓存身份分两个概念（外部评审）：
//   · 原始事件索引 —— 按**日志追加位置**增量维护（append-only 允许只处理新增）
//   · 当前 surface 视图 —— 按宿主 surface 版本/长度单独判定
//     因为替换前后节点数可能相同，仅凭节点数无法识别 surface 内容变化。
const evidenceIndexCache = new WeakMap()

/**
 * 建立/复用规范事件索引。
 * @param {object} session
 * @returns {{events:Array, bySeq:Map, nodeKey:string, logLen:number}|null}
 */
export function evidenceIndex(session) {
  if (!session) return null
  let nodes = []
  try { nodes = Array.isArray(session.surface && session.surface.nodes) ? session.surface.nodes : [] } catch { nodes = [] }
  // ★ surface 视图身份：节点数 + 首尾节点 + 替换代数（若能拿到）
  const gen = (() => { try { return session.surface && session.surface.replaceGeneration != null ? session.surface.replaceGeneration : null } catch { return null } })()
  const nodeKey = JSON.stringify(nodes) + ':' + (gen == null ? '-' : gen)
  const prev = evidenceIndexCache.get(session)
  if (prev && prev.nodeKey === nodeKey) return prev
  const events = []
  const bySeq = new Map()
  for (const seq of nodes) {
    // Session events are append-only; reuse surviving normalized events instead
    // of parsing all historical tool bodies on every new block.
    let ev = prev && prev.bySeq.get(seq)
    if (!ev) {
      let raw = null
      try { raw = session.eventAt(seq) } catch { raw = null }
      if (!raw) continue
      ev = normalizeEvidenceEvent(raw, seq)
    }
    if (!ev) continue
    bySeq.set(seq, ev)
    events.push(ev)
  }
  const idx = { events, bySeq, nodeKey, nodeCount: nodes.length }
  evidenceIndexCache.set(session, idx)
  return idx
}

// ════════════════════════════════════════════════════════════════════════
// ★★ 结构性上下文检索（2026-09-22，用户批准的 A 方案）★★
//
// 真机缺陷（176 节点会话，新构建 06:24 后实测）：
//   llm-stream 报 ledgerCount=3（三块看板确实在出站 payload 里）
//   但 state-envelope 报 priorMemory=0、cover=null
//   根因：collectEvidence 只取**最后 60 个节点**，看板早已滑出窗口
//         ⇒ 快照进不了输入 ⇒ 成对校验必然失败 ⇒ 过滤永不生效
//         ⇒ 全量 24.5k ⇒ 提纯超时 ⇒ 无新看板 ⇒ 自锁死循环。
//
// 修法：把采集拆成两路再合并 ——
//   路径一（本函数）：**跨窗口**找结构性节点（记忆快照／真实用户要求／运行时抬头）
//   路径二（下方 win）：沿用近期窗口，采 reasoning 与工具执行证据
//
// ⚠ 扫描范围扩大 ≠ 输入变多。路径一有**逐类上限**，且只取每类的**最新**若干条：
//   · 只取最新 1 份记忆快照 —— 绝不把全部历史看板捞回来（它们是全量快照，
//     最新那份已包含先前状态；将来若改为增量记忆，才需要额外取依赖链）。
//   · 只取最新 1 条运行时抬头 —— 旧运行状态不得重新挤进输入。
//   · 真实用户要求取最新若干条（要求及其后续修订都属于「目标与验收条件」）。
// ════════════════════════════════════════════════════════════════════════
const STRUCT_CAP = { ledger: 1, runtime: 1, user: 6 }
const STRUCT_LIMIT_DEFAULT = 12

/**
 * 判定一个规范事件是否属于「结构性上下文」。
 * 口径与 assembleEnvelopeParts 完全一致（human/generatedMemory/runtimeContext/runtime），
 * 来源未确认时再用结构化标头兜底 —— 绝不凭正文自称下结论。
 */
function structuralKindOf(e) {
  if (!e) return null
  const s = e.source
  const t = String(e.text || '')
  if (e.type === 'user/message') {
    if (s === SOURCE.human) return 'user'
    if (s === SOURCE.generatedMemory) return 'ledger'
    if (s === SOURCE.runtimeContext) return 'runtime'
    if (LEDGER_MARKERS.some((m) => t.includes(m))) return 'ledger'
    if (RUNTIME_MARKERS.some((m) => t.includes(m))) return 'runtime'
    return null
  }
  if (s === SOURCE.runtime) return 'runtime'
  return null
}

/**
 * ★★ 2026-09-21 证据采集（宿主集成层）★★
 *
 * 职责边界（刻意保持薄）：
 *   · 只**读** session，绝不改任何事件；
 *   · 来源按**原事件类型**判定，绝不用最终 role；
 *   · 先把宿主对象转成独立数据，再由 adaptEvidence 冻结 —— 杜绝共享引用破坏时间截面。
 *   · 索引与（无法建索引时的）回退扫描**共用同一个装配函数**，保证同样的事件得到同样的证据。
 *
 * @returns {{events:Array, inFlightIds:Set, cutSeq:number|null}}
 */
export function collectEvidence(session, opts = {}) {
  const empty = { events: [], inFlightIds: new Set(), cutSeq: null,
    coverage: { toolAssociation: 'unknown', userRequirements: 'unknown', omittedEvidence: true } }
  if (!session) return empty
  const limit = opts.limit == null ? 60 : opts.limit
  let nodes = []
  try { nodes = Array.isArray(session.surface && session.surface.nodes) ? session.surface.nodes : [] } catch { nodes = [] }
  if (!nodes.length) return empty
  const tail = nodes.slice(Math.max(0, nodes.length - limit))
  const inWindow = new Set(tail)
  // 路径一开关（回滚：stateStructuralFirst:false）
  // ⚠ 默认**关**（2026-09-22 用户裁定 A 暂不上线）：实测净负 +3711 字符。
  //   仅当显式传 { structural: true }（= cfg.stateStructuralFirst 打开）时才跨窗口取回。
  const structuralOn = opts.structural === true
  const structuralLimit = opts.structuralLimit == null ? STRUCT_LIMIT_DEFAULT : opts.structuralLimit
  // ① 取证据：优先走索引；索引不可用则**回退到同一规范化出口**（不是另一套解释）
  let all = null
  // v11.11：索引构建抛错（例如节点里有不可序列化的值）时走回退扫描 —— 此前这里没有保护，
  //   回退分支实际上不可达，而索引一抛整个采集就抛。观测层的失败只许降级，不许传染。
  let idx = null
  try { idx = evidenceIndex(session) } catch { idx = null }
  if (idx) all = idx.events
  if (!all) {
    all = []
    // ⚠ 路径一要跨窗口 ⇒ 无索引时也必须扫**全部节点**（倒序查找的等价物）。
    //   路径一关闭时保持旧行为（只扫窗口），不做无谓扫描。
    const scan = structuralOn ? nodes : tail
    for (const seq of scan) {
      let raw = null
      try { raw = session.eventAt(seq) } catch { raw = null }
      if (!raw) continue
      const ev = normalizeEvidenceEvent(raw, seq)
      if (ev) all.push(ev)
    }
  }
  // ② 路径二：窗口内事件（索引是全量的，回退本来就是窗口内的）
  const win = all.filter((e) => e.seq == null || inWindow.has(e.seq))
  // ②' 路径一：**跨窗口**结构性上下文（记忆快照／真实用户要求／运行时抬头）
  //     ⚠ 只从**窗口之外**取：窗口内本来就会带上，重复取没有意义。
  //     倒序遍历 = 优先取最新；逐类上限保证「扫描范围大」不等于「输入变多」。
  const structural = []
  if (structuralOn && structuralLimit > 0) {
    const used = { ledger: 0, runtime: 0, user: 0 }
    for (let i = all.length - 1; i >= 0 && structural.length < structuralLimit; i--) {
      const e = all[i]
      if (!e) continue
      if (e.seq != null && inWindow.has(e.seq)) continue
      const k = structuralKindOf(e)
      if (!k) continue
      if (used[k] >= (STRUCT_CAP[k] || 0)) continue
      used[k]++
      structural.push(e)
    }
    structural.reverse()   // 恢复时间顺序
  }
  // ③ 合并 + 按事件身份（seq）去重 ⇒ 再装配（唯一解释出口）
  const merged = []
  const seenSeq = new Set()
  for (const e of structural.concat(win)) {
    if (e.seq != null) { if (seenSeq.has(e.seq)) continue; seenSeq.add(e.seq) }
    merged.push(e)
  }
  const parts = assembleEvidence(merged, {})
  const evs = merged.slice()
  const cutSeq = tail.length ? tail[tail.length - 1] : null
  return {
    events: evs,
    inFlightIds: parts.inFlight,
    userAsks: parts.userAsks,
    tools: parts.tools,
    runtimeFacts: parts.runtimeFacts,
    unknownUserEvents: parts.unknownUserEvents,
    priorMemory: parts.priorMemory,
    cutSeq,
    // ★ 诊断：跨窗口取回了几条结构性节点（不进 coverage，避免被 adaptEvidence 收窄）
    structuralFetched: structural.length,
    structuralSeqs: structural.map((e) => e.seq),
    coverage: {
      toolAssociation: parts.inFlight.size === 0 ? 'complete' : 'partial',
      userRequirements: 'partial',
      windowEvents: merged.length,
      cutoff: cutSeq,
      omittedEvidence: nodes.length > tail.length,
    },
  }
}

/** Only a fully visible terminal result can acquire omission authority. */
export function fullyVisibleResultSeqs(tools) {
  return [...new Set((tools || []).filter(t => t && !t.resultTruncated && t.result != null &&
    ['completed', 'failed', 'cancelled'].includes(t.status) && Number.isSafeInteger(t.resultSeq) && t.resultSeq >= 0
  ).map(t => t.resultSeq))]
}

// ════════════════════════════════════════════════════════════════════════════
// ★★ 编译输入止血（2026-09-22，用户批准的第一轮）★★
//
// 真机实测（trace state-envelope，近 30 次）：
//   priorMemory 最大 = 1（219 次里只有 30 次 >0）  ← 回灌不是主因
//   toolBlockChars = 25366~28383                  ← 主体，且每轮几乎不变
//   toolLines = 28~29                             ← 每轮**全量重发**同一批工具证据
//
// 所以「旧状态反复进入输入」的真实形态不是看板回灌，而是：
//   一份状态快照已经把 E1..E28 编译进去了，下一轮又把 E1..E28 原样再喂一遍。
//
// 止血规则（保守、可回滚）：
//   · 只在**编译成功**时推进覆盖水位（失败/取消绝不推进 ⇒ 下轮仍能看到这些证据）。
//   · 只跳过**已覆盖的旧工具证据**；用户原话、runtime、pending 调用一律照旧全发。
//   · 每轮至少保留最近 N 条工具证据（tail floor），避免丢上下文。
//   · 覆盖水位按会话记录，绝不跨会话。
export const COVER_TAIL_FLOOR = 8      // 无论如何都保留的最近工具证据条数

/**
 * ★ 覆盖过滤（**纯函数**，导出以便自测与真机会话重放调用同一份实现）。
 *
 * 为什么必须导出：此前过滤逻辑内联在 birthStart 里，离线验证只能**手抄一份**，
 *   结果抄错了（改了 Object.freeze 的对象）而没被发现 —— 生产里一次都没生效。
 *   抽出纯函数后，验证与生产走的是同一份代码，这类错误不再可能。
 *
 * 规则：只跳过「结果已返回且**结果事件 seq** ≤ 水位」的旧证据；
 *   pending/running（无 resultSeq）一律保留；末尾 floor 条一律保留。
 * @returns {{tools:Array, info:{total,kept,dropped,savedChars}|null}}
 */
export function filterCoveredTools(tools, covered, floor) {
  const list = Array.isArray(tools) ? tools : []
  const f = floor == null ? COVER_TAIL_FLOOR : floor
  // 判据形态（2026-09-22 升级）：
  //   · Set / Array ⇒ **精确成员判定**（快照 coverage.coveredSeqs）。这是现在的生产形态。
  //     为什么必须用集合而不是水位线：水位线会连带跳过"没采集到"和"迟到返回"的结果，
  //     而它们的 resultSeq 根本不在集合里 ⇒ 集合判定天然只省略"确实已编译进去"的证据。
  //   · number ⇒ 旧水位线语义（s <= covered），保留以便回滚与既有自测继续有效。
  let has = null
  if (covered instanceof Set) has = (s) => covered.has(s)
  else if (Array.isArray(covered)) { const st = new Set(covered.map(Number)); has = (s) => st.has(s) }
  else if (typeof covered === 'number' && Number.isFinite(covered)) { const up = covered; has = (s) => s <= up }
  else return { tools: list, info: null }
  if (list.length <= f) return { tools: list, info: null }
  const keep = []
  let skipped = 0, saved = 0
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    // ⚠ 用 resultSeq 而非调用 seq：早先 pending 的调用后来返回结果时，
    //   其结果 seq 会大于调用 seq，用调用 seq 比较会把它误判成旧证据。
    const s = t && t.resultSeq != null ? Number(t.resultSeq) : null
    const isCovered = s != null && Number.isFinite(s) && has(s)
    const inFloor = i >= list.length - f
    if (isCovered && !inFloor) { skipped++; saved += String(t.result || '').length; continue }
    keep.push(t)
  }
  if (!skipped) return { tools: list, info: null }
  return { tools: Object.freeze(keep), info: { total: list.length, kept: keep.length, dropped: skipped, savedChars: saved } }
}
