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
import fs from 'node:fs'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const freshCp = () => ({
  attempts: new Map(), emitted: 0, blocked: 0, blockedBy: Object.create(null),
  enrichChars: 0, excerpted: 0, dumpSeen: 0, errorSeen: 0,
  archivePlanned: 0, archiveWritten: 0, archiveFailed: 0, archiveWriteChars: 0,
  verify: { resolved: 0, unresolvable: 0, unverifiable: 0, noEvidence: 0 },
  toolResultChars: 0, archivedItems: 0, lensItems: 0, simulated: 0, rechecks: 0,
  measuredSurfaceTokenDelta: [], usedTokens: [], lensMax: 0, buckets: [0, 0, 0, 0],
})

export function createTraceAudit() {
  const groups = []; let current = null, ignored = 0, malformed = 0
  const fresh = (at, boot) => ({ start: at, boot: boot ? {
    selfId: boot.selfId ?? null, deps: boot.deps ?? null, mode: boot.mode ?? null,
    timeoutMs: boot.timeoutMs ?? null, birthFinishWaitMs: boot.birth?.finishWaitMs ?? boot.birthFinishWaitMs ?? null,
    dryRun: boot.dryRun ?? null,
  } : null, events: Object.create(null), settled: { ok: 0, failed: 0, unknown: 0 },
    reasons: Object.create(null), promptChars: [], durationMs: [], coverObserved: 0, cp: freshCp() })
  function add(line) {
    const m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/.exec(line)
    if (!m) { ignored++; return }
    let obj; try { obj = JSON.parse(m[3]) } catch { malformed++; return }
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

  return { add, result: () => ({ ignored, malformed, quantile: 'nearest-rank',
    warning: 'Per-BOOT samples only. Missing fields remain unknown; no causal or task-success claims.',
    toolResultPath: toolResultPath(groups),
    groups: groups.map(g => ({ ...g, cp: undefined, promptChars: stats(g.promptChars), durationMs: stats(g.durationMs) })) }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: node tools/analyze-trace.mjs trace.log'); process.exitCode = 2 }
  else {
    const audit = createTraceAudit()
    for await (const line of readline.createInterface({ input: fs.createReadStream(process.argv[2]), crlfDelay: Infinity })) audit.add(line)
    console.log(JSON.stringify(audit.result(), null, 2))
  }
}
