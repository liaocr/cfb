// dsh-cot-form-b / plugin.js —— Cordis 插件入口：apply() 注册两个钩子，把各模块接起来
//
//   agent/pre-step  捕获会话（session-tracker.js），供 CAS 归档登记会话归属与流归属判定
//   llm/stream      只读观测（消息溯源 / 宿主模型跟随 host-follow.js）；birth 模式包装主流（birth.js）
//
// v12.1：checkpoint 模式、迟到认领、memory 模式随「单一路径」整理删除（可从 git 取回，见 CHANGELOG）。
// 纪律：任何观测或内部异常都不许影响宿主；主流自己的错误原样抛出。
// SELF_ID / DEP_ID：模块首次求值时从磁盘读到的 size@mtime，写进 BOOT，用来证明「网关里跑的是哪一版文件」。
import fs from 'node:fs'
import { birthTransform, deriveArtHandle, readPressure } from './birth.js'
import { bootRecord } from './boot-record.js'
import { normalizeConfig } from './config.js'
import { makeBirthCompiler, makeV4SegmentCompiler } from './distill.js'
import { v4Incremental, v4Budget } from './prompts.js'
import { createSegmenter } from './segment-v4.js'
import { mkHandleProbe } from './handle-probe.js'
import { createHostFollower } from './host-follow.js'
import { streamProvenanceRecord, buildCompressCtx } from './messages.js'
import { createSessionTracker } from './session-tracker.js'
import { makeTraceWriter } from './trace.js'
import { makePrewarmer } from './transport.js'

// 兼容：mkHandleProbe 自 v11.11 起住在 handle-probe.js；老的 import 路径继续可用
export { mkHandleProbe }

