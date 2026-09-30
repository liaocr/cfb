import * as I from '../../index.js'
import { makeRepairHost, summarizeRepair, REPAIR_SIGNATURE } from './repair-host.mjs'
export const REPAIR_POLICIES = I.immutableJson({
  'static-safe': { diagnosticStrategy: 'fixed', routing: 'fixed' },
  'active-only': { diagnosticStrategy: 'active', routing: 'fixed' },
  'routing-only': { diagnosticStrategy: 'fixed', routing: 'posterior' },
  'active-routing': { diagnosticStrategy: 'active', routing: 'posterior' },
})
export const REPAIR_BRANCH_PLAN = I.immutableJson({ firstActionId: 'relax-delay', fallbackActionId: 'await-response',
  routes: { timing: 'relax-delay', assertion: 'await-response', identity: 'pin-model' }, minPosterior: 0.99, maxAttempts: 2 })
export function repairCandidate(name) {
  if (!Object.hasOwn(REPAIR_POLICIES, name) || name === 'static-safe') throw new Error('repair-candidate-not-approved')
  return I.createMemoryCandidate({ kind: 'rule', body: I.canonicalJson({ name, ...REPAIR_POLICIES[name], ...REPAIR_BRANCH_PLAN }), signature: REPAIR_SIGNATURE,
    trigger: { op: 'equals', field: 'approvedLocalTask', value: true }, sources: ['docs/analysis/LOCAL-ITERATIONS-2026-09-30.md'] })
}
export async function runApprovedRepair(name, input, options = {}) {
  if (!Object.hasOwn(REPAIR_POLICIES, name)) throw new Error('repair-policy-not-approved')
  const configuration = REPAIR_POLICIES[name]
  const e = await makeRepairHost(input, { ...options, diagnosticStrategy: configuration.diagnosticStrategy, diagnosticOrder: configuration.diagnosticStrategy === 'fixed' ? ['b-order', 'c-assertion'] : null })
  try {
    const policy = I.freezeApprovedRepairPolicy({ ...REPAIR_BRANCH_PLAN, routing: configuration.routing }, e.contract)
    // 控制器不接收 input、family、fixture 文件、参考标签或对照结果。
    const controller = I.createApprovedRepairEpisode({ host: e.host, contract: e.contract, policy }), result = await controller.run()
    const recovery = result.outcomes.filter((r) => !r.ok).map((r) => ({ complete: r.status === 'rolled-back' && r.restored?.restored === true, status: r.status }))
    const summary = summarizeRepair(e, result.outcomes, result.publications, recovery)
    const output = { ...summary, controllerStatus: result.status, decisions: result.decisions, policyDigest: policy.digest }
    // 缺失证据不得被二元效果门当成已知的失败，更不能“平均”掉 unknown。
    if (summary.decidableChecks.unknown || summary.oracleAgreement.n !== summary.oracleAgreement.total || result.status.includes('unknown')) delete output.solved
    return I.immutableJson(output)
  } finally { e.cleanup() }
}
