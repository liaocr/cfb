// Usage: node tools/analyze-trace.mjs /path/to/trace.log
// 按 BOOT 分组统计 trace（每次网关重启 = 一组；selfId/deps 不同的构建绝不混算）。
// Only anchored records are evidence. Never split on '[BOOT]' inside JSON text.
//
// ★ 2026-09-24：新增 `toolResultPath` —— 工具结果路径的经济核算。
//   验收判据不是「压缩了多少字符」，而是 **净下降 − 读回成本 > 0**：
//     · 净下降 = 每个 emitAttemptId 的 netSavedChars（已扣 P1 富化代价）之和，**只算真正发射的尝试**；
//     · 读回成本 = 模型按句柄回查时重新吃回上下文的量。本文件看不到宿主侧的工具调用，
//       所以给的是**保本预算**（`breakeven.fullReadBacksAffordable`）：还能整块回读几次，超出即亏。
//   单位纪律：字符数不是钱。真账单必须用宿主 tokenMeter / usage（`measuredSurfaceTokenDelta` 只在
//   配了 emitterMeasureTokens 且非评估态时才有值）。
//
// ★ v11.10：每组新增 `birth` —— 生产路径（birth）的结局漏斗与**收网等待该给多少**的实测依据。
//   关键量 needWaitMs = 副模型真工期（birth-distill-settled.ms，自 block-end 起算）
//                     − 免费窗口（birth-finish-enter.gapMs，block-end → finish 之间本来就有的时间），按 taskId 关联。
//   它就是「这一块要在 finish 处再等多久才能拿到摘要」。按分位数给出 finishWaitMs 候选，
//   以及当前 finishWaitMs(+响应头宽限) 覆盖了多少比例的成功结果 —— 取值是产品权衡，工具只给数据。
//
// ★ v11.11：每组新增 `tokenCalibration` —— 用 provider 自报 usage 校准 src/tokens.js 的估算系数。
//   样本 = 成功的 birth-distill-settled 里同时有 prompt{Wide,Other}Chars 与 usage 的行；
//   最小二乘拟合 tokens ≈ wide·W + other·O + C（C 吸收聊天模板开销）。只对**副模型的分词器**成立；
//   followHostModel（缺省）下副模型 = 对话模型，所以它就是 token 闸门该用的系数。
import fs from 'node:fs'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const freshBirth = () => ({
  tasks: new Map(),            // taskId -> { gapMs, settledMs, ok }
  outcomes: Object.create(null), flush: Object.create(null), cancelled: Object.create(null),
  condensed: 0, netSavedChars: 0, netSavedTokensEst: 0, tokenFields: 0, waitedMs: [],
  calPrompt: [], calOutput: [],   // [wide, other, tokens]
})
const freshCp = () => ({
  attempts: new Map(), emitted: 0, blocked: 0, blockedBy: Object.create(null),
  enrichChars: 0, excerpted: 0, dumpSeen: 0, errorSeen: 0,
  archivePlanned: 0, archiveWritten: 0, archiveFailed: 0, archiveWriteChars: 0,
  verify: { resolved: 0, unresolvable: 0, unverifiable: 0, noEvidence: 0 },
  toolResultChars: 0, archivedItems: 0, lensItems: 0, simulated: 0, rechecks: 0,
  measuredSurfaceTokenDelta: [], usedTokens: [], lensMax: 0, buckets: [0, 0, 0, 0],
})

// v11.13：x1 拼装结局（按 promptVersion 分桶 ⇒ r1/r2、各消融开关、各准则可直接对比）与句柄回取观测（P5）。
const freshX1 = () => ({ byVersion: Object.create(null) })
const freshX1Bucket = () => ({ assembled: 0, rejected: Object.create(null), ratio: [], overTarget: 0,
  branchesFolded: 0, branchesParked: 0, branchesRejected: 0, foldedSentences: 0, foldRepaired: 0,
  failuresKept: 0, stateDeduped: 0, tagsVerified: 0, tagsDowngraded: 0, repaired: 0, byKind: Object.create(null) })
