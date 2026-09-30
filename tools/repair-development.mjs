#!/usr/bin/env node
// 第一轮：仅开发族，真实原生宿主闭环与强基线瓶颈。无模型/外部 API。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { repairSuite, runStaticRepair } from './helpers/repair-host.mjs'
import { assertOfflineNamespace } from './verify-offline.mjs'
export function repairSourceDigest() {
  const files = ['src/evidence-runtime.js', 'src/evidence-program.js', 'src/evidence-host.js', 'src/evidence-checkpoint.js', 'src/evidence-store.js', 'src/active-checks.js', 'src/evidence-context.js', 'src/evidence-intents.js', 'src/tokens.js',
    'tools/helpers/repair-host.mjs', 'test/fixtures/repair-workload.cjs', 'test/fixtures/repair-oracle.cjs']
  return I.evidenceDigest(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
}
export function repairLibrary() { return I.createEvidenceStore({ directory: path.resolve('.cfb-runtime/repair-iterations/library'), sessionId: 'repair-iterations-v1' }) }
export function aggregateRepair(records) {
  const outputs = records.map((r) => r.output), total = (field, key) => outputs.reduce((n, o) => n + (o[field]?.[key] || 0), 0)
  return I.immutableJson({ tasks: records.length, solved: outputs.filter((o) => o.solved).length,
    publication: { n: total('publication', 'n'), total: total('publication', 'total') }, decidableChecks: { n: total('decidableChecks', 'n'), total: total('decidableChecks', 'total'), unknown: total('decidableChecks', 'unknown') },
    actions: { n: total('actions', 'n'), total: total('actions', 'total') }, recovery: { n: total('recovery', 'n'), total: total('recovery', 'total') },
    secondBranch: { entered: outputs.filter((o) => o.secondBranch.entered).length, solved: outputs.filter((o) => o.secondBranch.solved).length },
    diagnosticChecks: outputs.reduce((n, o) => n + o.diagnostics, 0), repairs: outputs.reduce((n, o) => n + o.counters.repairs, 0),
    workerProcesses: outputs.reduce((n, o) => n + o.workerProcesses, 0), oracleAgreement: { n: total('oracleAgreement', 'n'), total: total('oracleAgreement', 'total') },
    loopbackRequests: outputs.reduce((n, o) => n + o.loopbackRequests, 0) })
}
export async function runRepairDevelopment(store) {
  const head = store.readHead('repair-development'), sourceDigest = repairSourceDigest(), suite = repairSuite()
  if (head) {
    const previous = store.getJson(head.ref, { kind: 'repair-development' })
    if (previous.sourceDigest !== sourceDigest || previous.suiteDigest !== suite.digest) throw new Error('repair-development-source-changed')
    return I.immutableJson({ ...previous, cached: true })
  }
  const records = []
  for (const split of ['train', 'selection']) for (const fixture of suite[split]) {
    const output = await runStaticRepair(fixture.input)
    const record = { fixtureId: fixture.id, family: fixture.family, inputDigest: I.evidenceDigest(fixture.input), split, output }
    records.push({ ...record, ref: store.putJson(record, { kind: 'repair-baseline-record' }) })
  }
  const report = { schema: 'cfb.repair-development/1', sourceDigest, suiteDigest: suite.digest, modelCalls: 0, externalApiCalls: 0, records, summary: aggregateRepair(records),
    heldoutTasksExecuted: 0, fullDshHost: 'blocked-not-installed', bottleneck: 'second-approved-branch-selection', note: '仓库原生生产代码+真实 IO，不是已验证外部 DSH/Cordis；故障复现任务由代理编写、参考已知。' }
  const ref = store.putJson(report, { kind: 'repair-development' }); store.setHead('repair-development', ref, { expectedRevision: null })
  return I.immutableJson({ ...report, cached: false })
}
async function main() {
  const isolation = assertOfflineNamespace(), report = await runRepairDevelopment(repairLibrary())
  fs.mkdirSync('.cfb-runtime/repair-iterations', { recursive: true }); fs.writeFileSync('.cfb-runtime/repair-iterations/development.json', JSON.stringify(report, null, 2) + '\n')
  const { records, ...summary } = report; console.log(JSON.stringify({ ...summary, isolation }, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.stack); process.exitCode = 1 })
