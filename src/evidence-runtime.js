// 宿主有界控制链：检查 → 动作 → 验收 → 主动诊断 → 联合恢复。没有模型/网络调用。
import crypto from 'node:crypto'
import { assertEvidenceContract, assertEvidenceProgram, createEvidenceProgram, parseEvidenceProposal, bindEvidenceProposal,
  initialEvidenceState, evidenceBinding, advanceEvidenceState, immutableJson } from './evidence-program.js'
import { createEvidenceContext } from './evidence-context.js'
import { createEvidenceVerifier } from './evidence-host.js'
import { archiveEvidenceArtifact, recoverEvidenceBlock } from './evidence-store.js'
import { createEvidenceCheckpoints } from './evidence-checkpoint.js'
import { createDiagnosticController, runActiveEvidenceChecks } from './active-checks.js'
const HOSTS = new WeakSet()

export function createEvidenceRuntime({ contract, sessionId, store, adapter, observe, diagnosticModel = null, archive = null,
  memoryContext = null, allowEdits = false, allowCommands = false, maxRounds = 3, maxRepairRounds = 2, maxChecks = 32,
  roundTimeoutMs = 10000, diagnosticChecks = 2, diagnosticCost = 4, contextOptions = null, diagnosticStrategy = 'active', diagnosticOrder = null }) {
  const c = assertEvidenceContract(contract)
  if (store.sessionId !== sessionId || typeof sessionId !== 'string' || !sessionId || !adapter ||
    ['capture', 'restore', 'revision', 'perform', 'readConditions'].some((k) => typeof adapter[k] !== 'function') ||
    !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3 || !Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 2 ||
    !Number.isInteger(maxChecks) || maxChecks < 0 || maxChecks > 256 || !Number.isInteger(roundTimeoutMs) || roundTimeoutMs < 1 || roundTimeoutMs > 30000 ||
    !['active', 'fixed'].includes(diagnosticStrategy) || diagnosticOrder !== null && (!Array.isArray(diagnosticOrder) || !diagnosticOrder.length || new Set(diagnosticOrder).size !== diagnosticOrder.length || diagnosticOrder.some((id) => c.checks.find((x) => x.id === id)?.role !== 'diagnostic')) || !Number.isInteger(diagnosticChecks) || diagnosticChecks < 0 || diagnosticChecks > 16 || !Number.isFinite(diagnosticCost) || diagnosticCost < 0) throw new Error('runtime-schema')
  let busy = false, rounds = 0, repairs = 0, checks = 0, peak = null, done = false
  const history = [], roundIds = new Set()
  const verifier = createEvidenceVerifier({ contract: c, root: adapter.root, observe, perform: adapter.perform,
    readRevision: adapter.revision, readConditions: adapter.readConditions, allowEdits, allowCommands })
  const checkpoints = createEvidenceCheckpoints({ store, adapter, sessionId, contractDigest: c.digest, authenticate: verifier.authenticate })
  const dashboard = (status, diagnostic = null) => immutableJson({ schema: 'cfb.evidence-view/1', status,
    lastPassed: peak ? { checkpoint: peak.handle, kind: peak.kind, artifact: peak.artifactRef } : null,
    diagnostics: diagnostic?.receipts.map((r) => ({ checkId: r.subjectId, status: r.status })) || [],
    memories: ['rolled-back', 'unresolved'].includes(status) && verifier.intact() && archive && memoryContext ? archive.retrieve(memoryContext) : [],
    next: status === 'verified' ? 'stop' : rounds >= maxRounds ? 'stop-with-unresolved' : 'choose-another-approved-branch' })
  const view = () => immutableJson({ sessionId, contractDigest: c.digest, rounds, repairs, checks, maxRounds, maxRepairRounds, maxChecks,
    busy, done, peak, history })
  if (contextOptions !== null && (typeof contextOptions !== 'object' || Array.isArray(contextOptions))) throw new Error('runtime-context-options')
  const context = contextOptions === null ? null : createEvidenceContext({ ...contextOptions, store, contract: c, verifier, readRevision: adapter.revision, readRuntime: view })
  const finish = (program, result, roundId) => {
    if (context) {
      if (!result.ok) context.intents.invalidateRound(roundId)
      try { context.publish(program, result) } catch { context.reset() } // 交付失败关闭；不伪报执行回滚。
    }
    return immutableJson(result)
  }
  async function runRound(candidate, { roundId = crypto.randomUUID(), raw = candidate?.explanation || '' } = {}) {
    const blocked = (reason) => immutableJson({ ok: false, status: 'blocked', reason, counters: { rounds, repairs, checks } })
    if (busy) return blocked('runtime-busy')
    if (done) return blocked('episode-already-verified')
    if (rounds >= maxRounds) return blocked('round-budget')
    if (typeof roundId !== 'string' || !roundId || roundIds.has(roundId)) return blocked('round-id-reused')
    let program
    try { program = assertEvidenceProgram(candidate, c); if (program.sessionId !== sessionId) return blocked('program-session') }
    catch { return blocked('program-invalid-or-contract-drift') }
    // 第 3 轮（或修复预算已满）只能检查，不让新改动偷占最后的验证轮。
    const hasEdit = program.steps.some((s) => s.action.type !== 'observe')
    if (hasEdit && (rounds >= maxRepairRounds || repairs >= maxRepairRounds)) return blocked('verification-only')
    busy = true; rounds++; roundIds.add(roundId); if (hasEdit) repairs++
    const abort = new AbortController(), deadline = Date.now() + roundTimeoutMs, timer = setTimeout(() => abort.abort(), roundTimeoutMs)
    const expired = () => { if (Date.now() >= deadline) abort.abort(); return abort.signal.aborted }
    let state, artifact, before, lastRevision, diagnostic = null, receipts = [], error = null
    const guardCheck = async (id, binding, opts = {}) => {
      if (checks >= maxChecks) throw new Error('check-budget')
      if (expired()) throw new Error('round-timeout')
      checks++
      const receipt = await verifier.check(id, binding, { ...opts, signal: abort.signal })
      // 同步回调会阻塞 timer；绝对截止须在结果返回后再次检测，不能采纳迟到的 pass。
      if (expired()) throw new Error('round-timeout')
      return receipt
    }
    try {
      try {
        artifact = archiveEvidenceArtifact(store, { raw, program })
        const currentRevision = adapter.revision()
        if (peak && peak.revision !== currentRevision) throw new Error('host-state-changed-since-peak')
        state = initialEvidenceState(program, { roundId, revision: currentRevision })
        // 每轮前存制品+宿主状态。不能写入检查点就不允许任何动作。
        before = checkpoints.take({ artifactRef: peak?.artifactRef || null })
        lastRevision = before.revision
        while (state.status === 'ready') {
          if (expired()) throw new Error('round-timeout')
          const step = program.steps[state.cursor], binding = evidenceBinding(program, state)
          let batch
          if (state.phase === 'preconditions') {
            if (context && step.preconditions.length) context.intents.define({ program, binding, stepId: step.id })
            batch = []
            for (const id of step.preconditions) batch.push(await guardCheck(id, binding))
            const next = advanceEvidenceState(program, state, batch, verifier.authenticate)
            if (next.status === 'ready' && !peak) peak = checkpoints.take({ kind: 'preconditions', artifactRef: null, program, state: next, receipts: batch })
            state = next
          } else if (state.phase === 'action') {
            if (context && step.preconditions.length && !context.intents.canExecute(program.id, roundId, step.id)) throw new Error('obligation-not-ready')
            if (expired()) throw new Error('round-timeout')
            batch = [verifier.action(step.action.id, binding)]
            // 先记录已落地动作的真实终态，再拒绝迟到结果，确保超时也能准确恢复。
            lastRevision = batch[0].nextRevision || adapter.revision()
            if (expired()) throw new Error('round-timeout')
            state = advanceEvidenceState(program, state, batch, verifier.authenticate)
          } else {
            batch = []
            for (const { checkId } of step.expectedObservations) batch.push(await guardCheck(checkId, binding))
            state = advanceEvidenceState(program, state, batch, verifier.authenticate)
            if (state.status === 'ready' || state.status === 'verified') peak = checkpoints.take({ kind: 'verified-step', artifactRef: artifact.indexRef, program, state, receipts: batch })
          }
          if (context) context.intents.record(batch)
          receipts.push(...batch)
          if (state.status === 'ready' || state.status === 'verified') lastRevision = state.revision
        }
        if (state.status === 'verified') {
          if (expired()) throw new Error('round-timeout')
          const result = { ok: true, status: 'verified', reason: 'all-steps-verified', artifactRef: artifact.indexRef, checkpoint: peak.handle,
            state, receipts, counters: { rounds, repairs, checks }, modelView: dashboard('verified') }
          const resultRef = store.putJson(result, { kind: 'round' })
          history.push({ roundId, programId: program.id, status: 'verified', resultRef }); done = true
          return finish(program, result, roundId)
        }
        error = state.reason || 'check-not-passed'
      } catch (e) { error = e.message || 'runtime-error' }

      try {
        if (before && state && diagnosticModel && checks < maxChecks && !abort.signal.aborted) {
          const controller = createDiagnosticController({ model: diagnosticModel, contract: c, maxChecks: Math.min(diagnosticChecks, maxChecks - checks), maxCost: diagnosticCost, strategy: diagnosticStrategy, checkOrder: diagnosticOrder })
          diagnostic = await runActiveEvidenceChecks({ controller, verifier: { ...verifier, check: guardCheck }, binding: evidenceBinding(program, state), signal: abort.signal })
        }
      } catch (e) { diagnostic = { receipts: [], error: e.message } }
      let restored = null, status = 'blocked', recoveryError = null
      try {
        if (before) { restored = checkpoints.restore((peak || before).handle, lastRevision); status = 'rolled-back' }
      } catch (e) { recoveryError = e.message; status = e.message === 'rollback-conflict' ? 'conflict' : 'recovery-failed' }
      try {
        const result = { ok: false, status, reason: error, recoveryError, artifactRef: artifact?.indexRef || null,
          checkpoint: (peak || before)?.handle || null, restored, state: state || null, receipts, diagnostic,
          counters: { rounds, repairs, checks }, modelView: dashboard(status, diagnostic) }
        // 错误稿与完整回执留在块仓；模型视图只有状态/通过检查点/诊断二元事实，不含失败正文。
        const resultRef = store.putJson(result, { kind: 'round' })
        history.push({ roundId, programId: program.id, status, resultRef })
        return finish(program, result, roundId)
      } catch { return immutableJson({ ...blocked('result-archive-failed'), failureReason: error, recoveryError }) }
    } finally { clearTimeout(timer); busy = false }
  }
  return Object.freeze({ runRound, view, modelView: () => dashboard(done ? 'verified' : 'unresolved'),
    contextView: () => context?.view() || null,
    modelInput: (options) => context ? context.render(options) : immutableJson({ ok: false, reason: 'context-disabled', prefix: null, layers: [] }),
    readBlock: (...args) => context ? context.readBlock(...args) : immutableJson({ ok: false, reason: 'context-disabled' }),
    cancelObligation: (id) => context?.intents.cancel(id) || false,
    publishDraft: (artifactRef) => {
      if (!context) return false
      try { const index = store.getJson(artifactRef, { kind: 'index' }); context.publish(store.getJson(index.programRef, { kind: 'program' }), { ok: false, status: 'proposed', artifactRef, receipts: [] }); return true }
      catch { context.reset(); return false }
    },
    program: (explanation, actionIds) => createEvidenceProgram(explanation, { contract: c, actionIds, sessionId }) })
}
/** DSH 只发布侧车，不替宿主捏造工具拦截/环境恢复能力。显式 runLatest 才进入新控制链。 */
export function createEvidenceHost(options) {
  const contract = assertEvidenceContract(options.contract), runtime = createEvidenceRuntime(options), { sessionId, store } = options
  const published = new Map()
  const captureDraft = ({ raw, text, sessionId: owner, index = 0, ctx = '', calls = [], complete = true }) => {
    if (owner !== sessionId || typeof raw !== 'string' || typeof text !== 'string') throw new Error('draft-session')
    // 新制品先撤销同索引旧授权；归档失败不能让 runLatest 执行上次的候选。
    published.delete(index)
    const rawRef = store.put(raw, { kind: 'raw' }), explanationRef = store.put(text, { kind: 'explanation' })
    const proposal = parseEvidenceProposal(text, { ctx, calls })
    const bound = complete ? bindEvidenceProposal(proposal, contract, sessionId) : { ok: false, reason: 'incomplete-artifact' }
    const item = bound.ok ? { index, authorized: true, ...archiveEvidenceArtifact(store, { raw, program: bound.program }) } :
      { index, authorized: false, reason: bound.reason, rawRef, explanationRef, proposalRef: store.putJson(proposal, { kind: 'proposal' }) }
    published.set(index, immutableJson(item))
    if (item.authorized) runtime.publishDraft(item.indexRef)
    if (published.size > 32) published.delete(published.keys().next().value)
    return immutableJson({ index, authorized: item.authorized, ...(item.authorized ? { artifactRef: item.indexRef, programRef: item.programRef } : { reason: item.reason }) })
  }
  const host = Object.freeze({ schema: 'cfb.evidence-host/1', sessionId, runtime, captureDraft,
    latest: () => immutableJson([...published.values()]),
    runLatest: async (index) => {
      const item = published.get(index)
      if (!item?.authorized) return immutableJson({ ok: false, status: 'blocked', reason: 'no-authorized-draft' })
      return runtime.runRound(store.getJson(item.programRef, { kind: 'program' }), { raw: recoverEvidenceBlock(store, item.indexRef, 'raw') })
    } })
  HOSTS.add(host); return host
}
export const isEvidenceHost = (value) => !!value && HOSTS.has(value)
