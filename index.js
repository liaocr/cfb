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
export { DEFAULTS, normalizeConfig, dshHome, dshHomePath } from './src/config.js'

// ── 出生即压缩（birth）───────────────────────────────────────────────────────
export {
  birthTransform, birthStart, birthFinish, birthSettle, birthHoldNew, deriveArtHandle, birthEconomics, birthCancelFlying, readPressure,
} from './src/birth.js'
export { estimateTokens, wideShare, scriptCounts } from './src/tokens.js'
export { createHostFollower } from './src/host-follow.js'
export { createSessionTracker } from './src/session-tracker.js'

// ── 副模型调用 ───────────────────────────────────────────────────────────────
export { generateDistillation, hedgedDistill, makeBirthCompiler, makeV4SegmentCompiler } from './src/distill.js'
export {
  buildCompressPrompt, buildCompressPromptV3, buildCompressPromptV4, splitCompressPrompt, fixHints, condHints,
  compressPromptVersion, compressPromptFor, compressTargets, V4_TAIL, v4Budget, v4Incremental, v4SegmentChars, buildCompressPromptV4Segment,
} from './src/prompts.js'
export {
  compileV4, compileOpsV4, parseOps, normalizeOp, validateOps, selectOps, renderOps, renderLine, renderLang, scoreOp,
  mergeSegmentOps, priorLines, freshenState, supersedesIds, v4RejectRatioOf, V4_KINDS, V4_EVS, V4_KIND2,
} from './src/compile-v4.js'
export { createSegmenter, findCut, findFirstCut } from './src/segment-v4.js'
export {
  requestOnce, requestStream, prewarmTargetUrl, retryDelayMs,
  detectResponseProtocol, assembleSseFrames, collectSseFrames, extractFromJsonBody,
} from './src/transport.js'
export { readApiKey, readProviderSpec, endpointUrl, resolveProviderEndpoint } from './src/provider.js'

// ── 消息工具与保真度 ─────────────────────────────────────────────────────────
export { provenanceOf, mapMessagesToSeqs, textOfContent, reasoningTextOf, artRefsOf } from './src/messages.js'
export { fidelity, protectedTokens, inventedIdentifiers } from './src/fidelity.js'

// ── 观测 ─────────────────────────────────────────────────────────────────────
export { makeTraceWriter, settledTraceData } from './src/trace.js'
