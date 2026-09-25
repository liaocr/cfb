// ★★ v11.11 并发正确性：模型跟随不改写共享配置、流归属可检测交错 ★★
//
// 旧实现两处共享可变状态：
//   ① followHostModel 看到新模型就改写共享 cfg.model / cfg.followProvider；
//      checkpoint 的 early-fire 在**流被消费时**才读 cfg ⇒ A 流开、B 流开、A 被消费 ⇒ A 的提前调用用了 B 的模型。
//   ② 全局 birthSessionId：pre-step 写、llm/stream 读 ⇒ A.pre → B.pre → A.stream 把 A 的块登记成 B。
// 本套件全部走**真实钩子入口 + 本机 HTTP**，零外网。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { normalizeConfig } from '../src/config.js'
import { createHostFollower } from '../src/host-follow.js'
import { createSessionTracker } from '../src/session-tracker.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-concurrency-'))
const previous = process.env.DSH_HOME
process.env.DSH_HOME = home
const credentialsPath = path.join(home, 'keys'); fs.writeFileSync(credentialsPath, 'LOCAL: unused\n')

let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 2000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await sleep(10); return pred() }

async function withServer(fn) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (x) => { body += x })
    req.on('end', () => {
      try { requests.push(JSON.parse(body)) } catch { requests.push(null) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '【摘要】核验通过。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 8 } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { return await fn({ baseUrl: 'http://127.0.0.1:' + server.address().port, requests }) }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
}
const readTrace = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
  const m = /^\[[^\]]+\] \[([^\]]+)\] (.*)$/.exec(l)
  try { return m ? { tag: m[1], data: JSON.parse(m[2]) } : null } catch { return null }
}).filter(Boolean) : [])
function applyPlugin(over, ctxGet) {
  const hooks = new Map()
  I.apply({ on: (n, fn) => hooks.set(n, fn), get: ctxGet || (() => null) }, {
    ...I.DEFAULTS, enabled: true, dryRun: false, credentialRef: 'LOCAL', credentialsPath,
    followHostProvider: false, keepAlive: false, prewarm: false, trace: true, ...over,
  })
  return hooks
}
const REASONING = '逐步核验参数与边界条件。'.repeat(40)
async function* reasoningStream(raw = REASONING) {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: raw }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: 'ok' }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: 'ok' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const drain = async (it) => { const out = []; for await (const c of it) out.push(c); return out }
const session = (id) => ({ id, surface: { nodes: [] }, eventAt: () => null, requestContext: () => ({ contextWindow: 262144 }) })

