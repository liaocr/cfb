import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-late-')), oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const I = await import('../index.js'), M = await import('../state-memory.js')
const { runPreStepEmit } = await import('../emitter.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const entries = () => [{ id: 'm1', category: 'state', content: '状态', evidence: 'inferred', origin: 'model', validity: 'active' }]
const scope = branchId => ({ branchId })
const raw = '原始推理'.repeat(250)
function session(sid, branchId, duplicate = false) {
  const user = seq => ({ seq, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '目标' }] } })
  const assistant = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text }] } } })
  const events = [user(1), assistant(2, raw), user(3), assistant(4, duplicate ? raw : 'active tail')]
  let appends = 0
  return { id: sid, branchId, surface: { nodes: events.map(e => e.seq) }, eventAt: n => events.find(e => e.seq === n),
    requestContext: () => ({ contextWindow: 100000 }), append: () => { appends++; return { seq: 9 } }, get appends() { return appends } }
}
try {
  await test('same session and raw cannot cross branch boundaries', () => {
    I.pushLateMemory('branches', raw, entries(), 'A', scope('A'))
    assert.equal(I.peekLateMemory('branches', raw, scope('B')), null)
    assert.equal(I.lateMemorySize('branches'), 0)
    assert.deepEqual(I.claimLateMemory('branches', raw, scope('A')).texts, ['A'])
  })
  await test('JSON keys do not collide through concatenation delimiters', () => {
    I.pushLateMemory('a|b', raw, entries(), 'one', scope('c'))
    I.pushLateMemory('a', raw, entries(), 'two', scope('b|c'))
    assert.deepEqual(I.claimLateMemory('a|b', raw, scope('c')).texts, ['one'])
    assert.deepEqual(I.claimLateMemory('a', raw, scope('b|c')).texts, ['two'])
  })
  await test('different tasks with identical reasoning remain ambiguous, not last-writer-wins', () => {
    I.pushLateMemory('amb', raw, entries(), 'one', { taskId: '1' })
    I.pushLateMemory('amb', raw, entries(), 'two', { taskId: '2' })
    assert.equal(I.peekLateMemory('amb', raw), null); assert.equal(I.lateMemorySize('amb'), 2)
  })
  await test('same task retry is replaceable but old emission receipt becomes invalid', () => {
    I.pushLateMemory('retry', raw, entries(), 'old', { taskId: '1' })
    const old = I.peekLateMemory('retry', raw)
    I.pushLateMemory('retry', raw, entries(), 'new', { taskId: '1' })
    assert.equal(I.lateReceiptValid('retry', old.receipt), false)
    assert.equal(I.acknowledgeLateMemory('retry', old.receipt), 0)
    assert.equal(I.lateMemorySize('retry'), 1); assert.deepEqual(I.claimLateMemory('retry', raw).texts, ['new'])
  })
  await test('ambiguous marker survives eviction of one colliding record', () => {
    I.pushLateMemory('eviction', raw, entries(), 'one')
    I.pushLateMemory('eviction', raw, entries(), 'two')
    for (let i = 0; i < 7; i++) I.pushLateMemory('eviction', 'other-' + i, entries(), 'other')
    assert.equal(I.lateMemorySize('eviction'), 8); assert.equal(I.peekLateMemory('eviction', raw), null)
  })
  await test('new collision invalidates an already peeked receipt before emission', () => {
    I.pushLateMemory('race', raw, entries(), 'old')
    const c = I.peekLateMemory('race', raw); assert.equal(I.lateReceiptValid('race', c.receipt), true)
    I.pushLateMemory('race', raw, entries(), 'new')
    assert.equal(I.lateReceiptValid('race', c.receipt), false)
  })
  await test('wrong branch acknowledgement cannot consume another branch result', () => {
    I.pushLateMemory('ack', raw, entries(), 'A', scope('A'))
    const c = I.peekLateMemory('ack', raw, scope('A'))
    assert.equal(I.acknowledgeLateMemory('ack', c.receipt, scope('B')), 0)
    assert.equal(I.acknowledgeLateMemory('ack', c.receipt, scope('A')), 1)
  })
  await test('cached entries are independent and immutable', () => {
    const es = entries(); I.pushLateMemory('frozen', raw, es, 'board'); es[0].content = 'changed later'
    const c = I.peekLateMemory('frozen', raw); assert.equal(c.entries[0].content, '状态')
    assert.throws(() => { c.entries[0].content = 'mutate' }, TypeError)
  })
  await test('oversize late item is rejected rather than retaining unbounded raw data', () => {
    assert.equal(I.pushLateMemory('huge', 'x'.repeat(256 * 1024), entries(), 'board'), false)
    assert.equal(I.lateMemorySize('huge'), 0)
  })
  await test('production birth settlement stores in its captured branch and carries task ID', async () => {
    const t = I.birthStart({ index: 0, text: raw }, { sessionId: 'born', branchId: 'branch-X',
      cfg: { stateMemory: true, stateSnapshot: false, birthDeferredClaim: true }, archive: async () => 'h', buildEnvelope: M.buildEvidenceEnvelope,
      distill: async () => ({ text: '简短状态', entries: entries(), checkpointText: 'board' }) })
    t.passedThrough = true; await t.distillP
    assert.equal(I.lateMemorySize('born'), 0)
    const c = I.peekLateMemory('born', raw, scope('branch-X'))
    assert.equal(c.count, 1); assert.equal(c.receipt[0].taskId, t.taskId)
  })
  for (const duplicate of [false, true]) await test(`real pre-step branch claim, duplicate surface = ${duplicate}`, async () => {
    const hooks = new Map(), sid = 'hook-' + duplicate
    I.apply({ on: (n, fn) => hooks.set(n, fn), get: () => null }, { mode: 'birth', birthDeferredClaim: true, dryRun: false, trace: false, prewarm: false })
    I.pushLateMemory(sid, raw, entries(), '【当前有效状态】\n已记录', scope('branch-A'))
    const wrong = session(sid, 'branch-B', duplicate)
    await hooks.get('agent/pre-step')({ agent: { session: wrong } }, async () => ({})); assert.equal(wrong.appends, 0)
    const right = session(sid, 'branch-A', duplicate)
    await hooks.get('agent/pre-step')({ agent: { session: right } }, async () => ({}))
    assert.equal(right.appends, duplicate ? 0 : 1)
    assert.equal(I.lateMemorySize(sid, scope('branch-A')), duplicate ? 1 : 0)
  })
  await test('emitter rechecks pending receipt after async preparation', async () => {
    const s = session('pipeline', 'main'); let valid = true
    const r = await runPreStepEmit({ session: s, cfg: { keepTail: 1 },
      rawOf: async e => e.data?.message?.content?.[0]?.text,
      awaitDistilled: async () => { queueMicrotask(() => { valid = false }); return { ok: true, text: 'ready' } },
      validatePending: () => valid })
    assert.equal(r.reason, 'stale-distill'); assert.equal(s.appends, 0)
  })
  await test('aggregate serialized size is bounded, not just record count', () => {
    let accepted = 0
    for (let i = 0; i < 60; i++) if (I.pushLateMemory('bytes-' + Math.floor(i / 8), 'x'.repeat(200000) + i, entries(), 'board')) accepted++
    assert.ok(accepted > 0 && accepted < 45, String(accepted))
  })
  await test('global key capacity is bounded and expired queues can be reclaimed', () => {
    let accepted = 0
    for (let i = 0; i < 160; i++) if (I.pushLateMemory('capacity-' + i, 'raw', entries(), 'board')) accepted++
    assert.ok(accepted > 0 && accepted <= 128)
    const now = Date.now; Date.now = () => now() + 11 * 60 * 1000
    try { assert.equal(I.pushLateMemory('fresh-after-ttl', 'raw', entries(), 'board'), true) }
    finally { Date.now = now }
  })
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); process.exitCode = fail ? 1 : 0
