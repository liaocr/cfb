// Phase 2: memory semantics + real hook/HTTP routing. No external API calls.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-quality-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('./index.js')
const M = await import('./state-memory.js')
const S = await import('./snapshot-store.js')
let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) }
}
const e = (content, extra = {}) => ({ id: 'm1', category: 'state', content,
  origin: 'model', evidence: 'inferred', validity: 'active', scope: null, evidenceIds: [], ...extra })
const parsed = M.parseStateCompile('【当前有效状态】\n待验证状态')
const commit = (id, extra = {}) => S.commitSnapshot({ sessionId: id, branchId: 'main',
  entries: [e('当前状态')], coveredSeqs: [2], ...extra })
function legacy(id) {
  const x = S.emptySnapshot(id, 'main')
  delete x.memoryPolicyVersion
  x.revision = 1; x.entries = [e('部署已完成', { evidence: 'observed' })]
  x.coverage = { coveredSeqs: [2, 4], upTo: 4, entries: 1, at: 100, sourceCutSeq: 4 }
  x.applied = { at: 101, revision: 1, mode: 'old', seq: 5 }
  return x
}
const user = (seq, text) => ({ seq, type: 'user/message', data: { origin: 'user', role: 'user', content: [{ type: 'text', text }] } })
function session(id, text) {
  const ev = user(1, text)
  return { id, branchId: id + '-branch', surface: { nodes: [1] }, eventAt: seq => seq === 1 ? ev : null }
}
function chunks(raw = '推理内容'.repeat(250)) {
  return [{ type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: raw },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } },
    { type: 'finish', reason: { kind: 'end' } }]
}
const stream = xs => (async function* () { for (const x of xs) yield x })()
const drain = async s => { const xs = []; for await (const x of s) xs.push(x); return xs }
function waitSnapshot(sid, bid, revision = 1) {
  return new Promise((resolve, reject) => {
    const dir = S.snapshotsDir()
    let watcher, timer
    const check = () => {
      const s = S.loadSnapshot(sid, bid)
      if (s && s.revision >= revision) { watcher?.close(); clearTimeout(timer); resolve(s); return true }
      return false
    }
    watcher = fs.watch(dir, check)
    timer = setTimeout(() => { watcher.close(); reject(new Error('background snapshot not committed')) }, 2000)
    check()
  })
}