const freshArt = () => ({ records: 0, withHandles: 0, handlesMax: 0, retrievedMax: 0, toolCallsMax: 0, handleLinesMax: 0 })
export function addX1(x1, tag, obj) {
  if (tag !== 'extractive-assembled' && tag !== 'extractive-rejected') return
  const v = typeof obj.promptVersion === 'string' && obj.promptVersion ? obj.promptVersion : 'unknown'
  const b = x1.byVersion[v] || (x1.byVersion[v] = freshX1Bucket())
  if (tag === 'extractive-rejected') { const c = obj.code || 'error'; b.rejected[c] = (b.rejected[c] || 0) + 1; return }
  b.assembled++
  if (Number.isFinite(obj.ratio)) b.ratio.push(obj.ratio)
  if (obj.overTarget === true) b.overTarget++
  if (typeof obj.kind === 'string') b.byKind[obj.kind] = (b.byKind[obj.kind] || 0) + 1
  for (const k of ['branchesFolded', 'branchesParked', 'branchesRejected', 'foldedSentences', 'foldRepaired', 'failuresKept', 'stateDeduped', 'tagsVerified', 'tagsDowngraded', 'repaired']) {
    if (Number.isFinite(obj[k])) b[k] += obj[k]
  }
}
export function addArt(art, tag, obj) {
  if (tag !== 'llm-stream' || !obj.artRefs || typeof obj.artRefs !== 'object') return
  const a = obj.artRefs
  art.records++
  if (a.handles > 0) art.withHandles++
  // 出站消息每轮重发历史 ⇒ 计数是累计值，取最大值；同一 BOOT 组里可能混有多个会话，最大值是「最活跃会话」的量
  art.handlesMax = Math.max(art.handlesMax, a.handles || 0)
  art.retrievedMax = Math.max(art.retrievedMax, a.retrieved || 0)
  art.toolCallsMax = Math.max(art.toolCallsMax, a.toolCalls || 0)
  art.handleLinesMax = Math.max(art.handleLinesMax, a.handleLines || 0)
}

