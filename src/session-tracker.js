// dsh-cot-form-b / session-tracker.js —— 流归属：这条 llm/stream 属于哪个会话（v11.11）
//
// 问题：宿主的 llm/stream 不带会话；会话只在 agent/pre-step 里看得到。旧实现用一个全局
//   `birthSessionId`：pre-step 写、llm/stream 读。两个会话交错（A.pre → B.pre → A.stream）时，
//   A 的流会被登记成 B —— CAS 归档挂错会话，memory 模式还会把 B 的证据喂给 A 的摘要（跨会话泄漏）。
//
// 根治需要宿主在 llm/stream 里带会话（宿主 API 未确认，不猜）。这里做的是**可证伪的检测 + 保守处置**：
//   - 维护一个「已 pre-step、尚未开流」的窗口；同会话新的 pre-step 覆盖旧项（会话内步骤串行）。
//   - 开流时窗口里出现 ≥2 个不同会话 ⇒ 这条流的归属**不可证** ⇒ ambiguous；窗口剩余项被标为污染，
//     它们开流时同样判不可证。
//   - 过期项（staleMs，缺省 60s）自动丢弃。
//   - 单会话宿主永远不会触发（窗口里只有一个会话）。
//   ⚠ 这是检测器，不是证明：它能抓住「交错」这种形态，不能保证抓住所有误归属；
//     代价是偶发的假阳性（例如 A 最后一步只有 pre-step 没开流，60s 内切到 B ⇒ B 的一条流原文放行）。
//
// 处置由 cfg.birthSessionAmbiguity 决定（plugin.js）：'passthrough'（缺省，原文放行、不归档不压缩）
//   或 'latest'（v11.10 及以前的行为：按最近一次 pre-step 的会话）。两种都留 trace。

/**
 * @param {{ staleMs?: number, now?: () => number }} [opts]
 */
export function createSessionTracker(opts = {}) {
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 60_000
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  let latest = { session: null, sessionId: null }
  // 已 pre-step、尚未开流：sessionId -> { at, tainted }（Map 保持插入序 ⇒ 最早的在前）
  // 同一会话的步骤天然串行 ⇒ 同会话新的 pre-step 覆盖旧项（旧的那一步要么已开流，要么永远不会开流）
  const pending = new Map()

  const prune = () => {
    const t = now()
    for (const [sid, p] of pending) if (t - p.at > staleMs) pending.delete(sid)
  }

  /** agent/pre-step 捕获到会话时调用。 */
  function onPreStep(session) {
    const sid = session && (session.id ?? session.sessionId)
    latest = { session: sid == null ? null : session, sessionId: sid == null ? null : String(sid) }
    if (latest.sessionId == null) return
    prune()
    pending.delete(latest.sessionId)
    pending.set(latest.sessionId, { at: now(), tainted: false })
  }

  /**
   * llm/stream 开流时调用。
   *   ambiguous = 窗口里有 ≥2 个不同会话，或窗口里还留着上一次歧义的「污染」项
   *   （A.pre → B.pre → 流 → 流：两条流谁是谁都不可证，第二条也必须判为不可证）。
   * @returns {{ session: any, sessionId: string|null, ambiguous: boolean, candidates: string[] }}
   */
  function forStream() {
    prune()
    const candidates = [...pending.keys()]
    const ambiguous = candidates.length > 1 || [...pending.values()].some((p) => p.tainted)
    // 记账：消费最早的一项（只用于让窗口排空，不用于归属判定）
    if (candidates.length) pending.delete(candidates[0])
    if (ambiguous) for (const p of pending.values()) p.tainted = true
    return { session: latest.session, sessionId: latest.sessionId, ambiguous, candidates }
  }

  return { onPreStep, forStream, latest: () => latest, pendingCount: () => pending.size }
}
