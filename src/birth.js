// dsh-cot-form-b / birth.js —— 出生即压缩（mode: 'birth'，唯一生产路径）
//
//   birthTransform  包装 llm/stream：reasoning delta 实时透传，block-end 起火，finish 前限时收网
//   birthStart      block-end 处同步起火：内存算句柄 → CAS 归档 ∥ 副模型压缩 并发起飞（绝不 await）
//   birthFinish     finish 处收网：句柄落盘 && 压缩成功 && 净省达标 ⇒ 改写；否则原文(+句柄)放行
//   birthEconomics  成本模型（只记录，不参与判定）
import crypto from 'node:crypto'
import { compileModeOf } from './config.js'
import { prepareJudgmentPrompt } from './evidence-ledger.js'
import { filterCoveredTools, COVER_TAIL_FLOOR, fullyVisibleResultSeqs } from './evidence.js'
import { fidelity } from './fidelity.js'
import { settleLateInFlight, pushLateMemory, noteLateInFlight } from './late-memory.js'
import {
  normalizeBranchId, loadSnapshot, snapshotStats, snapshotToText, coveredSeqSet, snapshotIdOf,
  commitSnapshot,
} from './snapshot-store.js'
import { adaptEvidence, promptStats, cacheIdentity, mergeOrdered, memoryStats } from './state-memory.js'
import { settledTraceData } from './trace.js'

// ═══════════════════════════════════════════════════════════════════════════════
// ── 出生即提纯（mode: 'birth'）: At-Birth Interception ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 为什么需要它：0.1.5-rc.1 的 `dsh-session/lib/types/surface.js` 规定，一次
// `surfaceOp: replace` 必须携带覆盖全部被遮蔽节点的 `sourceEventSeqs`：
//    ·:207  `assistant/message` **禁止**携带 `sourceEventSeqs`（embeds its source stream）
//    ·:234  不带则 `missing` 非空 ⇒ :236 抛错
//  ⇒ 「事后用 replace 改写 assistant 消息」在该版本被架构性禁止，四条载体全封死。
//
// 破局点：把剪刀提前到「出生那一秒」。在 `llm/stream` 里改写 chunk，由宿主
// `dsh-agent-loop:1040 live.push(chunk)` 接收后装配成 assistant 消息 —— 这是一次
// **普通 append**，不需要 replace、不需要 sourceEventSeqs、不触发任何断言。
// 因为改写发生在 push 之前，accumulator / stream 字段 / replayState 全部自洽。
//
// 四条硬约束（每条都有源码出处，违反即坏）：
//   ① `block-start` 必须**立刻**透传。`dsh-llm/invariant.js:16` 要求 `reasoning-delta`
//      落在「已开」的 reasoning 块上 ⇒ 我们后发的 delta 只有在块已开时才合法。
//   ② `finish` 必须**押后到最后**。`invariant.js:53` 规定 finish 时不许有未关闭块。
//   ③ **归档先于压缩**。归档失败 ⇒ 原样透传。原始 CoT 绝不允许因压缩而丢失。
//   ④ 主流自己的错误必须原样抛出；我们内部的异常只许降级成「原样重放」。

/** 新建一个被扣住的 reasoning 块（等待结算）。 */
export function birthHoldNew(index) {
  return { index, text: '', end: null }
}

// ── 句柄纯函数推导（方案一 优化1：内存秒算，不占用任何 I/O）────────────────────
/**
 * 与 dsh-context-memory-bundle/store/dshb-store.js:582-587 **逐字一致**：
 *   'art://' + HMAC-SHA256(sessionId, sha256(text)).base64url.slice(0,22)
 * 无随机盐、无时间戳 ⇒ 同一 (session, content) 永远得到同一句柄，
 * 因此可以在 block-end 那一毫秒同步算好，让「CAS 写盘」与「模型提纯」同时起飞。
 * ⚠ sessionId 必须与后续 putText 传入的严格同源，否则 CMB resolve() 的所有权校验会拒发。
 */
export function deriveArtHandle(sessionId, text) {
  const sha = crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
  return 'art://' + crypto.createHmac('sha256', String(sessionId || ''))
    .update(sha).digest('base64url').slice(0, 22)
}

/** 到点即返回 null 的期限守卫。结算后立刻清定时器；**绝不 unref**（unref 会让事件循环当场排空）。 */
function birthDeadline(p, ms) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const settle = (v) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    if (ms > 0) timer = setTimeout(() => settle(null), ms)
    Promise.resolve(p).then(settle, () => settle(null))
  })
}

/** 把结算稿组装成下游该看到的 chunk 序列（live 模式只发改写后的 block-end）。 */
function birthEmitChunks(task, text, deps) {
  const chunks = []
  if (!deps.live) chunks.push({ type: 'reasoning-delta', index: task.index, text })
  if (task.end) {
    // ★★ 真机首跑抓出的关键 bug：BlockAssembler（dsh-llm/lib/index.js:936-940）在 block-end
    //   分支执行 `partial.block = chunk.block`，此后该块**以 block.text 为权威**
    //   （:924 `if (partial.block) return` 直接忽略后续 delta）。若把源流的 block-end 原样转发，
    //   压缩结果会被原文整体覆盖。故 block.text 必须一并改写。
    const b = task.end.block
    chunks.push(b && typeof b === 'object'
      ? { ...task.end, block: { ...b, text } }
      : { ...task.end, block: { type: 'reasoning', text } })
  }
  return chunks
}

/**
 * ★ 成本模型（2026-09-23 v11.6，纯函数，只用于观测与自测）。
 *   净收益 = (R−1)·d·(B−B′) − T − 5·B′
 *   ρ_max  = [(R−1)·d − T/B] / [5 + (R−1)·d]      允许的最大压缩后占比
 *   B_abs  = T / ((R−1)·d)                          绝对下界：低于它无论多压都亏
 *   B_min  = B′_est / ρ_max                         保本原长（B′_est 冷启动 = compressTargetMax）
 *   R_est  = 剩余窗口 / 每轮增量；增量取不到 ⇒ R 回落 econR（55），rSource='fallback'
 * @param B 原文字符数
 * @param pressure {usedTokens, contextWindow, source} | null（emitter.readPressure 形状）
 */