try {
  // ═══ §1 host-follow：共享配置永不改写 ══════════════════════════════════════
  await test('§1a callConfig 按调用派生；共享 cfg.model / followProvider 原封不动', () => {
    const cfg = normalizeConfig({ model: 'explicit', followHostModel: true, followProvider: 'p0' })
    const traces = []
    const h = createHostFollower(cfg, (tag, data) => traces.push({ tag, data }))
    h.observe({ model: 'm-A', provider: 'pA' }, 1)
    const a = h.callConfig({ model: 'm-A', provider: 'pA' })
    const b = h.callConfig({ model: 'm-B', provider: 'pB' })
    assert.equal(a.model, 'm-A'); assert.equal(a.followProvider, 'pA')
    assert.equal(b.model, 'm-B'); assert.equal(b.followProvider, 'pB')
    assert.equal(cfg.model, 'explicit', '共享配置不许被改写'); assert.equal(cfg.followProvider, 'p0')
    assert.notEqual(a, cfg)
    assert.equal(traces.find((t) => t.tag === 'host-model').data.effectiveModel, 'm-A')
  })
  await test('§1b 不猜：本次没带模型 ⇒ 最近见过的宿主模型 ⇒ 显式配置；followHostModel:false ⇒ 永远显式', () => {
    const cfg = normalizeConfig({ model: 'explicit', followHostModel: true })
    const h = createHostFollower(cfg, () => {})
    assert.equal(h.callConfig({}).model, 'explicit')
    h.observe({ model: 'm-A' }, 1)
    assert.equal(h.callConfig({}).model, 'm-A')
    const off = createHostFollower(normalizeConfig({ model: 'explicit', followHostModel: false }), () => {})
    off.observe({ model: 'm-A' }, 1)
    assert.equal(off.callConfig({ model: 'm-A' }).model, 'explicit')
    const none = createHostFollower(normalizeConfig({ model: '', followHostModel: true }), () => {})
    assert.equal(none.callConfig({}).model, '', '都没有 ⇒ 空（下游抛 no model ⇒ 原文放行）')
  })
  await test('§1c followHostProvider:false ⇒ 端点永远用显式 followProvider', () => {
    const h = createHostFollower(normalizeConfig({ followHostProvider: false, followProvider: 'mine' }), () => {})
    h.observe({ model: 'x', provider: 'host' }, 1)
    assert.equal(h.callConfig({ provider: 'host' }).followProvider, 'mine')
  })

  // ═══ §2 钩子级：checkpoint early-fire 用「自己那次调用」的模型 ═══════════════
  await test('§2 A 流开 → B 流开（换模型）→ 消费 A ⇒ A 的提前调用用 m-A（v11.10 会用 m-B）', async () => {
    await withServer(async ({ baseUrl, requests }) => {
      const hooks = applyPlugin({ mode: 'checkpoint', earlyFire: true, minRawChars: 100, model: '', followHostModel: true, baseUrl,
        traceFile: path.join(home, 'cp-model.log') })
      const a = hooks.get('llm/stream')({ model: 'm-A', messages: [] }, () => reasoningStream())
      const b = hooks.get('llm/stream')({ model: 'm-B', messages: [] }, () => reasoningStream('另一段推理。'.repeat(60)))
      await drain(a)
      assert.ok(await until(() => requests.length >= 1), '提前调用应已发出')
      assert.equal(requests[0].model, 'm-A')
      await drain(b)
      assert.ok(await until(() => requests.length >= 2))
      assert.equal(requests[1].model, 'm-B')
    })
  })

  // ═══ §3 session-tracker：单会话永不误报、交错必报、可恢复 ═══════════════════
  await test('§3a 单会话 pre→stream 循环（含只有 pre-step 没开流的步）永不判歧义', () => {
    const t = createSessionTracker()
    for (let i = 0; i < 5; i++) { t.onPreStep(session('A')); if (i !== 2) assert.equal(t.forStream().ambiguous, false) }
    assert.equal(t.forStream().sessionId, 'A')
  })
  await test('§3b 交错 A.pre → B.pre → 流 → 流：两条都不可证；窗口排空后恢复', () => {
    const t = createSessionTracker()
    t.onPreStep(session('A')); t.onPreStep(session('B'))
    const s1 = t.forStream(), s2 = t.forStream()
    assert.equal(s1.ambiguous, true); assert.deepEqual(s1.candidates, ['A', 'B'])
    assert.equal(s2.ambiguous, true, '第二条流的归属同样不可证（污染项）')
    t.onPreStep(session('A'))
    const s3 = t.forStream()
    assert.equal(s3.ambiguous, false); assert.equal(s3.sessionId, 'A')
  })
  await test('§3c 顺序切换 A.pre → A.stream → B.pre → B.stream 不判歧义', () => {
    const t = createSessionTracker()
    t.onPreStep(session('A')); assert.equal(t.forStream().ambiguous, false)
    t.onPreStep(session('B')); const s = t.forStream()
    assert.equal(s.ambiguous, false); assert.equal(s.sessionId, 'B')
  })
  await test('§3d 过期：残留项超过 staleMs 自动丢弃，不会把之后的流永久判歧义', () => {
    let now = 0
    const t = createSessionTracker({ staleMs: 1000, now: () => now })
    t.onPreStep(session('A'))            // A 的最后一步只有 pre-step
    now = 5000
    t.onPreStep(session('B'))
    assert.equal(t.forStream().ambiguous, false)
  })
  await test('§3e 60s 内切会话且 A 残留 ⇒ 仅一条流保守放行（记录在案的假阳性代价）', () => {
    const t = createSessionTracker()
    t.onPreStep(session('A'))            // 没开流
    t.onPreStep(session('B'))
    assert.equal(t.forStream().ambiguous, true)
    t.onPreStep(session('B'))            // B 的下一步：新项、未污染
    assert.equal(t.forStream().ambiguous, false)
  })

  // ═══ §4 钩子级：birth 流归属不可证 ⇒ 缺省原文放行 ═══════════════════════════
  const birthRun = async (over) => withServer(async ({ baseUrl, requests }) => {
    const traceFile = path.join(home, 'amb-' + Math.random().toString(36).slice(2) + '.log')
    const writes = []
    const store = { async putText(text, opts) { writes.push(opts.sessionId); return { handle: 'art://' + 'x'.repeat(22) } }, async readRangeByHandle() { return { lines: ['x'], atEof: true } } }
    const hooks = applyPlugin({ mode: 'birth', model: 'm', followHostModel: false, baseUrl, birthMinChars: 100, birthFinishWaitMs: 300,
      finishHeadersGraceMs: 0, birthDeferredClaim: false, traceFile, ...over }, (name) => (name === 'cmbStore' ? store : null))
    const pre = hooks.get('agent/pre-step')
    await pre({ agent: { session: session('A') } }, async () => ({}))
    await pre({ agent: { session: session('B') } }, async () => ({}))
    const src = []
    for await (const c of reasoningStream()) src.push(c)
    const out = await drain(hooks.get('llm/stream')({ model: 'm', messages: [] }, () => reasoningStream()))
    await sleep(50)
    return { out, src, requests, writes, traces: readTrace(traceFile) }
  })
  await test('§4a A.pre → B.pre → 开流（缺省 passthrough）⇒ 原文逐字放行、零副模型调用、零归档、留痕', async () => {
    const r = await birthRun({})
    assert.deepEqual(r.out, r.src)
    assert.equal(r.requests.length, 0)
    assert.equal(r.writes.length, 0)
    const amb = r.traces.find((t) => t.tag === 'birth-session-ambiguous')
    assert.ok(amb); assert.deepEqual(amb.data.candidates, ['A', 'B']); assert.equal(amb.data.action, 'passthrough')
  })
  await test('§4b birthSessionAmbiguity:"latest" ⇒ 旧行为（按最近 pre-step 的会话 B 归档），仍留痕', async () => {
    const r = await birthRun({ birthSessionAmbiguity: 'latest' })
    assert.ok(r.requests.length >= 1)
    assert.ok(r.writes.length >= 1 && r.writes.every((s) => s === 'B'))
    assert.equal(r.traces.find((t) => t.tag === 'birth-session-ambiguous').data.action, 'latest')
  })
  await test('§4c 单会话照常压缩（不误伤）', async () => {
    await withServer(async ({ baseUrl, requests }) => {
      const hooks = applyPlugin({ mode: 'birth', model: 'm', followHostModel: false, baseUrl, birthMinChars: 100, birthFinishWaitMs: 300,
        finishHeadersGraceMs: 0, traceFile: path.join(home, 'single.log') }, (n) => (n === 'cmbStore' ? { async putText() { return { handle: 'art://' + 'y'.repeat(22) } } } : null))
      await hooks.get('agent/pre-step')({ agent: { session: session('A') } }, async () => ({}))
      await drain(hooks.get('llm/stream')({ model: 'm', messages: [] }, () => reasoningStream()))
      assert.equal(requests.length >= 1, true)
      assert.equal(readTrace(path.join(home, 'single.log')).some((t) => t.tag === 'birth-session-ambiguous'), false)
    })
  })

  // ═══ §5 配置 ═══════════════════════════════════════════════════════════════
  await test('§5 birthSessionAmbiguity：缺省 passthrough；嵌套别名；非法值回到安全缺省并留痕', () => {
    assert.equal(normalizeConfig({}).birthSessionAmbiguity, 'passthrough')
    const n = normalizeConfig({ birth: { sessionAmbiguity: 'latest' } })
    assert.equal(n.birthSessionAmbiguity, 'latest'); assert.deepEqual(n.unknownOptions, [])
    const bad = normalizeConfig({ birthSessionAmbiguity: 'lastest' })
    assert.equal(bad.birthSessionAmbiguity, 'passthrough')
    assert.equal(bad.configAdjusted.birthSessionAmbiguity.from, 'lastest')
  })
} finally {
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
