#!/usr/bin/env node
// Evidence for diagnosis, not an automatic semantic judge or billing estimator.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { parseTrace } from './replay.mjs'
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
function distribution(values) {
  const xs = values.filter(valid).sort((a, b) => a - b)
  const q = p => xs.length ? xs[Math.ceil(xs.length * p) - 1] : null
  return { samples: xs.length, p50: q(.5), p90: q(.9), max: xs.at(-1) ?? null }
}
function signedDistribution(values) {
  const xs = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  const q = p => xs.length ? xs[Math.ceil(xs.length * p) - 1] : null
  return { samples: xs.length, p50: q(.5), p90: q(.9), min: xs[0] ?? null, max: xs.at(-1) ?? null,
    sum: xs.length ? xs.reduce((a, b) => a + b, 0) : 0, mean: xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null }
}
function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  const input = u.prompt_tokens ?? u.input_tokens
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens
  return { inputTokens: valid(input) ? input : null,
    cachedInputTokens: valid(cached) && valid(input) && cached <= input ? cached : null,
    source: 'provider-reported-not-invoice', raw: u }
}
export function analyzeEfficiency(text) {
  const boots = [], rows = parseTrace(text)
  let group
  for (const r of rows) {
    if (!group || r.tag === 'BOOT') { group = { bootIndex: boots.length, anchored: r.tag === 'BOOT', boot: r.tag === 'BOOT' ? r : null, rows: [] }; boots.push(group) }
    group.rows.push(r)
  }
  return { kind: 'compiler-efficiency-diagnostics', sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    boots: boots.map(g => {
      const starts = new Map(), completed = new Map(), tasks = new Map()
      const task = id => { if (!tasks.has(id)) tasks.set(id, { taskId: id, presented: 0, acknowledged: false, semanticUse: null }); return tasks.get(id) }
      for (const r of g.rows) {
        if (r.tag === 'compiler-transport-started' && r.requestId) starts.set(r.requestId, r)
        if (r.tag === 'compiler-transport-settled' && r.requestId) completed.set(r.requestId, r)
        if (r.taskId) {
          const t = task(r.taskId)
          if (r.tag === 'compiler-preparation-cost') t.preparationMs = r.ms
          if (r.tag === 'birth-distill-settled') { t.ok = r.ok; t.reason = r.reason; t.requestId = r.requestId; t.flightId = r.flightId; t.sharedFlight = r.sharedFlight; t.promptVersion = r.promptVersion; t.parseRenderMs = r.parseRenderMs; t.promptBuildMs = r.promptBuildMs; t.inputAmplificationRatio = r.inputAmplificationRatio ?? r.compressRatio ?? null }
          if (r.tag === 'memory-presented-in-options') t.presented++
        }
        if (r.tag === 'birth-claim-acknowledged') for (const id of r.taskIds || []) task(id).acknowledged = true
      }
      const requests = [...new Set([...starts.keys(), ...completed.keys()])].map(id => {
        const r = completed.get(id), start = starts.get(id)
        return { requestId: id, flightId: r?.flightId || start?.flightId, model: start?.model || r?.model,
          timeoutMs: start?.timeoutMs, endpoint: start?.endpoint ?? r?.endpoint,
          maxOutputTokens: start?.maxOutputTokens ?? r?.maxOutputTokens, thinkingOff: start?.thinkingOff ?? r?.thinkingOff,
          stream: start?.stream ?? r?.stream, promptVersion: start?.promptVersion ?? null, ok: r?.ok ?? null, reason: r?.reason ?? null,
          stage: r?.stage ?? null, toFirstContentMs: r?.toFirstContentMs ?? null,
          contentSpanMs: r?.contentSpanMs ?? null, afterContentMs: r?.afterContentMs ?? null,
          totalMs: r?.totalMs ?? null, usage: usageOf(r?.providerReportedUsage) }
      })
      const ts = [...tasks.values()]
      // Partition success/failure; never compare a mixed latency percentile as
      // though it described successful compiles or a different BOOT/config.
      const profiles = new Map()
      for (const r of requests) {
        const config = Object.fromEntries(['model', 'endpoint', 'timeoutMs', 'maxOutputTokens', 'thinkingOff', 'stream', 'promptVersion'].map(k => [k, r[k] ?? null]))
        const key = JSON.stringify(config)
        if (!profiles.has(key)) profiles.set(key, { config, requests: [] })
        profiles.get(key).requests.push(r)
      }
      const transportTimings = [...profiles.values()].map(p => {
        const timings = {}
        for (const [label, ok] of [['successfulTransport', true], ['failedTransport', false]]) {
          const set = p.requests.filter(r => r.ok === ok)
          timings[label] = Object.fromEntries(['toFirstContentMs', 'contentSpanMs', 'afterContentMs', 'totalMs'].map(k => [k, distribution(set.map(r => r[k]))]))
        }
        return { config: p.config, ...timings }
      })
      const count = tag => g.rows.filter(r => r.tag === tag).length
      const netCandidates = g.rows.filter(r => r.tag === 'emit-net-savings')
      const netBlockedIds = new Set(g.rows.filter(r => r.tag === 'emit-no-net-savings').map(r => r.emitAttemptId).filter(Boolean))
      const netResults = g.rows.filter(r => r.tag === 'emit-net-savings-result')
      const netEvaluatedIds = new Set(netCandidates.map(r => r.emitAttemptId).filter(Boolean))
      const emittedResults = netResults.filter(r => r.stage === 'emit' && r.emitted === true && netEvaluatedIds.has(r.emitAttemptId))
      const passedGateIds = new Set([...netEvaluatedIds].filter(id => !netBlockedIds.has(id)))
      const finalizedPassedIds = new Set(netResults.filter(r => passedGateIds.has(r.emitAttemptId) && r.stage !== 'gate').map(r => r.emitAttemptId))
      const gatePassed = Math.max(0, netCandidates.length - g.rows.filter(r => r.tag === 'emit-no-net-savings').length)
      const evaluatedCount = netCandidates.length
      const blockedCount = g.rows.filter(r => r.tag === 'emit-no-net-savings').length
      const measuredEmits = emittedResults.filter(r => Number.isFinite(r.measuredSurfaceTokenDelta))
      const tokenDeltas = measuredEmits.map(r => r.measuredSurfaceTokenDelta)
      // ★ 迟到认领漏斗：每一级都是**计数**，不是收益。stored>0 而 claimHit=0 = 积压，不是修复。
      const claimFunnel = {
        compiled: ts.filter(t => t.ok === true).length,
        passedThrough: count('birth-passthrough'),
        stored: count('birth-late-memory-stored'),
        storeRefused: count('birth-late-memory-refused'),
        opportunity: count('birth-claim-opportunity'),
        claimHit: count('birth-claim-hit'),
        claimMiss: Object.fromEntries([...g.rows.filter(r => r.tag === 'birth-claim-miss').reduce((m, r) => m.set(r.why || 'unknown', (m.get(r.why || 'unknown') || 0) + 1), new Map())]),
        // no-candidate 细分：miss 当时还有编译在飞（"还没轮到"）vs 没有任何在飞（真正找不到 ⇒ 候选选择/身份问题）
        claimMissNoCandidateInFlight: g.rows.filter(r => r.tag === 'birth-claim-miss' && r.why === 'no-candidate' && (r.inFlight || 0) > 0).length,
        claimMissNoCandidateIdle: g.rows.filter(r => r.tag === 'birth-claim-miss' && r.why === 'no-candidate' && !(r.inFlight > 0)).length,
        claimSkip: Object.fromEntries([...g.rows.filter(r => r.tag === 'birth-claim-skip').reduce((m, r) => m.set(r.reason || 'unknown', (m.get(r.reason || 'unknown') || 0) + 1), new Map())]),
        emitted: count('birth-claim-emitted'),
        acknowledged: count('birth-claim-acknowledged'),
        presentedInOptions: count('memory-presented-in-options'),
        meaning: 'counts-per-boot; stored without claimHit is backlog, not delivery',
      }
      const carryRows = g.rows.filter(r => r.tag === 'ledger-built')
      const v11 = {
        retargetReady: count('emit-retarget-ready'),
        retargetRefusedBoardSingleton: count('emit-retarget-refused-board-singleton'),
        spanUnreadable: count('emit-span-unreadable'),
        retrySkipped: count('compiler-retry-skipped'),
        noRawRetargetTried: g.rows.filter(r => r.tag === 'emit-no-raw' && r.retargetTried === true).length,
        refusedRangeNonMonotonic: g.rows.filter(r => r.tag === 'emit-refused-range' && r.monotonic === false).length,
        // v1/v2 A/B：按 promptVersion 分桶的成功率与长度（长度是字符，不是语义保真）
        promptVersions: Object.fromEntries([...g.rows.filter(r => r.tag === 'birth-distill-settled').reduce((m, r) => {
          const k = r.promptVersion || 'unknown'; const b = m.get(k) || { settled: 0, ok: 0, chars: [] }
          b.settled++; if (r.ok) { b.ok++; b.chars.push(r.chars) } m.set(k, b); return m }, new Map())].map(([k, b]) => [k, { settled: b.settled, ok: b.ok, outputChars: distribution(b.chars) }])),
        carryChars: distribution(carryRows.map(r => r.carryChars)),
        carryInlineChars: distribution(carryRows.map(r => r.carryInlineChars)),
        carryOverflow: carryRows.filter(r => r.carryOverflow === true).length,
        carryBudgetOverflow: carryRows.reduce((n, r) => n + (r.carryBudgetOverflow || 0), 0),
        carryItemOversize: carryRows.reduce((n, r) => n + (r.carryItemOversize || 0), 0),
        carryCounts: { boards: distribution(g.rows.filter(r => r.tag === 'emit-carry').map(r => r.boards)),
          reasoning: distribution(g.rows.filter(r => r.tag === 'emit-carry').map(r => r.reasoning)),
          userInputs: distribution(g.rows.filter(r => r.tag === 'emit-carry').map(r => r.userInputs)),
          answers: distribution(g.rows.filter(r => r.tag === 'emit-carry').map(r => r.answers)),
          calls: distribution(g.rows.filter(r => r.tag === 'emit-carry').map(r => r.calls)) },
        ledgerChars: distribution(carryRows.map(r => r.ledgerChars ?? r.chars)),
        sourceChars: distribution(g.rows.filter(r => r.tag === 'emit-net-savings').map(r => r.sourceChars)),
        netSavedChars: distribution(g.rows.filter(r => r.tag === 'emit-net-savings').map(r => r.netSavedChars)),
        noNetSavings: count('emit-no-net-savings'),
        netSavingsGate: {
          evaluated: evaluatedCount,
          blocked: blockedCount,
          blockedShare: evaluatedCount ? Number((blockedCount / evaluatedCount).toFixed(4)) : null,
          passedGate: gatePassed,
          emittedAfterGate: emittedResults.length,
          postGateNotEmitted: Math.max(0, finalizedPassedIds.size - emittedResults.length),
          unfinalizedAfterGate: Math.max(0, passedGateIds.size - finalizedPassedIds.size),
          attemptCorrelationSamples: netEvaluatedIds.size,
          traceEmitReplaced: count('emit-replaced'),
          sourceChars: distribution(netCandidates.map(r => r.sourceChars)),
          candidateNetSavedChars: signedDistribution(netCandidates.map(r => r.netSavedChars)),
          realizedNetSavedChars: signedDistribution(emittedResults.map(r => r.netSavedChars)),
          tokenMeterSamples: tokenDeltas.length,
          measuredSurfaceTokenDelta: signedDistribution(tokenDeltas),
          measuredPositiveTokenSavings: tokenDeltas.filter(x => x > 0).length,
          measuredPositiveTokenSavingsShare: tokenDeltas.length ? Number((tokenDeltas.filter(x => x > 0).length / tokenDeltas.length).toFixed(4)) : null,
          measuredNonPositiveTokenSavings: tokenDeltas.filter(x => x <= 0).length,
          note: 'positive measuredSurfaceTokenDelta means host-meter surface tokens fell; this is not provider billing. Character deltas are not tokenizer counts.',
        },
      }
      // ★ v11.6 观测段（2026-09-23）。三者都只是诊断证据，不是收益证明。
      //   windowProbe：免费窗口是否存在。判读：otherStartToLastEndMs p50 > 1000 ⇒ 有窗口（可提前起火）；
      //                lastEndToFinishMs≈0 且 otherStartToLastEndMs≈0/null ⇒ 宿主攒完再发，无窗口。
      //   economics  ：成本模型三态分布（below-abs / below-min / ok）与 R 来源；用于标定动态门槛，不参与判定。
      //   fidelity   ：identifierRecall 分布，按 promptVersion 分桶；unmeasurable 单独计数、绝不算 pass。
      const probes = g.rows.filter(r => r.tag === 'birth-window-probe')
      const windowProbe = { samples: probes.length,
        otherStartToLastEndMs: signedDistribution(probes.map(r => r.otherStartToLastEndMs)),
        lastEndToFinishMs: distribution(probes.map(r => r.lastEndToFinishMs)),
        noOtherBlock: probes.filter(r => r.firstOtherStartMs == null).length,
        firstOtherType: Object.fromEntries([...probes.reduce((m, r) => m.set(r.firstOtherType || 'none', (m.get(r.firstOtherType || 'none') || 0) + 1), new Map())]),
        verdict: probes.length < 5 ? 'insufficient-samples' : null }
      if (windowProbe.verdict === null) {
        const p50 = windowProbe.otherStartToLastEndMs.p50
        windowProbe.verdict = p50 != null && p50 > 1000 ? 'window-exists' : (p50 != null && p50 < 0 ? 'block-end-already-earliest' : 'no-window')
      }
      const econRows = g.rows.filter(r => r.tag === 'birth-econ')
      const economics = { samples: econRows.length,
        verdict: Object.fromEntries([...econRows.reduce((m, r) => m.set(r.verdict || 'unknown', (m.get(r.verdict || 'unknown') || 0) + 1), new Map())]),
        rSource: Object.fromEntries([...econRows.reduce((m, r) => m.set(r.rSource || 'unknown', (m.get(r.rSource || 'unknown') || 0) + 1), new Map())]),
        B: distribution(econRows.map(r => r.B)), bMin: distribution(econRows.map(r => r.bMin)), netAtTarget: signedDistribution(econRows.map(r => r.netAtTarget)) }
      const condensed = g.rows.filter(r => r.tag === 'birth-condensed' && r.fidelity)
      const byPv = new Map()
      for (const r of condensed) {
        const pv = (ts.find(t => t.taskId === r.taskId) || {}).promptVersion || 'unknown'
        if (!byPv.has(pv)) byPv.set(pv, { measured: [], unmeasurable: 0 })
        if (r.fidelity.unmeasurable) byPv.get(pv).unmeasurable++
        else byPv.get(pv).measured.push(r.fidelity.identifierRecall)
      }
      const fidelity = { samples: condensed.length,
        byPromptVersion: Object.fromEntries([...byPv].map(([pv, v]) => [pv, { measured: v.measured.length, unmeasurable: v.unmeasurable,
          identifierRecall: distribution(v.measured), below95: v.measured.filter(x => x < 95).length }])),
        meaning: 'identifier-recall-is-a-necessary-condition-not-fidelity-proof' }
      return { bootIndex: g.bootIndex, anchored: g.anchored, boot: g.boot,
        windowProbe, economics, fidelity,
        counts: { transportAttemptsStarted: starts.size, transportAttemptsSettled: completed.size,
          sharedAttachments: count('compiler-flight-shared'),
          archiveTerminalConsumers: count('compiler-consumer-unusable') },
        claimFunnel, v11,
        preparationMs: distribution(ts.map(t => t.preparationMs)), parseRenderMs: distribution(ts.map(t => t.parseRenderMs)), transportTimings, requests, tasks: ts,
        decisionReview: ts.filter(t => t.acknowledged || t.presented).map(t => ({ taskId: t.taskId, requestId: t.requestId ?? null,
          observedInOptions: t.presented > 0, subsequentRoundIds: null, goalId: null,
          usedJudgmentEvidence: null, repeatedExploration: null, wrongStateRoute: null, reviewer: null })) }
    }), productAcceptance: '未验收', billingSavings: null,
    limitations: ['BOOT partitions are not pooled; an unanchored prefix cannot establish a configuration epoch.',
      'Transport-started is an attempted request, not proof of provider receipt or billing. Each retry has a distinct requestId.',
      'Shared attachments do not imply saved money; usage is deduplicated by requestId and remains provider-reported.',
      'Endpoint labels identify provider/API, not full URL or credential epochs; route or credential hot-reconfiguration still requires separate external attribution.',
      'Content timestamps do not establish completion; the original full-success gate is unchanged.',
      'Decision-review fields are intentionally null. Presentation/acknowledgment cannot establish understanding, repetition or causality.',
      'Use the existing paired full-session replay and independent audit for product acceptance.'] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, output] = process.argv.slice(2)
  if (!file) { console.error('Usage: node analyze-efficiency.mjs TRACE [OUTPUT]'); process.exitCode = 2 }
  else { const report = JSON.stringify(analyzeEfficiency(fs.readFileSync(file, 'utf8')), null, 2) + '\n'; if (output) fs.writeFileSync(output, report); else console.log(report) }
}
