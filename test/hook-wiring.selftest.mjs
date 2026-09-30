// ★★ 钩子接线健壮性（2026-09-24）★★
//
// 覆盖面：`plugin.js` 里那些「只有出错才会走到、于是从来没人走过」的分支，
// 以及两条不许被破坏的既有约定：
//   · **主流自己的错误必须原样抛出**（插件只许降级自己，绝不许吞掉宿主的错）；
//   · 宿主服务获取失败 / 存储故障 ⇒ 只降级为「原文放行 + 一条 trace」，绝不阻断会话。
// 这些分支此前是 plugin.js 里仅剩的未覆盖行 —— 它们恰恰是事故形态最集中的地方。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import * as I from '../index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-hook-wiring-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = home
const credentialsPath = path.join(home, 'keys'); fs.writeFileSync(credentialsPath, 'LOCAL: unused\n')

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) }
}
async function withServer(fn) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '【已定决策】摘要。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { await fn('http://127.0.0.1:' + server.address().port) }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
}
const readTrace = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
  const m = l.match(/^\[[^\]]+\] \[([^\]]+)\] (.*)$/)
  try { return m ? [m[1], JSON.parse(m[2])] : null } catch { return null }
}).filter(Boolean) : [])
function applyPlugin({ ctxGet, baseUrl, over = {}, traceFile }) {
  const hooks = new Map()
  const ctx = { on: (n, fn) => hooks.set(n, fn), get: ctxGet || (() => null) }
  I.apply(ctx, {
    ...I.DEFAULTS, enabled: true, dryRun: false, mode: 'birth',
    model: 'fixture', followHostModel: false, followHostProvider: false, credentialRef: 'LOCAL', credentialsPath,
    baseUrl, keepAlive: false, birthMinChars: 100,
    finishHeadersGraceMs: 0, birthFinishWaitMs: 50, timeoutMs: 2000,
    trace: true, traceFile, ...over,
  })
  return hooks
}
const SESSION = (events) => {
  const map = new Map(events.map((e) => [e.seq, e]))
  return { id: 'sess-w', surface: { nodes: events.map((e) => e.seq) }, eventAt: (s) => map.get(s), requestContext: () => ({ contextWindow: 262144 }) }
}
const LONG = '推理正文：' + '逐步核验。'.repeat(200)

