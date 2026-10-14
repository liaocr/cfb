// Paid reader smoke helpers. Never persist prompt or provider-response bodies.
import fs from 'node:fs'
import crypto from 'node:crypto'

const NANO = 1_000_000_000
const ARMS = Object.freeze(['raw-a', 'raw-b', 'reference'])
const DEFAULTS = Object.freeze({
  maxRequests: 9,
  maxUsd: 5,
  maxRetries: 0,
  maxInputTokens: 32768,
  maxOutputTokens: 512,
  timeoutMs: 120000,
  maxResponseBytes: 1024 * 1024,
  requestFeeUsd: 0,
})
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function budgetError(code) {
  const e = new Error(code)
  e.code = code
  return e
}
function envNumber(env, name, { fallback, required = false, integer = false, min, max } = {}) {
  const raw = env[name]
  if (raw === undefined) {
    if (required) throw new Error(`reader-smoke-config-required:${name}`)
    return fallback
  }
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(raw.trim())) throw new Error(`reader-smoke-config-invalid:${name}`)
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`reader-smoke-config-invalid:${name}`)
  return n
}
function validHttpsUrl(value, code) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(code)
  let u
  try { u = new URL(value) } catch { throw new Error(code) }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(code)
  return u
}
export function parseReaderSmokeConfig(env = process.env, { forExecution = false } = {}) {
  const pricingFields = ['INPUT_USD_PER_MILLION', 'OUTPUT_USD_PER_MILLION', 'PRICING_SOURCE', 'PRICING_VERIFIED_AT']
  if (forExecution) {
    for (const key of ['MAX_REQUESTS', 'MAX_USD', ...pricingFields]) if (env[key] === undefined || env[key] === '') throw new Error(`reader-smoke-config-required:${key}`)
  }
  const config = {
    maxRequests: envNumber(env, 'MAX_REQUESTS', { fallback: DEFAULTS.maxRequests, required: forExecution, integer: true, min: 1, max: 1000 }),
    maxUsd: envNumber(env, 'MAX_USD', { fallback: DEFAULTS.maxUsd, required: forExecution, min: 0.000000001, max: 1000 }),
    maxRetries: envNumber(env, 'MAX_RETRIES', { fallback: DEFAULTS.maxRetries, integer: true, min: 0, max: 10 }),
    maxInputTokens: envNumber(env, 'MAX_INPUT_TOKENS', { fallback: DEFAULTS.maxInputTokens, integer: true, min: 1, max: 1_000_000 }),
    maxOutputTokens: envNumber(env, 'MAX_OUTPUT_TOKENS', { fallback: DEFAULTS.maxOutputTokens, integer: true, min: 1, max: 8192 }),
    timeoutMs: envNumber(env, 'REQUEST_TIMEOUT_MS', { fallback: DEFAULTS.timeoutMs, integer: true, min: 1, max: 600_000 }),
    maxResponseBytes: envNumber(env, 'MAX_RESPONSE_BYTES', { fallback: DEFAULTS.maxResponseBytes, integer: true, min: 1024, max: 16 * 1024 * 1024 }),
    requestFeeUsd: envNumber(env, 'REQUEST_FEE_USD', { fallback: DEFAULTS.requestFeeUsd, min: 0, max: 10 }),
  }
  const anyPricing = pricingFields.some((key) => env[key] !== undefined)
  if (anyPricing || forExecution) {
    const source = env.PRICING_SOURCE
    validHttpsUrl(source, 'reader-smoke-config-invalid:PRICING_SOURCE')
    const verifiedAt = env.PRICING_VERIFIED_AT
    if (typeof verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt) || !Number.isFinite(Date.parse(verifiedAt)) || new Date(verifiedAt).toISOString().slice(0, 10) !== verifiedAt) throw new Error('reader-smoke-config-invalid:PRICING_VERIFIED_AT')
    config.pricing = Object.freeze({
      inputUsdPerMillion: envNumber(env, 'INPUT_USD_PER_MILLION', { required: forExecution, fallback: null, min: 0, max: 1_000_000 }),
      outputUsdPerMillion: envNumber(env, 'OUTPUT_USD_PER_MILLION', { required: forExecution, fallback: null, min: 0, max: 1_000_000 }),
      source,
      verifiedAt,
      requestFeeUsd: config.requestFeeUsd,
    })
    if (config.pricing.inputUsdPerMillion == null || config.pricing.outputUsdPerMillion == null) throw new Error('reader-smoke-config-incomplete-pricing')
  } else config.pricing = null
  return Object.freeze(config)
}

