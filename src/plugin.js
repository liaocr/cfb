// dsh-cot-form-b / plugin.js —— Cordis 插件入口：apply() 注册三个钩子并把各模块接起来
//
//   agent/pre-step  捕获会话；birth + birthDeferredClaim:true 时认领上一轮没赶上的压缩结果；checkpoint 模式发射看板
//   llm/stream      只读观测（消息溯源 / 消费计量 / 宿主模型跟随）；birth 模式包装主流（birth.js）；
//                   checkpoint 模式在 reasoning 结束时提前发起副模型调用（early-fire）
//
// 纪律：任何观测或内部异常都不许影响宿主；主流自己的错误原样抛出。
// SELF_ID / DEP_ID：模块首次求值时从磁盘读到的 size@mtime，写进 BOOT，用来证明「网关里跑的是哪一版文件」。
import fs from 'node:fs'
import { birthTransform, deriveArtHandle } from './birth.js'
import { normalizeConfig, compileModeOf } from './config.js'
import { createConsumptionMeter } from './consumption.js'
import { generateDistillation, generateStateMemory } from './distill.js'
import { runPreStepEmit, toolTextFromEvent, readPressure } from './emitter.js'
import { JUDGMENT_PROMPT_VERSION, prepareCompilerEvidence } from './evidence-ledger.js'
import { collectEvidence } from './evidence.js'
import { createExactFlights } from './exact-flights.js'
import {
  lateMemorySize, lateMemory, lateKey, lateReceiptValid, peekLateMemory, peekLateMemoryPartial,
  explainLateMiss, lateInFlightCount, acknowledgeLateMemory,
} from './late-memory.js'
import { reasoningTextOf, provenanceOf, mapMessagesToSeqs } from './messages.js'
import {
  compressPromptVersion, buildDistillPrompt, compressTargets, buildCompressPromptV3, buildCompressPrompt,
  splitCompressPrompt,
} from './prompts.js'
import { normalizeBranchId } from './snapshot-store.js'
import {
  MEMORY_POLICY_VERSION, SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION, renderCheckpoint,
  buildEvidenceEnvelope,
} from './state-memory.js'
import { makeTraceWriter } from './trace.js'
import { makePrewarmer } from './transport.js'

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
// DEP_ID：src/ 下**全部**其他模块（自动枚举 + 排序）。v11.8 前是手写清单，曾漏掉 exact-flights.js
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

