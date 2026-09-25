// dsh-cot-form-b / boot-record.js —— BOOT 行的内容（v11.11 从 plugin.js 抽出）
//
// BOOT 是「网关里跑的是哪一版、生效配置是什么」的唯一证据行；字段只增不改名（离线工具按名读取）。
import { JUDGMENT_PROMPT_VERSION } from './evidence-ledger.js'
import { compressPromptVersion } from './prompts.js'
import { MEMORY_POLICY_VERSION, SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION } from './state-memory.js'

/**
 * @param {object} cfg 归一化后的配置
 * @param {{ selfId: string, deps: string }} ids plugin.js 首次求值时从磁盘读到的模块身份
 */
export function bootRecord(cfg, { selfId, deps }) {
  return {
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
    selfId,
    deps,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    // ★ 2026-09-17 路线 A：活跃尾部宽度（最近多少条 assistant/message 逐字保留）。
    //   官方规范 dsh-compaction/README.md:145 —— "leaves the recent tail unchanged"。
    keepTail: Number.isInteger(cfg.keepTail) && cfg.keepTail >= 1 ? cfg.keepTail : 1,
    maxCarryChars: cfg.maxCarryChars,
    emitterMinSavingsChars: cfg.emitterMinSavingsChars,
    emitterMinSavingsRatio: cfg.emitterMinSavingsRatio,
    emitterMeasureTokens: cfg.emitterMeasureTokens === true,
    emitToolSampleChars: cfg.emitterToolSampleChars,
    emitterExcerptChars: cfg.emitterExcerptChars,
    emitterKeepRecentToolResults: cfg.emitterKeepRecentToolResults,
    emitterSelectiveArchive: cfg.emitterSelectiveArchive !== false,
    emitHandleProbeMax: cfg.emitHandleProbeMax,
    birthHandleProbeTimeoutMs: cfg.birthHandleProbeTimeoutMs,
    minRawChars: cfg.minRawChars,
    earlyFire: cfg.earlyFire,
    timeoutMs: cfg.timeoutMs,
    graceMs: cfg.graceMs,
    maxAttempts: cfg.maxAttempts,
    hedgeAfterMs: cfg.hedgeAfterMs,
    finishHeadersGraceMs: cfg.finishHeadersGraceMs,
    birthArchive: cfg.birthArchive,
    birthMinChars: cfg.birthMinChars,
    birthMinTokens: cfg.birthMinTokens,
    birthTokenGate: cfg.birthTokenGate !== false,
    traceMaxBytes: cfg.traceMaxBytes,
    tracePreviewChars: cfg.tracePreviewChars,
    birthProducer: cfg.birthProducer,
    keepAlive: cfg.keepAlive,
    keepAliveMsecs: cfg.keepAliveMsecs,
    prewarm: cfg.prewarm,
    // ★ BOOT 时 cfg.model 只是「patch 里显式写死的那个」。v11.11 起 followHostModel 不再改写共享配置：
    //   每次 llm/stream 各自派生一份调用配置（host-follow.js），实际用的模型见 host-model / settled trace。
    model: cfg.model,
    modelAtBoot: cfg.model,
    followHostModel: cfg.followHostModel,
    disableThinking: cfg.disableThinking,
    maxOutputTokens: cfg.maxOutputTokens,
    // v11.11：同一窗口内多个会话交错进入 pre-step ⇒ 流归属不可证时的处置（session-tracker.js）
    birthSessionAmbiguity: cfg.birthSessionAmbiguity,
    modelFollow: 'per-call',
    invariant: 'H2 首次出站不变律：块只在「还没出站」时允许替换，否则永久放弃',
  }
}
