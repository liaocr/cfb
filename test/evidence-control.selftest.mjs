// 取消/诊断停止安全回归，全部为本机工程反例，未使用已消费留出。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getEventListeners } from 'node:events'
import { execFile } from 'node:child_process'
import * as I from '../index.js'
import { createDemoEnvironment, DEMO_OLD } from '../tools/evidence-demo.mjs'
let pass = 0, fail = 0, serial = 0
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-control-'))
const env = (over = {}) => { const base = path.join(home, String(++serial)); return createDemoEnvironment({ root: path.join(base, 'work'), directory: path.join(base, 'store'), withArchive: false, ...over }) }
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const restored = (e) => { assert.equal(fs.readFileSync(path.join(e.adapter.root, 'fixture.js'), 'utf8'), DEMO_OLD); assert.deepEqual(e.getState().context, ['用户原始任务']) }
const sample = (b, value) => ({ value, revision: b.revision, roundId: b.roundId, conditions: { cpus: 2 } })
const policy = (e, over = {}) => I.freezeApprovedRepairPolicy({ routing: 'fixed', firstActionId: 'fake-clock', fallbackActionId: 'raise-threshold', routes: {}, ...over }, e.contract)
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
try {
  await test('runtime预取消零预算/零归档，不占roundId，可显式重新调用', async () => {
    const e = env(), r = I.createEvidenceRuntime(e.options), a = new AbortController(); a.abort()
    const before = e.store.stats().files, p = r.program('complete', ['fake-clock'])
    const no = await r.runRound(p, { signal: a.signal, roundId: 'not-consumed' })
    assert.equal(no.reason, 'round-aborted'); assert.deepEqual(no.counters, { rounds: 0, repairs: 0, checks: 0 }); restored(e)
    assert.equal(e.store.stats().files, before); assert.equal((await r.runRound(p, { roundId: 'not-consumed' })).ok, true)
  })
  await test('非法signal/非布尔诊断能力不授信、不消费执行预算', async () => {
    const e = env(), r = I.createEvidenceRuntime(e.options), p = r.program('p', ['fake-clock'])
    for (const options of [{ signal: { aborted: false } }, { diagnostics: 'false' }, { stopOnUnknown: 1 }]) assert.equal((await r.runRound(p, options)).reason, 'round-options')
    assert.equal(r.view().rounds, 0); restored(e)
  })
  await test('前置观察中取消不动作，晚到pass不能触发编辑', async () => {
    const a = new AbortController(), e = env(), { schema, digest, ...def } = e.contract
    const contract = I.freezeEvidenceContract({ ...def, checks: def.checks.map((c) => c.id === 'original' ? { id: c.id, kind: 'observation', role: 'precondition', predicate: { op: 'equals', field: 'ready', value: true }, conditions: { cpus: 2 } } : c) })
    const r = I.createEvidenceRuntime({ ...e.options, contract, diagnosticModel: null, observe: (c, b) => { a.abort(); return sample(b, { ready: true }) } })
    const result = await r.runRound(r.program('p', ['fake-clock']), { signal: a.signal })
    assert.equal(result.reason, 'round-aborted'); assert.equal(result.status, 'rolled-back'); assert.ok(!result.receipts.some((r) => r.binding.phase === 'action')); restored(e)
  })
  await test('真实Node子进程收到取消，动作后文件+JSON恢复，外部监听器清理', async () => {
    const a = new AbortController(), started = deferred(), closed = deferred(); let child, observedSignal
    const e = env({ observe: (c, b, signal) => {
      observedSignal = signal
      return new Promise((resolve, reject) => {
        child = execFile(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { signal, env: { PATH: '/usr/bin:/bin' }, timeout: 3000 }, (error) => error ? reject(error) : resolve(sample(b, { fixed: true })))
        child.stdout.once('data', () => started.resolve()); child.once('close', () => closed.resolve())
      })
    } }), r = I.createEvidenceRuntime(e.options)
    const running = r.runRound(r.program('p', ['raise-threshold']), { signal: a.signal }); await started.promise; a.abort()
    const result = await running; await closed.promise
    assert.equal(observedSignal.aborted, true); assert.equal(result.ok, false); assert.equal(result.reason, 'round-aborted'); assert.equal(result.status, 'rolled-back'); restored(e)
    assert.equal(result.diagnostic, null); assert.equal(r.view().busy, false); assert.equal(getEventListeners(a.signal, 'abort').length, 0)
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  })
  await test('忽略signal的观察迟到只丢弃结果，不授绿灯/不二次动作', async () => {
    const a = new AbortController(), entered = deferred(), late = deferred(); let binding
    const e = env({ observe: (c, b) => { binding = b; entered.resolve(); return late.promise } }), r = I.createEvidenceRuntime(e.options)
    const running = r.runRound(r.program('p', ['raise-threshold']), { signal: a.signal }); await entered.promise; a.abort()
    const result = await running; late.resolve(sample(binding, { fixed: true })); await Promise.resolve()
    assert.equal(result.ok, false); assert.equal(result.reason, 'round-aborted'); assert.equal(r.view().done, false); assert.equal(r.view().repairs, 1); restored(e)
  })
  await test('同步动作已落地时取消：保留真实动作回执，仍恢复、不验收或诊断', async () => {
    const a = new AbortController(), e = env(); let checks = 0
    const adapter = Object.freeze({ ...e.adapter, perform: (action) => { const value = e.adapter.perform(action); a.abort(); return value } })
    const r = I.createEvidenceRuntime({ ...e.options, adapter, observe: () => { checks++; throw new Error('must not observe') } })
    const result = await r.runRound(r.program('p', ['raise-threshold']), { signal: a.signal })
    assert.equal(result.reason, 'round-aborted'); assert.equal(result.status, 'rolled-back'); assert.equal(checks, 0)
    assert.equal(result.receipts.filter((r) => r.binding.phase === 'action' && r.status === 'pass').length, 1); restored(e)
  })
  await test('episode预取消不发布/不启动，信号贯穿host，运行中取消不路由', async () => {
    const a = new AbortController(), entered = deferred(), e = env({ observe: () => { entered.resolve(); return new Promise(() => {}) } }), host = I.createEvidenceHost(e.options)
    const controller = I.createApprovedRepairEpisode({ host, contract: e.contract, policy: policy(e) }); a.abort()
    assert.equal((await controller.run({ signal: a.signal })).status, 'episode-aborted'); assert.equal(controller.view().started, false); assert.equal(host.latest().length, 0)
    assert.equal((await controller.run({ signal: { aborted: false } })).status, 'invalid-signal')
    const next = new AbortController(), running = controller.run({ signal: next.signal }); await entered.promise; next.abort()
    const r = await running; assert.equal(r.status, 'episode-aborted'); assert.equal(r.outcomes.length, 1); assert.equal(r.counters.repairs, 1); assert.deepEqual(r.decisions, []); restored(e)
    assert.equal(getEventListeners(next.signal, 'abort').length, 0); assert.equal(controller.view().busy, false)
  })
  await test('存档故障安全收口，错误正文不复制；同一控制器不能重放', async () => {
    const e = env(), tiny = I.createEvidenceStore({ directory: path.join(home, 'tiny'), sessionId: e.store.sessionId, maxBlobBytes: 10, maxTotalBytes: 1000 })
    const host = I.createEvidenceHost({ ...e.options, store: tiny }), controller = I.createApprovedRepairEpisode({ host, contract: e.contract, policy: policy(e) })
    const result = await controller.run(); assert.equal(result.status, 'host-unavailable'); assert.equal(result.solved, false); assert.equal(host.runtime.view().rounds, 0); assert.equal(host.latest().length, 0); restored(e)
    assert.equal((await controller.run()).status, 'episode-already-run')
  })
  await test('默认policy摘要保持旧格式，before-retry显式冻结，非法模式/篡改拒绝', () => {
    const e = env(), p = policy(e), { digest, ...body } = p
    assert.equal(Object.hasOwn(body, 'diagnosticMode'), false); assert.equal(policy(e, { diagnosticMode: 'always' }).digest, digest)
    const lean = policy(e, { diagnosticMode: 'before-retry' }); assert.notEqual(lean.digest, digest); assert.equal(lean.diagnosticMode, 'before-retry')
    assert.throws(() => policy(e, { diagnosticMode: 'off' }), /repair-policy/)
    const host = I.createEvidenceHost(e.options); assert.throws(() => I.createApprovedRepairEpisode({ host, contract: e.contract, policy: { ...lean, diagnosticMode: 'always' } }), /drift/)
  })
  await test('无下次修复机会跳过末轮诊断，不减少验收/前置，仍恢复失败动作', async () => {
    const e = env(), host = I.createEvidenceHost(e.options), p = policy(e, { firstActionId: 'raise-threshold', diagnosticMode: 'before-retry', maxAttempts: 1 })
    const result = await I.createApprovedRepairEpisode({ host, contract: e.contract, policy: p }).run()
    assert.equal(result.status, 'repair-budget'); assert.equal(result.solved, false); assert.equal(result.outcomes[0].diagnostic, null)
    assert.ok(result.outcomes[0].receipts.some((r) => r.subjectId === 'original')); assert.ok(result.outcomes[0].receipts.some((r) => r.subjectId === 'symptom' && r.status === 'fail')); restored(e)
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
