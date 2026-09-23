import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { selectEvidenceViews } from './evidence-views.js'
import { createTraceAudit } from './deploy/analyze-trace.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-views-')), oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('./index.js'), M = await import('./state-memory.js'), S = await import('./snapshot-store.js')
const { emitCheckpoint } = await import('./emitter.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const tick = () => new Promise(r => setImmediate(r))
const hash = s => crypto.createHash('sha256').update(s).digest('hex')
const ent = (text = '记录') => ({ id: text, category: 'state', content: text, evidence: 'inferred', origin: 'model', validity: 'active' })
const result = { text: '【当前有效状态】\n已记录本轮可见内容。', entries: [ent()], checkpointText: '本轮记录' }
const tool = (extra = {}) => ({ id: 'c', name: 'read', args: '{}', resultSeq: 2, status: 'completed', result: 'HEAD'.repeat(150) + 'MIDDLE'.repeat(100) + 'TAIL'.repeat(150), ...extra })
const receipts = view => view.tools.filter(t => t.viewReceipt).map(t => t.viewReceipt)
function data(n = 28, len = 3299) {
  const events = []
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: len }, (_, j) => String.fromCharCode(0x4e00 + (i * 19 + j * 13) % 2000)).join('')
    events.push({ seq: 2 * i + 1, type: 'assistant/message', toolCalls: [{ id: 'c' + i, name: 'read', args: 'file' + i }] })
    events.push({ seq: 2 * i + 2, type: 'tool/result', toolCallId: 'c' + i, text })
  }
  return { events, inFlightIds: new Set(), cutSeq: n * 2 }
}
function start(sid, { distill = async () => result, archive = async () => 'h', cfg = {}, mirrorSnapshot, source = data(), traces = [] } = {}) {
  return I.birthStart({ index: 0, text: '原始推理'.repeat(300) }, { sessionId: sid, branchId: 'main',
    cfg: { stateMemory: true, stateEvidenceViews: true, stateSnapshotMirror: true, timeoutMs: 1000, ...cfg },
    distill, archive, mirrorSnapshot, buildEnvelope: M.buildEvidenceEnvelope, collectEvidence: () => source,
    trace: (tag, v) => traces.push({ tag, ...v }),
  })
}
let server
try {
  await test('one long result progresses head, tail, interior without new model calls', () => {
    let known = [], seen = []
    for (let i = 0; i < 3; i++) { const v = selectEvidenceViews([tool()], known); seen.push(v.tools[0].result); known.push(...receipts(v)) }
    assert.deepEqual(seen, ['HEAD'.repeat(150), 'TAIL'.repeat(150), 'MIDDLE'.repeat(100)])
    assert.equal(selectEvidenceViews([tool()], known).tools[0].result, null)
  })
  await test('changed unseen suffix invalidates old prefix receipt', () => {
    const a = selectEvidenceViews([tool()]); const b = selectEvidenceViews([tool({ result: tool().result.slice(0, -1) + '!' })], receipts(a))
    assert.equal(b.tools[0].result, a.tools[0].result); assert.notEqual(b.tools[0].viewReceipt, a.tools[0].viewReceipt)
  })
  await test('event identity, args, status and error flag are part of receipt identity', () => {
    const a = selectEvidenceViews([tool()]); for (const extra of [{ resultSeq: 4 }, { args: 'different' }, { status: 'failed' }, { isError: true }])
      assert.notEqual(selectEvidenceViews([tool(extra)], receipts(a)).tools[0].viewReceipt, a.tools[0].viewReceipt)
  })
  await test('already truncated source cannot mint a complete-source receipt', () => assert.equal(selectEvidenceViews([tool({ resultTruncated: true })]).tools[0].viewReceipt, null))
  await test('missing result identity cannot authorize future omission', () => assert.equal(selectEvidenceViews([tool({ resultSeq: null })]).tools[0].viewReceipt, null))
  await test('surrogate pairs are not split at view boundaries', () => {
    const raw = 'a'.repeat(599) + '😀' + 'z'.repeat(20)
    const v = selectEvidenceViews([tool({ result: raw })]); assert.equal(v.tools[0].result, 'a'.repeat(599))
    const next = selectEvidenceViews([tool({ result: raw })], receipts(v)); assert.ok(next.tools[0].result.startsWith('😀'))
  })
  await test('body budget is enforced while all tool metadata remains present', () => {
    const v = selectEvidenceViews(Array.from({ length: 28 }, (_, i) => tool({ id: 'c' + i, resultSeq: i + 1 })), [], { budget: 1800 })
    assert.equal(v.stats.bodyChars, 1800); assert.equal(v.tools.length, 28); assert.equal(v.stats.deferred, 25)
    assert.ok(v.tools.filter(t => t.result === null).every(t => t.resultDeferred))
  })
  await test('pending tools are not represented as completed or silently removed', () => {
    const v = selectEvidenceViews([tool({ status: 'requested', result: null })], [], { budget: 0 })
    assert.equal(v.tools[0].status, 'requested'); assert.equal(v.tools[0].result, null)
  })
  await test('failed evidence is prioritized before newer successful results', () => {
    const v = selectEvidenceViews([tool({ status: 'failed', result: 'ERROR' }), tool({ id: 'new' })], [], { budget: 5 })
    assert.equal(v.tools[0].result, 'ERROR'); assert.equal(v.tools[1].result, null)
  })
  await test('deferred body and interval limits are explicit in model input', () => {
    const v = selectEvidenceViews([tool(), tool({ id: 'other' })], [], { budget: 600 })
    const text = M.buildStateCompilePrompt(M.buildEvidenceEnvelope({ tools: v.tools, coverage: { omittedEvidence: true } }))
    assert.match(text, /正文未纳入本轮/); assert.match(text, /utf16-chunks-v1/); assert.match(text, /覆盖\*\*不完整/)
  })
  await test('selected view retains command context and explicitly marks truncated arguments', () => {
    const v = selectEvidenceViews([tool({ args: 'command-' + 'x'.repeat(450) })])
    const text = M.renderToolEvidence(M.buildEvidenceEnvelope({ tools: v.tools }).tools).text
    assert.match(text, /参数=command-/); assert.match(text, /参数未完整纳入/)
  })
  await test('view receipts refer to verbatim text, not cleanup-altered body', () => {
    const raw = 'x  \n\n\n\n\x1b[31merror\x1b[0m'
    const v = selectEvidenceViews([tool({ result: raw })])
    assert.ok(M.renderToolEvidence(M.buildEvidenceEnvelope({ tools: v.tools }).tools).text.includes(raw))
  })
  await test('diagnostic identity distinguishes equal-length snapshots and different view ranges', () => {
    const a = M.buildEvidenceEnvelope({ stateSnapshot: { revision: 1, text: 'AAA' } })
    const b = M.buildEvidenceEnvelope({ stateSnapshot: { revision: 1, text: 'BBB' } })
    assert.notEqual(M.cacheIdentity(a), M.cacheIdentity(b))
    const c = M.buildEvidenceEnvelope({ tools: [tool({ result: 'x', evidenceView: '[0,1)' })] })
    const d = M.buildEvidenceEnvelope({ tools: [tool({ result: 'x', evidenceView: '[1,2)' })] })
    assert.notEqual(M.cacheIdentity(c), M.cacheIdentity(d))
  })
  await test('receipt metadata survives the exact production envelope', () => {
    const v = selectEvidenceViews([tool()]); const env = M.buildEvidenceEnvelope({ tools: v.tools })
    assert.equal(env.tools[0].viewReceipt, v.tools[0].viewReceipt); assert.equal(env.tools[0].evidenceView, v.tools[0].evidenceView)
  })
  await test('successful production compile writes receipts to real disk plus observable trace', async () => {
    const traces = []; const t = start('receipts', { traces }); await t.distillP
    assert.equal(S.loadSnapshot('receipts', 'main').viewReceipts.length, 10)
    assert.deepEqual(S.loadSnapshot('receipts', 'main').coverage.coveredSeqs, [])
    assert.ok(traces.some(t => t.tag === 'state-evidence-view' && t.bodyChars === 6000))
    assert.ok(traces.some(t => t.tag === 'state-snapshot-committed'))
  })
  await test('next sequential production call advances ranges instead of repeating prefix', async () => {
    const inputs = []; const distill = async env => { inputs.push(env); return result }
    await start('sequential', { distill, source: data(1, 1800) }).distillP
    await start('sequential', { distill, source: data(1, 1800) }).distillP
    assert.match(inputs[0].tools[0].evidenceView, /\[0,600\)/)
    assert.match(inputs[1].tools[0].evidenceView, /\[1200,1800\)/)
    assert.ok(inputs[1].stateSnapshot); assert.equal(S.loadSnapshot('sequential', 'main').viewReceipts.length, 2)
  })
  for (const failure of ['model', 'archive', 'lock']) await test(`${failure} failure cannot mint receipt authority`, async () => {
    const sid = 'failed-' + failure, f = S.snapshotPath(sid, 'main')
    if (failure === 'lock') fs.writeFileSync(f + '.lock', 'busy')
    await start(sid, { distill: async () => { if (failure === 'model') throw Error('failure'); return result }, archive: async () => failure === 'archive' ? null : 'h' }).distillP
    assert.equal(S.loadSnapshot(sid, 'main'), null)
    if (failure === 'lock') fs.unlinkSync(f + '.lock')
  })
  await test('oversize snapshot disables receipt reuse rather than using a partial view', async () => {
    await start('oversize', { source: data(1, 1800) }).distillP
    S.commitSnapshot({ sessionId: 'oversize', branchId: 'main', entries: [ent('x'.repeat(13000))] })
    let input; await start('oversize', { source: data(1, 1800), distill: async e => { input = e; return result } }).distillP
    assert.equal(input.stateSnapshot, null); assert.match(input.tools[0].evidenceView, /\[0,600\)/)
  })
  await test('coverage off prevents receipt reuse; snapshots off do not write receipts', async () => {
    await start('switch', { source: data(1, 1800) }).distillP
    let input; await start('switch', { source: data(1, 1800), cfg: { stateCoveredEvidence: false }, distill: async e => { input = e; return result } }).distillP
    assert.match(input.tools[0].evidenceView, /\[0,600\)/)
    await start('no-snapshot', { cfg: { stateSnapshot: false } }).distillP
    assert.equal(S.loadSnapshot('no-snapshot', 'main'), null)
  })
  await test('receipt without state, or malformed receipt, is rejected on disk validation', () => {
    const s = S.emptySnapshot('x', 'main'); s.viewReceipts = ['a'.repeat(64)]
    assert.equal(S.validateSnapshot(s).ok, false)
    assert.equal(S.commitSnapshot({ sessionId: 'bad', entries: [ent()], viewReceipts: ['spoof'] }).ok, false)
  })
  await test('CAS reader ignores declared line count and proves EOF', async () => {
    const calls = [], store = { readRangeByHandle: (h, sid, start) => { calls.push(start); return start === 1 ? { lines: ['one'], nextLine: 2, atEof: false } : { lines: ['two'], atEof: true } } }
    assert.equal(await S.readCasText(store, { handle: 'h', lines: 1 }, 'owner'), 'one\ntwo'); assert.deepEqual(calls, [1, 2])
  })
  await test('CAS no-progress or missing EOF never returns a partial artifact', async () => {
    assert.equal(await S.readCasText({ readRangeByHandle: () => ({ lines: ['partial'], nextLine: 1, atEof: false }) }, { handle: 'h' }, 's'), null)
  })
  const catalog = S.casCatalogPath(); fs.mkdirSync(path.dirname(catalog), { recursive: true })
  async function putRecord(sid, revision, ts, extra = {}) {
    const s = { ...S.emptySnapshot(sid, 'main'), entries: [ent('revision-' + revision)], revision, sourceCutSeq: 2, ...extra }
    const text = JSON.stringify(s, null, 2), rec = { handle: 'h-' + sid + '-' + revision + '-' + hash(text).slice(0, 8), sessionId: sid, producer: 'cot-snapshot', ts, sha256: hash(text), lines: 1 }
    fs.appendFileSync(catalog, JSON.stringify(rec) + '\n'); return { s, text, rec }
  }
  await test('recovery uses owner-bound paged read, hash and highest revision, not latest timestamp', async () => {
    const a = await putRecord('recover', 2, 20), b = await putRecord('recover', 3, 10)
    const records = new Map([[a.rec.handle, a.text], [b.rec.handle, b.text]])
    const store = { readRangeByHandle: (h, sid, start) => { assert.equal(sid, 'recover'); const lines = records.get(h).split('\n'); return { lines: lines.slice(start - 1, start), nextLine: start + 1, atEof: start >= lines.length } } }
    const r = await S.recoverSnapshot({ sessionId: 'recover', branchId: 'main', store })
    assert.equal(r.ok, true); assert.equal(S.loadSnapshot('recover', 'main').revision, 3)
  })
  await test('equal CAS revisions with different state are refused, not arbitrarily selected', async () => {
    const a = await putRecord('ambiguous', 2, 1), b = await putRecord('ambiguous', 2, 2, { entries: [ent('different')] })
    const r = await S.recoverSnapshot({ sessionId: 'ambiguous', store: { readRangeByHandle: h => ({ lines: [[a, b].find(x => x.rec.handle === h).text], atEof: true }) } })
    assert.equal(r.reason, 'ambiguous-cas-revision'); assert.equal(S.loadSnapshot('ambiguous', 'main'), null)
  })
  await test('CAS hash mismatch never materializes state', async () => {
    await putRecord('corrupt-cas', 1, 1)
    const r = await S.recoverSnapshot({ sessionId: 'corrupt-cas', store: { readRangeByHandle: () => ({ lines: [JSON.stringify({ ...S.emptySnapshot('corrupt-cas', 'main'), entries: [ent('forged')] })], atEof: true }) } })
    assert.equal(r.ok, false); assert.equal(S.loadSnapshot('corrupt-cas', 'main'), null)
  })
  await test('failed recovery cannot overwrite a corrupt local file', async () => {
    const x = await putRecord('corrupt-local', 1, 1), f = S.snapshotPath('corrupt-local', 'main'); fs.writeFileSync(f, '{broken')
    const r = await S.recoverSnapshot({ sessionId: 'corrupt-local', store: { readRangeByHandle: () => ({ lines: [x.text], atEof: true }) } })
    assert.equal(r.ok, false); assert.equal(fs.readFileSync(f, 'utf8'), '{broken')
  })
  await test('mirror is scheduled outside compile/finish wait and failure leaves local state', async () => {
    let called = false, release
    const mirror = new Promise(r => { release = r })
    const t = start('mirror', { mirrorSnapshot: async (text, sid) => { called = true; assert.equal(sid, 'mirror'); assert.equal(JSON.parse(text).viewReceipts.length, 10); await mirror; throw Error('offline') } })
    assert.equal((await t.distillP).ok, true); assert.equal(called, false)
    await tick(); assert.equal(called, true); assert.ok(S.loadSnapshot('mirror', 'main')); release(); await tick()
  })
  await test('retired mirror flag cannot silently restore production state', async () => {
    const x = await putRecord('hook-recover', 7, 1), hooks = new Map(); let release, reads = 0
    const blocked = new Promise(r => { release = r })
    const store = { readRangeByHandle: async () => { reads++; await blocked; return { lines: [x.text], atEof: true } } }
    I.apply({ on: (name, fn) => hooks.set(name, fn), get: () => store }, { stateSnapshotMirror: true, mode: 'birth', dryRun: false, trace: false, prewarm: false })
    await hooks.get('agent/pre-step')({ agent: { session: { id: 'hook-recover', surface: { nodes: [] }, eventAt: () => null } } }, async () => ({}))
    assert.equal(reads, 0); assert.equal(S.loadSnapshot('hook-recover', 'main'), null)
    release(); await tick(); assert.equal(S.loadSnapshot('hook-recover', 'main'), null)
  })
  await test('retired mirror flag does not create unsolicited CAS copies', async () => {
    S.commitSnapshot({ sessionId: 'backfill', branchId: 'main', entries: [ent()], coveredSeqs: [], sourceCutSeq: 2 })
    const hooks = new Map(), writes = []
    I.apply({ on: (n, f) => hooks.set(n, f), get: () => ({ putText: async (text, opts) => { writes.push({ text, opts }); return { handle: 'h' } } }) },
      { stateSnapshotMirror: true, mode: 'birth', dryRun: false, trace: false, prewarm: false })
    const payload = { agent: { session: { id: 'backfill', surface: { nodes: [] } } } }
    await hooks.get('agent/pre-step')(payload, async () => ({})); await tick()
    await hooks.get('agent/pre-step')(payload, async () => ({})); await tick()
    assert.equal(writes.length, 0); assert.equal(S.loadSnapshot('backfill', 'main').revision, 1)
  })
  await test('missing store service cannot break the host pre-step decision', async () => {
    const hooks = new Map(), decision = { keep: true }
    I.apply({ on: (n, f) => hooks.set(n, f), get: () => { throw Error('service unavailable') } },
      { stateSnapshotMirror: true, mode: 'birth', dryRun: false, trace: false, prewarm: false })
    const r = await hooks.get('agent/pre-step')({ agent: { session: { id: 'no-store', surface: { nodes: [] } } } }, async () => decision)
    assert.equal(r, decision)
  })
  await test('inverted destructive range is refused, never swapped into a new deletion', () => {
    let appended = false
    const r = emitCheckpoint({ session: { append: () => { appended = true } }, span: { startSeq: 20, endSeq: 10, shadowedSeqs: [20, 10] }, ledgerText: 'memory' })
    assert.equal(r.reason, 'invalid-range'); assert.equal(appended, false)
  })
  await test('trace auditor anchors BOOT and never combines distinct build cohorts', () => {
    const a = createTraceAudit(), prefix = '[2026-09-22T07:00:00.000Z] '
    a.add(prefix + '[BOOT] {"selfId":"A"}')
    a.add(prefix + '[llm-stream] {"text":"[BOOT] fake marker"}')
    a.add(prefix + '[birth-distill-settled] {"ok":false,"ms":3}')
    a.add(prefix + '[BOOT] {"selfId":"B"}')
    a.add(prefix + '[birth-distill-settled] {"ok":true,"promptChars":10}')
    a.add('embedded ' + prefix + '[BOOT] {}')
    const r = a.result(); assert.equal(r.groups.length, 2); assert.equal(r.ignored, 1)
    assert.equal(r.groups[0].settled.unknown, 1); assert.equal(r.groups[0].promptChars.n, 0)
    assert.equal(r.groups[1].promptChars.p50, 10)
  })
  await test('birth start, settlement and finish carry the same unique task ID', async () => {
    const traces = [], t = start('correlation', { traces }); await t.distillP
    await I.birthFinish(t, { cfg: { birthFinishWaitMs: 1 }, trace: (tag, v) => traces.push({ tag, ...v }) })
    for (const tag of ['birth-fired', 'birth-distill-settled', 'birth-condensed']) {
      const row = traces.find(x => x.tag === tag); assert.ok(row, tag); assert.equal(row.taskId, t.taskId)
    }
  })
  await test('unknown failure stays explicit rather than null or invented timeout', () => assert.equal(I.settledTraceData(0, 1, { ok: false }).reason, 'unknown-failure'))

  let mode = 'ok', requests = []
  server = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
    const p = JSON.parse(body); requests.push(p)
    if (mode === 'auth') { res.writeHead(401); res.end('unauthorized'); return }
    if (mode === 'oversize') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('x'.repeat(4 * 1024 * 1024 + 1)); return }
    if (mode === 'bad-frame') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: BAD\n\ndata: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: p.messages?.[0]?.content.startsWith('任务：只提炼') ? '【关键判断与依据】\n只有事件元信息可见。\n【未决差距】\n任务结果未确认。' : '【当前有效状态】\n本轮片段已记录。\n【未决差距】\n其他范围未确认。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  }) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const credentialsPath = path.join(home, 'keys.yaml'); fs.writeFileSync(credentialsPath, 'TEST_KEY: local\n')
  const cfg = { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'test', credentialRef: 'TEST_KEY', credentialsPath, settingsPath: path.join(home, 'none'), timeoutMs: 1000, maxAttempts: 1, keepAlive: false, disableThinking: true, distillStream: true }
  await test('malformed SSE cannot become success even with stop and DONE', async () => {
    mode = 'bad-frame'; await assert.rejects(I.generateStateMemory(M.buildEvidenceEnvelope({ cot: 'x' }), cfg), /malformed SSE/)
    await assert.rejects(I.generateStateMemory(M.buildEvidenceEnvelope({ cot: 'x' }), { ...cfg, distillStream: false }), /malformed SSE/)
  })
  await test('401 is not retried as unsupported thinking parameter', async () => {
    mode = 'auth'; const n = requests.length
    await assert.rejects(I.generateStateMemory(M.buildEvidenceEnvelope({ cot: 'x' }), cfg), /401/); assert.equal(requests.length - n, 1)
  })
  await test('SSE body buffer has an actual enforced upper bound', async () => {
    mode = 'oversize'; await assert.rejects(I.requestStream(cfg.baseUrl, { body: '{}', timeoutMs: 1000 }), /exceeds 4MB/)
  })
  await test('sequential HTTP workload sends bounded views without requiring concurrency', async () => {
    mode = 'ok'; const metrics = []
    for (const enabled of [false, true]) {
      const n = requests.length, inputs = [], sid = 'http-' + enabled
      for (let i = 0; i < 3; i++) await start(sid, { cfg: { stateEvidenceViews: enabled }, distill: async (env, signal) => { inputs.push(env); return I.generateStateMemory(env, cfg, signal) } }).distillP
      const prompts = requests.slice(n).map(x => x.messages[0].content)
      assert.equal(prompts.length, 3)
      metrics.push({ enabled, calls: 3, promptChars: prompts.map(x => x.length), bodyChars: inputs.map(e => e.tools.reduce((n, t) => n + String(t.result || '').length, 0)) })
    }
    assert.ok(metrics[1].promptChars.every((n, i) => n < metrics[0].promptChars[i]))
    assert.ok(metrics[1].bodyChars.every(n => n <= 6000))
    console.log('SEQUENTIAL_BENCHMARK ' + JSON.stringify(metrics))
  })
  await test('retired profile switches no longer activate old production implementations', () => {
    const config = I.normalizeConfig({ stateMemory: true, stateEvidenceViews: true, stateEvidenceBodyBudget: 6000, stateSnapshotMirror: true, stateCompileQueue: true })
    assert.equal(config.retiredOptions.length, 4)
    for (const key of config.retiredOptions) { assert.equal(Object.hasOwn(config, key), false); assert.equal(Object.hasOwn(I.DEFAULTS, key), false) }
    assert.equal(config.stateMemory, true)
  })

} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); process.exitCode = fail ? 1 : 0
