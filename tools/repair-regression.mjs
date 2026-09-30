#!/usr/bin/env node
// 固定已知开发回归。不是盲测/搜索/入库，不读旧留出或认证库。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { repairSuite } from './helpers/repair-host.mjs'
import { runApprovedRepair } from './helpers/repair-policy.mjs'
import { assertOfflineNamespace } from './verify-offline.mjs'
export async function runRepairRegression() {
  const fixtures = repairSuite({ developmentOnly: true }).train, rows = [], summary = {}
  for (const name of ['static-safe', 'active-only', 'active-routing']) {
    const modes = {}
    for (const diagnosticMode of ['always', 'before-retry']) {
      const records = []
      for (const f of fixtures) {
        const output = await runApprovedRepair(name, f.input, { diagnosticMode })
        records.push({ fixtureId: f.id, output }); rows.push({ policy: name, diagnosticMode, fixtureId: f.id, output })
        for (const field of ['publication', 'actions', 'decidableChecks', 'recovery', 'oracleAgreement']) assert.equal(output[field].n, output[field].total, name + ':' + field)
        assert.equal(output.decidableChecks.unknown, 0)
      }
      modes[diagnosticMode] = { tasks: records.length, solved: records.filter((r) => r.output.solved === true).length,
        diagnosticChecks: records.reduce((n, r) => n + r.output.diagnostics, 0),
        preconditions: records.reduce((n, r) => n + r.output.outputs.reduce((n, o) => n + o.receipts.filter((r) => r.binding.phase === 'preconditions').length, 0), 0),
        acceptance: records.reduce((n, r) => n + r.output.outputs.reduce((n, o) => n + o.receipts.filter((r) => r.binding.phase === 'postconditions').length, 0), 0) }
    }
    assert.equal(modes.always.solved, modes['before-retry'].solved); assert.equal(modes.always.preconditions, modes['before-retry'].preconditions); assert.equal(modes.always.acceptance, modes['before-retry'].acceptance)
    summary[name] = modes
  }
  assert.deepEqual([summary['static-safe'].always.diagnosticChecks, summary['static-safe']['before-retry'].diagnosticChecks], [12, 8])
  assert.deepEqual([summary['active-only'].always.diagnosticChecks, summary['active-only']['before-retry'].diagnosticChecks], [8, 6])
  assert.deepEqual([summary['active-routing'].always.diagnosticChecks, summary['active-routing']['before-retry'].diagnosticChecks], [6, 6])
  const unknown = {}
  for (const diagnosticMode of ['always', 'before-retry']) {
    const output = await runApprovedRepair('active-routing', fixtures[1].input, { diagnosticMode, unknownDiagnostics: true })
    assert.equal(Object.hasOwn(output, 'solved'), false); assert.deepEqual(output.decisions, []); assert.equal(output.counters.repairs, 1)
    unknown[diagnosticMode] = { unknownChecks: output.decidableChecks.unknown, status: output.controllerStatus }
    rows.push({ control: 'unknown', diagnosticMode, output })
  }
  assert.equal(unknown.always.unknownChecks, 2); assert.equal(unknown['before-retry'].unknownChecks, 1)
  const cancelled = new AbortController(); cancelled.abort()
  const no = await runApprovedRepair('active-routing', fixtures[0].input, { signal: cancelled.signal })
  assert.equal(Object.hasOwn(no, 'solved'), false); assert.equal(no.counters.rounds, 0); assert.equal(no.workerProcesses, 0)
  return I.immutableJson({ schema: 'cfb.repair-known-regression/1', modelCalls: 0, externalApiCalls: 0, cost: 0, heldoutEpisodes: 0, libraryWrites: 0,
    scope: '6个已知train任务×3策略×2诊断模式的工程回归；非独立泛化，不用于搜索/入库。', summary, unknown, preCancelled: { status: no.controllerStatus, rounds: no.counters.rounds, workerProcesses: no.workerProcesses },
    episodes: rows.length + 1, workerProcesses: rows.reduce((n, r) => n + r.output.workerProcesses, 0), oracleProcesses: rows.reduce((n, r) => n + r.output.oracleProcesses, 0), loopbackRequests: rows.reduce((n, r) => n + r.output.loopbackRequests, 0),
    sourceDigest: I.evidenceDigest(['src/evidence-episode.js', 'src/evidence-runtime.js', 'src/active-checks.js', 'tools/helpers/repair-policy.mjs', 'tools/helpers/repair-host.mjs', 'test/fixtures/repair-workload.cjs', 'test/fixtures/repair-oracle.cjs', 'tools/repair-regression.mjs'].map((f) => [f, fs.readFileSync(f, 'utf8')])), rows })
}
async function main() {
  const isolation = assertOfflineNamespace(), report = await runRepairRegression()
  fs.mkdirSync('.cfb-runtime/repair-iterations', { recursive: true }); fs.writeFileSync('.cfb-runtime/repair-iterations/control-regression.json', JSON.stringify(report, null, 2) + '\n')
  const { rows, ...summary } = report; console.log(JSON.stringify({ ...summary, isolation }, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.stack); process.exitCode = 1 })