// ── 模块身份证据（★ 2026-09-17 新增）─────────────────────────────────────────
// 两次生产崩溃（06:14:04Z / 07:11:23Z）的根因都是同一个**不可证断言**：
//   「网关里跑的到底是哪一版模块」。
// 原来的上岗判据是 `emitting` 这个手写常量 —— 旧模块会照打一模一样的字，
// 因此它**证明不了任何事**（这正是 07:11 那次崩溃的直接成因）。
// 现在改为记录**模块首次求值那一刻**从磁盘读到的 size/mtimeMs：
//   · 网关里若是旧模块（Node ESM 缓存命中），它根本没有这段代码 ⇒ BOOT 里不会有 selfId；
//   · 出现 selfId 且与磁盘现值逐字一致 ⇒ 新模块确实上岗，可直接 grep 复验。
const SELF_ID = (() => {
  try { const s = fs.statSync(new URL(import.meta.url)); return s.size + '@' + Math.round(s.mtimeMs) } catch { return 'unknown' }
})()
// DEP_ID：src/ 下**全部**其他模块（自动枚举 + 排序）。v11.8 前是手写清单，曾漏掉模块
//   —— 新增模块忘了登记，BOOT 就证明不了它上岗。现在目录里有什么就报什么；包入口 ../index.js 一并列出。
export const DEP_ID = (() => {
  const stamp = (url, label) => {
    try { const s = fs.statSync(url); return label + '=' + s.size + '@' + Math.round(s.mtimeMs) } catch { return label + '=?' }
  }
  let files = []
  try { files = fs.readdirSync(new URL('./', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'plugin.js').sort() } catch { /* 读不到目录 ⇒ 只报入口 */ }
  return [stamp(new URL('../index.js', import.meta.url), 'index.js')]
    .concat(files.map((f) => stamp(new URL('./' + f, import.meta.url), f)))
    .join(' ')
})()

/** v12.7：v4 压缩时把本回合的任务与工具观察带给压缩器（逐字核真 / 落点绑定的依据）；显式 compressCtx 不覆盖；任何异常 ⇒ 原配置 */
export function compressCtxFor(callCfg, options) {
  if (!callCfg || callCfg.compressPrompt !== 'v4' || callCfg.compressCtxAuto === false || callCfg.compressCtx) return callCfg
  try {
    const ctx = buildCompressCtx(options && options.messages, { maxChars: callCfg.compressCtxMaxChars })
    return ctx ? { ...callCfg, compressCtx: ctx } : callCfg
  } catch { return callCfg }
}

export const name = 'cot-form-b'
export const inject = []

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  // ★ 2026-09-18：traceFile 父目录首次写之前递归建；建失败照样不阻断宿主，只吞掉证据。
  // ★ 2026-09-21：trace writer 是导出的工厂（makeTraceWriter），「写入→读回」可端到端测试。
  const trace = makeTraceWriter(cfg)
  // ★ P0-2：句柄读回探针（birth 的预推句柄验证）
  const probeHandle = mkHandleProbe(ctx, trace)
  // v11.11：宿主模型/provider 跟随不再改写共享 cfg；流归属由 session-tracker 判定（可检测交错）
  const host = createHostFollower(cfg, trace)
  const sessions = createSessionTracker()

  trace('BOOT', bootRecord(cfg, { selfId: SELF_ID, deps: DEP_ID }))

  // ★ 传输层预热：启动时就把到网关的 TLS 通道捂热（非阻塞、失败静默、零 token：HEAD）。
  const prewarm = makePrewarmer(cfg, trace)
  prewarm('boot')

  let n = 0

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    n++
    if (!cfg.enabled) { trace('skip-disabled', { n }); return decision }
    // ★ birth 模式也要先捕获会话 —— CAS 归档要用它登记会话归属
    try { sessions.onPreStep(payload && payload.agent && payload.agent.session) } catch { /* ignore */ }
    if (cfg.mode === 'off') { trace('skip-mode-off', { n }); return decision }
    return decision
  })

  // ── llm/stream：只读观测 + birth 包装 ─────────────────────────────────────────
  // ⚠ 任何**观察**异常都不许影响主流；主流自己抛错必须原样抛出，不许吞。
  ctx.on('llm/stream', (options, next) => {
    if (!cfg.enabled || cfg.mode === 'off') return next()
    // ★★ 宿主对话模型捕获（必须在任何副模型调用之前）★★
    host.observe(options, n)
    const callCfg = host.callConfig(options)
    const owner = sessions.forStream()

    try {
      trace('llm-stream', streamProvenanceRecord({ n, options, session: owner.session, previewChars: cfg.tracePreviewChars }))
    } catch (e) { trace('llm-stream-error', { error: String((e && e.message) || e) }) }

    const inner = next()
    // ★★ mode: 'birth' —— 出生即提纯（At-Birth Interception）★★
    //   在宿主 `live.push(chunk)` 之前改写推理 ⇒ 装配出的就是压缩后的 assistant 消息，
    //   走的是【普通 append】，不碰 surfaceOp:replace，故不触发任何表面断言。
    if (cfg.mode === 'birth') {
      if (!inner || typeof inner[Symbol.asyncIterator] !== "function") {
        // 拿到的不是 async iterable 就原样返回，绝不包装（包装不认识的形状会让主模型当场失败）
        trace("birth-no-async-iter", { n, kind: inner === null ? "null" : typeof inner })
        return inner
      }
      if (cfg.dryRun) { trace('birth-dry-run-stream', { n }); return inner }
      // v11.11：流归属不可证（多会话交错）⇒ 缺省原文放行（session-tracker.js）
      if (owner.ambiguous) {
        trace('birth-session-ambiguous', { n, candidates: owner.candidates, sessionId: owner.sessionId, action: cfg.birthSessionAmbiguity })
        if (cfg.birthSessionAmbiguity !== 'latest') return inner
      }
      // Capture now: another pre-step/provider update may run before this stream
      // is consumed or before block-end. No mutable session/config lookup later.
      const streamSession = owner.session
      const streamSessionId = owner.sessionId
      // v11.11：本次调用专属配置（模型 / provider 跟随这次调用；共享 cfg 永不改写）
      // v12.7：压缩器的「当前任务与观察」上下文（理论 S8-R5/R7 的生产前提）——只读构造，失败 ⇒ 空 = 旧行为
      const streamCfg = compressCtxFor(callCfg, options)
      return birthTransform(inner, {
        cfg: streamCfg,
        trace,
        sessionId: streamSessionId,
        // ★ v11.6 成本模型观测用：此刻物理水位（birth.readPressure）。失败返回 null，绝不抛。
        pressure: () => { try { return readPressure({ session: streamSession, ctx }) } catch { return null } },
        // ★ P0-2：内存预推句柄只在读回验证通过后才允许当成句柄用（详见 mkHandleProbe 契约）
        probeHandle,
        // Mirror runs outside finish; nonblocking recovery is scheduled by pre-step.
        archive: async (text, sid) => {
          const store = (ctx.get && ctx.get("cmbStore", false)) || null
          if (!store || typeof store.putText !== "function") { trace("birth-no-store", { n }); return null }
          try {
            const ref = await store.putText(text, {
              producer: streamCfg.birthProducer || 'cot-birth',
              sessionId: sid || null,
              retention: 'session',
            })
            return (ref && ref.handle) || null
          } catch (e) {
            trace("birth-archive-error", { n, error: String((e && e.message) || e) })
            return null
          }
        },
        // 唯一压缩器 = 宿主模型按 compress 提示词（v3 / v2 / v4）压缩本段 reasoning（100% 跟随宿主 provider/model）
        distill: makeBirthCompiler(streamCfg),
        // v12.2 v4 流式增量编译：思考过程中分段标注；block-end 只剩最后一段（src/segment-v4.js）
        segmenter: v4Incremental(streamCfg)
          ? (() => { const cs = makeV4SegmentCompiler(streamCfg); return (index) => createSegmenter({ cfg: streamCfg, compileSegment: cs, trace, index }) })()
          : null,
        v4Budget: v4Budget(streamCfg),
        // ★ 优化1：句柄内存秒算（与 store.deriveHandle 同一公式，纯函数）
        deriveHandle: (sessionId, text) => deriveArtHandle(sessionId, text),
        // ★ 优化2：思考一开始就捂热连接（HEAD，零 token）
        prewarm: (why) => prewarm(why, streamCfg),
      })
    }
    return inner
  }, { prepend: true })
}
