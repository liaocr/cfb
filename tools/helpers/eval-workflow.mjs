// 同一准备/诊断/执行/报告路径；准备与报告不读取凭据文件或发网络请求。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { buildGenerationPlan, genOutputs } from './generation.mjs'
import { buildMinimalPlan, buildBoundedPlanV2, buildVisiblePlanV3, buildVisiblePlanV4, buildExpandedPlanV5, buildExpandedPlanV6, buildExpandedPlanV7, buildReasoningReplayPlanV8, buildCandidateReplayPlanV9, sourceDifferences, summarizeMinimal, resultOf } from './eval-plan.mjs'
import { auditApiPlan, createBudgetedChat, inspectApiBudget, inputTokenBound, APPROVED_API_LIMITS } from './api-budget.mjs'
import { assertSafePath, readJson, writeJson, hasSecretMaterial } from './eval-files.mjs'
import { assertAutoCheckpoint, exportEvaluationBundle } from './eval-bundle.mjs'
import { readWatermark } from './api-watermark.mjs'
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_HOME = path.join(ROOT, '.cfb-runtime/bounded-ab')
export const PUBLIC_RECEIPT = path.join(ROOT, 'transfer/api-budget-approval.watermark.json')
// v2（2026-10-01 新批准）：独立私有仓与公开收据；旧 scope 的收据/账本封存不动。
export const DEFAULT_HOME_V2 = path.join(ROOT, '.cfb-runtime/bounded-ab-v2')
export const PUBLIC_RECEIPT_V2 = path.join(ROOT, 'transfer/api-budget-approval-v2.watermark.json')
export const DEFAULT_HOME_V3 = path.join(ROOT, '.cfb-runtime/bounded-ab-v3')
export const PUBLIC_RECEIPT_V3 = path.join(ROOT, 'transfer/api-budget-approval-v3.watermark.json')
export const DEFAULT_HOME_V4 = path.join(ROOT, '.cfb-runtime/bounded-ab-v4')
export const PUBLIC_RECEIPT_V4 = path.join(ROOT, 'transfer/api-budget-approval-v4.watermark.json')
export const DEFAULT_HOME_V5 = path.join(ROOT, '.cfb-runtime/bounded-ab-v5')
export const PUBLIC_RECEIPT_V5 = path.join(ROOT, 'transfer/api-budget-approval-v5.watermark.json')
export const DEFAULT_HOME_V6 = path.join(ROOT, '.cfb-runtime/bounded-ab-v6')
export const PUBLIC_RECEIPT_V6 = path.join(ROOT, 'transfer/api-budget-approval-v6.watermark.json')
export const DEFAULT_HOME_V7 = path.join(ROOT, '.cfb-runtime/bounded-ab-v7')
// v8：前提更正后的 reasoning 回放复跑（独立 home 与公开收据；旧 scope 全部封存不动）。
export const DEFAULT_HOME_V8 = path.join(ROOT, '.cfb-runtime/bounded-ab-v8')
export const PUBLIC_RECEIPT_V8 = path.join(ROOT, 'transfer/api-budget-approval-v8.watermark.json')
export const PUBLIC_RECEIPT_V7 = path.join(ROOT, 'transfer/api-budget-approval-v7.watermark.json')
// v9（v14.2 闭环 v2）：每轮一个 home 与一份公开收据（r1…r20），由 cfb-cycle 按轮次推导；旧 scope 全部封存不动。
export const DEFAULT_HOME_GEN = (round) => path.join(ROOT, '.cfb-runtime', 'generation', 'g' + Number(round))
export const PUBLIC_RECEIPT_GEN = (round) => path.join(ROOT, 'transfer', 'api-budget-approval-gen-g' + Number(round) + '.watermark.json')
export const DEFAULT_HOME_V9 = (round) => path.join(ROOT, '.cfb-runtime/bounded-ab-v9/r' + Number(round))
export const PUBLIC_RECEIPT_V9 = (round) => path.join(ROOT, 'transfer/api-budget-approval-v9-r' + Number(round) + '.watermark.json')
export const PROFILE_EXAMPLE = path.join(ROOT, 'deploy/eval-profile.example.json')
const DEFAULT_EXECUTION = Object.freeze({ apiKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 240000, maxResponseBytes: 1024 * 1024 })
const safeCode = (e) => /^(?:api|eval|response|request|channel|source|profile|explicit)-[a-z0-9-]+$/.test(e?.message || '') || /^HTTP \d{3}$/.test(e?.message || '') ? e.message : 'eval-state-unavailable'
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') throw new Error('profile-endpoint')
  let text = value.trim(), link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(text)
  if (link) { if (link[1] !== link[2]) throw new Error('profile-endpoint-label'); text = link[2] }
  let u; try { u = new URL(text) } catch { throw new Error('profile-endpoint') }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /\/chat\/completions\/?$/.test(u.pathname)) throw new Error('profile-endpoint')
  return u.href.replace(/\/+$/, '')
}
export function normalizeProfile(input) {
  if (!input || input.schema !== 'cfb.eval-profile/1' || hasSecretMaterial(input) || Object.keys(input).some((k) => !['schema', 'model', 'baseUrl', 'apiKeyEnv', 'pricing', 'timeoutMs', 'maxResponseBytes', 'modelAliases'].includes(k))) throw new Error('profile-schema-or-secret')
  if (typeof input.model !== 'string' || !/^[\w./:-]{1,120}$/.test(input.model)) throw new Error('profile-model')
  // 型号回显别名：显式声明、逐条校验，用于「同一型号、不同书写规范」的中转（见 effect-eval.mjs 的 canonModel 注释）。
  // 不允许通配/正则/空串；每条必须是合法型号串，且必须与被声明型号规范化后相等（防止借别名放行真型号不符）。
  const modelAliases = input.modelAliases === undefined ? [] : input.modelAliases
  if (!Array.isArray(modelAliases) || modelAliases.length > 8 || modelAliases.some((a) => typeof a !== 'string' || !/^[\w./:-]{1,120}$/.test(a) || a.toLowerCase().replace(/[._-]+/g, '-') !== input.model.toLowerCase().replace(/[._-]+/g, '-'))) throw new Error('profile-model-aliases')
  const execution = { ...DEFAULT_EXECUTION, ...Object.fromEntries(['apiKeyEnv', 'timeoutMs', 'maxResponseBytes'].filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) }
  if (typeof execution.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(execution.apiKeyEnv) || /^GITHUB_|^GH_/.test(execution.apiKeyEnv) || !Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 100 || execution.timeoutMs > 600000 || !Number.isInteger(execution.maxResponseBytes) || execution.maxResponseBytes < 1024 || execution.maxResponseBytes > 8 * 1024 * 1024) throw new Error('profile-execution')
  return immutableJson({ schema: input.schema, model: input.model, baseUrl: normalizeBaseUrl(input.baseUrl), pricing: input.pricing ?? null, modelAliases, execution })
}
const paths = (home) => ({ home: assertSafePath(home, { directory: true }), plan: path.join(path.resolve(home), 'plan.json'), preflight: path.join(path.resolve(home), 'preflight.json'), ledger: path.join(path.resolve(home), 'ledger'), summary: path.join(path.resolve(home), 'summary.json') })
export function loadPrepared(home = DEFAULT_HOME) { return readJson(paths(home).plan) }
export function prepareEvaluation({ home = DEFAULT_HOME, receiptPath = PUBLIC_RECEIPT, profile = readJson(PROFILE_EXAMPLE), pricing, env = {}, simulation = false, version = 1, candidates, round, hypothesis, offline, pool, generation } = {}) {
  const p = paths(home), normalized = normalizeProfile({ ...profile, ...(pricing !== undefined ? { pricing } : {}) })
  const existing = fs.existsSync(p.plan) ? readJson(p.plan) : null, marker = readWatermark(receiptPath)
  if (marker && !existing) throw new Error('api-budget-restore-required')
  const isV9 = existing?.schema === 'cfb.bounded-ab/9' || version === 9
  const isGen = existing?.schema === 'cfb.generation/1' || version === 10
  const builder = isGen ? buildGenerationPlan : isV9 ? buildCandidateReplayPlanV9 : existing?.schema === 'cfb.bounded-ab/8' || version === 8 ? buildReasoningReplayPlanV8 : existing?.schema === 'cfb.bounded-ab/7' || version === 7 ? buildExpandedPlanV7 : existing?.schema === 'cfb.bounded-ab/6' || version === 6 ? buildExpandedPlanV6 : existing?.schema === 'cfb.bounded-ab/5' || version === 5 ? buildExpandedPlanV5 : existing?.schema === 'cfb.bounded-ab/4' || version === 4 ? buildVisiblePlanV4 : existing?.schema === 'cfb.bounded-ab/3' || version === 3 ? buildVisiblePlanV3 : existing?.schema === 'cfb.bounded-ab/2' || version === 2 ? buildBoundedPlanV2 : buildMinimalPlan
  // v9 的候选稿 / 轮次 / 假设随计划冻结：重新 prepare（如改价表）时沿用已写入的，不允许换稿。
  const v9Args = isV9 ? {
    candidates: candidates ?? (existing ? existing.tasks.map((t) => ({ task: t, control: existing.variants[t].control, candidate: existing.variants[t].candidate, knobs: existing.variants[t].knobs })) : undefined),
    round: round ?? existing?.round, hypothesis: hypothesis ?? existing?.hypothesis, offline: offline ?? existing?.offline ?? null, pool: pool ?? existing?.pool ?? null } : {}
  // 生成计划（v14.3）：角色 / 轮次 / 对象随计划冻结；重 prepare（换价表 / 重算预检）沿用已冻结的计划体，不能换对象。
  if (isGen && !generation && !existing) throw new Error('gen-plan-requires-generation')
  if (isGen && !generation) {
    const plan = immutableJson({ ...existing, pricing: normalized.pricing ?? null })
    if (marker && evidenceDigest(existing) !== evidenceDigest(plan)) throw new Error('api-plan-changed')
    writeJson(p.plan, plan)
    const preflight = doctorEvaluation({ home, receiptPath, env }); writeJson(p.preflight, preflight)
    return immutableJson({ ...preflight, prepared: true, limits: plan.limits, sourceDigest: null })
  }
  const base = builder({ ...normalized, canary: existing?.canary, ...v9Args, ...(isGen ? { ...generation, round: generation.round ?? round } : {}) })
  // 型号别名随计划一起冻结：写入计划即进入 planDigest 与公开收据，事后不可改（改＝计划变更，闸会拒绝）。
  const plan = immutableJson({ ...base, modelAliases: normalized.modelAliases, execution: normalized.execution, simulation })
  if (hasSecretMaterial(plan)) throw new Error('api-plan-secret-material')
  if (marker && (!existing || evidenceDigest(existing) !== evidenceDigest(plan))) throw new Error('api-plan-changed')
  // 准备前只允许未开始的计划调整；已有公开收据时即使 private ledger 消失也不能改稿/重开。
  if (marker) inspectApiBudget({ plan, directory: p.ledger, receiptPath })
  writeJson(p.plan, plan)
  const preflight = doctorEvaluation({ home, receiptPath, env })
  writeJson(p.preflight, preflight)
  return immutableJson({ ...preflight, prepared: true, limits: APPROVED_API_LIMITS,
    inputTokenBounds: plan.jobs.map((j) => ({ key: j.key, inputTokens: inputTokenBound(j.body), maxOutputTokens: j.body.max_tokens })), sourceDigest: plan.sourceDigest ?? null })
}
export function doctorEvaluation({ home = DEFAULT_HOME, receiptPath = PUBLIC_RECEIPT, env = {}, now = Date.now() } = {}) {
  const checks = [], check = (id, ok, remedy = null) => checks.push({ id, status: ok ? 'pass' : 'blocked', ...(ok || !remedy ? {} : { remedy }) })
  let plan
  try { plan = loadPrepared(home) } catch (e) { return immutableJson({ schema: 'cfb.eval-doctor/1', status: 'blocked', networkTouched: false, checks: [{ id: e.code === 'ENOENT' ? (readWatermark(receiptPath) ? 'api-budget-restore-required' : 'plan-missing') : safeCode(e), status: 'blocked', remedy: '先 prepare；已有收据时先 import 最新加密检查点，不重开预算。' }] }) }
  check('offline-mode-disabled', env.CFB_OFFLINE !== '1', 'offline环境只允许prepare/doctor/report/simulate，live必须在另一个已获网络许可的环境显式执行。')
  check('tls-verification-enabled', env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', '不能关闭TLS验证来让钥匙/任务原文发送出去。')
  check('runtime-node', Number(process.versions.node.split('.')[0]) >= 20, '使用Node20或更新的兼容环境。')
  check('protocol', ['chat-completions-history-reasoning/1', 'chat-completions-visible-context/1'].includes(plan.protocol) && plan.execution, '重建未开始的计划；协议必须是已冻结的两种之一，不可伪装。')
  check('source-current', sourceDifferences(plan).length === 0, '未开始可重新prepare；已开始需原源码/原计划恢复，不变稿补测。')
  let audit = null; try { audit = auditApiPlan(plan); check('pricing-and-matrix', true) } catch (e) { check(safeCode(e), false, '按实际中转价表填写价格与来源，不用上游价或样例价替代。') }
  let priceCurrent = false
  if (plan.pricing) {
    const verified = Date.parse(plan.pricing.verifiedAt + 'T00:00:00Z'), age = now - verified
    try { priceCurrent = [plan.pricing.inputUsdPerMillion, plan.pricing.outputUsdPerMillion, plan.pricing.requestFeeUsd].some((v) => Number.isFinite(v) && v > 0) && Number.isFinite(age) && age >= 0 && age <= 7 * 86400000 && !new URL(plan.pricing.source).hostname.endsWith('.invalid') } catch { priceCurrent = false }
  }
  check('pricing-current-not-example', priceCurrent, '实际live前核对最近7天价表、固定费和账户额度；样例报价只可simulate。')
  check('not-simulation', plan.simulation === false, '模拟计划/响应不能被导入后当成真实效果继续付费。')
  let executionValid = false
  try {
    const e = plan.execution
    executionValid = !!e && Object.keys(e).every((k) => Object.hasOwn(DEFAULT_EXECUTION, k)) && normalizeProfile({ schema: 'cfb.eval-profile/1', model: plan.model, modelAliases: plan.modelAliases, baseUrl: plan.baseUrl, ...e }).execution.apiKeyEnv === e.apiKeyEnv
  } catch { executionValid = false }
  check('execution-reference-valid', executionValid, '只允许模型钥匙环境引用，禁止GitHub/PAT或明文凭据字段。')
  const keyEnv = executionValid ? plan.execution.apiKeyEnv : DEFAULT_EXECUTION.apiKeyEnv, keyConfigured = typeof env[keyEnv] === 'string' && !!env[keyEnv].trim()
  check('model-key-present', keyConfigured, '在安全环境设置已轮换的模型钥匙；工具不会读取keys.env，也不接受CLI明文钥匙。')
  let endpointSame = !env.DEEPSEEK_BASE_URL
  if (env.DEEPSEEK_BASE_URL) try { endpointSame = normalizeBaseUrl(env.DEEPSEEK_BASE_URL) === plan.baseUrl } catch { endpointSame = false }
  check('environment-not-drifted', (!env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL === plan.model) && endpointSame, '模型/endpoint与冻结计划不一致；不要悄悄切换渠道。')
  let state = null
  if (audit) {
    try {
      const budget = inspectApiBudget({ plan, directory: paths(home).ledger, receiptPath }); state = budget?.snapshot() || null
      check('durable-budget', true)
      check('authentication-context-current', !state?.entries.length || budget.matchesCredential(env[keyEnv]), '已验证渠道对应原鉴权上下文；换钥匙/换池需新批准，不复用旧探针。')
      check('no-unknown-dispatch', !state?.halted && !state?.entries.some((e) => e.status === 'pending'), '失败/未知保持预占，禁止补发；恢复原认证状态后离线report。')
    } catch (e) { check(safeCode(e), false, '收据与私有仓必须成套恢复；缺仓/换私钥/回滚不是零消费。') }
  }
  return immutableJson({ schema: 'cfb.eval-doctor/1', status: checks.every((c) => c.status === 'pass') ? 'live-preflight-ready' : 'blocked', networkTouched: false,
    model: plan.model, baseUrl: plan.baseUrl, credential: { environmentName: keyEnv, present: keyConfigured }, channel: 'not-live-verified', checks,
    planDigest: evidenceDigest(plan), maxReservedUsd: audit?.totalReservedUsd ?? null, requestsReserved: state?.entries.length ?? null,
    notes: ['预检通过不等于通道/型号已实测；第一次live仍只有冻结的单探针。', '预算基于可信价表与输入估计，不是服务商账单物理锁。', '当前适配器使用Node fetch；不隐式采用代理环境变量，需要宿主提供可用的出站路由。'] })
}
export function reportEvaluation({ home = DEFAULT_HOME, receiptPath = PUBLIC_RECEIPT } = {}) {
  const p = paths(home), plan = loadPrepared(home)
  auditApiPlan(plan, { allowUnpriced: true })
  const budget = inspectApiBudget({ plan, directory: p.ledger, receiptPath }), results = [], fpByKey = {}
  const isGen = plan.schema === 'cfb.generation/1'
  if (budget) for (const job of plan.jobs) {
    const r = budget.cached(job.key); if (!r) continue
    fpByKey[job.key] = r.fp ?? null
    if (job.kind === 'main' && !isGen) results.push(resultOf(plan, job, r))
  }
  if (isGen) {
    const outputs = budget ? genOutputs(plan, (k) => budget.cached(k)) : []
    const gstate = budget?.snapshot() || null
    return immutableJson({ schema: 'cfb.generation-report/1', role: plan.role, round: plan.round, complete: outputs.length === plan.jobs.filter((j) => j.kind === 'main').length, outputs, mode: plan.simulation ? 'simulation' : 'live',
      channelVerified: !!gstate?.entries.some((e) => e.kind === 'probe' && e.status === 'accepted'), requestsRejected: gstate?.entries.filter((e) => e.status === 'rejected').map((e) => ({ key: e.key, reason: e.reason ?? null })) ?? [],
      requestsReserved: gstate?.entries.length || 0, reservedUsd: gstate?.entries.reduce((n, e) => n + e.reservedNano, 0) / 1e9 || 0, actualCostUsd: null, stopped: gstate?.halted || null, judgeRequests: 0, retries: 0 })
  }
  const state = budget?.snapshot() || null
  // 指纹透明化：直方图 + 配对样本是否同指纹（池轮换噪声公开，不做闸）。
  const fingerprintHistogram = Object.values(fpByKey).reduce((h, fp) => ({ ...h, [fp ?? 'null']: (h[fp ?? 'null'] || 0) + 1 }), {})
  let pairsSameFingerprint = 0, pairsTotal = 0
  const [armA, armB] = Array.isArray(plan.arms) ? plan.arms : ['raw', 'current']
  for (const job of plan.jobs.filter((j) => j.kind === 'main' && j.variant === armA)) {
    const other = `${job.task}|${armB}|${job.sample}`
    if (job.key in fpByKey && other in fpByKey) { pairsTotal++; if (fpByKey[job.key] === fpByKey[other]) pairsSameFingerprint++ }
  }
  return immutableJson({ schema: 'cfb.eval-report/1', ...summarizeMinimal(plan, results), mode: plan.simulation ? 'simulation' : 'live', channelVerified: !!state?.entries.some((e) => e.kind === 'probe' && e.status === 'accepted'),
    fingerprintHistogram, pairsSameFingerprint, pairsTotal,
    // v14.2：逐样本规则结果随报告导出（闭环按 task|variant|sample 配对；仍是冻结判据算出的量，不是新打分）。
    results: results.map((r) => ({ task: r.task, variant: r.variant, sample: r.sample, rule: r.rule, action: r.action })),
    requestsRejected: state?.entries.filter((e) => e.status === 'rejected').map((e) => ({ key: e.key, reason: e.reason ?? null })) ?? [],
    requestsReserved: state?.entries.length || 0, reservedUsd: state?.entries.reduce((n, e) => n + e.reservedNano, 0) / 1e9 || 0, actualCostUsd: null,
    stopped: state?.halted || (state?.entries.some((e) => e.status === 'pending') ? 'api-unsettled-dispatch' : null), judgeRequests: 0, retries: 0, sourceDigest: plan.sourceDigest, sourceCurrent: sourceDifferences(plan).length === 0 })
}
/** 共用执行内核，传输由显式宿主提供；模拟与真实网络共享相同预算/校验/报告。 */
export async function executePreparedEvaluation({ home, receiptPath, apiKey, fetchImpl = globalThis.fetch, signal, stopAfter = null, checkpointFile = null, passphrase = null, onProgress = () => {} }) {
  const p = paths(home), plan = loadPrepared(home)
  if (checkpointFile) assertAutoCheckpoint({ home, receiptPath, file: checkpointFile, passphrase })
  const onStateCommitted = checkpointFile ? () => exportEvaluationBundle({ home, receiptPath, file: checkpointFile, passphrase, replace: true }) : undefined
  const budget = createBudgetedChat({ plan, apiKey, directory: p.ledger, receiptPath, fetchImpl, timeoutMs: plan.execution.timeoutMs, maxResponseBytes: plan.execution.maxResponseBytes, onStateCommitted })
  let stopped = null, processed = 0
  const snapshotState = () => { try { return inspectApiBudget({ plan, directory: p.ledger, receiptPath })?.snapshot() || null } catch { return null } }
  try {
    for (const job of plan.jobs) {
      if (signal?.aborted) throw new Error('request-aborted')
      const before = snapshotState()
      if (before?.halted) { stopped = before.halted; break }
      // 已作废（rejected）请求永不重发；探针一旦有 accepted，其余备用探针跳过、不预占。
      if (before?.entries.some((e) => e.key === job.key && e.status === 'rejected')) continue
      if (job.kind === 'probe' && before?.entries.some((e) => e.kind === 'probe' && e.status === 'accepted')) continue
      const cached = budget.cached(job.key)
      try {
        const r = cached || await budget.run(job.key, { signal })
        processed++; onProgress({ key: job.key, status: cached ? 'cached' : 'accepted', kind: job.kind })
        if (stopAfter !== null && processed >= stopAfter) { stopped = 'operator-checkpoint'; break }
        // r不直接打印；详细响应只留私有认证仓。
        void r
      } catch (e) {
        const reason = safeCode(e), after = snapshotState()
        onProgress({ key: job.key, status: 'rejected', kind: job.kind, reason })
        // v1（无网络失败预算）保持原语义立即停止；v2 仅在账本未停机时继续尚未派发的请求，该失败请求已花费并永久作废。
        if (!after || after.halted || e.message === 'request-aborted' || !(plan.limits?.networkFailureBudget > 0 || plan.limits?.sampleFailureBudget > 0)) throw e
      }
    }
  } catch (e) { stopped = safeCode(e) }
  let report
  try { const current = reportEvaluation({ home, receiptPath }); report = { ...current, stopped: stopped || current.stopped } }
  catch (e) { report = { schema: 'cfb.eval-report/1', complete: false, stopped: safeCode(e), requestsReserved: null, reservedUsd: null, budgetUnknown: true, judgeRequests: 0, retries: 0 } }
  writeJson(p.summary, report)
  return immutableJson(report)
}
export async function runEvaluation({ home = DEFAULT_HOME, receiptPath = PUBLIC_RECEIPT, env = {}, live = false, signal, onProgress, now, checkpointFile = null } = {}) {
  if (!live) throw new Error('explicit-live-required')
  const doctor = doctorEvaluation({ home, receiptPath, env, now })
  if (doctor.status !== 'live-preflight-ready') throw new Error('eval-preflight-blocked')
  const plan = loadPrepared(home)
  return executePreparedEvaluation({ home, receiptPath, apiKey: env[plan.execution.apiKeyEnv], signal, onProgress, checkpointFile, passphrase: checkpointFile ? env.CFB_STATE_PASSPHRASE : null })
}
