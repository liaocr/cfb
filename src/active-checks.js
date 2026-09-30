// 主动检查：完整条件熵/贝叶斯更新。宿主预注册有限假设与似然，不从评委分数拟合。
import { assertEvidenceContract, evidenceDigest, immutableJson } from './evidence-program.js'
const EPS = 1e-10
const probabilities = (p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length || Object.values(p).some((x) => !Number.isFinite(x) || x < 0)) throw new Error('probability-schema')
  const total = Object.values(p).reduce((a, b) => a + b, 0)
  if (!(total > 0)) throw new Error('zero-probability')
  return Object.fromEntries(Object.entries(p).map(([k, x]) => [k, x / total]))
}
export function evidenceEntropy(prior) {
  return Object.values(probabilities(prior)).reduce((h, p) => h - (p > 0 ? p * Math.log2(p) : 0), 0)
}
function validateLikelihood(prior, likelihood) {
  const keys = Object.keys(prior)
  if (!likelihood || Object.keys(likelihood).length !== keys.length) throw new Error('likelihood-schema')
  let outcomes
  for (const h of keys) {
    const row = likelihood[h]
    if (!row || Object.keys(row).sort().join(',') !== 'fail,pass' || Object.values(row).some((x) => !Number.isFinite(x) || x < 0 || x > 1) || Math.abs(row.pass + row.fail - 1) > EPS) throw new Error('likelihood-row')
    outcomes = Object.keys(row)
  }
  return outcomes
}
export function evidencePosterior(prior, likelihood, outcome) {
  const p = probabilities(prior), outcomes = validateLikelihood(p, likelihood)
  if (!outcomes.includes(outcome)) return { ok: false, reason: 'uninterpretable-outcome', prior: p }
  const weights = Object.fromEntries(Object.entries(p).map(([h, w]) => [h, w * likelihood[h][outcome]]))
  const probability = Object.values(weights).reduce((a, b) => a + b, 0)
  if (probability <= EPS) return { ok: false, reason: 'impossible-outcome', prior: p }
  return { ok: true, probability, prior: probabilities(weights) }
}
/** I(H;Y) = H(H) - Σ_y P(y) H(H|y)，不是只算 H(Y)。 */
export function expectedEvidenceGain(prior, likelihood) {
  const p = probabilities(prior), outcomes = validateLikelihood(p, likelihood)
  let conditional = 0
  for (const y of outcomes) { const post = evidencePosterior(p, likelihood, y); if (post.ok) conditional += post.probability * evidenceEntropy(post.prior) }
  return Math.max(0, evidenceEntropy(p) - conditional)
}
export function freezeDiagnosticModel(def, contract) {
  const c = assertEvidenceContract(contract), p = probabilities(def.prior)
  if (Object.keys(p).length > 32 || !Array.isArray(def.probes) || def.probes.length > 32) throw new Error('diagnostic-size')
  const checks = new Map(c.checks.map((x) => [x.id, x])), seen = new Set()
  for (const probe of def.probes) {
    if (seen.has(probe.checkId) || checks.get(probe.checkId)?.role !== 'diagnostic' || !Number.isFinite(probe.cost) || probe.cost <= 0) throw new Error('diagnostic-capability')
    seen.add(probe.checkId); validateLikelihood(p, probe.likelihood)
  }
  const body = { schema: 'cfb.diagnostic-model/1', contractDigest: c.digest, prior: p, probes: def.probes }
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
/** 调度状态只在宿主侧。未知回执消耗预算但不更新假设；不会把诊断成功变成验收成功。 */
export function createDiagnosticController({ model, contract, maxChecks = 4, maxCost = 8, minGain = 0.01, strategy = 'active', checkOrder = null, stopOnUnknown = false }) {
  const { digest, ...body } = model || {}
  if (evidenceDigest(body) !== digest || body.contractDigest !== assertEvidenceContract(contract).digest) throw new Error('diagnostic-model-drift')
  if (!Number.isInteger(maxChecks) || maxChecks < 0 || maxChecks > 16 || !Number.isFinite(maxCost) || maxCost < 0 || !Number.isFinite(minGain) || minGain < 0) throw new Error('diagnostic-budget')
  if (typeof stopOnUnknown !== 'boolean' || !['active', 'fixed'].includes(strategy) || checkOrder !== null && (!Array.isArray(checkOrder) || !checkOrder.length || new Set(checkOrder).size !== checkOrder.length || checkOrder.some((id) => !body.probes.some((p) => p.checkId === id)))) throw new Error('diagnostic-strategy')
  const order = [...(checkOrder || body.probes.map((p) => p.checkId))]
  let prior = probabilities(body.prior), count = 0, cost = 0, pending = null, stopped = null, scope = null, lastRevision = null
  const seen = new Set(), history = []
  const view = () => immutableJson({ prior, count, cost, maxChecks, maxCost, pending, stopped, history })
  const choose = (binding) => {
    const current = { sessionId: binding.sessionId, programId: binding.programId, contractDigest: binding.contractDigest, roundId: binding.roundId }
    if (binding.phase !== 'diagnostic' || current.contractDigest !== body.contractDigest || Object.values(current).some((v) => typeof v !== 'string' || !v) || typeof binding.revision !== 'string' || !binding.revision) throw new Error('diagnostic-binding')
    if (scope && evidenceDigest(scope) !== evidenceDigest(current)) throw new Error('diagnostic-scope-change')
    scope ??= current
    if (pending) return { ok: false, reason: 'awaiting-receipt' }
    if (lastRevision !== binding.revision && ['no-information', 'no-eligible-check'].includes(stopped)) stopped = null
    lastRevision = binding.revision
    if (stopped) return { ok: false, reason: stopped }
    if (count >= maxChecks) { stopped = 'check-budget'; return { ok: false, reason: stopped } }
    const candidates = body.probes.filter((p) => (strategy !== 'fixed' || order.includes(p.checkId)) && !seen.has(binding.revision + ':' + p.checkId) && cost + p.cost <= maxCost + EPS)
      .map((p) => ({ ...p, gain: expectedEvidenceGain(prior, p.likelihood) }))
      .sort((a, b) => strategy === 'fixed' ? order.indexOf(a.checkId) - order.indexOf(b.checkId) : b.gain - a.gain || a.cost - b.cost || a.checkId.localeCompare(b.checkId))
    const selected = candidates[0]
    if (!selected || strategy === 'active' && selected.gain <= minGain + EPS) { stopped = selected ? 'no-information' : 'no-eligible-check'; return { ok: false, reason: stopped } }
    count++; cost += selected.cost; seen.add(binding.revision + ':' + selected.checkId)
    pending = immutableJson({ checkId: selected.checkId, gain: selected.gain, cost: selected.cost, binding })
    return { ok: true, selected: pending }
  }
  const record = (receipt, authenticate) => {
    if (!pending) throw new Error('no-pending-check')
    let certified = false
    try { certified = typeof authenticate === 'function' && authenticate.constructor.name !== 'AsyncFunction' && authenticate(receipt) === true && receipt?.subjectId === pending.checkId && evidenceDigest(receipt.binding) === evidenceDigest(pending.binding) } catch { /* 认证失败关闭，不用异常授信。 */ }
    if (!certified) {
      stopped = 'invalid-diagnostic-receipt'; pending = null; return view()
    }
    const spec = body.probes.find((p) => p.checkId === pending.checkId)
    const post = evidencePosterior(prior, spec.likelihood, receipt.status)
    // unknown 是基础设施/证据缺失，不能用缺失去反证任务假设。
    if (post.ok) prior = post.prior
    else if (receipt.status !== 'unknown') stopped = post.reason
    else if (stopOnUnknown) stopped = 'unknown-evidence'
    history.push({ checkId: pending.checkId, revision: pending.binding.revision, status: receipt.status,
      gain: pending.gain, posteriorApplied: post.ok, receiptId: receipt.id })
    pending = null
    return view()
  }
  return Object.freeze({ choose, record, view })
}
export async function runActiveEvidenceChecks({ controller, verifier, binding, signal }) {
  const diagnostic = { ...binding, phase: 'diagnostic' }, receipts = []
  while (!signal?.aborted) {
    const next = controller.choose(diagnostic)
    if (!next.ok) break
    const receipt = await verifier.check(next.selected.checkId, diagnostic, { signal })
    receipts.push(receipt); controller.record(receipt, verifier.authenticate)
    if (controller.view().stopped) break
  }
  return immutableJson({ schema: 'cfb.diagnostic-result/1', receipts, state: controller.view(), acceptanceUnchanged: true })
}
