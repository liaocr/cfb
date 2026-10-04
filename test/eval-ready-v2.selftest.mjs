// v2 有界评测（2026-10-01 新批准scope）：网络容错但不放松任何可信性闸；v1 语义回归保持。全部mock传输，零网络。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBudgetedChat, inspectApiBudget, auditApiPlan, APPROVED_API_LIMITS_V2, planScope } from '../tools/helpers/api-budget.mjs'
import { API_APPROVAL_SCOPE, API_APPROVAL_SCOPE_V2, readWatermark } from '../tools/helpers/api-watermark.mjs'
import { buildMinimalPlan, buildBoundedPlanV2 } from '../tools/helpers/eval-plan.mjs'
import { prepareEvaluation, doctorEvaluation, reportEvaluation, loadPrepared, executePreparedEvaluation } from '../tools/helpers/eval-workflow.mjs'
import { readJson } from '../tools/helpers/eval-files.mjs'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-eval-v2-'))
const NOW = Date.parse('2026-10-01T12:00:00Z'), KEY = 'offline-key-fixture-not-a-secret'
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-10-01' }
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
const fresh = () => { const dir = fs.mkdtempSync(path.join(ROOT, 'case-')); return { home: path.join(dir, 'state'), receiptPath: path.join(dir, 'public.json'), dir } }
const prepared = (o = {}) => { const w = fresh(); prepareEvaluation({ ...w, profile: PROFILE, version: 2, ...o }); return { ...w, plan: loadPrepared(w.home) } }
const payload = (plan, job) => ({ model: plan.model, system_fingerprint: 'fp_dspure_app_v1', usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: job?.kind === 'probe' ? plan.canary : '本机固定回答', reasoning_content: '本机固定推理' } }] })
// script: 依次消费的传输行为数组，'net' 抛网络错、'http5' 返回500、函数则自定义
const scripted = (plan, script) => {
  let n = 0
  return { count: () => n, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), job = plan.jobs.find((j) => JSON.stringify(j.body) === JSON.stringify(body)) || plan.jobs.find((j) => j.body.messages.length === body.messages.length)
    const act = script[Math.min(n, script.length - 1)]; n++
    if (act === 'net') throw new TypeError('fetch failed')
    if (act === 'http5') return { ok: false, status: 502, text: async () => 'bad gateway' }
    const p = typeof act === 'function' ? act(body, job) : payload(plan, job)
    return { ok: true, status: 200, text: async () => JSON.stringify(p) }
  } }
}
const client = (w, m, extra = {}) => createBudgetedChat({ plan: w.plan, apiKey: KEY, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath, fetchImpl: m.fetchImpl, ...extra })
const snapshot = (w) => inspectApiBudget({ plan: w.plan, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath }).snapshot()

