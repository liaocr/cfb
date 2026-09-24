// Production-path regressions. No provider calls; HTTP tests use loopback only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-optimization-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('../index.js')
const S = await import('../src/snapshot-store.js')
const M = await import('../src/state-memory.js')
let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) }
}
const entry = (content = '当前状态', extra = {}) => ({ id: 'm1', category: 'state', content,
  origin: 'model', evidence: 'inferred', validity: 'active', evidenceIds: [], ...extra })
const commit = (sid, extra = {}) => S.commitSnapshot({ sessionId: sid, branchId: 'main',
  entries: [entry()], coveredSeqs: [2], sourceCutSeq: 2, ...extra })
const user = (seq, text) => ({ seq, type: 'user/message', data: { origin: 'user', role: 'user', content: [{ type: 'text', text }] } })
const assistant = (seq, raw) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: raw }] } } })
function evidence(count = 12) {
  const events = []
  for (let i = 0; i < count; i++) {
    events.push({ seq: i * 2 + 1, type: 'assistant/message', toolCalls: [{ id: 'tc' + i, name: 'read', args: '{}' }] })
    events.push({ seq: i * 2 + 2, type: 'tool/result', toolCallId: 'tc' + i, text: '证据' + i + ':'.repeat(500), isError: false })
  }
  return { events, inFlightIds: new Set(), cutSeq: count * 2 }
}
async function runBirth(sid, cfg = {}, archive = async () => 'h') {
  let input, options
  const traces = []
  const task = I.birthStart({ index: 0, text: '推理'.repeat(400) }, {
    sessionId: sid, cfg: { stateMemory: true, birthDeferredClaim: true, ...cfg },
    archive, buildEnvelope: M.buildEvidenceEnvelope,
    collectEvidence: (o) => { options = o; return evidence() },
    distill: async (env) => { input = env; return { text: '精简状态', entries: [entry()], checkpointText: '【当前有效状态】\n精简状态' } },
    trace: (tag, data) => traces.push({ tag, data }),
  })
  await task.distillP
  return { task, input, options, traces }
}
try {
  await test('snapshot path respects DSH_HOME', () => assert.ok(S.snapshotPath('s', 'main').startsWith(home + path.sep)))
  await test('catalog path respects DSH_HOME', () => assert.ok(S.casCatalogPath().startsWith(home + path.sep)))
  await test('commit and disk load round-trip', () => { assert.ok(commit('round').ok); assert.equal(S.loadSnapshot('round', 'main').revision, 1) })
  await test('wrong branch cannot load a snapshot', () => assert.equal(S.loadSnapshot('round', 'other'), null))
  await test('merge preserves earlier entries and coverage', () => {
    const c = commit('round', { entries: [entry('第二条', { id: 'm2' })], coveredSeqs: [4], sourceCutSeq: 4 })
    assert.ok(c.ok); assert.equal(c.snapshot.entries.length, 2); assert.deepEqual(c.snapshot.coverage.coveredSeqs, [2, 4])
  })
  await test('compile does not mark host application', () => assert.equal(S.loadSnapshot('round', 'main').applied, null))
  await test('★ identical judgments re-committed do not grow the snapshot (hybrid entries have no objectKey)', () => {
    let c
    for (let i = 0; i < 5; i++) c = S.commitSnapshot({ sessionId: 'bounded', branchId: 'main', coveredSeqs: [],
      entries: [entry('判断甲', { id: 'x' + i, at: i }), entry('差距乙', { id: 'y' + i, at: i, category: 'gap' })] })
    assert.ok(c.ok); assert.equal(c.snapshot.revision, 5); assert.equal(c.snapshot.entries.length, 2)
    assert.equal(c.added, 0)
  })
  await test('snapshot entries are capped, keeping the newest', () => {
    const many = Array.from({ length: S.SNAPSHOT_ENTRIES_MAX + 40 }, (_, i) => entry('条目' + i, { id: 'c' + i }))
    const kept = S.boundSnapshotEntries(many)
    assert.equal(kept.length, S.SNAPSHOT_ENTRIES_MAX)
    assert.equal(kept.at(-1).content, '条目' + (S.SNAPSHOT_ENTRIES_MAX + 39)); assert.equal(kept[0].content, '条目40')
  })

  await test('applied marker requires explicit matching revision', () => assert.equal(S.markSnapshotApplied('round', 'main', {}), false))
  await test('stale applied revision is rejected', () => assert.equal(S.markSnapshotApplied('round', 'main', { revision: 1 }), false))
  await test('explicit current revision may be marked applied', () => assert.equal(S.markSnapshotApplied('round', 'main', { revision: 2 }), true))
  await test('lock contention returns immediately and never writes unlocked', () => {
    const file = S.snapshotPath('round', 'main'), before = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file + '.lock', 'another-writer')
    const start = performance.now(), result = commit('round')
    assert.equal(result.ok, false); assert.equal(result.reason, 'lock-busy')
    assert.ok(performance.now() - start < 500, 'must not sleep 2500 ms')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'another-writer')
    fs.unlinkSync(file + '.lock')
  })
  await test('old live lock is not stolen by age', () => {
    const f = S.snapshotPath('round', 'main') + '.lock'; fs.writeFileSync(f, 'live')
    fs.utimesSync(f, new Date(0), new Date(0))
    assert.equal(commit('round').reason, 'lock-busy'); fs.unlinkSync(f)
  })
  await test('invalid/empty compile cannot advance coverage', () => {
    const before = S.loadSnapshot('round', 'main')
    assert.equal(commit('round', { entries: [], coveredSeqs: [99] }).ok, false)
    assert.equal(commit('round', { entries: [{ content: 'missing category' }] }).ok, false)
    assert.deepEqual(S.loadSnapshot('round', 'main'), before)
  })
  await test('merge exception preserves prior snapshot byte-for-byte', () => {
    const f = S.snapshotPath('round', 'main'), before = fs.readFileSync(f, 'utf8')
    const e = entry('circular'); e.circular = e
    assert.equal(commit('round', { entries: [e], coveredSeqs: [99] }).ok, false)
    assert.equal(fs.readFileSync(f, 'utf8'), before)
  })
  await test('coverage without state is invalid', () => {
    const x = S.emptySnapshot('bad', 'main'); x.coverage.coveredSeqs = [2]
    assert.equal(S.validateSnapshot(x).ok, false)
  })
  await test('invalid coverage is not silently coerced', () => {
    const x = commit('validate').snapshot; x.coverage.coveredSeqs = [null, 2.5]
    assert.equal(S.validateSnapshot(x).ok, false)
  })
  await test('materialization validates session before touching disk', () => {
    assert.equal(S.materializeSnapshot('other', 'main', S.loadSnapshot('round', 'main')).ok, false)
    assert.equal(S.loadSnapshot('other', 'main'), null)
  })
  await test('materialization respects lock', () => {
    const x = commit('material').snapshot, f = S.snapshotPath('material', 'main')
    x.revision++; fs.writeFileSync(f + '.lock', 'writer')
    assert.equal(S.materializeSnapshot('material', 'main', x).reason, 'lock-busy')
    fs.unlinkSync(f + '.lock')
  })
  await test('rendering preserves conflict/scope markers', () => {
    const x = commit('markers', { entries: [entry('待定', { validity: 'conflict', scope: 'build-A' })] }).snapshot
    assert.match(S.snapshotToText(x), /存在冲突/); assert.match(S.snapshotToText(x), /build-A/)
  })
  await test('oversized snapshot does not return a partial view', () => {
    const x = commit('oversize', { entries: [entry('长'.repeat(13000))] }).snapshot
    assert.equal(S.snapshotToText(x), '')
    assert.ok(S.snapshotToText(x, { maxChars: 20000 }).length > 13000)
  })
  const covered = Array.from({ length: 12 }, (_, i) => i * 2 + 2)
  await test('production birth path injects snapshot and filters covered tools', async () => {
    commit('filter-on', { coveredSeqs: covered })
    const r = await runBirth('filter-on')
    assert.equal(r.input.tools.length, 8); assert.ok(r.input.stateSnapshot.text.includes('当前状态'))
    assert.equal(r.options.structural, false)
    assert.equal(r.traces.find(x => x.tag === 'state-envelope').data.cover.dropped, 4)
  })
  await test('stateCoveredEvidence:false genuinely restores all tools', async () => {
    commit('filter-off', { coveredSeqs: covered })
    const r = await runBirth('filter-off', { stateCoveredEvidence: false })
    assert.equal(r.input.tools.length, 12); assert.ok(r.input.stateSnapshot)
  })
  await test('no full snapshot view means no filtering', async () => {
    commit('oversize-birth', { coveredSeqs: covered, entries: [entry('大'.repeat(13000))] })
    const r = await runBirth('oversize-birth')
    assert.equal(r.input.tools.length, 12); assert.equal(r.input.stateSnapshot, null)
    assert.ok(r.traces.some(x => x.tag === 'state-snapshot-view-unavailable'))
  })
  await test('stateSnapshot:false avoids reads and writes', async () => {
    commit('snapshot-off', { coveredSeqs: covered })
    const before = S.loadSnapshot('snapshot-off', 'main')
    const r = await runBirth('snapshot-off', { stateSnapshot: false })
    assert.equal(r.input.tools.length, 12); assert.equal(r.input.stateSnapshot, null)
    assert.deepEqual(S.loadSnapshot('snapshot-off', 'main'), before)
  })
  await test('archive failure cannot persist or stage compiled memory', async () => {
    const r = await runBirth('archive-fail', {}, async () => null)
    assert.equal(r.task.diskState.ok, false); assert.equal(S.loadSnapshot('archive-fail', 'main'), null)
    assert.equal(I.lateMemorySize('archive-fail'), 0)
  })
  await test('cache-identity trace does not throw outside apply scope', async () => {
    const r = await runBirth('trace-identity', { stateCacheKeyTrace: true })
    assert.ok(r.traces.some(x => x.tag === 'state-cache-identity'))
    assert.ok(!r.traces.some(x => x.tag === 'state-envelope-error'))
  })
  await test('mid-surface replacement invalidates index even if ends/size unchanged', () => {
    const map = new Map([user(1, 'head'), user(2, 'old'), user(3, 'tail'), user(4, 'new')].map(x => [x.seq, x]))
    let reads = 0
    const sess = { surface: { nodes: [1, 2, 3] }, eventAt: s => { reads++; return map.get(s) } }
    I.evidenceIndex(sess); assert.equal(reads, 3)
    sess.surface.nodes = [1, 4, 3]
    const idx = I.evidenceIndex(sess)
    assert.deepEqual(idx.events.map(x => x.seq), [1, 4, 3]); assert.equal(reads, 4)
  })
  await test('append normalizes only new surviving events', () => {
    let reads = 0
    const sess = { surface: { nodes: [1, 2] }, eventAt: s => { reads++; return user(s, 'text') } }
    I.evidenceIndex(sess); sess.surface.nodes.push(3); I.evidenceIndex(sess); I.evidenceIndex(sess)
    assert.equal(reads, 3)
  })
  await test('reverse completion order removes ALL consumed blocks', () => {
    const sid = 'reverse', a = '甲'.repeat(80), b = '乙'.repeat(80)
    I.pushLateMemory(sid, b, [entry()], 'B'); I.pushLateMemory(sid, a, [entry()], 'A')
    assert.deepEqual(I.claimLateMemory(sid, a + '\n' + b).texts, ['A', 'B'])
    assert.equal(I.lateMemorySize(sid), 0)
  })
  await test('receipt cannot consume a replacement that arrived during await', () => {
    I.pushLateMemory('receipt', 'raw', [entry()], 'old', { taskId: 'same-task' })
    const c = I.peekLateMemory('receipt', 'raw')
    I.pushLateMemory('receipt', 'raw', [entry()], 'new', { taskId: 'same-task' })
    assert.equal(I.acknowledgeLateMemory('receipt', c.receipt), 0)
    assert.deepEqual(I.peekLateMemory('receipt', 'raw').texts, ['new'])
  })
  async function hookFixture(sid, config = {}) {
    const hooks = new Map(), traceFile = path.join(home, sid + '.log')
    I.apply({ on: (n, fn) => hooks.set(n, fn), get: () => null }, {
      mode: 'birth', birthDeferredClaim: true, dryRun: false, trace: true, traceFile, prewarm: false, ...config,
    })
    const raw = '原'.repeat(1000)
    const events = [user(1, 'u'), assistant(2, raw), user(3, 'u2'), assistant(4, 'tail')]
    const map = new Map(events.map(x => [x.seq, x]))
    const session = { id: sid, surface: { nodes: events.map(x => x.seq) }, eventAt: q => map.get(q),
      requestContext: () => ({ contextWindow: 100000 }), append: () => { throw Error('injected append failure') } }
    I.pushLateMemory(sid, raw, [entry()], '【当前有效状态】\n已存状态')
    const fire = () => hooks.get('agent/pre-step')({ agent: { session } }, async () => ({ allow: true }))
    return { session, fire, traceFile }
  }
  await test('REAL pre-step hook retains late result on append failure, retries successfully', async () => {
    const h = await hookFixture('hook-retry')
    commit('hook-retry')
    await h.fire(); assert.equal(I.lateMemorySize('hook-retry'), 1)
    h.session.append = () => ({ seq: 9 })
    await h.fire(); assert.equal(I.lateMemorySize('hook-retry'), 0)
    assert.equal(S.loadSnapshot('hook-retry', 'main').applied, null, 'partial ledger must not mark full snapshot')
    assert.match(fs.readFileSync(h.traceFile, 'utf8'), /birth-claim-acknowledged/)
  })
  await test('REAL pre-step dry-run never consumes late result', async () => {
    const h = await hookFixture('hook-dry', { dryRun: true })
    await h.fire(); assert.equal(I.lateMemorySize('hook-dry'), 1)
  })
  await test('BOOT includes active snapshot and birth switches', async () => {
    const h = await hookFixture('boot')
    const line = fs.readFileSync(h.traceFile, 'utf8').split('\n').find(l => /^\[.*\] \[BOOT\]/.test(l))
    const data = JSON.parse(line.slice(line.indexOf('{')))
    assert.equal(data.birth.finishWaitMs, 1500); assert.equal(data.stateCoveredEvidence, true)
    assert.match(data.deps, /snapshot-store\.js=/)
  })
  await test('standalone onboard detects correct deployment and actual drift', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const profile = path.join(home, 'profiles', 'web')
    const installed = path.join(profile, 'node_modules', '@dsh-external', 'dsh-cot-form-b')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@dsh-external/dsh-cot-form-b'] } },
      dependencies: { '@dsh-external/dsh-cot-form-b': 'file:' + root },
    }))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: cot-form-b\n')
    fs.cpSync(root, installed, { recursive: true, filter: p => !p.split(path.sep).includes('.git') })
    const run = () => spawnSync(process.execPath, [path.join(root, 'deploy/onboard.mjs')], { encoding: 'utf8' })
    const clean = run(); assert.equal(clean.status, 0, clean.stdout + clean.stderr)
    assert.match(clean.stdout, /与源树一致/)
    fs.appendFileSync(path.join(installed, 'index.js'), '\n// drift')
    const drift = run(); assert.equal(drift.status, 4, drift.stdout + drift.stderr)
    assert.match(drift.stdout, /内容不同 1/)
  })
  // Real HTTP transport regression: all protocol variants obey the same terminal gate.
  let response = 'json-length'
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (response.startsWith('sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const finish = response === 'sse-length' ? 'length' : response === 'sse-stop' ? 'stop' : null
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial-or-complete' }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'partial-or-complete' }, finish_reason: response === 'json-stop' ? 'stop' : 'length' }] }))
      }
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const cred = path.join(home, 'credentials.yaml'); fs.writeFileSync(cred, 'TEST_KEY: local-only\n')
  const cfg = I.normalizeConfig({ model: 'local-test', baseUrl: 'http://127.0.0.1:' + server.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY', maxAttempts: 1, timeoutMs: 1000, keepAlive: false })
  try {
    for (const stream of [false, true]) {
      for (const mode of ['json-length', 'sse-length', 'sse-missing']) {
        await test(`transport stream=${stream} ${mode} rejects partial output with prompt fingerprint`, async () => {
          response = mode
          await assert.rejects(I.generateDistillation('x', { ...cfg, distillStream: stream }), e => {
            assert.ok(e.meta.promptChars > 0); assert.notEqual(e.meta.finish, 'stop'); return true
          })
        })
      }
      for (const mode of ['json-stop', 'sse-stop']) {
        await test(`transport stream=${stream} ${mode} accepts complete output`, async () => {
          response = mode
          assert.equal((await I.generateDistillation('x', { ...cfg, distillStream: stream })).text, 'partial-or-complete')
        })
      }
    }
  } finally { await new Promise(r => server.close(r)) }
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
