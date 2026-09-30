#!/usr/bin/env node
// 本地协议演示：失败→最大 EIG 诊断→联合恢复→批准的另一分支→通过。不是模型效果实验。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { effectFixtureSuite, effectFixtureEvaluator, memoryCandidate, memorySignature } from '../test/helpers/evidence-fixtures.mjs'
const eq = (field, value) => ({ op: 'equals', field, value })
export const DEMO_OLD = 'const hedgeAfterMs = 1600;\n'
export const DEMO_RAISE = 'const hedgeAfterMs = 3000;\n'
export const DEMO_CLOCK = 'const hedgeAfterMs = 1600; // fake clock\n'
export function demoContract() {
  return I.freezeEvidenceContract({ task: 'timer-protocol-demo', version: '1', checks: [
    { id: 'original', kind: 'file', role: 'precondition', path: 'fixture.js', predicate: eq('text', DEMO_OLD) },
    { id: 'raised', kind: 'file', role: 'acceptance', path: 'fixture.js', label: 'local verify', predicate: eq('text', DEMO_RAISE) },
    { id: 'clock-file', kind: 'file', role: 'acceptance', path: 'fixture.js', label: 'local verify', predicate: eq('text', DEMO_CLOCK) },
    { id: 'symptom', kind: 'observation', role: 'acceptance', predicate: eq('fixed', true), conditions: { cpus: 2 } },
    { id: 'event-order', kind: 'observation', role: 'diagnostic', predicate: { op: 'before', field: 'primaryAt', other: 'hedgeAt' }, conditions: { cpus: 2 } },
  ], actions: [
    { id: 'raise-threshold', type: 'replace', path: 'fixture.js', oldText: DEMO_OLD, newText: DEMO_RAISE, preconditions: ['original'], checks: ['raised', 'symptom'] },
    { id: 'fake-clock', type: 'replace', path: 'fixture.js', oldText: DEMO_OLD, newText: DEMO_CLOCK, preconditions: ['original'], checks: ['clock-file', 'symptom'] },
    { id: 'verify-only', type: 'observe', preconditions: [], checks: ['symptom'] },
  ] })
}
/** 测试与 CLI 共用真实文件/JSON 状态适配器，不模拟回滚成功。root 必须是调用者提供的专用临时目录。 */
export function createDemoEnvironment({ root, directory = path.join(root, 'store'), observe: observer, runtimeOptions = {}, withArchive = true } = {}) {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'fixture.js'), DEMO_OLD)
  let state = { context: ['用户原始任务'], primaryAt: 5000, cpus: 2 }
  const contract = demoContract(), store = I.createEvidenceStore({ directory, sessionId: 'demo-session' })
  const adapter = I.createFileStateAdapter({ root, paths: ['fixture.js'], readState: () => state, writeState: (s) => { state = s },
    afterAction: (action) => { state.context.push('候选执行：' + action.id) }, readConditions: () => ({ cpus: state.cpus }) })
  const observe = observer || ((check, binding) => {
    const text = fs.readFileSync(path.join(root, 'fixture.js'), 'utf8'), hedgeAt = Number(text.match(/= (\d+)/)?.[1] || 0)
    return { value: { fixed: text === DEMO_CLOCK, primaryAt: state.primaryAt, hedgeAt }, revision: binding.revision, roundId: binding.roundId, conditions: { cpus: state.cpus } }
  })
  const diagnosticModel = I.freezeDiagnosticModel({ prior: { primaryDelayed: 0.5, assertionRace: 0.5 }, probes: [
    { checkId: 'event-order', cost: 1, likelihood: { primaryDelayed: { pass: 0, fail: 1 }, assertionRace: { pass: 1, fail: 0 } } },
  ] }, contract)
  let archive = null, archiveRef = null
  if (withArchive) {
    archive = I.createEvidenceArchive({ store }); archive.beginCycle({ suite: effectFixtureSuite(), evaluate: effectFixtureEvaluator })
    archive.consider(memoryCandidate()); archive.finalize(); archiveRef = archive.persist()
  }
  const options = { contract, sessionId: store.sessionId, store, adapter, observe, diagnosticModel, archive,
    memoryContext: { signature: memorySignature, observation: { failed: true } }, allowEdits: true, ...runtimeOptions }
  return { contract, store, adapter, options, archive, archiveRef,
    getState: () => I.immutableJson(state), setState: (s) => { state = JSON.parse(JSON.stringify(s)) } }
}
export async function runEvidenceDemo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-evidence-demo-'))
  try {
    const env = createDemoEnvironment({ root: path.join(home, 'workspace'), directory: path.join(home, 'evidence') }), runtime = I.createEvidenceRuntime(env.options)
    const first = await runtime.runRound(runtime.program('失败提议：调大阈值，不等于已修复。', ['raise-threshold']), { roundId: 'round-1' })
    const recoveredText = fs.readFileSync(path.join(env.adapter.root, 'fixture.js'), 'utf8'), recoveredContext = env.getState().context
    const second = await runtime.runRound(runtime.program('宿主批准的另一分支：使用确定性时钟协议夹具。', ['fake-clock']), { roundId: 'round-2' })
    return I.immutableJson({ schema: 'cfb.evidence-demo/1', modelCalls: 0, networkCalls: 0, cost: 0,
      first: { status: first.status, reason: first.reason, diagnosis: first.diagnostic?.state?.prior || null,
        restoredFile: recoveredText === DEMO_OLD, restoredContext: recoveredContext, memoryCount: first.modelView?.memories.length || 0 },
      second: { status: second.status, allStepsVerified: second.ok, fileVerified: fs.readFileSync(path.join(env.adapter.root, 'fixture.js'), 'utf8') === DEMO_CLOCK },
      counters: runtime.view(), persistedMemoryItems: env.archive.snapshot().active.length,
      note: '只有协议与本地文件/状态控制链得到验证；没有测试主模型或真实 flaky 修复效果。' })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
async function main(argv) {
  let out
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--out') out = argv[++i]; else throw new Error('未知参数 ' + argv[i] + '；本工具只有本地演示，没有在线模式') }
  const report = await runEvidenceDemo()
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1 })