export function validateReaderBaseUrl(baseUrl) {
  const u = validHttpsUrl(baseUrl, 'reader-smoke-endpoint-invalid')
  if (u.pathname.includes('..')) throw new Error('reader-smoke-endpoint-invalid')
  return u.toString().replace(/\/+$/, '')
}
export function inputTokenBound(body) {
  // Conservative engineering bound matching the repository's approved API budget helper:
  // full JSON UTF-8 bytes plus 4096 protocol tokens. It is not a provider-tokenizer proof.
  return Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096
}
export function buildReaderSmokeBody({ model, ctx, reasoning }) {
  const reasoningBlock = String(reasoning).slice(0, 4000)
  return {
    model,
    messages: [
      { role: 'user', content: String(ctx) },
      { role: 'assistant', content: `Reasoning: ${reasoningBlock}`, reasoning_content: reasoningBlock },
      { role: 'user', content: 'Continue the task based on previous reasoning. Report task outcome and any constraint violations.' },
    ],
    reasoning_effort: 'high',
    max_tokens: undefined,
  }
}
function requestBodyForConfig({ model, ctx, reasoning }, config) {
  const body = buildReaderSmokeBody({ model, ctx, reasoning })
  body.max_tokens = config.maxOutputTokens
  body.stream = false
  body.extra_body = { thinking: { type: 'enabled' } }
  return body
}
export function quoteSmokeRequest(body, config) {
  if (!config?.pricing || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) throw budgetError('reader-smoke-pricing-or-output-limit-required')
  const inputTokens = inputTokenBound(body)
  if (inputTokens > config.maxInputTokens) throw budgetError('reader-smoke-input-token-limit')
  const p = config.pricing
  const reservedNano = Math.ceil((inputTokens * p.inputUsdPerMillion + body.max_tokens * p.outputUsdPerMillion) * 1000 + (p.requestFeeUsd || 0) * NANO)
  if (!Number.isSafeInteger(reservedNano) || reservedNano <= 0) throw budgetError('reader-smoke-price-range')
  return Object.freeze({ inputTokens, outputTokens: body.max_tokens, reservedNano, reservedUsd: reservedNano / NANO })
}
export class ReaderSmokeBudget {
  constructor(config, onReserve = null) {
    this.config = config
    this.onReserve = onReserve
    this.requests = 0
    this.reservedNano = 0
    this.halted = null
  }
  reserve(body, meta) {
    if (this.halted) throw budgetError('reader-smoke-halted:' + this.halted)
    if (this.requests >= this.config.maxRequests) throw budgetError('reader-smoke-request-budget-exhausted')
    const quote = quoteSmokeRequest(body, this.config)
    const cap = Math.floor(this.config.maxUsd * NANO)
    if (quote.reservedNano > cap - this.reservedNano) throw budgetError('reader-smoke-usd-budget-exhausted')
    const row = Object.freeze({
      ...meta,
      sequence: this.requests + 1,
      requestSha256: sha256(JSON.stringify(body)),
      inputTokenBound: quote.inputTokens,
      maxOutputTokens: quote.outputTokens,
      reservedNano: quote.reservedNano,
      reservedUsd: quote.reservedUsd,
      totalReservedUsd: (this.reservedNano + quote.reservedNano) / NANO,
      requestsReserved: this.requests + 1,
      at: new Date().toISOString(),
    })
    // Persist/fsync the reservation before mutating counters or dispatching a paid request.
    this.onReserve?.(row)
    this.requests++
    this.reservedNano += quote.reservedNano
    return row
  }
  halt(reason) { this.halted = String(reason || 'unknown') }
  snapshot() {
    return Object.freeze({ requestsReserved: this.requests, reservedUsd: this.reservedNano / NANO, maxRequests: this.config.maxRequests, maxUsd: this.config.maxUsd, halted: this.halted })
  }
}

