// 共用本地worker协调器v2；未知不变成功，ACK前持久预占，完整见证后才恢复。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { immutableJson, evidenceDigest } from '../../src/evidence-program.js'
import { assertOfflineNamespace } from '../verify-offline.mjs'
import { isTrainingApproval } from './training-governance.mjs'
import { assertTrainingPlan, TRAIN_ROOT } from './training-plan.mjs'
import { auditTrainingDataset } from './training-data.mjs'
import { openTrainingState } from './training-state.mjs'
import { privateTrainingPath } from './training-io.mjs'
import { assertSafePath, readJson, writeJson } from './eval-files.mjs'
import { LOCAL_WORKER_PROTOCOL, localTrainingGoal, localHostIdentity, localProcessIdentity, certifyLocalCheckpoint, inspectCertifiedCheckpoint } from './training-local-checkpoint.mjs'
const ADAPTERS = new WeakSet()
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k))), PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1' })
export function productionLocalWorkerAdapter() {
  const adapter = Object.freeze({ fixture: false, launch({ planFile, output, attemptId, resume }) {
    const args = [path.join(TRAIN_ROOT, 'training/lora_trainer.py'), '--plan', planFile, '--execute', '--operator-approved', '--supervised', '--attempt-id', attemptId, '--output', output]
    if (resume) args.push('--resume', resume)
    return spawn('python3', args, { cwd: TRAIN_ROOT, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
  } }); ADAPTERS.add(adapter); return adapter
}
/** 只允许真实断网namespace中的fixture；不能让fixture跳过真实计划的训练前置。 */
export function offlineLocalWorkerAdapter({ fault = 'healthy' } = {}) {
  assertOfflineNamespace()
  if (!['healthy', 'crash-after-uncheckpointed-step', 'crash-before-checkpoint', 'crash-after-checkpoint', 'foreign-checkpoint', 'no-ack-step'].includes(fault)) throw new Error('training-fixture-fault')
  const adapter = Object.freeze({ fixture: true, launch({ planFile, output, attemptId, resume }) {
    assertOfflineNamespace(); const args = [path.join(TRAIN_ROOT, 'test/fixtures/local-training-worker.py'), '--plan', planFile, '--output', output, '--attempt-id', attemptId, '--fault', fault]
    if (resume) args.push('--resume', resume)
    return spawn('python3', args, { cwd: TRAIN_ROOT, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
  } }); ADAPTERS.add(adapter); return adapter
}
export async function coordinateLocalTraining({ plan, reviews, approval, directory, markerPath, planFile, adapter, execute = false, resume = null, signal = null, stopAfter = null, onProgress = () => {} }) {
  assertTrainingPlan(plan)
  if (!execute || !ADAPTERS.has(adapter) || !isTrainingApproval(approval) || approval.planDigest !== plan.digest || plan.profile.backend !== 'local-lora' || plan.simulated !== adapter.fixture || approval.mode !== (adapter.fixture ? 'fixture' : 'local-compute')) throw new Error('training-local-compute-approval-required')
  const audit = await auditTrainingDataset({ directory: plan.executionPaths?.datasetDirectory || plan.dataset.directory, reviews })
  if (audit.datasetDigest !== plan.dataset.digest) throw new Error('training-dataset-plan-drift')
  if (signal?.aborted) throw new Error('training-aborted-before-worker')
  privateTrainingPath(directory, { directory: true, createParents: true })
  const session = openTrainingState({ directory, markerPath, plan, scope: approval.id }), old = session.read(), goal = localTrainingGoal(plan)
  if (old.phase === 'candidate') {
    const proof = await inspectCertifiedCheckpoint({ session, plan, jobDirectory: directory, ref: old.latestCheckpointRef })
    if (old.candidate.checkpointRef !== proof.ref) throw new Error('training-candidate-artifact-drift')
    return immutableJson({ cached: true, candidate: old.candidate, computeSteps: old.steps, trainedStep: old.trainedStep })
  }
  if (old.pending || ['unknown', 'recoverable', 'failed', 'running'].includes(old.phase)) throw new Error('training-local-reconciliation-required')
  let previous = null
  if (old.latestCheckpointRef) {
    previous = await inspectCertifiedCheckpoint({ session, plan, jobDirectory: directory, ref: old.latestCheckpointRef })
    if (resume && path.resolve(resume) !== path.resolve(previous.directory)) throw new Error('training-resume-not-certified-latest')
    if ((old.trainedStep || 0) !== previous.step) throw new Error('training-resume-logical-step-mismatch')
  } else if (resume || (old.trainedStep || 0) > 0) throw new Error('training-checkpoint-unverified')
  if (old.steps >= plan.profile.limits.maxComputeSteps) throw new Error('training-compute-budget-exhausted')
  const elapsedBase = old.elapsedMs || 0, remainingMs = plan.profile.limits.maxWallSeconds * 1000 - elapsedBase
  if (remainingMs <= 0) throw new Error('training-wall-budget')
  const attemptId = crypto.randomUUID(), output = path.join(directory, 'adapter', attemptId), leasePath = path.join(directory, '.local-worker.lock')
  let lease
  try { lease = fs.openSync(leasePath, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') throw new Error('training-local-worker-lease'); throw e }
  const start = performance.now(); let child, hello = false, paused = false, candidateEvent = false, protocolError = null, stopRequested = false, processed = 0, totalBytes = 0, buffer = '', serial = Promise.resolve(), killer = null, timer = null
  const elapsed = () => Math.max(0, Math.floor(elapsedBase + performance.now() - start))
  const elapsedPatch = (s) => ({ ...s, elapsedMs: Math.max(s.elapsedMs || 0, elapsed()) })
  const send = (action, e = {}) => { if (child?.stdin.writable) child.stdin.write(JSON.stringify({ action, attemptId, step: e.step ?? null }) + '\n') }
  const terminate = () => { stopRequested = true; if (child && !killer) { child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000) } }
  const safeError = (e) => /^training-[a-z0-9-]+$/.test(e?.message || '') ? e.message : 'training-worker-protocol-error'
  try {
    fs.writeSync(lease, JSON.stringify({ attemptId, hostIdentity: localHostIdentity() })); fs.fsyncSync(lease)
    session.update((s) => ({ ...elapsedPatch(s), phase: 'running', pending: { type: 'local-worker', attemptId }, localAttempts: [...(s.localAttempts || []), { id: attemptId, hostIdentity: localHostIdentity(), exitConfirmed: false, status: 'launching' }].slice(-128) }))
    child = adapter.launch({ planFile, output, attemptId, resume: previous?.directory || null })
    session.update((s) => ({ ...s, localAttempts: s.localAttempts.map((a) => a.id === attemptId ? { ...a, process: localProcessIdentity(child.pid), status: 'running' } : a) }))
    child.stdin.on('error', () => {})
    const event = async (e) => {
      if (!e || e.protocol !== LOCAL_WORKER_PROTOCOL || e.attemptId !== attemptId || typeof e.event !== 'string') throw new Error('training-worker-event-binding')
      if (e.event === 'hello') {
        if (hello || e.planDigest !== plan.digest || e.resumedStep !== (previous?.step || 0) || e.goalStep !== goal.steps) throw new Error('training-worker-hello')
        hello = true; send(stopRequested ? 'pause' : 'continue'); return
      }
      if (!hello) throw new Error('training-worker-not-handshaken')
      const state = session.read()
      if (e.event === 'step-ready') {
        if (!Number.isInteger(e.step) || e.step !== (state.trainedStep || 0) + 1 || e.step > goal.steps || state.pending?.type === 'gradient-step') throw new Error('training-worker-step-order')
        if (stopRequested || state.steps >= plan.profile.limits.maxComputeSteps || elapsed() >= plan.profile.limits.maxWallSeconds * 1000 || stopAfter !== null && processed >= stopAfter) { stopRequested = true; send('pause', e); return }
        session.update((s) => ({ ...elapsedPatch(s), steps: s.steps + 1, phase: 'running', pending: { type: 'gradient-step', attemptId, logicalStep: e.step } }))
        send('continue', e); return
      }
      if (e.event === 'step') {
        if (!Number.isInteger(e.step) || !Number.isFinite(e.loss) || state.pending?.type !== 'gradient-step' || state.pending.attemptId !== attemptId || state.pending.logicalStep !== e.step) throw new Error('training-worker-step-not-authorized')
        session.update((s) => ({ ...elapsedPatch(s), trainedStep: e.step, cursor: Math.min(e.step * plan.profile.recipe.gradientAccumulation, goal.batches), pending: { type: 'local-worker', attemptId } }))
        processed++; onProgress({ attemptId, step: e.step, computeSteps: session.read().steps, loss: e.loss, simulated: adapter.fixture }); return
      }
      if (e.event === 'checkpoint') {
        if (state.pending?.type === 'gradient-step' || e.step !== state.trainedStep || typeof e.directory !== 'string') throw new Error('training-worker-checkpoint-order')
        const absolute = assertSafePath(e.directory, { directory: true }), rel = path.relative(path.resolve(output), absolute)
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('training-checkpoint-outside-attempt')
        const ref = await certifyLocalCheckpoint({ session, plan, jobDirectory: directory, directory: absolute, attemptId, step: e.step, cursor: e.cursor, fixture: adapter.fixture })
        session.update((s) => ({ ...elapsedPatch(s), latestCheckpointRef: ref, localCheckpointRefs: [...new Set([...(s.localCheckpointRefs || []), ref])].slice(-128) }))
        send('continue', e); return
      }
      if (e.event === 'paused') { if (!stopRequested || e.step !== state.trainedStep || state.pending?.type === 'gradient-step') throw new Error('training-worker-pause-unconfirmed'); paused = true; return }
      if (e.event === 'candidate') { if (state.trainedStep !== goal.steps || e.step !== goal.steps || e.testRead !== false || !state.latestCheckpointRef || state.pending?.type === 'gradient-step') throw new Error('training-worker-candidate-unverified'); candidateEvent = true; return }
      if (e.event === 'error') throw new Error('training-worker-reported-error')
      throw new Error('training-worker-event-unsupported')
    }
    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length; buffer += chunk.toString('utf8')
      if (totalBytes > Math.max(4 * 1024 * 1024, goal.steps * 512) || buffer.length > 65536) { protocolError = 'training-worker-output-budget'; terminate(); return }
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        serial = serial.then(async () => { if (protocolError) return; let e; try { e = JSON.parse(line) } catch { throw new Error('training-worker-event-json') } await event(e) }).catch((e) => { protocolError ||= safeError(e); terminate() })
      }
    })
    child.stderr.on('data', () => {})
    const done = new Promise((resolve) => { child.once('error', () => resolve({ code: -1, signal: null })); child.once('close', (code, sig) => resolve({ code, signal: sig })) })
    timer = setTimeout(terminate, remainingMs); signal?.addEventListener('abort', terminate, { once: true }); if (signal?.aborted) terminate()
    const exit = await done; await serial
    if (buffer.trim()) protocolError ||= 'training-worker-incomplete-event'
    const exitRef = session.store.putJson({ schema: 'cfb.local-worker-exit/1', planDigest: plan.digest, attemptId, hostIdentity: localHostIdentity(), process: localProcessIdentity(child.pid), code: exit.code, signal: exit.signal, managedClose: true }, { kind: 'local-worker-exit' })
    session.update((s) => ({ ...elapsedPatch(s), localAttempts: s.localAttempts.map((a) => a.id === attemptId ? { ...a, exitConfirmed: true, exitRef, status: 'exited' } : a) }))
    let proof = null
    if (session.read().latestCheckpointRef) proof = await inspectCertifiedCheckpoint({ session, plan, jobDirectory: directory, ref: session.read().latestCheckpointRef })
    if (exit.code === 0 && !protocolError && candidateEvent && proof?.step === goal.steps) {
      const body = { schema: 'cfb.trained-candidate/1', backend: 'local-lora', simulated: adapter.fixture, modelDirectory: proof.directory, planDigest: plan.digest,
        datasetDigest: plan.dataset.digest, steps: proof.step, computeSteps: session.read().steps, checkpointRef: proof.ref, artifact: proof.artifact, independentEvaluationPassed: false, productionActivated: false }
      const candidate = { ...body, digest: evidenceDigest(body) }
      session.update((s) => ({ ...s, phase: 'candidate', pending: null, candidate })); writeJson(path.join(directory, 'candidate.json'), candidate)
      return immutableJson({ cached: false, candidate, computeSteps: session.read().steps, trainedStep: proof.step })
    }
    if (exit.code === 0 && !protocolError && paused && proof?.step === session.read().trainedStep) {
      session.update((s) => ({ ...s, phase: 'paused', pending: null }))
      return immutableJson({ paused: true, checkpointRef: proof.ref, trainedStep: proof.step, computeSteps: session.read().steps, modelSuccessClaimed: false })
    }
    const reason = protocolError || 'training-worker-interrupted', recoverable = !!proof
    session.update((s) => ({ ...s, phase: recoverable ? 'recoverable' : 'unknown', pending: { type: 'local-worker-interrupted', attemptId, reason }, lastWorkerError: reason }))
    return immutableJson({ interrupted: true, phase: recoverable ? 'recoverable' : 'unknown', checkpointRef: proof?.ref || null, trainedStep: session.read().trainedStep, computeSteps: session.read().steps, reason, modelSuccessClaimed: false })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { const kill = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000); child.once('close', () => { clearTimeout(kill); resolve() }); child.kill('SIGTERM') })
    }
    if (timer) clearTimeout(timer); if (killer) clearTimeout(killer); signal?.removeEventListener('abort', terminate)
    try { fs.closeSync(lease) } finally { fs.unlinkSync(leasePath) }
  }
}
