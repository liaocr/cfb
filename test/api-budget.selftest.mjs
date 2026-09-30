// 请求 mock + 一次真实 loopback 重定向；无外部 API/凭据/评委。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { makeChat, channelIssue } from '../tools/effect-eval.mjs'
import { buildMinimalPlan, summarizeMinimal } from '../tools/bounded-ab.mjs'
import { createBudgetedChat, auditApiPlan, quoteJob, inputTokenBound } from '../tools/helpers/api-budget.mjs'
import { createEvidenceStore } from '../src/evidence-store.js'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-api-budget-'))
const CANARY = 'CFB_CANARY_' + 'a'.repeat(32)
const PRICING = { inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.05, requestFeeUsd: 0, source: 'https://pricing.example.invalid/test-only', verifiedAt: '2026-09-30' }
const PLAN = buildMinimalPlan({ pricing: PRICING, canary: CANARY })
const body = PLAN.jobs[0].body
const payload = (overrides = {}) => ({ model: PLAN.model, system_fingerprint: 'fp_dspure_app_v1', usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: CANARY, reasoning_content: '检查上一轮推理中的标记。' } }], ...overrides })
const response = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
const temp = () => fs.mkdtempSync(path.join(HOME, 'ledger-'))
const mock = (fn = () => payload()) => {
  const requests = []
  return { requests, fetchImpl: async (url, options) => { requests.push({ url, options }); return response(await fn(JSON.parse(options.body), options)) } }
}
const bounded = (m, plan = PLAN, directory = temp()) => createBudgetedChat({ plan, apiKey: 'unit-test-only', directory, fetchImpl: m.fetchImpl, timeoutMs: 1000 })