export function createTraceAudit() {
  const groups = []; let current = null, ignored = 0, malformed = 0, rotations = 0
  const fresh = (at, boot) => ({ start: at, boot: boot ? {
    selfId: boot.selfId ?? null, deps: boot.deps ?? null, mode: boot.mode ?? null,
    timeoutMs: boot.timeoutMs ?? null, birthFinishWaitMs: boot.birth?.finishWaitMs ?? boot.birthFinishWaitMs ?? null,
    dryRun: boot.dryRun ?? null,
    // v11.10：轮转后 trace.js 续写的 BOOT 副本 —— 同一次启动的延续，不是一次重启
    rotatedCopy: boot.rotatedCopy === true,
  } : null, events: Object.create(null), settled: { ok: 0, failed: 0, unknown: 0 },
    reasons: Object.create(null), promptChars: [], durationMs: [], coverObserved: 0, cp: freshCp(), bt: freshBirth(), x1: freshX1(), art: freshArt(),
    graceMs: boot ? (boot.finishHeadersGraceMs ?? null) : null })
  function add(line) {
    const m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/.exec(line)
    if (!m) { ignored++; return }
    let obj; try { obj = JSON.parse(m[3]) } catch { malformed++; return }
    if (m[2] === 'trace-rotated') { rotations++; return }   // 元信息：不开组、不计事件（其后紧跟 BOOT 副本）
    if (!current || m[2] === 'BOOT') { current = fresh(m[1], m[2] === 'BOOT' ? obj : null); groups.push(current) }
    const tag = m[2]; current.events[tag] = (current.events[tag] || 0) + 1
    if (tag === 'state-envelope' && obj.cover) current.coverObserved++
    if (tag === 'birth-distill-settled') {
      if (obj.ok === true) current.settled.ok++
      else if (obj.ok === false) {
        current.settled.failed++
        const reason = typeof obj.reason === 'string' && obj.reason ? obj.reason : 'unknown-failure'
        current.reasons[reason] = (current.reasons[reason] || 0) + 1
        if (reason === 'unknown-failure') current.settled.unknown++
      }
      if (Number.isFinite(obj.promptChars) && obj.promptChars >= 0) current.promptChars.push(obj.promptChars)
      if (Number.isFinite(obj.ms) && obj.ms >= 0) current.durationMs.push(obj.ms)
    }
    addToolResultPath(current.cp, tag, obj)
    addBirth(current.bt, tag, obj)
    addX1(current.x1, tag, obj)
    addArt(current.art, tag, obj)
  }

  function addBirth(bt, tag, obj) {
    const task = () => {
      if (typeof obj.taskId !== 'string' || !obj.taskId) return null
      let t = bt.tasks.get(obj.taskId)
      if (!t) { t = { gapMs: null, settledMs: null, ok: null }; bt.tasks.set(obj.taskId, t) }
      return t
    }
    if (tag === 'birth-finish-enter') { const t = task(); if (t && Number.isFinite(obj.gapMs)) t.gapMs = Math.max(0, obj.gapMs); return }
    if (tag === 'birth-distill-settled') {
      const t = task(); if (t) { t.ok = obj.ok === true; if (Number.isFinite(obj.ms)) t.settledMs = obj.ms }
      if (obj.ok === true) addCalibration(bt, obj)
      return
    }
    if (tag === 'birth-condensed') {
      bt.condensed++; bt.outcomes.condensed = (bt.outcomes.condensed || 0) + 1
      if (Number.isFinite(obj.netSaved)) bt.netSavedChars += obj.netSaved
      if (Number.isFinite(obj.netSavedTokensEst)) { bt.netSavedTokensEst += obj.netSavedTokensEst; bt.tokenFields++ }
      if (Number.isFinite(obj.waitedMs)) bt.waitedMs.push(obj.waitedMs)
      return
    }
    if (tag === 'birth-passthrough') {
      const why = typeof obj.why === 'string' && obj.why ? obj.why : 'unknown'
      bt.outcomes[why] = (bt.outcomes[why] || 0) + 1
      if (Number.isFinite(obj.waitedMs)) bt.waitedMs.push(obj.waitedMs)
      return
    }
    if (tag === 'birth-session-ambiguous') {
      // v11.11：流归属不可证。passthrough 时这就是该流的结局（不会再有 condensed/passthrough 行）
      bt.ambiguous = (bt.ambiguous || 0) + 1
      if (obj.action !== 'latest') bt.outcomes['session-ambiguous'] = (bt.outcomes['session-ambiguous'] || 0) + 1
      return
    }
    if (tag === 'birth-flush') { const w = obj.why || 'unknown'; bt.flush[w] = (bt.flush[w] || 0) + 1; return }
    if (tag === 'birth-distill-cancelled') { const w = obj.why || 'unknown'; bt.cancelled[w] = (bt.cancelled[w] || 0) + 1 }
  }

  function addCalibration(bt, obj) {
    const u = obj.providerReportedUsage
    if (!u || typeof u !== 'object') return
    const num = (...xs) => { for (const x of xs) if (Number.isFinite(x)) return x; return null }
    const inTok = num(u.prompt_tokens, u.input_tokens)
    if (inTok != null && Number.isFinite(obj.promptWideChars) && Number.isFinite(obj.promptOtherChars)) bt.calPrompt.push([obj.promptWideChars, obj.promptOtherChars, inTok])
    const outAll = num(u.completion_tokens, u.output_tokens)
    // 思考 token 不属于可见产物（关思考失败时才会有）⇒ 扣掉
    const reasoning = num(u.completion_tokens_details?.reasoning_tokens, u.output_tokens_details?.reasoning_tokens) || 0
    if (outAll != null && Number.isFinite(obj.outputWideChars) && Number.isFinite(obj.outputOtherChars)) bt.calOutput.push([obj.outputWideChars, obj.outputOtherChars, Math.max(0, outAll - reasoning)])
  }

  function birthSummary(g) {
    const bt = g.bt
    const need = [], okMs = []
    let joined = 0
    for (const t of bt.tasks.values()) {
      if (t.ok !== true || !Number.isFinite(t.settledMs)) continue
      okMs.push(t.settledMs)
      if (Number.isFinite(t.gapMs)) { joined++; need.push(Math.max(0, t.settledMs - t.gapMs)) }
    }
    need.sort((a, b) => a - b)
    const q = (p) => need.length ? need[Math.ceil(p * need.length) - 1] : null
    const wait = g.boot && Number.isFinite(g.boot.birthFinishWaitMs) ? g.boot.birthFinishWaitMs : null
    const grace = Number.isFinite(g.graceMs) ? g.graceMs : 0
    const covered = (ms) => need.length && ms != null ? Number((need.filter((x) => x <= ms).length / need.length).toFixed(3)) : null
    const total = Object.values(bt.outcomes).reduce((a, b) => a + b, 0)
    return {
      outcomes: bt.outcomes, total,
      condensedRate: total ? Number((bt.condensed / total).toFixed(3)) : null,
      flush: bt.flush, cancelled: bt.cancelled, sessionAmbiguous: bt.ambiguous || 0,
      netSavedChars: bt.netSavedChars,
      netSavedTokensEst: bt.tokenFields ? bt.netSavedTokensEst : null,
      waitedMs: stats(bt.waitedMs),
      distillOkMs: stats(okMs),
      needWaitMs: { n: need.length, joined, p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), max: need.length ? need.at(-1) : null },
      finishWait: {
        configuredMs: wait, headersGraceMs: grace,
        coverageAtConfigured: covered(wait), coverageWithGrace: wait == null ? null : covered(wait + grace),
        candidates: need.length ? { p50: q(0.5), p75: q(0.75), p90: q(0.9) } : null,
        note: 'needWaitMs = distill settled ms − free window (block-end→finish). Coverage counts successful distills only; the choice is a latency/benefit trade-off, not a tool verdict.',
      },
      unit: 'chars and *TokensEst are estimates, not provider billing',
    }
  }

  function calibrationSummary(g) {
    return { prompt: fitTokenModel(g.bt.calPrompt), output: fitTokenModel(g.bt.calOutput),
      current: { wide: 0.6, other: 0.3, intercept: 0 },
      note: 'least squares tokens ≈ wide·W + other·O + C on provider-reported usage; valid for the side model tokenizer (= host model under followHostModel)' }
  }

  /**
   * 工具结果路径（checkpoint）。同一 `emitAttemptId` 只留一条**最后一次读数**：
   * 一次发射会依次落 `emit-net-savings`（闸门）→ 可能 `emit-net-savings-recheck`（归档失败重算）
   * → `emit-net-savings-result`（最终）。把三次都加总会把同一轮算三遍。
   */
  function addToolResultPath(cp, tag, obj) {
    if (obj.emitAttemptId && (tag === 'emit-net-savings' || tag === 'emit-net-savings-recheck' || tag === 'emit-net-savings-result')) {
      const prev = cp.attempts.get(obj.emitAttemptId) || { reason: null, emitted: null, netSavedChars: null }
      const num = (k) => (Number.isFinite(obj[k]) ? obj[k] : prev[k])
      const next = {
        ...prev,
        sourceChars: num('sourceChars'), ledgerChars: num('ledgerChars'), netSavedChars: num('netSavedChars'),
        enrichChars: num('enrichChars'), netSavedIfHandleOnly: num('netSavedIfHandleOnly'), casWrites: num('casWrites'),
        archiveSimulated: obj.archiveSimulated === true || prev.archiveSimulated === true,
        stage: tag === 'emit-net-savings-result' ? 'result' : (tag === 'emit-net-savings-recheck' ? 'recheck' : 'gate'),
      }
      if (tag === 'emit-net-savings-result') {
        next.reason = typeof obj.reason === 'string' && obj.reason ? obj.reason : (obj.emitted === true ? null : 'unknown')
        next.emitted = obj.emitted === true
      }
      if (tag === 'emit-net-savings-recheck') cp.rechecks++   // 归档失败后重算闸门：这是「归档失败真实发生过」的证据
      cp.attempts.set(obj.emitAttemptId, next)
      if (Number.isFinite(obj.measuredSurfaceTokenDelta)) cp.measuredSurfaceTokenDelta.push(obj.measuredSurfaceTokenDelta)
      if (Number.isFinite(obj.usedTokens)) cp.usedTokens.push(obj.usedTokens)
      return
    }
    if (tag === 'emit-archive-simulated') {
      cp.simulated++
      if (Number.isFinite(obj.pending)) cp.archivePlanned += obj.pending
      return
    }
    if (tag === 'ledger-archive-commit') {
      if (Number.isFinite(obj.pending)) cp.archivePlanned += obj.pending
      if (Number.isFinite(obj.ok)) cp.archiveWritten += obj.ok
      if (Number.isFinite(obj.failed)) cp.archiveFailed += obj.failed
      if (Number.isFinite(obj.wroteChars)) cp.archiveWriteChars += obj.wroteChars
      return
    }
    if (tag === 'emit-handle-verify') {
      const v = obj.verdict
      if (v === 'resolved') cp.verify.resolved++
      else if (v === 'unresolvable') cp.verify.unresolvable++
      else if (v === 'no-evidence') cp.verify.noEvidence++
      else cp.verify.unverifiable++
      return
    }
    if (tag === 'ledger-built') {
      if (Number.isFinite(obj.enrichChars)) cp.enrichChars += obj.enrichChars
      if (Number.isFinite(obj.excerpted)) cp.excerpted += obj.excerpted
      if (Number.isFinite(obj.dumpSeen)) cp.dumpSeen += obj.dumpSeen
      if (Number.isFinite(obj.errorSeen)) cp.errorSeen += obj.errorSeen
      if (Number.isFinite(obj.toolResultChars)) cp.toolResultChars += obj.toolResultChars
      if (Number.isFinite(obj.archived)) cp.archivedItems += obj.archived
      if (Number.isFinite(obj.toolResultItems)) cp.lensItems += obj.toolResultItems
      if (Number.isFinite(obj.toolResultLensMax) && obj.toolResultLensMax > cp.lensMax) cp.lensMax = obj.toolResultLensMax
      if (typeof obj.toolResultBuckets === 'string') {
        const b = obj.toolResultBuckets.split('/').map((x) => Number(x))
        if (b.length === 4 && b.every(Number.isFinite)) for (let i = 0; i < 4; i++) cp.buckets[i] += b[i]
      }
    }
  }

  function stats(xs) {
    const s = [...xs].sort((a, b) => a - b)
    const q = p => s.length ? s[Math.ceil(p * s.length) - 1] : null
    return { n: s.length, p50: q(.5), p90: q(.9), max: s.length ? s.at(-1) : null }
  }

  /** 见文件头：这是 A/B 的验收判据口径，不是「省了多少字符」的广告。 */
  function toolResultPath(gs) {
    let emitted = 0, blocked = 0, simulated = 0
    const blockedBy = Object.create(null)
    let sourceChars = 0, ledgerChars = 0, netSavedChars = 0, netSavedIfHandleOnly = 0
    let enrichChars = 0, excerpted = 0, dumpSeen = 0, errorSeen = 0
    let archivePlanned = 0, archiveWritten = 0, archiveFailed = 0, archiveWriteChars = 0
    let toolResultChars = 0, archivedItems = 0, lensItems = 0, lensMax = 0
    const buckets = [0, 0, 0, 0], deltas = [], used = []
    const verify = { resolved: 0, unresolvable: 0, unverifiable: 0, noEvidence: 0 }
    let rechecks = 0
    for (const g of gs) {
      rechecks += g.cp ? g.cp.rechecks : 0
      const c = g.cp; if (!c) continue
      simulated += c.simulated
      enrichChars += c.enrichChars; excerpted += c.excerpted; dumpSeen += c.dumpSeen; errorSeen += c.errorSeen
      archivePlanned += c.archivePlanned; archiveWritten += c.archiveWritten
      archiveFailed += c.archiveFailed; archiveWriteChars += c.archiveWriteChars
      toolResultChars += c.toolResultChars; archivedItems += c.archivedItems
      lensItems += c.lensItems; lensMax = Math.max(lensMax, c.lensMax)
      for (let i = 0; i < 4; i++) buckets[i] += c.buckets[i]
      for (const k of Object.keys(verify)) verify[k] += c.verify[k]
      deltas.push(...c.measuredSurfaceTokenDelta); used.push(...c.usedTokens)
      for (const a of c.attempts.values()) {
        if (a.stage !== 'result') continue          // 未终结的尝试不计（进程可能就是在那一行被杀的）
        if (a.emitted === true) {
          emitted++
          // ★ 净收益只算**真正发射**的尝试：被闸门拦下的尝试既没省下上下文、也没改写表面
          if (Number.isFinite(a.netSavedChars)) netSavedChars += a.netSavedChars
          if (Number.isFinite(a.netSavedIfHandleOnly)) netSavedIfHandleOnly += a.netSavedIfHandleOnly
          if (Number.isFinite(a.sourceChars)) sourceChars += a.sourceChars
          if (Number.isFinite(a.ledgerChars)) ledgerChars += a.ledgerChars
        } else {
          blocked++
          const r = a.reason || 'unknown'
          blockedBy[r] = (blockedBy[r] || 0) + 1
        }
      }
    }
    // 保本预算：一次**整块**回读 ≈ 把一条归档原文按全价重新吃回上下文。
    //   平均条目字节用「工具结果总字符 / 归档条目数」估（含 carry 项时略偏大 ⇒ 预算偏保守）。
    const avgArchivedCharsEstimate = archivedItems > 0 ? Math.round(toolResultChars / archivedItems) : null
    const fullReadBacksAffordable = avgArchivedCharsEstimate && toolResultChars > 0
      ? Number((netSavedChars / avgArchivedCharsEstimate).toFixed(2)) : null
    return {
      emits: { emitted, blocked, simulated },
      blockedBy,
      chars: {
        sourceChars, ledgerChars, netSavedChars, netSavedIfHandleOnly,
        enrichChars, excerpted, dumpSeen, errorSeen,
        // 信息量：净收益已扣 P1 富化代价；上界是「完全不做富化」的对照腿
        enrichShareOfSaving: netSavedChars > 0 ? Number((enrichChars / netSavedChars).toFixed(3)) : null,
        unit: 'chars-not-tokenizer-tokens',
      },
      archive: { planned: archivePlanned, written: archiveWritten, failed: archiveFailed, writeChars: archiveWriteChars, rechecks },
      handle: verify,
      lens: { toolResultChars, archivedItems, toolResults: lensItems, max: lensMax, buckets: { lt2K: buckets[0], k2to8: buckets[1], k8to32: buckets[2], gt32K: buckets[3] } },
      measuredSurfaceTokenDelta: stats(deltas),
      usedTokens: stats(used),
      breakeven: {
        avgArchivedCharsEstimate,
        fullReadBacksAffordable,
        // 判据原文：净下降 − 读回成本 > 0。回读计数只有宿主侧看得到，故此处给预算而非常量。
        acceptanceRule: 'netSavedChars − readBackCost > 0；readBackCost ≈ 回读次数 × 条目均长',
        note: fullReadBacksAffordable == null
          ? 'no emitted attempt or no archived item — nothing to judge yet'
          : 'affordable full read-backs before this checkpoint path breaks even; a targeted read (search/lines) costs a small fraction of one',
      },
    }
  }

  return { add, result: () => ({ ignored, malformed, rotations, quantile: 'nearest-rank',
    warning: 'Per-BOOT samples only. Missing fields remain unknown; no causal or task-success claims.',
    toolResultPath: toolResultPath(groups),
    groups: groups.map(g => ({ ...g, cp: undefined, bt: undefined, x1: undefined, art: undefined, graceMs: undefined, birth: birthSummary(g), tokenCalibration: calibrationSummary(g),
      extractive: x1Summary(g.x1), handleRetrieval: artSummary(g.art),
      promptChars: stats(g.promptChars), durationMs: stats(g.durationMs) })) }) }
  function x1Summary(x1) {
    const out = {}
    for (const [v, b] of Object.entries(x1.byVersion)) {
      const rejected = Object.values(b.rejected).reduce((a, c) => a + c, 0)
      out[v] = { ...b, ratio: stats(b.ratio), fallbackRate: b.assembled + rejected ? +(rejected / (b.assembled + rejected)).toFixed(3) : null,
        overTargetRate: b.assembled ? +(b.overTarget / b.assembled).toFixed(3) : null }
    }
    return Object.keys(out).length ? out : null
  }
  function artSummary(a) {
    if (!a.records) return null
    return { ...a, retrievalRate: a.handlesMax ? +(a.retrievedMax / a.handlesMax).toFixed(3) : null,
      note: 'Per-request cumulative counts; max over records. A BOOT group may mix sessions, so rates are indicative only.' }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: node tools/analyze-trace.mjs trace.log'); process.exitCode = 2 }
  else {
    const audit = createTraceAudit()
    for await (const line of readline.createInterface({ input: fs.createReadStream(process.argv[2]), crlfDelay: Infinity })) audit.add(line)
    console.log(JSON.stringify(audit.result(), null, 2))
  }
}

