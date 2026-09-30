#!/usr/bin/env node
// 第二轮：冻结 2x2 策略，复用第一轮认证基线，有限搜索先预占后 test。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { repairSuite } from './helpers/repair-host.mjs'
import { REPAIR_POLICIES, REPAIR_BRANCH_PLAN, repairCandidate, runApprovedRepair } from './helpers/repair-policy.mjs'
import { repairLibrary, repairSourceDigest, runRepairDevelopment, aggregateRepair } from './repair-development.mjs'
import { assertOfflineNamespace } from './verify-offline.mjs'
export function repairEvaluationScope() {
  return I.evidenceDigest({ baselineSource: repairSourceDigest(), policies: REPAIR_POLICIES, plan: REPAIR_BRANCH_PLAN,
    sources: ['src/evidence-episode.js', 'tools/helpers/repair-policy.mjs', 'tools/repair-iterations.mjs', 'src/effect-archive.js', 'src/evidence-search.js', 'index.js'].map((file) => [file, fs.readFileSync(file, 'utf8')]) })
}
export async function runRepairIterations(store) {
  const suite = repairSuite(), evaluationScope = repairEvaluationScope(), completed = store.readHead('repair-iterations')
  if (completed) {
    const old = store.getJson(completed.ref, { kind: 'repair-iterations' })
    if (old.evaluationScope !== evaluationScope || old.suiteDigest !== suite.digest) throw new Error('repair-iterations-source-changed-consumed')
    return I.immutableJson({ ...old, cached: true })
  }
  if (store.readHead('repair-protocol')) throw new Error('repair-protocol-already-started-no-blind-rerun')
  const development = await runRepairDevelopment(store), records = new Map(), fixtures = [...suite.train, ...suite.selection, ...suite.test]
  const key = (name, input) => name + ':' + I.evidenceDigest(input)
  for (const r of development.records) records.set('static-safe:' + r.inputDigest, { ...r, policy: 'static-safe', reused: true })
  // 所有四个比较臂/三个候选与同格择优顺序均在 test 前持久固定。
  const protocol = { schema: 'cfb.repair-protocol/1', suiteDigest: suite.digest, evaluationScope, policies: REPAIR_POLICIES, plan: REPAIR_BRANCH_PLAN,
    candidates: ['active-routing', 'routing-only', 'active-only'].map(repairCandidate), additionalPairedArm: 'active-only',
    note: 'active-only 若二元完成平局不会入库；它的冻结 test 比较只记录诊断效率，不重新进入候选选择。同格优先 active-routing，预先指定，不以 test 调序。' }
  store.setHead('repair-protocol', store.putJson(protocol, { kind: 'repair-protocol' }), { expectedRevision: null })
  const execute = async (name, input, signal) => {
    const k = key(name, input)
    if (records.has(k)) return records.get(k).output
    if (signal?.aborted) throw new Error('repair-evaluation-aborted')
    const fixture = fixtures.find((f) => I.evidenceDigest(f.input) === I.evidenceDigest(input))
    if (!fixture) throw new Error('repair-input-outside-frozen-suite')
    const split = ['train', 'selection', 'test'].find((s) => suite[s].some((f) => f.id === fixture.id))
    if (split === 'test') {
      const head = store.readHead('effect-holdouts'), journal = head && store.getJson(head.ref, { kind: 'holdout-journal' })
      if (!journal || !suite.test.every((f) => journal.spent.includes(f.family))) throw new Error('repair-test-without-persistent-reservation')
    }
    const output = await runApprovedRepair(name, input), record = { fixtureId: fixture.id, family: fixture.family, inputDigest: I.evidenceDigest(input), split, output, policy: name, reused: false, evaluationScope }
    records.set(k, { ...record, ref: store.putJson(record, { kind: 'repair-paired-record' }) }); return output
  }
  const evaluateAsync = async (entry, input, signal) => {
    // family/split 只存在宿主测量/预占层；从不传给分支控制器。
    if (suite.test.some((f) => I.evidenceDigest(f.input) === I.evidenceDigest(input))) await execute('active-only', input, signal)
    const name = entry ? JSON.parse(entry.body).name : 'static-safe'
    if (entry && !protocol.candidates.some((c) => c.id === entry.id)) throw new Error('repair-candidate-outside-approved-set')
    return execute(name, input, signal)
  }
  const search = await I.runEvidenceSearch({ store, suite, candidates: protocol.candidates, evaluateAsync, maxCandidates: 3, maxEvaluations: 66, evaluationTimeoutMs: 10000, evaluationScope })
  const rows = [...records.values()], summary = Object.fromEntries(Object.keys(REPAIR_POLICIES).map((name) => [name, {
    ...aggregateRepair(rows.filter((r) => r.policy === name)), splits: Object.fromEntries(['train', 'selection', 'test'].map((split) => [split, aggregateRepair(rows.filter((r) => r.policy === name && r.split === split))])),
  }]))
  const effects = Object.fromEntries(Object.keys(REPAIR_POLICIES).filter((n) => n !== 'static-safe').map((name) => {
    const paired = fixtures.map((f) => {
      const beforeOutput = records.get(key('static-safe', f.input))?.output, afterOutput = records.get(key(name, f.input))?.output
      const known = (o) => o && Object.hasOwn(o, 'solved') ? o.solved === true : null
      const before = known(beforeOutput), after = known(afterOutput)
      return { fixtureId: f.id, family: f.family, split: ['train', 'selection', 'test'].find((s) => suite[s].some((a) => a.id === f.id)), before, after,
        sign: before === null || after === null ? '?' : before === after ? '0' : after ? '+' : '-' }
    })
    return [name, { rows: paired, gate: I.gateSignedEffects(paired) }]
  }))
  const actual = rows.filter((r) => !r.reused), report = { schema: 'cfb.repair-iterations/1', suiteDigest: suite.digest, evaluationScope, cached: false,
    modelCalls: 0, externalApiCalls: 0, cost: 0, summary, effects, search, records: rows,
    execution: { pairedEpisodes: rows.length, reusedEpisodes: rows.filter((r) => r.reused).length, newEpisodes: actual.length,
      newWorkerProcesses: actual.reduce((n, r) => n + r.output.workerProcesses, 0), newOracleProcesses: actual.reduce((n, r) => n + r.output.oracleProcesses, 0), newLoopbackRequests: actual.reduce((n, r) => n + r.output.loopbackRequests, 0),
      heldoutEpisodes: rows.filter((r) => r.split === 'test').length },
    scope: '代理编写/参考已知的真实本机故障复现；不是独立作者/外部 DSH/模型泛化。库条目只适用本地认证签名，不自动启用生产。' }
  store.setHead('repair-iterations', store.putJson(report, { kind: 'repair-iterations' }), { expectedRevision: null }); return I.immutableJson(report)
}
async function main() {
  const isolation = assertOfflineNamespace(), report = await runRepairIterations(repairLibrary())
  fs.mkdirSync('.cfb-runtime/repair-iterations', { recursive: true }); fs.writeFileSync(path.resolve('.cfb-runtime/repair-iterations/report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ cached: report.cached, modelCalls: report.modelCalls, externalApiCalls: report.externalApiCalls, execution: report.execution,
    policies: Object.fromEntries(Object.entries(report.summary).map(([name, s]) => [name, { solved: s.solved, tasks: s.tasks, diagnosticChecks: s.diagnosticChecks, actions: s.actions, recovery: s.recovery, unknown: s.decidableChecks.unknown }])),
    candidates: report.search.counters, admitted: report.search.activeIds.length, gates: Object.fromEntries(Object.entries(report.effects).map(([name, e]) => [name, e.gate])), isolation, scope: report.scope }, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.stack); process.exitCode = 1 })
