import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createCompileLanes } from './compile-lane.js'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-incremental-'))
const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home
const I = await import('./index.js'), M = await import('./state-memory.js'), S = await import('./snapshot-store.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const entry = text => ({ id: text, category: 'state', content: text, origin: 'model', evidence: 'inferred', validity: 'active' })
const result = { text: '状态已记录，结果保留。', entries: [entry('记录')], checkpointText: '【当前有效状态】\n状态已记录' }
function evidence(n = 30, len = 800) {
  const events = []
  for (let i = 0; i < n; i++) {
    // Distinct bodies, no artificial repeated-line cleaning win.
    const text = Array.from({ length: len }, (_, j) => String.fromCharCode(0x4e00 + ((j * 31 + i * 77) % 900))).join('')
    events.push({ seq: i * 2 + 1, type: 'assistant/message', toolCalls: [{ id: 'tc' + i, name: 'read', args: 'file' + i }] })
    events.push({ seq: i * 2 + 2, type: 'tool/result', toolCallId: 'tc' + i, text, isError: false })
  }
  return { events, inFlightIds: new Set(), cutSeq: n * 2 }
}
function start(id, index, { distill = async () => result, archive = async () => 'handle', data = evidence(), cfg = {}, traces = [] } = {}) {
  return I.birthStart({ index, text: ('原始推理' + index).repeat(220) }, {
    sessionId: id, branchId: 'main',
    cfg: { stateMemory: true, stateCompileQueue: true, timeoutMs: 1000, birthMinChars: 20, ...cfg },
    archive, buildEnvelope: M.buildEvidenceEnvelope, collectEvidence: () => data, distill,
    trace: (tag, data) => traces.push({ tag, data }),
  })
}
const tools = Array.from({ length: 20 }, (_, i) => ({ id: 't' + i, status: 'completed', result: String(i).padStart(3, '0') + '证据'.repeat(100), resultSeq: i + 1 }))
const env = () => M.buildEvidenceEnvelope({ cot: '保持时间截面', at: 42, tools, userAsks: [{ text: '不可修改配置' }], runtimeFacts: [{ text: '运行态' }] })
const snap = () => ({ ...S.emptySnapshot('s', 'main'), revision: 1, sourceCutSeq: 20, entries: [entry('结果保留')], coverage: { coveredSeqs: tools.map(t => t.resultSeq) } })
let server
try {
  await test('lane keeps only latest pending opportunity, never evicts active', async () => {
    const q = createCompileLanes(), a = q.reserve('s'); await a.ready
    const b = q.reserve('s'), failed = b.ready.catch(e => e.message), c = q.reserve('s')
    assert.equal(await failed, 'compile-queue-superseded')
    let running = false; c.ready.then(() => { running = true }); await tick(); assert.equal(running, false)
    a.release(); await c.ready; c.release(); assert.equal(q.size, 0)
  })
  await test('different branches can run concurrently', async () => {
    const q = createCompileLanes(), a = q.reserve('[s,a]'), b = q.reserve('[s,b]')
    await Promise.all([a.ready, b.ready]); assert.equal(q.size, 2); a.release(); b.release(); assert.equal(q.size, 0)
  })
  await test('pending cancellation removes ticket and releases listener', async () => {
    const q = createCompileLanes(), a = q.reserve('s'), ac = new AbortController()
    const b = q.reserve('s', { signal: ac.signal }), error = b.ready.catch(e => e.message)
    ac.abort(); assert.equal(await error, 'compile-queue-cancelled'); a.release(); assert.equal(q.size, 0)
  })
  await test('pending timeout cannot launch a late model request', async () => {
    const q = createCompileLanes(), a = q.reserve('s')
    const b = q.reserve('s', { deadline: Date.now() + 15 })
    await assert.rejects(b.ready, /expired/); a.release(); assert.equal(q.size, 0)
  })
  await test('global lane capacity rejects rather than silently bypassing bound', async () => {
    const q = createCompileLanes({ maxKeys: 1 }), a = q.reserve('a'), b = q.reserve('b')
    await assert.rejects(b.ready, /capacity/); a.release(); assert.equal(q.size, 0)
  })
  await test('release is idempotent and cannot release a newer owner', async () => {
    const q = createCompileLanes(), a = q.reserve('s'), b = q.reserve('s')
    a.release(); await b.ready; a.release(); assert.equal(q.size, 1); b.release(); assert.equal(q.size, 0)
  })
  await test('long branch identities do not collapse at character 120', () => {
    const a = S.normalizeBranchId({ branchId: 'x'.repeat(120) + 'A' })
    const b = S.normalizeBranchId({ branchId: 'x'.repeat(120) + 'B' })
    assert.notEqual(a, b); assert.notEqual(S.snapshotPath('s', a), S.snapshotPath('s', b))
  })
  await test('rebase removes only covered old tools and retains tail eight', () => {
    const old = env(), next = I.rebaseCompileEnvelope(old, snap(), 20)
    assert.equal(next.tools.length, 8); assert.equal(old.tools.length, 20)
    assert.equal(next.cot, old.cot); assert.equal(next.at, 42)
    assert.deepEqual(next.userAsks, old.userAsks); assert.deepEqual(next.runtimeFacts, old.runtimeFacts)
    assert.match(next.stateSnapshot.text, /结果保留/)
  })
  await test('rebase never reads a later evidence cut', () => {
    const old = env(); assert.equal(I.rebaseCompileEnvelope(old, snap(), 19), old)
    const s = snap(); s.sourceCutSeq = 21; assert.equal(I.rebaseCompileEnvelope(old, s, 20), old)
  })
  await test('rebase rejects unknown cut and oversize snapshot', () => {
    const old = env(); assert.equal(I.rebaseCompileEnvelope(old, snap(), null), old)
    const s = snap(); s.entries = [entry('x'.repeat(14000))]; assert.equal(I.rebaseCompileEnvelope(old, s, 20), old)
  })
  await test('rebase rejects future covered seq even when sourceCut lies', () => {
    const old = env(), s = snap(); s.coverage.coveredSeqs.push(99)
    assert.equal(I.rebaseCompileEnvelope(old, s, 20), old)
  })
  await test('rebase no-op if new memory costs more than omitted evidence', () => {
    const old = M.buildEvidenceEnvelope({ tools: tools.map(t => ({ ...t, result: 'x' })) }), s = snap()
    s.entries = [entry('很长状态'.repeat(1000))]
    assert.equal(I.rebaseCompileEnvelope(old, s, 20), old)
  })
  await test('legacy snapshot cannot authorize incremental rebase', () => {
    const old = env(), s = snap(); s.memoryPolicyVersion = 2
    assert.equal(I.rebaseCompileEnvelope(old, s, 20), old)
  })
  await test('tool result sequence survives envelope construction', () => assert.equal(env().tools[0].resultSeq, 1))
  await test('frozen envelope cannot be modified by queued producer', () => {
    const e = env(); assert.throws(() => { e.tools[0].result = 'future' }, TypeError)
    assert.throws(() => e.userAsks.push({ text: 'future' }), TypeError)
    assert.throws(() => { e.host.step = 9 }, TypeError)
  })
  await test('truncated, pending and invalid-seq results never acquire coverage', () => {
    const e = M.buildEvidenceEnvelope({ tools: [
      { status: 'completed', result: 'x'.repeat(1201), resultSeq: 1 },
      { status: 'requested', resultSeq: 2 },
      { status: 'failed', result: 'ERROR', resultSeq: 3 },
      { status: 'completed', result: 'OK', resultSeq: -1 },
      { status: 'running', result: 'partial', resultSeq: 4 },
    ] })
    assert.deepEqual(I.fullyVisibleResultSeqs(e.tools), [3])
  })
  await test('production commit does not cover the unseen tail of long results', async () => {
    const t = start('truncated', 0, { data: evidence(12, 1800) }); assert.equal((await t.distillP).ok, true)
    assert.deepEqual(S.loadSnapshot('truncated', 'main').coverage.coveredSeqs, [])
  })
  await test('policy-2 migration revokes formerly truncated whole-result coverage', () => {
    const s = snap(); s.memoryPolicyVersion = 2
    const migrated = S.validateSnapshot(s).snapshot
    assert.equal(migrated.memoryPolicyVersion, 3); assert.deepEqual(migrated.coverage.coveredSeqs, [])
    assert.equal(migrated.entries[0].content, s.entries[0].content)
  })
  await test('latest pending compiles after prior commit with smaller input', async () => {
    const gate = deferred(), entered = deferred(), inputs = [], traces = []
    const distill = async e => { inputs.push(e); if (inputs.length === 1) { entered.resolve(); await gate.promise }; return result }
    const a = start('burst', 0, { distill, traces }); await entered.promise
    const b = start('burst', 1, { distill, traces }), c = start('burst', 2, { distill, traces })
    assert.equal((await b.distillP).ok, false); assert.equal(b.distillState.error, 'compile-queue-superseded')
    gate.resolve(); await Promise.all([a.distillP, c.distillP])
    assert.equal(inputs.length, 2); assert.equal(inputs[0].tools.length, 30); assert.equal(inputs[1].tools.length, 8)
    assert.equal(S.loadSnapshot('burst', 'main').revision, 2)
    assert.ok(traces.some(x => x.tag === 'state-queue-dispatched' && x.data.afterChars < x.data.beforeChars))
  })
  await test('lane ownership includes archive completion and snapshot commit', async () => {
    const gate = deferred(), entered = deferred(), inputs = []
    const distill = async e => { inputs.push(e); entered.resolve(); return result }
    const a = start('archive-barrier', 0, { distill, archive: async () => { await gate.promise; return 'h' } })
    await entered.promise
    const b = start('archive-barrier', 1, { distill }); await tick()
    assert.equal(inputs.length, 1); assert.equal(S.loadSnapshot('archive-barrier', 'main'), null)
    gate.resolve(); await Promise.all([a.distillP, b.distillP]); assert.equal(inputs[1].tools.length, 8)
  })
  await test('different production sessions do not block or coalesce each other', async () => {
    const gate = deferred(), inputs = []
    const distill = async e => { inputs.push(e); await gate.promise; return result }
    const a = start('parallel-A', 0, { distill }), b = start('parallel-B', 1, { distill })
    await tick(); assert.equal(inputs.length, 2); gate.resolve(); await Promise.all([a.distillP, b.distillP])
  })
  for (const reason of ['model', 'archive', 'snapshot-lock']) {
    await test(`${reason} failure leaves next dispatch evidence unfiltered`, async () => {
      const sid = 'failed-' + reason, gate = deferred(), entered = deferred(), inputs = []
      const distill = async e => { inputs.push(e); if (inputs.length === 1) {
        entered.resolve(); await gate.promise; if (reason === 'model') throw Error('model-failed')
      }; return result }
      let lock
      if (reason === 'snapshot-lock') { lock = S.snapshotPath(sid, 'main') + '.lock'; fs.writeFileSync(lock, 'busy') }
      const a = start(sid, 0, { distill, archive: async () => reason === 'archive' ? null : 'handle' }); await entered.promise
      const b = start(sid, 1, { distill }); gate.resolve()
      await Promise.all([a.distillP, b.distillP]); assert.equal(inputs[1].tools.length, 30)
      if (lock) fs.unlinkSync(lock)
    })
  }
  await test('disabled experimental flag preserves concurrent baseline dispatch', async () => {
    const gate = deferred(), inputs = []
    const distill = async e => { inputs.push(e); await gate.promise; return result }
    const a = start('off', 0, { distill, cfg: { stateCompileQueue: false } }), b = start('off', 1, { distill, cfg: { stateCompileQueue: false } })
    await tick(); assert.equal(inputs.length, 2); gate.resolve(); await Promise.all([a.distillP, b.distillP])
  })
  await test('expired queued task spends zero model calls and keeps original reasoning', async () => {
    const gate = deferred(), entered = deferred(); let calls = 0
    const distill = async () => { calls++; entered.resolve(); await gate.promise; return result }
    const a = start('expiry', 0, { distill }); await entered.promise
    const b = start('expiry', 1, { distill, cfg: { timeoutMs: 20 } })
    assert.equal((await b.distillP).ok, false); assert.equal(calls, 1)
    const r = await I.birthFinish(b, { cfg: { birthFinishWaitMs: 1, birthHandleInText: false } })
    assert.equal(r.text, b.raw); gate.resolve(); await a.distillP
  })
  await test('production baseline snapshot from the future is not injected', async () => {
    const s = snap(); s.sessionId = 'future'; s.sourceCutSeq = 1000
    fs.writeFileSync(S.snapshotPath('future', 'main'), JSON.stringify(s))
    let seen
    await start('future', 0, { distill: async e => { seen = e; return result } }).distillP
    assert.equal(seen.stateSnapshot, null); assert.equal(seen.tools.length, 30)
  })
  await test('queue does not recollect events that arrived after enqueue', async () => {
    const gate = deferred(), entered = deferred(), inputs = [], data = evidence()
    const distill = async e => { inputs.push(e); if (inputs.length === 1) { entered.resolve(); await gate.promise }; return result }
    const a = start('cut', 0, { distill, data }); await entered.promise
    const b = start('cut', 1, { distill, data })
    data.events.push({ seq: 100, type: 'tool/result', toolCallId: 'future', text: 'FUTURE_SECRET' })
    gate.resolve(); await Promise.all([a.distillP, b.distillP])
    assert.doesNotMatch(M.buildStateCompilePrompt(inputs[1]), /FUTURE_SECRET/)
  })
  await test('actual HTTP burst benchmark: fewer calls and prompt characters, not tokens', async () => {
    let requests, first, release
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c }); req.on('end', async () => {
        const parsed = JSON.parse(body); requests.push(parsed.messages[0].content)
        if (requests.length === 1) { first.resolve(); await release.promise }
        const content = '【当前有效状态】\n证据包已记录。\n【未决差距】\n最终运行结果未确认。'
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n' +
            'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }))
        }
      })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const credentialsPath = path.join(home, 'keys.yaml'); fs.writeFileSync(credentialsPath, 'TEST_KEY: local-only\n')
    const cfg = { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'test', credentialsPath,
      credentialRef: 'TEST_KEY', settingsPath: path.join(home, 'none'), maxAttempts: 1, timeoutMs: 3000,
      keepAlive: false, disableThinking: false, distillStream: false, stateMemory: true }
    const metrics = []
    for (const streaming of [false, true]) for (const enabled of [false, true]) {
      cfg.distillStream = streaming
      requests = []; first = deferred(); release = deferred()
      const distill = (env, signal, budget) => I.generateStateMemory(env, { ...cfg, ...budget }, signal)
      const sid = 'http-' + streaming + '-' + enabled
      const a = start(sid, 0, { distill, cfg: { ...cfg, stateCompileQueue: enabled } }); await first.promise
      const b = start(sid, 1, { distill, cfg: { ...cfg, stateCompileQueue: enabled } })
      const c = start(sid, 2, { distill, cfg: { ...cfg, stateCompileQueue: enabled } })
      // Ensure baseline B/C captured their inputs before A can commit.
      await tick(); await tick(); release.resolve()
      await Promise.all([a.distillP, b.distillP, c.distillP])
      metrics.push({ streaming, enabled, requests: requests.length, promptChars: requests.map(s => s.length), totalPromptChars: requests.reduce((n, s) => n + s.length, 0) })
    }
    assert.equal(metrics[0].requests, 3); assert.equal(metrics[1].requests, 2)
    assert.ok(metrics[1].promptChars[1] < metrics[1].promptChars[0])
    assert.ok(metrics[1].totalPromptChars < metrics[0].totalPromptChars)
    assert.equal(metrics[2].requests, 3); assert.equal(metrics[3].requests, 2)
    assert.equal(metrics[3].totalPromptChars, metrics[1].totalPromptChars)
    console.log('BENCHMARK ' + JSON.stringify(metrics))
  })
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); process.exitCode = fail ? 1 : 0
