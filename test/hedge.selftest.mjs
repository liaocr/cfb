#!/usr/bin/env node
// v11.7：对冲请求（hedgedDistill）与收尾宽限（finishHeadersGraceMs）。
// 全部走本机 HTTP 服务器（可控延迟），零外网、零 API 调用。
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'

let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-hedge-'))
const keyFile = path.join(home, 'keys'); fs.writeFileSync(keyFile, 'LOCAL: unused')

// 服务器：每个请求按 queue 里下一个延迟值等待后再发响应头；记录收到与被中断的请求数
let delays = [], received = 0, aborted = 0, completed = 0
const server = http.createServer((req, res) => {
  received++
  const d = delays.length ? delays.shift() : 0
  let gone = false
  req.on('aborted', () => { gone = true; aborted++ })
  res.on('close', () => { if (!res.writableFinished) { gone = true } })
  let body = ''; req.on('data', (c) => { body += c })
  req.on('end', () => {
    setTimeout(() => {
      if (gone || res.destroyed) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '摘要：' + d }, finish_reason: 'stop' }] }))
      completed++
    }, d)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = 'http://127.0.0.1:' + server.address().port
const cfgBase = { ...I.DEFAULTS, model: 'fixture', baseUrl, credentialsPath: keyFile, credentialRef: 'LOCAL', followHostModel: false, followHostProvider: false, keepAlive: false, maxAttempts: 1, timeoutMs: 5000, disableThinking: false }
const reset = (...d) => { delays = d; received = 0; aborted = 0; completed = 0 }

await test('hedgeAfterMs=0（缺省）⇒ 只发一份，行为与 v11.6 相同', async () => {
  reset(50)
  const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 0 }, undefined, 'p')
  assert.equal(received, 1); assert.equal(r.text, '摘要：50'); assert.equal(r.meta.hedged, undefined)
})

await test('主请求在 hedgeAfterMs 内回头 ⇒ 不对冲（只发一份）', async () => {
  reset(50)
  const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 400 }, undefined, 'p')
  await sleep(500)
  assert.equal(received, 1); assert.equal(r.meta.hedged, 'primary'); assert.equal(r.meta.hedgeStartedAt, null)
})

await test('★ 主请求慢、对冲快 ⇒ 用对冲结果，主请求被 abort，服务端只完成一份', async () => {
  reset(1500, 50)
  const traces = []
  const t0 = Date.now()
  const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 200 }, undefined, 'p', { trace: (t, d) => traces.push([t, d]) })
  const took = Date.now() - t0
  assert.equal(r.text, '摘要：50'); assert.equal(r.meta.hedged, 'hedge')
  assert.ok(took < 1200, 'took ' + took)
  await sleep(1700)
  assert.equal(received, 2); assert.equal(completed, 1, '慢的那份必须被 abort，不得完成')
  assert.ok(traces.some(([t]) => t === 'compiler-hedge-fired')); assert.ok(traces.some(([t, d]) => t === 'compiler-hedge-settled' && d.winner === 'hedge'))
})

await test('主请求先回头（对冲已发出）⇒ 用主结果，对冲被 abort', async () => {
  reset(300, 2000)
  const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 100 }, undefined, 'p')
  assert.equal(r.meta.hedged, 'primary')
  await sleep(2200)
  assert.equal(received, 2); assert.equal(completed, 1)
})

await test('对冲份失败不影响主份成功', async () => {
  // 第二个请求（对冲）立即 500
  let n = 0
  const srv2 = http.createServer((req, res) => { n++; if (n === 2) { res.writeHead(500); res.end('x'); return } setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })) }, 400) })
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  try {
    const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, baseUrl: 'http://127.0.0.1:' + srv2.address().port, hedgeAfterMs: 100 }, undefined, 'p')
    assert.equal(r.text, 'ok'); assert.equal(r.meta.hedged, 'primary')
  } finally { srv2.closeAllConnections(); await new Promise((r) => srv2.close(r)) }
})

await test('两份都失败 ⇒ 抛错（与不对冲同形），不挂起', async () => {
  const srv3 = http.createServer((req, res) => { res.writeHead(503); res.end('busy') })
  await new Promise((r) => srv3.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(I.generateDistillation('x'.repeat(100), { ...cfgBase, baseUrl: 'http://127.0.0.1:' + srv3.address().port, hedgeAfterMs: 50 }, undefined, 'p'), /http 503/)
  } finally { srv3.closeAllConnections(); await new Promise((r) => srv3.close(r)) }
})

