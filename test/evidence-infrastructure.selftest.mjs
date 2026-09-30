import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { effectFixtureSuite, effectFixtureEvaluator, memoryCandidate, memorySignature } from './helpers/evidence-fixtures.mjs'
let pass = 0, fail = 0, n = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-evidence-infra-'))
const store = () => I.createEvidenceStore({ directory: path.join(home, 'case-' + (++n)), sessionId: 'library' })
try {
  test('签名命名 head 重启可发现，引用不能跨会话，名字不能越界', () => {
    const s = store(), ref = s.putJson({ value: 1 }), first = s.setHead('latest', ref, { expectedRevision: null })
    assert.equal(first.sequence, 1); assert.equal(s.readHead('latest').ref, ref)
    const recovered = I.createEvidenceStore({ directory: path.dirname(s.directory), sessionId: 'library' })
    assert.deepEqual(recovered.readHead('latest'), first)
    assert.throws(() => s.setHead('../bad', ref, { expectedRevision: null }), /head-name/)
    const other = I.createEvidenceStore({ directory: path.dirname(s.directory), sessionId: 'other' })
    assert.throws(() => other.setHead('latest', ref, { expectedRevision: null }), /handle-session/)
  })
  test('CAS 必须提供匹配的前版本，ABA/旧写者不能覆盖新 head', () => {
    const s = store(), a = s.put('a'), b = s.put('b')
    assert.throws(() => s.setHead('latest', a), /head-conflict/)
    const first = s.setHead('latest', a, { expectedRevision: null })
    const second = s.setHead('latest', b, { expectedRevision: first.revision })
    const third = s.setHead('latest', a, { expectedRevision: second.revision })
    assert.notEqual(third.revision, first.revision)
    assert.throws(() => s.setHead('latest', b, { expectedRevision: first.revision }), /head-conflict/)
    assert.equal(s.readHead('latest').ref, a)
    fs.writeFileSync(path.join(s.directory, '.head-latest.json.lock'), '')
    assert.throws(() => s.setHead('latest', b, { expectedRevision: third.revision }), /head-conflict/)
    fs.unlinkSync(path.join(s.directory, '.head-latest.json.lock'))
  })
  test('head 损坏不能凭同内容哈希冒充认证；不静默回退空库', () => {
    const s = store(), ref = s.put('safe'); s.setHead('latest', ref, { expectedRevision: null })
    const file = path.join(s.directory, '.head-latest.json'), head = JSON.parse(fs.readFileSync(file))
    head.sequence++; const { revision, signature, ...body } = head; head.revision = I.evidenceDigest(body)
    fs.writeFileSync(file, JSON.stringify(head)); assert.throws(() => s.readHead('latest'), /head-integrity/)
  })
  test('盲测可提前预占；预占后不再允许候选选择，未知结果不会返还任务族', () => {
    const s = store(), a = I.createEvidenceArchive({ store: s }), suite = effectFixtureSuite()
    let testReads = 0
    const evaluate = (candidate, input) => { if (suite.test.some((f) => I.evidenceDigest(f.input) === I.evidenceDigest(input))) testReads++; return effectFixtureEvaluator(candidate, input) }
    a.beginCycle({ suite, evaluate }); assert.throws(() => a.reserveHoldout(), /no-finalists/)
    a.consider(memoryCandidate()); a.reserveHoldout(); assert.equal(testReads, 0)
    assert.throws(() => a.consider(memoryCandidate({ kind: 'fact' })), /closed-for-selection/)
    assert.ok(s.readHead('effect-holdouts'))
    const recreated = I.createEvidenceArchive({ store: s })
    recreated.beginCycle({ suite, evaluate }); recreated.consider(memoryCandidate())
    assert.throws(() => recreated.finalize(), /holdout-already-consumed/)
    assert.equal(testReads, 0)
  })
  test('持久预占写盘失败不运行盲测，不将未测试当成通过', () => {
    const s = store(), a = I.createEvidenceArchive({ store: s }), suite = effectFixtureSuite()
    let testReads = 0
    a.beginCycle({ suite, evaluate: (candidate, input) => { if (suite.test.some((f) => I.evidenceDigest(f.input) === I.evidenceDigest(input))) testReads++; return effectFixtureEvaluator(candidate, input) } })
    a.consider(memoryCandidate())
    const rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('.head-effect-holdouts.json')) throw new Error('journal-write-failed'); return rename(from, to) }
    try { assert.throws(() => a.finalize(), /journal-write-failed/); assert.equal(testReads, 0); assert.equal(a.snapshot().active.length, 0) }
    finally { fs.renameSync = rename }
    assert.equal(fs.readdirSync(s.directory).some((f) => f.startsWith('.writing-')), false)
  })
  test('跨会话库自动恢复最新 active/退役/盲测消耗，不需要调用者记住 restoreRef', () => {
    const s = store(), a = I.createEvidenceArchive({ store: s }), suite = effectFixtureSuite()
    a.beginCycle({ suite, evaluate: effectFixtureEvaluator }); a.consider(memoryCandidate()); a.finalize(); a.persist()
    const next = I.createEvidenceArchive({ store: s }), ctx = { signature: memorySignature, observation: { failed: true } }
    const item = next.retrieve(ctx)[0]; assert.ok(item)
    next.retire(item.id, 'independent counterexample'); next.persist()
    const again = I.createEvidenceArchive({ store: s }); assert.equal(again.retrieve(ctx).length, 0); assert.equal(again.snapshot().retired.length, 1)
    assert.throws(() => again.consider(memoryCandidate()), /no-effect-cycle/)
  })
  test('全拒绝关闭不读取/预占盲测，重复拒绝候选由周期缓存去重', () => {
    const s = store(), a = I.createEvidenceArchive({ store: s })
    let calls = 0
    a.beginCycle({ suite: effectFixtureSuite(), evaluate: () => { calls++; return {} } })
    const first = a.consider(memoryCandidate()), count = calls
    assert.equal(a.consider(memoryCandidate()).id, first.id); assert.equal(calls, count)
    assert.deepEqual(a.finalize(), []); assert.equal(s.readHead('effect-holdouts'), null)
  })
  test('两个库写者的旧 archive head 拒绝覆盖已经退役的新库', () => {
    const s = store(), a = I.createEvidenceArchive({ store: s })
    a.beginCycle({ suite: effectFixtureSuite(), evaluate: effectFixtureEvaluator }); a.consider(memoryCandidate()); a.finalize(); a.persist()
    const oldRef = s.readHead('effect-archive').ref
    const writer = I.createEvidenceArchive({ store: s }), other = I.createEvidenceArchive({ store: s })
    writer.retire(writer.snapshot().active[0].entry.id); writer.persist()
    assert.throws(() => other.persist(), /head-conflict/)
    assert.throws(() => I.createEvidenceArchive({ store: s, restoreRef: oldRef }), /archive-head-stale/)
    assert.equal(I.createEvidenceArchive({ store: s }).snapshot().active.length, 0)
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
