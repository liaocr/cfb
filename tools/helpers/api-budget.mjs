// 有界评测专用：冻结输入、全量预估、dispatch 前双平面预占；未知不退款/重试。
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { createEvidenceStore } from '../../src/evidence-store.js'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { makeChat, channelIssue, responseText } from '../effect-eval.mjs'
import { hasSecretMaterial } from './eval-files.mjs'
import { API_APPROVAL_SCOPE, API_APPROVAL_SCOPE_V2, API_APPROVAL_SCOPE_V3, API_APPROVAL_SCOPE_V4, API_APPROVAL_SCOPE_V5, API_APPROVAL_SCOPE_V6, API_APPROVAL_SCOPE_V7, API_APPROVAL_SCOPE_V8, API_APPROVAL_SCOPES_V9, API_APPROVAL_SCOPES_GEN, apiStoreDirectory, assertExistingBudget, assertWatermark, commitWatermark } from './api-watermark.mjs'

export const APPROVED_API_LIMITS = Object.freeze({ maxRequests: 13, maxUsd: 2, maxMain: 12, maxProbe: 1, retries: 0, judges: 0 })
// v2（用户2026-10-01批准）：同矩阵 + 3个同体备用探针；网络类失败只废该请求预留、不株连未派发请求，累计3次仍硬停。
export const APPROVED_API_LIMITS_V2 = Object.freeze({ maxRequests: 15, maxUsd: 2, maxMain: 12, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 3 })
// v4：在v2基础上增加已结算样本失败预算——response-incomplete(length截断)不再株连整个计划，但同样收费/不重发，累计3次仍全停。
export const APPROVED_API_LIMITS_V4 = Object.freeze({ maxRequests: 15, maxUsd: 2, maxMain: 12, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 3, sampleFailureBudget: 3 })
// v5：同v4语义，矩阵扩为6样本/格；失败预算按请求数等比放宽，总额仍≤USD2。
export const APPROVED_API_LIMITS_V5 = Object.freeze({ maxRequests: 39, maxUsd: 2, maxMain: 36, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 6, sampleFailureBudget: 6 })
// v8：回到 v1 的 reasoning 回放矩阵（3题×2臂×2样本=12主），复用 v2 的3同体备用探针与 v4 的样本级截断容错。
export const APPROVED_API_LIMITS_V8 = Object.freeze({ maxRequests: 15, maxUsd: 2, maxMain: 12, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 3, sampleFailureBudget: 3 })
// v9（v14.2 闭环 v2）：候选稿 vs 当前生产稿的序贯配对回放。每轮 ≤5 任务 × 2 臂 = ≤10 主 + 3 同体探针，USD 上限 1（实际预占
//   每请求 ≈ 0.05–0.07，一轮 ≈ 0.5–0.7 预占 / ≈ 0.05–0.10 实付）。失败预算沿用 v4 的样本级容错。每轮一个 scope，需逐轮批准。
export const APPROVED_API_LIMITS_V9 = Object.freeze({ maxRequests: 13, maxUsd: 1, maxMain: 10, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 3, sampleFailureBudget: 3 })
export const APPROVED_API_LIMITS_GEN = Object.freeze({ maxRequests: 8, maxUsd: 0.3, maxMain: 5, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 2, sampleFailureBudget: 2 })
export const GEN_ROLES_APPROVED = Object.freeze(['compile', 'propose', 'mint-a', 'mint-b'])
export const POOL_TASK_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/
export const MINIMAL_TASK_IDS = Object.freeze(['flaky-timeout', 'wrong-model', 'eacces-config'])
/** v9 可选任务全集（effect-mr-specs 五题）；计划的 tasks 必须是它的子集、3–5 题、无重复。 */
export const V9_TASK_IDS = Object.freeze(['eacces-config', 'flaky-timeout', 'wrong-model', 'perf-regression', 'sse-truncated'])
export const V9_ARMS = Object.freeze(['control', 'candidate'])
const TRANSIENT_REASON = /^(?:request-network-error|request-timeout|HTTP 5\d\d)$/
export const planVersion = (plan) => plan?.schema === 'cfb.generation/1' ? 10 : plan?.schema === 'cfb.bounded-ab/9' ? 9 : plan?.schema === 'cfb.bounded-ab/8' ? 8 : plan?.schema === 'cfb.bounded-ab/7' ? 7 : plan?.schema === 'cfb.bounded-ab/6' ? 6 : plan?.schema === 'cfb.bounded-ab/5' ? 5 : plan?.schema === 'cfb.bounded-ab/4' ? 4 : plan?.schema === 'cfb.bounded-ab/3' ? 3 : plan?.schema === 'cfb.bounded-ab/2' ? 2 : 1
export const planIsV2 = (plan) => planVersion(plan) >= 2
export const v9Round = (plan) => (planVersion(plan) === 9 && Number.isSafeInteger(plan.round) && plan.round >= 1 && plan.round <= API_APPROVAL_SCOPES_V9.length ? plan.round : null)
export const genRound = (plan) => (planVersion(plan) === 10 && Number.isSafeInteger(plan.round) && plan.round >= 1 && plan.round <= API_APPROVAL_SCOPES_GEN.length ? plan.round : null)
export const planScope = (plan) => planVersion(plan) === 10 ? (genRound(plan) ? API_APPROVAL_SCOPES_GEN[plan.round - 1] : undefined) : planVersion(plan) === 9 ? (v9Round(plan) ? API_APPROVAL_SCOPES_V9[plan.round - 1] : undefined) : [API_APPROVAL_SCOPE, API_APPROVAL_SCOPE_V2, API_APPROVAL_SCOPE_V3, API_APPROVAL_SCOPE_V4, API_APPROVAL_SCOPE_V5, API_APPROVAL_SCOPE_V6, API_APPROVAL_SCOPE_V7, API_APPROVAL_SCOPE_V8][planVersion(plan) - 1]
// 指纹只是通道连续性锚：v1/v2锚定曾验证的官方后端；v3-v6锚定实测中转vLLM后端。v7起不在表内＝不设fp闸（池轮换数小时即废任何钉死值），fp照记入报告。
export const TRUSTED_FINGERPRINTS = Object.freeze({ 1: 'fp_dspure_app_v1', 2: 'fp_dspure_app_v1', 3: 'vllm-0.0.0-tp4-dp2-ep-869f52fc', 4: 'vllm-0.0.0-tp4-dp2-ep-869f52fc', 5: 'vllm-0.0.0-tp4-dp2-ep-869f52fc', 6: 'vllm-0.0.0-tp4-dp2-ep-869f52fc' })
// v3 可见压缩稿块的冻结定界符；审计凭它验证 raw/current 除稿块外逐字节一致。
export const DRAFT_BLOCK_PREFIX = '【前情压缩稿】\n'
export const DRAFT_BLOCK_SUFFIX = '\n【/前情压缩稿】\n\n'
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
  const version = planVersion(plan), v2 = version >= 2, approvedLimits = version === 10 ? APPROVED_API_LIMITS_GEN : version === 9 ? APPROVED_API_LIMITS_V9 : version >= 8 ? APPROVED_API_LIMITS_V8 : version >= 5 ? APPROVED_API_LIMITS_V5 : version === 4 ? APPROVED_API_LIMITS_V4 : v2 ? APPROVED_API_LIMITS_V2 : APPROVED_API_LIMITS
  if (!['cfb.bounded-ab/1', 'cfb.bounded-ab/2', 'cfb.bounded-ab/3', 'cfb.bounded-ab/4', 'cfb.bounded-ab/5', 'cfb.bounded-ab/6', 'cfb.bounded-ab/7', 'cfb.bounded-ab/8', 'cfb.bounded-ab/9', 'cfb.generation/1'].includes(plan?.schema) || typeof plan.model !== 'string' || !/^[\w./:-]{1,120}$/.test(plan.model) || !Array.isArray(plan.jobs) || !plan.jobs.length || plan.jobs.length > approvedLimits.maxRequests) throw new Error('api-plan-schema')
  if (evidenceDigest(plan.limits) !== evidenceDigest(approvedLimits)) throw new Error('api-approval-changed')
  // v9 矩阵形状：轮次 ∈ 1..20（对应静态 scope 表）、任务 3–5 题 ⊂ V9_TASK_IDS、臂固定 control/candidate、每题 1 对、杠杆声明齐全。
  const v9Tasks = version === 9 ? plan.tasks : null
  // v14.3：任务 ∈ 冻结 5 题 ∪ 计划登记的任务池（plan.pool[id] = { digest, source, split }，池摘要随计划冻结）；A/A（lever 'A/A'）允许两臂同文。
  const poolOk = (t) => V9_TASK_IDS.includes(t) || (POOL_TASK_ID_RE.test(t) && plan.pool && typeof plan.pool[t]?.digest === 'string' && /^[a-f0-9]{16}$/.test(plan.pool[t].digest) && ['frozen', 'minted', 'mined', 'authored'].includes(plan.pool[t].source))
  if (version === 9 && (!v9Round(plan) || !Array.isArray(v9Tasks) || v9Tasks.length < 3 || v9Tasks.length > 5 || new Set(v9Tasks).size !== v9Tasks.length || v9Tasks.some((t) => !poolOk(t)) || !plan.hypothesis || typeof plan.hypothesis.lever !== 'string' || typeof plan.hypothesis.value !== 'string' || !plan.hypothesis.champion || typeof plan.hypothesis.champion !== 'object')) throw new Error('api-plan-schema')
  // 生成计划形状：轮次 1..40（静态 scope 表）、角色在批准表内、主请求 1..5、每个主请求带 gen 元数据且角色一致。
  if (version === 10) {
    const mains = plan.jobs.filter((j) => j.kind === 'main')
    if (!Number.isSafeInteger(plan.round) || plan.round < 1 || plan.round > 40 || !GEN_ROLES_APPROVED.includes(plan.role) || !mains.length || mains.length > approvedLimits.maxMain || mains.some((j) => !j.gen || j.gen.role !== plan.role) || (plan.role !== 'compile' && mains.length !== 1)) throw new Error('api-plan-schema')
    if (plan.jobs.some((j) => j.kind === 'main' && JSON.stringify(j.body).includes(plan.canary))) throw new Error('api-probe-leak')
  }
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
  const probeKeys = v2 ? ['probe', 'probe-r1', 'probe-r2'] : ['probe']
  const expectedMain = version === 10 ? plan.jobs.filter((j) => j.kind === 'main').length : version === 9 ? v9Tasks.length * V9_ARMS.length : approvedLimits.maxMain
  if (probe !== probeKeys.length || main !== expectedMain || main > approvedLimits.maxMain || typeof plan.canary !== 'string' || !/^CFB_CANARY_[a-f0-9]{32}$/.test(plan.canary)) throw new Error('api-matrix')
  if (probeKeys.some((k, i) => plan.jobs[i].kind !== 'probe' || plan.jobs[i].key !== k || evidenceDigest(plan.jobs[i].body) !== evidenceDigest(plan.jobs[0].body))) throw new Error('api-matrix')
  const probeBody = plan.jobs[0].body
  // 可见协议闸只属于 v3–v7：v1/v2 与 v8 走 reasoning 回放口径（v8 是前提更正后回到 v1 的协议）。
  const visibleProtocol = version >= 3 && version <= 7
  if (visibleProtocol) {
    // v3/v4：全部消息不得携带 reasoning_content（当时以为通道已证丢弃；该前提已于 2026-10-01 被 v8 canary 推翻，见 api-watermark 更正块）。
    // 本闸照旧生效：v3–v7 的协议定义与收据已封存，协议口径不追溯修改；v8 起走 v1 的 reasoning 回放口径（走 else 分支）。
    if (plan.jobs.some((j) => j.body.messages.some((m) => m.reasoning_content !== undefined))) throw new Error('api-probe-leak')
    const carriers = probeBody.messages.filter((m) => typeof m.content === 'string' && m.content.includes(plan.canary))
    if (carriers.length !== 1 || carriers[0].role !== 'assistant') throw new Error('api-probe-leak')
    if (plan.jobs.filter((j) => j.kind === 'main').some((j) => JSON.stringify(j.body).includes(plan.canary))) throw new Error('api-probe-leak')
  } else {
    const carriers = probeBody.messages.filter((m) => m.reasoning_content?.includes(plan.canary))
    const visibleProbe = { ...probeBody, messages: probeBody.messages.map(({ reasoning_content, ...m }) => m) }
    if (carriers.length !== 1 || carriers[0].role !== 'assistant' || JSON.stringify(visibleProbe).includes(plan.canary)) throw new Error('api-probe-leak')
  }
  const strip = (b) => ({ ...b, messages: b.messages.map(({ reasoning_content, ...m }) => m) })
  const draftBlockRe = new RegExp('^' + DRAFT_BLOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\n') + '[\\s\\S]*' + DRAFT_BLOCK_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\n'))
  // 生成计划没有配对矩阵（每个主请求各自独立）；只做请求体通用闸。
  const matrixTasks = version === 10 ? [] : version === 9 ? v9Tasks : MINIMAL_TASK_IDS, matrixArms = version === 9 ? V9_ARMS : ['raw', 'current']
  const sampleCount = version === 9 ? 1 : approvedLimits.maxMain / (MINIMAL_TASK_IDS.length * 2)
  for (const task of matrixTasks) for (let sample = 0; sample < sampleCount; sample++) {
    const pair = matrixArms.map((variant) => plan.jobs.find((j) => j.kind === 'main' && j.task === task && j.sample === sample && j.variant === variant && j.obs === 'red' && j.key === `${task}|${variant}|${sample}`))
    if (pair.some((j) => !j)) throw new Error('api-matrix-protocol')
    if (visibleProtocol) {
      // 冻结关系：current 的 assistant 轮 = 稿块前缀 + raw 同位置逐字节内容；其余消息完全一致。
      const [rawB, curB] = [pair[0].body, pair[1].body]
      if (rawB.messages.length !== curB.messages.length) throw new Error('api-matrix-protocol')
      for (let i = 0; i < rawB.messages.length; i++) {
        const a = rawB.messages[i], b = curB.messages[i]
        if (a.role !== b.role) throw new Error('api-matrix-protocol')
        if (a.content === b.content) continue
        if (a.role !== 'assistant' || !draftBlockRe.test(b.content) || !b.content.endsWith(a.content) || !b.content.startsWith(DRAFT_BLOCK_PREFIX)) throw new Error('api-matrix-protocol')
      }
    } else if (evidenceDigest(strip(pair[0].body)) !== evidenceDigest(strip(pair[1].body))) throw new Error('api-matrix-protocol')
  }
  if (totalNano > 2 * NANO) throw new Error('api-budget-plan-exceeds-2usd')
  if (totalNano > approvedLimits.maxUsd * NANO) throw new Error('api-budget-plan-exceeds-approved-usd')
  return immutableJson({ planDigest: evidenceDigest(plan), maxRequests: approvedLimits.maxRequests, maxUsd: approvedLimits.maxUsd, main, probe, priced: plan.pricing !== null, totalReservedUsd: plan.pricing === null ? null : totalNano / NANO, quotes })
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
  const scope = planScope(plan)
  const file = receiptPath || path.resolve(directory) + '.watermark.json'
  const marker = assertExistingBudget(directory, file, scope), home = apiStoreDirectory(directory, scope)
  if (!initialize && !fs.existsSync(path.join(home, '.head-api-budget.json'))) return null
  const audit = auditApiPlan(plan)
  const store = createEvidenceStore({ directory, sessionId: scope })
  const read = () => {
    const head = store.readHead('api-budget')
    const state = head ? store.getJson(head.ref, { kind: 'api-budget' }) : { schema: 'cfb.api-budget/1', planDigest: audit.planDigest, entries: [], halted: null }
    if (state.planDigest !== audit.planDigest) throw new Error('api-plan-changed')
    if (head) assertWatermark(store, head, state, file, scope)
    return { head, state }
  }
  const save = (head, state, initial = false) => {
    const next = store.setHead('api-budget', store.putJson(state, { kind: 'api-budget' }), { expectedRevision: head?.revision || null })
    commitWatermark(store, next, state, file, { initial, scope })
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
      const usdCap = Math.min(2, Number.isFinite(plan.limits?.maxUsd) && plan.limits.maxUsd > 0 ? plan.limits.maxUsd : 2)   // v9 每轮 USD 1；任何版本都不超 2
      if (state.entries.length >= (plan.limits?.maxRequests ?? 13) || state.entries.reduce((n, e) => n + e.reservedNano, 0) + reservedNano > usdCap * NANO) throw new Error('api-budget-exhausted')
      save(head, { ...state, authTag, entries: [...state.entries, { key, kind: job.kind, reservedNano, status: 'pending' }] })
      dispatched = true   // 私有仓+公开收据全部 fsync 后才允许 fetch；任一写失败都不发。
    } })
    try {
      const r = await chat(job.body, { signal })
      // fp 由下一行按 scope 版本锚定检查；channelIssue 的旧全局 TRUSTED_FP 集合只服务旧CLI。
      // v6起：探针是纯可见echo保真测试，不强制思考（v5实测空reasoning误杀整计划）；主请求仍要求思考在跑。
      // v14.9：compile（副模型按生产形态关思考）不要求 reasoning_content；通道身份仍由下一行的指纹锚定 + 同计划里思考开着的主调用负责。
      const compileJob = job.gen?.role === 'compile' && job.body?.thinking?.type === 'disabled'
      const issue = channelIssue(r, plan.model, { requireFp: false, requireThinking: !(planVersion(plan) >= 6 && job.kind === 'probe') && !compileJob, modelAliases: plan.modelAliases || [] }); if (issue) throw new Error(issue)
      const trustedFp = TRUSTED_FINGERPRINTS[planVersion(plan)]
      if (trustedFp !== undefined && r.fp !== trustedFp) throw new Error('channel-fingerprint')
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
        // 该请求的预留永久作废（不退款、不重发）。v2 只对纯网络类失败不株连未派发请求；可信性失败（channel/usage/response/4xx）与超出网络失败预算仍全停。
        const entries = state.entries.map((x) => x.key === key ? { ...x, status: 'rejected', reason } : x)
        const netBudget = Number.isSafeInteger(plan.limits?.networkFailureBudget) ? plan.limits.networkFailureBudget : 0
        const sampleBudget = Number.isSafeInteger(plan.limits?.sampleFailureBudget) ? plan.limits.sampleFailureBudget : 0
        // v6起：主请求的逐响应验证失败＝样本级（每个accepted样本本就逐个过全部闸，计划级全停只是止损，预算封顶即可）；
        // 探针的信任类失败、鉴权/账本/HTTP 4xx 仍整计划硬停。v4/v5冻结语义不追溯。
        const SAMPLE_V6 = /^(?:response-[a-z-]+|channel-(?:no-thinking|fingerprint|model-mismatch|usage|history-not-visible)|api-usage-out-of-bound)$/
        const isNet = TRANSIENT_REASON.test(reason)
        const isSample = planVersion(plan) >= 6 ? (job.kind === 'main' && SAMPLE_V6.test(reason)) : reason === 'response-incomplete'
        const netCount = entries.filter((x) => x.status === 'rejected' && TRANSIENT_REASON.test(x.reason || '')).length
        const sampleCount = entries.filter((x) => x.status === 'rejected' && (planVersion(plan) >= 6 ? SAMPLE_V6.test(x.reason || '') : x.reason === 'response-incomplete')).length
        const halted = isNet && netBudget > 0 ? (netCount >= netBudget ? 'api-network-failure-budget' : state.halted)
          : isSample && sampleBudget > 0 ? (sampleCount >= sampleBudget ? 'api-sample-failure-budget' : state.halted)
          : reason
        save(head, { ...state, halted, entries })
        throw new Error(reason)
      }
      throw e
    }
  }
  return Object.freeze({ audit, snapshot: () => read().state, run, cached: budget.cached, receiptPath: budget.receiptPath })
}