async function readResponseBytes(response, limit) {
  if (!response.body) return Buffer.alloc(0)
  if (typeof response.body.getReader !== 'function') throw budgetError('reader-smoke-response-stream-required')
  const declared = response.headers?.get?.('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    try { await response.body.cancel() } catch { /* body may already be closed */ }
    throw budgetError('reader-smoke-response-too-large')
  }
  const reader = response.body.getReader(), chunks = []; let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > limit) { await reader.cancel(); throw budgetError('reader-smoke-response-too-large') }
      chunks.push(chunk)
    }
  } finally { try { reader.releaseLock() } catch { /* stream already cancelled */ } }
  return Buffer.concat(chunks, total)
}
function safeUsage(usage) {
  const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens
  if (!Number.isSafeInteger(prompt) || prompt < 0 || !Number.isSafeInteger(completion) || completion < 0) return null
  return { prompt_tokens: prompt, completion_tokens: completion }
}
export async function callReader({ body, apiKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULTS.timeoutMs, maxResponseBytes = DEFAULTS.maxResponseBytes }) {
  const endpoint = validateReaderBaseUrl(baseUrl) + '/chat/completions'
  const controller = new AbortController(), started = Date.now()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    })
    let bytes
    try { bytes = await readResponseBytes(response, maxResponseBytes) }
    catch (e) {
      return { ok: false, status: response.status, errorCode: timedOut ? 'request-timeout' : (typeof e.code === 'string' ? e.code : 'reader-smoke-response-read'), latencyMs: Date.now() - started, responseSha256: null, usage: null }
    }
    const responseSha256 = sha256(bytes)
    let json
    try { json = JSON.parse(bytes.toString('utf8')) }
    catch { return { ok: false, status: response.status, errorCode: 'reader-smoke-response-json', latencyMs: Date.now() - started, responseSha256, usage: null } }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, status: response.status, errorCode: 'reader-smoke-response-json', latencyMs: Date.now() - started, responseSha256, usage: null }
    const choice = json.choices?.[0], message = choice?.message || {}
    const usage = safeUsage(json.usage)
    const ok = !!response.ok
    return {
      ok,
      status: response.status,
      errorCode: ok ? null : `HTTP-${response.status}`,
      latencyMs: Date.now() - started,
      responseSha256,
      usage,
      usageVerified: !!usage,
      contentChars: typeof message.content === 'string' ? message.content.length : 0,
      reasoningChars: typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0,
    }
  } catch (e) {
    return { ok: false, status: null, errorCode: timedOut ? 'request-timeout' : 'request-network-error', latencyMs: Date.now() - started, responseSha256: null, usage: null }
  } finally { clearTimeout(timer) }
}
function usageBounded(usage, reservation) {
  return !!usage && usage.prompt_tokens <= reservation.inputTokenBound && usage.completion_tokens <= reservation.maxOutputTokens
}
function retriable(result) {
  return result.errorCode === 'request-network-error' || result.errorCode === 'request-timeout' || /^HTTP-5\d\d$/.test(result.errorCode || '')
}
export async function runReaderSmoke({ cases, model, baseUrl, apiKey, config, fetchImpl = globalThis.fetch, onReserve = null, onResult = null }) {
  const base = validateReaderBaseUrl(baseUrl)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('reader-smoke-api-key-required')
  if (!config?.pricing) throw new Error('reader-smoke-pricing-required')
  if (!Array.isArray(cases) || !cases.length) throw new Error('reader-smoke-cases-required')
  const seen = new Set()
  for (const row of cases) {
    if (!row || typeof row.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.caseId) || seen.has(row.caseId) || !['raw', 'ctx', 'reference'].every((k) => typeof row[k] === 'string')) throw new Error('reader-smoke-case-schema')
    seen.add(row.caseId)
  }
  if (typeof model !== 'string' || !/^[\w./:-]{1,120}$/.test(model)) throw new Error('reader-smoke-model-invalid')
  const results = []
  const budget = new ReaderSmokeBudget(config, onReserve)
  let stopReason = null
  outer: for (const c of cases) {
    for (const arm of ARMS) {
      const reasoning = arm === 'reference' ? c.reference : c.raw
      const request = requestBodyForConfig({ model, ctx: c.ctx, reasoning }, config)
      let last = null
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        let reservation
        try { reservation = budget.reserve(request, { caseId: c.caseId, arm, attempt: attempt + 1 }) }
        catch (e) { stopReason = e.code || e.message; break outer }
        last = await callReader({ body: request, apiKey, baseUrl: base, fetchImpl, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes })
        const out = Object.freeze({
          caseId: c.caseId, arm, attempt: attempt + 1, requestSha256: reservation.requestSha256,
          ok: last.ok, httpStatus: last.status, errorCode: last.errorCode,
          responseSha256: last.responseSha256,
          usage: last.usage, usageVerified: last.usageVerified || false,
          contentChars: last.contentChars || 0, reasoningChars: last.reasoningChars || 0,
          latencyMs: last.latencyMs, reservedUsd: reservation.reservedUsd,
          totalReservedUsd: budget.snapshot().reservedUsd,
          estimatedUsageUsd: last.usage ? (last.usage.prompt_tokens * config.pricing.inputUsdPerMillion + last.usage.completion_tokens * config.pricing.outputUsdPerMillion) / 1e6 : null,
          estimateBasis: last.usage ? 'provider-reported token usage × operator-supplied price; not an invoice' : 'unknown',
          at: new Date().toISOString(),
        })
        onResult?.(out)
        results.push(out)
        if (last.usage && !usageBounded(last.usage, reservation)) {
          stopReason = 'reader-smoke-provider-usage-over-reservation'
          budget.halt(stopReason); break outer
        }
        if (last.ok) {
          if (!last.usage) {
            stopReason = 'reader-smoke-usage-unavailable'
            budget.halt(stopReason); break outer
          }
          break
        }
        if (attempt < config.maxRetries && retriable(last)) continue
        stopReason = last.errorCode || 'reader-smoke-request-failed'
        budget.halt(stopReason); break outer
      }
    }
  }
  const snapshot = budget.snapshot()
  const expected = cases.length * ARMS.length
  return Object.freeze({
    schema: 'cfb.reader-smoke-run/2',
    status: stopReason ? 'halted' : results.length === expected ? 'complete' : 'incomplete',
    stopReason,
    expectedSlots: expected,
    recordedAttempts: results.length,
    results: Object.freeze(results),
    budget: snapshot,
    pricing: Object.freeze({ ...config.pricing, semantics: 'Worst-case local pre-reservation under the declared rate card, byte-based input bound + fixed overhead, and max_tokens. Not a provider-enforced spending cap or invoice.' }),
    promotionAllowed: false,
    formalReaderStudy: false,
  })
}

