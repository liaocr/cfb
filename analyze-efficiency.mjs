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
          if (r.tag === 'birth-distill-settled') { t.ok = r.ok; t.reason = r.reason; t.requestId = r.requestId; t.flightId = r.flightId; t.sharedFlight = r.sharedFlight; t.promptVersion = r.promptVersion; t.parseRenderMs = r.parseRenderMs; t.promptBuildMs = r.promptBuildMs }
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
      return { bootIndex: g.bootIndex, anchored: g.anchored, boot: g.boot,
        counts: { transportAttemptsStarted: starts.size, transportAttemptsSettled: completed.size,
          sharedAttachments: g.rows.filter(r => r.tag === 'compiler-flight-shared').length,
          archiveTerminalConsumers: g.rows.filter(r => r.tag === 'compiler-consumer-unusable').length },
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