export function birthEconomics(B, pressure, cfg = {}) {
  const d = Number.isFinite(cfg.econCacheDiscount) ? cfg.econCacheDiscount : 0.02
  const T = Number.isFinite(cfg.econTemplateChars) ? cfg.econTemplateChars : 460
  const Rfb = Number.isFinite(cfg.econR) ? cfg.econR : 55
  const perTurn = Number.isFinite(cfg.econCharsPerTurn) && cfg.econCharsPerTurn > 0 ? cfg.econCharsPerTurn : null
  const bPrime = Number.isFinite(cfg.compressTargetMax) ? cfg.compressTargetMax : 450
  if (!(B > 0)) return null
  let R = Rfb, rSource = 'fallback', remainingTokens = null
  if (pressure && Number.isFinite(pressure.usedTokens) && Number.isFinite(pressure.contextWindow) && perTurn) {
    remainingTokens = Math.max(0, pressure.contextWindow - pressure.usedTokens)
    const est = Math.floor((remainingTokens * 4) / perTurn)   // 4 字符/token 粗估，与 emitter CHARS_PER_TOKEN 同口径
    if (est >= 2) { R = est; rSource = pressure.source || 'meter' }
  }
  const k = (R - 1) * d
  const rhoMax = (k - T / B) / (5 + k)
  const bAbs = Math.ceil(T / k)
  const bMin = rhoMax > 0 ? Math.ceil(bPrime / rhoMax) : Infinity
  const netAtTarget = k * (B - bPrime) - T - 5 * bPrime
  return {
    B, R, rSource, remainingTokens, d, T,
    rhoMax: Number(rhoMax.toFixed(4)), bAbs, bMin: Number.isFinite(bMin) ? bMin : null,
    netAtTarget: Math.round(netAtTarget),
    // 三态判定（只记录）：below-abs 必亏；below-min 目标长度下亏；ok 目标长度下赚
    verdict: B < bAbs ? 'below-abs' : (B < bMin ? 'below-min' : 'ok'),
  }
}

/**
 * 阶段一（block-end 处）：**同步**起火，绝不 await。
 *   ① 内存秒算句柄（~0.05ms）
 *   ② diskP（CAS 写盘）与 distillP（宿主模型提纯）双向并发起飞
 * 低于门槛 / 无 store ⇒ belowFloor=true，调用方应立即原样放行（不必扣住）。
 * @returns 任务对象，finish 处交给 birthFinish 收口
 */
