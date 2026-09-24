// 健壮性回归：快照失败语义、CAS 读取与恢复、退役开关不生效、宿主 pre-step 不被插件拖垮、
// emitter 拒绝倒置区间、trace 审计器、taskId 贯通、传输层错误形态（SSE 畸形帧 / 401 / 4MB 上限）。
// v11.8：证据视图（selectEvidenceViews / 回执复用）与快照镜像已随退役开关移除，对应用例一并删除。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createTraceAudit } from '../tools/analyze-trace.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-views-')), oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('../index.js'), M = await import('../src/state-memory.js'), S = await import('../src/snapshot-store.js')
const { emitCheckpoint } = await import('../src/emitter.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const tick = () => new Promise(r => setImmediate(r))
const hash = s => crypto.createHash('sha256').update(s).digest('hex')
const ent = (text = '记录') => ({ id: text, category: 'state', content: text, evidence: 'inferred', origin: 'model', validity: 'active' })
const result = { text: '【当前有效状态】\n已记录本轮可见内容。', entries: [ent()], checkpointText: '本轮记录' }
function data(n = 28, len = 3299) {
  const events = []
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: len }, (_, j) => String.fromCharCode(0x4e00 + (i * 19 + j * 13) % 2000)).join('')
    events.push({ seq: 2 * i + 1, type: 'assistant/message', toolCalls: [{ id: 'c' + i, name: 'read', args: 'file' + i }] })
    events.push({ seq: 2 * i + 2, type: 'tool/result', toolCallId: 'c' + i, text })
  }
  return { events, inFlightIds: new Set(), cutSeq: n * 2 }
}
function start(sid, { distill = async () => result, archive = async () => 'h', cfg = {}, source = data(), traces = [] } = {}) {
  return I.birthStart({ index: 0, text: '原始推理'.repeat(300) }, { sessionId: sid, branchId: 'main',
    cfg: { stateMemory: true, timeoutMs: 1000, ...cfg },
    distill, archive, buildEnvelope: M.buildEvidenceEnvelope, collectEvidence: () => source,
    trace: (tag, v) => traces.push({ tag, ...v }),
  })
}
let server
try {
  for (const failure of ['model', 'archive', 'lock']) await test(`${failure} failure cannot commit a snapshot`, async () => {
    const sid = 'failed-' + failure, f = S.snapshotPath(sid, 'main')
    if (failure === 'lock') fs.writeFileSync(f + '.lock', 'busy')
    await start(sid, { distill: async () => { if (failure === 'model') throw Error('failure'); return result }, archive: async () => failure === 'archive' ? null : 'h' }).distillP
    assert.equal(S.loadSnapshot(sid, 'main'), null)
    if (failure === 'lock') fs.unlinkSync(f + '.lock')
  })
  await test('oversize snapshot is never injected as a partial view', async () => {
    await start('oversize', { source: data(1, 1800) }).distillP
    S.commitSnapshot({ sessionId: 'oversize', branchId: 'main', entries: [ent('x'.repeat(13000))] })
    let input; await start('oversize', { source: data(1, 1800), distill: async e => { input = e; return result } }).distillP
    assert.equal(input.stateSnapshot, null)
  })
  await test('stateSnapshot:false never writes a snapshot', async () => {
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
  await test('trace auditor reads birth.finishWaitMs from the nested BOOT field', () => {
    const a = createTraceAudit(), prefix = '[2026-09-24T07:00:00.000Z] '
    a.add(prefix + '[BOOT] {"selfId":"C","timeoutMs":20000,"birth":{"finishWaitMs":12000,"deferredClaim":false}}')
    const g = a.result().groups[0]; assert.equal(g.boot.birthFinishWaitMs, 12000); assert.equal(g.boot.timeoutMs, 20000)
  })
  await test('trace auditor: tool-result path accounting counts only emitted attempts (no double counting)', () => {
    const a = createTraceAudit(), p = '[2026-09-24T07:00:00.000Z] '
    const L = (tag, o) => a.add(p + '[' + tag + '] ' + JSON.stringify(o))
    L('BOOT', { selfId: 'X', mode: 'checkpoint', dryRun: false })
    // 成功发射：gate → commit → verify → result（同一 attemptId 四次读数，只能算一次）
    L('ledger-built', { emitAttemptId: 'a1', archived: 2, toolResultChars: 60000, toolResultItems: 3, toolResultLensMax: 30000, toolResultBuckets: '1/1/1/0', enrichChars: 700, excerpted: 1 })
    L('emit-net-savings', { emitAttemptId: 'a1', sourceChars: 90000, ledgerChars: 2500, netSavedChars: 87500, enrichChars: 700, netSavedIfHandleOnly: 88200 })
    L('ledger-archive-commit', { emitAttemptId: 'a1', pending: 2, ok: 2, failed: 0, wroteChars: 60000 })
    L('emit-handle-verify', { emitAttemptId: 'a1', verdict: 'resolved' })
    L('emit-net-savings-result', { emitAttemptId: 'a1', stage: 'emit', emitted: true, sourceChars: 90000, ledgerChars: 2500, netSavedChars: 87500, casWrites: 2, measuredSurfaceTokenDelta: 8000 })
    // 被闸门拦下：不得计收益，但要计入 blockedBy
    L('emit-net-savings', { emitAttemptId: 'a2', sourceChars: 5000, ledgerChars: 4900, netSavedChars: 100 })
    L('emit-net-savings-result', { emitAttemptId: 'a2', stage: 'gate', emitted: false, reason: 'no-net-savings' })
    // 归档失败重算后发射：以**最后一次**读数为准
    L('emit-net-savings', { emitAttemptId: 'a3', sourceChars: 50000, ledgerChars: 3000, netSavedChars: 47000 })
    L('emit-net-savings-recheck', { emitAttemptId: 'a3', ledgerChars: 9000, netSavedChars: 41000 })
    L('emit-net-savings-result', { emitAttemptId: 'a3', stage: 'emit', emitted: true, sourceChars: 50000, ledgerChars: 9000, netSavedChars: 41000, casWrites: 1 })
    // 句柄读不回 ⇒ 拒发
    L('emit-net-savings', { emitAttemptId: 'a4', sourceChars: 40000, ledgerChars: 1200, netSavedChars: 38800 })
    L('emit-net-savings-result', { emitAttemptId: 'a4', stage: 'handle-verify', emitted: false, reason: 'handle-unresolvable', casWrites: 1 })
    const r = a.result().toolResultPath
    assert.equal(r.emits.emitted, 2); assert.equal(r.emits.blocked, 2)
    assert.equal(r.blockedBy['no-net-savings'], 1); assert.equal(r.blockedBy['handle-unresolvable'], 1)
    // ★ 只算真正发射的尝试：87500（a1，取最终读数）+ 41000（a3 的 recheck 值，不是 47000）
    assert.equal(r.chars.netSavedChars, 128500)
    assert.equal(r.chars.sourceChars, 140000); assert.equal(r.chars.ledgerChars, 11500)
    assert.equal(r.archive.rechecks, 1, '归档失败重算必须留痕')
    assert.equal(r.archive.writeChars, 60000)
    assert.equal(r.handle.resolved, 1)
    assert.equal(r.lens.buckets.lt2K + r.lens.buckets.k2to8 + r.lens.buckets.k8to32 + r.lens.buckets.gt32K, 3)
    assert.equal(r.measuredSurfaceTokenDelta.p50, 8000)
    // 保本预算：128500 / (60000/2) = 4.28 次整块回读
    assert.equal(r.breakeven.avgArchivedCharsEstimate, 30000)
    assert.equal(r.breakeven.fullReadBacksAffordable, 4.28)
    assert.match(r.breakeven.acceptanceRule, /readBackCost/)
  })
  await test('trace auditor: un-emitted attempts cannot inflate the saving; empty trace yields no claims', () => {
    const a = createTraceAudit(), p = '[2026-09-24T07:00:00.000Z] '
    a.add(p + '[BOOT] {"selfId":"Y"}')
    a.add(p + '[emit-net-savings] {"emitAttemptId":"z1","netSavedChars":99999}')
    let r = a.result().toolResultPath
    assert.equal(r.emits.emitted, 0); assert.equal(r.emits.blocked, 0)
    assert.equal(r.chars.netSavedChars, 0, '没有终结的尝试不得计入收益')
    assert.equal(r.breakeven.fullReadBacksAffordable, null)
    assert.match(r.breakeven.note, /nothing to judge yet/)
    const b = createTraceAudit()
    r = b.result().toolResultPath
    assert.equal(r.emits.emitted, 0); assert.equal(r.chars.netSavedChars, 0)
  })

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
  await test('retired profile switches no longer activate old production implementations', () => {
    const config = I.normalizeConfig({ stateMemory: true, stateEvidenceViews: true, stateEvidenceBodyBudget: 6000, stateSnapshotMirror: true, stateCompileQueue: true })
    assert.equal(config.retiredOptions.length, 4)
    for (const key of config.retiredOptions) { assert.equal(Object.hasOwn(config, key), false); assert.equal(Object.hasOwn(I.DEFAULTS, key), false) }
    assert.equal(config.stateMemory, true)
  })


// ══ 句柄读回探针（P0-2，2026-09-24）══════════════════════════════════════════
//   契约三态：true=有正面证据能读回；false=有正面证据读不回；null=不可证（不拦发射）。
//   关键设计：先用一根**必然不存在**的同形句柄做受控探针，确认"失败信号可信"，
//   否则读 API 抛错究竟意味着"没这条记录"还是"我调用方式不对"无从区分 ⇒ 误伤所有正常发射。
{
  const { mkHandleProbe } = await import('../src/plugin.js')
  const silent = () => {}
  const mk = (store) => mkHandleProbe({ get: (k) => (k === 'cmbStore' ? store : null) }, silent)

  await test('句柄探针：无读 API ⇒ null（不可证，不拦）', async () => {
    const probe = mk({ putText: async () => ({ handle: 'art://x' }) })
    assert.equal(await probe('art://h', 'text', 's'), null)
  })

  await test('句柄探针：读得到内容 ⇒ true', async () => {
    const probe = mk({ readRangeByHandle: async (h) => ({ lines: ['hello world'], atEof: true }) })
    assert.equal(await probe('art://h', 'hello world and more', 's'), true)
  })

  await test('句柄探针：查无此记录（返回空页）⇒ false', async () => {
    const probe = mk({ readRangeByHandle: async () => ({ lines: [], atEof: true }) })
    assert.equal(await probe('art://h', 'x', 's'), false)
  })

  await test('句柄探针：受控探针确认失败信号可信后，抛错 = 证伪 ⇒ false', async () => {
    const probe = mk({ readRangeByHandle: async (h) => { throw new Error('resolve-owner-mismatch') } })
    assert.equal(await probe('art://h', 'x', 's'), false)
  })

  await test('句柄探针：连"必然不存在的句柄"都读得到 ⇒ 抛错不可信 ⇒ null（不误伤）', async () => {
    const probe = mk({ readRangeByHandle: async () => ({ lines: ['anything'], atEof: true }) })
    assert.equal(await probe('art://real', 'x', 's'), true)   // 直接读成功
    const probe2 = mk({ readRangeByHandle: async (h) => {
      if (h === 'art://' + '0'.repeat(22)) return { lines: ['impossible'], atEof: true }
      throw new Error('boom')
    } })
    assert.equal(await probe2('art://real', 'x', 's'), null)
  })

  await test('句柄探针：读 API 抛错且会话 id 与归档同源（跨 session 所有权校验）', async () => {
    const seen = []
    const probe = mk({ readRangeByHandle: async (h, sid) => { seen.push(sid); return { lines: ['a'], atEof: true } } })
    await probe('art://h', 'abc', 'sess-9')
    assert.equal(seen.every((sid) => sid === 'sess-9'), true, JSON.stringify(seen))
  })

  await test('句柄探针：store 服务缺失/ctx.get 抛错 ⇒ 不向外抛', async () => {
    const probe = mkHandleProbe({ get: () => { throw new Error('no service') } }, silent)
    assert.equal(await probe('art://h', 'x', 's'), null)
  })
}

} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); process.exitCode = fail ? 1 : 0