try {
  // ══ 1. 宿主服务获取抛错 ⇒ 只降级，绝不阻断（v12.1：原 checkpoint 分支改为 birth 全链路）══
  await test('1. ctx.get 抛错 ⇒ pre-step 照常透传 decision；birth 原文逐字放行', async () => {
    await withServer(async (baseUrl) => {
      const traceFile = path.join(home, 't-ctxget.log')
      const hooks = applyPlugin({ baseUrl, traceFile, ctxGet: () => { throw new Error('service registry unavailable') } })
      const session = SESSION([{ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'u' }] } } }])
      const d = { host: 'decision' }
      assert.deepEqual(await hooks.get('agent/pre-step')({ agent: { session } }, async () => d), d, '绝不因为服务取不到而抛给宿主')
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: LONG },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: LONG } },
        { type: 'finish', reason: { kind: 'end' } },
      ]
      const out = []
      for await (const c of hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => (async function* () { for (const c of chunks) yield c })())) out.push(c)
      assert.equal(out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), LONG, '取不到存储 ⇒ 推理原文逐字保留')
      assert.equal(out.find((c) => c.type === 'block-end').block.text, LONG)
    })
  })

  // ══ 2. birth 的 llm/stream：非 iterable 与评估态都必须原样放行 ═════════════
  await test('2. birth：坏形状不包装、评估态零介入（原样返回同一个对象）', async () => {
    await withServer(async (baseUrl) => {
      const traceFile = path.join(home, 't-noiter.log')
      const hooks = applyPlugin({ baseUrl, traceFile })
      for (const shape of [null, undefined, 42, 'text', { notIterable: true }]) {
        const got = hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => shape)
        assert.equal(got, shape, '不是 async iterable ⇒ 必须原样返回：' + String(shape))
      }
      const noiter = readTrace(traceFile).filter(([t]) => t === 'birth-no-async-iter')
      assert.equal(noiter.length, 5, '每一次都要留痕（否则宿主侧看不到为什么没压缩）')
      // 评估态：原样返回，不包装、不调用次模型
      const dryFile = path.join(home, 't-dry.log')
      const dryHooks = applyPlugin({ baseUrl, traceFile: dryFile, over: { dryRun: true } })
      const inner = (async function* () { yield { type: 'finish' } })()
      assert.equal(dryHooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => inner), inner)
      assert.ok(readTrace(dryFile).some(([t]) => t === 'birth-dry-run-stream'))
    })
  })

  // ══ 3. birth：CAS 写入抛错 ⇒ 原文逐字放行 + 一条错误证据；主流不受影响 ═══════
  await test('3. birth：CAS 写入抛错 ⇒ 原文逐字放行（存储故障绝不许改坏会话）', async () => {
    await withServer(async (baseUrl) => {
      const traceFile = path.join(home, 't-storefail.log')
      const hooks = applyPlugin({
        baseUrl, traceFile,
        ctxGet: (k) => (k === 'cmbStore' ? { putText: async () => { throw new Error('quota exceeded') } } : null),
      })
      // 先让 pre-step 捕获 sessionId（CAS 归档要用它登记归属）
      await hooks.get('agent/pre-step')({ agent: { session: SESSION([]) } }, async () => ({}))
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: LONG },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: LONG } },
        { type: 'finish', reason: { kind: 'end' } },
      ]
      const out = []
      for await (const c of hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => (async function* () { for (const c of chunks) yield c })())) out.push(c)
      // 逐步核对：reasoning 必须逐字透传（绝不因归档失败而丢字）
      const raw = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
      assert.equal(raw, LONG, '归档失败时推理原文必须逐字保留')
      const be = out.find((c) => c.type === 'block-end')
      assert.equal(be.block.text, LONG, 'block-end 的文本也必须逐字保留（否则 BlockAssembler 会用原文覆盖）')
      const err = readTrace(traceFile).find(([t]) => t === 'birth-archive-error')
      assert.ok(err, '应留 birth-archive-error 证据')
      assert.match(err[1].error, /quota exceeded/)
      const pt = readTrace(traceFile).find(([t]) => t === 'birth-passthrough')
      assert.ok(pt && pt[1].rawChars === LONG.length, '必须有一条 passthrough 记录说明原文被放行')
    })
  })

  // ══ 4. 主流自己的错误必须原样抛出（插件只许降级自己）═══════════════════════
  await test('4. 主流抛错原样抛出（绝不被插件吞掉或替换）', async () => {
    await withServer(async (baseUrl) => {
      const hooks = applyPlugin({ baseUrl, traceFile: path.join(home, 't-throw.log') })
      await hooks.get('agent/pre-step')({ agent: { session: SESSION([]) } }, async () => ({}))
      const BOOM = new Error('upstream provider exploded')
      const wrapped = hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: LONG }
        throw BOOM
      })())
      const seen = []
      await assert.rejects(async () => { for await (const c of wrapped) seen.push(c) }, (e) => e === BOOM)
      assert.ok(seen.some((c) => c.type === 'reasoning-delta'), '在抛错前已经产出的块必须照常交付（不许吞）')
    })
  })

  // ══ 5. 评估态 birth：零副模型调用、零改写（金丝雀观察的底线）═══════════════
  await test('5. birth 评估态：零改写、零 CAS 写入（只落观测）', async () => {
    await withServer(async (baseUrl) => {
      const traceFile = path.join(home, 't-birthdry.log')
      const writes = []
      const hooks = applyPlugin({
        baseUrl, traceFile, over: { dryRun: true },
        ctxGet: (k) => (k === 'cmbStore' ? { putText: async (t, o) => { writes.push([t, o]); return { handle: 'art://x' } } } : null),
      })
      await hooks.get('agent/pre-step')({ agent: { session: SESSION([]) } }, async () => ({}))
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: LONG },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: LONG } },
        { type: 'finish', reason: { kind: 'end' } },
      ]
      const out = []
      for await (const c of hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => (async function* () { for (const c of chunks) yield c })())) out.push(c)
      // 评估态：连包装都不做（early return）⇒ 块原样通过
      assert.equal(out.length, chunks.length)
      assert.deepEqual(out.map((c) => c.type), chunks.map((c) => c.type))
      assert.equal(writes.length, 0, '评估态绝不写 CAS')
      assert.ok(readTrace(traceFile).some(([t]) => t === 'birth-dry-run-stream'))
    })
  })

  // ══ 6. v12.7 compressCtx 自动构造经真实 llm/stream 钩子贯通（理论 S8-R5/R7 的生产前提）════════
  //   出站消息里的工具结果 ⇒ 压缩提示词带【当前任务与观察】⇒ 只在观察里出现的 `…` 片段被程序门核真（不被当编造剥掉）⇒ 分支绑到它。
  await test('6. birth + v4 直写：工具结果进 compressCtx；观察里的逐字片段核真；分支落点绑定；trace 带 ctxChars', async () => {
    const bodies = []
    const draft = '看起来余量只有 100ms。所以下一步工具调用是 bash 复现。如果失败复现，那么改测试把 `hedgeAfterMs: 1600` 拉大；如果始终不复现，那么去查 CI 负载。'
    const server = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        bodies.push(b)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: draft }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      const baseUrl = 'http://127.0.0.1:' + server.address().port
      const traceFile = path.join(home, 't-ctx.log')
      const hooks = applyPlugin({
        baseUrl, traceFile, over: { compressPrompt: 'v4', compressV4Direct: true, prewarm: false },   // 直写 ⇒ v4Incremental 自动为 false、收网窗口自动抬到 6000（normalizeConfig）
        ctxGet: (k) => (k === 'cmbStore' ? { putText: async () => ({ handle: 'art://ctx' }) } : null),
      })
      await hooks.get('agent/pre-step')({ agent: { session: SESSION([]) } }, async () => ({}))
      // 推理原文**没有**复述 hedgeAfterMs: 1600 —— 这一行只在工具结果里
      const raw = '我们需要找出 CI 偶发失败的原因。' + '两个定时器只差 100ms，2 核 CI 上事件循环抖动就能吃掉。'.repeat(12) + '下一步先限到 2 核循环复现。'
      const messages = [
        { role: 'user', content: '你是编码 Agent。CI 里 test/hedge.selftest.mjs 大约每 5 次失败 1 次。' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read_file', arguments: { path: 'test/hedge.selftest.mjs' } }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600\nassert.equal(meta.hedgeStartedAt, null)' }] }] },
      ]
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: raw },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } },
        { type: 'finish', reason: { kind: 'end' } },
      ]
      const out = []
      for await (const c of hooks.get('llm/stream')({ model: 'fixture', messages }, () => (async function* () { for (const c of chunks) yield c })())) out.push(c)
      assert.equal(bodies.length, 1, '一次副模型调用')
      const prompt = JSON.parse(bodies[0]).messages.map((m) => m.content).join('\n')
      assert.ok(prompt.includes('【当前任务与观察】'), '提示词带观察块')
      assert.ok(prompt.includes('[tool: read_file] path=test/hedge.selftest.mjs\nserver 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600'), prompt.slice(-600))
      const be = out.find((c) => c.type === 'block-end')
      assert.ok(be && be.block.text !== raw, '压缩生效（不是原文放行）')
      assert.ok(be.block.text.includes('`hedgeAfterMs: 1600`'), '只在观察里出现的片段仍算逐字（不被剥反引号）：' + be.block.text)
      assert.ok(be.block.text.includes('拉大——落点 `hedgeAfterMs: 1600` 的逐字原文已给出，可以直接当 edit_file 的 old_text'), 'R7 分支绑定：' + be.block.text)
      const compiled = readTrace(traceFile).find(([t]) => t === 'compiler-v4-compiled')
      assert.ok(compiled && compiled[1].ok === true && compiled[1].ctxChars > 0 && compiled[1].boundBranches === 1, JSON.stringify(compiled && compiled[1]))
      const settled = readTrace(traceFile).find(([t]) => t === 'birth-distill-settled')
      // v12.9.0：这条流之前已有一轮工具往来 ⇒ 台账在手 ⇒ 标 :mr（第一轮才是 :ctx）；台账进了提示词
      assert.ok(settled && /compress-v4d9:mr/.test(settled[1].promptVersion), 'promptVersion 标 :mr（生产 trace 可见观察 + 台账到位）：' + JSON.stringify(settled && settled[1].promptVersion))
      assert.ok(prompt.includes('【台账】') && prompt.includes('已走过的路') && prompt.includes('10. ★ 前面有【台账】'), '台账与多轮规则进提示词：' + prompt.slice(0, 300))
      assert.ok(!readTrace(traceFile).some(([t]) => /^v4-segment/.test(t)), '直写不走增量分段')
      const boot = readTrace(traceFile).find(([t]) => t === 'BOOT')
      assert.ok(boot && JSON.stringify(boot[1]).includes('compressV4DirectMinWaitMs'), 'BOOT 可见收网窗口被抬（configAdjusted）：' + JSON.stringify(boot && boot[1]).slice(0, 300))
    } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  })
} finally {
  if (previous == null) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
