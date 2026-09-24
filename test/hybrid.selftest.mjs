import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import crypto from 'node:crypto'
import { prepareEvidenceLedger as prepare, loadEvidenceLedger as load, ledgerDirectory, buildJudgmentPrompt, createEvidenceArchiver, readEvidenceHistory } from '../evidence-ledger.js'
import { captureTrace, parseTrace, replayCompiler, evaluateProduct, observationEvents } from '../tools/replay.mjs'
import * as I from '../index.js'
import * as M from '../state-memory.js'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-hybrid-')), oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let pass = 0, fail = 0
const hash = x => crypto.createHash('sha256').update(x).digest('hex')
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const tool = (n, extra = {}) => ({ id: 'call-' + n, seq: n * 2, resultSeq: n * 2 + 1, name: 'read', args: '{"path":"src/' + n + '.js"}', status: 'completed', exitCode: 0, result: 'TOOL_BODY_' + n + '_' + '正文不可每次重发'.repeat(500), ...extra })
const input = (sid, extra = {}) => ({ sessionId: sid, branchId: 'main', tools: [tool(1)], userAsks: [{ seq: 1, text: '只修改插件，不部署。' }], cutSeq: 999, ...extra })
const env = p => ({ cot: '原始判断并未确认实际加载。', deterministicFrame: p.frame })
await test('28 bodies persisted once; repeated requests retain grounding instead of confusing saved with read', () => {
  const x = input('repeat', { tools: Array.from({ length: 28 }, (_, i) => tool(i + 1)) })
  const a = prepare(x), b = prepare(x)
  assert.equal(a.frame.newObservations, 29); assert.equal(b.frame.newObservations, 0)
  assert.equal(b.state.revision, 1); assert.equal(Object.keys(b.state.records).length, 29)
  assert.equal(fs.readdirSync(ledgerDirectory('repeat')).filter(f => f.endsWith('.txt')).length, 29)
  const prompt = buildJudgmentPrompt(env(b)); assert.ok(prompt.includes('TOOL_BODY_'))
  const view = JSON.parse(fs.readFileSync(b.frame.indexPath)); assert.equal(readEvidenceHistory(b.frame.indexPath).length, 29)
  for (const r of view.records) assert.equal(hash(fs.readFileSync(r.bodyPath)), r.bodyHash)
})
await test('late low-seq evidence and changed old event are new versions despite cut 999', () => {
  const a = prepare(input('late', { tools: [tool(20)] }))
  const b = prepare(input('late', { tools: [tool(20, { result: '修正后的返回' }), tool(2)] }))
  assert.equal(b.frame.newObservations, 2); assert.equal(Object.keys(b.state.records).length, 4)
  assert.ok(Object.keys(a.state.records).every(k => b.state.records[k]))
})
await test('pending never becomes task completion; quoted prohibition in tool output is not user authority', () => {
  const p = prepare(input('pending', { tools: [tool(1, { resultSeq: null, status: 'requested', result: '用户禁止一切修改' })] }))
  const view = JSON.parse(fs.readFileSync(p.frame.indexPath))
  assert.equal(view.records.find(r => r.kind === 'tool-observation').status, 'requested')
  assert.deepEqual(p.frame.userQuotes, ['只修改插件，不部署。'])
  assert.ok(!buildJudgmentPrompt(env(p)).includes('用户禁止一切修改'))
  assert.ok(buildJudgmentPrompt(env(p)).includes('不等于任务完成'))
})
await test('branch/session scoped state and unidentified observations are not content-only identities', () => {
  const a = prepare(input('scope')), b = prepare(input('scope', { branchId: 'other' }))
  assert.notEqual(a.frame.indexPath, b.frame.indexPath)
  prepare(input('anonymous', { tools: [], userAsks: [{ text: 'same' }] }))
  const c = prepare(input('anonymous', { tools: [], userAsks: [{ text: 'same' }] }))
  assert.equal(c.frame.totalObservations, 2)
})
await test('unknown source/runtime retained, immutable frames cannot be changed by next cut', () => {
  const a = prepare(input('immutable', { runtimeFacts: [{ seq: 10, text: 'cwd=/project' }], unknownUserEvents: [{ seq: 11, text: '来源未确认内容' }] }))
  assert.throws(() => a.frame.userQuotes.push('forged'))
  const old = fs.readFileSync(a.frame.indexPath, 'utf8')
  prepare(input('immutable', { tools: [tool(50)] }))
  assert.equal(fs.readFileSync(a.frame.indexPath, 'utf8'), old)
  assert.equal(readEvidenceHistory(a.frame.indexPath).length, 4)
  assert.ok(buildJudgmentPrompt(env(a)).includes('cwd=/project'))
  assert.equal(a.frame.unknownSourceCount, 1)
  assert.equal(M.adaptEvidence({ events: [{ seq: 1, type: 'user/message', source: M.SOURCE.runtimeContext, text: 'Current runtime context.' }] }).runtimeFacts.length, 1)
})
await test('lock contention/corrupt body cannot advance observation state', () => {
  const a = prepare(input('disk-fail')), dir = ledgerDirectory('disk-fail')
  fs.writeFileSync(path.join(dir, 'index.lock'), 'busy')
  assert.throws(() => prepare(input('disk-fail')), /busy/)
  fs.unlinkSync(path.join(dir, 'index.lock'))
  const r = JSON.parse(fs.readFileSync(a.frame.indexPath)).records[0]
  fs.writeFileSync(r.bodyPath, 'corrupt')
  assert.throws(() => prepare(input('disk-fail')), /corrupt/)
  assert.equal(load('disk-fail').revision, 1)
})
await test('foreground does not wait for unresolved model; observations survive failed judgment', async () => {
  let release
  const cfg = { ...I.DEFAULTS, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100, birthDeferredClaim: true }
  const o = input('no-wait'), raw = '原始 reasoning 必须完整保留。'.repeat(100)
  const deps = { cfg, sessionId: o.sessionId, archive: async () => 'confirmed-test-archive',
    collectEvidence: () => observationEvents({ ...o, cut: 999 }), buildEnvelope: M.buildEvidenceEnvelope,
    prepareEvidence: x => prepare(x).frame, distill: () => new Promise((_, reject) => { release = reject }) }
  const task = I.birthStart({ index: 0, text: raw }, deps)
  let timer
  try {
    const result = await Promise.race([I.birthFinish(task, deps), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('foreground waited for background')), 300) })])
    assert.equal(result.text, raw); assert.equal(result.why, 'background-judgment-pending')
    assert.equal(load('no-wait').revision, 1)
  } finally { clearTimeout(timer); release?.(Error('fixture background failure')); await task.distillP }
  assert.equal(task.distillState.ok, false); assert.equal(load('no-wait').revision, 1)
})
await test('ledger unavailable keeps exact raw and never invokes model with legacy full window', async () => {
  let calls = 0
  const raw = '原文'.repeat(500), cfg = { ...I.DEFAULTS, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100 }
  const deps = { cfg, sessionId: 'prepare-fail', archive: async () => null, collectEvidence: () => ({}),
    adaptEvidence: () => ({ tools: [], userAsks: [] }), buildEnvelope: M.buildEvidenceEnvelope,
    prepareEvidence: () => { throw Error('disk unavailable') }, distill: () => { calls++; return { text: 'wrong' } } }
  const task = I.birthStart({ index: 0, text: raw }, deps), result = await I.birthFinish(task, deps)
  await task.distillP; assert.equal(calls, 0); assert.equal(result.text, raw)
})
await test('CAS references advertised only after confirmed store write; unchanged body not re-archived', async () => {
  const p = prepare(input('cas')), calls = [], done = []
  let resolve
  const completed = new Promise(r => { resolve = r })
  const archive = createEvidenceArchiver(() => ({ putText: async (text, opts) => { calls.push({ text, opts }); return { handle: 'art://confirmed-' + hash(text), sha256: hash(text) } } }), (tag) => { if (tag === 'evidence-cas-ready') { done.push(tag); if (done.length === p.archives.length) resolve() } })
  archive(p.archives); await completed
  const b = prepare(input('cas')); assert.equal(b.archives.length, 0)
  assert.ok(b.frame.deltaText || b.frame.indexPath)
  const view = JSON.parse(fs.readFileSync(b.frame.indexPath)); assert.ok(view.records.every(r => r.reference.startsWith('art://confirmed-')))
  archive(b.archives); assert.equal(calls.length, 2)
})

