import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { createDemoEnvironment } from '../tools/evidence-demo.mjs'
let pass = 0, fail = 0, n = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-context-'))
function env(options = {}) {
  const base = path.join(home, 'case-' + (++n)), e = createDemoEnvironment({ root: path.join(base, 'ws'), directory: path.join(base, 'store'), withArchive: false })
  const verifier = I.createEvidenceVerifier({ contract: e.contract, root: e.adapter.root, observe: e.options.observe, perform: e.adapter.perform,
    readRevision: e.adapter.revision, readConditions: e.adapter.readConditions, allowEdits: true })
  const context = I.createEvidenceContext({ store: e.store, contract: e.contract, verifier, readRevision: e.adapter.revision, maxTokensEst: 131072, ...options })
  const program = I.createEvidenceProgram('只有本地类型化操作的说明，非原文尾巴。', { contract: e.contract, actionIds: ['fake-clock'], sessionId: e.store.sessionId })
  const binding = { ...I.evidenceBinding(program, I.initialEvidenceState(program, { roundId: 'manual', revision: e.adapter.revision() })) }
  return { ...e, verifier, context, program, binding }
}
async function execute(e, raw = '真实完整原文\n\ud800🙂') {
  const artifact = I.archiveEvidenceArtifact(e.store, { raw, program: e.program }), receipts = []
  let state = I.initialEvidenceState(e.program, e.binding)
  while (state.status === 'ready') {
    const step = e.program.steps[state.cursor], binding = I.evidenceBinding(e.program, state)
    const batch = state.phase === 'action' ? [e.verifier.action(step.action.id, binding)] : await Promise.all((state.phase === 'preconditions' ? step.preconditions : step.expectedObservations.map((x) => x.checkId)).map((id) => e.verifier.check(id, binding)))
    state = I.advanceEvidenceState(e.program, state, batch, e.verifier.authenticate); receipts.push(...batch)
  }
  const result = { ok: state.status === 'verified', status: state.status, artifactRef: artifact.indexRef, state, receipts }
  e.context.publish(e.program, result)
  return { ...result, raw }
}
try {
  await test('验证器/块仓权威不能用同形对象或 truthy 权限冒充', () => {
    const e = env(); assert.equal(I.isEvidenceVerifier(e.verifier), true); assert.equal(I.isEvidenceVerifier({ ...e.verifier }), false)
    assert.throws(() => I.createEvidenceContext({ ...e, contract: e.contract, store: e.store, readRevision: e.adapter.revision, verifier: { ...e.verifier } }), /authority/)
    assert.throws(() => env({ allowOptimizerReads: 'yes' }), /authority/)
    assert.throws(() => I.createEvidenceRuntime({ ...e.options, contextOptions: true }), /context-options/)
  })
  await test('逐槽审计区分机器完整核心与散文 unknown，不冒充 QAEval', () => {
    const e = env(); assert.equal(I.auditEvidenceSlots(e.program, e.contract).complete, true)
    const proposal = I.parseEvidenceProposal('验收命令是 `local verify`。预期：通过。', { calls: [{ name: 'edit_file', args: { path: 'fixture.js', old_text: 'old', new_text: 'new' } }] })
    const audit = I.auditEvidenceSlots(proposal, e.contract); assert.equal(audit.complete, false); assert.ok(audit.unknown > 0)
    assert.equal(I.auditEvidenceSlots({ steps: 'not an array' }).missing, 1)
  })
  await test('新鲜前置触发 pending，动作仅 executed，全部独立验收才 fulfilled', async () => {
    const e = env(), ledger = e.context.intents, id = ledger.define({ program: e.program, binding: e.binding, stepId: 'step-1' })
    const before = await e.verifier.check('original', e.binding); ledger.record([before]); assert.equal(ledger.view()[0].status, 'pending')
    const action = e.verifier.action('fake-clock', { ...e.binding, phase: 'action' }); ledger.record([action]); assert.equal(ledger.view()[0].status, 'executed')
    const b = { ...e.binding, phase: 'postconditions', revision: action.nextRevision }
    ledger.record([await e.verifier.check('clock-file', b)]); assert.equal(ledger.view()[0].status, 'executed')
    ledger.record([await e.verifier.check('symptom', b)]); assert.equal(ledger.view()[0].status, 'fulfilled'); assert.equal(ledger.cancel(id), false)
  })
  await test('未知/陈旧/错角色/伪造回执不触发；真回执后才可执行', async () => {
    const e = env(), l = e.context.intents; l.define({ program: e.program, binding: e.binding, stepId: 'step-1' })
    const fresh = await e.verifier.check('original', e.binding)
    l.record([{ ...fresh, signature: '0'.repeat(64) }, await e.verifier.check('original', { ...e.binding, revision: 'old' }), await e.verifier.check('event-order', e.binding)])
    assert.equal(l.view()[0].status, 'armed'); assert.equal(l.canExecute(e.program.id, 'manual', 'step-1'), false)
    l.record([fresh]); assert.equal(l.canExecute(e.program.id, 'manual', 'step-1'), true)
  })
  await test('取消/外部修订失效均不能执行，也不能用旧回执复活', async () => {
    const e = env(), l = e.context.intents, id = l.define({ program: e.program, binding: e.binding, stepId: 'step-1' }), r = await e.verifier.check('original', e.binding)
    l.record([r]); assert.equal(l.cancel(id), true); l.record([r]); assert.equal(l.canExecute(e.program.id, 'manual', 'step-1'), false)
    const x = env(), j = x.context.intents; j.define({ program: x.program, binding: x.binding, stepId: 'step-1' }); j.record([await x.verifier.check('original', x.binding)])
    fs.writeFileSync(path.join(x.adapter.root, 'fixture.js'), 'external'); assert.equal(j.canExecute(x.program.id, 'manual', 'step-1'), false); assert.equal(j.view()[0].reason, 'revision-changed')
  })
  await test('义务过期与失败关闭不允许延迟动作补跑', async () => {
    let now = 1000
    const e = env({ clock: () => now }), l = e.context.intents; l.define({ program: e.program, binding: e.binding, stepId: 'step-1', expiresAt: 1001 })
    l.record([await e.verifier.check('original', e.binding)]); now = 1002; assert.equal(l.canExecute(e.program.id, 'manual', 'step-1'), false); assert.equal(l.view()[0].reason, 'expired')
    const x = env(), j = x.context.intents; j.define({ program: x.program, binding: x.binding, stepId: 'step-1' }); j.invalidateRound('manual'); assert.equal(j.view()[0].status, 'invalidated')
  })
  await test('回执完整重放与源码验证权独立，不采信外部 ok=true', async () => {
    const e = env(), r = await execute(e)
    assert.deepEqual(I.replayEvidenceTrace(e.program, r.receipts, e.verifier), r.state)
    assert.throws(() => e.context.publish(e.program, { ...r, state: { ...r.state, cursor: 0 } }), /trace-mismatch/)
    const x = env(); const a = I.archiveEvidenceArtifact(x.store, { raw: 'r', program: x.program })
    assert.throws(() => x.context.publish(x.program, { ok: true, status: 'verified', artifactRef: a.indexRef, receipts: [] }), /unverified-claim/)
  })
  await test('L0/L1/L2 均完整可解，七个非空子集保持相同类型化核心', async () => {
    const e = env(); await execute(e); const frame = e.context.render({ levels: ['L0', 'L1', 'L2'] }); assert.equal(frame.ok, true)
    const refs = frame.layers.map((x) => x.ref), core = e.context.decode([refs[0]])
    assert.equal(core.slotAudit.complete, true); assert.deepEqual(core.steps, e.program.steps)
    for (let bits = 1; bits < 8; bits++) assert.deepEqual(e.context.decode(refs.filter((_, i) => bits & (1 << i))), core)
    assert.throws(() => e.context.decode([]), /subset/); assert.throws(() => e.context.decode([refs[0], refs[0]]), /subset/)
  })
  await test('预算不足拒绝整层，不输出抽取尾巴/部分核心/偷偷扣账', async () => {
    const e = env(); await execute(e); const before = e.context.view().budget
    const rejected = e.context.render({ levels: ['L0', 'L1', 'L2'], tokenBudgetEst: 1 }); assert.equal(rejected.ok, false); assert.equal(rejected.prefix, null); assert.deepEqual(rejected.layers, [])
    assert.deepEqual(e.context.view().budget, before)
  })
  await test('混周期/缺核心/非本管理器的伪层拒绝；旧单层不当作新周期', async () => {
    const e = env(), r = await execute(e), old = e.context.render({ levels: ['L0', 'L1'] })
    e.context.publish(e.program, r); const current = e.context.render({ levels: ['L2'] })
    assert.throws(() => e.context.decode([old.layers[0].ref, current.layers[0].ref]), /core-or-scope/)
    assert.throws(() => e.context.decode([old.layers[0].ref]), /core-or-scope/)
    const fake = e.store.putJson({ schema: 'cfb.evidence-description/1', level: 'L0' }, { kind: 'description' })
    assert.throws(() => e.context.decode([fake]), /authority/)
  })
  await test('已通过 RAW 与 EXPLANATION 逐字恢复，年龄/访问/实际扣账随调用变化', async () => {
    let now = 1000
    const e = env({ clock: () => now }), r = await execute(e, '原文完整\n\ud800🙂\0终点')
    now = 1200; const before = e.context.view().blocks.find((b) => b.type === 'RAW'); assert.equal(before.ageMs, 200); assert.equal(before.readCalls, 0)
    const got = e.context.readBlock(r.artifactRef, 'raw'); assert.equal(got.ok, true); assert.equal(got.value, r.raw)
    assert.equal(e.context.readBlock(r.artifactRef, 'explanation').value, e.program.explanation)
    const after = e.context.view().blocks.find((b) => b.type === 'RAW'); assert.equal(after.readCalls, 1); assert.equal(after.lastAccessAt, now)
    assert.ok(e.context.view().budget.tokensUsedEst > 0); assert.equal(e.context.view().budget.providerReportedUsage, null)
    assert.equal(e.context.readBlock(r.artifactRef, 'step-1').ok, true)
  })
  await test('失败 RAW/EXPLANATION 默认 solver/伪 optimizer 均拒绝，帧内没有失败故事', async () => {
    const e = env(), runtime = I.createEvidenceRuntime({ ...e.options, contextOptions: { maxTokensEst: 131072 } })
    const r = await runtime.runRound(runtime.program('失败独有故事TOKEN', ['raise-threshold']), { raw: '原始失败独有故事RAW' })
    for (const id of ['raw', 'explanation']) { assert.equal(runtime.readBlock(r.artifactRef, id).ok, false); assert.equal(runtime.readBlock(r.artifactRef, id, { role: 'optimizer' }).ok, false) }
    const frame = runtime.modelInput(); assert.equal(frame.ok, true); assert.equal(JSON.stringify(frame).includes('失败独有故事'), false)
    assert.ok(runtime.contextView().obligations.every((x) => x.status === 'invalidated'))
  })
  await test('宿主显式授权的 optimizer 可无损读失败块，但不能据此升级为已验收', async () => {
    const e = env(), runtime = I.createEvidenceRuntime({ ...e.options, contextOptions: { maxTokensEst: 131072, allowOptimizerReads: true } })
    const r = await runtime.runRound(runtime.program('失败全文', ['raise-threshold']), { raw: '失败原文完整' })
    assert.equal(runtime.readBlock(r.artifactRef, 'raw', { role: 'optimizer' }).value, '失败原文完整')
    assert.equal(runtime.readBlock(r.artifactRef, 'raw').ok, false)
    assert.equal(JSON.parse(runtime.modelInput().layers[0].text).core.cycle.verified, false)
  })
  await test('已认证历史回执与旧 RAW 在宿主修订后失效，不能冒充 fresh', async () => {
    const e = env(), r = await execute(e); fs.writeFileSync(path.join(e.adapter.root, 'fixture.js'), 'changed by owner')
    assert.equal(e.context.readBlock(r.artifactRef, 'raw').ok, false); assert.equal(e.context.render().reason, 'context-stale')
    assert.ok(e.context.view().blocks.every((x) => x.freshness === 'stale-revision'))
  })
  await test('块字节和 token 上限在读前拒绝，无负账/部分读回', async () => {
    const e = env({ maxReadBytes: 4 }), r = await execute(e, 'long original text')
    assert.equal(e.context.readBlock(r.artifactRef, 'raw').reason, 'block-read-budget')
    const x = env(), a = await execute(x); assert.equal(x.context.readBlock(a.artifactRef, 'raw', { tokenBudgetEst: 0 }).ok, false); assert.equal(x.context.view().budget.tokensUsedEst, 0)
  })
  await test('反馈仅接受本程序/轮次/角色的签名证据；动作不伪装验收，旧修订 unknown', async () => {
    const e = env(), r = await execute(e), binding = { ...e.binding, phase: 'diagnostic', revision: e.adapter.revision() }
    const diagnostic = await e.verifier.check('event-order', binding), wrongRound = await e.verifier.check('event-order', { ...binding, roundId: 'other' })
    const fb = I.binaryEvidenceFeedback({ program: e.program, receipts: r.receipts, diagnosticReceipts: [diagnostic, wrongRound, { ...diagnostic, signature: '0'.repeat(64) }], verifier: e.verifier, revision: e.adapter.revision() })
    assert.equal(fb.checks.filter((x) => x.role === 'diagnostic').length, 1)
    assert.equal(fb.checks.find((x) => x.checkId === 'original').status, 'unknown')
    assert.ok(fb.checks.filter((x) => x.role === 'acceptance').every((x) => x.status === 'pass')); assert.equal(fb.checks.some((x) => x.checkId === 'fake-clock'), false)
  })
  await test('原生两轮接线真实扣检查/修复预算，前缀字节不随轮次/动态帧变化', async () => {
    const e = env(), runtime = I.createEvidenceRuntime({ ...e.options, contextOptions: { maxTokensEst: 131072 } })
    await runtime.runRound(runtime.program('失败提议', ['raise-threshold']), { roundId: 'a' }); const first = runtime.modelInput()
    const secondResult = await runtime.runRound(runtime.program('另一个批准分支', ['fake-clock']), { roundId: 'b' }), second = runtime.modelInput()
    assert.equal(secondResult.ok, true); assert.equal(first.prefix, second.prefix)
    const core = JSON.parse(second.layers[0].text).core; assert.equal(core.budgets.rounds, 2); assert.equal(core.budgets.repairs, 2); assert.equal(core.budgets.checks, runtime.view().checks)
    assert.ok(runtime.contextView().obligations.some((x) => x.status === 'fulfilled')); assert.equal(core.cycle.verified, true)
  })
  await test('显式取消接入动作闸，前置已 pass 仍不允许执行取消的义务', async () => {
    const e = env(); let runtime
    // 用 observation 前置检查在等待期间取消；此时义务已经 armed，但动作尚未执行。
    const body = { task: 'cancel', version: '1', checks: [{ id: 'pre', role: 'precondition', kind: 'observation', predicate: { op: 'equals', field: 'ready', value: true } },
      { id: 'post', role: 'acceptance', kind: 'file', path: 'fixture.js', predicate: { op: 'includes', field: 'text', value: 'fake clock' } }], actions: [
      { id: 'edit', type: 'replace', path: 'fixture.js', oldText: '1600', newText: '1600 /* fake clock */', preconditions: ['pre'], checks: ['post'] }] }
    const contract = I.freezeEvidenceContract(body)
    runtime = I.createEvidenceRuntime({ ...e.options, contract, diagnosticModel: null, contextOptions: {}, observe: (check, binding) => {
      runtime.cancelObligation(runtime.contextView().obligations[0].id)
      return { value: { ready: true }, revision: binding.revision, roundId: binding.roundId, conditions: {} }
    } })
    const result = await runtime.runRound(runtime.program('cancel', ['edit']))
    assert.equal(result.ok, false); assert.equal(result.reason, 'obligation-not-ready'); assert.equal(fs.readFileSync(path.join(e.adapter.root, 'fixture.js'), 'utf8').includes('fake clock'), false)
    assert.equal(runtime.contextView().obligations[0].status, 'cancelled')
  })
  await test('侧车草稿可装配完整 proposed 核心，不自动执行/解锁未验证 RAW', () => {
    const e = env(), host = I.createEvidenceHost({ ...e.options, contextOptions: { maxTokensEst: 131072 } })
    host.captureDraft({ raw: 'RAW', text: '验收命令是 `local verify`。', sessionId: e.store.sessionId, calls: [{ name: 'edit_file', args: { path: 'fixture.js', old_text: 'const hedgeAfterMs = 1600;\n', new_text: 'const hedgeAfterMs = 1600; // fake clock\n' } }] })
    assert.equal(host.latest()[0].authorized, true); const frame = host.runtime.modelInput(); assert.equal(frame.ok, true)
    assert.equal(JSON.parse(frame.layers[0].text).core.cycle.status, 'proposed'); assert.equal(host.runtime.view().rounds, 0)
    assert.equal(host.runtime.readBlock(host.latest()[0].indexRef, 'raw').ok, false)
  })
  await test('空块不收费但仍有读次数硬上限，不能以零 token 无限读', async () => {
    const e = env({ maxReadCalls: 2 }), r = await execute(e, '')
    assert.equal(e.context.readBlock(r.artifactRef, 'raw').ok, true); assert.equal(e.context.readBlock(r.artifactRef, 'raw').ok, true)
    assert.equal(e.context.readBlock(r.artifactRef, 'raw').reason, 'read-call-budget'); assert.equal(e.context.view().budget.remainingReadCalls, 0)
  })
  await test('默认旧路不装配新上下文，不修改旧模型 view，公共 API/类型登记齐全', () => {
    const e = env(), r = I.createEvidenceRuntime(e.options); assert.equal(r.contextView(), null); assert.equal(r.modelInput().reason, 'context-disabled')
    assert.equal(r.readBlock('x', 'raw').reason, 'context-disabled'); assert.equal(r.cancelObligation('x'), false)
    const types = fs.readFileSync('index.d.ts', 'utf8'); for (const name of ['isEvidenceVerifier', 'createEvidenceIntents', 'replayEvidenceTrace', 'binaryEvidenceFeedback', 'auditEvidenceSlots', 'createEvidenceContext']) { assert.equal(typeof I[name], 'function'); assert.ok(types.includes('function ' + name)) }
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
