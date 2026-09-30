// R3：独立冻结留出、逐项符号、拒绝/退役卫生。没有 Likert、模型或外网。
import assert from 'node:assert/strict'
import * as I from '../index.js'
import { effectFixtureSuite, effectFixtureEvaluator, memorySignature, memoryCandidate } from './helpers/evidence-fixtures.mjs'
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const suite = effectFixtureSuite(), context = { signature: memorySignature, observation: { failed: true } }
const cycle = (over = {}) => I.createEffectCycle({ suite, evaluate: effectFixtureEvaluator, registry: I.createHoldoutRegistry(), ...over })
const archive = (over = {}) => { const a = I.createEvidenceArchive(over); a.beginCycle({ suite, evaluate: effectFixtureEvaluator }); return a }
await test('24 人写夹具、六族三切分完全隔离，哈希冻结', () => {
  assert.equal(suite.train.length + suite.selection.length + suite.test.length, 24)
  assert.equal(new Set([...suite.train, ...suite.selection, ...suite.test].map((x) => x.family)).size, 6)
  assert.throws(() => { suite.test[0].predicate.value = false })
  const def = JSON.parse(JSON.stringify(suite)); delete def.schema; delete def.digest; delete def.testDigest
  def.test[0].family = def.train[0].family; assert.throws(() => I.freezeEffectSuite(def), /family-leakage/)
  def.test[0].family = 'other'; def.test[0].id = def.train[0].id; assert.throws(() => I.freezeEffectSuite(def), /fixture-schema/)
  def.test = []; assert.throws(() => I.freezeEffectSuite(def), /suite-split/)
})
await test('规则/事实/疫苗都有内容签名/来源/触发，拒绝不合法 DSL 与空来源', () => {
  for (const kind of ['rule', 'fact', 'vaccine']) assert.equal(memoryCandidate({ kind }).kind, kind)
  const base = { kind: 'rule', body: 'strict', signature: memorySignature, sources: ['human'], trigger: { op: 'equals', field: 'failed', value: true } }
  for (const over of [{ kind: 'self-score' }, { body: '' }, { sources: [] }, { signature: {} }, { trigger: { op: 'regex', field: 'x', value: '.*' } }, { expiresAt: NaN }]) assert.throws(() => I.createMemoryCandidate({ ...base, ...over }))
  assert.equal(memoryCandidate().id, memoryCandidate().id)
})
await test('逐项符号 +/0/-/?；负项不能被正项抵消，selection/test 平局拒绝', () => {
  const effects = ['train', 'selection', 'test'].flatMap((split) => [{ split, sign: '+' }, { split, sign: '0' }])
  assert.equal(I.gateSignedEffects(effects).ok, true)
  assert.equal(I.gateSignedEffects([...effects, { split: 'selection', sign: '-' }]).reason, 'regression-selection')
  assert.equal(I.gateSignedEffects(effects.map((x) => x.split === 'selection' ? { ...x, sign: '0' } : x)).reason, 'tie-selection')
  assert.equal(I.gateSignedEffects(effects.map((x) => x.split === 'test' ? { ...x, sign: '?' } : x)).reason, 'unknown-test')
  assert.equal(I.gateSignedEffects(effects.filter((x) => x.split !== 'test')).reason, 'missing-test')
})
await test('screen 不碰盲测，也不把 split/期望输出给候选执行器', () => {
  let n = 0
  const c = cycle({ evaluate: (entry, input) => { n++; assert.equal(input.split, undefined); assert.equal(input.predicate, undefined); return effectFixtureEvaluator(entry, input) } })
  const report = c.screen(memoryCandidate())
  assert.equal(n, 32); assert.equal(report.effects.length, 16)
  assert.ok(report.effects.every((x) => x.split !== 'test')); assert.equal(c.authenticate(report), true)
  assert.equal(c.authenticate({ ...report, gate: { ok: true } }), false)
  assert.equal(c.view().closed, false)
})
await test('严格通过留出后才入库；逐项效果记录 24 行，默认只检索一条', () => {
  const a = archive(), entry = memoryCandidate()
  const screen = a.consider(entry); assert.equal(screen.gate.ok, true)
  assert.deepEqual(a.retrieve(context), [])
  const [final] = a.finalize(); assert.equal(final.gate.ok, true); assert.equal(final.effects.length, 24)
  assert.equal(a.snapshot().active.length, 1); assert.equal(a.snapshot().active[0].effects.filter((x) => x.sign === '+').length, 12)
  assert.equal(a.retrieve(context)[0].id, entry.id)
  assert.throws(() => a.retrieve(context, { k: 2 }), /retrieval-budget/)
})
await test('三种记忆逐项接受/记录，不靠合并后的总分掩盖损害', () => {
  const a = archive()
  for (const kind of ['rule', 'fact', 'vaccine']) assert.equal(a.consider(memoryCandidate({ kind })).gate.ok, true)
  a.finalize()
  assert.equal(a.snapshot().active.length, 3)
  assert.deepEqual(new Set(a.snapshot().active.map((x) => x.entry.kind)), new Set(['rule', 'fact', 'vaccine']))
  assert.equal(a.retrieve(context).length, 1)
})
await test('平局/回归/未知候选进入拒绝缓冲；全拒绝可关周期，未消耗盲测', () => {
  const a = archive()
  for (const body of ['tie', 'regress', 'unknown']) assert.equal(a.consider(memoryCandidate({ body })).gate.ok, false)
  assert.equal(a.snapshot().rejected.length, 3); assert.equal(a.snapshot().active.length, 0)
  assert.deepEqual(a.finalize(), []); assert.deepEqual(a.snapshot().heldoutFamiliesSpent, [])
  assert.throws(() => a.consider(memoryCandidate()), /cycle-closed/)
  a.beginCycle({ suite, evaluate: effectFixtureEvaluator }); assert.equal(a.consider(memoryCandidate()).gate.ok, true)
})
await test('selection 过拟合被最后盲测平局拒绝，不可再用测试搜索', () => {
  const a = archive(), entry = memoryCandidate({ body: 'selection-only' })
  assert.equal(a.consider(entry).gate.ok, true)
  assert.equal(a.finalize()[0].gate.reason, 'tie-test')
  assert.equal(a.snapshot().active.length, 0); assert.equal(a.snapshot().rejected[0].reason, 'tie-test')
  a.beginCycle({ suite, evaluate: effectFixtureEvaluator }); a.consider(memoryCandidate())
  assert.throws(() => a.finalize(), /holdout-already-consumed/)
})
await test('同周期只关盲测一次；旧证书/新周期/篡改证书均不能认证', () => {
  const c = cycle(), e = memoryCandidate(); c.screen(e)
  const [r] = c.finalize([e.id]); assert.equal(c.authenticate(r), true)
  assert.throws(() => c.finalize([e.id]), /cycle-closed/)
  assert.throws(() => c.screen(memoryCandidate({ kind: 'fact' })), /cycle-closed/)
  assert.equal(cycle().authenticate(r), false)
  assert.equal(c.authenticate({ ...r, effects: [] }), false)
})
await test('候选预算、近重复去重、档案/拒绝缓冲容量有界', () => {
  const c = cycle({ maxCandidates: 1 }); c.screen(memoryCandidate()); c.screen(memoryCandidate())
  assert.equal(c.view().attempts, 1); assert.throws(() => c.screen(memoryCandidate({ kind: 'fact' })), /candidate-budget/)
  const a = archive({ maxEntries: 1, maxRejected: 1 })
  a.consider(memoryCandidate()); a.consider(memoryCandidate({ kind: 'fact' })); a.finalize()
  assert.equal(a.snapshot().active.length, 1); assert.equal(a.snapshot().rejected.length, 1)
  assert.equal(a.snapshot().rejected[0].reason, 'archive-capacity')
  const b = archive({ maxRejected: 1 }); b.consider(memoryCandidate({ body: 'tie' })); b.consider(memoryCandidate({ body: 'unknown' }))
  assert.equal(b.snapshot().rejected.length, 1)
})
await test('指纹不等、触发缺失、过期不检索；反例退役不再出现', () => {
  let now = 5
  const a = archive({ clock: () => now }), e = memoryCandidate({ expiresAt: 10 })
  a.consider(e); a.finalize(); assert.equal(a.retrieve(context).length, 1)
  assert.equal(a.retrieve({ ...context, signature: { ...memorySignature, environment: 'node-v2' } }).length, 0)
  assert.equal(a.retrieve({ ...context, observation: {} }).length, 0)
  now = 10; assert.equal(a.retrieve(context).length, 0); now = 5
  assert.equal(a.retire(e.id, 'fresh counterexample'), true); assert.equal(a.retrieve(context).length, 0)
  assert.equal(a.snapshot().retired[0].reason, 'fresh counterexample')
  assert.equal(a.retire('missing'), false)
})
await test('签名档案快照可无损序列化，不把拒绝/失败正文混进检索', () => {
  const a = archive(); a.consider(memoryCandidate()); a.consider(memoryCandidate({ kind: 'vaccine', body: 'regress' })); a.finalize()
  const snapshot = a.snapshot(); assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  const visible = JSON.stringify(a.retrieve(context)); assert.ok(!visible.includes('regress')); assert.ok(!visible.includes('effects'))
  assert.throws(() => { snapshot.active[0].entry.body = 'changed' })
})
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
