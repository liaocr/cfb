import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { compilerEvidence, unionEvidenceRanges } from '../src/evidence-input.js'
import { prepareEvidenceLedger, prepareCompilerEvidence, ledgerDirectory } from '../src/evidence-ledger.js'
import { replayCompiler, captureTrace } from '../tools/replay.mjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-sharing-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = home
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch(e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const tool = (n, result, more = {}) => ({ id: 't' + n, name: 'read', seq: 2 * n, resultSeq: 2 * n + 1, args: 'file-' + n, status: 'completed', exitCode: 0, result, ...more })
const terminal = t => t.result != null && ['completed', 'failed', 'cancelled'].includes(t.status)
// Reference selection policy copied as a specification, not the implementation.
function v7Ranges(tools, index) {
  const t = tools[index], raw = String(t.result ?? '')
  if (!terminal(t)) return []
  const last = tools.map((x, i) => terminal(x) ? i : -1).filter(i => i >= 0).at(-1)
  const bad = t.isError || typeof t.exitCode === 'number' && t.exitCode !== 0 || ['failed', 'cancelled'].includes(t.status)
  const limit = bad ? 8192 : index === last ? 4096 : 1200
  return [[0, Math.min(limit, raw.length)], ...(raw.length > limit && (bad || index === last) ? [[Math.max(limit, raw.length - 1200), raw.length]] : [])]
}
function checkCoverage(tools) {
  const e = compilerEvidence(tools)
  assert.equal(e.receipts.length, tools.length)
  for (const [i, t] of tools.entries()) {
    const old = v7Ranges(tools, i), receipt = e.receipts[i]
    assert.deepEqual(receipt.requestedRanges, old)
    assert.equal(receipt.sourceTruncated, !!(t.sourceTruncated ?? t.resultTruncated))
    if (!terminal(t)) { assert.equal(receipt.providedComplete, false); assert.deepEqual(receipt.ranges, []); continue }
    const b = e.bodies.find(b => b.label === receipt.bodyLabel)
    assert.ok(b)
    for (const [a, z] of old) assert.ok(b.segments.some(s => s.start <= a && s.end >= z && s.text.slice(a - s.start, z - s.start) === t.result.slice(a, z)))
    for (const s of b.segments) assert.equal(s.text, t.result.slice(s.start, s.end))
    if (receipt.sourceTruncated) assert.equal(receipt.providedComplete, false)
    assert.ok(e.text.includes(`id="${t.id}"`))
  }
  return e
}
try {
  await test('same body with ordinary/error/latest views sends the union once, preserving all old ranges', () => {
    const raw = '0123456789'.repeat(2000)
    const tools = [tool(1, raw), tool(2, raw, { exitCode: 1, isError: true }), tool(3, raw)]
    const e = checkCoverage(tools)
    assert.equal(e.bodies.length, 1); assert.equal(e.bodyChars, 9392); assert.equal(e.duplicateBodyCharsAvoided, 6496)
    assert.deepEqual(e.bodies[0].ranges, [[0, 8192], [18800, 20000]])
    assert.ok(e.text.includes('exitCode=0') && e.text.includes('exitCode=1'))
    if (process.env.CFB_V8_EVIDENCE_DIR) { fs.mkdirSync(process.env.CFB_V8_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CFB_V8_EVIDENCE_DIR, 'range-preservation.json'), JSON.stringify({ kind: 'synthetic-range-preservation-not-product-performance', events: 3, bodyGroups: 1, v7SelectedBodyChars: 15888, v8SelectedBodyChars: 9392, allPriorRangesPreserved: true, tokenSavings: null, qualityImprovement: null }, null, 2) + '\n') }
  })
  await test('same prefix, different unseen suffixes are NOT the same body', () => {
    const a = 'x'.repeat(1600), e = checkCoverage([tool(1, a + 'one'), tool(2, a + 'two'), tool(3, 'third')])
    assert.equal(e.bodies.length, 3)
  })
  await test('source completeness and outcomes remain per event regardless of order', () => {
    for (const tools of [[tool(1, 'same', { sourceTruncated: true }), tool(2, 'same')], [tool(2, 'same'), tool(1, 'same', { sourceTruncated: true })]]) {
      const e = checkCoverage(tools); assert.equal(e.bodies.length, 1)
      assert.equal(e.receipts[tools.findIndex(t => t.id === 't1')].providedComplete, false)
      assert.equal(e.receipts[tools.findIndex(t => t.id === 't2')].providedComplete, true)
    }
  })
  await test('adjacent ranges do not invent an omitted middle; event sequence remains in input order', () => {
    const e = checkCoverage([tool(1, 'first'), tool(2, 'z'.repeat(4500))])
    assert.equal(e.text.includes('中间未提供'), false)
    assert.ok(e.text.indexOf('id="t1"') < e.text.indexOf('正文 B2'))
    assert.ok(e.text.indexOf('id="t1"') < e.text.indexOf('id="t2"'))
    assert.deepEqual(unionEvidenceRanges([[20, 25], [0, 10], [10, 20]]), [[0, 25]])
  })
  await test('empty returns, missing seq and pending never collapse into one lifecycle', () => {
    const e = checkCoverage([tool(1, ''), tool(2, '', { resultSeq: null }), tool(3, null, { status: 'requested', resultSeq: null })])
    assert.equal(e.bodies.length, 1); assert.equal(e.receipts[0].providedComplete, true)
    assert.equal(e.receipts[1].providedComplete, true); assert.equal(e.receipts[2].providedComplete, false)
    assert.equal(compilerEvidence([]).text, '')
  })
  await test('100 deterministic mixed workloads preserve every v7-selected character interval', () => {
    let seed = 8147
    const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
    for (let k = 0; k < 100; k++) {
      const bodies = Array.from({ length: 5 }, (_, j) => `BODY-${j}-` + '正文😀\n'.repeat(rand(4200)))
      checkCoverage(Array.from({ length: 15 }, (_, i) => tool(i, bodies[rand(5)], { status: ['completed', 'failed', 'cancelled'][rand(3)], exitCode: rand(3), sourceTruncated: rand(5) === 0 })))
    }
  })
  await test('request and ledger verification caches are batch-local, not stale cross-request shortcuts', () => {
    const input = { sessionId: 'verify', tools: [tool(1, 'shared'), tool(2, 'shared'), tool(3, 'shared')] }
    prepareEvidenceLedger(input)
    const p = prepareEvidenceLedger(input)
    assert.equal(p.frame.ioStats.bodyHashComputations, 1)
    assert.equal(p.frame.ioStats.verificationCacheHits, 2)
    const view = JSON.parse(fs.readFileSync(p.frame.indexPath))
    fs.writeFileSync(view.records[0].bodyPath, 'changed-outside-ledger')
    const failed = prepareCompilerEvidence(input)
    assert.equal(failed.durable, false); assert.equal(failed.storageReason, 'evidence-object-corrupt')
    assert.ok(failed.evidenceInput.text.includes('shared'))
  })
  await test('production preparation retains identical grounding when persistence is disabled', () => {
    const input = { sessionId: 'disabled', tools: [tool(1, 'error detail', { isError: true })] }
    const frame = prepareCompilerEvidence(input, false)
    assert.equal(frame.indexPath, null); assert.equal(frame.storageReason, 'stateSnapshot-disabled')
    assert.equal(fs.existsSync(ledgerDirectory(input.sessionId)), false)
    assert.equal(frame.evidenceInput.text, compilerEvidence(input.tools).text)
  })
  await test('capture cannot quietly discard transient-input compiles and still claim completeness', async () => {
    const trace = '[time] [compiler-input-prepared] {"taskId":"not-recorded"}\n[time] [evidence-ledger-unavailable] {"taskId":"not-recorded"}'
    const result = await captureTrace(trace, null)
    assert.equal(result.complete, false); assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].reason, /transient input/)
  })
  await test('HTTP compiler replay uses the same no-persistence preparation as production', async () => {
    let prompt
    const server = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
      prompt = JSON.parse(body).messages[0].content
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '【关键判断与依据】\n仍需核验。\n【未决差距】\n结果未确认。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    }) })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    try {
      const keyFile = path.join(home, 'keys'); fs.writeFileSync(keyFile, 'LOCAL: unused')
      const raw = 'fixture-only original reasoning'.repeat(50)
      // Fixture archive exists; this synthetic capture is not a production recording.
      const archived = path.join(home, 'fixture-reasoning.txt'); fs.writeFileSync(archived, raw)
      const capture = { kind: 'compiler-capture', complete: true, sourceSha256: 'f'.repeat(64), cases: [{ id: 'fixture', sessionId: 'replay-disabled', branchId: 'main', raw, rawHandle: 'fixture-file://' + archived,
        observations: { tools: [tool(1, 'READ_THIS_ERROR', { isError: true, status: 'failed' })], userAsks: [], runtimeFacts: [], cut: 3 } }] }
      const report = await replayCompiler(capture, { model: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port, credentialsPath: keyFile, credentialRef: 'LOCAL', followHostProvider: false, stateSnapshot: false, keepAlive: false }, path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), path.join(home, 'replay'))
      assert.equal(report.compiles[0].status, 'ok'); assert.equal(report.productAccepted, false)
      assert.ok(prompt.includes('READ_THIS_ERROR')); assert.ok(prompt.includes('持久化不可用'))
      assert.ok(report.compiles[0].traces.some(r => r.tag === 'evidence-ledger-unavailable' && r.storageReason === 'stateSnapshot-disabled'))
      assert.equal(fs.existsSync(path.join(home, 'replay', 'storages', 'cot-form-b', 'evidence-v1')), false)
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  })
} finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`); if (fail) process.exitCode = 1