/**
 * v11.11：最小二乘拟合 tokens ≈ wide·W + other·O + C。
 * 退化（样本只有一种书写系统 / 太少）时自动降维：去掉恒为 0 的那一列；仍不可解 ⇒ fit=null。
 * 同时报告现行估算（0.6/0.3，无截距）与拟合结果的平均绝对百分比误差，便于判断要不要改系数。
 * @param {Array<[number, number, number]>} samples [wide, other, tokens]
 */
export function fitTokenModel(samples) {
  const xs = (Array.isArray(samples) ? samples : []).filter((r) => Array.isArray(r) && r.every(Number.isFinite) && r[2] > 0)
  const n = xs.length
  const mape = (pred) => n ? Number((xs.reduce((a, r) => a + Math.abs(pred(r) - r[2]) / r[2], 0) / n).toFixed(3)) : null
  const current = (r) => r[0] * 0.6 + r[1] * 0.3
  const sumEst = xs.reduce((a, r) => a + current(r), 0), sumAct = xs.reduce((a, r) => a + r[2], 0)
  const base = { n, estimateOverActual: sumAct ? Number((sumEst / sumAct).toFixed(3)) : null, currentMape: mape(current) }
  if (n < 3) return { ...base, fit: null, fitMape: null, why: 'need >= 3 samples' }
  const cols = [0, 1].filter((j) => xs.some((r) => r[j] > 0))
  // 设计矩阵：选中的字符列 + 截距列
  const X = xs.map((r) => cols.map((j) => r[j]).concat(1)), y = xs.map((r) => r[2])
  const k = cols.length + 1
  if (n < k + 1) return { ...base, fit: null, fitMape: null, why: 'too few samples for ' + k + ' parameters' }
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((a, row) => a + row[i] * row[j], 0)))
  const b = Array.from({ length: k }, (_, i) => X.reduce((a, row, t) => a + row[i] * y[t], 0))
  const beta = solveLinear(A, b)
  if (!beta) return { ...base, fit: null, fitMape: null, why: 'degenerate samples' }
  const fit = { wide: null, other: null, intercept: Number(beta[k - 1].toFixed(2)) }
  cols.forEach((j, i) => { fit[j === 0 ? 'wide' : 'other'] = Number(beta[i].toFixed(4)) })
  const pred = (r) => cols.reduce((a, j, i) => a + beta[i] * r[j], 0) + beta[k - 1]
  return { ...base, fit, fitMape: mape(pred) }
}

function solveLinear(A, b) {
  const k = b.length, M = A.map((row, i) => row.concat(b[i]))
  for (let c = 0; c < k; c++) {
    let p = c
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    const scale = Math.max(1, ...M.map((row) => Math.abs(row[c])))
    if (Math.abs(M[p][c]) < 1e-9 * scale) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < k; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]
    }
  }
  return M.map((row, i) => row[k] / row[i])   // Gauss-Jordan 之后 row[i] 就是主元
}
