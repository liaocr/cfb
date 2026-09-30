import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as I from '../index.js'
import { makeRepairHost } from '../tools/helpers/repair-host.mjs'
import { REPAIR_POLICIES, REPAIR_BRANCH_PLAN, repairCandidate, runApprovedRepair } from '../tools/helpers/repair-policy.mjs'
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const options = (e, overrides = {}) => ({ host: e.host, contract: e.contract, policy: I.freezeApprovedRepairPolicy({ ...REPAIR_BRANCH_PLAN, routing: 'posterior', ...overrides }, e.contract) })
await test('冻结 2x2 一次只换一因素，候选只有批准三种，无执行策略从输入读族/标签', () => {
  assert.equal(REPAIR_POLICIES['active-only'].routing, REPAIR_POLICIES['static-safe'].routing)
  assert.equal(REPAIR_POLICIES['routing-only'].diagnosticStrategy, REPAIR_POLICIES['static-safe'].diagnosticStrategy)
  assert.throws(() => repairCandidate('unapproved'), /approved/)
  assert.ok(Object.isFrozen(REPAIR_BRANCH_PLAN.routes))
  for (const name of ['freezeApprovedRepairPolicy', 'createApprovedRepairEpisode']) { assert.equal(typeof I[name], 'function'); assert.ok(fs.readFileSync('index.d.ts', 'utf8').includes('export declare function ' + name + '(')) }
})
await test('策略精确绑定契约与批准动作，不能放宽信心/多一轮/改检查器', async () => {
  const e = await makeRepairHost({ caseId: 'plain-json:1' })
  try {
    for (const override of [{ maxAttempts: 3 }, { minPosterior: 0.2 }, { firstActionId: 'weaken-goal' }, { routes: { identity: 'edit-oracle' } }]) assert.throws(() => options(e, override), /permission-budget/)
    const o = options(e); assert.throws(() => I.createApprovedRepairEpisode({ ...o, policy: { ...o.policy, routing: 'fixed' } }), /drift/)
  } finally { e.cleanup() }
})
await test('拒绝同形伪宿主和外部后验注入；原生品牌但错契约也不接线', async () => {
  const e = await makeRepairHost({ caseId: 'plain-json:1' })
  try {
    const o = options(e); assert.throws(() => I.createApprovedRepairEpisode({ ...o, host: { ...e.host } }), /native-host/)
    const controller = I.createApprovedRepairEpisode(o); assert.equal(controller.record, undefined); assert.equal(controller.route, undefined)
    const { schema, digest, ...def } = e.contract, other = I.freezeEvidenceContract({ ...def, task: 'other-contract' })
    assert.throws(() => I.createApprovedRepairEpisode({ host: e.host, contract: other, policy: I.freezeApprovedRepairPolicy({ ...REPAIR_BRANCH_PLAN, routing: 'posterior' }, other) }), /native-host/)
  } finally { e.cleanup() }
})
await test('实际迟到任务第一批准分支完成，不先占一轮纯诊断，第三轮不编辑', async () => {
  const o = await runApprovedRepair('active-routing', { caseId: 'plain-json:0' })
  assert.equal(o.solved, true); assert.equal(o.counters.rounds, 1); assert.equal(o.diagnostics, 0); assert.deepEqual(o.decisions, [])
})
await test('身份故障只换路由即可修：固定 2 诊断/EIG 1 诊断，同一目标和批准 pin-model', async () => {
  const fixed = await runApprovedRepair('routing-only', { caseId: 'plain-json:2' }), active = await runApprovedRepair('active-routing', { caseId: 'plain-json:2' })
  assert.equal(fixed.solved, true); assert.equal(active.solved, true); assert.equal(fixed.diagnostics, 2); assert.equal(active.diagnostics, 1)
  assert.equal(active.decisions[0].nextActionId, 'pin-model'); assert.equal(active.counters.repairs, 2); assert.equal(active.recovery.n, 1)
  assert.ok(active.traces.every((t) => t.primary === t.secondary)); assert.equal(active.traces.at(-1).raw.identity.model, 'local-model')
})
await test('提前断言用真实事件识别，EIG不自报答案，路由后明确等主响应', async () => {
  const o = await runApprovedRepair('active-routing', { caseId: 'plain-json:1' })
  assert.equal(o.solved, true); assert.equal(o.diagnostics, 2); assert.equal(o.decisions[0].nextActionId, 'await-response')
  assert.ok(o.traces[0].raw.events.find((e) => e.kind === 'assert').wasComplete === false)
  assert.ok(o.traces.at(-1).raw.events.find((e) => e.kind === 'assert').wasComplete === true)
})
await test('只换 EIG 不假称完成增益，固定错误分支仍失败并完整恢复', async () => {
  const fixed = await runApprovedRepair('static-safe', { caseId: 'plain-json:2' }), active = await runApprovedRepair('active-only', { caseId: 'plain-json:2' })
  assert.equal(fixed.solved, false); assert.equal(active.solved, false); assert.equal(fixed.diagnostics, 4); assert.equal(active.diagnostics, 2)
  assert.equal(active.recovery.n, 2); assert.equal(active.controllerStatus, 'repair-budget')
})
await test('unknown 否决：不路由、不消耗第二修复、不把未知写成已知二元失败', async () => {
  const o = await runApprovedRepair('active-routing', { caseId: 'plain-json:1' }, { unknownDiagnostics: true })
  assert.equal(Object.hasOwn(o, 'solved'), false); assert.equal(o.controllerStatus, 'unknown-diagnostic'); assert.deepEqual(o.decisions, [])
  assert.equal(o.counters.repairs, 1); assert.equal(o.recovery.n, 1); assert.ok(o.decidableChecks.unknown > 0)
})
await test('后验没有批准路由也停止；单次权限预算不会多执行；并发/重放拒绝', async () => {
  const e = await makeRepairHost({ caseId: 'plain-json:2' })
  try {
    const controller = I.createApprovedRepairEpisode(options(e, { routes: { assertion: 'await-response' } }))
    const running = controller.run(), parallel = await controller.run(); assert.equal(parallel.status, 'episode-busy')
    const r = await running; assert.equal(r.status, 'insufficient-posterior'); assert.equal(r.solved, false); assert.equal(r.counters.repairs, 1); assert.equal(e.recovered(), true)
    assert.equal((await controller.run()).status, 'episode-already-run')
  } finally { e.cleanup() }
})
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