export function birthStart(entry, deps = {}) {
  const cfg = deps.cfg || {}
  const preparationStarted = performance.now()
  const taskId = crypto.randomUUID()
  const trace = (tag, data) => (deps.trace || (() => {}))(tag, { ...data, taskId })
  const raw = String(entry.text || '')
  const floor = cfg.birthMinChars == null ? 500 : cfg.birthMinChars
  const sessionId = typeof deps.sessionId === 'function' ? deps.sessionId() : (deps.sessionId || null)
  // ★ 分支键：宿主当前无分支概念 ⇒ normalizeBranchId 返回 'main'；一旦宿主提供则按分支隔离。
  const branchId = typeof deps.branchId === 'function'
    ? normalizeBranchId(deps.branchId())
    : normalizeBranchId(deps.branchId ?? deps.branch ?? null)
  const task = {
    taskId, index: entry.index, raw, end: entry.end || null, sessionId, branchId,
    canDefer: sessionId != null && Buffer.byteLength(raw) <= 192 * 1024,
    handle: null, diskP: null, distillP: null,
    diskState: null, distillState: null,
    belowFloor: false, why: null,
    // ★ 2026-09-21 短路信号（外部审计第一批）：任一分支【终局不可用】⇒ 立刻唤醒收网，
    //   不再陪跑到 budgetMs。只停止"等待"，绝不取消 archive/distill 本身。
    shortP: null, shortReason: null, finishEnterAt: 0,
    abort: null,
  }
  let shortResolve = null
  task.shortP = new Promise((r) => { shortResolve = r })
  const noteShort = (why) => {
    if (!task.shortReason) task.shortReason = why
    if (shortResolve) { const r = shortResolve; shortResolve = null; r(why) }
  }
  if (cfg.enabled === false || cfg.mode === 'off' || cfg.dryRun === true) { task.belowFloor = true; task.why = cfg.dryRun ? 'dry-run' : 'disabled'; return task }
  if (!raw.trim() || raw.length < floor) { task.belowFloor = true; task.why = 'below-floor'; return task }
  if (cfg.birthArchive === false) { task.belowFloor = true; task.why = 'archive-off'; return task }
  task.compressMode = compileModeOf(cfg) === 'compress'
  // ★ 2026-09-23 v11.6 成本模型字段（**只记录，不参与判定**；见 docs/AUDIT-V11.5.md §一）。
  //   目的：为「按剩余窗口动态门槛」积累标定数据（R_est 的每轮增量尚未标定，直接接管会抖动）。
  try {
    const econ = birthEconomics(raw.length, typeof deps.pressure === 'function' ? deps.pressure() : null, cfg)
    if (econ) { task.econ = econ; trace('birth-econ', { index: entry.index, ...econ }) }
  } catch { /* 观测失败绝不影响主流 */ }
  const archive = deps.archive
  if (typeof archive !== 'function') { task.belowFloor = true; task.why = 'no-store'; return task }

  // ★ 2026-09-21：本任务的取消开关（外部审计 P0-2）。放弃应用时用它掐掉在飞的提纯。
  try {
    task.abort = new AbortController()
  } catch { task.abort = null }

  // ① 内存秒算句柄（纯函数；测试可注入 deriveHandle 以固定取值）
  const derive = typeof deps.deriveHandle === 'function' ? deps.deriveHandle : deriveArtHandle
  try { task.handle = derive(sessionId, raw) } catch { task.handle = null }

  // ② 并发起飞：写盘（独立超时护栏；卡住即当归档失败）
  const toMs = cfg.birthArchiveTimeoutMs == null ? 3000 : cfg.birthArchiveTimeoutMs
  task.diskP = birthDeadline(Promise.resolve().then(() => archive(raw, sessionId)), toMs)
    .then((h) => ({ ok: !!h, handle: h || null }))
    .catch((e) => {
      trace('birth-archive-error', { index: task.index, error: String((e && e.message) || e) })
      return { ok: false, handle: null }
    })
    .then((s) => {
      task.diskState = s
      trace('birth-archive-settled', { index: task.index, ok: s.ok, handle: s.handle, rawSha256: crypto.createHash('sha256').update(raw).digest('hex') })
      // 归档终局失败 ⇒ 拿不到句柄 ⇒ 提纯结果永远无法应用（铁律③）⇒ 立即短路
      if (!s.ok) {
        noteShort('archive-failed-early')
        // This consumer can never pass the mandatory archive gate, even if a
        // timed-out write eventually finishes. Do not cancel other consumers.
        task.abort?.abort()
        trace('compiler-consumer-unusable', { reason: 'archive-terminal-failure' })
      }
      return s
    })

  // ③ 并发起飞：提纯（100% 跟随宿主模型/provider；端点/钥匙由注入的 distill 决定，本模块不碰）
  const distill = deps.distill
  const dsignal = task.abort ? task.abort.signal : undefined
  // ★ v11.7 响应头信号：蒸馏一收到响应头就 resolve（排队结束、正在生成）。供 birthFinish 收尾宽限使用。
  let headersResolve = null
  task.headersAt = null
  task.headersP = new Promise((r) => { headersResolve = r })
  const noteHeaders = (info) => { if (info && info.status != null && info.status !== 200) return; if (task.headersAt === null) { task.headersAt = Date.now(); trace('birth-distill-headers', { index: task.index, ttfbMs: info && info.ttfbMs, sinceFiredMs: task.firedAt ? task.headersAt - task.firedAt : null }); headersResolve(true) } }
  // ★★ 2026-09-21 任务状态记忆：把"原始 reasoning"升格为"证据信封"。★★
  //   时间截面在**这里**固定：此后不再补入任何"后来才发生"的事实。
  //   信封纯数据、被冻结；构造失败一律回落裸 raw，绝不因为观测层出问题而碰坏主流。
  let distillInput = raw
  // ⚠ 作用域修复（2026-09-22）：这两个值在 settle 钩子（try 块**之外**）里要用。
  //   此前它们声明在 try 块内 ⇒ 钩子里引用必然 ReferenceError，又被 `catch {}` 吞掉
  //   ⇒ 覆盖水位一次都没真正推进过（这正是"过滤从未生效"的第二重原因）。
  let toolsForPrompt = null
  let adaptedCut = null
  let preparationError = null
  let deterministicFrame = null
  let preparedJudgment = null
  // ★ 2026-09-22 切分：证据信封只在「状态记忆」模式构造。
  //   stateCompress（纯压缩）**不采集证据** —— 它只需要这段 reasoning，
  //   带上整窗工具正文正是实测 7.5x 放大的来源。
  if (compileModeOf(cfg) === 'memory' && typeof deps.buildEnvelope === 'function') {
    try {
      // ① 采集：只读 session；来源按**原事件类型**判定，绝不用最终 role
      const collected = typeof deps.collectEvidence === 'function'
        ? deps.collectEvidence({
            limit: cfg.stateEvidenceLimit == null ? 60 : cfg.stateEvidenceLimit,
            // ★ 结构性上下文跨窗口检索：看板/用户要求/运行时抬头不受 60 节点窗口限制
            structural: cfg.stateStructuralFirst === true,
          })
        : { events: [], inFlightIds: new Set(), cutSeq: null }
      // ② 适配：转独立数据 + 冻结快照（杜绝事后共享引用改动破坏时间截面）
      const adapted = adaptEvidence({
        events: collected.events, inFlightIds: collected.inFlightIds, cutSeq: collected.cutSeq,
        coverage: collected.coverage,
      })
      if (typeof deps.prepareEvidence === 'function') {
        try {
          deterministicFrame = deps.prepareEvidence({ sessionId, branchId, tools: adapted.tools,
            userAsks: adapted.userAsks, runtimeFacts: adapted.runtimeFacts, unknownUserEvents: adapted.unknownUserEvents, coverage: adapted.coverage, cutSeq: adapted.cut })
          task.deterministic = true
          trace(deterministicFrame.durable === false ? 'evidence-ledger-unavailable' : 'evidence-ledger-committed', { storageReason: deterministicFrame.storageReason, revision: deterministicFrame.revision,
            indexPath: deterministicFrame.indexPath, newObservations: deterministicFrame.newObservations, repeatedObservations: deterministicFrame.repeatedObservations,
            totalObservations: deterministicFrame.totalObservations })
        } catch (e) { preparationError = e; throw e }
      }
      // ★★ 快照持久化：编译输入止血（2026-09-22，用户批准路线）★★
      //   旧实现的两个根本缺陷（真机 + 会话日志逐条核对确认）：
      //     ① 覆盖判据依赖「本轮 priorMemory 里有一份更新的看板」，而看板是**渲染产物**，
      //        且会被宿主压缩整段删除（实测 seq=27097 替换掉 [26309,26733]，171 节点消失）
      //        ⇒ 判据恒为 false ⇒ 过滤一次都没生效；
      //     ② 水位线会连带跳过"未采集/迟到返回"的结果。
      //   现在改为：插件自己保存的**结构化快照**（不解析消息文本、不看 role、不认标记），
      //   覆盖判据 = 快照 coverage.coveredSeqs 的**精确成员判定**。
      //   ⚠ 没有快照 ⇒ 没有覆盖 ⇒ 全量发送（宁可多发，不可漏发）。
      let coverInfo = null
      toolsForPrompt = adapted.tools
      adaptedCut = adapted.cut == null ? null : adapted.cut
      let snapshot = null
      let snapInfo = null
      let snapText = ''
      try {
        snapshot = deterministicFrame || cfg.stateSnapshot === false ? null : loadSnapshot(sessionId, branchId)
        if (snapshot && Number.isSafeInteger(adaptedCut) && Number.isSafeInteger(snapshot.sourceCutSeq) && snapshot.sourceCutSeq > adaptedCut) {
          trace('state-snapshot-future-cut', { index: task.index, cutSeq: adaptedCut, snapshotCut: snapshot.sourceCutSeq })
          snapshot = null
        }
        if (snapshot) {
          snapInfo = snapshotStats(snapshot)
          snapText = snapshotToText(snapshot)
          if (!snapText) trace('state-snapshot-view-unavailable', { index: task.index, revision: snapshot.revision, reason: 'incomplete-or-oversize', filtering: false })
        }
      } catch (e) { trace('state-snapshot-error', { index: task.index, error: String((e && e.message) || e) }) }
      try {
        const covered = cfg.stateCoveredEvidence !== false && snapshot && snapText
          ? coveredSeqSet(snapshot) : null
        if (covered && covered.size) {
          // ★ 过滤走**导出的纯函数**（与自测/重放同一份实现，杜绝「验证的是手抄副本」）
          const res = filterCoveredTools(adapted.tools, covered, COVER_TAIL_FLOOR)
          if (res.info) {
            toolsForPrompt = res.tools
            coverInfo = Object.assign({
              source: 'snapshot', revision: snapshot.revision, coveredSeqs: covered.size,
            }, res.info)
          }
        }
      } catch (e) { trace('state-cover-error', { index: task.index, error: String((e && e.message) || e) }) }
      // ③ 构造信封（仍是**一次**模型调用；仍是纯数据）
      // ⚠ 这里**不**注入迟到结果：收网器一旦发射 ledger，assembleEvidence 会
      //   自动把它读回来当 priorMemory（同一条通路），此处再注入就是重复。
      distillInput = deps.buildEnvelope({
        cot: raw,
        userAsks: adapted.userAsks,
        // ⚠ 绝不能改 adapted（Object.freeze）—— 传过滤后的数组本身
        tools: deterministicFrame ? [] : toolsForPrompt,
        runtimeFacts: adapted.runtimeFacts,
        priorMemory: adapted.priorMemory,
        // ★ 结构化状态快照：**完整**注入（走独立字段，不经 priorMemory 的 1200 字符腰斩）
        stateSnapshot: snapText ? {
          text: snapText,
          revision: snapshot.revision,
          entries: (snapshot.entries || []).length,
          covered: (snapshot.coverage && snapshot.coverage.coveredSeqs) ? snapshot.coverage.coveredSeqs.length : 0,
          sourceCutSeq: snapshot.sourceCutSeq,
          snapshotId: snapshotIdOf(snapshot.sessionId, snapshot.branchId, snapshot.revision),
        } : null,
        unknownUserEvents: adapted.unknownUserEvents,
        coverage: adapted.coverage,
        host: Object.assign({
          step: entry.step == null ? null : entry.step,
          blockIndex: task.index,
          archive: 'in-flight',
        }, entry.host || {}),
        at: Date.now(),
      })
      if (deterministicFrame) distillInput = Object.freeze({ ...distillInput, deterministicFrame })
      if (deterministicFrame) trace('compiler-input-prepared', { revision: deterministicFrame.revision, bodyChars: deterministicFrame.evidenceInput?.bodyChars || 0, receipts: deterministicFrame.evidenceInput?.receipts || [], meaning: 'input-prepared-not-proof-of-transmission-or-understanding' })
      toolsForPrompt = distillInput.tools
      // ★ 提示词体量画像（2026-09-21）：把「优化省了多少」变成可核对的生产数据。
      //   此前只能靠本地合成场景猜重复率，现在真实分布直接落 trace。
      let pstats = null
      try {
        if (deterministicFrame) preparedJudgment = prepareJudgmentPrompt(distillInput)
        pstats = preparedJudgment ? { totalChars: preparedJudgment.prompt.length, toolBodyChars: deterministicFrame.evidenceInput?.bodyChars || 0, compilerMode: 'grounded-judgment-v2', promptVersion: preparedJudgment.version, promptBuildMs: preparedJudgment.buildMs } : promptStats(distillInput)
      } catch { pstats = null }
      trace('state-envelope', {
        index: task.index, cotChars: raw.length,
        tools: distillInput.counts.tools, pending: distillInput.counts.pending,
        terminal: distillInput.counts.terminal, userAsks: distillInput.counts.userAsks,
        runtimeFacts: distillInput.counts.runtimeFacts, priorMemory: distillInput.counts.priorMemory,
        unknownUser: distillInput.counts.unknownUserEvents, coverageIncomplete: distillInput.counts.coverageIncomplete,
        coverage: distillInput.coverage, cutSeq: adapted.cut,
        // ★ 编译输入止血（2026-09-22）：本轮因「已覆盖」而少发了多少旧工具证据
        cover: coverInfo,
        // ★ 快照持久化诊断：本轮注入的是哪个 revision、覆盖了多少条、是否已应用到主请求面
        snapshot: snapInfo,
        snapshotChars: distillInput.counts.snapshotChars,
        // ★ 结构性上下文跨窗口取回了几条（A 方案；0 = 未启用或窗口外没有）
        structural: collected.structuralFetched == null ? null : collected.structuralFetched,
        structuralSeqs: collected.structuralSeqs || null,
        prompt: pstats,
      })
      // 缓存身份：**影响摘要结论的内容才进入**（同一 reasoning 在不同工具终局下不得共用摘要）
      if (cfg.stateCacheKeyTrace) trace('state-cache-identity', { index: task.index, hash: crypto.createHash('sha256').update(cacheIdentity(distillInput)).digest('hex').slice(0, 16) })
    } catch (e) {
      if (typeof deps.prepareEvidence === 'function') preparationError ||= e
      trace('state-envelope-error', { index: task.index, error: String((e && e.message) || e) })
      distillInput = raw
    }
  }
  trace('compiler-preparation-cost', { ms: performance.now() - preparationStarted, promptBuilt: !!preparedJudgment })
  task.distillP = (typeof distill === 'function'
    ? Promise.resolve().then(async () => {
        if (preparationError) throw preparationError
        return distill(distillInput, dsignal, {
          preparedJudgment, onHeaders: noteHeaders,
          taskId, trace, scope: sessionId != null && String(sessionId).length > 0 && Number.isSafeInteger(adaptedCut) && adaptedCut >= 0 ? [String(sessionId), branchId, adaptedCut] : null,
        })
      })
    : Promise.reject(new Error('no-distiller')))
    .then((r) => {
      const text = r && r.text != null ? String(r.text).trim() : ''
      if (!text) throw new Error('empty distillate')
      // ★ 状态记忆分支：把六栏对象与有效性一并带出去，供 trace 与后续 checkpoint 使用。
      //   注意此处**不**提交任何东西 —— 提交仍由 birthFinish + 现有 surface 通路决定。
      let entries = (r && r.entries) || null
      // ★ 2026-09-23 compress 接入迟到通路：纯压缩没有六栏，但摘要本身就是可认领的产物。
      //   包成一条最小 entry ⇒ pushLateMemory 的 entries 门禁放行；快照仍不提交（见下方 stateSnapshot 门）。
      if (!entries && compileModeOf(cfg) === 'compress') {
        entries = [{ id: 'compress:' + taskId.slice(0, 8), category: 'state', content: text, source: 'model', basis: 'compressed-reasoning' }]
      }
      return { ok: true, text, meta: (r && r.meta) || null, entries,
               checkpointText: (r && r.checkpointText) || text, parsed: (r && r.parsed) || null }
    })
    .catch((e) => {
      // ★ 2026-09-21 补漏：这里原本把 `e.meta` 丢了 ⇒ **超时/取消**这条最该诊断的路径
      //   一个阶段字段都落不了盘（真机首条 settled 就是这样：ok:false, reason:cancelled,
      //   无 ttfbMs / toFirstContentMs / chunks）。现在原样带出去。
      const em = (e && e.meta) || null
      trace('birth-distill-failed', Object.assign(
        { index: task.index, error: String((e && e.message) || e) },
        em ? {
          ttfbMs: em.ttfbMs, totalMs: em.totalMs, chunks: em.chunks, reused: em.reused,
          status: em.status, cancelled: em.cancelled, stream: em.stream === true ? true : undefined,
          toFirstEventMs: em.toFirstEventMs, toFirstContentMs: em.toFirstContentMs,
          contentSpanMs: em.contentSpanMs, eventCount: em.eventCount,
        } : {}))
      return { ok: false, error: String((e && e.message) || e), meta: em }
    })
    .then(async (s) => {
      task.distillState = s
      settleLateInFlight(sessionId, taskId, { branchId })
      // 提纯终局失败 ⇒ 必定原文放行 ⇒ 没有理由再等（归档仍在后台继续）
      if (!s.ok) noteShort('distill-failed-early')
      // ★★ 方案二：这次结果没赶上自己那块（已放行原文）⇒ 暂存给下一轮。
      //   仅当：编译成功 && 带六栏 entries && 确实已放行 && 开关打开。
      //   失败/取消一律不存 —— 绝不把半成品当记忆。
      // ★★ 快照持久化：**只在编译成功时**提交（失败/取消一律不提交 ⇒ 下轮仍能看到这批证据）。
      //   覆盖集合 = 本轮**真正发给模型的**那些工具证据的 resultSeq（= toolsForPrompt）。
      //   为什么不是 cutSeq / maxSeq：cutSeq 可能指向 pending 调用，maxSeq 会跳过未采集
      //   与迟到返回的结果 —— 两者都会把"结果未返回"当成已知，违反时间截面。
      //   写入顺序由 commitSnapshot 保证：先归并 entries → 先写完整快照 → 再原子替换指针。
      // The archive is a prerequisite for both persistent and deferred memory.
      // Waiting here is background work; birthFinish retains its own deadline.
      const archived = s.ok && s.entries ? await task.diskP : null
      // ⚠ 快照只属于 memory 模式：compress 的最小 entry 是摘要，不是判断，绝不写进持久快照。
      if (s.ok && s.entries && archived && archived.ok && cfg.stateSnapshot !== false && compileModeOf(cfg) === 'memory') {
        try {
          const seqs = fullyVisibleResultSeqs(toolsForPrompt)
          const c = commitSnapshot({
            sessionId, branchId, entries: s.entries, coveredSeqs: seqs,
            sourceCutSeq: adaptedCut, at: Date.now(),
          })
          if (c.ok) {
            trace('state-snapshot-committed', {
              index: task.index, revision: c.snapshot.revision, parentRevision: c.mergedFrom,
              entries: c.snapshot.entries.length, added: c.added,
              covered: c.snapshot.coverage.coveredSeqs.length, newSeqs: c.newSeqs,
              sourceCutSeq: c.snapshot.sourceCutSeq, locked: c.locked,
              snapshotId: snapshotIdOf(sessionId, branchId, c.snapshot.revision),
            })
          } else {
            trace('state-snapshot-commit-failed', { index: task.index, reason: c.reason })
          }
        } catch (e) { trace('state-snapshot-error', { index: task.index, where: 'commit', error: String((e && e.message) || e) }) }
      }
      if (s.ok && s.entries && archived && archived.ok && task.passedThrough && cfg.birthDeferredClaim === true) {
        const worthStoring = !(task.deterministic || task.compressMode) || raw.length - String(s.checkpointText || s.text).length >= (cfg.birthMinSavedChars ?? 50)
        const stored = worthStoring && pushLateMemory(sessionId, raw, s.entries, s.checkpointText, { branchId, taskId })
        if (!stored) trace('birth-late-memory-refused', { index: task.index, reason: worthStoring ? 'invalid-or-capacity' : 'no-gain', branchId })
        if (stored) trace('birth-late-memory-stored', {
          index: task.index, entries: s.entries.length,
          chars: s.text ? s.text.length : 0,
          // ★ 真工期：这是回答「预算该给多少」的唯一直接证据
          distillMs: (s.meta && s.meta.toCompleteMs) || null,
          ttfbMs: (s.meta && s.meta.ttfbMs) || null,
          promptChars: (s.meta && s.meta.promptChars) || null,
        })
      }
      return s
    })

    // ★ 真工期探针（2026-09-18）：收尾即使已熔断，伴生调用真正结束时也会落一条记录。
    //   纯观测，不改任何行为。用途：回答「finishWaitMs 该设多少」「这笔调用是否白付」。
    if (task.distillP && typeof task.distillP.then === "function") {
      const _t0 = Date.now()
      task.distillP.then((s) => {
        // ★ 2026-09-21：把请求指纹与阶段耗时一并落 trace（外部审计 P0-1）。
        //   connectMs=建连 / ttfbMs=响应头 / firstByteMs=首个正文字节 / totalMs=读完 / chunks=分片数。
        //   非流式下 firstByte≈ttfb；一旦上游 chunked，这两个数就能把「排队」与「生成」分开。
        // ★ 2026-09-21 补漏：流式阶段字段此前只写进 meta、**没进 trace 白名单**，
        //   导致第一次真机读数的 trace 里看不到它们（只能拿 ttfb/totalMs 反推）。
        //   现在记录体由纯函数 settledTraceData() 生成，并有端到端 trace 测试钉住。
        trace("birth-distill-settled", settledTraceData(task.index, Date.now() - _t0, s))
      }, () => {}).catch(() => {})
    }

  trace('birth-fired', { index: task.index, rawChars: raw.length, handle: task.handle })
  task.firedAt = Date.now()
  return task
}

