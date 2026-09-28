// dsh-cot-form-b / boot-record.js —— BOOT 行的内容（v11.11 从 plugin.js 抽出）
//
// BOOT 是「网关里跑的是哪一版、生效配置是什么」的唯一证据行；字段只增不改名（离线工具按名读取）。
import { compressPromptVersion } from './prompts.js'

/**
 * @param {object} cfg 归一化后的配置
 * @param {{ selfId: string, deps: string }} ids plugin.js 首次求值时从磁盘读到的模块身份
 */
export function bootRecord(cfg, { selfId, deps }) {
  return {
    ...(cfg.configAdjusted ? { configAdjusted: cfg.configAdjusted } : {}),
    // v12.1 起只有一种编译模式（compress）；两个字段保留字段名，供离线工具按名读取
    compilerMode: compressPromptVersion(cfg),
    promptVersion: compressPromptVersion(cfg),
    retiredOptions: cfg.retiredOptions,
    unknownOptions: cfg.unknownOptions,
    ...(cfg.retiredMode ? { retiredMode: cfg.retiredMode } : {}),
    ...(cfg.invalidMode !== undefined ? { invalidMode: cfg.invalidMode } : {}),
    birth: { finishWaitMs: cfg.birthFinishWaitMs, identifierGate: cfg.birthIdentifierGate !== false },
    // ★★ 复电上岗判据（模块改动必须重启网关才生效）★★
    //   ① emitting 是**手写常量**，只能说明版本意图，**不能**证明载入的是哪一份文件；
    //   ② selfId / deps 是**模块首次求值时从磁盘读到的** size@mtimeMs ——
    //      旧模块在内存里根本不含这段代码 ⇒ 不会打印这两个字段。
    //   复电前先确认本行出现 selfId，且与 `node -e` 现读值一致。
    emitting: 'birth@llm/stream',
    selfId,
    deps,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    birthHandleProbeTimeoutMs: cfg.birthHandleProbeTimeoutMs,
    timeoutMs: cfg.timeoutMs,
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
