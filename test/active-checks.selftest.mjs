// R2 的概率计算、宿主诊断闭环和预算。没有模型调用。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-active-'))
const prior = { delayed: 0.5, race: 0.5 }
const clear = { delayed: { pass: 0, fail: 1 }, race: { pass: 1, fail: 0 } }
const noisy = { delayed: { pass: 0.1, fail: 0.9 }, race: { pass: 0.9, fail: 0.1 } }
const noise = { delayed: { pass: 0.5, fail: 0.5 }, race: { pass: 0.5, fail: 0.5 } }
const contract = I.freezeEvidenceContract({ task: 'flaky-fixture', version: '1', checks: [
  { id: 'event-order', kind: 'observation', role: 'diagnostic', predicate: { op: 'before', field: 'primaryAt', other: 'hedgeAt' } },
  { id: 'same-green', kind: 'observation', role: 'diagnostic', predicate: { op: 'equals', field: 'green', value: true } },
  { id: 'coarse-clock', kind: 'observation', role: 'diagnostic', predicate: { op: 'equals', field: 'earlier', value: true } },
  { id: 'accept', kind: 'observation', role: 'acceptance', predicate: { op: 'equals', field: 'fixed', value: true } },
], actions: [{ id: 'observe', type: 'observe', preconditions: [], checks: ['accept'] }] })
const bind = { sessionId: 's', programId: 'p', contractDigest: contract.digest, roundId: 'r', revision: 'v', stepId: 'step-1', phase: 'diagnostic' }
const model = (probes) => I.freezeDiagnosticModel({ prior, probes }, contract)
try {
  await test('二元熵 1 bit、单一假设 0 bit，拒绝负数/空/零/非有限', () => {
    assert.equal(I.evidenceEntropy(prior), 1); assert.equal(I.evidenceEntropy({ only: 1 }), 0)
    for (const p of [{}, { a: 0 }, { a: -1 }, { a: NaN }, { a: Infinity }]) assert.throws(() => I.evidenceEntropy(p))
  })
  await test('完整 EIG：确定性 1、纯噪声 0、0.9 通道约 0.531，不是 H(Y)', () => {
    assert.equal(I.expectedEvidenceGain(prior, clear), 1)
    assert.equal(I.expectedEvidenceGain(prior, noise), 0)
    assert.ok(Math.abs(I.expectedEvidenceGain(prior, noisy) - 0.5310044064107188) < 1e-12)
    // 两者的输出熵都是 1；只有扣掉 H(Y|H) 才能分辨。
    assert.ok(I.expectedEvidenceGain(prior, noisy) > I.expectedEvidenceGain(prior, noise))
  })
  await test('贝叶斯更新方向正确，未知/不可能输出不捏造 posterior', () => {
    assert.deepEqual(I.evidencePosterior(prior, clear, 'pass').prior, { delayed: 0, race: 1 })
    assert.deepEqual(I.evidencePosterior(prior, clear, 'fail').prior, { delayed: 1, race: 0 })
    assert.equal(I.evidencePosterior(prior, clear, 'unknown').ok, false)
    assert.equal(I.evidencePosterior({ delayed: 1, race: 0 }, clear, 'pass').reason, 'impossible-outcome')
  })
  await test('似然必须完整归一化；不允许增加未知假设/输出', () => {
    for (const l of [{ delayed: clear.delayed }, { ...clear, race: { pass: 0.5, fail: 0.6 } }, { ...clear, race: { pass: 1 } }, { ...clear, race: { pass: 1, fail: 0, unknown: 0 } }]) assert.throws(() => I.expectedEvidenceGain(prior, l))
  })
  await test('只能引用冻结宿主 diagnostic，不能用 acceptance 来绕门', () => {
    assert.throws(() => model([{ checkId: 'accept', cost: 1, likelihood: clear }]), /capability/)
    assert.throws(() => model([{ checkId: 'invented', cost: 1, likelihood: clear }]), /capability/)
    assert.throws(() => model([{ checkId: 'event-order', cost: 0, likelihood: clear }]), /capability/)
    const m = model([{ checkId: 'event-order', cost: 1, likelihood: clear }])
    assert.throws(() => I.createDiagnosticController({ model: { ...m, prior: { delayed: 1, race: 0 } }, contract }), /drift/)
  })
  await test('预算内选最大 EIG，而不是最大输出熵或最短命令', () => {
    const m = model([{ checkId: 'event-order', cost: 4, likelihood: clear }, { checkId: 'same-green', cost: 0.5, likelihood: noise }, { checkId: 'coarse-clock', cost: 1, likelihood: noisy }])
    assert.equal(I.createDiagnosticController({ model: m, contract, maxCost: 4 }).choose(bind).selected.checkId, 'event-order')
    assert.equal(I.createDiagnosticController({ model: m, contract, maxCost: 1 }).choose(bind).selected.checkId, 'coarse-clock')
  })
  await test('检查/成本双预算、无信息/无可选项均停止，无隐形调用', () => {
    const m = model([{ checkId: 'event-order', cost: 1, likelihood: clear }])
    assert.equal(I.createDiagnosticController({ model: m, contract, maxChecks: 0 }).choose(bind).reason, 'check-budget')
    assert.equal(I.createDiagnosticController({ model: m, contract, maxCost: 0 }).choose(bind).reason, 'no-eligible-check')
    assert.equal(I.createDiagnosticController({ model: model([{ checkId: 'same-green', cost: 1, likelihood: noise }]), contract }).choose(bind).reason, 'no-information')
    assert.throws(() => I.createDiagnosticController({ model: m, contract, maxChecks: 17 }), /budget/)
  })
  await test('真实签名诊断回执更新 posterior，诊断不改变原验收状态', async () => {
    let calls = 0
    const verifier = I.createEvidenceVerifier({ contract, root, observe: (c, b) => { calls++; return { value: { primaryAt: 10, hedgeAt: 20 }, roundId: b.roundId, revision: b.revision, conditions: {} } } })
    const controller = I.createDiagnosticController({ model: model([{ checkId: 'event-order', cost: 1, likelihood: clear }]), contract })
    const r = await I.runActiveEvidenceChecks({ controller, verifier, binding: bind })
    assert.equal(calls, 1); assert.equal(r.receipts[0].status, 'pass')
    assert.deepEqual(r.state.prior, { delayed: 0, race: 1 }); assert.equal(r.acceptanceUnchanged, true)
    const p = I.createEvidenceProgram('未修复', { contract, actionIds: ['observe'], sessionId: 's' }), s = { ...I.initialEvidenceState(p, { roundId: 'r', revision: 'v' }), phase: 'postconditions' }
    assert.equal(I.advanceEvidenceState(p, s, r.receipts, verifier.authenticate).status, 'blocked')
  })
  await test('未知观测不更新假设，且同环境同检查不重跑', async () => {
    let calls = 0
    const verifier = I.createEvidenceVerifier({ contract, root, observe: () => { calls++; return { error: 'unavailable' } } })
    const controller = I.createDiagnosticController({ model: model([{ checkId: 'event-order', cost: 1, likelihood: noisy }]), contract })
    const r = await I.runActiveEvidenceChecks({ controller, verifier, binding: bind })
    assert.equal(calls, 1); assert.deepEqual(r.state.prior, prior); assert.equal(r.state.history[0].posteriorApplied, false)
    assert.equal(controller.choose(bind).ok, false)
    assert.equal(controller.choose({ ...bind, revision: 'changed' }).ok, true)
  })
  await test('待回执不再发起；伪回执停止且不会建立事实', () => {
    const controller = I.createDiagnosticController({ model: model([{ checkId: 'event-order', cost: 1, likelihood: clear }]), contract })
    controller.choose(bind); assert.equal(controller.choose(bind).reason, 'awaiting-receipt')
    const s = controller.record({ subjectId: 'event-order', binding: bind, status: 'pass' }, () => false)
    assert.equal(s.stopped, 'invalid-diagnostic-receipt'); assert.deepEqual(s.prior, prior)
    assert.throws(() => controller.record({}, () => true), /no-pending/)
  })
  await test('固定检查顺序构造即冻结，不受调用方数组后改影响', () => {
    const order = ['coarse-clock', 'event-order'], m = model([{ checkId: 'event-order', cost: 1, likelihood: noisy }, { checkId: 'coarse-clock', cost: 1, likelihood: noisy }])
    const c = I.createDiagnosticController({ model: m, contract, strategy: 'fixed', checkOrder: order })
    order.reverse(); assert.equal(c.choose(bind).selected.checkId, 'coarse-clock')
  })
  await test('认证要求同步true，truthy/Promise/异常不得更新后验', () => {
    for (const authenticate of [() => 1, () => 'yes', () => Promise.resolve(true), async () => true, () => { throw new Error('invalid') }]) {
      const c = I.createDiagnosticController({ model: model([{ checkId: 'event-order', cost: 1, likelihood: clear }]), contract })
      c.choose(bind); const state = c.record({ subjectId: 'event-order', binding: bind, status: 'pass', id: 'not-certified' }, authenticate)
      assert.equal(state.stopped, 'invalid-diagnostic-receipt'); assert.deepEqual(state.prior, prior); assert.equal(state.history.length, 0)
    }
  })
  await test('可选unknown首个即停，默认继续探测不变，未知不更新后验', async () => {
    const m = model([{ checkId: 'event-order', cost: 1, likelihood: noisy }, { checkId: 'coarse-clock', cost: 1, likelihood: noisy }])
    for (const stopOnUnknown of [false, true]) {
      const c = I.createDiagnosticController({ model: m, contract, stopOnUnknown }), v = I.createEvidenceVerifier({ contract, root, observe: () => ({ error: 'unavailable' }) })
      const r = await I.runActiveEvidenceChecks({ controller: c, verifier: v, binding: bind })
      assert.equal(r.receipts.length, stopOnUnknown ? 1 : 2); assert.deepEqual(r.state.prior, prior)
      if (stopOnUnknown) assert.equal(r.state.stopped, 'unknown-evidence')
    }
    assert.throws(() => I.createDiagnosticController({ model: m, contract, stopOnUnknown: 'yes' }), /strategy/)
  })
  await test('跨会话/制品/轮次不能复用诊断预算/假设，已中断零检查', async () => {
    const m = model([{ checkId: 'event-order', cost: 1, likelihood: clear }]), controller = I.createDiagnosticController({ model: m, contract })
    controller.choose(bind)
    assert.throws(() => controller.choose({ ...bind, sessionId: 'other' }), /scope-change/)
    const abort = new AbortController(); abort.abort()
    const r = await I.runActiveEvidenceChecks({ controller: I.createDiagnosticController({ model: m, contract }), verifier: { check: () => { throw new Error('not called') } }, binding: bind, signal: abort.signal })
    assert.equal(r.receipts.length, 0); assert.equal(r.state.count, 0)
  })
} finally { fs.rmSync(root, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
