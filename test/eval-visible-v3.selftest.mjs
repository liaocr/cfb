// v3 生产等价可见上下文协议：raw=思考已丢、current=可见压缩稿；指纹按scope锚定。全部mock传输，零网络。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBudgetedChat, inspectApiBudget, auditApiPlan, planScope, planVersion, TRUSTED_FINGERPRINTS, DRAFT_BLOCK_PREFIX, DRAFT_BLOCK_SUFFIX } from '../tools/helpers/api-budget.mjs'
import { API_APPROVAL_SCOPE_V3, API_APPROVAL_SCOPE_V4 } from '../tools/helpers/api-watermark.mjs'
import { buildVisiblePlanV3, buildVisiblePlanV4 } from '../tools/helpers/eval-plan.mjs'
import { prepareEvaluation, doctorEvaluation, loadPrepared, executePreparedEvaluation } from '../tools/helpers/eval-workflow.mjs'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-eval-v3-'))
const NOW = Date.parse('2026-10-01T12:00:00Z'), KEY = 'offline-key-fixture-not-a-secret'
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-10-01' }
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
const fresh = () => { const dir = fs.mkdtempSync(path.join(ROOT, 'case-')); return { home: path.join(dir, 'state'), receiptPath: path.join(dir, 'public.json'), dir } }
const prepared = () => { const w = fresh(); prepareEvaluation({ ...w, profile: PROFILE, version: 3 }); return { ...w, plan: loadPrepared(w.home) } }
const payload = (plan, job, fp = TRUSTED_FINGERPRINTS[3]) => ({ model: plan.model, system_fingerprint: fp, usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: job?.kind === 'probe' ? plan.canary : '本机固定回答', reasoning_content: '本机固定推理' } }] })
const mock = (plan, f) => { let n = 0; return { count: () => n, fetchImpl: async (_url, options) => { n++; const body = JSON.parse(options.body); const job = plan.jobs.find((j) => JSON.stringify(j.body) === JSON.stringify(body)); return { ok: true, status: 200, text: async () => JSON.stringify(f ? f(body, job, n) : payload(plan, job)) } } } }
const client = (w, m) => createBudgetedChat({ plan: w.plan, apiKey: KEY, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath, fetchImpl: m.fetchImpl })
const snapshot = (w) => inspectApiBudget({ plan: w.plan, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath }).snapshot()

