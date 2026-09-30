// 延迟义务与二元反馈。只有本进程真实验证器签发的回执可触发/兑现；不是工具拦截器。
import { assertEvidenceContract, assertEvidenceProgram, evidenceDigest, immutableJson, initialEvidenceState, advanceEvidenceState } from './evidence-program.js'
import { isEvidenceVerifier } from './evidence-host.js'
const terminal = new Set(['fulfilled', 'cancelled', 'invalidated'])
export function replayEvidenceTrace(program, receipts, verifier) {
  if (!isEvidenceVerifier(verifier)) throw new Error('trace-verifier-authority')
  const p = assertEvidenceProgram(program, verifier.contract)
  if (!Array.isArray(receipts) || !receipts.length) return null
  let at = 0, state = initialEvidenceState(p, receipts[0].binding)
  for (let i = 0; i < p.steps.length * 3 && state.status === 'ready'; i++) {
    const step = p.steps[state.cursor], count = state.phase === 'preconditions' ? step.preconditions.length : state.phase === 'action' ? 1 : step.expectedObservations.length
    if (at + count > receipts.length) break
    state = advanceEvidenceState(p, state, receipts.slice(at, at + count), verifier.authenticate)
    at += count
  }
  if (at !== receipts.length) throw new Error('trace-extra-receipts')
  return state
}
export function binaryEvidenceFeedback({ program, receipts = [], diagnosticReceipts = [], verifier, revision }) {
  if (!isEvidenceVerifier(verifier)) throw new Error('feedback-verifier-authority')
  const p = assertEvidenceProgram(program, verifier.contract), rows = []
  const trace = replayEvidenceTrace(p, receipts, verifier)
  const roundId = trace?.roundId
  for (const r of [...receipts, ...diagnosticReceipts]) {
    const spec = verifier.contract.checks.find((c) => c.id === r?.subjectId)
    const role = r?.binding?.phase === 'preconditions' ? 'precondition' : r?.binding?.phase === 'postconditions' ? 'acceptance' : r?.binding?.phase === 'diagnostic' ? 'diagnostic' : null
    if (!spec || spec.role !== role || !verifier.authenticate(r) || r.binding.sessionId !== p.sessionId || r.binding.programId !== p.id ||
      r.binding.contractDigest !== p.contractDigest || r.binding.roundId !== roundId) continue
    const fresh = verifier.intact() && r.binding.revision === revision
    rows.push({ checkId: spec.id, role, status: fresh ? r.status : 'unknown', fresh })
  }
  return immutableJson({ schema: 'cfb.binary-feedback/1', roundId: roundId || null, revision, checks: rows })
}
export function createEvidenceIntents({ contract, verifier, sessionId, readRevision, clock = Date.now, maxEntries = 128 }) {
  const c = assertEvidenceContract(contract)
  if (!isEvidenceVerifier(verifier) || verifier.contract.digest !== c.digest || typeof sessionId !== 'string' || !sessionId ||
    typeof readRevision !== 'function' || typeof clock !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) throw new Error('intent-authority-or-budget')
  const rows = new Map()
  const refresh = (row) => {
    if (terminal.has(row.status)) return
    if (!verifier.intact() || row.revision !== readRevision() || row.expiresAt !== null && clock() >= row.expiresAt) {
      row.status = 'invalidated'; row.reason = !verifier.intact() ? 'source-drift' : row.revision !== readRevision() ? 'revision-changed' : 'expired'
    }
  }
  const define = ({ program, binding, stepId, expiresAt = null }) => {
    const p = assertEvidenceProgram(program, c), step = p.steps.find((s) => s.id === stepId)
    if (!step || !step.preconditions.length || p.sessionId !== sessionId || binding?.sessionId !== sessionId || binding.programId !== p.id ||
      binding.contractDigest !== c.digest || binding.stepId !== stepId || binding.phase !== 'preconditions' || !binding.roundId || binding.revision !== readRevision() ||
      expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= clock())) throw new Error('intent-scope')
    const id = evidenceDigest({ sessionId, programId: p.id, roundId: binding.roundId, stepId })
    if (rows.has(id)) return id
    if (rows.size >= maxEntries) throw new Error('intent-budget')
    rows.set(id, { id, programId: p.id, roundId: binding.roundId, stepId, contractDigest: c.digest, revision: binding.revision,
      triggerChecks: [...step.preconditions], action: step.action, acceptanceChecks: step.expectedObservations.map((x) => x.checkId),
      status: 'armed', reason: null, expiresAt, triggerReceipts: {}, acceptanceReceipts: {}, actionReceipt: null })
    return id
  }
  const record = (receipts) => {
    if (!Array.isArray(receipts)) throw new Error('intent-receipts')
    for (const row of rows.values()) {
      // 动作已发生时 revision 合法推进到 nextRevision，不能在处理它之前当成外部漂移。
      for (const r of receipts) {
        if (terminal.has(row.status) || !verifier.authenticate(r) || r?.status !== 'pass' || r.ok !== true || !verifier.intact() ||
          r.binding?.sessionId !== sessionId || r.binding.programId !== row.programId || r.binding.roundId !== row.roundId ||
          r.binding.contractDigest !== c.digest || r.binding.stepId !== row.stepId || r.binding.revision !== row.revision ||
          row.expiresAt !== null && clock() >= row.expiresAt) continue
        if (row.status === 'armed' && r.binding.phase === 'preconditions' && row.triggerChecks.includes(r.subjectId) && readRevision() === row.revision) {
          row.triggerReceipts[r.subjectId] = r.id
          if (row.triggerChecks.every((id) => row.triggerReceipts[id])) row.status = 'pending'
        } else if (row.status === 'pending' && r.binding.phase === 'action' && r.subjectId === row.action.id && r.nextRevision === readRevision()) {
          row.status = 'executed'; row.actionReceipt = r.id; row.revision = r.nextRevision
        } else if (row.status === 'executed' && r.binding.phase === 'postconditions' && row.acceptanceChecks.includes(r.subjectId) && readRevision() === row.revision) {
          row.acceptanceReceipts[r.subjectId] = r.id
          if (row.acceptanceChecks.every((id) => row.acceptanceReceipts[id])) row.status = 'fulfilled'
        }
      }
      refresh(row)
    }
  }
  const canExecute = (programId, roundId, stepId) => {
    const row = [...rows.values()].find((r) => r.programId === programId && r.roundId === roundId && r.stepId === stepId)
    if (!row) return false
    refresh(row); return row.status === 'pending'
  }
  const cancel = (id) => { const row = rows.get(id); if (!row || terminal.has(row.status)) return false; row.status = 'cancelled'; row.reason = 'cancelled-by-host'; return true }
  const invalidateRound = (roundId) => { for (const row of rows.values()) if (row.roundId === roundId && !terminal.has(row.status)) { row.status = 'invalidated'; row.reason = 'round-failed' } }
  const view = () => { for (const row of rows.values()) refresh(row); return immutableJson([...rows.values()].map((r) => ({ ...r, scopeFresh: verifier.intact() && r.revision === readRevision() }))) }
  return Object.freeze({ define, record, canExecute, cancel, invalidateRound, view })
}