/**
 * 阶段二（finish 处）：收网。硬上限 birthFinishWaitMs（终审 1500ms），到点立即熔断。
 * 判定：句柄已落盘 && 提纯成功 && 净省 ≥ birthMinSavedChars ⇒ 改写稿；否则 raw(+句柄)。
 * 失败一律原样放行 —— **零 rules 兜底**（方案一铁律 1）。
 */
export async function birthFinish(task, deps = {}) {
  const cfg = deps.cfg || {}
  const trace = (tag, data) => (deps.trace || (() => {}))(tag, { ...data, taskId: task.taskId || null })
  const handleInText = cfg.birthHandleInText !== false
  const raw = String(task.raw || '')
  // ★★ 2026-09-18 用户令：句柄标记从上下文中【彻底删除】，一个字符都不许出现。★★
  //   理由（血的教训）：模型对着一根裸指针无法思考。替换文本必须携带【语义内容】：
  //     A 态 → 宿主模型提纯出的语义摘要；B 态 → 原文逐字。
  //   句柄只用于 CAS 归档登记（磁盘上的证据索引），绝不写进模型可见的文本。
  const withHandle = (text, _handle) => text
  // ★★ 2026-09-18 终审（用户令）——兜底 = 原文逐字，句柄绝不进上下文 ★★
  //   事故复盘：曾把兜底改成「裸句柄指针」，导致模型失去自身思维链、
  //   对着一根指针无法思考。该做法已永久废除。
  //   现行语义：能提纯 ⇒ 语义摘要（A 态）；超时/失败/不划算 ⇒ 原文逐字（B 态）。
  //   句柄仅用于 CAS 归档登记与磁盘证据索引，绝不写进模型可见文本。
  // ★ 2026-09-21 放弃应用 ⇒ 掐掉仍在飞的提纯（外部审计 P0-2）。
  //   判据严格：只有【本任务确实起了提纯】且【它还没落地】时才取消 —— 已落地的结果
  //   绝不取消（那是已经付过的钱）。
  //
  // ★★ 2026-09-22 方案二：**有消费者就不取消** ★★
  //   上面这段注释自己预言了这一刻：「将来若接入『历史 checkpoint 回收』，
  //   这里必须改成『有消费者就不取消』」。现在消费者出现了 —— 暂存区（lateMemory）。
  //
  //   真机证据（2026-09-22T04:50:04，finishWaitMs 刚降到 1500）：
  //     [birth-finish-enter]      gapMs=15
  //     [birth-distill-cancelled] why=distill-timeout waitedMs=1506
  //     [birth-passthrough]       cancelled=true waitedMs=1501
  //     [birth-distill-failed]    error="cancelled"
  //     [birth-distill-settled]   ok=false reason="cancelled"
  //   ⇒ 放行时把仍在飞的提纯 abort 掉 ⇒ 暂存区永远拿不到迟到成功
  //   ⇒ 收网通路虽已接通，仍会**每轮空转**（birth-claim-idle）。
  //
  //   不取消 ≠ 无限等：提纯仍受自身 timeoutMs(8000) 约束，到点自然失败；
  //   暂存区另有容量上限与过期清理。放行本身仍是零等待。
  const cancelFlying = (why) => {
    if (!task.abort || task.distillState !== null) return false
    if (cfg.birthDeferredClaim === true) return false
    if (cfg.birthCancelOnGiveUp === false) return false
    try { task.abort.abort() } catch { /* ignore */ }
    trace('birth-distill-cancelled', {
      index: task.index, why,
      waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0,
    })
    return true
  }

  const pass = (why, handle, extra) => {
    const text = withHandle(raw, handle)
    const waitedMs = task.finishEnterAt ? Date.now() - task.finishEnterAt : 0
    const cancelled = cancelFlying(why)
    // ★ 方案二：标记「本块已放行原文」⇒ 若 distill 稍后才成功，它的结果改走暂存给下一轮。
    task.passedThrough = true
    if (task.distillState === null && task.distillP && !cancelled && task.sessionId != null) noteLateInFlight(task.sessionId, task.taskId, raw.length, { branchId: task.branchId })
    trace('birth-passthrough', { index: task.index, why, rawChars: raw.length, outChars: text.length, handle: handle || null, waitedMs, short: task.shortReason || null, cancelled, ...(extra || {}) })
    return { chunks: birthEmitChunks(task, text, deps), text, why, rawChars: raw.length, outChars: text.length, handle: handle || null }
  }

  if (task.belowFloor) return pass(task.why || 'below-floor', null)

  // ★ 2026-09-23：compress 也走 ready-only。它的迟到产物现在能进暂存区被下轮认领，
  //   没有理由再让用户在 finish 处等 finishWaitMs（线上 4000ms）却大概率拿不到结果。
  //   legacy（无迟到消费者）保持原预算等待语义。
  const lateCapable = task.deterministic || task.compressMode === true
  const readyOnly = lateCapable && cfg.birthDeferredClaim === true && task.canDefer !== false
  task.finishEnterAt = Date.now()
  trace('birth-finish-enter', { index: task.index, gapMs: task.finishEnterAt - (task.firedAt || 0), waitPolicy: readyOnly ? 'ready-only' : 'budgeted' })
  if (readyOnly && (!task.diskState || !task.distillState)) {
    const why = task.distillState?.ok === false ? 'judgment-failed' : task.diskState?.ok === false ? 'archive-failed' : 'background-judgment-pending'
    return pass(why, null)
  }
  const budgetMs = readyOnly ? 0 : (cfg.birthFinishWaitMs == null ? 1500 : cfg.birthFinishWaitMs)
  // ★ 自然窗口探针（2026-09-18）：量出「block-end → finish」这段**免费**时间。
  //   α 的成败全看它：摘要在这一段里落地 = 白捡的 A 态；没落地 = 纯句柄（零等待）。
  // ★★ 终审 α（2026-09-18）：budgetMs <= 0 ⇒ 真零等待模式 ★★
  //   实测伴生提纯真工期 3.3~4.0s（探针 birth-distill-settled）。任何 0 < budget < 真工期的取值
  //   都是「白等一段还拿不到摘要」——2000ms 实测 0/2 命中，是被支配的选项。故：
  //     budgetMs  > 0 ：等 disk+distill（旧语义，命中则 A 态语义摘要）
  //     budgetMs <= 0 ：只等写盘落地（本地 I/O，护栏 400ms），绝不等提纯
  //                     ⇒ 真零等待，直接纯句柄放行（写盘未确认仍回吐原文，安全底线不变）
  //   ⚠ birthDeadline(p, 0) 的旧语义是「不设定时器 = 无限等」，零等待必须显式分支。
  if (!(budgetMs > 0)) {
    await birthDeadline(task.diskP, cfg.birthDiskWaitMs == null ? 400 : cfg.birthDiskWaitMs)
  } else {
    // ★ 2026-09-21：短路信号一响就收网，绝不为一个已经注定走原文的结果陪跑到 budget。
    //   实测可回收：archive-failed 52 次 + distill-failed 4 次（本机 trace.log）。
    const shortP = task.shortP || new Promise(() => {})
    const all = Promise.all([task.diskP, task.distillP])
    await birthDeadline(Promise.race([all, shortP]), budgetMs)
    // ★ v11.7 收尾宽限：budget 到点但蒸馏**已收到响应头**（排队已结束、正在生成，实测 contentSpanMs 137~1,267ms）
    //   ⇒ 再多等最多 finishHeadersGraceMs。没收到头 ⇒ 不加一毫秒（排队何时结束不可知）。
    const grace = cfg.finishHeadersGraceMs == null ? 1500 : Number(cfg.finishHeadersGraceMs)
    if (grace > 0 && task.distillState === null && !task.shortReason && task.headersAt !== null) {
      const t0 = Date.now()
      await birthDeadline(Promise.race([all, shortP]), grace)
      trace('birth-finish-headers-grace', { index: task.index, graceMs: grace, waitedMs: Date.now() - t0, settled: task.distillState !== null })
    }
  }

  const disk = task.diskState
  const dist = task.distillState
  const handle = disk && disk.ok && typeof disk.handle === 'string' && disk.handle
    ? disk.handle
    : (disk && disk.ok ? (task.handle || null) : null)

  // 铁律③：拿不到句柄（或写盘未落地）⇒ 绝不替换原文
  if (!handle) return pass(task.shortReason || (disk === null ? 'archive-timeout' : 'archive-failed'), null)

  // 零 rules：只有宿主模型提纯成功且净省够本才替换
  if (dist && dist.ok) {
    const candidate = withHandle(dist.text, handle)
    // ★ 2026-09-23 v11.6 硬断言：替换结果绝不能为空白。
    //   DeepSeek 带 tools 的请求要求每条历史 assistant 都携带 reasoning_content；API 只查字段存在，
    //   但空白内容会让模型失去该轮思维链（H8 事故同形）。空白 ⇒ 原文放行。
    if (!String(candidate).trim()) return pass('empty-candidate', handle)
    const netSaved = raw.length - candidate.length
    const minSaved = cfg.birthMinSavedChars == null ? 50 : cfg.birthMinSavedChars
    // ★ 2026-09-23 v11.6 保真观测（**只记录，不拦截**）：逐字标识符召回率。
    //   受保护 token 集为空 ⇒ unmeasurable（不能算 pass，单独统计）。门槛待离线分布 + 白付成本模型后再定。
    let fid = null
    try {
      const f = fidelity(raw, dist.text)
      fid = f.stats.protectedTokens === 0
        ? { identifierRecall: null, protectedTokens: 0, lostTokens: 0, unmeasurable: true }
        : { identifierRecall: f.stats.tokenRecall, protectedTokens: f.stats.protectedTokens, lostTokens: f.stats.lostTokens, lostSample: f.stats.lostSample, unmeasurable: false }
    } catch { fid = null }
    if (netSaved >= minSaved) {
      trace('birth-condensed', { index: task.index, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, minSaved, handle, waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0, fidelity: fid, econ: task.econ || null })
      return { chunks: birthEmitChunks(task, candidate, deps), text: candidate, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, handle }
    }
    return pass('no-gain', handle, { netSaved, minSaved })
  }
  return pass(dist === null ? 'distill-timeout' : 'distill-failed', handle, { error: (dist && dist.error) || null })
}
/**
 * 单次结算便捷入口（供单测/直调）：起火 + 立即收网。
 * 生产路径用两段式：block-end 处 birthStart，finish 处 birthFinish（中间留给 text/tool 流式）。
 */
