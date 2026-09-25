// ★★ v11.11 协议与校准：OpenAI Responses 风格端点的端到端测试 + token 估算校准链路 ★★
//
// 为什么单开：provider 配成 `api: openai-responses` 时，请求体、完成判据、产物抽取全是另一套
//   （input / max_output_tokens / reasoning.effort；status=completed|incomplete；output[].content[]）。
//   v11.10 之前只有 URL 拼接有测试，解析与完成判据**一条都没有** —— 用户的 provider 若是这种接口，
//   跑的就是从未被执行过的代码。
// 判据：半成品绝不冒充成功（incomplete / failed / 缺 completed ⇒ 抛错 ⇒ 上层原文放行）；
//   reasoning 产物不混进摘要；参数被拒时按既有路径降级重试。全部走本机 HTTP，零外网。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { generateDistillation, makeBirthCompiler } from '../src/distill.js'
import { settledTraceData } from '../src/trace.js'
import { createTraceAudit, fitTokenModel } from '../tools/analyze-trace.mjs'
import { scriptCounts } from '../src/tokens.js'
import { clearProviderCache } from '../src/provider.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-protocol-'))
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }

let handler = null
const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (x) => { body += x })
  req.on('end', () => {
    let j = null; try { j = JSON.parse(body) } catch { /* keep null */ }
    requests.push({ url: req.url, body: j })
    handler(req, res, j, requests.length)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

const settingsPath = path.join(home, 'settings.yaml')
fs.writeFileSync(settingsPath, ['llm-pi-ai:', '  providers:', '    resp:', '      apiKeyEnv: RESP_KEY', '      api: openai-responses',
  '      baseURL: ' + base + '/v1', '    chat:', '      apiKeyEnv: RESP_KEY', '      api: openai-completions', '      baseURL: ' + base + '/v1', ''].join('\n'))
const credentialsPath = path.join(home, 'keys'); fs.writeFileSync(credentialsPath, 'RESP_KEY: k-test\n')
clearProviderCache()
const cfgOf = (over = {}) => ({ model: 'm', followProvider: 'resp', settingsPath, credentialsPath, maxAttempts: 1, timeoutMs: 3000,
  maxOutputTokens: 400, disableThinking: false, keepAlive: false, ...over })
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n') }
const reject = async (p) => { try { await p } catch (e) { return e } throw new Error('expected rejection') }
const COT = 'Step by step: verify the parameters, then the boundary conditions. '.repeat(10)

try {
  // ═══ §1 非流式 Responses ═══════════════════════════════════════════════════
  await test('§1a completed ⇒ 只取 output_text，reasoning 产物不混入；请求体是 Responses 形状', async () => {
    requests.length = 0
    handler = (q, r) => json(r, { status: 'completed', output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hidden-thinking' }] },
      { type: 'message', content: [{ type: 'output_text', text: '【摘要】参数已核验。' }] },
    ], usage: { input_tokens: 120, output_tokens: 9 } })
    const r = await generateDistillation(COT, cfgOf())
    assert.equal(r.text, '【摘要】参数已核验。')
    assert.equal(r.meta.style, 'responses')
    assert.equal(r.meta.reasoningChars, 'hidden-thinking'.length)
    assert.deepEqual(r.meta.providerReportedUsage, { input_tokens: 120, output_tokens: 9 })
    const q = requests[0]
    assert.equal(q.url, '/v1/responses')
    assert.equal(typeof q.body.input, 'string'); assert.equal(q.body.max_output_tokens, 400)
    assert.equal('messages' in q.body, false); assert.equal('max_tokens' in q.body, false)
  })
  await test('§1b status=incomplete（max_output_tokens）⇒ 抛错，半成品绝不冒充成功', async () => {
    handler = (q, r) => json(r, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '【摘要】参数已' }] }] })
    const e = await reject(generateDistillation(COT, cfgOf()))
    assert.match(e.message, /incomplete distillate \(finish=incomplete/)
  })
  await test('§1c status=failed + error ⇒ 抛错', async () => {
    handler = (q, r) => json(r, { status: 'failed', error: { message: 'server_error' }, output: [] })
    const e = await reject(generateDistillation(COT, cfgOf()))
    assert.match(e.message, /empty distillate \(finish=failed/)
  })
  await test('§1d 只有顶层 output_text（简化形状）⇒ 兜底取用', async () => {
    handler = (q, r) => json(r, { status: 'completed', output: [], output_text: '【摘要】兜底。' })
    assert.equal((await generateDistillation(COT, cfgOf())).text, '【摘要】兜底。')
  })
  await test('§1e 缺 status（无完成证据）⇒ 抛错', async () => {
    handler = (q, r) => json(r, { output: [{ type: 'message', content: [{ type: 'output_text', text: '看似完整' }] }] })
    const e = await reject(generateDistillation(COT, cfgOf()))
    assert.match(e.message, /finish=missing/)
  })
  await test('§1f disableThinking ⇒ 先带 reasoning.effort=none；被 400 拒 ⇒ 裸试成功（既有降级路径）', async () => {
    requests.length = 0
    handler = (q, r, body) => (body && body.reasoning
      ? json(r, { error: { message: 'Unsupported value: reasoning.effort' } }, 400)
      : json(r, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '【摘要】降级成功。' }] }] }))
    const r = await generateDistillation(COT, cfgOf({ disableThinking: true }))
    assert.equal(r.text, '【摘要】降级成功。')
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0].body.reasoning, { effort: 'none' })
    assert.equal('reasoning' in requests[1].body, false)
    assert.equal('thinking' in requests[0].body, false, 'Responses 风格不许带 chat 的 thinking 字段')
  })
  await test('§1g 非流式请求却收到 SSE（协议错配）⇒ 按实际协议解析 Responses 事件', async () => {
    handler = (q, r) => sse(r, [
      { type: 'response.reasoning_text.delta', delta: 'think' },
      { type: 'response.output_text.delta', delta: '【摘要】' }, { type: 'response.output_text.delta', delta: '错配也能读。' },
      { type: 'response.completed' },
    ])
    const r = await generateDistillation(COT, cfgOf())
    assert.equal(r.text, '【摘要】错配也能读。')
  })
  await test('§1h 协议错配 + response.incomplete ⇒ 抛错', async () => {
    handler = (q, r) => sse(r, [{ type: 'response.output_text.delta', delta: '【摘要】半' }, { type: 'response.incomplete' }])
    await reject(generateDistillation(COT, cfgOf()))
  })

  // ═══ §2 流式 Responses（distillStream:true）═════════════════════════════════
  await test('§2a 流式：delta 拼接 + response.completed ⇒ 成功，stream:true 进请求体', async () => {
    requests.length = 0
    handler = (q, r) => sse(r, [{ type: 'response.output_text.delta', delta: '【摘要】' }, { type: 'response.output_text.delta', delta: '流式。' }, { type: 'response.completed' }])
    const r = await generateDistillation(COT, cfgOf({ distillStream: true }))
    assert.equal(r.text, '【摘要】流式。')
    assert.equal(requests[0].body.stream, true); assert.equal(typeof requests[0].body.input, 'string')
  })
  await test('§2b 流式：response.incomplete ⇒ 抛错（被截断的摘要不是摘要）', async () => {
    handler = (q, r) => sse(r, [{ type: 'response.output_text.delta', delta: '【摘要】截' }, { type: 'response.incomplete' }])
    await reject(generateDistillation(COT, cfgOf({ distillStream: true })))
  })
  await test('§2c 流式：没有完成事件就断开 ⇒ 抛错', async () => {
    handler = (q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.end('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '半截' }) + '\n\n') }
    await reject(generateDistillation(COT, cfgOf({ distillStream: true })))
  })

  // ═══ §3 token 估算校准链路 ═════════════════════════════════════════════════
  await test('§3a makeBirthCompiler(compress) 成功结果带 prompt/output 书写系统字符数，且进 settled trace 白名单', async () => {
    handler = (q, r) => json(r, { choices: [{ message: { content: '【摘要】核验完成 OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 12 } })
    const compile = makeBirthCompiler(cfgOf({ followProvider: 'chat', mode: 'birth', stateCompress: true, compileMode: 'compress', compressPrompt: 'v3' }))
    const r = await compile(COT, undefined, {})
    const exp = scriptCounts(r.text)
    assert.equal(r.meta.outputWideChars, exp.wide); assert.equal(r.meta.outputOtherChars, exp.other)
    assert.ok(r.meta.promptWideChars > 0 && r.meta.promptOtherChars > COT.length * 0.9, '提示词 = 中文规则 + 英文原文')
    assert.equal(r.meta.promptWideChars + r.meta.promptOtherChars, r.meta.promptChars)
    const row = settledTraceData(0, 100, { ok: true, text: r.text, meta: r.meta })
    for (const k of ['promptWideChars', 'promptOtherChars', 'outputWideChars', 'outputOtherChars']) assert.equal(row[k], r.meta[k], k + ' 必须落盘')
    assert.deepEqual(row.providerReportedUsage, { prompt_tokens: 300, completion_tokens: 12 })
    assert.equal(JSON.stringify(row).includes('核验完成'), false, '校准字段只有数量，不含内容')
  })
  await test('§3b legacy 模式同样记录；memory 模式不记（提示词在内部拼装，拿不到全文 —— 不猜）', async () => {
    handler = (q, r) => json(r, { choices: [{ message: { content: '摘要' }, finish_reason: 'stop' }] })
    const r = await makeBirthCompiler(cfgOf({ followProvider: 'chat', compileMode: 'legacy' }))(COT, undefined, {})
    assert.ok(Number.isFinite(r.meta.promptWideChars))
  })
  await test('§3c analyze-trace tokenCalibration：从 settled 行回归出真实系数（含截距），与现行 0.6/0.3 对照', () => {
    const a = createTraceAudit()
    a.add('[2026-09-24T00:00:00.000Z] [BOOT] {"selfId":"cal"}')
    // 真实分词器（假设）：中文 0.52、其他 0.26、每请求模板开销 11
    for (let i = 0; i < 12; i++) {
      const w = 400 + i * 45, o = 900 + ((i * 131) % 700), ow = 150 + i * 7, oo = 20 + ((i * 37) % 50)
      const usage = { prompt_tokens: Math.round(w * 0.52 + o * 0.26 + 11), completion_tokens: Math.round(ow * 0.52 + oo * 0.26) + 5,
        completion_tokens_details: { reasoning_tokens: 5 } }
      a.add('[2026-09-24T00:00:01.000Z] [birth-distill-settled] ' + JSON.stringify({ taskId: 't' + i, ok: true, ms: 900,
        promptWideChars: w, promptOtherChars: o, outputWideChars: ow, outputOtherChars: oo, providerReportedUsage: usage }))
    }
    a.add('[2026-09-24T00:00:02.000Z] [birth-distill-settled] ' + JSON.stringify({ taskId: 'bad', ok: false, ms: 900, promptWideChars: 1, promptOtherChars: 1, providerReportedUsage: { prompt_tokens: 999 } }))
    const cal = a.result().groups[0].tokenCalibration
    assert.equal(cal.prompt.n, 12, '失败的调用不进样本')
    assert.ok(Math.abs(cal.prompt.fit.wide - 0.52) < 0.01 && Math.abs(cal.prompt.fit.other - 0.26) < 0.01, JSON.stringify(cal.prompt.fit))
    assert.ok(Math.abs(cal.prompt.fit.intercept - 11) < 2)
    assert.ok(cal.prompt.fitMape < cal.prompt.currentMape)
    assert.ok(cal.prompt.estimateOverActual > 1, '现行系数高估了这个分词器')
    assert.ok(Math.abs(cal.output.fit.wide - 0.52) < 0.02, '思考 token 已从产物里扣除：' + JSON.stringify(cal.output.fit))
    assert.deepEqual(cal.current, { wide: 0.6, other: 0.3, intercept: 0 })
  })
  await test('§3d fitTokenModel 退化保护：样本不足 / 单一书写系统 / 共线', () => {
    assert.equal(fitTokenModel([[1, 1, 1]]).fit, null)
    const latin = Array.from({ length: 6 }, (_, i) => [0, 100 + i * 50, Math.round((100 + i * 50) * 0.25 + 4)])
    const f = fitTokenModel(latin)
    assert.equal(f.fit.wide, null, '没有中文样本 ⇒ 不给中文系数（不猜）')
    assert.ok(Math.abs(f.fit.other - 0.25) < 0.01)
    assert.equal(fitTokenModel(Array.from({ length: 5 }, () => [10, 10, 9])).fit, null)
    assert.equal(fitTokenModel([]).n, 0)
  })
} finally {
  server.closeAllConnections(); await new Promise((r) => server.close(r))
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