try {
  await test('01 最大输出冻结；按完整 UTF-8 字节保守预留，非按压后字数取巧', () => {
    assert.ok(inputTokenBound(body) > JSON.stringify(body).length)
    assert.equal(quoteJob(body, PRICING).outputTokens, 512)
    assert.throws(() => quoteJob({ ...body, max_tokens: 0 }, PRICING), /api-output-limit/)
    assert.throws(() => quoteJob({ ...body, n: 2 }, PRICING), /api-output-limit/)
    assert.throws(() => quoteJob({ ...body, stream: true }, PRICING), /api-output-limit/)
  })
  await test('02 缺报价/非有限价格/不安全 URL 不允许 dispatch', () => {
    assert.throws(() => auditApiPlan({ ...PLAN, pricing: null }), /api-pricing-required/)
    assert.throws(() => quoteJob(body, { ...PRICING, inputUsdPerMillion: NaN }), /api-pricing-required/)
    assert.throws(() => auditApiPlan({ ...PLAN, baseUrl: 'https://user:pass@example.invalid/v1' }), /api-endpoint/)
    assert.throws(() => auditApiPlan({ ...PLAN, baseUrl: 'https://example.invalid/v1?key=x' }), /api-endpoint/)
  })
  await test('03 全 13 请求最坏预估超 USD2，第一请求也不发', () => {
    const m = mock()
    assert.throws(() => bounded(m, { ...PLAN, pricing: { ...PRICING, outputUsdPerMillion: 100000 } }), /exceeds-2usd/)
    assert.equal(m.requests.length, 0)
  })
  await test('04 冻结三任务×两变体×两样本；只换 reasoning，参考答案不入输入', () => {
    const a = auditApiPlan(PLAN); assert.equal(a.main, 12); assert.equal(a.probe, 1)
    assert.equal(PLAN.jobs.length, 13); assert.equal(PLAN.limits.retries, 0); assert.equal(PLAN.limits.judges, 0)
    for (let i = 1; i < PLAN.jobs.length; i += 2) {
      const raw = PLAN.jobs[i], current = PLAN.jobs[i + 1]
      const strip = (b) => ({ ...b, messages: b.messages.map(({ reasoning_content, ...m }) => m) })
      assert.deepEqual(strip(raw.body), strip(current.body))
      assert.equal(raw.variant, 'raw'); assert.equal(current.variant, 'current')
      assert.ok(!JSON.stringify(raw.body).includes('【参考：'))
    }
    assert.ok(Object.isFrozen(PLAN.jobs[1].body.messages))
  })
  await test('05 探针标记只能在上一轮 assistant.reasoning_content；无第 2 个探针', () => {
    assert.throws(() => auditApiPlan({ ...PLAN, jobs: [...PLAN.jobs, PLAN.jobs[0]] }), /api-plan-schema|api-job-schema/)
    const jobs = JSON.parse(JSON.stringify(PLAN.jobs)); jobs[0].body.messages[2].content += CANARY
    assert.throws(() => auditApiPlan({ ...PLAN, jobs }), /api-probe-leak/)
    const leaked = JSON.parse(JSON.stringify(PLAN.jobs)); leaked[0].body.tools = [{ name: CANARY }]
    assert.throws(() => auditApiPlan({ ...PLAN, jobs: leaked }), /api-probe-leak/)
  })
  await test('06 maxRetries:0 的 5xx 恰好一次，错误正文不回显', async () => {
    let n = 0
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', maxRetries: 0, fetchImpl: async () => { n++; return { ok: false, status: 502, text: async () => 'credential-looking-private-body' } } })
    await assert.rejects(chat(body), (e) => e.message === 'HTTP 502')
    assert.equal(n, 1)
  })
  await test('07 maxRetries:0 的连接错误恰好一次且不复制异常正文', async () => {
    let n = 0
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', maxRetries: 0, fetchImpl: async () => { n++; throw new Error('private-error-body') } })
    await assert.rejects(chat(body), /request-network-error/); assert.equal(n, 1)
  })
  await test('08 旧重试参数兼容，每次实际重试也必须再经过预算钩子', async () => {
    let n = 0, before = 0
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', maxRetries: 1, sleep: async () => {}, beforeRequest: () => { before++ }, fetchImpl: async () => { n++; return n === 1 ? { ok: false, status: 503, text: async () => '' } : response(payload()) } })
    assert.equal((await chat(body)).model, PLAN.model); assert.equal(n, 2); assert.equal(before, 2)
  })
  await test('09 预算钩子拒绝时 fetch=0，不按连接错误自动重试', async () => {
    const m = mock(); let before = 0
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', beforeRequest: () => { before++; throw new Error('budget-denied') }, fetchImpl: m.fetchImpl })
    await assert.rejects(chat(body), /budget-denied/); assert.equal(m.requests.length, 0); assert.equal(before, 1)
  })
  await test('10 请求字节在异步钩子前冻结，不被检查后 body 变异替换', async () => {
    const m = mock(), b = JSON.parse(JSON.stringify(body))
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', maxRetries: 0, fetchImpl: m.fetchImpl, beforeRequest: async () => { b.model = 'changed' } })
    await chat(b); assert.equal(JSON.parse(m.requests[0].options.body).model, PLAN.model)
    assert.equal(m.requests[0].options.redirect, 'error')
  })
  await test('11 预取消零钩子/零 dispatch', async () => {
    const m = mock(), b = bounded(m), ctl = new AbortController(); ctl.abort()
    await assert.rejects(b.run('probe', { signal: ctl.signal }), /request-aborted/)
    assert.equal(b.snapshot().entries.length, 0); assert.equal(m.requests.length, 0)
  })
  await test('12 timeout 不重试，也不把迟到的绿灯当成功', async () => {
    const m = mock(async () => { await new Promise((r) => setTimeout(r, 30)); return payload() })
    const b = createBudgetedChat({ plan: PLAN, apiKey: 'test', directory: temp(), fetchImpl: m.fetchImpl, timeoutMs: 10 })
    await assert.rejects(b.run('probe'), /request-timeout/)
    assert.equal(m.requests.length, 1); assert.equal(b.snapshot().halted, 'request-timeout'); assert.equal(b.cached('probe'), null)
  })
  await test('13 相同请求 model 不等于响应 model；缺型号/指纹/思考都无效', () => {
    const good = { model: PLAN.model, fp: 'fp_dspure_app_v1', usage: { prompt_tokens: 1 }, message: { reasoning_content: '想过' } }
    assert.equal(channelIssue(good, PLAN.model), null)
    assert.equal(channelIssue({ ...good, model: undefined }, PLAN.model), 'channel-model-mismatch')
    assert.equal(channelIssue({ ...good, model: 'cb/' + PLAN.model }, PLAN.model), 'channel-model-mismatch')
    assert.equal(channelIssue({ ...good, fp: null }, PLAN.model), 'channel-fingerprint')
    assert.equal(channelIssue({ ...good, message: {} }, PLAN.model), 'channel-no-thinking')
    assert.equal(channelIssue({ ...good, usage: { claude_input_tokens: 1 } }, PLAN.model), 'channel-usage')
  })
  await test('14 先探针后主模型；先发主请求被本地拒绝且不占实际调用', async () => {
    const m = mock(), b = bounded(m)
    await assert.rejects(b.run(PLAN.jobs[1].key), /api-probe-required/)
    assert.equal(m.requests.length, 0); assert.equal(b.snapshot().entries.length, 0)
    await b.run('probe'); assert.equal(m.requests.length, 1)
  })
  await test('15 探针不能复述隐藏标记立即停；预留费用不退款', async () => {
    const m = mock(() => payload({ choices: [{ finish_reason: 'stop', message: { content: '不知道', reasoning_content: '不可见' } }] })), b = bounded(m)
    await assert.rejects(b.run('probe'), /channel-history-not-visible/)
    assert.equal(b.snapshot().entries.length, 1); assert.ok(b.snapshot().entries[0].reservedNano > 0)
    await assert.rejects(b.run(PLAN.jobs[1].key), /api-ledger-halted/); assert.equal(m.requests.length, 1)
  })
  await test('16 错误响应型号只耗一次，坏正文不归档为成功样本', async () => {
    const m = mock(() => payload({ model: 'wrong-model' })), b = bounded(m)
    await assert.rejects(b.run('probe'), /channel-model-mismatch/)
    assert.equal(b.snapshot().entries[0].status, 'rejected'); assert.equal(b.cached('probe'), null)
    await assert.rejects(b.run('probe'), /api-ledger-halted/); assert.equal(m.requests.length, 1)
  })
  await test('17 null 指纹不是第四次以后就可信，首次失败即停', async () => {
    const m = mock(() => payload({ system_fingerprint: null })), b = bounded(m)
    await assert.rejects(b.run('probe'), /channel-fingerprint/)
    await assert.rejects(b.run(PLAN.jobs[1].key), /api-ledger-halted/); assert.equal(m.requests.length, 1)
  })
  await test('18 usage 缺字段/输入越界/输出越界，保留整笔预占并停止', async () => {
    for (const usage of [{ prompt_tokens: 1 }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 513 }]) {
      const m = mock(() => payload({ usage })), b = bounded(m)
      await assert.rejects(b.run('probe'), /api-usage-out-of-bound/)
      assert.equal(m.requests.length, 1); assert.equal(b.snapshot().entries[0].status, 'rejected')
    }
  })
  await test('19 截断响应不参与成功样本，也不补样本', async () => {
    const m = mock(() => payload({ choices: [{ finish_reason: 'length', message: { content: CANARY, reasoning_content: '截断' } }] })), b = bounded(m)
    await assert.rejects(b.run('probe'), /response-incomplete/); assert.equal(m.requests.length, 1)
  })
  await test('20 完整最小矩阵恰好 13 dispatch；重复 job 不再发送', async () => {
    const m = mock(), b = bounded(m)
    for (const job of PLAN.jobs) await b.run(job.key)
    assert.equal(m.requests.length, 13); assert.equal(b.snapshot().entries.length, 13)
    assert.ok(b.snapshot().entries.reduce((n, e) => n + e.reservedNano, 0) <= 2e9)
    await assert.rejects(b.run(PLAN.jobs[1].key), /already-dispatched/); assert.equal(m.requests.length, 13)
  })
  await test('21 重启沿用 HMAC 台账/缓存；换模型/价格/稿不能重置批准额度', async () => {
    const directory = temp(), m = mock(), b = bounded(m, PLAN, directory); await b.run('probe')
    const reopened = bounded(m, PLAN, directory)
    assert.equal(reopened.cached('probe').model, PLAN.model)
    await assert.rejects(reopened.run('probe'), /already-dispatched/)
    assert.throws(() => bounded(m, { ...PLAN, pricing: { ...PRICING, requestFeeUsd: 0.0001 } }, directory), /api-plan-changed/)
    assert.equal(m.requests.length, 1)
  })
  await test('22 崩溃遗留 pending 不自动抢回/退款/重发', async () => {
    const directory = temp(), m = mock(), b = bounded(m, PLAN, directory)
    const store = createEvidenceStore({ directory, sessionId: 'cfb.minimal-api-approval.2026-09-30' }), head = store.readHead('api-budget'), state = store.getJson(head.ref, { kind: 'api-budget' })
    const next = { ...state, entries: [{ key: 'probe', kind: 'probe', reservedNano: quoteJob(body, PRICING).reservedNano, status: 'pending' }] }
    store.setHead('api-budget', store.putJson(next, { kind: 'api-budget' }), { expectedRevision: head.revision })
    await assert.rejects(b.run('probe'), /api-unsettled-dispatch/); assert.equal(m.requests.length, 0)
  })
  await test('23 两个客户端同一额度不能并发重复探针', async () => {
    const directory = temp(), m = mock(async () => { await new Promise((r) => setTimeout(r, 15)); return payload() }), a = bounded(m, PLAN, directory), b = bounded(m, PLAN, directory)
    const pending = a.run('probe')
    await assert.rejects(b.run('probe'), /api-unsettled-dispatch/)
    await pending; assert.equal(m.requests.length, 1)
  })
  await test('24 无 JSON/协议响应不自动重试；输出模型字段保留', async () => {
    let n = 0
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', fetchImpl: async () => { n++; return { ok: true, text: async () => 'bad-json' } }, sleep: async () => {} })
    await assert.rejects(chat(body), /response-json/); assert.equal(n, 1)
    const m = mock(); assert.equal((await makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', fetchImpl: m.fetchImpl })(body)).model, PLAN.model)
  })
  await test('25 单边样本不算配对收益；规则合规不等于真实修复', () => {
    const row = { task: 'flaky-timeout', sample: 0, variant: 'raw', action: 'grep', rule: { falseDone: 0, bump: 0, reEdit: 0, repeat: 0, next: 1, avoid: 1 } }
    let s = summarizeMinimal(PLAN, [row]); assert.equal(s.pairedMainResponses, 0); assert.equal(s.complete, false)
    s = summarizeMinimal(PLAN, [row, { ...row, variant: 'current' }]); assert.equal(s.pairedMainResponses, 2)
    assert.match(s.limitation, /不等于修复完成/)
  })
  await test('27 同步迟到也按墙钟拒绝，不等待 timeout 回调来作废', async () => {
    const m = mock(() => { const until = Date.now() + 20; while (Date.now() < until) {} return payload() })
    const chat = makeChat({ baseUrl: PLAN.baseUrl, apiKey: 'test', maxRetries: 0, fetchImpl: m.fetchImpl, timeoutMs: 5 })
    await assert.rejects(chat(body), /request-timeout/); assert.equal(m.requests.length, 1)
  })
  await test('26 真实 loopback 302 不跟随，不向第二 URL 转发凭据', async () => {
    let first = 0, second = 0
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions') { first++; res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/second` }); res.end() }
      else { second++; res.end('{}') }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const chat = makeChat({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'loopback-test-only', maxRetries: 0, timeoutMs: 2000 })
      await assert.rejects(chat(body), /request-network-error/); assert.equal(first, 1); assert.equal(second, 0)
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  })
} finally { fs.rmSync(HOME, { recursive: true, force: true }) }
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
