// 有界评测专用：冻结输入、全量预估、dispatch 前持久预占；未知/失败不退款、不重试。
// 复用本地证据仓 HMAC + CAS。它不是服务商账单锁，也不是同权限进程的 OS 沙箱。
import { createEvidenceStore } from '../../src/evidence-store.js'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { makeChat, channelIssue, responseText } from '../effect-eval.mjs'

export const APPROVED_API_LIMITS = Object.freeze({ maxRequests: 13, maxUsd: 2, maxMain: 12, maxProbe: 1, retries: 0, judges: 0 })
const NANO = 1e9
export function inputTokenBound(body) {
  // 对当前 byte-level 文本接口的保守估计，不冒充供应商 tokenizer 的严格数学上界。
  // 完整 JSON UTF-8 字节 + 4096 协议/注入余量；响应 usage 越界立即停。
  return Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096
}
export function quoteJob(body, pricing) {
  if (!pricing || !['inputUsdPerMillion', 'outputUsdPerMillion', 'requestFeeUsd'].every((k) => Number.isFinite(pricing[k]) && pricing[k] >= 0) || typeof pricing.source !== 'string' || !/^https:\/\//.test(pricing.source) || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.verifiedAt || '')) throw new Error('api-pricing-required')
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 16000 || body.stream !== false || (body.n !== undefined && body.n !== 1)) throw new Error('api-output-limit')
  const inputTokens = inputTokenBound(body), outputTokens = body.max_tokens
  const reservedNano = Math.ceil((inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) * 1000 + pricing.requestFeeUsd * NANO)
  if (!Number.isSafeInteger(reservedNano) || reservedNano < 0) throw new Error('api-price-range')
  return Object.freeze({ inputTokens, outputTokens, reservedNano, reservedUsd: reservedNano / NANO })
}
export function auditApiPlan(plan) {
  if (plan?.schema !== 'cfb.bounded-ab/1' || typeof plan.model !== 'string' || !plan.model || !Array.isArray(plan.jobs) || !plan.jobs.length || plan.jobs.length > 13) throw new Error('api-plan-schema')
  const endpoint = new URL(plan.baseUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('api-endpoint')
  const keys = new Set(), quotes = {}
  let main = 0, probe = 0, totalNano = 0
  for (const job of plan.jobs) {
    if (typeof job.key !== 'string' || !job.key || keys.has(job.key) || !['probe', 'main'].includes(job.kind) || job.body?.model !== plan.model) throw new Error('api-job-schema')
    keys.add(job.key); job.kind === 'probe' ? probe++ : main++
    const quote = quoteJob(job.body, plan.pricing); quotes[job.key] = quote; totalNano += quote.reservedNano
  }
  if (probe !== 1 || plan.jobs[0].kind !== 'probe' || main > 12 || typeof plan.canary !== 'string' || !/^CFB_CANARY_[a-f0-9]{32}$/.test(plan.canary)) throw new Error('api-matrix')
  const probeBody = plan.jobs[0].body, carriers = probeBody.messages.filter((m) => m.reasoning_content?.includes(plan.canary))
  const visibleProbe = { ...probeBody, messages: probeBody.messages.map(({ reasoning_content, ...m }) => m) }
  if (carriers.length !== 1 || carriers[0].role !== 'assistant' || JSON.stringify(visibleProbe).includes(plan.canary)) throw new Error('api-probe-leak')
  if (totalNano > 2 * NANO) throw new Error('api-budget-plan-exceeds-2usd')
  return immutableJson({ planDigest: evidenceDigest(plan), maxRequests: 13, maxUsd: 2, main, probe, totalReservedUsd: totalNano / NANO, quotes })
}

export function createBudgetedChat({ plan: input, apiKey, directory, fetchImpl = globalThis.fetch, timeoutMs = 240000 }) {
  const plan = immutableJson(input), audit = auditApiPlan(plan)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('api-key-missing')
  // 固定批准 scope，不把 plan hash 放进 sessionId：换稿/改价不能重置同一次批准的计数。
  const store = createEvidenceStore({ directory, sessionId: 'cfb.minimal-api-approval.2026-09-30' })
  const read = () => {
    const head = store.readHead('api-budget')
    const state = head ? store.getJson(head.ref, { kind: 'api-budget' }) : { schema: 'cfb.api-budget/1', planDigest: audit.planDigest, entries: [], halted: null }
    if (state.planDigest !== audit.planDigest) throw new Error('api-plan-changed')
    return { head, state }
  }
  const save = (head, state) => store.setHead('api-budget', store.putJson(state, { kind: 'api-budget' }), { expectedRevision: head?.revision || null })
  const initial = read(); if (!initial.head) save(initial.head, initial.state)
  const snapshot = () => read().state
  const run = async (key, { signal } = {}) => {
    const job = plan.jobs.find((j) => j.key === key); if (!job) throw new Error('api-job-unregistered')
    let dispatched = false
    const chat = makeChat({ baseUrl: plan.baseUrl, apiKey, maxRetries: 0, fetchImpl, timeoutMs, beforeRequest(body) {
      if (evidenceDigest(body) !== evidenceDigest(job.body)) throw new Error('api-request-changed')
      const { head, state } = read()
      if (state.halted) throw new Error('api-ledger-halted')
      if (state.entries.some((e) => e.status === 'pending')) throw new Error('api-unsettled-dispatch')
      if (state.entries.some((e) => e.key === key)) throw new Error('api-job-already-dispatched')
      if (job.kind === 'main' && !state.entries.some((e) => e.kind === 'probe' && e.status === 'accepted')) throw new Error('api-probe-required')
      const reservedNano = audit.quotes[key].reservedNano
      if (state.entries.length >= 13 || state.entries.reduce((n, e) => n + e.reservedNano, 0) + reservedNano > 2 * NANO) throw new Error('api-budget-exhausted')
      save(head, { ...state, entries: [...state.entries, { key, kind: job.kind, reservedNano, status: 'pending' }] })
      dispatched = true   // 先写仓，再允许 fetch；崩溃/网络未知也占请求/费用，不自动补票。
    } })
    try {
      const r = await chat(job.body, { signal })
      const issue = channelIssue(r, plan.model)
      if (issue) throw new Error(issue)
      if (r.fp !== 'fp_dspure_app_v1') throw new Error('channel-fingerprint')
      if (!['stop', 'tool_calls'].includes(r.finish)) throw new Error('response-incomplete')
      const quote = audit.quotes[key], u = r.usage
      if (!Number.isSafeInteger(u.prompt_tokens) || u.prompt_tokens < 0 || u.prompt_tokens > quote.inputTokens || !Number.isSafeInteger(u.completion_tokens) || u.completion_tokens < 0 || u.completion_tokens > quote.outputTokens) throw new Error('api-usage-out-of-bound')
      if (job.kind === 'probe' && responseText(r.message).trim() !== plan.canary) throw new Error('channel-history-not-visible')
      const { head, state } = read()
      const resultRef = store.putJson(r, { kind: 'api-response' })
      save(head, { ...state, entries: state.entries.map((e) => e.key === key ? { ...e, status: 'accepted', resultRef, usage: u } : e) })
      return r
    } catch (e) {
      if (dispatched) {
        const { head, state } = read()
        const reason = /^(?:channel-[a-z-]+|api-usage-out-of-bound|response-incomplete|response-json|response-shape|request-aborted|request-timeout|request-network-error|HTTP \d{3})$/.test(e.message) ? e.message : 'api-request-failed'
        save(head, { ...state, halted: reason, entries: state.entries.map((x) => x.key === key ? { ...x, status: 'rejected', reason } : x) })
        throw new Error(reason)
      }
      throw e
    }
  }
  const cached = (key) => {
    const entry = snapshot().entries.find((e) => e.key === key && e.status === 'accepted')
    return entry ? store.getJson(entry.resultRef, { kind: 'api-response' }) : null
  }
  return Object.freeze({ audit, snapshot, run, cached })
}