// Strict output allowlist: even a future caller passing an accidental raw provider object cannot persist it.
export function publicAuditEvent(type, row) {
  const reservationFields = ['caseId', 'arm', 'attempt', 'sequence', 'requestSha256', 'inputTokenBound', 'maxOutputTokens', 'reservedUsd', 'totalReservedUsd', 'requestsReserved', 'at']
  const resultFields = ['caseId', 'arm', 'attempt', 'requestSha256', 'ok', 'httpStatus', 'errorCode', 'responseSha256', 'usage', 'usageVerified', 'contentChars', 'reasoningChars', 'latencyMs', 'reservedUsd', 'totalReservedUsd', 'estimatedUsageUsd', 'estimateBasis', 'at']
  const runFields = ['status', 'stopReason', 'expectedSlots', 'recordedAttempts', 'requestsReserved', 'usdReserved', 'maxRequests', 'maxUsd', 'maxRetries', 'maxInputTokens', 'maxOutputTokens', 'timeoutMs', 'maxResponseBytes', 'inputUsdPerMillion', 'outputUsdPerMillion', 'requestFeeUsd', 'pricingSource', 'pricingVerifiedAt', 'inputBoundBasis']
  const fields = type === 'reservation' ? reservationFields : type === 'result' ? resultFields : type === 'run' ? runFields : null
  if (!fields || !row || typeof row !== 'object') throw new Error('reader-smoke-audit-event-invalid')
  const out = { type }
  for (const key of fields) if (own(row, key)) out[key] = row[key]
  return Object.freeze(out)
}
export function appendPrivateAuditEvent(fd, type, row) {
  const safe = publicAuditEvent(type, row)
  fs.writeSync(fd, JSON.stringify(safe) + '\n')
  fs.fsyncSync(fd)
  return safe
}
export function formatUsdNano(nano) {
  if (!Number.isSafeInteger(nano) || nano < 0) throw new Error('reader-smoke-nano-invalid')
  return (nano / NANO).toFixed(9)
}
