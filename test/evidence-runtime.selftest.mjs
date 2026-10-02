// R4：真实本地块仓、JSON/文件联合恢复、完整控制链及 birth/plugin 侧车（零模型/外网）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { createDemoEnvironment, runEvidenceDemo, DEMO_OLD, DEMO_RAISE, DEMO_CLOCK } from '../tools/evidence-demo.mjs'
import { effectFixtureSuite, effectFixtureEvaluator, memoryCandidate, memorySignature } from './helpers/evidence-fixtures.mjs'
import { canSymlink } from './helpers/platform.mjs'
// Windows 没有 POSIX 权限位：chmod(0o600) 之后 statSync().mode & 0o777 报的是 0o666。
// 权限收紧在 POSIX 上是真实保证，在 Windows 上**无法验证** ⇒ 相关断言按平台显式跳过，
// 而不是放宽阈值（放宽会让「权限没生效」也变绿）。
const POSIX_MODE = process.platform !== 'win32'
let pass = 0, fail = 0, counter = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-evidence-runtime-'))
const dir = () => { const d = path.join(home, 'case-' + (++counter)); fs.mkdirSync(d); return d }
const env = (options = {}) => { const base = dir(); return createDemoEnvironment({ root: path.join(base, 'workspace'), directory: path.join(base, 'store'), ...options }) }
const file = (e) => fs.readFileSync(path.join(e.adapter.root, 'fixture.js'), 'utf8')
const sample = (binding, value, conditions = { cpus: 2 }) => ({ value, revision: binding.revision, roundId: binding.roundId, conditions })
const store = (base, sessionId = 's', over = {}) => I.createEvidenceStore({ directory: path.join(base, 'store'), sessionId, ...over })
try {
  await test('块仓文字/Unicode/孤立 surrogate/二进制/JSON 全部无损，去重且重启可恢复', () => {
    const base = dir(), s = store(base), text = '中文\n\0\ud800🧪 原文尾巴不是上下文替代', binary = Buffer.from([0, 255, 128, 13, 10])
    const h = s.put(text), b = s.put(binary)
    assert.equal(s.get(h), text); assert.deepEqual(s.get(b), binary); assert.equal(s.put(text), h)
    const j = s.putJson({ x: [1, null, '好'] }); assert.deepEqual(s.getJson(j), { x: [1, null, '好'] })
    assert.equal(s.stats().files, 3); assert.equal(store(base).get(h), text)
    if (POSIX_MODE) assert.equal(fs.statSync(path.join(s.directory, 'authority.key')).mode & 0o777, 0o600)
    else console.log('  (跳过 POSIX 权限位断言：当前平台 ' + process.platform + ' 无 POSIX mode)')
  })
  await test('句柄会话隔离，损坏/伪造 HMAC 不接受；不会静默修复同名脏块', () => {
    const base = dir(), s = store(base), h = s.put('old'), other = store(base, 'other')
    assert.throws(() => other.get(h), /session-or-format/)
    const id = h.split('/').at(-1), p = path.join(s.directory, id + '.json'), r = JSON.parse(fs.readFileSync(p))
    r.data = 'tampered'; fs.writeFileSync(p, JSON.stringify(r))
    assert.throws(() => s.get(h), /integrity/); assert.throws(() => s.put('old'), /integrity/)
    const { digest, signature, ...body } = r, forgedId = I.evidenceDigest(body)
    fs.writeFileSync(path.join(s.directory, forgedId + '.json'), JSON.stringify({ ...body, digest: forgedId, signature }))
    assert.throws(() => s.get(h.slice(0, -64) + forgedId), /integrity/)
  })
  await test('块大小/总容量、链接/根目录/密钥目录限制，运行物被 ignore/manifest 排除', () => {
    const s = store(dir(), 's', { maxBlobBytes: 10, maxTotalBytes: 512 })
    assert.throws(() => s.put('x'.repeat(11)), /blob-budget/)
    const tiny = store(dir(), 's', { maxBlobBytes: 10, maxTotalBytes: 10 }); assert.throws(() => tiny.put('x'), /total-budget/)
    assert.throws(() => I.createEvidenceStore({ directory: process.cwd(), sessionId: 's' }), /unsafe-store/)
    assert.throws(() => I.createEvidenceStore({ directory: path.join(dir(), '.secrets'), sessionId: 's' }), /unsafe-store/)
    const d = dir()
    if (canSymlink()) { fs.symlinkSync(s.directory, path.join(d, 'linked')); assert.throws(() => I.createEvidenceStore({ directory: path.join(d, 'linked'), sessionId: 's' }), /symlink/) }
    else console.log('  (跳过 symlink 拒绝断言：当前平台无法创建符号链接)')
    // 本用例要保证的是**行为**：运行产物既被 git 忽略、也不进清单。
    // 早先这里断言 manifest.mjs 源码里含字面量 "'.cfb-runtime'"，那是在测实现细节：
    // 忽略规则改为从 .gitignore 单一来源读取后，该字面量不复存在，但保证反而更强。
    assert.ok(fs.readFileSync('.gitignore', 'utf8').includes('.cfb-runtime/'), '.cfb-runtime/ 必须在 .gitignore 中')
    assert.ok(/\.gitignore/.test(fs.readFileSync('manifest.mjs', 'utf8')), 'manifest.mjs 必须从 .gitignore 读取忽略规则')
    const listed = fs.readFileSync('MANIFEST.sha256', 'utf8').split('\n').some((l) => l.includes('.cfb-runtime/'))
    assert.ok(!listed, '运行产物不得出现在 MANIFEST.sha256 中')
  })
  await test('制品按 RAW/EXPLANATION/STEP 可寻址，无损回取且类型/跨会话错误拒绝', () => {
    const e = env({ withArchive: false }), p = I.createEvidenceProgram('说明完整\n', { contract: e.contract, actionIds: ['raise-threshold'], sessionId: e.store.sessionId })
    const a = I.archiveEvidenceArtifact(e.store, { raw: '原始推理\n'.repeat(10), program: p })
    assert.equal(I.recoverEvidenceBlock(e.store, a.indexRef, 'raw'), '原始推理\n'.repeat(10))
    assert.equal(I.recoverEvidenceBlock(e.store, a.indexRef, 'explanation'), p.explanation)
    assert.deepEqual(I.recoverEvidenceBlock(e.store, a.indexRef, 'step-1'), p.steps[0])
    assert.throws(() => I.recoverEvidenceBlock(e.store, a.indexRef, 'unknown'), /block-not-found/)
    assert.throws(() => e.store.getJson(a.programRef, { kind: 'checkpoint' }), /blob-kind/)
  })
  await test('文件二进制/权限与完整宿主上下文联合恢复；只删除受管新文件，不碰 Git/无关文件', () => {
    const root = dir(), original = Buffer.from([0, 255, 13, 10]), tracked = path.join(root, 'tracked.bin')
    fs.writeFileSync(tracked, original, { mode: 0o640 }); fs.writeFileSync(path.join(root, 'untouched'), 'user work')
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git/config'), 'canary')
    let state = { context: ['user'], nested: { a: 1 } }
    const a = I.createFileStateAdapter({ root, paths: ['tracked.bin', 'created.txt'], readState: () => state, writeState: (v) => { state = v } }), cp = a.capture()
    fs.writeFileSync(tracked, 'changed'); fs.chmodSync(tracked, 0o600); fs.writeFileSync(path.join(root, 'created.txt'), 'new'); state.context.push('failed thought')
    a.restore(cp, { expectedRevision: a.revision() })
    assert.deepEqual(fs.readFileSync(tracked), original)
    if (POSIX_MODE) assert.equal(fs.statSync(tracked).mode & 0o777, 0o640)
    assert.deepEqual(state, { context: ['user'], nested: { a: 1 } }); assert.equal(fs.existsSync(path.join(root, 'created.txt')), false)
    assert.equal(fs.readFileSync(path.join(root, 'untouched'), 'utf8'), 'user work'); assert.equal(fs.readFileSync(path.join(root, '.git/config'), 'utf8'), 'canary')
    assert.throws(() => I.createFileStateAdapter({ root, paths: ['.git/config'] }), /adapter-schema/)
    assert.throws(() => I.createFileStateAdapter({ root, paths: ['.cfb-runtime/authority.key'] }), /adapter-schema/)
  })
  await test('外部并发改动拒绝回滚，不覆盖用户内容；快照不能跨 root/scope 使用', () => {
    const e = env({ withArchive: false }), cp = e.adapter.capture(), rev = e.adapter.revision()
    fs.writeFileSync(path.join(e.adapter.root, 'fixture.js'), 'external user change')
    assert.throws(() => e.adapter.restore(cp, { expectedRevision: rev }), /rollback-conflict/)
    assert.equal(file(e), 'external user change')
    const other = env({ withArchive: false }); assert.throws(() => other.adapter.restore(cp, { expectedRevision: other.adapter.revision() }), /snapshot-scope/)
  })
  await test('恢复 setter 失败能撤销为当前状态；不可恢复的物理条件变化不能伪报成功', () => {
    const root = dir(); fs.writeFileSync(path.join(root, 'f'), 'old')
    let state = { value: 1 }, rejectOnce = true
    const a = I.createFileStateAdapter({ root, paths: ['f'], readState: () => state, writeState: (v) => { if (v.value === 1 && rejectOnce) { rejectOnce = false; throw new Error('reject') } state = v } })
    const cp = a.capture(); fs.writeFileSync(path.join(root, 'f'), 'new'); state = { value: 2 }
    assert.throws(() => a.restore(cp, { expectedRevision: a.revision() }), /current-preserved/)
    assert.equal(fs.readFileSync(path.join(root, 'f'), 'utf8'), 'new'); assert.equal(state.value, 2)
    let cpus = 2
    const b = I.createFileStateAdapter({ root, paths: ['f'], readConditions: () => ({ cpus }) }), physical = b.capture(); cpus = 1
    assert.throws(() => b.restore(physical, { expectedRevision: b.revision() }), /current-preserved/)
    assert.equal(cpus, 1)
    assert.throws(() => I.createFileStateAdapter({ root, paths: ['f'], writeState: async () => {} }), /adapter-schema/)
  })
  await test('恢复暂存的写入/chmod/fsync/关闭失败都清理临时文件并保留当前状态', () => {
    for (const operation of ['writeFileSync', 'fchmodSync', 'fsyncSync', 'closeSync']) {
      const root = dir(); fs.writeFileSync(path.join(root, 'f'), 'old')
      let state = { value: 1 }, injected = false
      const adapter = I.createFileStateAdapter({ root, paths: ['f'], readState: () => state, writeState: (s) => { state = s } })
      const snapshot = adapter.capture(); fs.writeFileSync(path.join(root, 'f'), 'current'); state = { value: 2 }
      const original = fs[operation], originalOpen = fs.openSync, stagingFds = new Set()
      fs.openSync = (name, ...args) => {
        const fd = originalOpen(name, ...args)
        if (typeof name === 'string' && path.basename(name).startsWith('.cfb-restore-')) stagingFds.add(fd)
        return fd
      }
      fs[operation] = (...args) => {
        if (!injected && stagingFds.has(args[0])) {
          injected = true
          if (operation === 'closeSync') original(...args) // 关闭后报错，不让测试自身泄漏 fd。
          throw new Error('injected-' + operation)
        }
        return original(...args)
      }
      try { assert.throws(() => adapter.restore(snapshot, { expectedRevision: adapter.revision() }), /restore-failed-current-preserved/, operation) }
      finally { fs[operation] = original; fs.openSync = originalOpen }
      assert.equal(injected, true, operation)
      assert.equal(fs.readFileSync(path.join(root, 'f'), 'utf8'), 'current', operation)
      assert.deepEqual(state, { value: 2 }, operation)
      assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.cfb-restore-')), [], operation)
    }
  })
  await test('未验证不能标峰值；检查点认证/会话/契约与仓库范围都核对', () => {
    const e = env({ withArchive: false }), v = I.createEvidenceVerifier({ contract: e.contract, root: e.adapter.root })
    const cp = I.createEvidenceCheckpoints({ store: e.store, adapter: e.adapter, sessionId: e.store.sessionId, contractDigest: e.contract.digest, authenticate: v.authenticate })
    assert.throws(() => cp.take({ kind: 'verified-step', program: null, state: null, receipts: [] }), /unverified/)
    const before = cp.take(); assert.equal(before.kind, 'before-round')
    const wrong = I.createEvidenceCheckpoints({ store: e.store, adapter: e.adapter, sessionId: e.store.sessionId, contractDigest: 'wrong', authenticate: v.authenticate })
    assert.throws(() => wrong.restore(before.handle, e.adapter.revision()), /session-contract/)
    assert.throws(() => cp.restore(e.store.putJson({ schema: 'fake' }, { kind: 'checkpoint' }), e.adapter.revision()), /session-contract/)
  })
  await test('完整链：失败→EIG 诊断→文件+上下文恢复→另一批准分支→真正通过', async () => {
    const e = env(), r = I.createEvidenceRuntime(e.options)
    const first = await r.runRound(r.program('失败正文，不得自动回灌。', ['raise-threshold']), { roundId: 'r1' })
    assert.equal(first.status, 'rolled-back'); assert.equal(first.ok, false); assert.equal(file(e), DEMO_OLD)
    assert.deepEqual(e.getState().context, ['用户原始任务']); assert.equal(first.diagnostic.state.prior.primaryDelayed, 1)
    assert.ok(!JSON.stringify(first.modelView).includes('失败正文')); assert.equal(first.modelView.memories.length, 1)
    const next = await r.runRound(r.program('另一分支，等待独立验收。', ['fake-clock']), { roundId: 'r2' })
    assert.equal(next.ok, true); assert.equal(next.status, 'verified'); assert.equal(file(e), DEMO_CLOCK)
    assert.equal(next.state.verifiedSteps.length, 1); assert.equal(next.modelView.memories.length, 0)
    assert.equal(r.view().busy, false); assert.equal(r.view().done, true)
    assert.equal((await r.runRound(r.program('不得重复', ['raise-threshold']))).reason, 'episode-already-verified')
  })
  await test('多步骤回到最近通过的中间峰值，不回初始状态或失败稿', async () => {
    const e = env({ withArchive: false }), def = { task: 'two-step', version: '1', checks: [
      { id: 'old', kind: 'file', role: 'precondition', path: 'fixture.js', predicate: { op: 'equals', field: 'text', value: DEMO_OLD } },
      { id: 'mid-pre', kind: 'file', role: 'precondition', path: 'fixture.js', predicate: { op: 'equals', field: 'text', value: DEMO_RAISE } },
      { id: 'mid', kind: 'file', role: 'acceptance', path: 'fixture.js', predicate: { op: 'equals', field: 'text', value: DEMO_RAISE } },
      { id: 'fail', kind: 'observation', role: 'acceptance', predicate: { op: 'equals', field: 'fixed', value: true } },
    ], actions: [
      { id: 'one', type: 'replace', path: 'fixture.js', oldText: DEMO_OLD, newText: DEMO_RAISE, preconditions: ['old'], checks: ['mid'] },
      { id: 'two', type: 'replace', path: 'fixture.js', oldText: DEMO_RAISE, newText: 'bad\n', preconditions: ['mid-pre'], checks: ['fail'] },
    ] }, c = I.freezeEvidenceContract(def)
    const r = I.createEvidenceRuntime({ ...e.options, contract: c, diagnosticModel: null, observe: (c, b) => sample(b, { fixed: false }, {}) })
    const result = await r.runRound(r.program('整体失败散文', ['one', 'two']))
    assert.equal(result.status, 'rolled-back'); assert.equal(file(e), DEMO_RAISE)
    assert.deepEqual(result.restored.state.verifiedSteps, ['step-1']); assert.deepEqual(e.getState().context, ['用户原始任务', '候选执行：one'])
    assert.ok(!JSON.stringify(result.modelView).includes('整体失败散文'))
  })
  await test('验收期间外部修改造成 conflict，不能将用户改动当本轮修改回滚', async () => {
    const e = env({ withArchive: false, observe: (c, b) => {
      fs.writeFileSync(path.join(e.adapter.root, 'fixture.js'), 'external user work')
      return sample(b, { fixed: true })
    } }), r = I.createEvidenceRuntime({ ...e.options, diagnosticModel: null })
    const result = await r.runRound(r.program('proposal', ['raise-threshold']))
    assert.equal(result.status, 'conflict'); assert.equal(result.recoveryError, 'rollback-conflict'); assert.equal(file(e), 'external user work')
  })
  await test('轮间外部变化拒绝旧峰值恢复，不覆盖用户最新状态', async () => {
    const e = env({ withArchive: false }), r = I.createEvidenceRuntime(e.options)
    await r.runRound(r.program('first', ['raise-threshold']))
    fs.writeFileSync(path.join(e.adapter.root, 'fixture.js'), 'new user change')
    const result = await r.runRound(r.program('second', ['fake-clock']))
    assert.equal(result.reason, 'host-state-changed-since-peak'); assert.equal(file(e), 'new user change')
  })
  await test('两次修复后第 3 轮只验；轮次/检查双预算，重复轮号与漂移程序不放行', async () => {
    const e = env({ withArchive: false }), r = I.createEvidenceRuntime(e.options), p = r.program('same failure', ['raise-threshold'])
    await r.runRound(p, { roundId: '1' })
    assert.equal((await r.runRound(p, { roundId: '1' })).reason, 'round-id-reused')
    await r.runRound(p, { roundId: '2' })
    assert.equal((await r.runRound(p, { roundId: '3' })).reason, 'verification-only'); assert.equal(r.view().rounds, 2)
    await r.runRound(r.program('only verify', ['verify-only']), { roundId: '3' })
    assert.equal((await r.runRound(p)).reason, 'round-budget'); assert.equal(r.view().repairs, 2); assert.equal(file(e), DEMO_OLD)
    const other = I.createEvidenceRuntime(e.options)
    assert.equal((await other.runRound({ ...p, explanation: 'tampered' })).reason, 'program-invalid-or-contract-drift')
    assert.equal(other.view().rounds, 0)
    const zero = I.createEvidenceRuntime({ ...e.options, maxChecks: 0 })
    const result = await zero.runRound(p); assert.equal(result.reason, 'check-budget'); assert.equal(file(e), DEMO_OLD); assert.equal(zero.view().checks, 0)
  })
  await test('整个轮次有硬截止，观察超时不推进、实际恢复且锁清理', async () => {
    const e = env({ withArchive: false, observe: () => new Promise(() => {}), runtimeOptions: { roundTimeoutMs: 30 } }), r = I.createEvidenceRuntime(e.options)
    const started = Date.now(), result = await r.runRound(r.program('timeout', ['raise-threshold']))
    assert.ok(Date.now() - started < 1500); assert.equal(result.status, 'rolled-back'); assert.equal(file(e), DEMO_OLD)
    assert.equal(r.view().busy, false); assert.equal(result.ok, false)
    let entered = false
    // 本用例的语义是「同步阻塞的 observe 不能把迟到绿灯偷过绝对截止」，成立条件是
    //   ① runtime 能在截止前**走到** observe（否则 guardCheck 先抛，observe 根本不被调用）；
    //   ② observe 的同步阻塞**超过**截止（返回后第 70 行的复查才会判超时）。
    // 原值（截止 50ms / 阻塞 100ms）只给 ① 留了 50ms 余量，负载下 setup 一慢就变 entered=false。
    // 数字是任意的，关系才是语义：阻塞(900) > 截止(500)，且截止远大于 setup。
    const sync = env({ withArchive: false, runtimeOptions: { roundTimeoutMs: 500 }, observe: (c, b) => {
      entered = true
      const until = Date.now() + 900; while (Date.now() < until) { /* 故障注入：阻塞 timer 的同步观察 */ }
      return sample(b, { fixed: true })
    } }), bounded = I.createEvidenceRuntime({ ...sync.options, diagnosticModel: null })
    const late = await bounded.runRound(bounded.program('同步迟到绿灯不可采纳', ['raise-threshold']))
    assert.equal(entered, true); assert.equal(late.reason, 'round-timeout'); assert.equal(late.status, 'rolled-back')
    assert.equal(late.ok, false); assert.equal(file(sync), DEMO_OLD); assert.equal(bounded.view().busy, false)
  })
  await test('并发轮次拒绝且不消耗第二份预算；串行收口之后可另走分支', async () => {
    let release, entered
    const pending = new Promise((r) => { release = r }), started = new Promise((r) => { entered = r })
    const e = env({ withArchive: false, observe: (c, b) => { entered(); return pending.then(() => sample(b, { fixed: false })) } }), r = I.createEvidenceRuntime({ ...e.options, diagnosticModel: null })
    const first = r.runRound(r.program('one', ['raise-threshold']))
    await started
    assert.equal((await r.runRound(r.program('two', ['fake-clock']))).reason, 'runtime-busy'); assert.equal(r.view().rounds, 1)
    release(); await first; assert.equal(r.view().busy, false); assert.equal(file(e), DEMO_OLD)
  })
  await test('归档/检查点预算失败不执行，不能绕过存档闸', async () => {
    const e = env({ withArchive: false }), tiny = I.createEvidenceStore({ directory: path.join(dir(), 'tiny'), sessionId: e.store.sessionId, maxBlobBytes: 10, maxTotalBytes: 10 })
    const r = I.createEvidenceRuntime({ ...e.options, store: tiny }), result = await r.runRound(r.program('x', ['raise-threshold']))
    assert.equal(result.ok, false); assert.equal(file(e), DEMO_OLD); assert.deepEqual(e.getState().context, ['用户原始任务']); assert.equal(r.view().busy, false)
  })
  await test('签名档案可跨对象持久恢复，盲测消耗/退役保留；不接受非本机签名仓', () => {
    const e = env(), restored = I.createEvidenceArchive({ store: e.store, restoreRef: e.archiveRef }), context = { signature: memorySignature, observation: { failed: true } }
    assert.equal(restored.retrieve(context).length, 1)
    restored.beginCycle({ suite: effectFixtureSuite(), evaluate: effectFixtureEvaluator }); restored.consider(memoryCandidate({ kind: 'fact' }))
    assert.throws(() => restored.finalize(), /holdout-already-consumed/)
    const id = restored.retrieve(context)[0].id; restored.retire(id, 'independent counterexample')
    const cp = restored.persist(), again = I.createEvidenceArchive({ store: e.store, restoreRef: cp })
    assert.equal(again.retrieve(context).length, 0); assert.equal(again.snapshot().retired.length, 1)
    assert.throws(() => I.createEvidenceArchive({ store: { getJson: () => e.archive.snapshot() }, restoreRef: cp }), /authority/)
  })
  await test('birth 默认无侧车；打开时只发布可检查制品，说明稿/chunks 逐字不变且不自动执行', async () => {
    const e = env({ withArchive: false }), host = I.createEvidenceHost(e.options)
    const draft = `所以下一步工具调用是 edit_file fixture.js，old_text 是 \`${DEMO_OLD}\`，new_text 是 \`${DEMO_RAISE}\`。验收是 \`local verify\`，预期落地。`
    const raw = draft + '\n' + '同一条待验证假设。'.repeat(300), deps = { sessionId: e.store.sessionId, archive: () => 'art://fixture', distill: () => ({ text: draft }), evidenceHost: host,
      cfg: { birthMinChars: 1, birthFinishWaitMs: 100, finishHeadersGraceMs: 0, birthMinSavedChars: 1 } }
    const old = await I.birthSettle({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }, deps)
    assert.equal(old.why, 'condensed'); assert.equal(old.evidence, undefined); assert.equal(host.latest().length, 0)
    const next = await I.birthSettle({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }, { ...deps, cfg: { ...deps.cfg, evidenceProgram: true } })
    assert.equal(next.evidence.authorized, true); assert.equal(next.text, old.text); assert.deepEqual(next.chunks, old.chunks); assert.equal(file(e), DEMO_OLD)
    const executed = await host.runLatest(0)
    assert.equal(executed.status, 'rolled-back'); assert.equal(file(e), DEMO_OLD)
    assert.equal(I.recoverEvidenceBlock(e.store, executed.artifactRef, 'raw'), raw)
    assert.equal((await host.runLatest(99)).reason, 'no-authorized-draft')
  })
  await test('失败/部分制品只归档、不授权；错误会话/伪 service/存储故障不改变 birth 原稿', async () => {
    const e = env({ withArchive: false }), host = I.createEvidenceHost(e.options)
    const p = host.captureDraft({ raw: 'raw', text: '未检查的原文', sessionId: e.store.sessionId, complete: false })
    assert.equal(p.authorized, false); assert.equal(p.reason, 'incomplete-artifact')
    assert.throws(() => host.captureDraft({ raw: 'raw', text: 'text', sessionId: 'other' }), /draft-session/)
    assert.equal(I.isEvidenceHost({ schema: host.schema, captureDraft: host.captureDraft }), false)
    const raw = '原样 fallback。'.repeat(50), bad = await I.birthSettle({ index: 0, text: raw }, { sessionId: 'other', archive: () => 'art://h', distill: () => { throw new Error('fail') }, evidenceHost: host,
      cfg: { evidenceProgram: true, birthMinChars: 1, birthFinishWaitMs: 20, finishHeadersGraceMs: 0 } })
    assert.equal(bad.text, raw); assert.equal(bad.evidence, undefined)
    const boundedStore = store(dir(), e.store.sessionId, { maxBlobBytes: 8192, maxTotalBytes: 1024 * 1024 })
    const bounded = I.createEvidenceHost({ ...e.options, store: boundedStore })
    const draft = `所以下一步工具调用是 edit_file fixture.js，old_text 是 \`${DEMO_OLD}\`，new_text 是 \`${DEMO_RAISE}\`。验收是 \`local verify\`，预期落地。`
    assert.equal(bounded.captureDraft({ raw: 'prior raw', text: draft, sessionId: e.store.sessionId }).authorized, true)
    assert.throws(() => bounded.captureDraft({ raw: 'x'.repeat(8193), text: draft, sessionId: e.store.sessionId }), /blob-budget/)
    assert.equal(bounded.latest().length, 0); assert.equal((await bounded.runLatest(0)).reason, 'no-authorized-draft')
    assert.equal(file(e), DEMO_OLD)
  })
  await test('真实 plugin 服务接线：默认关/评估态零取服务，opt-in 缺模型安全回退只发布 raw', async () => {
    const e = env({ withArchive: false }), host = I.createEvidenceHost(e.options), raw = '这是待验证的思考。'.repeat(450)
    const chunks = [{ type: 'block-start', blockType: 'reasoning', index: 0 }, { type: 'reasoning-delta', index: 0, text: raw },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }, { type: 'finish', reason: { kind: 'end' } }]
    for (const [enabled, dryRun] of [[false, false], [true, true], [true, false]]) {
      let gets = 0
      const hooks = new Map(), ctx = { on: (n, f) => hooks.set(n, f), get: (name) => {
        if (name === 'cfbEvidenceHost') { gets++; return host }
        if (name === 'cmbStore') return { putText: () => ({ handle: 'art://archive' }) }
        return null
      } }
      I.apply(ctx, { evidenceProgram: enabled, dryRun, trace: false, followHostModel: false, followHostProvider: false, model: '', prewarm: false, birthMinChars: 1 })
      await hooks.get('agent/pre-step')({ agent: { session: { id: e.store.sessionId } } }, async () => ({}))
      const out = []
      for await (const c of hooks.get('llm/stream')({ messages: [] }, () => (async function* () { yield* chunks })())) out.push(c)
      assert.equal(out.find((c) => c.type === 'block-end').block.text, raw)
      assert.equal(gets, enabled && !dryRun ? 1 : 0)
    }
    assert.equal(host.latest().length, 1); assert.equal(host.latest()[0].authorized, false); assert.equal(file(e), DEMO_OLD)
    assert.equal(I.DEFAULTS.evidenceProgram, false); assert.equal(I.normalizeConfig({ evidenceProgram: true }).evidenceProgram, true)
  })
  await test('独立检查器文件及依赖被固定，禁止修改判据源码，漂移不给动作/绿灯', async () => {
    const e = env({ withArchive: false }), oracle = path.join(e.adapter.root, 'oracle.js')
    fs.writeFileSync(oracle, 'independent checker v1')
    const { schema, digest, ...def } = e.contract
    const contract = I.protectEvidenceContract(def, { root: e.adapter.root, paths: ['oracle.js'] })
    const invalid = JSON.parse(JSON.stringify(def)); invalid.actions[0].path = 'oracle.js'
    assert.throws(() => I.protectEvidenceContract(invalid, { root: e.adapter.root, paths: ['oracle.js'] }), /action-replace/)
    const runtime = I.createEvidenceRuntime({ ...e.options, contract, diagnosticModel: null })
    fs.writeFileSync(oracle, 'weakened checker v2')
    const result = await runtime.runRound(runtime.program('no self-authored checker', ['raise-threshold']))
    assert.equal(result.ok, false); assert.equal(result.reason, 'verifier-source-drift'); assert.equal(file(e), DEMO_OLD)
    assert.equal(fs.readFileSync(oracle, 'utf8'), 'weakened checker v2')
    assert.equal(result.modelView.memories.length, 0)
  })
  await test('检查/动作执行期间检查器源码漂移不给绿灯，动作已落地也必须恢复', async () => {
    const e = env({ withArchive: false }), oracle = path.join(e.adapter.root, 'oracle.js')
    fs.writeFileSync(oracle, 'independent checker v1')
    const { schema, digest, ...def } = e.contract
    const contract = I.protectEvidenceContract(def, { root: e.adapter.root, paths: ['oracle.js'] })
    const verifier = I.createEvidenceVerifier({ contract, root: e.adapter.root, observe: (c, b) => {
      fs.writeFileSync(oracle, 'weakened during check')
      return sample(b, { fixed: true })
    } })
    const binding = { sessionId: e.store.sessionId, programId: 'p', contractDigest: contract.digest,
      roundId: 'r', revision: e.adapter.revision(), stepId: 'step-1', phase: 'postconditions' }
    const checked = await verifier.check('symptom', binding)
    assert.equal(checked.status, 'unknown'); assert.equal(checked.reason, 'verifier-source-drift'); assert.equal(verifier.authenticate(checked), true)

    const other = env(), otherOracle = path.join(other.adapter.root, 'oracle.js')
    fs.writeFileSync(otherOracle, 'independent checker v1')
    const otherContract = I.protectEvidenceContract(def, { root: other.adapter.root, paths: ['oracle.js'] })
    const adapter = Object.freeze({ ...other.adapter, perform: (action) => {
      const output = other.adapter.perform(action)
      fs.writeFileSync(otherOracle, 'weakened during action')
      return output
    } })
    const runtime = I.createEvidenceRuntime({ ...other.options, contract: otherContract, adapter, diagnosticModel: null })
    const result = await runtime.runRound(runtime.program('源码变了不能签动作绿灯', ['raise-threshold']))
    assert.equal(result.reason, 'verifier-source-drift'); assert.equal(result.status, 'rolled-back'); assert.equal(result.ok, false)
    assert.equal(result.receipts.find((r) => r.binding.phase === 'action').status, 'unknown')
    assert.equal(file(other), DEMO_OLD); assert.deepEqual(other.getState().context, ['用户原始任务'])
    assert.equal(result.modelView.memories.length, 0)
    assert.equal(fs.readFileSync(otherOracle, 'utf8'), 'weakened during action') // 独立保护路径不是受管恢复目标。
  })
  await test('执行/编辑必须是显式布尔能力，重复检查定义不进入程序', () => {
    const e = env({ withArchive: false })
    assert.throws(() => I.createEvidenceVerifier({ contract: e.contract, root: e.adapter.root, allowEdits: 'false' }), /capability-boolean/)
    const { schema, digest, ...d } = JSON.parse(JSON.stringify(e.contract)); d.actions[0].checks.push(d.actions[0].checks[0])
    assert.throws(() => I.freezeEvidenceContract(d), /action-checks/)
    assert.throws(() => I.createEvidenceVerifier({ contract: e.contract, root: e.adapter.root, perform: async () => ({ changed: true }) }), /perform-sync/)
    const literal = { type: 'replace', path: 'fixture.js', oldText: DEMO_OLD, newText: 'literal $& $$\n' }
    I.replaceEvidenceFile(e.adapter.root, literal); assert.equal(file(e), literal.newText)
    const binary = Buffer.from([0x61, 0xff]); fs.writeFileSync(path.join(e.adapter.root, 'fixture.js'), binary)
    assert.throws(() => I.replaceEvidenceFile(e.adapter.root, { ...literal, oldText: 'a' }), /requires-utf8/)
    assert.deepEqual(fs.readFileSync(path.join(e.adapter.root, 'fixture.js')), binary)
  })
  await test('所有新增公共函数/常量都有对外类型契约，未引入外部运行依赖', () => {
    const types = fs.readFileSync('index.d.ts', 'utf8')
    for (const name of ['compileV4Evidence', 'canonicalJson', 'evidenceDigest', 'immutableJson', 'safeRelativePath', 'freezeEvidenceContract', 'assertEvidenceContract',
      'createEvidenceProgram', 'assertEvidenceProgram', 'parseEvidenceProposal', 'bindEvidenceProposal', 'evaluateEvidencePredicate', 'initialEvidenceState', 'evidenceBinding',
      'advanceEvidenceState', 'createEvidenceVerifier', 'protectEvidenceContract', 'evidenceFilePath', 'readEvidenceFile', 'replaceEvidenceFile', 'evidenceEntropy', 'evidencePosterior',
      'expectedEvidenceGain', 'freezeDiagnosticModel', 'createDiagnosticController', 'runActiveEvidenceChecks', 'createMemoryCandidate', 'freezeEffectSuite', 'createHoldoutRegistry',
      'gateSignedEffects', 'createEffectCycle', 'createEvidenceArchive', 'createEvidenceStore', 'isEvidenceStore', 'archiveEvidenceArtifact', 'recoverEvidenceBlock', 'createFileStateAdapter',
      'createEvidenceCheckpoints', 'createEvidenceRuntime', 'createEvidenceHost', 'isEvidenceHost']) {
      assert.equal(typeof I[name], 'function', name); assert.ok(types.includes('export declare function ' + name + '(') || types.includes('export declare function ' + name + '<'), name)
    }
    for (const name of ['EVIDENCE_SCHEMA', 'CONTRACT_SCHEMA']) assert.ok(types.includes('export declare const ' + name))
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); assert.equal(Object.keys(pkg.dependencies || {}).length, 0)
  })
  await test('一条 CLI 演示完整复现，无模型/网络/费用；失败正文不在模型视图', async () => {
    const r = await runEvidenceDemo()
    assert.equal(r.modelCalls, 0); assert.equal(r.networkCalls, 0); assert.equal(r.cost, 0)
    assert.equal(r.first.status, 'rolled-back'); assert.equal(r.first.restoredFile, true); assert.deepEqual(r.first.restoredContext, ['用户原始任务'])
    assert.equal(r.second.status, 'verified'); assert.equal(r.second.fileVerified, true)
    assert.equal(r.counters.rounds, 2); assert.equal(r.counters.repairs, 2); assert.equal(r.counters.checks, 7)
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