await test('★ 主请求先失败（400）且对冲未发 ⇒ 不再对冲，立即按主请求错误结算', async () => {
  let n = 0
  const srv = http.createServer((req, res) => { n++; res.writeHead(400); res.end('bad request') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const t0 = Date.now()
    await assert.rejects(I.generateDistillation('x'.repeat(100), { ...cfgBase, baseUrl: 'http://127.0.0.1:' + srv.address().port, hedgeAfterMs: 1000 }, undefined, 'p'), /http 400/)
    const took = Date.now() - t0
    await sleep(1200)
    assert.equal(n, 1, '主请求已失败，计时器到点不得再发对冲')
    assert.ok(took < 800, '不得陪计时器空等：took ' + took)
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)) }
})

await test('★ compress 模式经 apply()：对冲/传输 trace 落盘，birth-distill-settled 带 hedged', async () => {
  reset(1500, 50)
  const hooks = new Map(), traceFile = path.join(home, 'compress-hedge.log')
  I.apply({ on: (n, fn) => hooks.set(n, fn), get: (k) => (k === 'cmbStore' ? { putText: async () => ({ handle: 'art://compress-hedge' }) } : null) }, {
    ...cfgBase, mode: 'birth', dryRun: false, stateCompress: true, compressPrompt: 'v3', birthMinChars: 100, birthDeferredClaim: false,
    birth: { finishWaitMs: 3000 }, hedgeAfterMs: 200, trace: true, traceFile, prewarm: false,
  })
  const session = { id: 'compress-hedge', surface: { nodes: [] }, eventAt: () => null }
  await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
  const raw = 'CHECK module alpha verified ok step\n'.repeat(120)
  const chunks = [{ type: 'block-start', blockType: 'reasoning', index: 0 }, { type: 'reasoning-delta', index: 0, text: raw },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }, { type: 'finish', reason: { kind: 'end' } }]
  const out = []
  for await (const c of hooks.get('llm/stream')({ messages: [] }, () => (async function* () { yield* chunks })())) out.push(c)
  let text = ''
  for (let i = 0; i < 40 && !/\[birth-distill-settled\]/.test(text); i++) { await sleep(50); try { text = fs.readFileSync(traceFile, 'utf8') } catch {} }
  assert.ok(text.includes('[compiler-transport-started]'), 'compress 路径必须有 compiler-transport-started')
  assert.ok(text.includes('[compiler-hedge-fired]'), '对冲真的发出时 trace 必须可见')
  assert.ok(text.includes('[compiler-hedge-settled]'))
  const settled = text.split('\n').find((l) => l.includes('[birth-distill-settled]'))
  assert.ok(settled && settled.includes('"hedged":"hedge"') && settled.includes('"hedgeAfterMs":200'), settled)
  assert.ok(settled.includes('"promptVersion":"compress-v3:250-450"'), 'promptVersion 仍须贯通')
  await sleep(1600)
})

await test('外部 signal abort ⇒ 两份都取消', async () => {
  reset(3000, 3000)
  const ctl = new AbortController()
  const p = I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 100 }, ctl.signal, 'p')
  setTimeout(() => ctl.abort(), 300)
  await assert.rejects(p)
  await sleep(200)
  assert.equal(completed, 0)
})

await test('maxAttempts>1 时对冲不生效（并发纪律）', async () => {
  reset(600)
  const r = await I.generateDistillation('x'.repeat(100), { ...cfgBase, hedgeAfterMs: 100, maxAttempts: 2 }, undefined, 'p')
  await sleep(200)
  assert.equal(received, 1); assert.equal(r.meta.hedged, undefined)
})

// ── 收尾宽限：birthStart/birthFinish 直调 ──
await test('★ 收尾宽限：budget 到点但已收到响应头 ⇒ 多等 grace 拿到摘要', async () => {
  const traces = []
  const raw = 'CHECK module alpha verified ok step\n'.repeat(120)
  let onHeaders = null
  const deps = {
    cfg: { birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 200, birthMinSavedChars: 50, finishHeadersGraceMs: 1500, birthDeferredClaim: false },
    trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's',
    // 模拟：100ms 后响应头到达，再 600ms 后内容完成（budget 200 会先到点）
    distill: async (_raw, _sig, budget) => { onHeaders = budget.onHeaders; await sleep(100); onHeaders({ ttfbMs: 100 }); await sleep(600); return { text: '摘要' } },
  }
  const task = I.birthStart({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }, deps)
  const r = await I.birthFinish(task, deps)
  assert.equal(r.why, 'condensed', r.why)
  const g = traces.find(([t]) => t === 'birth-finish-headers-grace')
  assert.ok(g && g[1].settled === true && g[1].waitedMs < 1500, JSON.stringify(g))
  assert.ok(traces.some(([t]) => t === 'birth-distill-headers'))
})

