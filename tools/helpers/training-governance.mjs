// 宿主签发训练批准与独立发布证书。纯数据gate不等于已获生产权限。
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { isEvidenceStore } from '../../src/evidence-store.js'
import { gateTrainingRelease } from '../../src/training-core.js'
const APPROVALS = new WeakSet()
export const isTrainingApproval = (p) => !!p && APPROVALS.has(p)
export function createTrainingGovernance({ store, authorize = null, authenticateEvaluation = null }) {
  if (!isEvidenceStore(store) || authorize !== null && typeof authorize !== 'function' || authenticateEvaluation !== null && typeof authenticateEvaluation !== 'function') throw new Error('training-governance-authority')
  const head = (name, kind, fallback) => { const h = store.readHead(name); return { head: h, state: h ? store.getJson(h.ref, { kind }) : fallback } }
  const approve = (plan, policy) => {
    if (!authorize || authorize(plan, policy) !== true || !['local-compute', 'remote-money', 'fixture'].includes(policy.mode) || typeof policy.owner !== 'string' || !policy.owner || !Number.isFinite(policy.maxUsd) || policy.maxUsd < 0 || policy.maxUsd > 10000 || plan.simulated !== (policy.mode === 'fixture')) throw new Error('training-approval-not-authorized')
    const body = { schema: 'cfb.training-approval/1', planDigest: plan.digest, datasetDigest: plan.dataset.digest, authorityId: store.authorityId, mode: policy.mode, owner: policy.owner, maxUsd: policy.maxUsd, maxSteps: plan.profile.recipe.maxSteps, maxComputeSteps: plan.profile.limits.maxComputeSteps ?? plan.profile.recipe.maxSteps, maxWallSeconds: plan.profile.limits.maxWallSeconds, maxHttpRequests: plan.profile.limits.maxHttpRequests }
    const ref = store.putJson(body, { kind: 'training-approval' }), view = head('training-approvals', 'training-approvals', { refs: [], revoked: [] })
    store.setHead('training-approvals', store.putJson({ ...view.state, refs: [...new Set([...view.state.refs, ref])] }, { kind: 'training-approvals' }), { expectedRevision: view.head?.revision || null })
    return openApproval(ref, plan)
  }
  const openApproval = (ref, plan) => {
    const view = head('training-approvals', 'training-approvals', { refs: [], revoked: [] })
    if (!view.state.refs.includes(ref) || view.state.revoked.includes(ref)) throw new Error('training-approval-missing-or-revoked')
    const p = store.getJson(ref, { kind: 'training-approval' })
    if (p.schema !== 'cfb.training-approval/1' || p.authorityId !== store.authorityId || p.planDigest !== plan.digest || p.datasetDigest !== plan.dataset.digest) throw new Error('training-approval-binding')
    const approved = immutableJson({ ...p, ref, id: evidenceDigest({ ref, planDigest: plan.digest }) }); APPROVALS.add(approved); return approved
  }
  const revokeApproval = (ref) => {
    const view = head('training-approvals', 'training-approvals', { refs: [], revoked: [] })
    store.setHead('training-approvals', store.putJson({ ...view.state, revoked: [...new Set([...view.state.revoked, ref])] }, { kind: 'training-approvals' }), { expectedRevision: view.head?.revision || null })
  }
  const certify = ({ candidate, plan, effects, evaluatorDigest, evaluationRef }) => {
    if (!authenticateEvaluation || authenticateEvaluation({ candidate, plan, effects, evaluatorDigest, evaluationRef }) !== true || !/^[a-f0-9]{64}$/.test(evaluatorDigest || '')) throw new Error('training-independent-evaluation-required')
    if (!plan.evaluationSuite || plan.evaluationSuite.evaluatorDigest !== evaluatorDigest) throw new Error('training-frozen-evaluation-required')
    const gate = gateTrainingRelease(effects, { simulated: candidate.simulated || plan.simulated, suite: plan.evaluationSuite })
    const body = { schema: 'cfb.training-release-certificate/1', authorityId: store.authorityId, candidateDigest: candidate.digest, planDigest: plan.digest, datasetDigest: plan.dataset.digest, evaluatorDigest, evaluationRef, suiteDigest: plan.evaluationSuite.digest, effects, gate }
    const ref = store.putJson(body, { kind: 'training-release-certificate' }), registry = head('training-certificates', 'training-certificates', { refs: [] })
    store.setHead('training-certificates', store.putJson({ refs: [...new Set([...registry.state.refs, ref])] }, { kind: 'training-certificates' }), { expectedRevision: registry.head?.revision || null })
    return { ref, gate }
  }
  const promote = ({ candidate, plan, certificateRef }) => {
    if (!head('training-certificates', 'training-certificates', { refs: [] }).state.refs.includes(certificateRef)) throw new Error('training-release-certificate-untrusted')
    const proof = store.getJson(certificateRef, { kind: 'training-release-certificate' })
    if (candidate.simulated || plan.simulated || proof.authorityId !== store.authorityId || proof.candidateDigest !== candidate.digest || proof.planDigest !== plan.digest || proof.datasetDigest !== plan.dataset.digest || !proof.gate.ok || proof.suiteDigest !== plan.evaluationSuite?.digest || !gateTrainingRelease(proof.effects, { suite: plan.evaluationSuite }).ok) throw new Error('training-release-not-approved')
    const view = head('training-models', 'training-models', { current: null, history: [] }), row = { candidateDigest: candidate.digest, planDigest: plan.digest, certificateRef }
    const history = [...view.state.history, row]; if (history.length > 128) throw new Error('training-registry-budget')
    const next = { current: row, history }; store.setHead('training-models', store.putJson(next, { kind: 'training-models' }), { expectedRevision: view.head?.revision || null })
    return immutableJson({ ...next, productionConfigModified: false })
  }
  const rollback = () => {
    const view = head('training-models', 'training-models', { current: null, history: [] }), history = view.state.history
    if (history.length < 2) throw new Error('training-no-previous-model')
    const next = { current: history.at(-2), history: history.slice(0, -1) }; store.setHead('training-models', store.putJson(next, { kind: 'training-models' }), { expectedRevision: view.head?.revision || null }); return immutableJson(next)
  }
  return Object.freeze({ approve, openApproval, revokeApproval, certify, promote, rollback, view: () => head('training-models', 'training-models', { current: null, history: [] }).state })
}
