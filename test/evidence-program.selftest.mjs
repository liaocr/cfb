// 证据程序 R1：纯函数 + 宿主本地 IO + 历史资产。零模型/零外网。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { replayEvidence } from '../tools/replay-evidence.mjs'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-evidence-'))
const P = (op, field, value) => ({ op, field, value })
const and = (...items) => ({ op: 'and', items })
function definition() {
  return { task: 'fixture', version: '1', checks: [
    { id: 'before', kind: 'file', role: 'precondition', path: 'fixture.txt', predicate: P('includes', 'text', 'old') },
    { id: 'after', kind: 'file', role: 'acceptance', path: 'fixture.txt', label: 'local file check', predicate: and(P('includes', 'text', 'new'), P('absent', 'text', 'old')) },
    { id: 'symptom', kind: 'observation', role: 'acceptance', predicate: P('equals', 'fixed', true), conditions: { cpus: 2 } },
    { id: 'clock', kind: 'observation', role: 'diagnostic', predicate: { op: 'before', field: 'primaryAt', other: 'hedgeAt' } },
  ], actions: [{ id: 'fix', type: 'replace', path: 'fixture.txt', oldText: 'old', newText: 'new', preconditions: ['before'], checks: ['after'] }] }
}
const revision = () => I.evidenceDigest({ text: fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8') })
function fixture(over = {}) {
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'old\n')
  const contract = I.freezeEvidenceContract(definition()), program = I.createEvidenceProgram('原说明稿，不能改变。', { contract, actionIds: ['fix'], sessionId: 'session-A' })
  const state = I.initialEvidenceState(program, { roundId: 'r1', revision: revision() })
  const verifier = I.createEvidenceVerifier({ contract, root, readRevision: revision, ...over })
  return { contract, program, state, verifier }
}
try {
  await test('规范 JSON 稳定、不可变，拒绝非 JSON/循环/原型字段', () => {
    assert.equal(I.evidenceDigest({ b: 2, a: 1 }), I.evidenceDigest({ a: 1, b: 2 }))
    for (const v of [NaN, undefined, new Map(), { a: undefined }, JSON.parse('{"__proto__":1}')]) assert.throws(() => I.canonicalJson(v))
    const c = {}; c.c = c; assert.throws(() => I.canonicalJson(c))
    const f = I.immutableJson({ a: [1] }); assert.throws(() => f.a.push(2))
  })
  await test('谓词三值逻辑：缺失字段与 not(unknown) 不能变绿', () => {
    assert.equal(I.evaluateEvidencePredicate(P('includes', 'text', 'PASS'), { text: 'PASS' }), true)
    assert.equal(I.evaluateEvidencePredicate(P('absent', 'text', 'FAIL'), {}), null)
    assert.equal(I.evaluateEvidencePredicate({ op: 'not', item: P('equals', 'x', 1) }, {}), null)
    assert.equal(I.evaluateEvidencePredicate(and(P('equals', 'x', 1), P('equals', 'y', 2)), { x: 0 }), false)
    assert.equal(I.evaluateEvidencePredicate({ op: 'or', items: [P('equals', 'x', 1), P('equals', 'y', 2)] }, { x: 1 }), true)
    assert.throws(() => I.evaluateEvidencePredicate(P('exec', '', ''), {}))
    assert.throws(() => I.evaluateEvidencePredicate(P('equals', '__proto__.x', 1), {}))
  })
  await test('契约冻结且类型化步骤四字段从宿主判据派生', () => {
    const def = definition(), c = I.freezeEvidenceContract(def)
    def.checks[1].predicate = P('equals', '', true)
    assert.notDeepEqual(c.checks[1].predicate, def.checks[1].predicate)
    const p = I.createEvidenceProgram('逐字解释\n', { contract: c, actionIds: ['fix'], sessionId: 's' })
    assert.equal(p.explanation, '逐字解释\n')
    assert.deepEqual(Object.keys(p.steps[0]).sort(), ['action', 'checkCommand', 'expectedObservations', 'id', 'preconditions'].sort())
    assert.equal(I.assertEvidenceProgram(p, c).id, p.id)
    assert.throws(() => I.assertEvidenceContract({ ...c, digest: '0'.repeat(64) }), /drift/)
    assert.throws(() => I.assertEvidenceProgram({ ...p, explanation: '偷改' }, c), /drift/)
  })
  await test('拒绝自改判据/未知角色/无前提写入/诊断冒充验收', () => {
    for (const mutate of [
      (d) => { d.actions[0].checks = ['clock'] },
      (d) => { d.actions[0].preconditions = [] },
      (d) => { d.checks[0].role = 'free' },
      (d) => { d.checks[1].predicate.op = 'regex' },
      (d) => { d.schema = 'fake' },
      (d) => { d.checks.push(d.checks[0]) },
      (d) => { d.actions[0].oldText = 'new' },
    ]) { const d = definition(); mutate(d); assert.throws(() => I.freezeEvidenceContract(d)) }
    const c = I.freezeEvidenceContract(definition())
    assert.throws(() => I.createEvidenceProgram('x', { contract: c, sessionId: 's', actionIds: ['invented'] }))
    assert.throws(() => I.createEvidenceProgram('x', { contract: c, sessionId: 's', actionIds: ['fix', 'fix'] }))
  })
  await test('路径后缀必须完整：json 不截成 js，未知长后缀不授权', () => {
    const draft = (file) => `所以下一步工具调用是 edit_file ${file}，old_text 是 \`old\`，new_text 是 \`new\`。验收是 \`local file check\`，预期通过。`
    for (const file of ['config.json', 'file.js', 'file.mjs', 'file.cjs', 'file.tsx', 'file.ts', 'file.yaml', 'file.yml', 'file.py']) assert.equal(I.parseEvidenceProposal(draft(file)).steps[0].action.path, file)
    for (const file of ['config.json.bak', 'file.jsn', 'file.tsl']) { const p = I.parseEvidenceProposal(draft(file)); assert.equal(p.steps[0].action.path, null); assert.equal(I.bindEvidenceProposal(p, I.freezeEvidenceContract(definition()), 's').ok, false) }
  })
  await test('旧稿解析是提议，精确匹配授权后才得到证据程序', () => {
    const text = '所以下一步工具调用是 edit_file fixture.txt，old_text 是 `old`，new_text 是 `new`。验收是 `local file check`，预期新值已落地。'
    // .txt 本身不在旧代码文件提示模式中，真实工具结构补齐路径。
    const p = I.parseEvidenceProposal(text, { calls: [{ name: 'edit_file', args: { path: 'fixture.txt', old_text: 'old', new_text: 'new' } }] })
    assert.equal(p.authorized, false); assert.equal(p.parsed, true); assert.equal(p.steps[0].action.path, 'fixture.txt')
    const c = I.freezeEvidenceContract(definition()), b = I.bindEvidenceProposal(p, c, 's')
    assert.equal(b.ok, true); assert.equal(b.program.explanation, text)
    const bad = I.parseEvidenceProposal(text.replace('`local file check`', '`rm -rf /`'))
    assert.equal(I.bindEvidenceProposal(bad, c, 's').ok, false)
    assert.equal(I.parseEvidenceProposal('无法判定').parsed, false)
  })
  await test('宿主执行检查/动作/检查：只有实际通过才推进', async () => {
    const f = fixture({ allowEdits: true })
    let s = f.state
    const take = (rs) => { s = I.advanceEvidenceState(f.program, s, rs, f.verifier.authenticate) }
    take([await f.verifier.check('before', I.evidenceBinding(f.program, s))]); assert.equal(s.phase, 'action')
    take([f.verifier.action('fix', I.evidenceBinding(f.program, s))]); assert.equal(s.phase, 'postconditions')
    assert.notEqual(s.revision, f.state.revision)
    take([await f.verifier.check('after', I.evidenceBinding(f.program, s))]); assert.equal(s.status, 'verified')
    assert.deepEqual(s.verifiedSteps, ['step-1']); assert.equal(fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8'), 'new\n')
  })
  await test('缺失/伪造/篡改/跨会话/旧轮次/重复回执均阻塞', async () => {
    const f = fixture(), b = I.evidenceBinding(f.program, f.state), r = await f.verifier.check('before', b)
    const advance = (rs, state = f.state) => I.advanceEvidenceState(f.program, state, rs, f.verifier.authenticate)
    assert.equal(advance([]).status, 'blocked')
    assert.equal(advance([{ ...r, ok: false }]).reason, 'receipt-unauthenticated')
    assert.equal(advance([r], { ...f.state, roundId: 'r2' }).reason, 'receipt-stale')
    assert.equal(advance([r], { ...f.state, sessionId: 'other' }).reason, 'state-program-mismatch')
    assert.equal(advance([r, r]).status, 'blocked')
    const other = I.createEvidenceVerifier({ contract: f.contract, root })
    assert.equal(other.authenticate(r), false)
    assert.equal(I.advanceEvidenceState(f.program, f.state, [r]).reason, 'receipt-unauthenticated')
  })
  await test('失败状态不能靠补一份绿回执解锁；禁止改变 program/state 绑定', async () => {
    const f = fixture(), b = I.evidenceBinding(f.program, f.state)
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'none')
    const r = await f.verifier.check('before', { ...b, revision: revision() })
    const blocked = I.advanceEvidenceState(f.program, f.state, [r], f.verifier.authenticate)
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'old\n')
    const green = await f.verifier.check('before', b)
    assert.equal(I.advanceEvidenceState(f.program, blocked, [green], f.verifier.authenticate).status, 'blocked')
    assert.equal(I.advanceEvidenceState({ ...f.program, id: 'bad' }, f.state, [], f.verifier.authenticate).status, 'blocked')
  })
  await test('文件写入默认关闭；非唯一 oldText 不执行', () => {
    const f = fixture(), state = { ...f.state, phase: 'action' }
    assert.equal(f.verifier.action('fix', I.evidenceBinding(f.program, state)).reason, 'edit-not-authorized')
    const g = fixture({ allowEdits: true }); fs.writeFileSync(path.join(root, 'fixture.txt'), 'old old')
    assert.equal(g.verifier.action('fix', { ...I.evidenceBinding(g.program, { ...g.state, phase: 'action' }), revision: revision() }).ok, false)
    assert.equal(fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8'), 'old old')
  })
  await test('拒绝路径逃逸、Git/密钥、符号链接，未触碰外部文件', () => {
    for (const p of ['../out', '/tmp/out', '.git/config', '.secrets/keys.env', 'keys.env', '.env', 'x\\y', 'x/../y', './x', '']) assert.equal(I.safeRelativePath(p), false, p)
    fs.symlinkSync('/etc/passwd', path.join(root, 'link'))
    assert.throws(() => I.readEvidenceFile(root, 'link'), /unsafe-file-type/)
    const d = definition(); d.actions[0].path = '.git/config'; assert.throws(() => I.freezeEvidenceContract(d))
  })
  await test('未知条件、旧观察、观察抛错/超时均不能通过', async () => {
    for (const [observe, reason] of [
      [(c, b) => ({ value: { fixed: true }, revision: b.revision, roundId: b.roundId, conditions: {} }), 'condition-mismatch'],
      [(c, b) => ({ value: { fixed: true }, revision: 'old', roundId: b.roundId, conditions: { cpus: 2 } }), 'stale-observation'],
      [() => { throw new Error('bad') }, 'observation-error'],
    ]) {
      const f = fixture({ observe }), b = { ...I.evidenceBinding(f.program, f.state), phase: 'postconditions' }
      assert.equal((await f.verifier.check('symptom', b)).reason, reason)
    }
    const d = definition(); d.checks[2].timeoutMs = 10
    const c = I.freezeEvidenceContract(d), v = I.createEvidenceVerifier({ contract: c, root, observe: () => new Promise(() => {}) })
    const r = await v.check('symptom', { contractDigest: c.digest, sessionId: 's', programId: 'p', roundId: 'r', revision: 'v', stepId: 'x', phase: 'postconditions' })
    assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'observation-timeout')
  })
  await test('真实新鲜观测 + 等价条件可验，诊断回执不能替代验收', async () => {
    const f = fixture({ observe: (c, b) => ({ value: { fixed: true, primaryAt: 10, hedgeAt: 20 }, revision: b.revision, roundId: b.roundId, conditions: { cpus: 2 } }) })
    const b = { ...I.evidenceBinding(f.program, f.state), phase: 'postconditions' }
    assert.equal((await f.verifier.check('symptom', b)).ok, true)
    assert.equal((await f.verifier.check('clock', b)).reason, 'wrong-check-role')
    assert.equal((await f.verifier.check('clock', { ...b, phase: 'diagnostic' })).ok, true)
  })
  await test('进程能力默认关闭；授权后 execFile 语义真实执行，无 shell/密钥继承', async () => {
    const d = definition(); d.checks.push({ id: 'cmd', kind: 'command', role: 'diagnostic', executable: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({hasKey: !!process.env.CFB_FAKE_API_KEY, arg: process.argv[1]}))', 'x;echo injected'], localOnly: true, timeoutMs: 2000,
      predicate: and(P('equals', 'exitCode', 0), P('includes', 'stdout', '"hasKey":false'), P('includes', 'stdout', 'x;echo injected')) })
    process.env.CFB_FAKE_API_KEY = 'not-a-real-key'
    try {
      const c = I.freezeEvidenceContract(d), b = { contractDigest: c.digest, sessionId: 's', programId: 'p', roundId: 'r', revision: 'v', stepId: 'x', phase: 'diagnostic' }
      assert.equal((await I.createEvidenceVerifier({ contract: c, root }).check('cmd', b)).reason, 'command-not-authorized')
      assert.equal((await I.createEvidenceVerifier({ contract: c, root, allowCommands: true }).check('cmd', b)).ok, true)
      d.checks.at(-1).env = { API_KEY: 'secret' }; assert.throws(() => I.freezeEvidenceContract(d), /command-env/)
    } finally { delete process.env.CFB_FAKE_API_KEY }
  })
  await test('进程超时/输出超预算/中断均 unknown，不能将 stdout 中 PASS 当成功', async () => {
    for (const [args, timeoutMs, maxOutputBytes, reason] of [
      [['-e', 'setInterval(()=>{},1000)'], 30, 65536, 'check-timeout'],
      [['-e', 'console.log("x".repeat(10000))'], 2000, 100, 'output-budget'],
    ]) {
      const d = definition(); d.checks.push({ id: 'cmd', kind: 'command', role: 'diagnostic', executable: process.execPath, args, localOnly: true, timeoutMs, maxOutputBytes, predicate: P('equals', 'exitCode', 0) })
      const c = I.freezeEvidenceContract(d), v = I.createEvidenceVerifier({ contract: c, root, allowCommands: true }), b = { contractDigest: c.digest, sessionId: 's', programId: 'p', roundId: 'r', revision: 'v', stepId: 'x', phase: 'diagnostic' }
      assert.equal((await v.check('cmd', b)).reason, reason)
      const abort = new AbortController(); abort.abort(); assert.equal((await v.check('cmd', b, { signal: abort.signal })).reason, 'aborted')
    }
  })
  await test('全部 auto-d2 与 run4 离线回放：不改旧稿、不丢重复行、没有执行授权', () => {
    const r = replayEvidence()
    assert.equal(r.modelCalls, 0); assert.equal(r.networkCalls, 0); assert.equal(r.judgeUsed, false)
    assert.equal(r.legacyByteEquality.n, r.legacyByteEquality.total)
    assert.equal(r.run4.rows, 79); assert.ok(r.drafts.rows >= 30)
    assert.equal(r.run4.executable.n, 0); assert.equal(r.run4.livePass.n, 0)
    assert.ok(r.run4.historical.unknown > 0)
    assert.equal(new Set(r.entries.results.map((x) => x.key)).size, 79)
  })
} finally { fs.rmSync(root, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
