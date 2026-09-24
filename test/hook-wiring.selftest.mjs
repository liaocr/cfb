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
    baseUrl, keepAlive: false, birthMinChars: 100, birthDeferredClaim: false,
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
  // ══ 1. checkpoint 分支：宿主服务获取抛错 ⇒ 只降级，绝不阻断 ══════════════
  await test('1. checkpoint：ctx.get 抛错 ⇒ 留一条 checkpoint-error 且 decision 照常透传', async () => {
    await withServer(async (baseUrl) => {
      const traceFile = path.join(home, 't-ctxget.log')
      const hooks = applyPlugin({
        baseUrl, traceFile, over: { mode: 'checkpoint' },
        ctxGet: () => { throw new Error('service registry unavailable') },
      })
      const session = SESSION([{ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'u' }] } } }])
      const d = { host: 'decision' }
      assert.deepEqual(await hooks.get('agent/pre-step')({ agent: { session } }, async () => d), d, '绝不因为服务取不到而抛给宿主')
      const err = readTrace(traceFile).find(([t]) => t === 'checkpoint-error')
      assert.ok(err, '应留 checkpoint-error')
      assert.match(err[1].error, /service registry unavailable/)
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
} finally {
  if (previous == null) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