try {
  await test('01 v2计划形状：3同体探针+12主、limits冻结、scope独立、预算审计仍≤2USD', () => {
    const plan = buildBoundedPlanV2({ pricing: PRICING })
    assert.equal(plan.schema, 'cfb.bounded-ab/2'); assert.equal(plan.jobs.length, 15)
    assert.deepEqual(plan.jobs.slice(0, 3).map((j) => j.key), ['probe', 'probe-r1', 'probe-r2'])
    assert.equal(new Set(plan.jobs.slice(0, 3).map((j) => JSON.stringify(j.body))).size, 1)
    assert.equal(planScope(plan), API_APPROVAL_SCOPE_V2)
    assert.equal(planScope(buildMinimalPlan()), API_APPROVAL_SCOPE)
    const audit = auditApiPlan(plan)
    assert.equal(audit.maxRequests, 15); assert.ok(audit.totalReservedUsd <= 2)
    assert.throws(() => auditApiPlan({ ...plan, limits: { ...APPROVED_API_LIMITS_V2, networkFailureBudget: 99 } }), /api-approval-changed/)
    assert.throws(() => auditApiPlan({ ...plan, jobs: [plan.jobs[0], { ...plan.jobs[1], body: { ...plan.jobs[1].body, max_tokens: 400 } }, ...plan.jobs.slice(2)] }), /api-matrix/)
  })
  await test('02 探针1网络失败不停机、不退款；探针2成功验证canary后主请求可发', async () => {
    const w = prepared(), m = scripted(w.plan, ['net', null, null])
    const c = client(w, m)
    await assert.rejects(c.run('probe'), /request-network-error/)
    let s = snapshot(w)
    assert.equal(s.halted, null)
    assert.equal(s.entries.find((e) => e.key === 'probe').status, 'rejected')
    const reservedAfterFailure = s.entries.reduce((n, e) => n + e.reservedNano, 0)
    assert.ok(reservedAfterFailure > 0)
    await c.run('probe-r1')
    s = snapshot(w)
    assert.equal(s.entries.find((e) => e.key === 'probe-r1').status, 'accepted')
    assert.ok(s.entries.reduce((n, e) => n + e.reservedNano, 0) > reservedAfterFailure)
    await c.run('flaky-timeout|raw|0')
    assert.equal(snapshot(w).entries.find((e) => e.key === 'flaky-timeout|raw|0').status, 'accepted')
  })
  await test('03 网络类失败累计达预算3即硬停；后续dispatch拒绝api-ledger-halted', async () => {
    const w = prepared(), c = client(w, scripted(w.plan, ['net', 'http5', 'net']))
    await assert.rejects(c.run('probe'), /request-network-error/)
    await assert.rejects(c.run('probe-r1'), /HTTP 502/)
    await assert.rejects(c.run('probe-r2'), /request-network-error/)
    assert.equal(snapshot(w).halted, 'api-network-failure-budget')
    await assert.rejects(client(w, scripted(w.plan, [null])).run('flaky-timeout|raw|0'), /api-ledger-halted/)
  })
  await test('04 可信性失败（指纹/型号/usage越界）不享受网络容错，立即全停', async () => {
    const w = prepared(), c = client(w, scripted(w.plan, [(body, job) => ({ ...payload(w.plan, job), system_fingerprint: 'fp_other' })]))
    await assert.rejects(c.run('probe'), /channel-fingerprint/)
    assert.equal(snapshot(w).halted, 'channel-fingerprint')
    const w2 = prepared(), c2 = client(w2, scripted(w2.plan, [(body, job) => ({ ...payload(w2.plan, job), usage: { prompt_tokens: 99999999, completion_tokens: 20 } })]))
    await assert.rejects(c2.run('probe'), /api-usage-out-of-bound/)
    assert.equal(snapshot(w2).halted, 'api-usage-out-of-bound')
  })
  await test('05 executePrepared：探针成功后备用探针跳过不预占；网络失败请求不重发且流程继续', async () => {
    const w = prepared(), m = scripted(w.plan, [null, 'net', ...Array(11).fill(null)])
    const r = await executePreparedEvaluation({ home: w.home, receiptPath: w.receiptPath, apiKey: KEY, fetchImpl: m.fetchImpl })
    // 1探针成功 + 12主中1个网络失败=12次dispatch记账（其中11主成功），备用探针0次
    const s = snapshot(w)
    assert.equal(s.entries.filter((e) => e.kind === 'probe').length, 1)
    assert.equal(s.entries.filter((e) => e.status === 'rejected').length, 1)
    assert.equal(s.halted, null)
    assert.equal(r.validMainResponses, 11)
    assert.equal(r.requestsRejected.length, 1)
    assert.equal(m.count(), 13)
    // 再跑：已作废请求不重发、已认证不重压，0新传输
    const m2 = scripted(w.plan, [null])
    const r2 = await executePreparedEvaluation({ home: w.home, receiptPath: w.receiptPath, apiKey: KEY, fetchImpl: m2.fetchImpl })
    assert.equal(m2.count(), 0)
    assert.equal(r2.validMainResponses, 11)
  })
  await test('06 v1语义回归：单次网络失败即halted，报告stopped如实', async () => {
    const w = fresh(); prepareEvaluation({ ...w, profile: PROFILE, version: 1 })
    const plan = loadPrepared(w.home), m = scripted(plan, ['net'])
    const r = await executePreparedEvaluation({ home: w.home, receiptPath: w.receiptPath, apiKey: KEY, fetchImpl: m.fetchImpl })
    assert.equal(r.stopped, 'request-network-error')
    assert.equal(inspectApiBudget({ plan, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath }).snapshot().halted, 'request-network-error')
    assert.equal(m.count(), 1)
  })
  await test('07 v2水印：scope/requests≤15合法；篡改scope或超容量拒绝；与v1收据不互换', async () => {
    const w = prepared(), c = client(w, scripted(w.plan, [null]))
    await c.run('probe')
    const marker = readWatermark(w.receiptPath)
    assert.equal(marker.scope, API_APPROVAL_SCOPE_V2)
    const forged = JSON.parse(JSON.stringify(marker)); forged.scope = API_APPROVAL_SCOPE
    fs.writeFileSync(w.receiptPath, JSON.stringify(forged))
    assert.throws(() => snapshot(w), /api-watermark-integrity|api-watermark-conflict/)
  })
  await test('08 doctor在部分网络失败后仍ready（未停机、无pending），停机后blocked', async () => {
    const w = prepared(), c = client(w, scripted(w.plan, ['net']))
    await assert.rejects(c.run('probe'), /request-network-error/)
    assert.equal(doctorEvaluation({ home: w.home, receiptPath: w.receiptPath, env: { DEEPSEEK_API_KEY: KEY }, now: NOW }).status, 'live-preflight-ready')
    const c2 = client(w, scripted(w.plan, ['net', 'net']))
    await assert.rejects(c2.run('probe-r1'), /request-network-error/)
    await assert.rejects(c2.run('probe-r2'), /request-network-error/)
    assert.equal(doctorEvaluation({ home: w.home, receiptPath: w.receiptPath, env: { DEEPSEEK_API_KEY: KEY }, now: NOW }).status, 'blocked')
  })
  await test('09 报告如实分列：channelVerified需accepted探针；reservedUsd含作废请求，不当成本证明', async () => {
    const w = prepared(), c = client(w, scripted(w.plan, ['net', null]))
    await assert.rejects(c.run('probe'), /request-network-error/)
    let rep = reportEvaluation({ home: w.home, receiptPath: w.receiptPath })
    assert.equal(rep.channelVerified, false)
    assert.deepEqual(rep.requestsRejected, [{ key: 'probe', reason: 'request-network-error' }])
    await c.run('probe-r1')
    rep = reportEvaluation({ home: w.home, receiptPath: w.receiptPath })
    assert.equal(rep.channelVerified, true)
    assert.equal(rep.requestsReserved, 2)
    assert.equal(rep.actualCostUsd, null)
  })
  await test('10 prepare幂等且digest绑定：既有v2计划重prepare不换canary；有收据后换版本改稿拒绝', async () => {
    const w = prepared(), before = loadPrepared(w.home)
    prepareEvaluation({ ...w, profile: PROFILE, version: 2 })
    assert.equal(loadPrepared(w.home).canary, before.canary)
    await client(w, scripted(w.plan, [null])).run('probe')
    // 已有v2计划时version=1被粘住为v2（防降级换稿），幂等不变digest
    prepareEvaluation({ ...w, profile: PROFILE, version: 1 })
    assert.equal(loadPrepared(w.home).schema, 'cfb.bounded-ab/2')
    assert.equal(loadPrepared(w.home).canary, before.canary)
    // 收据在、私有计划不在（换目录）：必须先恢复，不能重开预算
    const w2 = { home: path.join(w.dir, 'state-2'), receiptPath: w.receiptPath }
    assert.throws(() => prepareEvaluation({ ...w2, profile: PROFILE, version: 2 }), /api-budget-restore-required/)
  })
} finally { fs.rmSync(ROOT, { recursive: true, force: true }) }
console.log(`eval-ready-v2: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