await test('收尾宽限：没收到响应头 ⇒ 不加一毫秒，budget 到点即放行', async () => {
  const traces = []
  const raw = 'CHECK module alpha verified ok step\n'.repeat(120)
  const deps = {
    cfg: { birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 200, birthMinSavedChars: 50, finishHeadersGraceMs: 1500, birthDeferredClaim: false },
    trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's',
    distill: async () => { await sleep(1000); return { text: '摘要' } },
  }
  const task = I.birthStart({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }, deps)
  const t0 = Date.now()
  const r = await I.birthFinish(task, deps)
  assert.equal(r.why, 'distill-timeout'); assert.ok(Date.now() - t0 < 600)
  assert.ok(!traces.some(([t]) => t === 'birth-finish-headers-grace'))
  await task.distillP.catch(() => {})
})

await test('收尾宽限：grace 也到点 ⇒ 放行，宽限最多一次', async () => {
  const traces = []
  const raw = 'CHECK module alpha verified ok step\n'.repeat(120)
  const deps = {
    cfg: { birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 100, birthMinSavedChars: 50, finishHeadersGraceMs: 300, birthDeferredClaim: false },
    trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's',
    distill: async (_r, _s, budget) => { await sleep(50); budget.onHeaders({ ttfbMs: 50 }); await sleep(2000); return { text: '摘要' } },
  }
  const task = I.birthStart({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }, deps)
  const t0 = Date.now()
  const r = await I.birthFinish(task, deps)
  assert.equal(r.why, 'distill-timeout'); const took = Date.now() - t0
  assert.ok(took >= 350 && took < 900, 'took ' + took)
  assert.equal(traces.filter(([t]) => t === 'birth-finish-headers-grace').length, 1)
  await task.distillP.catch(() => {})
})

await test('DEFAULTS：hedgeAfterMs=0（关）、finishHeadersGraceMs=1500；嵌套键可配', async () => {
  assert.equal(I.DEFAULTS.hedgeAfterMs, 0); assert.equal(I.DEFAULTS.finishHeadersGraceMs, 1500)
  const c = I.normalizeConfig({ distill: { hedgeAfterMs: 3000 }, birth: { finishHeadersGraceMs: 800 } })
  assert.equal(c.hedgeAfterMs, 3000); assert.equal(c.finishHeadersGraceMs, 800)
})

// ── 缓存友好拆分（compressSystemPrompt）──
await test('splitCompressPrompt：v2/v3 拆分字节等价；无 marker 返回 null', async () => {
  for (const p of [I.buildCompressPromptV3('原文ABC', 250, 450), I.buildCompressPrompt('原文ABC')]) {
    const sp = I.splitCompressPrompt(p)
    assert.ok(sp && sp.system.length > 0); assert.equal(sp.system + '\n\n' + sp.user, p)
    assert.ok(sp.user.startsWith('【上一轮思维链】\n原文ABC'))
    assert.ok(!sp.system.includes('原文ABC'), 'system 段不得含原文')
  }
  assert.equal(I.splitCompressPrompt('no marker'), null)
})

await test('compressPromptVersion：开关打开时版本号追加 :sys（v1 除外）', async () => {
  assert.equal(I.compressPromptVersion({ compressPrompt: 'v3', compressSystemPrompt: true }), 'compress-v3:250-450:sys')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'v2', compressSystemPrompt: true }), 'compress-v2:sys')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'v1', compressSystemPrompt: true }), 'compress-v1')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'v3' }), 'compress-v3:250-450')
  assert.equal(I.DEFAULTS.compressSystemPrompt, false)
})

await test('★ 请求体形状：cfg._promptMessages 存在 ⇒ 发 system+user 两条；否则单条 user（与 v11.6 相同）', async () => {
  const bodies = []
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { bodies.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '摘要' }, finish_reason: 'stop' }] })) }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const c0 = { ...cfgBase, baseUrl: 'http://127.0.0.1:' + srv.address().port }
    const prompt = I.buildCompressPromptV3('原文XYZ', 250, 450)
    await I.generateDistillation('原文XYZ', c0, undefined, prompt)
    const sp = I.splitCompressPrompt(prompt)
    await I.generateDistillation('原文XYZ', { ...c0, _promptMessages: [{ role: 'system', content: sp.system }, { role: 'user', content: sp.user }] }, undefined, prompt)
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[0].messages.map((m) => m.role), ['user']); assert.equal(bodies[0].messages[0].content, prompt)
    assert.deepEqual(bodies[1].messages.map((m) => m.role), ['system', 'user'])
    assert.equal(bodies[1].messages[0].content + '\n\n' + bodies[1].messages[1].content, prompt)
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)) }
})

server.closeAllConnections(); await new Promise((r) => server.close(r))
fs.rmSync(home, { recursive: true, force: true })
console.log('PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
