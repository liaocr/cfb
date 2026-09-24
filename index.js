// dsh-cot-form-b —— 推理块「出生即压缩」插件（DSH 外部插件，Cordis 协议）
//
// 人话：模型每写完一段 reasoning，就在它进入会话之前把它压成短摘要；
//       原文先写进 CAS（可按句柄取回），摘要以普通 append 落进会话。
//       后续每一轮携带的都是短摘要，而不是又长又啰嗦的原文。
//
// 本文件只是包入口：宿主按包名加载它，拿到 name / inject / apply。
// 实现全部在 src/（模块地图见 README「代码结构」）。下面的其余导出是给自测与离线工具用的
// 纯函数与内部入口 —— 包的 exports 只开放本文件，深层路径对外不可导入。
//
// ⚠ 口径纪律：本模块只做「字符数」判定。字符数不是钱；trace 里的字符数不得当作费用节省。

// ── 插件入口 ─────────────────────────────────────────────────────────────────
export { name, inject, apply, DEP_ID } from './src/plugin.js'

// ── 配置 ─────────────────────────────────────────────────────────────────────
export { DEFAULTS, normalizeConfig, resolveCompileMode, dshHome, dshHomePath } from './src/config.js'

// ── 出生即压缩（birth）───────────────────────────────────────────────────────
export {
  birthTransform, birthStart, birthFinish, birthSettle, birthHoldNew, deriveArtHandle, birthEconomics,
} from './src/birth.js'

// ── 迟到结果暂存区（Deferred Claim，实验）────────────────────────────────────
export {
  pushLateMemory, peekLateMemory, peekLateMemoryPartial, claimLateMemory, takeLateMemory,
  acknowledgeLateMemory, lateReceiptValid, lateMemorySize, explainLateMiss,
  noteLateInFlight, settleLateInFlight, lateInFlightCount,
} from './src/late-memory.js'

// ── 副模型调用 ───────────────────────────────────────────────────────────────
export { generateDistillation, generateStateMemory, hedgedDistill } from './src/distill.js'
export {
  buildDistillPrompt, buildCompressPrompt, buildCompressPromptV3, splitCompressPrompt,
  compressPromptVersion, compressTargets,
} from './src/prompts.js'
export {
  requestOnce, requestStream, prewarmTargetUrl, retryDelayMs,
  detectResponseProtocol, assembleSseFrames, collectSseFrames, extractFromJsonBody,
} from './src/transport.js'
export { readApiKey, readProviderSpec, endpointUrl, resolveProviderEndpoint } from './src/provider.js'

// ── 证据采集与消息工具 ───────────────────────────────────────────────────────
export { evidenceIndex, collectEvidence, filterCoveredTools, fullyVisibleResultSeqs } from './src/evidence.js'
export { provenanceOf, mapMessagesToSeqs, textOfContent, reasoningTextOf } from './src/messages.js'
// ★ 供测试直接校验「唯一解释出口」：索引与回退必须得到同样的证据。
export { normalizeEvidenceEvent, assembleEvidence } from './src/state-memory.js'

// ── 观测 ─────────────────────────────────────────────────────────────────────
export { makeTraceWriter, settledTraceData } from './src/trace.js'
