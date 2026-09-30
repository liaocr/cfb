// 代码代理编写的宿主协议合成夹具，24 条 / 6 族 / 8:8:8。只测工程门，不是 S0 主模型任务评测。
import { freezeEffectSuite, createMemoryCandidate } from '../../index.js'
export function effectFixtureSuite(suffix = '') {
  const parts = {}, families = { train: ['freshness', 'conditions'], selection: ['landing', 'termination'], test: ['revision', 'identity'] }
  for (const [split, names] of Object.entries(families)) {
    parts[split] = names.flatMap((name) => Array.from({ length: 4 }, (_, i) => {
      const checks = { fresh: true, equivalent: true, landed: true, terminated: true, revision: true, identity: true }
      if (i % 2) checks[Object.keys(checks)[['freshness', 'conditions', 'landing', 'termination', 'revision', 'identity'].indexOf(name)]] = false
      return { id: name + suffix + ':' + i, family: name + suffix, input: { family: name, checks },
        predicate: { op: 'equals', field: 'allow', value: i % 2 === 0 } }
    }))
  }
  return freezeEffectSuite({ id: 'protocol-fixtures' + suffix, evaluatorVersion: 'synthetic-binary-v1', ...parts })
}
export function effectFixtureEvaluator(candidate, input) {
  if (candidate?.body === 'unknown') return {}
  if (candidate?.body === 'regress') return { allow: false }
  if (candidate?.body === 'strict' || candidate?.body === 'selection-only' && !['revision', 'identity'].includes(input.family)) return { allow: Object.values(input.checks).every((x) => x === true) }
  return { allow: true }
}
export const memorySignature = { taskFamily: 'timer-evidence', environment: 'node-fixture-v1', contractVersion: '1' }
export function memoryCandidate({ kind = 'rule', body = 'strict', signature = memorySignature, expiresAt } = {}) {
  return createMemoryCandidate({ kind, body, signature, trigger: { op: 'equals', field: 'failed', value: true },
    sources: ['synthetic-host-protocol-fixture:v1'], ...(expiresAt === undefined ? {} : { expiresAt }) })
}
