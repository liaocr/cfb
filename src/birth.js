// dsh-cot-form-b / birth.js —— 出生即压缩（mode: 'birth'，唯一生产路径）
//
//   birthTransform  包装 llm/stream：reasoning delta 实时透传，block-end 起火，finish 前限时收网
//   birthStart      block-end 处同步起火：内存算句柄 → CAS 归档 ∥ 副模型压缩 并发起飞（绝不 await）
//   birthFinish     finish 处收网：句柄落盘 && 压缩成功 && 净省达标 ⇒ 改写；否则原文(+句柄)放行
//   birthEconomics  成本模型（只记录，不参与判定）
//   readPressure    此刻物理水位（官方 tokenMeter；拿不到就如实标 source）
import crypto from 'node:crypto'
import { fidelity, inventedIdentifiers } from './fidelity.js'
import { settledTraceData } from './trace.js'
import { estimateTokens } from './tokens.js'
import { turnCallsBlock, spliceProgramParts, programPartsText } from './compile-v4.js'   // v12.9.1：I2 闸的出处集合并入程序算出的【验收提示】（S10.14）；v12.9.2：finish 处按本轮调用拼提示

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

/**
 * ★★ P0-2 句柄读回探针（birth 侧）★★
 *
 * 背景：`deriveArtHandle()` 是**内存预推**——它在 putText 之前就把句柄算好了（方案一 优化1）。
 * 这条快路的正确性完全押在「本机推导 ≡ 兄弟包推导」上，而那份等价测试在兄弟包不在本机时**整条跳过**。
 * 公式一旦漂移，我们会拿一根**谁也读不回**的地址去登记归档，而且不会有任何报错。
 *
 * 判据（保守）：`true` = 有正面证据能取回；`false` = 正面证据取不回；`null` = 不可证（无读 API / 超时 / 抛错）。
 * 调用点只在「store 说写成功但没给句柄」这条罕见分支上，所以绝不给主流加延迟。
 */
