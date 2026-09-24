import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import * as I from '../index.js'
import * as M from '../state-memory.js'
import { compilerEvidence } from '../evidence-input.js'
import { prepareEvidenceLedger, transientEvidenceFrame, ledgerDirectory, buildJudgmentPrompt, readEvidenceHistory } from '../evidence-ledger.js'
import { STORAGE_LIMITS, auditEvidenceStorage, collectEvidenceGarbage } from '../evidence-storage.js'
import { analyzeConsumption } from '../tools/analyze-consumption.mjs'
import { parseTrace } from '../tools/replay.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-grounding-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = home
const sha = t => crypto.createHash('sha256').update(t).digest('hex')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const tool = (n, text, extra = {}) => ({ id: 't' + n, seq: n * 2, resultSeq: n * 2 + 1, name: 'read', args: { path: '/project/' + n }, result: text, status: 'completed', exitCode: 0, ...extra })
try {
  await test('normal results remain grounding, including empty/semantic failure with exit zero', () => {
    const tools = [tool(1, '版本：旧版本，不支持目标配置。'), tool(2, 'test failures: 4'), tool(3, '')]
    const e = compilerEvidence(tools)
    assert.ok(e.text.includes('旧版本')); assert.ok(e.text.includes('test failures: 4'))
    assert.ok(compilerEvidence([tool(4, '有显式结果但无事件序号', { resultSeq: null })]).text.includes('有显式结果但无事件序号'))
    assert.equal(e.receipts.length, 3); assert.equal(e.receipts[2].providedComplete, true)
  })
  await test('all visible normal results retain the old 1200-character prefix; old storage never authorizes omission', () => {
    const tools = Array.from({ length: 28 }, (_, i) => tool(i + 1, String(i).padStart(2, '0') + '正常正文'.repeat(1000)))
    const a = prepareEvidenceLedger({ sessionId: 'prefix', tools }), b = prepareEvidenceLedger({ sessionId: 'prefix', tools })
    assert.equal(b.frame.newObservations, 0)
    for (const t of tools) assert.ok(b.frame.evidenceInput.text.includes(t.result.slice(0, 1200)))
    assert.equal(a.frame.evidenceInput.text, b.frame.evidenceInput.text)
    assert.equal(JSON.parse(fs.readFileSync(b.frame.indexPath)).evidenceInput, undefined)
  })
  await test('isError/nonzero exit/failed/cancelled all carry body; overflow is explicit head plus tail, not whole-result coverage', () => {
    for (const flags of [{ isError: true }, { exitCode: 1 }, { status: 'failed' }, { status: 'cancelled' }]) {
      const e = compilerEvidence([tool(1, 'HEAD_' + 'x'.repeat(20000) + '_LAST_ERROR', flags)])
      assert.ok(e.text.includes('HEAD_')); assert.ok(e.text.includes('_LAST_ERROR'))
      assert.equal(e.receipts[0].providedComplete, false); assert.equal(e.receipts[0].ranges.length, 2)
      assert.ok(e.text.includes('中间未提供'))
    }
  })
  await test('identical bodies deduplicate inside the request but retain both event associations', () => {
    const body = '完整内容'
    const e = compilerEvidence([tool(1, body), tool(2, body)])
    assert.equal(e.bodyChars, body.length); assert.equal(e.receipts.length, 2)
    assert.ok(e.text.includes('id="t1"') && e.text.includes('id="t2"'))
  })
  await test('long source is not falsely called source-truncated merely because old prompt used 1200 chars', () => {
    const ev = M.normalizeEvidenceEvent({ seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 't', content: 'x'.repeat(2000) }] } } })
    const adapted = M.adaptEvidence({ events: [{ seq: 2, type: 'assistant/message', toolCalls: [{ id: 't', name: 'read' }] }, ev] })
    assert.equal(adapted.tools[0].sourceTruncated, false)
    assert.equal(compilerEvidence(adapted.tools).receipts[0].providedComplete, true)
  })
  await test('plans/alternatives/goals/constraints are required content despite two-section presentation', () => {
    const f = transientEvidenceFrame({ tools: [tool(1, '结果')], unknownUserEvents: [{ text: '未知来源材料' }] }, 'fixture')
    const prompt = buildJudgmentPrompt({ cot: '原始判断', deterministicFrame: f })
    for (const term of ['验收条件', '约束', '项目语义状态', '否决原因', '备选解释', '已有计划', '未知来源材料', '结果']) assert.ok(prompt.includes(term), term)
    assert.ok(!prompt.includes('null〕'))
  })
  await test('managed store cap refuses growth without deleting live evidence; orphan GC preserves every view', () => {
    const p = prepareEvidenceLedger({ sessionId: 'quota', tools: [tool(1, '保留证据')] }), dir = ledgerDirectory('quota'), root = path.dirname(dir)
    const oldUsage = JSON.parse(fs.readFileSync(path.join(root, '.usage.json')))
    fs.writeFileSync(path.join(root, '.usage.json'), JSON.stringify({ ...oldUsage, bytes: STORAGE_LIMITS.globalBytes }))
    assert.throws(() => prepareEvidenceLedger({ sessionId: 'quota', tools: [tool(2, '新证据')] }), /quota-exceeded/)
    assert.equal(readEvidenceHistory(p.frame.indexPath).length, 1)
    const report = auditEvidenceStorage(root, true); assert.ok(report.measured.bytes < STORAGE_LIMITS.globalBytes)
    const orphan = path.join(dir, 'a'.repeat(64) + '.txt'); fs.writeFileSync(orphan, '未提交孤儿')
    const gc = collectEvidenceGarbage(root); assert.equal(gc.deletedFiles, 1); assert.equal(fs.existsSync(orphan), false)
    assert.equal(readEvidenceHistory(p.frame.indexPath).length, 1)
  })
  await test('no deferred consumer => original bounded wait remains, avoiding guaranteed abandonment', async () => {
    const cfg = { ...I.DEFAULTS, mode: 'birth', dryRun: false, stateMemory: true, birthDeferredClaim: false }
    const deps = { cfg, sessionId: 'no-deferred', collectEvidence: () => ({ events: [] }), buildEnvelope: M.buildEvidenceEnvelope,
      prepareEvidence: input => transientEvidenceFrame(input, 'fixture'), archive: async () => 'confirmed',
      distill: async () => { await new Promise(r => setImmediate(r)); return { text: '简短有效判断' } } }
    const task = I.birthStart({ index: 0, text: '原始reasoning'.repeat(300) }, deps)
    const result = await I.birthFinish(task, deps); assert.equal(result.why, 'condensed')
  })
  await test('already-ready result still compresses; missing session falls back to configured wait', async () => {
    for (const sid of ['ready-before-finish', null]) {
      const cfg = { ...I.DEFAULTS, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100 }
      const deps = { cfg, sessionId: sid, collectEvidence: () => ({ events: [] }), buildEnvelope: M.buildEvidenceEnvelope, prepareEvidence: input => transientEvidenceFrame(input, 'fixture'), archive: async () => 'confirmed', distill: async () => { await new Promise(r => setImmediate(r)); return { text: '保留已有判断。' } } }
      const task = I.birthStart({ index: 0, text: '原始判断'.repeat(500) }, deps)
      if (sid) await task.distillP
      assert.equal((await I.birthFinish(task, deps)).why, 'condensed')
    }
  })
  await test('production envelope failure cannot silently invoke an ungrounded legacy compiler', async () => {
    let calls = 0
    const cfg = { ...I.DEFAULTS, dryRun: false, mode: 'birth', stateMemory: true, birthMinChars: 100 }
    const deps = { cfg, sessionId: 'invalid-envelope', collectEvidence: () => ({ events: [] }),
      prepareEvidence: input => transientEvidenceFrame(input, 'fixture'),
      buildEnvelope: () => { throw Error('fixture envelope failure') }, archive: async () => 'confirmed',
      distill: async () => { calls++; return { text: '不应被调用' } } }
    const raw = '完整原始判断'.repeat(300), task = I.birthStart({ index: 0, text: raw }, deps)
    const result = await I.birthFinish(task, deps); await task.distillP
    assert.equal(calls, 0); assert.ok(result.text.includes(raw)); assert.equal(task.distillState.ok, false)
  })
  await test('funnel separates no observed opportunity from failed claims and prepared from generated', () => {
    const rows = [['birth-fired', { taskId: 't' }], ['compiler-input-prepared', { taskId: 't' }], ['birth-distill-settled', { taskId: 't', ok: true }], ['birth-archive-settled', { taskId: 't', ok: true }], ['birth-late-memory-stored', { taskId: 't' }]]
    const text = rows.map(([tag, v]) => `[time] [${tag}] ${JSON.stringify(v)}`).join('\n')
    const r = analyzeConsumption(text)
    assert.equal(r.counts.generatedAndArchived, 1); assert.equal(r.counts.storedWithoutObservedOpportunity, 1)
    assert.equal(r.counts.applied, 0); assert.equal(r.billingSavings, null)
  })

  for (const quotaFull of [false, true]) await test(`real hooks: delayed result, next turns, retry, consumption; ledger quota full=${quotaFull}`, async () => {
    const sid = 'full-route-' + quotaFull
    const root = path.dirname(ledgerDirectory(sid))
    if (quotaFull) { const usage = JSON.parse(fs.readFileSync(path.join(root, '.usage.json'))); fs.writeFileSync(path.join(root, '.usage.json'), JSON.stringify({ ...usage, bytes: STORAGE_LIMITS.globalBytes })) }
    const hooks = new Map(), traceFile = path.join(home, 'production-' + quotaFull + '.log'), credentialsPath = path.join(home, 'keys')
    fs.writeFileSync(credentialsPath, 'LOCAL: unused')
    let release, received
    const gate = new Promise(r => { release = r }), requested = new Promise(r => { received = r })
    const server = http.createServer((req, res) => { let body = ''; req.on('data', x => { body += x }); req.on('end', async () => {
      received(JSON.parse(body)); await gate
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '【关键判断与依据】\n只有原始判断，运行状态尚未确认。\n【未决差距】\n缺少运行核验结果。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 32 } }) + '\n\ndata: [DONE]\n\n')
    }) })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    let watcher, timer
    try {
      const archived = new Map(), store = { putText: async (text, opts) => { const handle = 'art://' + sha(opts.sessionId + text); archived.set(handle, text); return { handle, sha256: sha(text) } } }
      I.apply({ on: (name, fn) => hooks.set(name, fn), get: key => key === 'cmbStore' ? store : null }, {
        ...I.DEFAULTS, mode: 'birth', stateMemory: true, dryRun: false, model: 'fixture', followHostModel: false, followHostProvider: false,
        baseUrl: 'http://127.0.0.1:' + server.address().port, credentialRef: 'LOCAL', credentialsPath,
        keepAlive: false, distillStream: true, trace: true, traceFile,
      })
      const events = new Map(), nodes = [], raw = '已有判断需要保留，不代表执行成功。'.repeat(300)
      let seq = 0, emitted = 0, rejectAppend = true, lastLedger
      function add(type, content) { seq++; const ev = { seq, type, data: { message: { role: type === 'assistant/message' ? 'assistant' : 'user', content } } }; events.set(seq, ev); nodes.push(seq); return seq }
      add('user/message', [{ type: 'text', text: '只核验状态，不部署。' }])
      const session = { id: sid, branchId: 'main', surface: { nodes }, eventAt: n => events.get(n), requestContext: () => ({ contextWindow: 100000 }),
        append: (type, message, options) => {
          if (rejectAppend) throw Error('fixture append rejected')
          const start = nodes.indexOf(options.surfaceOp.startSeq), end = nodes.indexOf(options.surfaceOp.endSeq)
          assert.ok(start >= 0 && end >= start)
          seq++; events.set(seq, { seq, type, data: { message } }); nodes.splice(start, end - start + 1, seq)
          lastLedger = message; emitted++; return { seq }
        } }
      const pre = () => hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      await pre()
      const chunks = [{ type: 'block-start', blockType: 'reasoning', index: 0 }, { type: 'reasoning-delta', index: 0, text: raw }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }, { type: 'finish', reason: { kind: 'end' } }]
      const output = []; for await (const c of hooks.get('llm/stream')({ messages: [] }, () => (async function* () { yield* chunks })())) output.push(c)
      assert.equal(output.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), raw)
      add('assistant/message', [{ type: 'reasoning', text: raw }]); add('user/message', [{ type: 'text', text: '继续核验' }])
      await pre(); assert.equal(emitted, 0) // Model has not completed; no half-product is applied.
      let requestTimer
      try { await Promise.race([requested, new Promise((_, reject) => { requestTimer = setTimeout(() => reject(Error('expected compiler request was not issued')), 3000) })]) } finally { clearTimeout(requestTimer) }
      const settled = new Promise((resolve, reject) => {
        const check = () => { if (parseTrace(fs.readFileSync(traceFile, 'utf8')).some(r => r.tag === 'birth-late-memory-stored')) { clearTimeout(timer); watcher.close(); resolve() } }
        watcher = fs.watch(traceFile, check); timer = setTimeout(() => reject(Error('late result never stored')), 3000); check()
      })
      release(); await settled
      // keepTail=1 intentionally requires a later assistant, not just a user turn.
      await pre(); assert.equal(emitted, 0)
      add('assistant/message', [{ type: 'reasoning', text: '活跃尾部保留。' }]); add('user/message', [{ type: 'text', text: '继续' }])
      await pre(); assert.equal(emitted, 0); assert.equal(I.lateMemorySize(sid), 1)
      rejectAppend = false; await pre(); assert.equal(emitted, 1); assert.equal(I.lateMemorySize(sid), 0)
      const passThrough = hooks.get('llm/stream')({ messages: [lastLedger] }, () => (async function* () { yield { type: 'finish', reason: { kind: 'end' } } })())
      for await (const c of passThrough) {}
      await pre(); assert.equal(emitted, 1)
      const trace = fs.readFileSync(traceFile, 'utf8'), report = analyzeConsumption(trace)
      if (quotaFull) assert.ok(parseTrace(trace).some(r => r.tag === 'evidence-ledger-unavailable' && r.storageReason === 'evidence-quota-exceeded'))
      else assert.ok(parseTrace(trace).some(r => r.tag === 'evidence-ledger-committed' && r.indexPath))
      assert.equal(report.counts.generatedAndArchived, 1); assert.equal(report.counts.applied, 1)
      assert.equal(report.counts.acknowledged, 1); assert.equal(report.counts.observedInLaterOptions, 1)
      assert.equal(parseTrace(trace).find(r => r.tag === 'birth-distill-settled').providerReportedUsage.prompt_tokens, 123)
      if (process.env.CFB_V7_EVIDENCE_DIR) { fs.mkdirSync(process.env.CFB_V7_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CFB_V7_EVIDENCE_DIR, quotaFull ? 'quota-fallback-consumption.json' : 'local-consumption.json'), JSON.stringify({ ...report, evidenceKind: 'local HTTP fixture + simulated host, NOT real production session' }, null, 2) + '\n') }
    } finally { clearTimeout(timer); watcher?.close(); release(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
  })
} finally {
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); if (fail) process.exitCode = 1
