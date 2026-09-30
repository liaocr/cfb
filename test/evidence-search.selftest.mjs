import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import * as I from '../index.js'
import { localPolicyCandidates, localRobustSuite, runLocalEvidenceBench, LOCAL_SIGNATURE } from '../tools/local-evidence-bench.mjs'
let pass = 0, fail = 0, n = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-search-'))
const store = () => I.createEvidenceStore({ directory: path.join(home, 'case-' + (++n)), sessionId: 'library' })
const candidate = (body = 'good') => I.createMemoryCandidate({ kind: 'rule', body, signature: LOCAL_SIGNATURE, trigger: { op: 'equals', field: 'failed', value: true }, sources: ['unit-test-not-model-evidence'] })
const suite = () => I.freezeEffectSuite({ id: 'unit-search', evaluatorVersion: '1', ...Object.fromEntries(['train', 'selection', 'test'].map((split, j) => [split, Array.from({ length: 2 }, (_, i) => ({ id: split + ':' + i, family: 'f' + j, input: { token: j * 2 + i }, predicate: { op: 'equals', field: 'ok', value: true } }))])) })
let benchmark, benchmarkStore
try {
  await test('有界文档 add/delete/replace 与 stale 检测，不修改冻结头/必要槽', () => {
    const original = localPolicyCandidates().document
    const added = I.editEvidenceDocument(original, [{ type: 'add', id: 'note', text: '本地策略说明' }]).document
    const removed = I.editEvidenceDocument(added, [{ type: 'delete', id: 'note' }]).document; assert.deepEqual(removed, original)
    const changed = I.editEvidenceDocument(original, [{ type: 'replace', id: 'mode', expectedText: '{"mode":"idle"}', text: '{"mode":"checked"}' }])
    assert.deepEqual(changed.document.protected, original.protected); assert.ok(changed.changedChars > 0)
    assert.throws(() => I.editEvidenceDocument(original, [{ type: 'delete', id: 'mode' }]), /protected-section/)
    assert.throws(() => I.editEvidenceDocument(original, [{ type: 'replace', id: 'mode', expectedText: 'stale', text: 'new' }]), /edit-stale/)
    assert.throws(() => I.editEvidenceDocument(original, [{ type: 'replace', id: 'mode', path: 'protected.checks', text: 'weakened' }]), /protected/)
  })
  await test('改动字符/次数/最终体积/重复槽的硬上限，不能零预算加一大段', () => {
    const d = localPolicyCandidates().document
    assert.throws(() => I.editEvidenceDocument(d, [{ type: 'add', id: 'large', text: 'x'.repeat(257) }]), /budget/)
    assert.throws(() => I.editEvidenceDocument(d, [{ type: 'add', id: 'a', text: 'x' }], { maxEdits: 0 }), /budget/)
    assert.throws(() => I.editEvidenceDocument(d, [{ type: 'add', id: 'mode', text: 'x' }]), /edit-add/)
    assert.throws(() => I.editEvidenceDocument(d, [{ type: 'add', id: 'extra', text: 'x' }], { maxFinalChars: 1 }), /budget/)
  })
  await test('场景集实际 32/8/16:8:8，三切分族互斥，基座/字典不可变', () => {
    const s = I.createLocalEvidenceSuite(); assert.equal(s.train.length, 16); assert.equal(s.selection.length, 8); assert.equal(s.test.length, 8)
    const families = new Set([...s.train, ...s.selection, ...s.test].map((f) => f.family)); assert.equal(families.size, 8)
    assert.throws(() => I.LOCAL_EVIDENCE_FAMILIES.train.push('leak'), TypeError)
    const robust = localRobustSuite(s); assert.equal(robust.train.length + robust.selection.length + robust.test.length, 96)
    assert.throws(() => I.parseLocalEvidencePolicy({ body: '{"mode":"checked","weakenChecks":true}' }), /policy-space/)
  })
  await test('本地 S0/有界策略搜索实执行 336 案例，基座/扰动/交换均 32/32、观察器 336/336', async () => {
    benchmarkStore = store(); benchmark = await runLocalEvidenceBench({ store: benchmarkStore })
    assert.deepEqual(benchmark.baseline, { n: 16, total: 32, unknown: 0 })
    for (const field of ['checked', 'formattingPerturbation', 'evaluatorSwap']) assert.deepEqual(benchmark[field], { n: 32, total: 32, unknown: 0 })
    assert.deepEqual(benchmark.observerAgreement, { n: 336, total: 336 }); assert.equal(benchmark.runtimeCases, 336); assert.equal(benchmark.localOracleProcesses, 336)
    assert.equal(benchmark.loopbackRequests, 18); assert.equal(benchmark.externalApiCalls, 0); assert.equal(benchmark.modelCalls, 0)
    assert.equal(benchmark.search.counters.candidates, 3); assert.equal(benchmark.search.counters.duplicates, 1); assert.equal(benchmark.search.counters.testEvaluations, 48)
    assert.equal(benchmark.acceptedChecked, true); assert.equal(benchmark.rejectedUnchecked.reason, 'regression-train')
    fs.mkdirSync('.cfb-runtime/local-evidence', { recursive: true }); fs.writeFileSync('.cfb-runtime/local-evidence/latest-regression.json', JSON.stringify(benchmark, null, 2) + '\n')
  })
  await test('模型身份/指纹不等价、源码漂移、命令非零/输出爆量，真实拒绝并恢复受管状态', () => {
    assert.ok(benchmark)
    const selected = localPolicyCandidates().checked.id
    for (const family of ['model-identity', 'source-integrity', 'command-output', 'rollback-recovery']) {
      const controls = benchmark.search.records.filter((r) => r.candidateId === selected && r.fixtureId.startsWith(family + ':') && r.fixtureId.endsWith(':base') && r.inputDigest && r.output.actualVerified === false)
      assert.equal(controls.length, 2, family); assert.ok(controls.every((r) => r.output.correct === true && r.output.managedStateRestored === true), family)
    }
  })
  await test('实际档案重建后保留通过规则与消费族，换 cycle 仍不能读同族盲测', () => {
    const archive = I.createEvidenceArchive({ store: benchmarkStore }); assert.equal(archive.snapshot().active.length, 1)
    assert.equal(archive.retrieve({ signature: LOCAL_SIGNATURE, observation: { failed: true } }).length, 1)
    let testReads = 0
    archive.beginCycle({ suite: localRobustSuite(), evaluate: (c, input) => { if (['model-identity', 'command-output'].includes(input.family)) testReads++; return { correct: c !== null } } })
    archive.consider(localPolicyCandidates().checked); assert.throws(() => archive.finalize(), /holdout-already-consumed/); assert.equal(testReads, 0)
  })
  await test('重复拒绝只评估一次；全拒绝不读 test、不消耗盲测', async () => {
    const s = store(), bad = candidate('bad'); let calls = 0
    const result = await I.runEvidenceSearch({ store: s, suite: suite(), candidates: [bad, bad], evaluateAsync: () => { calls++; return {} } })
    assert.equal(calls, 8); assert.equal(result.counters.duplicates, 1); assert.equal(result.counters.testEvaluations, 0); assert.equal(result.final.length, 0)
    assert.equal(s.readHead('effect-holdouts'), null)
  })
  await test('异步盲测在执行器运行前已有持久预占，不先偷看 test 再 finalize', async () => {
    const s = store(), data = suite(), testTokens = new Set(data.test.map((f) => f.input.token)); let reads = 0
    const result = await I.runEvidenceSearch({ store: s, suite: data, candidates: [candidate()], evaluateAsync: (entry, input) => {
      if (testTokens.has(input.token)) { reads++; assert.ok(s.readHead('effect-holdouts')) }
      return { ok: entry !== null }
    } })
    assert.equal(reads, 4); assert.equal(result.final[0].gate.ok, true); assert.equal(result.activeIds.length, 1)
  })
  await test('同源码/环境指纹跨周期复用拒绝缓冲，版本变化重新评估，不缓存成永久真理', async () => {
    const s = store(), data = suite(), c = candidate('bad'); let allow = false, calls = 0
    const evaluateAsync = (entry) => { calls++; return { ok: entry !== null && allow } }
    const scope = I.evidenceDigest({ environment: 'initial' })
    await I.runEvidenceSearch({ store: s, suite: data, candidates: [c], evaluateAsync, evaluationScope: scope }); const before = calls
    const cached = await I.runEvidenceSearch({ store: s, suite: data, candidates: [c], evaluateAsync, evaluationScope: scope }); assert.equal(calls, before); assert.equal(cached.counters.priorRejections, 1)
    allow = true
    const changed = await I.runEvidenceSearch({ store: s, suite: data, candidates: [c], evaluateAsync, evaluationScope: I.evidenceDigest({ environment: 'changed' }) })
    assert.ok(calls > before); assert.equal(changed.counters.priorRejections, 0); assert.equal(changed.final[0].gate.ok, true)
  })
  await test('无环境指纹不跨周期跳过旧失败，宿主不能靠 closure 字符串自证环境不变', async () => {
    const s = store(), c = candidate('bad'); let calls = 0
    const evaluateAsync = () => { calls++; return {} }
    await I.runEvidenceSearch({ store: s, suite: suite(), candidates: [c], evaluateAsync }); const before = calls
    await I.runEvidenceSearch({ store: s, suite: suite(), candidates: [c], evaluateAsync }); assert.ok(calls > before); assert.equal(s.readHead('search-rejections'), null)
  })
  await test('评估预算在新的执行前拒绝，没有留出/入库/绕过硬限', async () => {
    const s = store(); let calls = 0
    await assert.rejects(I.runEvidenceSearch({ store: s, suite: suite(), candidates: [candidate()], maxEvaluations: 1, evaluateAsync: () => { calls++; return { ok: false } } }), /evaluation-budget/)
    assert.equal(calls, 1); assert.equal(s.readHead('effect-holdouts'), null)
    await assert.rejects(I.runEvidenceSearch({ store: s, suite: suite(), candidates: [], maxCandidates: 9, evaluateAsync: () => ({}) }), /budget/)
  })
  await test('异步超时/不合法 JSON 一律 unknown，不提升、不运行 test', async () => {
    const s = store(), timed = await I.runEvidenceSearch({ store: s, suite: suite(), candidates: [candidate()], evaluationTimeoutMs: 3, evaluateAsync: () => new Promise(() => {}) })
    assert.equal(timed.screened[0].gate.reason, 'unknown-train'); assert.equal(timed.counters.testEvaluations, 0)
    const invalid = await I.runEvidenceSearch({ store: store(), suite: suite(), candidates: [candidate()], evaluateAsync: () => undefined })
    assert.equal(invalid.screened[0].gate.reason, 'unknown-train')
  })
  await test('任一扰动/交换负项 veto，不用总分抵消', () => {
    const effects = ['train', 'selection', 'test'].flatMap((split) => [{ fixtureId: split + '+', family: split, split, before: false, after: true, sign: '+' }])
    effects.push({ fixtureId: 'swap-negative', family: 'test', split: 'test', before: true, after: false, sign: '-' })
    assert.equal(I.gateSignedEffects(effects).reason, 'regression-test')
  })
  await test('复发问题队列认证原记录、去重、限额、排序、恢复及解决状态持久化', () => {
    const s = store(), issues = I.createEvidenceIssues({ store: s, maxIssues: 2 })
    const record = (x) => s.putJson({ schema: 'cfb.search-record/1', x }, { kind: 'search-record' })
    const first = record(1), args = { signature: LOCAL_SIGNATURE, family: 'recurring', component: 'base', reason: 'unknown-train', evidenceRef: first }
    assert.equal(issues.record(args), true); assert.equal(issues.record(args), false); issues.record({ ...args, evidenceRef: record(2) })
    issues.record({ ...args, family: 'rare', evidenceRef: record(3) }); issues.record({ ...args, family: 'rare2', evidenceRef: record(4) })
    assert.equal(issues.view().length, 2); assert.equal(issues.view()[0].count, 2); issues.resolve(issues.view()[0].id); issues.persist()
    const next = I.createEvidenceIssues({ store: s, maxIssues: 2 }); assert.equal(next.view()[0].status, 'resolved'); assert.equal(next.record(args), false)
    assert.throws(() => next.record({ ...args, evidenceRef: s.putJson({ x: 3 }, { kind: 'other' }) }), /kind/)
    assert.ok(benchmark.recurrentIssues > 0)
  })
  await test('独立子进程观察器丢失不能被归为 false 再冒充改进，输出缺槽保持 unknown', async () => {
    const original = cp.spawnSync
    try {
      cp.spawnSync = () => ({ status: null, stdout: '', error: new Error('oracle-down') }); syncBuiltinESMExports()
      const output = await I.executeLocalEvidenceCase(localPolicyCandidates().checked, { family: 'file-precondition', variant: 0 })
      assert.equal(output.primary, true); assert.equal(Object.hasOwn(output, 'correct'), false)
      assert.equal(I.evaluateEvidencePredicate({ op: 'equals', field: 'correct', value: true }, output), null)
    } finally { cp.spawnSync = original; syncBuiltinESMExports() }
  })
  await test('已有成对数据按真实分母统计；没有模型答案就是 unknown，不伪装 forced answering', () => {
    const measured = I.compareEvidencePairs([{ id: 'one', before: { answer: { x: 1 }, action: false }, after: { answer: { x: 1 }, action: true } },
      { id: 'two', before: { answer: 'a', action: true }, after: { answer: 'b', action: true } }, { id: 'missing', before: {}, after: {} }])
    assert.deepEqual(measured.answerUnchanged, { n: 1, total: 2, unknown: 1 }); assert.deepEqual(measured.actionChanged, { n: 1, total: 2, unknown: 1 })
    assert.deepEqual(benchmark.paired.answerUnchanged, { n: 0, total: 0, unknown: 32 }); assert.deepEqual(benchmark.paired.actionChanged, { n: 16, total: 32, unknown: 0 })
  })
  await test('公共 API/类型声明齐全，运行物不纳入 Git/manifest，没有外部服务地址', () => {
    const types = fs.readFileSync('index.d.ts', 'utf8')
    for (const name of ['createLocalEvidenceSuite', 'parseLocalEvidencePolicy', 'executeLocalEvidenceCase', 'createEvidenceDocument', 'editEvidenceDocument', 'createEvidenceIssues', 'compareEvidencePairs', 'runEvidenceSearch']) { assert.equal(typeof I[name], 'function'); assert.ok(types.includes('function ' + name)) }
    assert.ok(fs.readFileSync('.gitignore', 'utf8').includes('.cfb-runtime/'))
    assert.ok(benchmark.search.records.every((r) => r.output.externalApiCalls === 0))
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