async function probeDerivedHandle(deps, handle, text, sessionId) {
  const probe = deps && deps.probeHandle
  if (typeof probe !== 'function') return { ok: false, reason: 'no-probe' }
  const cfg = (deps && deps.cfg) || {}
  const ms = Number.isFinite(cfg.birthHandleProbeTimeoutMs) ? Math.max(1, cfg.birthHandleProbeTimeoutMs) : 800
  try {
    const r = await birthDeadline(Promise.resolve().then(() => probe(handle, text, sessionId)), ms)
    if (r === true) return { ok: true, reason: 'probe-resolved' }
    if (r === false) return { ok: false, reason: 'probe-unresolvable' }
    return { ok: false, reason: r == null ? 'probe-timeout' : 'probe-inconclusive' }
  } catch (e) {
    return { ok: false, reason: 'probe-error:' + String((e && e.message) || e) }
  }
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

/**
 * ★ v11.10 取消在飞提纯的唯一实现（birthFinish 放行、flush 降级、消费者提前退出三处共用）。
 *   判据严格：只有【本任务确实起了提纯】且【它还没落地】时才取消 —— 已落地的结果绝不取消。
 *   v11.10 前 flush / 提前退出两条路径完全不取消 ⇒ 请求一直跑到 timeoutMs（线上 20s），白付一次调用。
 */
export function birthCancelFlying(task, cfg = {}, trace = () => {}, why = 'give-up') {
  if (!task || !task.abort || task.distillState !== null || !task.distillP) return false
  if (cfg.birthCancelOnGiveUp === false) return false
  if (task.abort.signal && task.abort.signal.aborted) return false
  try { task.abort.abort() } catch { /* ignore */ }
  try {
    trace('birth-distill-cancelled', {
      index: task.index, why,
      waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0,
    })
  } catch { /* 观测失败绝不影响主流 */ }
  return true
}

/** 把结算稿组装成下游该看到的 chunk 序列（live 模式只发改写后的 block-end）。 */
function birthEmitChunks(task, text, deps) {
  const chunks = []
  if (!deps.live) chunks.push({ type: 'reasoning-delta', index: task.index, text })
  if (task.end) {
    // ★ 2026-09-27 审计：**原样放行 = 原对象放行**。此前放行路径也会重建 block-end 并用 delta 累积值
    //   覆盖宿主的 block.text —— 一旦两者不一致（宿主规范化、丢 delta、带 signature 的思考块），
    //   「原样透传」就不再原样，而且没有任何留痕。现在只有真正改写时才重建 chunk。
    if (text === task.raw) { chunks.push(task.end); return chunks }
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
 * ★ 2026-09-27 审计：birthStart / birthFinish 内部的 trace 包装。
 *   trace 是观测，观测失败（JSON.stringify 遇到 BigInt/循环引用、statsOf 抛错…）不得变成主流异常。
 *   此前两处 trace 包装都不吞错：block-end 处同步抛 ⇒ 生成器抛 ⇒ **主模型流被插件打断**；
 *   finish 处抛 ⇒ birthFinish reject ⇒ 该块的 block-end 被静默丢弃（违反 invariant.js:53）。
 */
function safeTrace(deps, extra) {
  const t = deps && deps.trace
  if (typeof t !== 'function') return () => {}
  return (tag, data) => { try { return t(tag, { ...data, ...extra }) } catch { return null } }
}

/**
 * ★ 成本模型（2026-09-23 v11.6，纯函数，只用于观测与自测）。
 *   净收益 = (R−1)·d·(B−B′) − T − 5·B′
 *   ρ_max  = [(R−1)·d − T/B] / [5 + (R−1)·d]      允许的最大压缩后占比
 *   B_abs  = T / ((R−1)·d)                          绝对下界：低于它无论多压都亏
 *   B_min  = B′_est / ρ_max                         保本原长（B′_est 冷启动 = compressTargetMax）
 *   R_est  = 剩余窗口 / 每轮增量；增量取不到 ⇒ R 回落 econR（60，2026-09-24 用户拍板），rSource='fallback'
 * @param B 原文字符数
 * @param pressure {usedTokens, contextWindow, source} | null（readPressure 形状）
 */
export function birthEconomics(B, pressure, cfg = {}) {
  const d = Number.isFinite(cfg.econCacheDiscount) ? cfg.econCacheDiscount : 0.02
  const T = Number.isFinite(cfg.econTemplateChars) ? cfg.econTemplateChars : 460
  const Rfb = Number.isFinite(cfg.econR) ? cfg.econR : 60   // 用户拍板：复用轮数 R=60（原 55 为生产实测压缩间隔，凭据见 docs/analysis/AUDIT-V11.5.md）
  const perTurn = Number.isFinite(cfg.econCharsPerTurn) && cfg.econCharsPerTurn > 0 ? cfg.econCharsPerTurn : null
  const bPrime = Number.isFinite(cfg.compressTargetMax) ? cfg.compressTargetMax : 450
  if (!(B > 0)) return null
  let R = Rfb, rSource = 'fallback', remainingTokens = null
  if (pressure && Number.isFinite(pressure.usedTokens) && Number.isFinite(pressure.contextWindow) && perTurn) {
    remainingTokens = Math.max(0, pressure.contextWindow - pressure.usedTokens)
    const est = Math.floor((remainingTokens * 4) / perTurn)   // 4 字符/token 粗估，与 CHARS_PER_TOKEN 同口径
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

/** 兜底用的字符/token 比（无计量服务时才用，且会落 trace 标明来源）。 */
const CHARS_PER_TOKEN = 4

/**
 * 此刻物理水位（v12.1 从已删除的 emitter.js 搬来，供 birth-econ 观测）。
 * 任何一步拿不到就诚实地把来源记下来，绝不假装知道。
 * @returns { usedTokens, contextWindow, source } source ∈ meter|estimated|none
 */
export function readPressure(deps) {
  const { session, ctx, surfaceChars } = deps
  let contextWindow
  try { contextWindow = session && session.requestContext && session.requestContext() && session.requestContext().contextWindow } catch { contextWindow = undefined }
  if (!Number.isFinite(contextWindow)) contextWindow = undefined

  // 首选官方计量服务
  try {
    const meter = ctx && typeof ctx.get === 'function' ? ctx.get('tokenMeter', false) : null
    if (meter && typeof meter.measure === 'function') {
      const m = meter.measure(session)
      const used = m && (m.usedTokens != null ? m.usedTokens : (m.pressureTokens != null ? m.pressureTokens : m.surfaceTokens))
      if (Number.isFinite(used) && Number.isFinite(contextWindow)) return { usedTokens: used, contextWindow, source: 'meter' }
    }
  } catch { /* 降级，不抛 */ }

  // 降级：字符估算（只在窗口可读时才有意义）
  if (Number.isFinite(contextWindow) && Number.isFinite(surfaceChars)) {
    return { usedTokens: Math.ceil(surfaceChars / CHARS_PER_TOKEN), contextWindow, source: 'estimated' }
  }
  return { usedTokens: undefined, contextWindow: contextWindow, source: 'none' }
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
  const trace = safeTrace(deps, { taskId })
  const raw = String(entry.text || '')
  const floor = cfg.birthMinChars == null ? 500 : cfg.birthMinChars
  const sessionId = typeof deps.sessionId === 'function' ? deps.sessionId() : (deps.sessionId || null)
  const task = {
    taskId, index: entry.index, raw, end: entry.end || null, sessionId,
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
  // v12.2 v4 增量编译：block-end 之前已经起飞的分段编译器。任何不压缩的出口都必须掐掉它。
  const seg = entry.seg && typeof entry.seg.finish === 'function' ? entry.seg : null
  const dropSeg = (why) => { if (seg) { try { seg.cancel(why) } catch { /* ignore */ } } }
  if (cfg.enabled === false || cfg.mode === 'off' || cfg.dryRun === true) { dropSeg('disabled'); task.belowFloor = true; task.why = cfg.dryRun ? 'dry-run' : 'disabled'; return task }
  // ★ v11.10 与语言无关的门槛（opt-in）：birthMinTokens 为正数时按 token 估算判定、完全接管字符门槛。
  //   缺省 null ⇒ 行为与 v11.9 逐字一致（仍按 birthMinChars 判）。
  const minTokens = Number.isFinite(cfg.birthMinTokens) && cfg.birthMinTokens > 0 ? cfg.birthMinTokens : null
  const tooShort = minTokens != null ? estimateTokens(raw) < minTokens : raw.length < floor
  if (!raw.trim() || tooShort) { dropSeg('below-floor'); task.belowFloor = true; task.why = 'below-floor'; return task }
  if (cfg.birthArchive === false) { dropSeg('archive-off'); task.belowFloor = true; task.why = 'archive-off'; return task }
  // ★ 2026-09-23 v11.6 成本模型字段（**只记录，不参与判定**；见 docs/analysis/AUDIT-V11.5.md §一）。
  //   目的：为「按剩余窗口动态门槛」积累标定数据（R_est 的每轮增量尚未标定，直接接管会抖动）。
  try {
    const econ = birthEconomics(raw.length, typeof deps.pressure === 'function' ? deps.pressure() : null, cfg)
    if (econ) { econ.rawTokensEst = estimateTokens(raw); task.econ = econ; trace('birth-econ', { index: entry.index, ...econ }) }
  } catch { /* 观测失败绝不影响主流 */ }
  const archive = deps.archive
  if (typeof archive !== 'function') { dropSeg('no-store'); task.belowFloor = true; task.why = 'no-store'; return task }

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
  // v12.2：有分段编译器 ⇒ 压缩 = 把最后一段送出并合并各段（task.partial 供收网到点时取「已编译前缀 + 原文尾巴」）
  const distill = seg
    ? (text, signal, b) => seg.finish(text, signal, { onHeaders: b && b.onHeaders, v4Budget: deps.v4Budget })
    : deps.distill
  if (seg) { task.seg = seg; task.partial = () => seg.partial(raw, deps.v4Budget) }
  const dsignal = task.abort ? task.abort.signal : undefined
  // ★ v11.7 响应头信号：蒸馏一收到响应头就 resolve（排队结束、正在生成）。供 birthFinish 收尾宽限使用。
  let headersResolve = null
  task.headersAt = null
  task.headersP = new Promise((r) => { headersResolve = r })
  const noteHeaders = (info) => { if (info && info.status != null && info.status !== 200) return; if (task.headersAt === null) { task.headersAt = Date.now(); trace('birth-distill-headers', { index: task.index, ttfbMs: info && info.ttfbMs, sinceFiredMs: task.firedAt ? task.headersAt - task.firedAt : null }); headersResolve(true) } }
  // 输入 = 本段 reasoning 原文，不背任何窗口证据（v12.1 起只剩 compress 一种编译模式）。
  trace('compiler-preparation-cost', { ms: performance.now() - preparationStarted })
  task.distillP = (typeof distill === 'function'
    ? Promise.resolve().then(() => distill(raw, dsignal, { onHeaders: noteHeaders, taskId, trace }))
    : Promise.reject(new Error('no-distiller')))
    .then((r) => {
      const text = r && r.text != null ? String(r.text).trim() : ''
      if (!text) throw new Error('empty distillate')
      return { ok: true, text, meta: (r && r.meta) || null }
    })
    .catch((e) => {
      // ★ 2026-09-21 补漏：这里原本把 `e.meta` 丢了 ⇒ **超时/取消**这条最该诊断的路径
      //   一个阶段字段都落不了盘。现在原样带出去。
      const em = (e && e.meta) || null
      trace('birth-distill-failed', Object.assign(
        { index: task.index, error: String((e && e.message) || e) },
        em ? {
          ttfbMs: em.ttfbMs, totalMs: em.totalMs, chunks: em.chunks, reused: em.reused,
          status: em.status, cancelled: em.cancelled, stream: em.stream === true ? true : undefined,
          toFirstEventMs: em.toFirstEventMs, toFirstContentMs: em.toFirstContentMs,
          contentSpanMs: em.contentSpanMs, eventCount: em.eventCount,
          v4: em.v4,
        } : {}))
      return { ok: false, error: String((e && e.message) || e), meta: em }
    })
    .then((s) => {
      task.distillState = s
      task.distillMs = task.firedAt ? Date.now() - task.firedAt : null
      // 提纯终局失败 ⇒ 必定原文放行 ⇒ 没有理由再等（归档仍在后台继续）
      if (!s.ok) noteShort('distill-failed-early')
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
  const trace = safeTrace(deps, { taskId: task.taskId || null })
  const raw = String(task.raw || '')
  // ★★ 2026-09-18 用户令：句柄标记从上下文中【彻底删除】，一个字符都不许出现。★★
  //   理由（血的教训）：模型对着一根裸指针无法思考。替换文本必须携带【语义内容】：
  //     A 态 → 宿主模型提纯出的语义摘要；B 态 → 原文逐字。
  //   句柄只用于 CAS 归档登记（磁盘上的证据索引），绝不写进模型可见的文本。
  //   （v11.10：据此退役 birthHandleInText —— 它自 2026-09-18 起就不再有任何效果。）
  // ★★ 2026-09-18 终审（用户令）——兜底 = 原文逐字，句柄绝不进上下文 ★★
  //   事故复盘：曾把兜底改成「裸句柄指针」，导致模型失去自身思维链、
  //   对着一根指针无法思考。该做法已永久废除。
  //   现行语义：能提纯 ⇒ 语义摘要（A 态）；超时/失败/不划算 ⇒ 原文逐字（B 态）。
  //   句柄仅用于 CAS 归档登记与磁盘证据索引，绝不写进模型可见文本。
  // ★ 2026-09-21 放弃应用 ⇒ 掐掉仍在飞的提纯（外部审计 P0-2）。
  //   判据严格：只有【本任务确实起了提纯】且【它还没落地】时才取消 —— 已落地的结果
  //   绝不取消（那是已经付过的钱）。
  //   （v12.1：迟到认领已删除 ⇒ 放行即取消，不再有「留给下一轮」的消费者。）
  const cancelFlying = (why) => birthCancelFlying(task, cfg, trace, why)

  const pass = (why, handle, extra) => {
    const text = raw
    const waitedMs = task.finishEnterAt ? Date.now() - task.finishEnterAt : 0
    const cancelled = cancelFlying(why)
    trace('birth-passthrough', { index: task.index, why, rawChars: raw.length, outChars: text.length, handle: handle || null, waitedMs, short: task.shortReason || null, cancelled, ...(extra || {}) })
    return { chunks: birthEmitChunks(task, text, deps), text, why, rawChars: raw.length, outChars: text.length, handle: handle || null }
  }

  if (task.belowFloor) return pass(task.why || 'below-floor', null)

  task.finishEnterAt = Date.now()
  trace('birth-finish-enter', { index: task.index, gapMs: task.finishEnterAt - (task.firedAt || 0) })
  const budgetMs = cfg.birthFinishWaitMs == null ? 1500 : cfg.birthFinishWaitMs
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
  // ★★ P0-2（2026-09-24）：句柄必须**可归因**。★★
  //   store 回给我们的句柄 = 权威（它自己写的，它自己认）；
  //   内存预推的 task.handle = **预测**，只在读回验证给出正面证据后才允许当成句柄用。
  //   预测错 ⇒ 原文会被换成一根读不回的地址（且无任何报错）⇒ 宁可当归档失败、保留原文。
  let handle = null
  let handleSource = null
  if (disk && disk.ok) {
    if (typeof disk.handle === 'string' && disk.handle) { handle = disk.handle; handleSource = 'store-returned' }
    else if (task.handle) {
      const v = await probeDerivedHandle(deps, task.handle, raw, task.sessionId)
      if (v.ok) { handle = task.handle; handleSource = 'derived-verified'; trace('birth-handle-derived-verified', { index: task.index, handle: task.handle }) }
      else {
        trace('birth-handle-unverified', { index: task.index, reason: v.reason, derived: task.handle })
        return pass('handle-unverified', null)
      }
    }
  }
  if (handle && handleSource) trace('birth-handle-source', { index: task.index, source: handleSource })

  // 铁律③：拿不到句柄（或写盘未落地）⇒ 绝不替换原文
  if (!handle) return pass(task.shortReason || (disk === null ? 'archive-timeout' : 'archive-failed'), null)

  // v12.2 v4 增量编译：整块没在收网窗口内完成 ⇒ 取「已编译前缀 + 原文尾巴」，照样走下面全部闸门
  let partial = null
  if (dist === null && typeof task.partial === 'function') {
    try { partial = task.partial() } catch (e) { partial = null; trace('birth-partial-error', { index: task.index, error: String((e && e.message) || e) }) }
    if (partial && !(partial.text && partial.partial)) partial = null
  }
  // 零 rules：只有宿主模型提纯成功且净省够本才替换
  if ((dist && dist.ok) || partial) {
    let candidate = partial ? partial.text : dist.text
    // v12.9.2：多轮稿的验收提示只能在 finish 处算（本轮调用此时才齐）：把【本轮已发出的调用】接到 ctx 后拼进稿，闸门也按这份 ctx 判
    let cfgAcc = cfg
    if (Array.isArray(task.turnCalls) && task.turnCalls.length && /【台账】/.test(String(cfg.compressCtx || '')) && !/【本轮已发出的调用】/.test(String(cfg.compressCtx || ''))) {
      try {
        const block = turnCallsBlock(task.turnCalls)
        if (block) {
          const ctx2 = String(cfg.compressCtx) + '\n\n' + block
          const st = {}
          const spliced = spliceProgramParts(candidate, ctx2, st)
          if (spliced !== candidate) { candidate = spliced; trace('birth-hints-spliced', { index: task.index, hints: st.splicedHints || 0, calls: task.turnCalls.length }) }
          cfgAcc = { ...cfg, compressCtx: ctx2 }
        }
      } catch (e) { try { trace('birth-hints-error', { index: task.index, error: String((e && e.message) || e) }) } catch { /* ignore */ } }
    }
    // v12.7：闸门判定抽成纯函数 birthAccept（工具 compile-direct 同一份判定 ⇒ 评测稿在真机会不会被放行，离线就能看到）
    const acc = birthAccept(raw, candidate, cfgAcc)
    if (!acc.ok) return pass(acc.why, handle, acc.info)
    const { netSaved, minSaved, tokens, netSavedTokensEst } = acc
    // ★ 2026-09-23 v11.6 保真观测（**只记录，不拦截**）：逐字标识符召回率。
    //   受保护 token 集为空 ⇒ unmeasurable（不能算 pass，单独统计）。门槛待离线分布 + 白付成本模型后再定。
    let fid = null
    try {
      const f = fidelity(raw, candidate)
      fid = f.stats.protectedTokens === 0
        ? { identifierRecall: null, protectedTokens: 0, lostTokens: 0, unmeasurable: true }
        : { identifierRecall: f.stats.tokenRecall, protectedTokens: f.stats.protectedTokens, lostTokens: f.stats.lostTokens, lostSample: f.stats.lostSample, unmeasurable: false }
    } catch { fid = null }
    if (partial) {
      // 已决定用部分结果 ⇒ 仍在飞的分段（尾段）不再有用
      birthCancelFlying(task, cfg, trace, 'partial-used')
      trace('birth-condensed', { index: task.index, why: 'condensed-partial', rawChars: raw.length, outChars: candidate.length, netSaved, minSaved, ...tokens, handle,
        waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0, fidelity: fid, econ: task.econ || null, v4: partial.stats })
      return { chunks: birthEmitChunks(task, candidate, deps), text: candidate, why: 'condensed-partial', rawChars: raw.length, outChars: candidate.length, netSaved, netSavedTokensEst, handle }
    }
    trace('birth-condensed', { index: task.index, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, minSaved, ...tokens, handle, waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0, fidelity: fid, econ: task.econ || null,
      distillMs: task.distillMs ?? null, promptVersion: dist.meta?.promptVersion || null, v4: dist.meta?.v4 || null })
    return { chunks: birthEmitChunks(task, candidate, deps), text: candidate, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, netSavedTokensEst, handle }
  }
  return pass(dist === null ? 'distill-timeout' : 'distill-failed', handle, { error: (dist && dist.error) || null })
}

/**
 * v12.7：候选替换稿的闸门判定（纯函数；birthFinish 与 tools/compile-direct 共用）。
 *   empty-candidate    空白（DeepSeek 带 tools 的请求要求历史 assistant 带 reasoning_content，空白 = 丢失该轮思维链，H8 事故同形）
 *   invented-identifier v12.1 发明标识符闸（I2）：出处 = 原文 + 本回合观察（cfg.compressCtx）；模板工具接口词不算（fidelity.GATE_ALLOW）
 *   no-token-gain      v11.10：字符净省达标但估算 token 不降（英文原文 → 中文摘要）
 *   no-gain            净省不足 birthMinSavedChars（缺省 50）
 * @returns {{ ok:boolean, why?:string, info?:object, netSaved:number, minSaved:number, tokens:object, netSavedTokensEst:number }}
 */
export function birthAccept(raw, candidate, cfg = {}) {
  const r = String(raw || ''), c = String(candidate == null ? '' : candidate)
  const netSaved = r.length - c.length
  const minSaved = cfg.birthMinSavedChars == null ? 50 : cfg.birthMinSavedChars
  const rawTokensEst = estimateTokens(r), outTokensEst = estimateTokens(c), netSavedTokensEst = rawTokensEst - outTokensEst
  const tokens = { rawTokensEst, outTokensEst, netSavedTokensEst, unit: 'estimate-not-tokenizer' }
  const base = { netSaved, minSaved, tokens, netSavedTokensEst }
  if (!c.trim()) return { ok: false, why: 'empty-candidate', info: undefined, ...base }
  if (cfg.birthIdentifierGate !== false) {
    let invented = []
    try { invented = inventedIdentifiers(r, c, { extra: (cfg.compressCtx || '') + '\n' + programPartsText(cfg.compressCtx || '') }) } catch { invented = [] }   // v12.9.2：程序部件（延续段 / 提示 / 三问）的片段都由 ctx 推出，算出处
    if (invented.length) return { ok: false, why: 'invented-identifier', info: { invented }, ...base }
  }
  const minSavedTokens = Number.isFinite(cfg.birthMinSavedTokens) && cfg.birthMinSavedTokens > 0 ? cfg.birthMinSavedTokens : 1
  if (netSaved >= minSaved && cfg.birthTokenGate !== false && netSavedTokensEst < minSavedTokens) {
    return { ok: false, why: 'no-token-gain', info: { netSaved, minSaved, ...tokens, minSavedTokens }, ...base }
  }
  if (netSaved < minSaved) return { ok: false, why: 'no-gain', info: { netSaved, minSaved, ...tokens }, ...base }
  return { ok: true, ...base }
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
  // ★ 2026-09-27 审计：生成器内所有观测 trace 都不得抛（同 safeTrace 语义）
  const trace = safeTrace(deps)
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
    // v12.9.2：本轮流过的工具调用（reasoning 结束后才出现）——finish 处交给 birthFinish 算验收提示（理论 S10.14 K1–K6 在生产里的唯一入口）
    const turnCalls = new Map()   // index -> { name, args }
    let sourceError = null
    let prewarmed = false
    // ★ v11.10：流是否已走完自己的收尾（正常结束 / 源流抛错）。false 而进入 finally ⇒ 消费者提前退出。
    let drained = false

    // 立即降级放行（abort/异常路径，绝不等待）：无条件给出【原文逐字】（句柄不进上下文）
    // ★ v11.10：降级放行 = 放弃应用 ⇒ 同样掐掉仍在飞的提纯（此前这里不取消，请求白跑到 timeoutMs）。
    // v12.2：还没 block-end 的块若已起了分段编译，任何提前结束都要掐掉
    const dropHeldSegs = (why) => { for (const h of held.values()) if (h && h.seg) { try { h.seg.cancel(why) } catch { /* ignore */ } h.seg = null } }
    const flushTask = function* (task, why) {
      const cancelled = birthCancelFlying(task, cfg, trace, why)
      try { trace('birth-flush', { index: task.index, why, rawChars: task.raw.length, cancelled, taskId: task.taskId || null }) } catch { /* ignore */ }
      for (const c of birthEmitChunks(task, task.raw, settleDeps)) yield c
    }

    try {
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
          if (t === 'tool-call-delta' || t === 'toolcall-delta') {
            try {
              const cur = turnCalls.get(chunk.index) || { name: '', args: '' }
              if (chunk.name) cur.name = chunk.name
              cur.args += String(chunk.argumentsDelta ?? chunk.argsDelta ?? chunk.delta ?? '')
              turnCalls.set(chunk.index, cur)
            } catch { /* 观测不碰主流 */ }
            yield chunk
            continue
          }
          if (t === 'reasoning-delta') {
            const h = held.get(chunk.index)
            // live：delta 实时透传（GUI 不卡顿），同时累积原文供 block-end 结算
            if (h) {
              h.text += (chunk.text || '')
              // v12.2 v4 增量编译：主模型还在思考时就开始分段标注（切段判断 O(1)；失败绝不影响主流）
              if (typeof deps.segmenter === 'function') {
                try { if (!h.seg) h.seg = deps.segmenter(chunk.index); if (h.seg) h.seg.feed(h.text) }
                catch (e) { h.seg = null; try { trace('v4-segment-error', { index: chunk.index, error: String((e && e.message) || e) }) } catch { /* ignore */ } }
              }
              yield chunk; continue
            }
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
              // ★ 2026-09-27 审计（不变式③ 观测不碰主流）：起火本身抛错 ⇒ 这块按「从未介入」处理，原 chunk 原样放行。
              //   此前同步异常会从生成器冒出去，主模型流被插件内部错误打断（自测 p11 复现）。
              let task
              try { task = birthStart(h, settleDeps) } catch (e) {
                try { trace('birth-start-error', { index: chunk.index, error: String((e && e.message) || e) }) } catch { /* ignore */ }
                yield chunk
                continue
              }
              if (task.belowFloor) {
                // 无需异步工作 ⇒ 立即放行，零延迟
                // ★ 2026-09-27 决议阶段 0（DECISION-2026-09-27 §5 N2）：此前门槛之下的块在 trace 里**完全不可见**，
                //   于是 rawChars 分布（回本门槛唯一的实测依据）三轮文档都拿不到。只记长度与原因，不记正文。
                trace('birth-below-floor', { index: chunk.index, rawChars: task.raw.length, why: task.why || 'below-floor' })
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
                for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task, 'hard-stop:' + reason.kind)) yield c
              } else {
                // 收网：多块**并行**兑现（总耗时 ≈ 单块），再按 index 升序放行
                // ★ 2026-09-21 共享绝对截止（外部审计 P0-2）：先把所有待收网任务的进入时刻
                //   钉成同一个值，保证多块并行收网共用【一个】budget，而不是每块各拿一份。
                //   （Promise.all 本已并发，这里把它变成显式不变量，防止将来改成串行时静默劣化。）
                const sharedEnterAt = Date.now()
                const calls = [...turnCalls.values()].filter((c) => c.name)
                for (const t of pending) { t.finishEnterAt = sharedEnterAt; t.turnCalls = calls }
                // ★ 2026-09-21 并行块的有序归并（外部评审）：蒸馏是并发的，
                //   「较早块→蒸馏较晚完成」完全可能。**出站与记忆都必须按源块顺序**，
                //   绝不能按 promise 完成顺序 —— 那会让旧状态压回新状态。
                const settled = await Promise.all(pending.map(async (task) => {
                  try { return { sourceIndex: task.index, r: await birthFinish(task, settleDeps), task } }
                  catch (e) {
                    try { trace('birth-settle-error', { index: task.index, error: String((e && e.message) || e) }) } catch { /* ignore */ }
                    return { sourceIndex: task.index, r: null, task }
                  }
                }))
                // ① 出站：按源块 index 升序（原有不变量，保持）
                // ★ 2026-09-27 审计：收网抛错的块 ⇒ **原文放行**（与 flushTask 同语义：取消在飞 + 原 chunk）。
                //   此前 `if (s.r)` 直接跳过 ⇒ 该块的 block-end 永远不出站 ⇒ finish 时有未关闭块
                //   （dsh-llm invariant.js:53）⇒ 宿主抛错。不变式③要求内部异常只能降级为原样重放。
                const ordered = settled.slice().sort((a, b) => a.sourceIndex - b.sourceIndex)
                for (const s of ordered) {
                  if (s.r) { for (const c of s.r.chunks) yield c; continue }
                  for (const c of flushTask(s.task, 'settle-error')) yield c
                }
              }
              pending.length = 0
            }
            // 源流没给 block-end 的块：绝不补造（源流没关就不许我们关）
            dropHeldSegs('finish-unclosed')
            held.clear()
            yield chunk
            continue
          }
          yield chunk
        }
      } catch (e) {
        sourceError = e
      }
      // 源流结束/抛错时仍未收网的 task：立即降级放行（原文逐字）
      const flushWhy = sourceError ? 'source-error' : 'no-finish'
      for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task, flushWhy)) yield c
      pending.length = 0
      dropHeldSegs(flushWhy)
      held.clear()
      drained = true
      if (sourceError) throw sourceError
    } finally {
      // ★ v11.10 消费者提前退出（用户取消 / 宿主 break / return()）：生成器不会再走到上面的收尾，
      //   pending 里的提纯会一直跑到 timeoutMs。本块从未出站 ⇒ 迟到结果不可能被认领 ⇒ 一律取消。
      if (!drained) dropHeldSegs('consumer-return')
      if (!drained && pending.length) {
        for (const task of pending) birthCancelFlying(task, cfg, trace, 'consumer-return')
        try { trace('birth-consumer-return', { pending: pending.length }) } catch { /* ignore */ }
        pending.length = 0
      }
    }
  })()
}
