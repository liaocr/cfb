import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import * as I from '../index.js'
import * as M from '../state-memory.js'
import { createExactFlights } from '../exact-flights.js'
import { prepareJudgmentPrompt, buildJudgmentPrompt, transientEvidenceFrame } from '../evidence-ledger.js'
import { analyzeEfficiency } from '../tools/analyze-efficiency.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-efficiency-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = home
const credentialsPath = path.join(home, 'keys'); fs.writeFileSync(credentialsPath, 'LOCAL: unused\nOTHER: alternate')
const cfg = { ...I.DEFAULTS, enabled: true, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100, model: 'fixture', followHostModel: false, followHostProvider: false, credentialRef: 'LOCAL', credentialsPath, keepAlive: false, distillStream: true }
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(r => setImmediate(r))
async function bounded(p) { let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture deadline')), 3000) })]) } finally { clearTimeout(timer) } }
const good = '【关键判断与依据】\n参数 X 下测试失败，其他参数的适用性尚未确认。\n【未决差距】\n缺少其他参数的核验。'
function sse(res, text = good) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n') }
async function serverTest(fn, handler) {
  const requests = [], received = defer()
  const server = http.createServer((req, res) => { let body = ''; req.on('data', x => { body += x }); req.on('end', () => { requests.push(JSON.parse(body)); received.resolve(); (handler || ((q, r) => sse(r)))(req, res, requests.length) }) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try { await fn({ config: { ...cfg, baseUrl: 'http://127.0.0.1:' + server.address().port }, requests, received: received.promise }) }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
}
const frame = () => transientEvidenceFrame({ userAsks: [{ text: '只核验，不部署。' }], tools: [{ id: 't', name: 'test', seq: 2, resultSeq: 3, result: '参数 X 失败；不得部署是用户约束而不是测试失败。', status: 'failed', exitCode: 1 }], coverage: { cutoff: 3 } }, 'fixture')
const env = () => Object.freeze({ ...M.buildEvidenceEnvelope({ cot: '保留判断。', host: { blockIndex: 0 }, priorMemory: [{ text: '旧判断：A 可行，等待与新结果核对。' }] }), deterministicFrame: frame() })
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
try {
  await test('decision prompt retains correction scope, conflicts, prohibitions, prior inference and grounding', () => {
    const e = env(), p = buildJudgmentPrompt(e)
    for (const text of ['明确修正', '适用条件', '用户禁止与技术失败分开', '不得推广成永久不可行', '已有计划', '不虚构下一步', '未解决冲突', '旧判断：A 可行', e.deterministicFrame.evidenceInput.text, e.cot]) assert.ok(p.includes(text), text)
    assert.ok(p.indexOf('既有模型记忆') < p.indexOf('【宿主编译位置'))
    const b = buildJudgmentPrompt({ ...e, host: { blockIndex: 77 } })
    const at = p.indexOf('【宿主编译位置')
    assert.equal(p.slice(0, at), b.slice(0, at)); assert.notEqual(p, b)
  })
  await test('prepared prompt is serialized once and the same complete bytes go to HTTP', async () => {
    await serverTest(async ({ config, requests }) => {
      const e = env(); let reads = 0
      const f = { ...e.deterministicFrame, get userQuotes() { reads++; return ['只核验，不部署。'] } }
      const input = { ...e, deterministicFrame: f }, prepared = prepareJudgmentPrompt(input)
      const r = await I.generateStateMemory(input, config, null, { preparedJudgment: prepared })
      assert.equal(reads, 1); assert.equal(requests[0].messages[0].content, prepared.prompt)
      assert.equal(r.meta.promptBuildCount, 1); assert.ok(r.meta.parseRenderMs >= 0)
      assert.equal(r.meta.promptVersion, 'grounded-decisions-v3')
    })
  })
  await test('prepared artifacts cannot be applied to a different envelope', async () => {
    await serverTest(async ({ config, requests }) => {
      const a = env(), b = { ...a, cot: '不同证据截面的 reasoning' }
      await I.generateStateMemory(b, config, null, { preparedJudgment: prepareJudgmentPrompt(a) })
      assert.ok(requests[0].messages[0].content.includes(b.cot))
    })
  })
  await test('exact flights share only concurrent work and each consumer has independent top-level metadata', async () => {
    const f = createExactFlights(), gate = defer(); let calls = 0
    const run = () => f.run('exact', async () => { calls++; await gate.promise; return { text: 'ok', meta: { x: 1 } } })
    const a = run(), b = run(); gate.resolve()
    const [x, y] = await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(y.meta.sharedFlight, true)
    x.meta.x = 9; assert.equal(y.meta.x, 1); assert.equal(f.size, 0); assert.equal(f.bytes, 0)
    await run(); assert.equal(calls, 2)
  })
  await test('one cancellation detaches; final cancellation aborts and removes flight immediately', async () => {
    const f = createExactFlights(), a = new AbortController(), b = new AbortController(), started = defer()
    let transportSignal
    const execute = signal => { transportSignal = signal; started.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })) }
    const x = f.run('same', execute, { signal: a.signal }), y = f.run('same', execute, { signal: b.signal })
    const ex = assert.rejects(x, /cancelled/), ey = assert.rejects(y, /cancelled/)
    await started.promise; a.abort(); assert.equal(transportSignal.aborted, false); b.abort()
    assert.equal(transportSignal.aborted, true); assert.equal(f.size, 0)
    await Promise.all([ex, ey]); assert.equal(f.bytes, 0)
  })
  await test('unscoped/capacity bypass never queues or evicts active work; failures are not cached', async () => {
    const f = createExactFlights({ maxEntries: 1, maxBytes: 20 }), gate = defer(); let calls = 0
    const exec = async () => { calls++; await gate.promise; return { text: 'ok' } }
    const ps = [f.run('A', exec), f.run('B', exec), f.run(null, exec), f.run(null, exec), f.run('A', exec)]
    await tick(); assert.equal(calls, 4); assert.equal(f.size, 1)
    gate.resolve(); await Promise.all(ps); assert.equal(f.size, 0)
    await assert.rejects(f.run('A', () => { throw Error('failed') }), /failed/)
    assert.equal(f.size, 0); assert.equal((await f.run('A', exec)).text, 'ok')
  })
  await test('repeated detachments cannot create unbounded callbacks on one active flight', async () => {
    const f = createExactFlights(), gate = defer(), tags = []
    const exec = async () => { await gate.promise; return { text: 'ok' } }
    const opts = { trace: tag => tags.push(tag) }, owner = f.run('same', exec, opts)
    for (let n = 0; n < 128; n++) {
      const controller = new AbortController(), p = f.run('same', exec, { ...opts, signal: controller.signal })
      controller.abort(); await assert.rejects(p, /cancelled/)
    }
    assert.equal(tags.filter(t => t === 'compiler-flight-shared').length, 127)
    assert.equal(f.size, 1); gate.resolve(); await owner; assert.equal(f.size, 0)
  })
  await test('HTTP identity includes complete prompt, scope, endpoint credential and generation settings', async () => {
    const gate = defer()
    await serverTest(async ({ config, requests, received }) => {
      const flights = createExactFlights(), e = env(), runtime = { flights, scope: ['s', 'b', 3] }
      const cases = [
        [e, config, runtime], [e, config, runtime],
        [{ ...e, cot: 'different' }, config, runtime],
        [e, config, { ...runtime, scope: ['s', 'other', 3] }],
        [e, config, { ...runtime, scope: ['s', 'b', 4] }],
        [e, { ...config, maxOutputTokens: config.maxOutputTokens + 1 }, runtime],
        [e, { ...config, model: 'another' }, runtime],
        [e, { ...config, credentialRef: 'OTHER' }, runtime],
        [e, { ...config, baseUrl: config.baseUrl + '/alternate' }, runtime],
        [e, { ...config, timeoutMs: config.timeoutMs + 1 }, runtime],
        [e, { ...config, disableThinking: !config.disableThinking }, runtime],
        [e, config, { ...runtime, flights: createExactFlights() }],
        [e, config, { ...runtime, scope: null }],
      ]
      const ps = cases.map(([input, c, r]) => I.generateStateMemory(input, c, null, r))
      await received; gate.resolve(); const values = await Promise.all(ps)
      assert.equal(requests.length, cases.length - 1)
      assert.equal(values[0].meta.requestId, values[1].meta.requestId)
      assert.notEqual(values[0].entries[0].id, values[1].entries[0].id)
      assert.equal(flights.size, 0)
    }, async (req, res) => { await gate.promise; sse(res) })
  })
  await test('shared truncated outputs fail for every consumer and are never cached as success', async () => {
    await serverTest(async ({ config, requests }) => {
      const runtime = { flights: createExactFlights(), scope: ['s', 'b', 3] }, e = env()
      const a = I.generateStateMemory(e, config, null, runtime), b = I.generateStateMemory(e, config, null, runtime)
      await Promise.all([assert.rejects(a, /length/), assert.rejects(b, /length/)])
      assert.equal(requests.length, 1); assert.equal(runtime.flights.size, 0)
      await assert.rejects(I.generateStateMemory(e, config, null, runtime), /length/)
      assert.equal(requests.length, 2)
    }, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: good }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n') })
  })
  await test('archive terminal failure cancels only its consumer; same-flight healthy consumer completes', async () => {
    const response = defer(), archive = defer(), shared = defer(), traces = [], flights = createExactFlights()
    await serverTest(async ({ config, requests, received }) => {
      const trace = (tag, r) => { traces.push({ tag, ...r }); if (tag === 'compiler-flight-shared') shared.resolve() }
      const deps = { cfg: config, sessionId: 'archive-scope', trace,
        collectEvidence: () => ({ events: [], cutSeq: 3 }), buildEnvelope: M.buildEvidenceEnvelope,
        prepareEvidence: input => transientEvidenceFrame(input, 'fixture'),
        distill: (input, signal, runtime) => I.generateStateMemory(input, config, signal, { ...runtime, flights }) }
      const entry = { index: 0, text: '原始 reasoning 不能丢。'.repeat(100) }
      const a = I.birthStart(entry, { ...deps, archive: () => archive.promise })
      const b = I.birthStart(entry, { ...deps, archive: async () => 'confirmed' })
      await bounded(Promise.all([received, shared.promise])); archive.resolve(null)
      await bounded(a.diskP); assert.equal(a.abort.signal.aborted, true); assert.equal(b.abort.signal.aborted, false)
      response.resolve(); await bounded(Promise.all([a.distillP, b.distillP]))
      assert.equal(a.distillState.ok, false); assert.equal(b.distillState.ok, true); assert.equal(requests.length, 1)
      assert.equal((await I.birthFinish(a, deps)).text, entry.text)
      assert.equal((await I.birthFinish(b, deps)).why, 'condensed')
      assert.ok(traces.some(r => r.tag === 'compiler-consumer-unusable'))
      assert.equal(traces.filter(r => r.tag === 'compiler-transport-started').length, 1)
    }, async (req, res) => { await response.promise; sse(res) })
  })
  await test('content then stall keeps timeout failure and first-content timing; no finish shortcut', async () => {
    await serverTest(async ({ config }) => {
      await assert.rejects(I.generateStateMemory(env(), { ...config, timeoutMs: 250 }), e => {
        assert.match(e.message, /timeout/); assert.equal(typeof e.meta.toFirstContentMs, 'number'); assert.ok(e.meta.toFirstContentMs >= 0)
        assert.equal(typeof e.meta.afterContentMs, 'number'); assert.ok(e.meta.afterContentMs >= 0); assert.equal(e.meta.promptBuildCount, 1); assert.equal(typeof e.meta.totalMs, 'number'); return true
      })
    }, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: good }, finish_reason: 'stop' }] }) + '\n\n') })
  })
  await test('retry attempts have distinct IDs; shared logical tasks do not double-count provider usage', async () => {
    const rows = []
    await serverTest(async ({ config, requests }) => {
      const r = await I.generateStateMemory(env(), { ...config, disableThinking: true }, null, { trace: (tag, data) => rows.push({ tag, ...data }) })
      assert.equal(requests.length, 2)
      const starts = rows.filter(r => r.tag === 'compiler-transport-started')
      assert.equal(starts.length, 2); assert.notEqual(starts[0].requestId, starts[1].requestId)
      assert.equal(r.meta.requestId, starts[1].requestId)
    }, (req, res, n) => { if (n === 1) { res.writeHead(400); res.end('unsupported parameter thinking') } else sse(res) })
    const lines = [{ tag: 'BOOT', model: 'fixture' }, ...rows, { tag: 'birth-distill-settled', taskId: 'A', requestId: rows.at(-1).requestId, ok: true }, { tag: 'birth-distill-settled', taskId: 'B', requestId: rows.at(-1).requestId, ok: true }, { tag: 'memory-presented-in-options', taskId: 'B' }, { tag: 'BOOT', model: 'other' }]
    const report = analyzeEfficiency(lines.map(({ tag, ...r }) => `[time] [${tag}] ${JSON.stringify(r)}`).join('\n'))
    assert.equal(report.boots.length, 2); assert.equal(report.boots[0].requests.length, 2)
    assert.equal(report.boots[0].requests.filter(r => r.usage).length, 1)
    assert.equal(report.boots[0].requests[1].usage.cachedInputTokens, 30)
    assert.equal(report.boots[0].transportTimings.length, 2) // thinking-off retry is a different effective profile
    assert.equal(report.boots[1].requests.length, 0)
    assert.equal(report.boots[0].decisionReview[0].usedJudgmentEvidence, null)
    assert.equal(report.billingSavings, null); assert.equal(report.productAcceptance, '未验收')
    if (process.env.CFB_V9_EVIDENCE_DIR) { fs.mkdirSync(process.env.CFB_V9_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CFB_V9_EVIDENCE_DIR, 'synthetic-efficiency.json'), JSON.stringify({ ...report, fixtureOnly: true }, null, 2) + '\n') }
  })
  await test('default production hooks enable sharing without a switch and emit preparation/transport traces', async () => {
    const response = defer()
    await serverTest(async ({ config, requests }) => {
      const hooks = new Map(), traceFile = path.join(home, 'hooks.log')
      I.apply({ on: (name, fn) => hooks.set(name, fn), get: key => key === 'cmbStore' ? { putText: async () => ({ handle: 'art://confirmed' }) } : null }, { ...config, trace: true, traceFile })
      const session = { id: 'production-sharing', surface: { nodes: [1] }, eventAt: () => ({ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '核验，不部署' }] } } }), requestContext: () => ({ contextWindow: 100000 }) }
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      const raw = '尚未确认，需要保留原判断。'.repeat(100)
      const chunks = [{ type: 'block-start', blockType: 'reasoning', index: 0 }, { type: 'reasoning-delta', index: 0, text: raw }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }, { type: 'finish', reason: { kind: 'end' } }]
      const outputs = await Promise.all(Array.from({ length: 3 }, async () => {
        const out = []; for await (const c of hooks.get('llm/stream')({ messages: [] }, () => (async function* () { yield* chunks })())) out.push(c)
        assert.equal(out.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), raw)
      }))
      assert.equal(outputs.length, 3)
      // First ledger revision has a new-observation delta; subsequent identical
      // views may share. Exact matching must not ignore that first difference.
      const done = defer(); let watcher, timer
      const check = () => { const t = fs.readFileSync(traceFile, 'utf8'); if ((t.match(/\[birth-distill-settled\]/g) || []).length === 3) done.resolve() }
      watcher = fs.watch(traceFile, check); response.resolve()
      try { await bounded(done.promise) } finally { watcher.close(); clearTimeout(timer) }
      const text = fs.readFileSync(traceFile, 'utf8'), report = analyzeEfficiency(text)
      assert.equal(requests.length, 2)
      assert.ok(text.includes('[compiler-flight-shared]')); assert.ok(text.includes('[compiler-preparation-cost]'))
      assert.ok(text.includes('"promptBuildCount":1'))
      assert.equal(report.boots.at(-1).counts.transportAttemptsStarted, 2)
      assert.equal(report.boots.at(-1).tasks.filter(t => t.ok).length, 3)
      if (process.env.CFB_V9_EVIDENCE_DIR) {
        fs.writeFileSync(path.join(process.env.CFB_V9_EVIDENCE_DIR, 'production-hook-fixture.json'), JSON.stringify({ ...report, fixtureOnly: true }, null, 2) + '\n')
        fs.copyFileSync(traceFile, path.join(process.env.CFB_V9_EVIDENCE_DIR, 'production-hook-fixture.trace.txt'))
        fs.writeFileSync(path.join(process.env.CFB_V9_EVIDENCE_DIR, 'http-request-fixture.json'), JSON.stringify({ fixtureOnly: true, requests }, null, 2) + '\n')
      }
    }, async (req, res) => { await response.promise; sse(res) })
  })
} finally {
  if (previous == null) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