let srv
try {
  await test('projection namespace distinguishes independent compiles', () => {
    const a = M.createMemoryProjection({ namespace: 'compile-A' }).ingest(parsed)
    const b = M.createMemoryProjection({ namespace: 'compile-B' }).ingest(parsed)
    assert.notEqual(a[0].id, b[0].id)
  })
  await test('correction pointers remain valid inside namespace', () => {
    const p = M.createMemoryProjection({ namespace: 'compile-A' })
    const old = p.add({ content: '旧值' }), newer = p.correct(old.id, { content: '新值' })
    assert.equal(newer.supersedes, old.id); assert.equal(p.all()[0].validity, 'superseded')
  })
  await test('explicit object metadata survives projection, absent metadata not invented', () => {
    const p = M.createMemoryProjection()
    const a = p.add({ content: 'A', objectId: 'obj', problemId: 'p', propositionKind: 'current-state' })
    assert.equal(a.objectId, 'obj'); assert.equal(a.problemId, 'p'); assert.equal(a.propositionKind, 'current-state')
    assert.equal(p.add({ content: 'B' }).objectId, null)
  })
  await test('same local ID does not associate unknown objects', () => {
    const xs = M.mergeByEvidence([e('部署通过', { evidence: 'observed' }), e('文件不存在', { evidence: 'observed' })])
    assert.equal(xs.length, 2); assert.ok(xs.every(x => x.validity === 'active' && !x.relation))
  })
  await test('missing IDs/objects do not require randomness', () => {
    const xs = [e('A', { id: null }), e('B', { id: null })]
    assert.deepEqual(M.mergeByEvidence(structuredClone(xs)), M.mergeByEvidence(structuredClone(xs)))
  })
  await test('same object/text in different scopes must remain two records', () => {
    const xs = M.mergeByEvidence([e('测试通过', { objectId: 'test', scope: 'config-A' }), e('测试通过', { objectId: 'test', scope: 'config-B' })])
    assert.equal(xs.length, 2); assert.deepEqual(xs.map(x => x.scope), ['config-A', 'config-B'])
  })
  await test('unknown scope does not erase known scope even with identical text', () => {
    const xs = M.mergeByEvidence([e('通过', { objectId: 'test' }), e('通过', { objectId: 'test', scope: 'config-A' })])
    assert.equal(xs.length, 2); assert.equal(xs[0].validity, 'historical'); assert.equal(xs[1].validity, 'active')
  })
  await test('same-scope duplicates combine unique references only', () => {
    const xs = M.mergeByEvidence([e('通过', { scope: 'A', evidenceIds: ['E1'] }), e('通过', { scope: 'A', evidenceIds: ['E1', 'E2'] })])
    assert.equal(xs.length, 1); assert.deepEqual(xs[0].evidenceIds, ['E1', 'E2'])
  })
  await test('equal wording with different validity is not silently deduplicated', () => {
    assert.equal(M.mergeByEvidence([e('通过', { scope: 'A', validity: 'historical' }), e('通过', { scope: 'A' })]).length, 2)
  })
  await test('equal wording with different evidence grades retains both records', () => {
    assert.equal(M.mergeByEvidence([e('通过', { scope: 'A', evidence: 'observed' }), e('通过', { scope: 'A' })]).length, 2)
  })
  await test('ordered prose merge defaults to inferred, not observed', () => {
    const r = M.mergeOrdered([{ ok: true, sourceIndex: 0, parsed }])
    assert.ok(r.entries.length); assert.ok(r.entries.every(x => x.evidence === 'inferred'))
  })
  await test('compile prompt does not promote saved snapshots to verified facts', () => {
    const env = M.buildEvidenceEnvelope({ cot: 'x', stateSnapshot: { text: '旧判断', revision: 1 } })
    const prompt = M.buildStateCompilePrompt(env)
    assert.doesNotMatch(prompt, /权威基线|已归档，非推测|以\*\*新材料\*\*为准/)
    assert.match(prompt, /不证明每个判断已经独立核验/)
    assert.match(prompt, /新材料不因较新就自动胜出/)
  })
  await test('compile prompt preserves uncertainty rather than banning it', () => {
    const prompt = M.buildStateCompilePrompt(M.buildEvidenceEnvelope({ cot: '原因可能是上游抖动。' }))
    assert.match(prompt, /「可能」「未确认」必须保持原强度/)
    assert.doesNotMatch(prompt, /严禁.*软性措辞/)
  })
  await test('prohibition example does not invent a completed phase', () => {
    const prompt = M.buildStateCompilePrompt(M.buildEvidenceEnvelope({ cot: '禁止再动代码' }))
    assert.match(prompt, /用户明确禁止继续修改代码/)
    assert.doesNotMatch(prompt, /⇒「代码修改阶段已结束/)
  })
  await test('new snapshots carry explicit memory policy version', () => assert.equal(commit('new-policy').snapshot.memoryPolicyVersion, M.MEMORY_POLICY_VERSION))
  await test('legacy load keeps text but revokes unverified evidence grade and old coverage', () => {
    const x = legacy('legacy'), f = S.snapshotPath('legacy', 'main')
    fs.writeFileSync(f, JSON.stringify(x)); const before = fs.readFileSync(f, 'utf8')
    const got = S.loadSnapshot('legacy', 'main')
    assert.equal(got.entries[0].content, x.entries[0].content)
    assert.equal(got.entries[0].evidence, 'inferred'); assert.equal(got.entries[0].legacyEvidence, 'observed')
    assert.deepEqual(got.coverage.coveredSeqs, []); assert.equal(got.applied, null)
    assert.equal(got.migratedFromPolicy, 1); assert.equal(fs.readFileSync(f, 'utf8'), before)
  })
  await test('legacy normalization is idempotent', () => {
    const one = S.validateSnapshot(legacy('idem')).snapshot
    assert.deepEqual(S.validateSnapshot(one).snapshot, one)
  })
  await test('legacy provenance warning is visible, not hidden metadata', () => {
    const text = S.snapshotToText(legacy('visible'))
    assert.match(text, /旧版模型编译记录/); assert.match(text, /未独立核验/)
  })
  await test('raw legacy object cannot authorize coverage omission', () => assert.equal(S.coveredSeqSet(legacy('direct')).size, 0))
  await test('post-migration commit covers only new evidence and keeps old prose', () => {
    const f = S.snapshotPath('migrate-commit', 'main'); fs.writeFileSync(f, JSON.stringify(legacy('migrate-commit')))
    const c = commit('migrate-commit', { entries: [e('新增观察', { id: 'compile-new:m1' })], coveredSeqs: [8] })
    assert.ok(c.ok); assert.deepEqual(c.snapshot.coverage.coveredSeqs, [8])
    assert.ok(c.snapshot.entries.some(x => x.content === '部署已完成'))
    assert.equal(S.loadSnapshot('migrate-commit', 'main').memoryPolicyVersion, M.MEMORY_POLICY_VERSION)
  })
  await test('separate commits with compile-local IDs preserve unrelated active states', () => {
    commit('local-ids', { entries: [e('文件已写入')], coveredSeqs: [2] })
    const c = commit('local-ids', { entries: [e('进程尚未确认')], coveredSeqs: [4] })
    assert.equal(c.snapshot.entries.length, 2)
    assert.ok(c.snapshot.entries.every(x => x.validity === 'active' && !x.relation))
    assert.deepEqual(c.snapshot.coverage.coveredSeqs, [2, 4])
  })
  await test('persistent model prose cannot claim observed even under new policy', () => {
    const c = commit('forged-grade', { entries: [e('猜测', { evidence: 'observed' })] })
    assert.equal(c.snapshot.entries[0].evidence, 'inferred')
  })
  await test('explicit tool observations are not downgraded', () => {
    const c = commit('tool-grade', { entries: [e('退出码0', { origin: 'tool', source: 'tool', evidence: 'observed' })] })
    assert.equal(c.snapshot.entries[0].evidence, 'observed')
  })
  await test('future memory policy is not guessed', () => {
    const x = S.emptySnapshot('future', 'main'); x.memoryPolicyVersion = 99
    assert.equal(S.validateSnapshot(x).reason, 'memory-policy-mismatch')
  })
  await test('commit never overwrites a future-policy or corrupt existing snapshot', () => {
    for (const [id, body] of [['future-write', JSON.stringify({ ...legacy('future-write'), memoryPolicyVersion: 99 })], ['corrupt-write', '{broken']]) {
      const f = S.snapshotPath(id, 'main'); fs.writeFileSync(f, body)
      const c = commit(id)
      assert.equal(c.ok, false); assert.equal(c.reason, 'invalid-existing-snapshot')
      assert.equal(fs.readFileSync(f, 'utf8'), body)
    }
  })
  await test('direct birthStart dry-run does not archive, compile or create a task', () => {
    let called = 0
    const t = I.birthStart({ index: 0, text: 'x'.repeat(1000) }, { cfg: { dryRun: true }, archive: () => { called++ }, distill: () => { called++ } })
    assert.equal(called, 0); assert.equal(t.belowFloor, true); assert.equal(t.why, 'dry-run')
  })
  await test('direct birthStart disabled/off is transparent', () => {
    for (const cfg of [{ enabled: false }, { mode: 'off' }]) {
      const t = I.birthStart({ index: 0, text: 'x'.repeat(1000) }, { cfg, archive: () => { throw Error('must not call') } })
      assert.equal(t.why, 'disabled')
    }
  })
  const requests = [], archives = []
  let httpStatus = 200
  srv = http.createServer((req, res) => {
    let text = ''; req.on('data', c => { text += c })
    req.on('end', () => {
      const body = JSON.parse(text || '{}')
      requests.push({ url: req.url, body, authorization: req.headers.authorization })
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(httpStatus === 200 ? { choices: [{ finish_reason: 'stop', message: { content:
        body.messages?.[0]?.content.startsWith('任务：只提炼') ? '【关键判断与依据】\n运行进程是否加载尚未确认。\n【未决差距】\n缺运行版本证据。' : '【当前有效状态】\n构建文件已写入。\n【关键判断与依据】\n运行进程是否加载尚未确认。\n【未决差距】\n缺运行版本证据。' } }] } : { error: 'denied' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const credentialsPath = path.join(home, 'credentials.yaml'), settingsPath = path.join(home, 'settings.yaml')
  fs.writeFileSync(credentialsPath, 'KEY_A: local-A\nKEY_B: local-B\n')
  fs.writeFileSync(settingsPath, `llm-pi-ai:\n  providers:\n    provider-A:\n      api: openai-completions\n      baseURL: ${base}/a/v1\n      apiKeyEnv: KEY_A\n    provider-B:\n      api: openai-completions\n      baseURL: ${base}/b/v1\n      apiKeyEnv: KEY_B\n`)
  const config = { mode: 'birth', dryRun: false, stateMemory: true, prewarm: false, keepAlive: false,
    trace: false, baseUrl: base, model: 'same-model', settingsPath, credentialsPath,
    credentialRef: 'KEY_A', followHostModel: true, followHostProvider: true,
    maxAttempts: 1, timeoutMs: 1500, birthFinishWaitMs: 300, birthMinChars: 50 }
  function harness(over = {}) {
    const hooks = new Map()
    I.apply({ on: (name, fn) => hooks.set(name, fn), get: name => name === 'cmbStore' ? {
      putText: async (raw, opts) => { archives.push({ raw, opts }); return { handle: 'archive-' + opts.sessionId } },
    } : null }, { ...config, ...over })
    return { pre: s => hooks.get('agent/pre-step')({ agent: { session: s } }, async () => ({})),
      llm: (options, inner) => hooks.get('llm/stream')(options, () => inner) }
  }
  await test('generateStateMemory creates unique compile IDs and inferred grades on real HTTP', async () => {
    const env = M.buildEvidenceEnvelope({ cot: '推理', at: 123, host: { blockIndex: 0 } })
    const [a, b] = await Promise.all([I.generateStateMemory(env, config), I.generateStateMemory(env, config)])
    assert.ok(a.entries.every(x => x.evidence === 'inferred'))
    assert.ok(a.entries.every(x => x.at === 123))
    const ids = new Set(a.entries.map(x => x.id)); assert.ok(b.entries.every(x => !ids.has(x.id)))
    assert.match(a.text, /模型编译/); assert.match(a.checkpointText, /模型编译/)
    assert.equal(a.meta.memoryPolicyVersion, M.MEMORY_POLICY_VERSION)
  })
  for (const [name, overrides] of [['disabled', { enabled: false }], ['off', { mode: 'off' }], ['dry-run', { dryRun: true }]]) {
    await test(`REAL llm hook ${name} preserves stream identity and makes zero calls`, async () => {
      const h = harness(overrides), xs = chunks(), inner = stream(xs)
      const beforeR = requests.length, beforeA = archives.length
      const ret = h.llm({ model: 'same-model', provider: 'provider-A', messages: [] }, inner)
      assert.equal(ret, inner); assert.deepEqual(await drain(ret), xs)
      assert.equal(requests.length, beforeR); assert.equal(archives.length, beforeA)
    })
  }
  await test('same model changing provider routes the next compile to the new endpoint/key', async () => {
    const h = harness(); await h.pre(session('provider-session', '要求'))
    const n = requests.length
    await drain(h.llm({ model: 'same-model', provider: 'provider-A', messages: [] }, stream(chunks())))
    await waitSnapshot('provider-session', 'provider-session-branch', 1)
    await drain(h.llm({ model: 'same-model', provider: 'provider-B', messages: [] }, stream(chunks())))
    await waitSnapshot('provider-session', 'provider-session-branch', 2)
    assert.equal(requests[n].url, '/a/v1/chat/completions'); assert.equal(requests[n + 1].url, '/b/v1/chat/completions')
    assert.equal(requests[n].authorization, 'Bearer local-A'); assert.equal(requests[n + 1].authorization, 'Bearer local-B')
  })
  await test('interleaved acquired streams retain session, evidence, model, provider and branch', async () => {
    const h = harness(), n = requests.length, an = archives.length
    await h.pre(session('session-A', 'ONLY_USER_A'))
    const a = h.llm({ model: 'model-A', provider: 'provider-A', messages: [] }, stream(chunks('A'.repeat(1000))))
    await h.pre(session('session-B', 'ONLY_USER_B'))
    const b = h.llm({ model: 'model-B', provider: 'provider-B', messages: [] }, stream(chunks('B'.repeat(1000))))
    await drain(a); await drain(b)
    await Promise.all([waitSnapshot('session-A', 'session-A-branch'), waitSnapshot('session-B', 'session-B-branch')])
    assert.equal(requests[n].url, '/a/v1/chat/completions'); assert.equal(requests[n].body.model, 'model-A')
    assert.match(requests[n].body.messages[0].content, /ONLY_USER_A/); assert.doesNotMatch(requests[n].body.messages[0].content, /ONLY_USER_B/)
    assert.equal(requests[n + 1].url, '/b/v1/chat/completions'); assert.equal(requests[n + 1].body.model, 'model-B')
    assert.deepEqual(archives.slice(an).filter(x => x.opts.producer === 'cot-birth').map(x => x.opts.sessionId), ['session-A', 'session-B'])
    assert.ok(S.loadSnapshot('session-A', 'session-A-branch')); assert.ok(S.loadSnapshot('session-B', 'session-B-branch'))
    assert.equal(S.loadSnapshot('session-A', 'session-B-branch'), null)
  })
} finally {
  if (srv) { srv.closeAllConnections(); await new Promise(r => srv.close(r)) }
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