let responseMode = 'two', prompts = []
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => { body += b }); req.on('end', () => {
    prompts.push(JSON.parse(body).messages[0].content)
    if (responseMode === 'timeout') return
    const text = responseMode === 'empty' ? '' : responseMode === 'six' ? '【当前有效状态】\n任务已完成。' : '【关键判断与依据】\n运行进程是否加载尚未确认。\n【未决差距】\n缺运行版本证据。'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const credentials = path.join(home, 'credentials'); fs.writeFileSync(credentials, 'FIXTURE: unused-local-key')
const cfg = { ...I.DEFAULTS, enabled: true, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100, birthDeferredClaim: true, model: 'fixture-only',
  followHostModel: false, followHostProvider: false, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
  credentialsPath: credentials, credentialRef: 'FIXTURE', keepAlive: false, prewarm: false, distillStream: true,
  trace: true, traceFile: path.join(home, 'trace.log') }
let captured
try {
  await test('actual transport accepts two fields but rejects six-field/empty output without substituting facts', async () => {
    const p = prepare(input('transport')), envelope = { ...M.buildEvidenceEnvelope({ cot: '判断材料'.repeat(100) }), deterministicFrame: p.frame }
    responseMode = 'two'; const r = await I.generateStateMemory(envelope, cfg)
    assert.equal(r.meta.compilerMode, 'grounded-judgment-v2'); assert.ok(r.entries.every(e => ['judgment', 'gap'].includes(e.category)))
    assert.ok(r.entries.every(e => e.evidence === 'inferred')); assert.ok(r.text.includes(p.frame.indexPath))
    responseMode = 'six'; await assert.rejects(() => I.generateStateMemory(envelope, cfg), /judgment-only/)
    responseMode = 'empty'; await assert.rejects(() => I.generateStateMemory(envelope, cfg), /empty distillate/)
  })
  await test('REAL default hooks: 8000ms timeout then empty then success; same observations remain committed, grounding survives retries', async () => {
    const hooks = {}, stored = new Map()
    const store = { putText: async (text, opts) => { const handle = 'art://' + hash(opts.sessionId + text); stored.set(handle, { text, sid: opts.sessionId }); return { handle, sha256: hash(text) } },
      readRangeByHandle: async (handle, sid) => { const r = stored.get(handle); assert.equal(r?.sid, sid); return { lines: r.text.split('\n'), atEof: true } } }
    const ctx = { get: k => k === 'cmbStore' ? store : null, on: (k, f) => { hooks[k] = f } }
    I.apply(ctx, cfg)
    const events = [{ seq: 1, type: 'user/message', data: { origin: 'user', role: 'user', content: [{ type: 'text', text: '不部署，只修改插件。' }] } },
      { seq: 2, type: 'assistant/message', data: { content: [{ type: 'tool-call', toolCallId: 't', toolName: 'read', args: { path: 'x.js' } }] } },
      { seq: 3, type: 'tool/result', data: { content: [{ type: 'tool-result', toolCallId: 't', content: 'NEVER_RESEND_THIS_BODY'.repeat(200) }], exitCode: 0 } }]
    const session = { id: 'real-hook', branchId: 'main', surface: { nodes: [1, 2, 3] }, eventAt: n => events.find(e => e.seq === n) }
    function settled(n) { return new Promise((resolve, reject) => {
      let timer; const watcher = fs.watch(cfg.traceFile, () => check())
      const check = () => { if (parseTrace(fs.readFileSync(cfg.traceFile, 'utf8')).filter(r => r.tag === 'birth-distill-settled').length >= n) { clearTimeout(timer); watcher.close(); resolve() } }
      timer = setTimeout(() => { watcher.close(); reject(Error('background settlement missing')) }, 12000); check()
    }) }
    const before = prompts.length
    for (const [i, mode] of ['timeout', 'empty', 'two'].entries()) {
      responseMode = mode; await hooks['agent/pre-step']({ agent: { session } }, async () => ({}))
      const done = settled(i + 1), raw = ('本轮判断 ' + i + ' 尚未确认实际加载。').repeat(100)
      const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: raw },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }, { type: 'finish', reason: { kind: 'end' } }]
      const stream = hooks['llm/stream']({ model: 'fixture-only', messages: [] }, () => (async function* () { yield* chunks })())
      const output = []; for await (const c of stream) output.push(c)
      assert.equal(output.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), raw)
      assert.equal(load('real-hook').revision, 1)
      await done
    }
    assert.equal(prompts.length - before, 3)
    assert.ok(prompts.slice(before).every(p => p.startsWith('任务：只提炼') && p.includes('NEVER_RESEND_THIS_BODY')))
    const trace = fs.readFileSync(cfg.traceFile, 'utf8'), rows = parseTrace(trace)
    const results = rows.filter(r => r.tag === 'birth-distill-settled')
    assert.match(results[0].reason, /timeout 8000ms/); assert.match(results[1].reason, /empty distillate/); assert.equal(results[2].ok, true)
    assert.deepEqual(rows.filter(r => r.tag === 'evidence-ledger-committed').map(r => r.newObservations), [2, 0, 0])
    captured = await captureTrace(trace, store); assert.equal(captured.complete, true); assert.equal(captured.cases.length, 3)
    assert.ok(captured.cases[0].observations.tools[0].result.includes('NEVER_RESEND_THIS_BODY'))
  })
  await test('runnable recorded compiler replay is explicitly NOT product acceptance', async () => {
    responseMode = 'two'
    // ⚠ Windows 修复：new URL(import.meta.url).pathname 会产出 "/C:/Users/..."（前导斜杠 + 盘符），
    //   path.resolve 再拼一次就变成 "C:\C:\Users\..." ⇒ ERR_MODULE_NOT_FOUND。
    //   改用 fileURLToPath，它在 Windows 上给出正确盘符路径，在 POSIX 上行为不变。
    const report = await replayCompiler(captured, cfg, path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), path.join(home, 'replay-home'))
    assert.equal(report.compiles.length, 3); assert.ok(report.compiles.every(c => c.status === 'ok'))
    assert.equal(report.productAccepted, false)
    assert.equal(evaluateProduct(report, report, {}).status, '未验收')
  })
} finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
// ════════════════════════════════════════════════════════════════════════════
// ★★ 2026-09-22 开关切分（用户令）：压缩 与 状态记忆 必须互不拖累 ★★
//   背景（本机 trace.log 实测，27 次副编译）：
//     要压缩的原文 均值 5,371 / 实际发出的 prompt 均值 40,522 ⇒ 放大 7.5x，工具正文占 58.7%
//   根因：触发粒度是「每段 reasoning」，输入范围却是「整个 60 节点证据窗口」。
//   以下用例把切分语义钉死，防止再被合并回一个开关。
// ════════════════════════════════════════════════════════════════════════════
await test('compile mode is adjudicated in one place; memory wins but conflict is reported', () => {
  assert.equal(I.resolveCompileMode({}), 'legacy')
  assert.equal(I.resolveCompileMode({ stateCompress: true }), 'compress')
  assert.equal(I.resolveCompileMode({ stateMemory: true }), 'memory')
  // 两个都开：stateMemory 优先，且必须留痕，绝不静默二选一
  assert.equal(I.resolveCompileMode({ stateMemory: true, stateCompress: true }), 'memory')
  const c = I.normalizeConfig({ stateMemory: true, stateCompress: true })
  assert.equal(c.compileMode, 'memory')
  assert.deepEqual(c.compileModeConflict, { stateMemory: true, stateCompress: true, winner: 'stateMemory' })
})
await test('stateCompress NEVER collects evidence: prompt carries only this reasoning', async () => {
  let collected = 0, envelopeBuilt = 0, seenPrompt = null
  const raw = '推理正文。'.repeat(200)
  const cfg = { ...I.normalizeConfig({ mode: 'birth', dryRun: false, stateCompress: true, birthMinChars: 100 }),
    model: 'fixture-only', baseUrl: 'http://127.0.0.1:1/v1', maxAttempts: 1, timeoutMs: 50 }
  const deps = { cfg, sessionId: 'compress-scope',
    archive: async () => 'confirmed-archive',
    collectEvidence: () => { collected++; return { events: [], inFlightIds: new Set(), cutSeq: 1 } },
    buildEnvelope: (...a) => { envelopeBuilt++; return M.buildEvidenceEnvelope(...a) },
    prepareEvidence: () => { throw Error('stateCompress 不得采集证据') },
    distill: async (input, _s, _b) => { seenPrompt = input; return { text: '摘要', meta: {} } } }
  const task = I.birthStart({ index: 0, text: raw }, deps)
  await I.birthFinish(task, deps); await task.distillP.catch(() => {})
  // 切分的核心断言：纯压缩模式下，证据采集器一次都不该被调用
  assert.equal(collected, 0, 'stateCompress 不得调用 collectEvidence')
  assert.equal(envelopeBuilt, 0, 'stateCompress 不得构造证据信封')
  // 且送给模型的就是这段 reasoning 本身
  assert.equal(typeof seenPrompt, 'string')
  assert.ok(seenPrompt.length <= raw.length * 2, '压缩输入不得远超原文：' + seenPrompt.length + ' vs ' + raw.length)
})
await test('stateMemory still collects evidence (切分不得破坏状态记忆)', async () => {
  let collected = 0
  const cfg = { ...I.normalizeConfig({ mode: 'birth', dryRun: false, stateMemory: true, birthMinChars: 100 }), model: 'fixture-only', maxAttempts: 1, timeoutMs: 50 }
  const o = input('memory-still-collects')
  const deps = { cfg, sessionId: o.sessionId, archive: async () => 'confirmed-archive',
    collectEvidence: () => { collected++; return observationEvents({ ...o, cut: 999 }) },
    buildEnvelope: M.buildEvidenceEnvelope, prepareEvidence: x => prepare(x).frame,
    distill: async () => ({ text: '判断', meta: {} }) }
  const task = I.birthStart({ index: 0, text: '原文'.repeat(300) }, deps)
  await I.birthFinish(task, deps); await task.distillP.catch(() => {})
  assert.ok(collected >= 1, 'stateMemory 必须仍然采集证据')
})
await test('missing real data, audit coverage, or zero applied compiles never pass product gate', () => {
  assert.equal(evaluateProduct(null, null, null).status, '未验收')
  const b = { kind: 'full-session-replay', complete: true, realModel: true, sourceSha256: 'a'.repeat(64), profileFingerprint: 'same',
    compiles: [{ id: 'ok', status: 'ok', applied: true }, { id: 'failed', status: 'timeout' }], rounds: [{ id: 'round', goalId: 'goal', redundant: true }], outcomes: { goal: 'passed' } }
  const c = { ...b, compiles: [b.compiles[0]], rounds: [{ id: 'round', goalId: 'goal', redundant: false }] }
  const reviewed = { reviewedCompileIds: ['ok'], reviewedRoundIds: ['round'], wrongStateCases: [] }
  const audit = { complete: true, reviewer: 'fixture-only-not-real-audit', baselineHash: hash(JSON.stringify(b)), candidateHash: hash(JSON.stringify(c)), baseline: reviewed, candidate: reviewed }
  assert.equal(evaluateProduct(b, c, audit).status, '通过') // Schema gate only, NOT real evidence.
  audit.candidate = { ...reviewed, wrongStateCases: [{ compileId: 'ok', roundId: 'round', explanation: '错误状态导致改错文件' }] }
  assert.equal(evaluateProduct(b, c, audit).status, '未通过')
  audit.candidate = { ...reviewed, reviewedCompileIds: [] }
  assert.equal(evaluateProduct(b, c, audit).status, '未验收')
  c.compiles[0] = { ...c.compiles[0], applied: false }
  assert.equal(evaluateProduct(b, c, audit).status, '未验收')
})
if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
fs.rmSync(home, { recursive: true, force: true })
console.log(`PASS=${pass} FAIL=${fail}`); if (fail) process.exitCode = 1
