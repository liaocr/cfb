import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import cp from 'node:child_process'
import { promisify } from 'node:util'
import { repairSuite, makeRepairHost, BASE_CONFIG, REPAIR_CONFIGS, REPAIR_TIMING } from '../tools/helpers/repair-host.mjs'
const exec = promisify(cp.execFile)
import { runRepairDevelopment } from '../tools/repair-development.mjs'
let pass = 0, fail = 0, report
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-native-host-test-'))
const store = I.createEvidenceStore({ directory: path.join(home, 'library'), sessionId: 'development' })
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
try {
  await test('新复现集 18/6/6:6:6，开发只包含 12 个，不复用旧 32 族', () => {
    const suite = repairSuite(); for (const split of ['train', 'selection', 'test']) assert.equal(suite[split].length, 6)
    assert.equal(new Set([...suite.train, ...suite.selection, ...suite.test].map((f) => f.family)).size, 6)
    assert.equal(repairSuite({ developmentOnly: true }).test, undefined)
    assert.ok(suite.test.every((f) => ![...suite.train, ...suite.selection].some((a) => a.family === f.family)))
  })
  await test('对冲余量足够宽：timing 仍能复现，修复态与非 timing 态不会误触发 hedge', () => {
    const waitOf = (text) => JSON.parse(text).waitMs
    const base = waitOf(BASE_CONFIG), relaxed = waitOf(REPAIR_CONFIGS['relax-delay'])
    const { plainPrimaryMs, timingPrimaryMs, minMarginMs } = REPAIR_TIMING
    assert.ok(base < timingPrimaryMs, 'timing 故障将无法复现：BASE.waitMs=' + base + ' 不小于 timingPrimaryMs=' + timingPrimaryMs)
    assert.ok(relaxed - timingPrimaryMs >= minMarginMs, 'relax-delay 余量不足：' + (relaxed - timingPrimaryMs) + 'ms < ' + minMarginMs + 'ms')
    assert.ok(base - plainPrimaryMs >= minMarginMs, '非 timing 余量不足：' + (base - plainPrimaryMs) + 'ms < ' + minMarginMs + 'ms')
    for (const id of ['await-response', 'pin-model']) assert.equal(waitOf(REPAIR_CONFIGS[id]), base, id + ' 不应改动 waitMs（否则余量分析失效）')
  })
  await test('并发下快速主响应不得被误判为对冲：连跑 24 次没有 hedge-start', async () => {
    const e = await makeRepairHost({ caseId: 'plain-json:1' })
    try {
      const hedged = async () => {
        const r = await exec(process.execPath, ['repair-workload.cjs'], { cwd: e.adapter.root, timeout: 30000, maxBuffer: 65536 })
        return JSON.parse(r.stdout).events.some((ev) => ev.kind === 'hedge-start')
      }
      const seen = []
      let i = 0
      await Promise.all(Array.from({ length: 8 }, async () => { while (i < 24) { i++; seen.push(await hedged()) } }))
      assert.equal(seen.filter(Boolean).length, 0, '并发下出现 hedge-start ⇒ 对冲余量不足，观测会被误判')
    } finally { e.cleanup() }
  })
  await test('真实强基线开发执行：8/12，发布/落地/可判/恢复完整，损失在第二分支', async () => {
    report = await runRepairDevelopment(store)
    assert.equal(report.summary.tasks, 12); assert.equal(report.summary.solved, 8); assert.equal(report.heldoutTasksExecuted, 0)
    for (const field of ['publication', 'actions', 'recovery', 'decidableChecks', 'oracleAgreement']) assert.equal(report.summary[field].n, report.summary[field].total, field)
    assert.equal(report.summary.decidableChecks.unknown, 0); assert.equal(report.summary.secondBranch.entered, 8); assert.equal(report.summary.secondBranch.solved, 4)
    assert.ok(report.summary.workerProcesses > 12); assert.ok(report.summary.loopbackRequests > 12)
    assert.equal(report.modelCalls, 0); assert.equal(report.fullDshHost, 'blocked-not-installed')
  })
  await test('强基线每个失败都通过同一验收并恢复，不是假装无行动的弱对照', () => {
    assert.ok(report.records.every((r) => r.output.actions.n > 0 && r.output.actions.n === r.output.actions.total))
    assert.ok(report.records.every((r) => r.output.counters.maxRounds === 3 && r.output.counters.maxRepairRounds === 2))
    assert.ok(report.records.filter((r) => !r.output.solved).every((r) => r.output.counters.repairs === 2 && r.output.recovery.n === 2))
  })
  await test('认证开发记录重启后回放，不重新跑工作负载、不消费 test', async () => {
    const next = I.createEvidenceStore({ directory: path.join(home, 'library'), sessionId: 'development' }), cached = await runRepairDevelopment(next)
    assert.equal(cached.cached, true); assert.deepEqual(cached.records, report.records); assert.equal(next.readHead('effect-holdouts'), null)
  })
  await test('生产 birth 模块录制流接入原生 host：text/chunks 不变，仅发布，显式 runLatest 才动作', async () => {
    const e = await makeRepairHost({ caseId: 'plain-json:0' })
    try {
      const draft = `所以下一步工具调用是 edit_file config.json，old_text 是 \`${BASE_CONFIG}\`，new_text 是 \`${REPAIR_CONFIGS['relax-delay']}\`。验收是 \`workload check\`，预期目标通过。`
      const ungrounded = '录制完整推理；不是请求模型。'.repeat(300)
      const raw = draft + '\n' + ungrounded
      const task = { index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }
      const deps = { sessionId: 'native-repair', archive: () => 'art://recorded', distill: () => ({ text: draft }), evidenceHost: e.host,
        cfg: { birthMinChars: 1, birthMinSavedChars: 1, birthFinishWaitMs: 100, finishHeadersGraceMs: 0 } }
      const rejected = await I.birthSettle({ ...task, text: ungrounded, end: { ...task.end, block: { type: 'reasoning', text: ungrounded } } }, { ...deps, cfg: { ...deps.cfg, evidenceProgram: true } })
      assert.equal(rejected.evidence.authorized, false)
      const old = await I.birthSettle(task, deps), current = await I.birthSettle(task, { ...deps, cfg: { ...deps.cfg, evidenceProgram: true } })
      assert.equal(current.evidence.authorized, true); assert.equal(current.text, old.text); assert.deepEqual(current.chunks, old.chunks); assert.equal(e.recovered(), true)
      const result = await e.host.runLatest(0); assert.equal(result.ok, true); assert.equal(I.recoverEvidenceBlock(e.store, result.artifactRef, 'raw'), raw)
      assert.equal((await e.host.runLatest(0)).reason, 'episode-already-verified')
    } finally { e.cleanup() }
  })
  await test('真实检查器源码被固定，漂移不执行/不授绿灯，未验收 RAW 不解锁', async () => {
    const e = await makeRepairHost({ caseId: 'plain-json:0' })
    try {
      fs.appendFileSync(path.join(e.adapter.root, 'repair-oracle.cjs'), '\n// source changed')
      e.publish('relax-delay', 0); const r = await e.host.runLatest(0)
      assert.equal(r.ok, false); assert.equal(r.reason, 'verifier-source-drift'); assert.equal(e.recovered(), true)
      assert.equal(e.host.runtime.readBlock(r.artifactRef, 'raw').ok, false)
    } finally { e.cleanup() }
  })
  await test('固定诊断只能选已批准 diagnostic ID，不能改 acceptance 或重复消费', async () => {
    const e = await makeRepairHost({ caseId: 'plain-json:1' }, { diagnosticStrategy: 'fixed', diagnosticOrder: ['b-order', 'c-assertion'] })
    try {
      e.publish('relax-delay', 0); const r = await e.host.runLatest(0)
      assert.deepEqual(r.diagnostic.receipts.map((p) => p.subjectId), ['b-order', 'c-assertion'])
      assert.equal(r.diagnostic.state.prior.assertion, 1); assert.equal(r.ok, false); assert.equal(e.recovered(), true)
      assert.throws(() => I.createEvidenceRuntime({ contract: e.contract, sessionId: e.store.sessionId, store: e.store, adapter: e.adapter, diagnosticStrategy: 'fixed', diagnosticOrder: ['goal'] }), /schema/)
    } finally { e.cleanup() }
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
