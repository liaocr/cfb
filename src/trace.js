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
  // ★ v11.10 轮转：已知文件大小（首次写入时 stat 一次，之后在内存里累加，不再每行 stat）。
  let size = null
  const stamp = () => '[' + new Date().toISOString() + '] '
  const rotateIfNeeded = (file, incoming) => {
    const max = Number(cfg.traceMaxBytes)
    if (!(Number.isFinite(max) && max > 0)) return
    if (size === null) { try { size = fs.statSync(file).size } catch { size = 0 } }
    if (size + incoming <= max || size === 0) return
    const from = size
    try { fs.renameSync(file, file + '.1') } catch { /* 改名失败 ⇒ 继续追加，绝不因轮转丢证据 */ return }
    size = 0
    // 新文件的第一行说明来历（锚定格式，analyze-trace 可识别；BOOT 分组语义不变）
    const head = stamp() + '[trace-rotated] ' + JSON.stringify({ previous: path.basename(file) + '.1', previousBytes: from, maxBytes: max }) + '\n'
    fs.appendFileSync(file, head)
    size += Buffer.byteLength(head)
    // 续写 BOOT 副本：analyze-trace 按 BOOT 分组，否则轮转后的事件会落进「无构建」组、无法归因
    if (lastBoot) {
      const boot = stamp() + '[BOOT] ' + JSON.stringify(Object.assign({}, lastBoot, { rotatedCopy: true })) + '\n'
      fs.appendFileSync(file, boot)
      size += Buffer.byteLength(boot)
    }
  }
  let lastBoot = null
  return function trace(tag, data) {
    if (!cfg.trace) return null
    const stats = typeof statsOf === 'function' ? statsOf() : undefined
    const payload = Object.assign({}, data, stats === undefined ? {} : { stats })
    const line = stamp() + '[' + tag + '] ' + JSON.stringify(payload)
    if (tag === 'BOOT') lastBoot = payload
    try {
      if (!dirReady) { fs.mkdirSync(path.dirname(cfg.traceFile), { recursive: true }); dirReady = true }
      const bytes = Buffer.byteLength(line) + 1
      rotateIfNeeded(cfg.traceFile, bytes)
      fs.appendFileSync(cfg.traceFile, line + '\n')
      if (size !== null) size += bytes
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
      // v11.11 token 估算校准：按书写系统的字符数（只有数量）；与 providerReportedUsage 同行，离线回归系数
      promptWideChars: m.promptWideChars, promptOtherChars: m.promptOtherChars,
      outputWideChars: m.outputWideChars, outputOtherChars: m.outputOtherChars,
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
