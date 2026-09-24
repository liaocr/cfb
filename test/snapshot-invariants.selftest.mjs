// 快照 / 覆盖 / 证据截面的不变式（legacy memory 路径）。
// v11.8：编译排队（stateCompileQueue / compile-lane.js）与增量 rebase 已随退役开关移除，
//   对应用例一并删除；这里保留与排队无关、仍在生产路径上的不变式。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-incremental-'))
const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home
const I = await import('../index.js'), M = await import('../src/state-memory.js'), S = await import('../src/snapshot-store.js')
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const entry = text => ({ id: text, category: 'state', content: text, origin: 'model', evidence: 'inferred', validity: 'active' })
const result = { text: '状态已记录，结果保留。', entries: [entry('记录')], checkpointText: '【当前有效状态】\n状态已记录' }
function evidence(n = 30, len = 800) {
  const events = []
  for (let i = 0; i < n; i++) {
    // Distinct bodies, no artificial repeated-line cleaning win.
    const text = Array.from({ length: len }, (_, j) => String.fromCharCode(0x4e00 + ((j * 31 + i * 77) % 900))).join('')
    events.push({ seq: i * 2 + 1, type: 'assistant/message', toolCalls: [{ id: 'tc' + i, name: 'read', args: 'file' + i }] })
    events.push({ seq: i * 2 + 2, type: 'tool/result', toolCallId: 'tc' + i, text, isError: false })
  }
  return { events, inFlightIds: new Set(), cutSeq: n * 2 }
}
function start(id, index, { distill = async () => result, archive = async () => 'handle', data = evidence(), cfg = {}, traces = [] } = {}) {
  return I.birthStart({ index, text: ('原始推理' + index).repeat(220) }, {
    sessionId: id, branchId: 'main',
    cfg: { stateMemory: true, timeoutMs: 1000, birthMinChars: 20, ...cfg },
    archive, buildEnvelope: M.buildEvidenceEnvelope, collectEvidence: () => data, distill,
    trace: (tag, data) => traces.push({ tag, data }),
  })
}
const tools = Array.from({ length: 20 }, (_, i) => ({ id: 't' + i, status: 'completed', result: String(i).padStart(3, '0') + '证据'.repeat(100), resultSeq: i + 1 }))
const env = () => M.buildEvidenceEnvelope({ cot: '保持时间截面', at: 42, tools, userAsks: [{ text: '不可修改配置' }], runtimeFacts: [{ text: '运行态' }] })
const snap = () => ({ ...S.emptySnapshot('s', 'main'), revision: 1, sourceCutSeq: 20, entries: [entry('结果保留')], coverage: { coveredSeqs: tools.map(t => t.resultSeq) } })
let server
try {
  await test('long branch identities do not collapse at character 120', () => {
    const a = S.normalizeBranchId({ branchId: 'x'.repeat(120) + 'A' })
    const b = S.normalizeBranchId({ branchId: 'x'.repeat(120) + 'B' })
    assert.notEqual(a, b); assert.notEqual(S.snapshotPath('s', a), S.snapshotPath('s', b))
  })
  await test('tool result sequence survives envelope construction', () => assert.equal(env().tools[0].resultSeq, 1))
  await test('frozen envelope cannot be modified after the evidence cut', () => {
    const e = env(); assert.throws(() => { e.tools[0].result = 'future' }, TypeError)
    assert.throws(() => e.userAsks.push({ text: 'future' }), TypeError)
    assert.throws(() => { e.host.step = 9 }, TypeError)
  })
  await test('truncated, pending and invalid-seq results never acquire coverage', () => {
    const e = M.buildEvidenceEnvelope({ tools: [
      { status: 'completed', result: 'x'.repeat(1201), resultSeq: 1 },
      { status: 'requested', resultSeq: 2 },
      { status: 'failed', result: 'ERROR', resultSeq: 3 },
      { status: 'completed', result: 'OK', resultSeq: -1 },
      { status: 'running', result: 'partial', resultSeq: 4 },
    ] })
    assert.deepEqual(I.fullyVisibleResultSeqs(e.tools), [3])
  })
  await test('production commit does not cover the unseen tail of long results', async () => {
    const t = start('truncated', 0, { data: evidence(12, 1800) }); assert.equal((await t.distillP).ok, true)
    assert.deepEqual(S.loadSnapshot('truncated', 'main').coverage.coveredSeqs, [])
  })
  await test('policy-2 migration revokes formerly truncated whole-result coverage', () => {
    const s = snap(); s.memoryPolicyVersion = 2
    const migrated = S.validateSnapshot(s).snapshot
    assert.equal(migrated.memoryPolicyVersion, 3); assert.deepEqual(migrated.coverage.coveredSeqs, [])
    assert.equal(migrated.entries[0].content, s.entries[0].content)
  })
  await test('different production sessions do not block or coalesce each other', async () => {
    const gate = deferred(), inputs = []
    const distill = async e => { inputs.push(e); await gate.promise; return result }
    const a = start('parallel-A', 0, { distill }), b = start('parallel-B', 1, { distill })
    await tick(); assert.equal(inputs.length, 2); gate.resolve(); await Promise.all([a.distillP, b.distillP])
  })
  await test('production baseline snapshot from the future is not injected', async () => {
    const s = snap(); s.sessionId = 'future'; s.sourceCutSeq = 1000
    fs.writeFileSync(S.snapshotPath('future', 'main'), JSON.stringify(s))
    let seen
    await start('future', 0, { distill: async e => { seen = e; return result } }).distillP
    assert.equal(seen.stateSnapshot, null); assert.equal(seen.tools.length, 30)
  })
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`); process.exitCode = fail ? 1 : 0