export const name = 'cot-form-b'
export const inject = []

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const compilerFlights = createExactFlights()
  // compress / legacy 的传输观测：只透传 trace（compiler-transport-* / compiler-hedge-* / compiler-retry-skipped）。
  //   v11.7 前这两条路径没传，对冲真的触发了 trace 里却一条都没有。
  //   ⚠ 不传 flights：这两种模式没有 scope（证据截面只在 memory 模式存在）⇒ 共享永不命中，
  //     反而会把取消路径的传输 meta（ttfbMs/stage 等）换成合成错误，损失线上诊断数据。
  const compileRuntime = (budget) => ({ trace: budget && typeof budget.trace === 'function' ? budget.trace : undefined })
  // 出生即提纯：本轮会话 id（在 agent/pre-step 捕获，供 CAS 归档登记）
  let birthSessionId = null
  // ★ 2026-09-21 消息溯源（外部审计 P0-3）：同时持有 session 对象本身（供证据采集只读访问）。
  //   只用于【读】surface.nodes / eventAt(seq) 建立 seq 映射；绝不改任何事件。
  //   寿命与 birthSessionId 相同（同一个 agent/pre-step 里捕获）。
  let birthSession = null

  // ★ 2026-09-18 公测可移植性：traceFile 现在由 harness home 推导，其父目录默认不存在。
  //   旧代码只 catch ⇒ 在别人机器上「trace 开着但一直没写」，把证据静默丢光。
  //   这里首次写之前递归建目录；建失败照样不阻断宿主，只吞掉证据。
  // ★ 2026-09-21：trace writer 抽成导出的工厂（makeTraceWriter），使"写入→读回"
  //   的**端到端**测试成为可能。只测 meta 里有字段，挡不住"字段没进白名单"这类问题
  //   —— 本文件刚刚就栽过一次（流式阶段字段写进 meta 却没落 trace）。
  // v11.8：不再给每行附 stats —— 那组计数器只在已退役的 distill 路径里递增，birth 下恒为 0。
  const trace = makeTraceWriter(cfg)
  const consumption = createConsumptionMeter(trace)

  trace('BOOT', {
    // ★ 回滚所需版本号：关闭功能时**停止新的状态编译**，不把新格式强塞给旧解析器，
    //   已合法出站的内容保持原样，CAS 与事件日志不受影响（回滚 = 停用，不是回写历史）。
    stateMemory: cfg.stateMemory === true,
    // ★ 2026-09-22 切分：把裁决结果落在 BOOT 里，避免"开了哪个开关却不知道跑的是哪条路"
    stateCompress: cfg.stateCompress === true,
    compileMode: cfg.compileMode,
    ...(cfg.compileModeConflict ? { compileModeConflict: cfg.compileModeConflict } : {}),
    ...(cfg.configAdjusted ? { configAdjusted: cfg.configAdjusted } : {}),
    // ★ 从实际配置派生，不写死：compress 的版本由 compressPrompt 决定（v11.1 起缺省 v2）
    compilerMode: cfg.compileMode === 'memory' ? 'grounded-judgment-v2'
      : cfg.compileMode === 'compress' ? compressPromptVersion(cfg) : 'reasoning-distill',
    promptVersion: cfg.compileMode === 'memory' ? JUDGMENT_PROMPT_VERSION
      : cfg.compileMode === 'compress' ? compressPromptVersion(cfg) : null,
    retiredOptions: cfg.retiredOptions,
    unknownOptions: cfg.unknownOptions,
    ...(cfg.retiredMode ? { retiredMode: cfg.retiredMode } : {}),
    ...(cfg.invalidMode !== undefined ? { invalidMode: cfg.invalidMode } : {}),
    memoryPolicyVersion: MEMORY_POLICY_VERSION,
    stateSnapshot: cfg.stateSnapshot !== false,
    stateCoveredEvidence: cfg.stateCoveredEvidence !== false,
    stateStructuralFirst: cfg.stateStructuralFirst === true,
    birth: { finishWaitMs: cfg.birthFinishWaitMs, deferredClaim: cfg.birthDeferredClaim === true,
      ...(cfg.birthDeferredClaim === true ? { experimental: true } : {}) },
    schemaVersion: SCHEMA_VERSION, compilerVersion: COMPILER_VERSION, rendererVersion: RENDERER_VERSION,
    // ★★ 复电上岗判据（模块改动必须重启网关才生效）★★
    //   ① emitting 是**手写常量**，只能说明版本意图，**不能**证明载入的是哪一份文件；
    //   ② selfId / deps 是**模块首次求值时从磁盘读到的** size@mtimeMs ——
    //      旧模块在内存里根本不含这段代码 ⇒ 不会打印这两个字段。
    //   复电前先确认本行出现 selfId，且与 `node -e` 现读值一致。
    emitting: 'birth@llm/stream+deferredClaim@agent/pre-step+checkpoint@agent/pre-step',
    selfId: SELF_ID,
    deps: DEP_ID,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    // ★ 2026-09-17 路线 A：活跃尾部宽度（最近多少条 assistant/message 逐字保留）。
    //   官方规范 dsh-compaction/README.md:145 —— "leaves the recent tail unchanged"。
    keepTail: Number.isInteger(cfg.keepTail) && cfg.keepTail >= 1 ? cfg.keepTail : 1,
    maxCarryChars: cfg.maxCarryChars,
    emitterMinSavingsChars: cfg.emitterMinSavingsChars,
    emitterMinSavingsRatio: cfg.emitterMinSavingsRatio,
    emitterMeasureTokens: cfg.emitterMeasureTokens === true,
    minRawChars: cfg.minRawChars,
    earlyFire: cfg.earlyFire,
    timeoutMs: cfg.timeoutMs,
    graceMs: cfg.graceMs,
    maxAttempts: cfg.maxAttempts,
    hedgeAfterMs: cfg.hedgeAfterMs,
    finishHeadersGraceMs: cfg.finishHeadersGraceMs,
    birthArchive: cfg.birthArchive,
    birthMinChars: cfg.birthMinChars,
    birthHandleInText: cfg.birthHandleInText,
    birthProducer: cfg.birthProducer,
    keepAlive: cfg.keepAlive,
    keepAliveMsecs: cfg.keepAliveMsecs,
    prewarm: cfg.prewarm,
    // ★ BOOT 时 cfg.model 还只是「patch 里显式写死的那个」，followHostModel 下它会在
    //   第一次 llm/stream 时被替换成宿主对话模型 ⇒ 这里记的只是初始值，不是最终值。
    model: cfg.model,
    modelAtBoot: cfg.model,
    followHostModel: cfg.followHostModel,
    disableThinking: cfg.disableThinking,
    maxOutputTokens: cfg.maxOutputTokens,
    invariant: 'H2 首次出站不变律：块只在「还没出站」时允许替换，否则永久放弃',
  })

  // ★ 传输层预热：启动时就把到网关的 TLS 通道捂热。
  //   实测冷连接 TTFB 676ms / 复用 265ms ⇒ 这一发能把「进程内第一次调用」
  //   从冷变成温热。**非阻塞、失败静默、零 token（HEAD，不产生 completion）。**
  const prewarm = makePrewarmer(cfg, trace)
  prewarm('boot')

  let n = 0

  // ── ★★ 宿主对话模型跟随（2026-09-15 用户拍板）★★ ─────────────────────────
  //   用户原话：「宿主用哪个模型对话，我们就用那个模型压缩。」
  //   机制：`llm/stream` 的 options 里带 `provider` / `model`（= 本次对话调用用的模型），
  //        每次看到就缓存下来；`followHostModel` 开着时把 `cfg.model` 改写成它。
  //   ⚠ 不猜：`explicitModel` 是 patch 里显式写的那个（可能为空串）。
  //     - 见过宿主模型 ⇒ cfg.model = 宿主模型（跟随成立）
  //     - 没见过但有显式配置 ⇒ cfg.model 仍是显式值（**这是用户的显式选择，不是猜**）
  //     - 都没 ⇒ cfg.model 为空 ⇒ generateDistillation 直接抛 `no model:` ⇒ 原文放行
  //   ⚠ 我们的提纯调用走 `requestOnce`（node:https 直连），**不经过宿主 llm/stream**
  //     ⇒ 不存在自己污染自己（把提纯模型当成宿主模型）的风险。
  //   ⚠ 但宿主若有其他模型调用（子 agent / 标题生成）也会打这里 ⇒ 只取**最近一次**，
  //     并把 provider 一并落 trace，便于事后核对取到的是不是对话模型。
  const explicitModel = cfg.model
  let hostModel = null
  let hostProvider = null

  // ── 提前发起的结果槽（只留最近 3 个，按 reasoning 原文精确匹配）──
  const early = new Map()
  const EARLY_MAX = 3

  function fireEarly(raw) {
    if (!cfg.earlyFire || cfg.mode !== 'checkpoint') return
    if (!raw || raw.length < cfg.minRawChars) return
    // ★ 跟随宿主模型时，还没见过宿主模型就**不发起** —— 不猜模型名。
    //   直接跳过（pre-step 拿不到结果 ⇒ 原文保持）；比发一次注定失败的调用干净
    //   （不产生 `early-failed` 噪音，也不占 EARLY_MAX 槽位）。
    if (!cfg.model) {
      trace('early-no-model', { rawChars: raw.length, followHostModel: cfg.followHostModel, explicitModel })
      return
    }
    if (early.has(raw)) return
    const e = { raw, settled: false, ok: false, text: null, err: null, firedAt: Date.now(), readyAt: null, meta: null }
    e.promise = generateDistillation(raw, cfg).then((r) => {
      e.settled = true; e.ok = true; e.text = r.text; e.meta = r.meta; e.readyAt = Date.now()
      trace('early-ready', {
        rawChars: raw.length,
        tookMs: e.readyAt - e.firedAt,
        // ★ 实际用了哪个模型提纯（followHostModel 下应等于宿主对话模型）
        model: r.meta && r.meta.model,
        hostModel,
        modelSource: r.meta && r.meta.model === hostModel ? 'host' : 'config',
        thinkingOff: r.meta && r.meta.thinkingOff,
        // ★ 传输层证据：这次调用到底复用了没有、握手花了多少
        reused: r.meta && r.meta.reused,
        connectMs: r.meta && r.meta.connectMs,
        ttfbMs: r.meta && r.meta.ttfbMs,
        // ★ 模型侧证据：finish_reason 与 reasoning 长度（诊断"空提纯稿"的真因）
        finish: r.meta && r.meta.finish,
        reasoningChars: r.meta && r.meta.reasoningChars,
        endpoint: r.meta && r.meta.endpoint,
      })
    }).catch((err) => {
      e.settled = true; e.ok = false; e.err = String((err && err.message) || err)
      trace('early-failed', { rawChars: raw.length, tookMs: Date.now() - e.firedAt, error: e.err })
    })
    early.set(raw, e)
    while (early.size > EARLY_MAX) early.delete(early.keys().next().value)
    trace('early-fired', { rawChars: raw.length, minRawChars: cfg.minRawChars })
  }

  const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

  // ★ D4′ 相对宽限收网：后台提纯若已就绪 ⇒ 0 等待；未就绪 ⇒ 最多再给 graceMs。
  //   两种结局都只是「用提纯稿」或「保持原文」，绝不抛错、绝不阻断宿主。
  async function awaitDistilled(raw, graceMs) {
    const e = early.get(raw)
    if (!e) return null
    if (e.settled) return e
    const cfgMs = Number.isFinite(cfg.graceMs) ? cfg.graceMs : 1000
    const budget = Number.isFinite(graceMs) ? Math.max(0, graceMs) : cfgMs
    if (budget > 0) await Promise.race([e.promise, sleep(budget)])
    return e.settled ? e : null
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    n++
    if (!cfg.enabled) { trace('skip-disabled', { n }); return decision }
    // ★ birth 模式也要先捕获 sessionId —— CAS 归档要用它登记会话归属
    try {
      const s = payload && payload.agent && payload.agent.session
      const sid = s && (s.id ?? s.sessionId)
      birthSessionId = sid == null ? null : String(sid)
      birthSession = sid == null ? null : s
    } catch { /* ignore */ }
    // ════════════════════════════════════════════════════════════════════════
    // ★★ 2026-09-21 方案二：birth 模式的「下轮收网」（Deferred Claim）★★
    //
    // 旧行为（本行原文）：birth 在这里直接 return ⇒ 事后替换路径被整体旁路
    //   ⇒ trace 里 emit-queued / replaced / checkpoint-emitted 全是 0。
    //   后果：没赶上 finishWaitMs 的提纯结果**全部丢弃** —— 用户白等 6 秒，
    //   拿不到摘要，还要额外付一次上游调用。
    //
    // 新行为：出生即提纯照旧（快则同轮内联替换）；**没赶上的结果进暂存区**，
    //   在下一轮 pre-step 用官方 user/message + surfaceOp replace 收网 ——
    //   与 checkpoint 模式共用同一条已加固的通路（emitter.js runPreStepEmit）。
    //
    // ⚠ 实际等待 = 0：pre-step 时结果早已就绪（真工期被「用户阅读 / 工具执行」消化）。
    // ⚠ keepTail 最小为 1 ⇒ 收网天然有 1 轮滞后，这是官方规范，不是缺陷。
    // ⚠ 任何一步不满足 ⇒ 一律 no-op 保持原文，绝不抛错、绝不写坏表面。
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.mode === 'birth') {
      if (cfg.birthDeferredClaim !== true) { trace('skip-mode-birth', { n }); return decision }
      try {
        const bpSession = payload && payload.agent && payload.agent.session
        const bpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
        const bpSid = bpSession && (bpSession.id || bpSession.sessionId)
        // ★ 快速路径：本会话没有任何「没赶上的结果」⇒ 直接返回，
        //   不做表面读取、不做区间选择（收网器只在真有东西可收时才启动）。
        if (!lateMemorySize(bpSid, { branchId: normalizeBranchId(bpSession) })) { trace('birth-claim-idle', { n }); return decision }
        const claimScope = { branchId: normalizeBranchId(bpSession) }
        trace('birth-claim-opportunity', { n, sessionId: bpSid, branchId: claimScope.branchId, taskIds: (lateMemory.get(lateKey(bpSid, claimScope)) || []).map(x => x.taskId).filter(Boolean) })
        let pendingClaim = null
        const r = await runPreStepEmit({
          session: bpSession,
          requireUniqueRaw: true,
          validatePending: () => lateReceiptValid(bpSid, pendingClaim, claimScope),
          ctx,
          cfg,
          trace,
          rawOf: async (ev) => {
            const msg = ev && ev.data && ev.data.message
            return msg ? reasoningTextOf(msg) : null
          },
          // ★ 这里必须交**原文**：buildLedger 会用它写 CAS 归档。
          //   清洗只允许发生在「模型输入视图」那一侧（buildLedger 内联时），
          //   绝不能让归档副本被洗 —— 那是原始证据，必须字节保真。
          toolTextOf: async (ev) => toolTextFromEvent(ev),
          // ★ 零等待探测：让发射器在缺省目标未就绪时回头找「更早但已就绪」的候选（机会饥饿修正）
          isReady: async (raw) => !!(peekLateMemory(bpSid, raw, claimScope) || (cfg.lateClaimPartial === true && peekLateMemoryPartial(bpSid, raw, claimScope))),
          archive: async (text) => {
            if (!bpCmb || typeof bpCmb.putText !== 'function') return null
            try {
              const ref = await bpCmb.putText(text, {
                producer: cfg.emitterProducer || 'cot-checkpoint',
                sessionId: bpSid || null,
                retention: 'session',
              })
              return (ref && ref.handle) || null
            } catch (e) { trace('birth-claim-archive-error', { error: String((e && e.message) || e) }); return null }
          },
          // ★ birth 专属：结果不是「等」来的，是从暂存区**认领**来的。
          //   认领要求【全覆盖】：本消息的每一个推理块都有就绪结果，且拼起来逐字等于原文。
          //   只部分就绪 ⇒ 不认领、不消费（否则未就绪块的推理会凭空消失）。
          //   先 peek，只有发射成功才 acknowledge；拒发/漂移/dry-run 不消费。
          awaitDistilled: async (raw) => {
            let c = peekLateMemory(bpSid, raw, claimScope)
            if (!c && cfg.lateClaimPartial === true) {
              c = peekLateMemoryPartial(bpSid, raw, claimScope)
              if (c) trace('birth-claim-partial', { n, blocks: c.count, replacedChars: c.replacedChars, keptChars: c.keptChars })
            }
            if (!c) { trace('birth-claim-miss', { n, why: explainLateMiss(bpSid, raw, claimScope), rawChars: raw.length, inFlight: lateInFlightCount(bpSid, claimScope), stored: lateMemorySize(bpSid, claimScope) }); return null }
            // 多块时按块序拼接（顺序由 coverageMatch 保证，绝不按 promise 完成序）
            const text = c.texts.join('\n\n') || renderCheckpoint(c.entries)
            if (!text || !String(text).trim()) return null
            pendingClaim = c.receipt
            trace('birth-claim-hit', { n, blocks: c.count, chars: String(text).length, taskIds: c.receipt.map(x => x.taskId).filter(Boolean) })
            return { ok: true, text: String(text) }
          },
        })
        trace(r && r.emitted ? 'birth-claim-emitted' : 'birth-claim-skip', {
          n, reason: r && r.reason, returnedSeq: r && r.returnedSeq, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean),
        })
        if (r && r.emitted) {
          const consumed = acknowledgeLateMemory(bpSid, pendingClaim, claimScope)
          trace('birth-claim-acknowledged', { n, consumed, seq: r.returnedSeq ?? null, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean), rawChars: (pendingClaim || []).reduce((n, x) => n + x.raw.length, 0), summaryChars: (pendingClaim || []).reduce((n, x) => n + String(x.board || '').length, 0), accounting: 'characters-not-tokens-or-money' })
          for (const item of pendingClaim || []) consumption.applied(item.taskId, item.board)
          // A block-level ledger is NOT the entire latest persistent snapshot.
          // Do not mark that unrelated revision as host-applied.
        }
      } catch (e) {
        trace('birth-claim-error', { n, error: String((e && e.message) || e) })
      }
      return decision
    }
    if (cfg.mode === 'off') { trace('skip-mode-off', { n }); return decision }

    // ★★ mode: 'checkpoint' —— 官方 user/message 检查点发射器（阶段二）★★
    //   全链路：感知水位 → D10 动态门槛 → D1′ 平衡整步 → D4′ 伴生提纯收网
    //           → D2′ 混合组装 → 官方合规 replace 发射（绕开 surface.js:207 / :234 两道断言）
    //   任何一步不满足 ⇒ runPreStepEmit 一律返回 no-op（保持原文），绝不抛错。
    if (cfg.mode === 'checkpoint') {
      try {
        const cpSession = payload && payload.agent && payload.agent.session
        const cpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
        const r = await runPreStepEmit({
          session: cpSession,
          ctx,
          cfg,
          trace,
          rawOf: async (ev) => {
            const msg = ev && ev.data && ev.data.message
            return msg ? reasoningTextOf(msg) : null
          },
          // 复用 emitter.js 里的唯一实现（真机形状已实测 11,802/11,802 命中）
          toolTextOf: async (ev) => toolTextFromEvent(ev),
          archive: async (text) => {
            if (!cpCmb || typeof cpCmb.putText !== 'function') return null
            try {
              const ref = await cpCmb.putText(text, {
                producer: cfg.emitterProducer || 'cot-checkpoint',
                sessionId: (cpSession && (cpSession.id || cpSession.sessionId)) || null,
                retention: 'session',
              })
              return (ref && ref.handle) || null
            } catch (e) { trace('emitter-archive-error', { error: String((e && e.message) || e) }); return null }
          },
          awaitDistilled,
        })
        trace(r && r.emitted ? 'checkpoint-emitted' : 'checkpoint-skip', {
          n, reason: r && r.reason, returnedSeq: r && r.returnedSeq,
        })
      } catch (e) {
        trace('checkpoint-error', { n, error: String((e && e.message) || e) })
      }
      return decision
    }

    return decision
  })

  // ── llm/stream：只读观测 + 提前发起（非阻塞）──────────────────────────────
  // ⚠ 包装流的写法照抄 `deploy/probe/index.mjs` —— 那是本项目已在真实会话里跑过的既有模式：
  //   任何**观察**异常都不许影响主流；主流自己抛错必须原样抛出，不许吞。
  ctx.on('llm/stream', (options, next) => {
    if (cfg.enabled && cfg.mode !== 'off') consumption.observe(options)
    if (!cfg.enabled || cfg.mode === 'off') return next()
    // ★★ 宿主对话模型捕获（必须在 fireEarly 之前）★★
    //   本次 llm/stream 就是「生成当前这条 assistant 消息」的那次调用
    //   ⇒ options.model 正是宿主此刻对话用的模型 ⇒ 拿它提纯，就是用户要的「跟着对话模型走」。
    try {
      const hm = options && options.model
      const hp = options && options.provider
      if ((hm && hm !== hostModel) || (hp && hp !== hostProvider)) {
        if (hm) hostModel = hm
        hostProvider = hp || hostProvider
        if (cfg.followHostModel && hm) cfg.model = hm
        // ★ 模型跟随之外，端点/钥匙也跟随宿主 provider（禁止硬编码）
        if (cfg.followHostProvider !== false) cfg.followProvider = hostProvider
        trace('distill-endpoint-target', { hostProvider, followProvider: cfg.followProvider || null })
        trace('host-model', {
          model: hm,
          provider: options && options.provider,
          followHostModel: cfg.followHostModel,
          effectiveModel: cfg.model,
          n,
        })
      }
    } catch (e) { trace('host-model-error', { error: String((e && e.message) || e) }) }

    try {
      const msgs = (options && options.messages) || []
      // ★ 2026-09-21 消息溯源（外部审计 P0-3）：只观测，绝不删/改/合并任何消息。
      //   判据是"来源与时间线"，不是"role 数了几个"。
      const prov = provenanceOf(msgs)
      // ★ 建立"出站消息 → 源事件 seq"的链条（只读；不改任何事件）
      const seqMap = mapMessagesToSeqs(birthSession, msgs.length)
      // ★ 2026-09-21 守住最危险的假阳性（外部审计）：**数量不一致时绝不按下标硬配** ——
      //   错位的 seq 比没有 seq 更糟，它会让人顺着错误的链条得出结论。
      //   只有 note==='aligned' 才写 seq；否则整批不写，只留 note 说明原因。
      if (seqMap.map && seqMap.note === 'aligned') {
        for (let i = 0; i < prov.items.length; i++) prov.items[i].seq = seqMap.map[i]
      }
      trace('llm-stream', {
        n,
        model: options && options.model,
        provider: options && options.provider,
        messageCount: msgs.length,
        roles: msgs.map((m) => m && m.role),
        reasoningChars: msgs.map((m) => reasoningTextOf(m).length),
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
      })
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
      // Capture now: another pre-step/provider update may run before this stream
      // is consumed or before block-end. No mutable session/config lookup later.
      const streamSession = birthSession
      const streamSessionId = birthSessionId
      const streamBranchId = normalizeBranchId(streamSession)
      const streamCfg = { ...cfg }
      return birthTransform(inner, {
        cfg: streamCfg,
        trace,
        sessionId: streamSessionId,
        branchId: () => streamBranchId,
        // ★ v11.6 成本模型观测用：此刻物理水位（emitter.readPressure 形状）。失败返回 null，绝不抛。
        pressure: () => { try { return readPressure({ session: streamSession, ctx }) } catch { return null } },
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
        // ★ 方案一：唯一压缩器 = 宿主模型提纯（100% 跟随宿主 provider/model；本模块不碰端点与钥匙）
        // ★ 状态记忆打开时：输入是【证据信封】，产物是六栏状态渲染 + 记忆条目。
        //   两者共用同一条传输/重试/超时/取消机制（仍是**一次**模型调用）。
        // ★★ 2026-09-22 切分后：按 compileMode 三选一 ★★
        //   memory   → 证据信封 + 两栏判断（状态记忆）
        //   compress → 本段 reasoning 的摘要（纯压缩）★ 输入不背整窗证据
        //   legacy   → 旧的 generateDistillation 默认提示词
        distill: compileModeOf(streamCfg) === 'memory'
          ? async (env, signal, budget) => generateStateMemory(env, streamCfg, signal, { ...budget, flights: compilerFlights })
          : compileModeOf(streamCfg) === 'compress'
            ? async (raw, signal, budget) => {
                // 提示词选择与版本号必须来自**同一次**裁决，否则 trace 会把 A 的产物记成 B 的版本。
                const pv = compressPromptVersion(streamCfg)
                const prompt = pv === 'compress-v1' ? buildDistillPrompt(raw)
                  : pv.indexOf('compress-v3') === 0
                    ? (() => { const t = compressTargets(streamCfg); return buildCompressPromptV3(raw, t.min, t.max) })()
                    : buildCompressPrompt(raw)
                // ★ v11.7：响应头信号透传（_onHeaders 只活在这次调用的 cfg 副本里，不进 BOOT、不进 trace）
                const c = { ...streamCfg }
                if (budget && typeof budget.onHeaders === 'function') c._onHeaders = budget.onHeaders
                // ★ v11.7 缓存友好拆分（opt-in）：system=规则前缀、user=原文；字节等价，只改消息形状。v1 不拆（它无 marker）。
                const pvOut = pv
                if (streamCfg.compressSystemPrompt === true && pv !== 'compress-v1') {
                  const sp = splitCompressPrompt(prompt)
                  if (sp) c._promptMessages = [{ role: 'system', content: sp.system }, { role: 'user', content: sp.user }]
                }
                return generateDistillation(raw, c, signal, prompt, { ...compileRuntime(budget), promptVersion: pvOut })
              }
            : async (raw, signal, budget) => generateDistillation(raw, budget && typeof budget.onHeaders === 'function' ? { ...streamCfg, _onHeaders: budget.onHeaders } : streamCfg, signal, undefined, compileRuntime(budget)),
        prepareEvidence: (input) => {
          const started = performance.now()
          const frame = prepareCompilerEvidence(input, streamCfg.stateSnapshot)
          trace('evidence-prepare-cost', { ms: performance.now() - started, io: frame.ioStats || null })
          return frame
        },
        buildEnvelope: (o) => buildEvidenceEnvelope(o),
        collectEvidence: (o) => collectEvidence(streamSession, o),
        // ★ 优化1：句柄内存秒算（与 store.deriveHandle 同一公式，纯函数）
        deriveHandle: (sessionId, text) => deriveArtHandle(sessionId, text),
        // ★ 优化2：思考一开始就捂热连接（HEAD，零 token）
        prewarm: (why) => prewarm(why),
      })
    }
    if (!cfg.earlyFire || cfg.mode !== 'checkpoint') return inner

    // ★ 保险：拿到的不是 async iterable 就**原样返回，绝不包装**。
    //   包装一个不认识的形状会让 `for await` 直接抛错 ⇒ 主模型调用当场失败。
    //   宁可这一轮不提前发起，也绝不许碰坏主流。
    if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
      trace('early-no-async-iter', { n, kind: inner === null ? 'null' : typeof inner })
      return inner
    }

    return (async function* () {
      const blockType = new Map() // index → blockType
      const buf = new Map()       // index → reasoning 文本（按 index 升序拼，与 reasoningTextOf 同口径）
      let fired = false
      const joinBuf = () => [...buf.keys()].sort((a, b) => a - b).map((k) => buf.get(k)).join('\n')
      const maybeFire = (why) => {
        if (fired) return
        const text = joinBuf()
        if (!text.trim()) return
        fired = true
        trace('early-trigger', { n, why, reasoningChars: text.length })
        fireEarly(text)
      }
      try {
        for await (const chunk of inner) {
          try {
            const t = chunk && chunk.type
            const idx = chunk && chunk.index !== undefined ? chunk.index : 0
            if (t === 'block-start') {
              blockType.set(idx, chunk.blockType)
              // reasoning 之后紧接着 tool-call / text ⇒ reasoning 一定已经写完
              if (chunk.blockType === 'tool-call') maybeFire('tool-call-block-start')
              else if (chunk.blockType === 'text') maybeFire('text-block-start')
            } else if (t === 'text-delta') {
              if (blockType.get(idx) === 'reasoning') buf.set(idx, (buf.get(idx) || '') + String(chunk.text || ''))
            } else if (t === 'reasoning-delta') {
              buf.set(idx, (buf.get(idx) || '') + String(chunk.text || chunk.reasoning || ''))
            } else if (t === 'block-end') {
              const b = chunk.block
              if (b && b.type === 'reasoning') { buf.set(idx, String(b.text || buf.get(idx) || '')); maybeFire('reasoning-block-end') }
            } else if (t === 'tool-call-delta') {
              maybeFire('tool-call-delta')
            } else if (t === 'finish') {
              maybeFire('finish')
            }
          } catch { /* 观察失败绝不影响主流 */ }
          yield chunk
        }
      } catch (err) {
        trace('llm-stream-threw', { n, error: String((err && err.message) || err) })
        throw err
      }
    })()
  }, { prepend: true })
}
