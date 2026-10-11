// 健壮性回归：退役开关不生效、宿主 pre-step 不被插件拖垮、trace 审计器、taskId 贯通、
// 传输层错误形态（SSE 畸形帧 / 401 / 4MB 上限）、句柄读回探针。
// v11.8：证据视图（selectEvidenceViews / 回执复用）与快照镜像已随退役开关移除，对应用例一并删除。
// v12.1：快照失败语义 / CAS 快照恢复 / emitter 倒置区间 / 工具结果路径核算随 memory 与 checkpoint 模式删除。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createTraceAudit } from '../tools/analyze-trace.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-views-')), oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('../index.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
function start(sid, { distill = async () => ({ text: '摘要：核验通过。', meta: {} }), archive = async () => 'h', cfg = {}, traces = [] } = {}) {
  return I.birthStart({ index: 0, text: '原始推理'.repeat(300) }, { sessionId: sid,
    cfg: { timeoutMs: 1000, ...cfg },
    distill, archive,
    trace: (tag, v) => traces.push({ tag, ...v }),
  })
}
let server
try {
  await test('missing store service cannot break the host pre-step decision', async () => {
    const hooks = new Map(), decision = { keep: true }
    I.apply({ on: (n, f) => hooks.set(n, f), get: () => { throw Error('service unavailable') } },
      { mode: 'birth', dryRun: false, trace: false, prewarm: false })
    const r = await hooks.get('agent/pre-step')({ agent: { session: { id: 'no-store', surface: { nodes: [] } } } }, async () => decision)
    assert.equal(r, decision)
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
    mode = 'bad-frame'; await assert.rejects(I.generateDistillation('x', cfg), /malformed SSE/)
    await assert.rejects(I.generateDistillation('x', { ...cfg, distillStream: false }), /malformed SSE/)
  })
  await test('401 is not retried as unsupported thinking parameter', async () => {
    mode = 'auth'; const n = requests.length
    await assert.rejects(I.generateDistillation('x', cfg), /401/); assert.equal(requests.length - n, 1)
  })
  await test('SSE body buffer has an actual enforced upper bound', async () => {
    mode = 'oversize'; await assert.rejects(I.requestStream(cfg.baseUrl, { body: '{}', timeoutMs: 1000 }), /exceeds 4MB/)
  })
  await test('retired profile switches no longer activate old production implementations', () => {
    const config = I.normalizeConfig({ stateMemory: true, stateEvidenceViews: true, stateEvidenceBodyBudget: 6000, stateSnapshotMirror: true, stateCompileQueue: true })
    assert.equal(config.retiredOptions.length, 5)
    for (const key of config.retiredOptions) { assert.equal(Object.hasOwn(config, key), false); assert.equal(Object.hasOwn(I.DEFAULTS, key), false) }
    assert.equal(config.stateMemory, undefined, 'v12.1：memory 模式已删除 ⇒ stateMemory 也是退役键')
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