export async function birthSettle(entry, deps = {}) {
  return birthFinish(birthStart(entry, deps), deps)
}

/**
 * 把一条模型流包成「出生即提纯」的流（方案一：流式双轨并发拦截器）。
 *   推理 delta 实时透传 → block-end 扣住并起火（写盘 ‖ 提纯）→ text/tool 实时透传
 *   → finish 扣住、等待收网 → 按 index 放行改写后的 block-end → 放行 finish
 * 四条硬约束见上方文件头注释。
 * @param inner 源流（必须已校验为 async iterable，调用方负责）
 * @param deps  { cfg, trace, archive, sessionId, distill, prewarm }
 */
export function birthTransform(inner, deps = {}) {
  const trace = deps.trace || (() => {})
  const cfg = deps.cfg || {}
  const settleDeps = { ...deps, live: true }
  return (async function* () {
    const held = new Map()   // index -> 累计中的 reasoning 块
    const pending = []       // 已起火、等 finish 收网的 task
    // ★ 2026-09-23 v11.6 免费窗口探针（纯观测，不改任何行为）：
    //   记录 reasoning block-end / 第一个非 reasoning block-start / finish 三个时刻。
    //   判读：firstOtherStart 早于 reasoningEnd >1s ⇒ 有窗口（可提前起火）；
    //         两者都贴着 finish ⇒ 宿主攒完再发，无窗口；reasoningEnd 早于 firstOtherStart ⇒ 现有起火点已最早。
    const streamT0 = Date.now()
    let firstOtherStartAt = null, firstOtherType = null
    const reasoningEndAt = []   // [{index, at}]
    let sourceError = null
    let prewarmed = false
    const handleInText = cfg.birthHandleInText !== false

    // 立即降级放行（abort/异常路径，绝不等待）：无条件给出【原文逐字】（句柄不进上下文）
    const flushTask = function* (task) {
      const s = task.diskState
      const handle = s && s.ok ? (s.handle || task.handle || null) : null
      // 句柄不写进文本：降级放行时给出【原文逐字】
      const text = task.raw
      for (const c of birthEmitChunks(task, text, settleDeps)) yield c
    }

    try {
      for await (const chunk of inner) {
        const t = chunk && chunk.type
        // 约束①：block-start 必须立刻透传（不变式要求 delta 落在已开的块上）
        if (t === 'block-start' && chunk.blockType !== 'reasoning' && firstOtherStartAt === null) {
          firstOtherStartAt = Date.now(); firstOtherType = chunk.blockType || null
        }
        if (t === 'block-start' && chunk.blockType === 'reasoning') {
          held.set(chunk.index, birthHoldNew(chunk.index))
          // 优化2：思考一开始就捂热连接（HEAD，零 token；每次流只做一次）
          if (!prewarmed && typeof deps.prewarm === 'function') {
            prewarmed = true
            try { deps.prewarm('birth-reasoning-start') } catch { /* 预热失败绝不影响主流 */ }
          }
          yield chunk
          continue
        }
        if (t === 'reasoning-delta') {
          const h = held.get(chunk.index)
          // live：delta 实时透传（GUI 不卡顿），同时累积原文供 block-end 结算
          if (h) { h.text += (chunk.text || ''); yield chunk; continue }
          yield chunk
          continue
        }
        // ★ 流式双轨：block-end 处扣住（不 yield），起飞并发任务
        if (t === 'block-end') {
          const h = held.get(chunk.index)
          if (h) {
            h.end = chunk
            held.delete(chunk.index)
            reasoningEndAt.push({ index: chunk.index, at: Date.now() })
            const task = birthStart(h, settleDeps)
            if (task.belowFloor) {
              // 无需异步工作 ⇒ 立即放行，零延迟
              for (const c of birthEmitChunks(task, task.raw, settleDeps)) yield c
            } else {
              pending.push(task)
            }
            continue
          }
          yield chunk
          continue
        }
        if (t === 'finish') {
          const reason = (chunk && chunk.reason) || {}
          const hardStop = reason.kind === 'error' || reason.kind === 'aborted'
          if (reasoningEndAt.length) {
            const finishAt = Date.now()
            const lastEnd = reasoningEndAt[reasoningEndAt.length - 1].at
            trace('birth-window-probe', {
              reasoningBlocks: reasoningEndAt.length,
              reasoningEndMs: reasoningEndAt.map((x) => x.at - streamT0),
              firstOtherStartMs: firstOtherStartAt === null ? null : firstOtherStartAt - streamT0,
              firstOtherType,
              finishMs: finishAt - streamT0,
              // 关键读数：>1000 ⇒ 有免费窗口；≈0 且 finish−lastEnd≈0 ⇒ 宿主攒完再发，无窗口
              otherStartToLastEndMs: firstOtherStartAt === null ? null : lastEnd - firstOtherStartAt,
              lastEndToFinishMs: finishAt - lastEnd,
            })
          }
          if (pending.length) {
            if (hardStop) {
              // 异常/中断：绝不等待，立即降级放行
              for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task)) yield c
            } else {
              // 收网：多块**并行**兑现（总耗时 ≈ 单块），再按 index 升序放行
              // ★ 2026-09-21 共享绝对截止（外部审计 P0-2）：先把所有待收网任务的进入时刻
              //   钉成同一个值，保证多块并行收网共用【一个】budget，而不是每块各拿一份。
              //   （Promise.all 本已并发，这里把它变成显式不变量，防止将来改成串行时静默劣化。）
              const sharedEnterAt = Date.now()
              for (const t of pending) t.finishEnterAt = sharedEnterAt
              // ★ 2026-09-21 并行块的有序归并（外部评审）：蒸馏是并发的，
              //   「较早块→蒸馏较晚完成」完全可能。**出站与记忆都必须按源块顺序**，
              //   绝不能按 promise 完成顺序 —— 那会让旧状态压回新状态。
              const settled = await Promise.all(pending.map(async (task) => {
                try { return { sourceIndex: task.index, r: await birthFinish(task, settleDeps), task } }
                catch (e) {
                  trace('birth-settle-error', { index: task.index, error: String((e && e.message) || e) })
                  return { sourceIndex: task.index, r: null, task }
                }
              }))
              // ① 出站：按源块 index 升序（原有不变量，保持）
              const ordered = settled.slice().sort((a, b) => a.sourceIndex - b.sourceIndex)
              for (const s of ordered) if (s.r) for (const c of s.r.chunks) yield c
              // ② 记忆：同样按源块顺序归并；失败块被跳过，不污染记忆
              // ⚠ 关闭 stateMemory 时**绝不**归并或消费新格式记忆（回滚语义）
              if (compileModeOf(cfg) === 'memory') {
                try {
                  const merged = mergeOrdered(ordered.map((s) => ({
                    sourceIndex: s.sourceIndex,
                    ok: !!(s.task && s.task.distillState && s.task.distillState.ok && s.task.distillState.entries),
                    parsed: s.task && s.task.distillState && s.task.distillState.parsed ? s.task.distillState.parsed : null,
                    at: sharedEnterAt,
                  })).filter((x) => x.ok))
                  if (merged.entries.length) {
                    trace('state-memory-merged', {
                      blocks: merged.order,
                      entries: memoryStats(merged.entries),
                    })
                  }
                } catch (e) {
                  trace('state-memory-merge-error', { error: String((e && e.message) || e) })
                }
              }
            }
            pending.length = 0
          }
          // 源流没给 block-end 的块：绝不补造（源流没关就不许我们关）
          held.clear()
          yield chunk
          continue
        }
        yield chunk
      }
    } catch (e) {
      sourceError = e
    }
    // 源流结束/抛错时仍未收网的 task：立即降级放行（原文 + 句柄）
    for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task)) yield c
    pending.length = 0
    held.clear()
    if (sourceError) throw sourceError
  })()
}
