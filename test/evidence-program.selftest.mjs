// test/evidence-program.selftest.mjs —— 证据原语与块仓自测（canonicalJson / evidenceDigest / evidence-store / compileV4Evidence）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-evidence-'))
let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n  ${e.stack || e.message}`) }
}

const P = (op, field, value) => ({ op, field, value })
const and = (...items) => ({ op: 'and', items })
function definition() {
  return {
    task: '5u2', version: 'v1',
    protectedFiles: [{ path: 'README.md', sha256: 'a'.repeat(64) }],
    actions: [{ id: 'fix', type: 'replace', path: 'fixture.txt', oldText: 'old\n', newText: 'new\n', preconditions: ['before'], checks: ['after', 'symptom'] }],
    checks: [
      { id: 'before', kind: 'file', role: 'precondition', path: 'fixture.txt', predicate: and(P('includes', 'text', 'old\n'), P('absent', 'text', 'new\n')) },
      { id: 'after', kind: 'file', role: 'acceptance', label: 'npm test', path: 'fixture.txt', predicate: and(P('includes', 'text', 'new\n'), P('absent', 'text', 'old\n')) },
      { id: 'symptom', kind: 'observation', role: 'acceptance', conditions: { cpus: 2 }, predicate: P('equals', 'fixed', true) },
      { id: 'clock', kind: 'observation', role: 'diagnostic', predicate: { op: 'before', field: 'primaryAt', other: 'hedgeAt' } },
    ],
  }
}

try {
  await test('canonicalJson / evidenceDigest / immutableJson：键序无关摘要与深度冻结', () => {
    const a = { b: 2, a: [1, { y: 'y', x: 'x' }] }
    const b = { a: [1, { x: 'x', y: 'y' }], b: 2 }
    assert.equal(I.canonicalJson(a), I.canonicalJson(b))
    assert.equal(I.evidenceDigest(a), I.evidenceDigest(b))
    const frozen = I.immutableJson(a)
    assert.throws(() => { frozen.b = 99 }, TypeError)
    assert.throws(() => { frozen.a[1].x = 'z' }, TypeError)
  })
  await test('safeRelativePath：拒绝路径逃逸、绝对路径、Git/密钥文件', () => {
    assert.equal(I.safeRelativePath('src/messages.js'), true)
    for (const p of ['../out', '/tmp/out', '.git/config', '.secrets/keys.env', 'keys.env', '.env', 'x\\y', 'x/../y', './x', '']) {
      assert.equal(I.safeRelativePath(p), false, p)
    }
  })
  await test('evaluateEvidencePredicate：三值逻辑（缺失字段返 null，闭合算子传播）', () => {
    const pred = and(P('equals', 'fixed', true), P('at-least', 'rounds', 2))
    assert.equal(I.evaluateEvidencePredicate(pred, { fixed: true, rounds: 3 }), true)
    assert.equal(I.evaluateEvidencePredicate(pred, { fixed: false, rounds: 3 }), false)
    assert.equal(I.evaluateEvidencePredicate(pred, { fixed: true }), null)
  })
  await test('freezeEvidenceContract / parseEvidenceProposal / bindEvidenceProposal：生成器提议无授权，契约绑定后生成不可变程序', () => {
    const contract = I.freezeEvidenceContract(definition())
    assert.equal(contract.schema, I.CONTRACT_SCHEMA)
    const raw = '先看 fixture.txt 的 old，将 old\\n 改为 new\\n 后跑 npm test 验收确认 symptom fixed。'
    const side = '我看到 `fixture.txt` 里是 `old\\n`。先核对 `fixture.txt` 含 `old\\n`；若命中，把 `old\\n` 改为 `new\\n`，验收命令是 `npm test`，预期观察 `symptom` 为 `fixed: true`。'
    const compiled = I.compileV4Evidence(side, raw, { compressCtx: 'fixture.txt:\nold\n' }, {
      contract,
      sessionId: 's1',
      calls: [{ name: 'edit_file', args: { path: 'fixture.txt', old_text: 'old\n', new_text: 'new\n' } }],
    })
    assert.equal(compiled.ok, true)
    assert.equal(compiled.proposal.authorized, false)
    assert.equal(compiled.evidence.ok, true)
    assert.equal(compiled.evidence.program.contractDigest, contract.digest)
  })
  await test('createEvidenceStore：CAS 块仓写入、读回校验、篡改检测与 head 乐观锁', () => {
    const storeDir = path.join(root, 'store')
    const store = I.createEvidenceStore({ directory: storeDir, sessionId: 'sess-1' })
    assert.equal(I.isEvidenceStore(store), true)
    const h = store.putJson({ hello: 'world', n: 42 }, { kind: 'unit' })
    assert.deepEqual(store.getJson(h, { kind: 'unit' }), { hello: 'world', n: 42 })
    assert.equal(store.readHead('main'), null)
    const head1 = store.setHead('main', h, { expectedRevision: null })
    assert.equal(head1.ref, h)
    assert.throws(() => store.setHead('main', h, { expectedRevision: 'wrong-rev' }), /head-conflict/)
  })
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
