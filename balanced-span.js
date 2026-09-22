/**
 * D1′ 平衡区间选择器（纯函数，零依赖）。
 *
 * 唯一职责：在一条线性表面序列上，为「要压缩的那条 assistant 消息」找出一个
 * **工具配对平衡的闭包区间** `[startSeq, endSeq]`；找不出来就返回 `null`。
 *
 * 为什么必须有它：官方引擎在 `dsh-compaction-basic:540/:541` 硬校验
 *   toolPairingBalancedBefore(session, nodes[startIdx])
 *   toolPairingBalancedAfter(session, nodes[endIdx])
 * 而 `dsh-compaction/lib/types/tool-pairing.js:33` 会对孤儿 tool/result 直接抛
 * 「corrupt surface」。单点替换一条带 tool-call 的 assistant 消息，必然踩中。
 *
 * 铁律：本模块**只做选择与校验**，不改任何状态；任何异常一律返回 null，
 * 由调用方按 D3′「保持原文」处理。绝不向外吐出会撕裂表面的非法区间。
 *
 * @module dsh-cot-form-b/balanced-span
 */

export const ASSISTANT_MESSAGE = 'assistant/message'
export const TOOL_RESULT = 'tool/result'

/** 从一条裸事件里数出 tool-call 块的数量（兼容会话原始形状）。 */
export function countToolCalls(event) {
  if (!event) return 0
  if (typeof event.toolCallCount === 'number' && Number.isFinite(event.toolCallCount)) {
    return Math.max(0, Math.trunc(event.toolCallCount))
  }
  const content = event.data && event.data.message && event.data.message.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) if (block && block.type === 'tool-call') n++
  return n
}

/**
 * 单事件对「进行中工具调用数」的增量。
 * 逐字对齐 dsh-compaction/lib/types/tool-pairing.js:9-18 的 eventDelta。
 */
export function eventDelta(event) {
  if (!event) return 0
  if (event.type === ASSISTANT_MESSAGE) return countToolCalls(event)
  if (event.type === TOOL_RESULT) return -1
  return 0
}

/** 每个事件之后的累计余额。 */
export function balanceAfterEach(events) {
  const out = new Array(events.length)
  let acc = 0
  for (let i = 0; i < events.length; i++) { acc += eventDelta(events[i]); out[i] = acc }
  return out
}

/** 切在索引 i 之前（即 i-1 之后）的余额；i<=0 时表面起点恒为 0。 */
export function balanceBefore(events, i) {
  if (i <= 0) return 0
  const bal = balanceAfterEach(events)
  return bal[i - 1]
}

/**
 * 对已选区间做独立复核（防御性，供发射器在 append 前再跑一次）。
 * @returns { ok: boolean, reason?: string }
 */
export function verifyBalancedSpan(events, span) {
  if (!span || !Number.isInteger(span.startIdx) || !Number.isInteger(span.endIdx)) {
    return { ok: false, reason: 'span-shape' }
  }
  const { startIdx: s, endIdx: e } = span
  if (s < 0 || e >= events.length || s > e) return { ok: false, reason: 'span-range' }

  const bal = balanceAfterEach(events)
  // ① 整个表面本身就不能是坏的（负余额 = 孤儿 tool/result）
  for (let i = 0; i < bal.length; i++) if (bal[i] < 0) return { ok: false, reason: 'surface-corrupt-neg' }
  // ② 起点之前的切点必须平衡
  if (s > 0 && bal[s - 1] !== 0) return { ok: false, reason: 'start-cut-unbalanced' }
  // ③ 终点之后的切点必须平衡
  if (bal[e] !== 0) return { ok: false, reason: 'end-cut-unbalanced' }
  // ④ 区间内部余额不得为负（不得吞掉「调用在外、结果在内」的半截配对）
  for (let i = s; i <= e; i++) if (bal[i] < 0) return { ok: false, reason: 'inner-neg' }
  // ⑤ 区间内增量代数和必须归零
  let sum = 0
  for (let i = s; i <= e; i++) sum += eventDelta(events[i])
  if (sum !== 0) return { ok: false, reason: 'span-sum-nonzero' }
  // ⑥ 区间内 tool-call 数必须等于 tool/result 数
  let calls = 0, results = 0
  for (let i = s; i <= e; i++) {
    if (events[i].type === ASSISTANT_MESSAGE) calls += countToolCalls(events[i])
    else if (events[i].type === TOOL_RESULT) results++
  }
  if (calls !== results) return { ok: false, reason: 'calls-results-mismatch' }
  // ⑦ 选出的 seq 必须与表面一一对应
  for (let i = s; i <= e; i++) {
    if (span.shadowedSeqs[i - s] !== events[i].seq) return { ok: false, reason: 'seq-mismatch' }
  }
  return { ok: true }
}