try {
  await test('01 v3形状：全消息零reasoning_content；canary只在探针单条可见assistant；raw臂无稿、current臂稿块前缀+raw逐字节', () => {
    const plan = buildVisiblePlanV3({ pricing: PRICING })
    assert.equal(plan.schema, 'cfb.bounded-ab/3'); assert.equal(planVersion(plan), 3); assert.equal(planScope(plan), API_APPROVAL_SCOPE_V3)
    assert.ok(plan.jobs.every((j) => j.body.messages.every((m) => m.reasoning_content === undefined)))
    assert.ok(plan.jobs.filter((j) => j.kind === 'main').every((j) => !JSON.stringify(j.body).includes(plan.canary)))
    for (const task of ['flaky-timeout', 'wrong-model', 'eacces-config']) for (const sample of [0, 1]) {
      const raw = plan.jobs.find((j) => j.key === `${task}|raw|${sample}`), cur = plan.jobs.find((j) => j.key === `${task}|current|${sample}`)
      const diff = raw.body.messages.map((m, i) => [m, cur.body.messages[i]]).filter(([a, b]) => a.content !== b.content)
      assert.ok(diff.length >= 1 && diff.every(([a, b]) => a.role === 'assistant' && b.content.startsWith(DRAFT_BLOCK_PREFIX) && b.content.includes(DRAFT_BLOCK_SUFFIX) && b.content.endsWith(a.content)))
    }
    assert.ok(auditApiPlan(plan).totalReservedUsd <= 2)
  })
  await test('02 v3指纹锚：旧官方指纹在v3拒绝；锚定vllm指纹接受；null拒绝', async () => {
    const w = prepared()
    await assert.rejects(client(w, mock(w.plan, (b, j) => payload(w.plan, j, 'fp_dspure_app_v1'))).run('probe'), /channel-fingerprint/)
    assert.equal(snapshot(w).halted, 'channel-fingerprint')
    const w2 = prepared()
    await assert.rejects(client(w2, mock(w2.plan, (b, j) => payload(w2.plan, j, null))).run('probe'), /channel-fingerprint|channel-/)
    const w3 = prepared()
    await client(w3, mock(w3.plan)).run('probe')
    assert.equal(snapshot(w3).entries[0].status, 'accepted')
  })
  await test('03 篡改稿块关系（current不含前缀/尾部不等raw）审计拒绝api-matrix-protocol', () => {
    const plan = buildVisiblePlanV3({ pricing: PRICING })
    const jobs = plan.jobs.map((j) => j.key === 'flaky-timeout|current|0' ? { ...j, body: { ...j.body, messages: j.body.messages.map((m, i) => i === 2 ? { ...m, content: '被偷换的稿\n' + m.content.slice(DRAFT_BLOCK_PREFIX.length) } : m) } } : j)
    assert.throws(() => auditApiPlan({ ...plan, jobs }), /api-matrix-protocol/)
  })
  await test('04 v3探针canary必须逐字回显才accepted；网络容错语义继承v2', async () => {
    const w = prepared()
    await assert.rejects(client(w, mock(w.plan, (b, j) => ({ ...payload(w.plan, j), choices: [{ finish_reason: 'stop', message: { content: '标记是XYZ', reasoning_content: '想' } }] }))).run('probe'), /channel-history-not-visible/)
    assert.equal(snapshot(w).halted, 'channel-history-not-visible')
    const w2 = prepared(); let n = 0
    const flaky = { fetchImpl: async (u, o) => { n++; if (n === 1) throw new TypeError('fetch failed'); const body = JSON.parse(o.body); const job = w2.plan.jobs.find((j) => JSON.stringify(j.body) === JSON.stringify(body)); return { ok: true, status: 200, text: async () => JSON.stringify(payload(w2.plan, job)) } } }
    const r = await executePreparedEvaluation({ home: w2.home, receiptPath: w2.receiptPath, apiKey: KEY, fetchImpl: flaky.fetchImpl })
    assert.equal(r.channelVerified, true)
    assert.equal(r.validMainResponses, 12)
    assert.deepEqual(r.requestsRejected, [{ key: 'probe', reason: 'request-network-error' }])
    assert.equal(snapshot(w2).entries.filter((e) => e.kind === 'probe').length, 2)
  })
  await test('05 doctor对v3计划可ready；v3收据scope正确且与v2目录互不可用', async () => {
    const w = prepared()
    assert.equal(doctorEvaluation({ home: w.home, receiptPath: w.receiptPath, env: { DEEPSEEK_API_KEY: KEY }, now: NOW }).status, 'live-preflight-ready')
    await client(w, mock(w.plan)).run('probe')
    const marker = JSON.parse(fs.readFileSync(w.receiptPath, 'utf8'))
    assert.equal(marker.scope, API_APPROVAL_SCOPE_V3)
    assert.throws(() => prepareEvaluation({ home: path.join(w.dir, 'other'), receiptPath: w.receiptPath, profile: PROFILE, version: 2 }), /api-budget-restore-required|api-watermark-conflict/)
  })
  await test('06 v4形状：主请求8192/探针512、limits含sampleFailureBudget、对照关系与v3同构、审计通过', () => {
    const plan = buildVisiblePlanV4({ pricing: PRICING })
    assert.equal(plan.schema, 'cfb.bounded-ab/4'); assert.equal(planVersion(plan), 4); assert.equal(planScope(plan), API_APPROVAL_SCOPE_V4)
    assert.ok(plan.jobs.filter((j) => j.kind === 'main').every((j) => j.body.max_tokens === 8192))
    assert.ok(plan.jobs.filter((j) => j.kind === 'probe').every((j) => j.body.max_tokens === 512))
    const a = auditApiPlan(plan); assert.ok(a.totalReservedUsd <= 2); assert.equal(a.maxRequests, 15)
  })
  await test('07 v4：response-incomplete为样本级失败不停机；累计3次硬停api-sample-failure-budget；v3老语义保持全停', async () => {
    const w = (() => { const x = fresh(); prepareEvaluation({ ...x, profile: PROFILE, version: 4 }); return { ...x, plan: loadPrepared(x.home) } })()
    const truncated = (b, j) => ({ ...payload(w.plan, j), choices: [{ finish_reason: 'length', message: { content: '被截断', reasoning_content: '想' } }] })
    const c = client(w, mock(w.plan, (b, j, n) => n === 2 ? truncated(b, j) : payload(w.plan, j)))
    await c.run('probe')
    await assert.rejects(c.run('flaky-timeout|raw|0'), /response-incomplete/)
    assert.equal(snapshot(w).halted, null)
    await c.run('flaky-timeout|current|0')
    assert.equal(snapshot(w).entries.find((e) => e.key === 'flaky-timeout|current|0').status, 'accepted')
    const c2 = client(w, mock(w.plan, truncated))
    await assert.rejects(c2.run('wrong-model|raw|0'), /response-incomplete/)
    await assert.rejects(c2.run('wrong-model|current|0'), /response-incomplete/)
    assert.equal(snapshot(w).halted, 'api-sample-failure-budget')
    // v3 计划仍然是旧语义：单个 response-incomplete 直接停机
    const w3 = prepared()
    const c3 = client(w3, mock(w3.plan, (b, j, n) => n === 1 ? payload(w3.plan, j) : truncated(b, j)))
    await c3.run('probe')
    await assert.rejects(c3.run('flaky-timeout|raw|0'), /response-incomplete/)
    assert.equal(snapshot(w3).halted, 'response-incomplete')
  })
} finally { fs.rmSync(ROOT, { recursive: true, force: true }) }
console.log(`eval-visible-v3: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
