// 新故障复现：生产原生宿主 + 真实 Node/HTTP/计时器，不是 Cordis 替身。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as I from '../../index.js'
const exec = promisify(execFile)
export const REPAIR_FAMILIES = I.immutableJson({ train: ['plain-json', 'chunked-json'], selection: ['header-identity', 'split-utf8'], test: ['delayed-headers', 'chunked-header'] })
const transports = Object.values(REPAIR_FAMILIES).flat()
const faults = ['timing', 'assertion', 'identity']
export const REPAIR_SIGNATURE = I.immutableJson({ taskFamily: 'causal-repair-local-v1', environment: 'native-host-loopback-worker-v1', contractVersion: '1' })
export const BASE_CONFIG = JSON.stringify({ waitMs: 40, assertMode: 'legacy', route: 'legacy' }) + '\n'
export const REPAIR_CONFIGS = I.immutableJson({
  'relax-delay': JSON.stringify({ waitMs: 150, assertMode: 'legacy', route: 'legacy' }) + '\n',
  'await-response': JSON.stringify({ waitMs: 40, assertMode: 'await', route: 'legacy' }) + '\n',
  'pin-model': JSON.stringify({ waitMs: 40, assertMode: 'legacy', route: 'approved' }) + '\n',
})
const eq = (field, value) => ({ op: 'equals', field, value })
export function repairSuite({ developmentOnly = false } = {}) {
  const parts = Object.fromEntries(Object.entries(REPAIR_FAMILIES).map(([split, families]) => [split, families.flatMap((family) => faults.map((fault, i) => ({
    id: family + ':' + i, family, input: { caseId: family + ':' + i }, predicate: eq('solved', true) }))) ]))
  if (developmentOnly) delete parts.test
  return developmentOnly ? I.immutableJson(parts) : I.freezeEffectSuite({ id: 'native-repair-new18-v1', evaluatorVersion: 'actual-http-timers-native-host-protected-oracle-v1', ...parts })
}
export async function makeRepairHost(input, { diagnosticStrategy = 'active', diagnosticOrder = null, unknownDiagnostics = false } = {}) {
  const [family, suffix] = String(input?.caseId || '').split(':'), index = Number(suffix), fault = faults[index]
  if (!transports.includes(family) || !/^[012]$/.test(suffix)) throw new Error('repair-fixture-input')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-native-repair-')), root = path.join(home, 'workspace')
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'config.json'), BASE_CONFIG)
  const initialState = { context: ['user repair task'], pending: 1 }
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(initialState))
  for (const name of ['repair-workload.cjs', 'repair-oracle.cjs']) fs.copyFileSync(new URL('../../test/fixtures/' + name, import.meta.url), path.join(root, name))
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ transport: family, primaryDelayMs: fault === 'timing' ? 85 : 8, earlyAssertion: fault === 'assertion', identityFault: fault === 'identity', wrongField: transports.indexOf(family) % 2 ? 'fingerprint' : 'model' }))
  const traces = [], conditions = { runtime: 'node-local-worker-v1' }
  const adapter = I.createFileStateAdapter({ root, paths: ['config.json'],
    readState: () => JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
    writeState: (s) => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(s)), readConditions: () => conditions,
    afterAction: (a) => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ context: ['user repair task', a.id], pending: 0 })) })
  const checks = [
    { id: 'original', kind: 'file', role: 'precondition', path: 'config.json', predicate: eq('text', BASE_CONFIG) },
    { id: 'goal', kind: 'observation', role: 'acceptance', label: 'workload check', conditions, predicate: eq('goal', true), timeoutMs: 2500 },
    ...[['a-model', 'model'], ['b-order', 'order'], ['c-assertion', 'assertion']].map(([id, field]) => ({ id, kind: 'observation', role: 'diagnostic', conditions, predicate: eq(field, true), timeoutMs: 2500 })),
  ]
  const contract = I.protectEvidenceContract({ task: 'native-local-repair', version: '1', checks, actions: Object.entries(REPAIR_CONFIGS).map(([id, newText]) => ({
    id, type: 'replace', path: 'config.json', oldText: BASE_CONFIG, newText, preconditions: ['original'], checks: ['goal'] })) }, { root, paths: ['fixture.json', 'repair-workload.cjs', 'repair-oracle.cjs'] })
  const likelihood = (bad) => Object.fromEntries(faults.map((h) => [h, { pass: h === bad ? 0 : 1, fail: h === bad ? 1 : 0 }]))
  const diagnosticModel = I.freezeDiagnosticModel({ prior: { timing: 1, assertion: 1, identity: 1 }, probes: [
    { checkId: 'a-model', cost: 1, likelihood: likelihood('identity') }, { checkId: 'b-order', cost: 1, likelihood: likelihood('timing') }, { checkId: 'c-assertion', cost: 1, likelihood: likelihood('assertion') },
  ] }, contract)
  const observe = async (check, binding, signal) => {
    if (unknownDiagnostics && check.role === 'diagnostic') return { error: 'missing-diagnostic-source' }
    const start = performance.now()
    const result = await exec(process.execPath, ['repair-workload.cjs'], { cwd: root, signal, timeout: 2000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' } })
    const raw = JSON.parse(result.stdout), order = !raw.events.some((e) => e.kind === 'hedge-start'), assertion = raw.events.some((e) => e.kind === 'assert' && e.wasComplete === true), model = raw.identity.model === 'local-model' && raw.identity.fingerprint === 'local-fp'
    const value = { goal: order && assertion && model, order, assertion, model }
    const oracle = spawnSync(process.execPath, ['repair-oracle.cjs'], { input: JSON.stringify(raw), cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', HOME: root } })
    const secondary = oracle.status === 0 ? JSON.parse(oracle.stdout).okay : null
    traces.push({ checkId: check.id, binding, raw, primary: value.goal, secondary, elapsedMs: performance.now() - start })
    if (secondary === null || secondary !== value.goal) return { error: 'oracle-unavailable-or-disagreement' }
    return { value, revision: binding.revision, roundId: binding.roundId, conditions }
  }
  const store = I.createEvidenceStore({ directory: path.join(home, 'store'), sessionId: 'native-repair' })
  const host = I.createEvidenceHost({ contract, sessionId: store.sessionId, store, adapter, observe, diagnosticModel, diagnosticChecks: 2, diagnosticCost: 2,
    diagnosticStrategy, diagnosticOrder, maxChecks: 24, allowEdits: true, contextOptions: { maxTokensEst: 32768 } })
  const publish = (actionId, index) => {
    const a = contract.actions.find((a) => a.id === actionId)
    if (!a) throw new Error('unapproved-repair-branch')
    return host.captureDraft({ index, sessionId: store.sessionId, raw: '录制的完整本地候选；未调用生成模型。', text: '宿主批准的修复；验收命令是 `workload check`。预期：工作负载目标通过。',
      calls: [{ name: 'edit_file', args: { path: a.path, old_text: a.oldText, new_text: a.newText } }] })
  }
  const recovered = () => fs.readFileSync(path.join(root, 'config.json'), 'utf8') === BASE_CONFIG && I.canonicalJson(JSON.parse(fs.readFileSync(path.join(root, 'state.json')))) === I.canonicalJson(initialState)
  return { host, store, adapter, contract, publish, recovered, traces, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}
/** 第一轮强基线。只用于开发切分，不读取 test。 */
export async function runStaticRepair(input) {
  const e = await makeRepairHost(input, { diagnosticStrategy: 'fixed', diagnosticOrder: ['b-order', 'c-assertion'] })
  try {
    const outcomes = [], publications = [], recovery = []
    for (const actionId of ['relax-delay', 'await-response']) {
      publications.push(e.publish(actionId, outcomes.length)); const result = await e.host.runLatest(outcomes.length); outcomes.push(result)
      if (result.ok) break
      recovery.push({ complete: result.status === 'rolled-back' && e.recovered(), status: result.status })
      if (result.status !== 'rolled-back') break
    }
    return summarizeRepair(e, outcomes, publications, recovery)
  } finally { e.cleanup() }
}
export function summarizeRepair(e, outcomes, publications, recovery) {
  const receipts = outcomes.flatMap((r) => [...(r.receipts || []), ...(r.diagnostic?.receipts || [])]), final = outcomes.at(-1), checks = receipts.filter((r) => r.binding.phase !== 'action')
  return I.immutableJson({ solved: final?.ok === true, finalStatus: final?.status || 'blocked',
    publication: { n: publications.filter((p) => p.authorized).length, total: publications.length },
    decidableChecks: { n: checks.filter((r) => ['pass', 'fail'].includes(r.status)).length, total: checks.length, unknown: checks.filter((r) => r.status === 'unknown').length },
    actions: { n: receipts.filter((r) => r.binding.phase === 'action' && r.status === 'pass').length, total: outcomes.length },
    recovery: { n: recovery.filter((r) => r.complete).length, total: recovery.length },
    secondBranch: { entered: outcomes.length > 1, solved: outcomes.length > 1 && final?.ok === true }, diagnostics: receipts.filter((r) => r.binding.phase === 'diagnostic').length,
    counters: e.host.runtime.view(), oracleAgreement: { n: e.traces.filter((t) => t.primary === t.secondary).length, total: e.traces.length },
    workerProcesses: e.traces.length, oracleProcesses: e.traces.length, loopbackRequests: e.traces.reduce((n, t) => n + t.raw.requests, 0), traces: e.traces,
    modelCalls: 0, externalApiCalls: 0, outputs: outcomes })
}
