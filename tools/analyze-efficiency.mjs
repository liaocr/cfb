#!/usr/bin/env node
// Evidence for diagnosis, not an automatic semantic judge or billing estimator.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
// trace.log 一行 = `[ISO时间] [tag] {json}`（v12.1 从已删除的 tools/replay.mjs 搬来）
export function parseTrace(text) {
  return text.split('\n').flatMap(line => {
    const m = /^\[([^\]]+)\] \[([^\]]+)\] (\{.*\})$/.exec(line)
    if (!m) return []
    try { return [{ at: m[1], tag: m[2], ...JSON.parse(m[3]) }] } catch { return [] }
  })
}
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
      const task = id => { if (!tasks.has(id)) tasks.set(id, { taskId: id }); return tasks.get(id) }
      for (const r of g.rows) {
        if (r.tag === 'compiler-transport-started' && r.requestId) starts.set(r.requestId, r)
        if (r.tag === 'compiler-transport-settled' && r.requestId) completed.set(r.requestId, r)
        if (r.taskId) {
          const t = task(r.taskId)
          if (r.tag === 'compiler-preparation-cost') t.preparationMs = r.ms
          if (r.tag === 'birth-distill-settled') { t.ok = r.ok; t.reason = r.reason; t.requestId = r.requestId; t.promptVersion = r.promptVersion; t.inputAmplificationRatio = r.inputAmplificationRatio ?? r.compressRatio ?? null }
        }
      }
      const requests = [...new Set([...starts.keys(), ...completed.keys()])].map(id => {
        const r = completed.get(id), start = starts.get(id)
        return { requestId: id, model: start?.model || r?.model,
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
      // 放行原因分布（v12.1）：condensed 之外每一种原文放行都在这里，含 invented-identifier（发明标识符闸）
      const outcomes = {
        condensed: count('birth-condensed'),
        passthrough: Object.fromEntries([...g.rows.filter(r => r.tag === 'birth-passthrough').reduce((m, r) => m.set(r.why || 'unknown', (m.get(r.why || 'unknown') || 0) + 1), new Map())]),
        inventedSamples: g.rows.filter(r => r.tag === 'birth-passthrough' && r.why === 'invented-identifier').slice(0, 20).map(r => r.invented || []),
        retrySkipped: count('compiler-retry-skipped'),
        // 按 promptVersion 分桶的成功率与长度（长度是字符，不是语义保真）
        promptVersions: Object.fromEntries([...g.rows.filter(r => r.tag === 'birth-distill-settled').reduce((m, r) => {
          const k = r.promptVersion || 'unknown'; const b = m.get(k) || { settled: 0, ok: 0, chars: [] }
          b.settled++; if (r.ok) { b.ok++; b.chars.push(r.chars) } m.set(k, b); return m }, new Map())].map(([k, b]) => [k, { settled: b.settled, ok: b.ok, outputChars: distribution(b.chars) }])),
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
      // ★ v11.7 观测段：对冲与收尾宽限的真机效果，只做计数与分布，不做收益结论。
      const hs = g.rows.filter(r => r.tag === 'compiler-hedge-settled')
      const hedge = { samples: hs.length, fired: hs.filter(r => r.fired).length, hedgeWon: hs.filter(r => r.winner === 'hedge').length,
        ttfbMsWhenFired: distribution(hs.filter(r => r.fired).map(r => r.ttfbMs)), ttfbMsWhenNotFired: distribution(hs.filter(r => !r.fired).map(r => r.ttfbMs)) }
      const gs = g.rows.filter(r => r.tag === 'birth-finish-headers-grace')
      const headersGrace = { samples: gs.length, rescued: gs.filter(r => r.settled).length, waitedMs: distribution(gs.map(r => r.waitedMs)),
        headersSinceFiredMs: distribution(g.rows.filter(r => r.tag === 'birth-distill-headers').map(r => r.sinceFiredMs)) }
      return { bootIndex: g.bootIndex, anchored: g.anchored, boot: g.boot,
        windowProbe, economics, fidelity, hedge, headersGrace,
        counts: { transportAttemptsStarted: starts.size, transportAttemptsSettled: completed.size,
          archiveTerminalConsumers: count('compiler-consumer-unusable') },
        outcomes,
        preparationMs: distribution(ts.map(t => t.preparationMs)), transportTimings, requests, tasks: ts }
    }), productAcceptance: '未验收', billingSavings: null,
    limitations: ['BOOT partitions are not pooled; an unanchored prefix cannot establish a configuration epoch.',
      'Transport-started is an attempted request, not proof of provider receipt or billing. Each retry has a distinct requestId.',
      'Usage is deduplicated by requestId and remains provider-reported.',
      'Endpoint labels identify provider/API, not full URL or credential epochs; route or credential hot-reconfiguration still requires separate external attribution.',
      'Content timestamps do not establish completion; the original full-success gate is unchanged.',
      'Use the existing paired full-session replay and independent audit for product acceptance.'] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, output] = process.argv.slice(2)
  if (!file) { console.error('Usage: node tools/analyze-efficiency.mjs TRACE [OUTPUT]'); process.exitCode = 2 }
  else { const report = JSON.stringify(analyzeEfficiency(fs.readFileSync(file, 'utf8')), null, 2) + '\n'; if (output) fs.writeFileSync(output, report); else console.log(report) }
}