/**
 * 选出一个平衡闭包区间。
 * @param events [{ seq, type, toolCallCount? , data? }] 线性表面序列
 * @param opts
 *   targetSeq           指定要压缩哪条 assistant 消息；缺省 = 跳过活跃尾部后的那一条
 *   keepTail            活跃尾部宽度（最近多少条 assistant/message 逐字保留，永不遮蔽）；
 *                       缺省 1。官方规范："leaves the recent tail unchanged"。
 *   absorbSeqs          一并纳入遮蔽区间的既有 seq（用于"看板单例自吞噬"：把上一条看板吞掉，
 *                       使表面恒 ≤ 1 份看板）。不在表面上 / 会越入活跃尾部 / 切点不平衡 ⇒ 放弃吞并。
 *   minShadowedEvents   区间太短则不选（缺省 1）
 *   allowWholeSurface   是否允许把整个表面全部遮蔽（缺省 false，安全阀）
 * @returns { startIdx, endIdx, startSeq, endSeq, shadowedSeqs, calls, results } | null
 */
export function selectBalancedSpan(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  const bal = balanceAfterEach(events)
  // 表面本身已损坏 ⇒ 一律不动（D3′）
  for (let i = 0; i < bal.length; i++) if (bal[i] < 0) return null

  // ★ 活跃尾部宽度：最近多少条 assistant/message 永不进入遮蔽区间。
  //   非整数 / <1 / 缺省 ⇒ 一律取 1（安全缺省；0 与负数不是合法配置）。
  const keepTail = Number.isInteger(opts.keepTail) && opts.keepTail >= 1 ? opts.keepTail : 1
  // 尾部窗口的起点（= 倒数第 keepTail 条 assistant 的索引）；不足 keepTail 条 ⇒ 整表皆尾部
  const asstAll = []
  for (let i = 0; i < events.length; i++) if (events[i].type === ASSISTANT_MESSAGE) asstAll.push(i)
  const tailStartIdx = asstAll.length >= keepTail ? asstAll[asstAll.length - keepTail] : events.length

  // ① 定位目标：必须是一条 assistant/message
  let target = -1
  if (opts.targetSeq !== undefined) {
    for (let i = 0; i < events.length; i++) if (events[i].seq === opts.targetSeq) { target = i; break }
    if (target < 0) return null
    if (events[target].type !== ASSISTANT_MESSAGE) return null
  } else {
    // ★★ 2026-09-17 路线 A —— 对齐官方规范（本模块此前的默认行为是错的）★★
    //   官方 dsh-compaction-basic/README.md:81 原文：
    //     "The oldest balanced span is replaced by one summary message and
    //      the recent tail stays verbatim"
    //   官方 dsh-compaction/README.md:145 原文：
    //     "... trades many retained history tokens for one summary and
    //      leaves the recent tail unchanged."
    //
    //   本函数原来的取法是【最后一条】assistant/message ⇒ 恰好剪在模型正说话的
    //   嘴唇上：刚生成的 assistant 回答当轮就被 replace 成 user 检查点，模型下一轮
    //   在上下文里找不到自己对那条提问的任何回应 ⇒ 只能重答 ⇒ 无限自催促。
    //   实测（09-17 08:07-08:17 带电窗口）：一条用户消息被连答 10 次、
    //   出站尾部出现 15 条连续 user、assistant 计数被冻结在 29。
    //
    //   ⇒ 现在把最近 keepTail 条 assistant/message 视为"活跃尾部"，逐字保留；
    //     只有在它滑出尾部窗口（Age ≥ keepTail）之后才允许被整步结算。
    //     缺省 keepTail = 1（最小安全值，也是官方规范的最小实现）。
    const asst = []
    for (let i = 0; i < events.length; i++) if (events[i].type === ASSISTANT_MESSAGE) asst.push(i)
    const ti = asst.length - 1 - keepTail
    if (ti < 0) return null            // 尾部还没攒够 ⇒ 什么都不做（保持原文，D3′）
    target = asst[ti]
  }

  // ② start = 距离 target 最近的、切点平衡的位置（向左找到第一个余额为 0 的切点）
  let s = target
  while (s > 0 && bal[s - 1] !== 0) s--

  // ③ end = 距离 target 最近的、切点平衡的位置（向右）
  let e = -1
  for (let i = target; i < events.length; i++) if (bal[i] === 0) { e = i; break }
  if (e < 0) return null   // 未闭合（如工具尚未回填）⇒ 保持原文

  // ★★ 尾部保护（结构不变量）★★ —— "leaves the recent tail unchanged" 的可执行形式：
  //   遮蔽区间的右端必须【严格】落在活跃尾部之前；想咬到尾巴就整个放弃（D3′ 保持原文）。
  //   这条是独立于 target 选择的第二道闸：即使 targetSeq 被显式指到尾部，也一律拒绝。
  if (e >= tailStartIdx) return null

  // ★★ 看板单例自吞噬（2026-09-17）★★
  //   病：每次 replace 只遮蔽"当轮"，旧看板像僵尸一样堆在尾部
  //       （真机实测：出站 payload 尾部 15 条连续 user，assistant 计数被冻结在 29）。
  //   法：把调用方点名的既有 seq（= 上一条看板的 seq）一并纳入遮蔽区间
  //       ⇒ 表面任意时刻只存活 1 份看板。
  //   两道闸：① 不得越入活跃尾部；② 新起点之前的余额必须为 0（切点仍平衡）。
  //   任一不满足 ⇒ 放弃吞并、照常发射（宁可少吞，绝不吐非法区间）。
  if (Array.isArray(opts.absorbSeqs) && opts.absorbSeqs.length > 0) {
    // ★★★ 人类回合不可逾越律（Human Boundary Law）★★★ 2026-09-17 生产事故
    //   事故现场：seq 6178 是用户新发的 2590 字真人指令（data.source.kind='user'），
    //   它夹在旧看板(6176)与当步目标之间。新看板(6193)为了吞掉 6176，
    //   把区间左端推过了 6178 —— 而 replace 是【连续区间】⇒ 61 秒后用户原文
    //   被物理抹出模型视野，模型再也读不到用户说了什么。
    //   铁律：左端回溯绝不准跨过任何【不是本插件看板】的 user/message。
    //   它们包括：真人发言(kind:'user')、宿主压缩检查点、system-prompt 快照……
    //   一律是围栏。为安全起见这里不看 source.kind，只要不是被点名的看板就算围栏。
    const absorbSet = new Set(opts.absorbSeqs)
    let floor = 0
    for (let i = 0; i < s; i++) {
      if (events[i].type === 'user/message' && !absorbSet.has(events[i].seq)) floor = i + 1
    }
    let absorbIdx = -1
    for (const q of opts.absorbSeqs) {
      for (let i = floor; i < s; i++) {
        if (events[i].seq === q) { if (absorbIdx < 0 || i < absorbIdx) absorbIdx = i; break }
      }
    }
    if (absorbIdx >= floor && absorbIdx < tailStartIdx && balanceBefore(events, absorbIdx) === 0) s = absorbIdx
  }

  // ④ 安全阀：不允许把整个表面一次性全遮蔽
  const whole = s === 0 && e === events.length - 1
  if (whole && opts.allowWholeSurface !== true) return null

  // ⑤ 区间长度下限
  const minShadowed = Number.isInteger(opts.minShadowedEvents) ? opts.minShadowedEvents : 1
  if (e - s + 1 < minShadowed) return null

  let calls = 0, results = 0
  const shadowedSeqs = []
  for (let i = s; i <= e; i++) {
    shadowedSeqs.push(events[i].seq)
    if (events[i].type === ASSISTANT_MESSAGE) calls += countToolCalls(events[i])
    else if (events[i].type === TOOL_RESULT) results++
  }

  const span = {
    startIdx: s,
    endIdx: e,
    targetSeq: events[target].seq,
    startSeq: events[s].seq,
    endSeq: events[e].seq,
    shadowedSeqs,
    calls,
    results,
    keepTail,
    tailStartIdx,
    tailStartSeq: tailStartIdx < events.length ? events[tailStartIdx].seq : null,
  }
  // ⑥ 自检不过就放弃：绝不吐出非法区间
  if (!verifyBalancedSpan(events, span).ok) return null
  return span
}

/**
 * 便利适配器：把会话表面的 seq 列表折成本模块需要的线性事件序列。
 * @param nodes 表面节点 seq 数组（session.surface.nodes）
 * @param eventAt (seq) => event
 */
export function eventsFromSurface(nodes, eventAt) {
  if (!Array.isArray(nodes)) return []
  const out = []
  for (const seq of nodes) {
    let ev
    try { ev = eventAt(seq) } catch { ev = undefined }
    if (!ev || ev.seq !== seq) return null   // 表面与日志不一致 ⇒ 调用方按保持原文处理
    // raw 原样透传：选择器只读 type/toolCallCount，但发射器还要取推理原文与工具结果文本
    out.push({ seq, type: ev.type, toolCallCount: ev.type === ASSISTANT_MESSAGE ? countToolCalls(ev) : undefined, raw: ev })
  }
  return out
}
