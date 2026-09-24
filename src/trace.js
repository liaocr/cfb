// dsh-cot-form-b / trace.js —— trace 落盘
//
//   makeTraceWriter   '[ISO] [tag] {json}' 一行一条；写失败只丢证据，绝不阻断宿主
//   settledTraceData  birth-distill-settled / compiler-transport-settled 的字段白名单（加字段必须改这里）
import fs from 'node:fs'
import path from 'node:path'

/**
 * trace writer 工厂（2026-09-21 导出以便端到端测试）。
 * 语义与原先内联版本逐字一致：trace 关闭 ⇒ 什么都不写；写失败 ⇒ 只吞证据，绝不阻断宿主。
 * @param {object} cfg 需要 cfg.trace 与 cfg.traceFile
 * @param {() => object} statsOf 返回当前 stats 快照（每行都会附上）
 */
export function makeTraceWriter(cfg, statsOf) {
  let dirReady = false
  return function trace(tag, data) {
    if (!cfg.trace) return null
    const stats = typeof statsOf === 'function' ? statsOf() : undefined
    const payload = Object.assign({}, data, stats === undefined ? {} : { stats })
    const line = '[' + new Date().toISOString() + '] [' + tag + '] ' + JSON.stringify(payload)
    try {
      if (!dirReady) { fs.mkdirSync(path.dirname(cfg.traceFile), { recursive: true }); dirReady = true }
      fs.appendFileSync(cfg.traceFile, line + '\n')
      return line
    } catch { return null /* evidence only */ }
  }
}

/**
 * `birth-distill-settled` 的记录体（2026-09-21 抽出为纯函数）。
 * 抽出的理由：这个对象就是"白名单"本身 —— 加字段必须同时改这里，
 * 否则字段只活在 meta 里、落不了盘（已发生过的真实事故）。
 */
export function settledTraceData(index, ms, s) {
  const m = (s && s.meta) || null
  return {
    index, ms, ok: !!(s && s.ok),
    chars: (s && s.text) ? s.text.length : 0,
    reason: (s && s.ok) ? null : ((s && s.error) || 'unknown-failure'),
    ...(m ? {
      model: m.model, endpoint: m.endpoint, style: m.style, thinkingOff: m.thinkingOff,
      compilerMode: m.compilerMode, deterministicRevision: m.deterministicRevision, evidenceBodyChars: m.evidenceBodyChars, evidencePolicy: m.evidencePolicy, duplicateBodyCharsAvoided: m.duplicateBodyCharsAvoided,
      // 输入放大度量：promptChars / inputChars。不是输出压缩率，也不是实际 token 节省。
      inputChars: m.inputChars, promptVersion: m.promptVersion,
      // promptChars/inputChars is request-side amplification, not output compression or savings.
      inputAmplificationRatio: (typeof m.promptChars === 'number' && typeof m.inputChars === 'number' && m.inputChars > 0)
        ? Number((m.promptChars / m.inputChars).toFixed(2)) : undefined,
      /** @deprecated compatibility alias; use inputAmplificationRatio. */
      compressRatio: (typeof m.promptChars === 'number' && typeof m.inputChars === 'number' && m.inputChars > 0)
        ? Number((m.promptChars / m.inputChars).toFixed(2)) : undefined,
      promptChars: m.promptChars, maxOutputTokens: m.maxOutputTokens,
      connectMs: m.connectMs, ttfbMs: m.ttfbMs, firstByteMs: m.firstByteMs,
      totalMs: m.totalMs, chunks: m.chunks, reused: m.reused, status: m.status,
      bytes: m.bytes, cancelled: m.cancelled, finish: m.finish, reasoningChars: m.reasoningChars,
      stream: m.stream === true ? true : undefined,
      // ★ 失败阶段（2026-09-21）：区分「还没拿到响应头就超时」与「拿到了但生成太慢」
      stage: m.stage,
      providerReportedUsage: m.providerReportedUsage || null,
      requestId: m.requestId, flightId: m.flightId, sharedFlight: m.sharedFlight,
      // v11.7 对冲：谁胜出（primary/hedge；未启用 = undefined）、阈值、对冲发出时刻（未发 = null）
      hedged: m.hedged, hedgeAfterMs: m.hedgeAfterMs, hedgeStartedAt: m.hedgeStartedAt,
      promptBuildMs: m.promptBuildMs, promptBuildCount: m.promptBuildCount,
      parseRenderMs: m.parseRenderMs, staticPrefixChars: m.staticPrefixChars,
      afterContentMs: m.afterContentMs,
      // ★ 协议错配（2026-09-21）：响应实际协议与请求模式不一致时显式留痕
      protocolMismatch: m.protocolMismatch,
      eventCount: m.eventCount, badFrame: m.badFrame, outputChars: m.outputChars,
      toFirstEventMs: m.toFirstEventMs, toFirstContentMs: m.toFirstContentMs,
      contentSpanMs: m.contentSpanMs, toCompleteMs: m.toCompleteMs,
    } : {}),
  }
}
