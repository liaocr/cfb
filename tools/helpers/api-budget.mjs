// 有界评测专用：冻结输入、全量预估、dispatch 前双平面预占；未知不退款/重试。
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { createEvidenceStore } from '../../src/evidence-store.js'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { makeChat, channelIssue, responseText } from '../effect-eval.mjs'
import { hasSecretMaterial } from './eval-files.mjs'
import { API_APPROVAL_SCOPE, apiStoreDirectory, assertExistingBudget, assertWatermark, commitWatermark } from './api-watermark.mjs'

export const APPROVED_API_LIMITS = Object.freeze({ maxRequests: 13, maxUsd: 2, maxMain: 12, maxProbe: 1, retries: 0, judges: 0 })
export const MINIMAL_TASK_IDS = Object.freeze(['flaky-timeout', 'wrong-model', 'eacces-config'])
const NANO = 1e9
export function inputTokenBound(body) {
  // 完整 JSON UTF-8 字节 + 4096 协议余量；保守工程估计，非供应商 tokenizer 数学证明。
  return Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096
}
export function quoteJob(body, pricing) {
  if (!pricing || !['inputUsdPerMillion', 'outputUsdPerMillion', 'requestFeeUsd'].every((k) => Number.isFinite(pricing[k]) && pricing[k] >= 0) || typeof pricing.source !== 'string' || !/^https:\/\//.test(pricing.source) || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.verifiedAt || '')) throw new Error('api-pricing-required')
  let source
  try { source = new URL(pricing.source) } catch { throw new Error('api-pricing-required') }
  if (source.username || source.password || source.search || source.hash || Object.keys(pricing).some((k) => !['inputUsdPerMillion', 'outputUsdPerMillion', 'requestFeeUsd', 'source', 'verifiedAt'].includes(k)) || !Number.isFinite(Date.parse(pricing.verifiedAt)) || Number.isFinite(Date.parse(pricing.verifiedAt)) && new Date(pricing.verifiedAt).toISOString().slice(0, 10) !== pricing.verifiedAt) throw new Error('api-pricing-required')
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 16000 || body.stream !== false || (body.n !== undefined && body.n !== 1)) throw new Error('api-output-limit')
  const inputTokens = inputTokenBound(body), outputTokens = body.max_tokens
  const reservedNano = Math.ceil((inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) * 1000 + pricing.requestFeeUsd * NANO)
  if (!Number.isSafeInteger(reservedNano) || reservedNano < 0) throw new Error('api-price-range')
  return Object.freeze({ inputTokens, outputTokens, reservedNano, reservedUsd: reservedNano / NANO })
}
export function auditApiPlan(plan, { allowUnpriced = false } = {}) {
  if (plan?.schema !== 'cfb.bounded-ab/1' || typeof plan.model !== 'string' || !/^[\w./:-]{1,120}$/.test(plan.model) || !Array.isArray(plan.jobs) || !plan.jobs.length || plan.jobs.length > 13) throw new Error('api-plan-schema')
  if (evidenceDigest(plan.limits) !== evidenceDigest(APPROVED_API_LIMITS)) throw new Error('api-approval-changed')
  let endpoint
  try { endpoint = new URL(plan.baseUrl) } catch { throw new Error('api-endpoint') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('api-endpoint')
  if (hasSecretMaterial(plan)) throw new Error('api-plan-secret-material')
  const keys = new Set(), quotes = {}; let main = 0, probe = 0, totalNano = 0
  for (const job of plan.jobs) {
    if (typeof job.key !== 'string' || !job.key || keys.has(job.key) || !['probe', 'main'].includes(job.kind) || job.body?.model !== plan.model || !Array.isArray(job.body.messages) || job.body.messages.some((m) => !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string' || m.reasoning_content !== undefined && typeof m.reasoning_content !== 'string')) throw new Error('api-job-schema')
    keys.add(job.key); job.kind === 'probe' ? probe++ : main++
    let quote
    if (allowUnpriced && plan.pricing === null) {
      if (!Number.isSafeInteger(job.body.max_tokens) || job.body.max_tokens < 1 || job.body.max_tokens > 16000 || job.body.stream !== false || job.body.n !== undefined && job.body.n !== 1) throw new Error('api-output-limit')
      quote = { inputTokens: inputTokenBound(job.body), outputTokens: job.body.max_tokens, reservedNano: null, reservedUsd: null }
    } else quote = quoteJob(job.body, plan.pricing)
    quotes[job.key] = quote; totalNano += quote.reservedNano ?? 0
  }
  if (probe !== 1 || plan.jobs[0].kind !== 'probe' || plan.jobs[0].key !== 'probe' || main !== 12 || typeof plan.canary !== 'string' || !/^CFB_CANARY_[a-f0-9]{32}$/.test(plan.canary)) throw new Error('api-matrix')
  const probeBody = plan.jobs[0].body, carriers = probeBody.messages.filter((m) => m.reasoning_content?.includes(plan.canary))
  const visibleProbe = { ...probeBody, messages: probeBody.messages.map(({ reasoning_content, ...m }) => m) }
  if (carriers.length !== 1 || carriers[0].role !== 'assistant' || JSON.stringify(visibleProbe).includes(plan.canary)) throw new Error('api-probe-leak')
  const strip = (b) => ({ ...b, messages: b.messages.map(({ reasoning_content, ...m }) => m) })
  for (const task of MINIMAL_TASK_IDS) for (const sample of [0, 1]) {
    const pair = ['raw', 'current'].map((variant) => plan.jobs.find((j) => j.kind === 'main' && j.task === task && j.sample === sample && j.variant === variant && j.obs === 'red' && j.key === `${task}|${variant}|${sample}`))
    if (pair.some((j) => !j) || evidenceDigest(strip(pair[0].body)) !== evidenceDigest(strip(pair[1].body))) throw new Error('api-matrix-protocol')
  }
  if (totalNano > 2 * NANO) throw new Error('api-budget-plan-exceeds-2usd')
  return immutableJson({ planDigest: evidenceDigest(plan), maxRequests: 13, maxUsd: 2, main, probe, priced: plan.pricing !== null, totalReservedUsd: plan.pricing === null ? null : totalNano / NANO, quotes })
}
function validateToolMessage(message, job) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw new Error('response-message-shape')
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('response-tool-shape')
  const calls = message.tool_calls || [], allowed = new Map((job.body.tools || []).map((t) => [t.function.name, t.function.parameters]))
  for (const c of calls) {
    const spec = allowed.get(c.function?.name)
    if (c.type !== 'function' || typeof c.id !== 'string' || !c.id || !spec || typeof c.function.arguments !== 'string') throw new Error('response-tool-shape')
    let args; try { args = JSON.parse(c.function.arguments) } catch { throw new Error('response-tool-arguments') }
    if (!args || typeof args !== 'object' || Array.isArray(args) || (spec.required || []).some((k) => !Object.hasOwn(args, k)) || Object.entries(args).some(([k, v]) => !spec.properties?.[k] || spec.properties[k].type === 'string' && typeof v !== 'string')) throw new Error('response-tool-arguments')
  }
  if (!String(message.content || '').trim() && !calls.length) throw new Error('response-empty')
}
function openBudget(plan, directory, receiptPath, { initialize = false, onStateCommitted = () => {} } = {}) {
  const file = receiptPath || path.resolve(directory) + '.watermark.json'
  const marker = assertExistingBudget(directory, file), home = apiStoreDirectory(directory)
  if (!initialize && !fs.existsSync(path.join(home, '.head-api-budget.json'))) return null
  const audit = auditApiPlan(plan)
  const store = createEvidenceStore({ directory, sessionId: API_APPROVAL_SCOPE })
  const read = () => {
    const head = store.readHead('api-budget')
    const state = head ? store.getJson(head.ref, { kind: 'api-budget' }) : { schema: 'cfb.api-budget/1', planDigest: audit.planDigest, entries: [], halted: null }
    if (state.planDigest !== audit.planDigest) throw new Error('api-plan-changed')
    if (head) assertWatermark(store, head, state, file)
    return { head, state }
  }
  const save = (head, state, initial = false) => {
    const next = store.setHead('api-budget', store.putJson(state, { kind: 'api-budget' }), { expectedRevision: head?.revision || null })
    commitWatermark(store, next, state, file, { initial })
    const hook = onStateCommitted({ sequence: next.sequence, requestsReserved: state.entries.length })
    if (hook && typeof hook.then === 'function') throw new Error('api-async-state-hook')
    return next
  }
  const head = store.readHead('api-budget')
  if (!head) {
    if (marker || !initialize) throw new Error('api-budget-restore-required')
    save(null, { schema: 'cfb.api-budget/1', planDigest: audit.planDigest, entries: [], halted: null }, true)
  }
  read()
  const cached = (key) => {
    const e = read().state.entries.find((e) => e.key === key && e.status === 'accepted')
    return e ? store.getJson(e.resultRef, { kind: 'api-response' }) : null
  }
  return { store, audit, read, save, cached, receiptPath: file }
}
/** 只读诊断/报告入口；不读 API key、不初始化仓、不发请求。 */
export function inspectApiBudget({ plan, directory, receiptPath }) {
  const budget = openBudget(plan, directory, receiptPath)
  return budget ? Object.freeze({ snapshot: () => budget.read().state, cached: budget.cached, receiptPath: budget.receiptPath, matchesCredential: (value) => typeof value === 'string' && (!budget.read().state.authTag || budget.read().state.authTag === crypto.createHmac('sha256', budget.store.authorityId).update(value).digest('hex')) }) : null
}
export function createBudgetedChat({ plan: input, apiKey, directory, receiptPath, fetchImpl = globalThis.fetch, timeoutMs = 240000, maxResponseBytes = 1024 * 1024, onStateCommitted }) {
  const plan = immutableJson(input)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('api-key-missing')
  const budget = openBudget(plan, directory, receiptPath, { initialize: true, onStateCommitted }), { store, audit, read, save } = budget
  const run = async (key, { signal } = {}) => {
    const job = plan.jobs.find((j) => j.key === key); if (!job) throw new Error('api-job-unregistered')
    let dispatched = false
    const chat = makeChat({ baseUrl: plan.baseUrl, apiKey, maxRetries: 0, fetchImpl, timeoutMs, maxResponseBytes, beforeRequest(body) {
      if (evidenceDigest(body) !== evidenceDigest(job.body)) throw new Error('api-request-changed')
      const { head, state } = read()
      if (state.halted) throw new Error('api-ledger-halted')
      const authTag = crypto.createHmac('sha256', store.authorityId).update(apiKey).digest('hex')
      if (state.authTag && state.authTag !== authTag) throw new Error('api-auth-context-changed')
      if (state.entries.some((e) => e.status === 'pending')) throw new Error('api-unsettled-dispatch')
      if (state.entries.some((e) => e.key === key)) throw new Error('api-job-already-dispatched')
      if (job.kind === 'main' && !state.entries.some((e) => e.kind === 'probe' && e.status === 'accepted')) throw new Error('api-probe-required')
      const reservedNano = audit.quotes[key].reservedNano
      if (state.entries.length >= 13 || state.entries.reduce((n, e) => n + e.reservedNano, 0) + reservedNano > 2 * NANO) throw new Error('api-budget-exhausted')
      save(head, { ...state, authTag, entries: [...state.entries, { key, kind: job.kind, reservedNano, status: 'pending' }] })
      dispatched = true   // 私有仓+公开收据全部 fsync 后才允许 fetch；任一写失败都不发。
    } })
    try {
      const r = await chat(job.body, { signal })
      const issue = channelIssue(r, plan.model); if (issue) throw new Error(issue)
      if (r.fp !== 'fp_dspure_app_v1') throw new Error('channel-fingerprint')
      if (!['stop', 'tool_calls'].includes(r.finish)) throw new Error('response-incomplete')
      if (hasSecretMaterial(r) || apiKey.length >= 16 && JSON.stringify(r).includes(apiKey)) throw new Error('response-secret-material')
      validateToolMessage(r.message, job)
      const quote = audit.quotes[key], u = r.usage
      if (!Number.isSafeInteger(u.prompt_tokens) || u.prompt_tokens < 0 || u.prompt_tokens > quote.inputTokens || !Number.isSafeInteger(u.completion_tokens) || u.completion_tokens < 0 || u.completion_tokens > quote.outputTokens) throw new Error('api-usage-out-of-bound')
      if (job.kind === 'probe' && responseText(r.message).trim() !== plan.canary) throw new Error('channel-history-not-visible')
      const clean = { ...r, message: { content: r.message.content ?? null, reasoning_content: r.message.reasoning_content, ...(r.message.tool_calls ? { tool_calls: r.message.tool_calls.map((c) => ({ id: c.id, type: c.type, function: { name: c.function.name, arguments: c.function.arguments } })) } : {}) }, usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens } }
      const { head, state } = read(), resultRef = store.putJson(clean, { kind: 'api-response' })
      save(head, { ...state, entries: state.entries.map((e) => e.key === key ? { ...e, status: 'accepted', resultRef, usage: clean.usage } : e) })
      return immutableJson(clean)
    } catch (e) {
      if (dispatched) {
        const { head, state } = read()
        if (state.entries.find((x) => x.key === key)?.status === 'accepted') throw new Error('api-checkpoint-write-failed')
        const reason = /^(?:channel-[a-z-]+|api-usage-out-of-bound|response-[a-z-]+|request-aborted|request-timeout|request-network-error|HTTP \d{3})$/.test(e.message) ? e.message : 'api-request-failed'
        save(head, { ...state, halted: reason, entries: state.entries.map((x) => x.key === key ? { ...x, status: 'rejected', reason } : x) })
        throw new Error(reason)
      }
      throw e
    }
  }
  return Object.freeze({ audit, snapshot: () => read().state, run, cached: budget.cached, receiptPath: budget.receiptPath })
}
