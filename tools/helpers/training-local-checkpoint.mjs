// 本地worker恢复见证：完整checkpoint与进程退出分别证明，不能以文件名/unknown当成功。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { assertTrainingPlan } from './training-plan.mjs'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { assertSafePath, readJson } from './eval-files.mjs'
export const LOCAL_WORKER_PROTOCOL = 'cfb.local-training-worker/2'
export function localTrainingGoal(plan) {
  const batches = Math.ceil(plan.dataset.counts.train / plan.profile.recipe.batchSize) * plan.profile.recipe.epochs
  return { batches, steps: Math.min(plan.profile.recipe.maxSteps, Math.ceil(batches / plan.profile.recipe.gradientAccumulation)) }
}
export function localHostIdentity() {
  let boot = 'unavailable'; try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch {}
  return crypto.createHash('sha256').update(os.platform() + ':' + os.hostname() + ':' + boot).digest('hex')
}
export function localProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null
  try { const t = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return { pid, startToken: t.slice(t.lastIndexOf(')') + 2).trim().split(/\s+/)[19], hostIdentity: localHostIdentity() } }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw new Error('training-process-identity-unavailable') }
}
export function assertWorkerStopped(attempt, { attestForeignExit = null } = {}) {
  if (attempt?.exitConfirmed === true) return { kind: 'managed-child-exit', attemptId: attempt.id }
  if (!attempt?.process || !attempt.id) throw new Error('training-worker-exit-unverified')
  if (attempt.process.hostIdentity !== localHostIdentity()) {
    if (typeof attestForeignExit !== 'function' || attestForeignExit(attempt) !== true) throw new Error('training-foreign-worker-exit-unverified')
    return { kind: 'operator-attested-foreign-exit', attemptId: attempt.id }
  }
  const current = localProcessIdentity(attempt.process.pid)
  if (current && (!attempt.process.startToken || current.startToken === attempt.process.startToken)) throw new Error('training-worker-still-alive')
  return { kind: current ? 'pid-reused-old-worker-gone' : 'local-worker-gone', attemptId: attempt.id }
}
function relativeCheckpoint(root, directory) {
  const absolute = assertSafePath(directory, { directory: true }), rel = path.relative(path.resolve(root), absolute)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => !s || ['.git', '.secrets'].includes(s))) throw new Error('training-checkpoint-outside-job')
  return rel.split(path.sep).join('/')
}
export async function fingerprintLocalCheckpoint(directory) {
  const root = assertSafePath(directory, { directory: true }), files = {}; let total = 0
  const names = fs.readdirSync(root).sort()
  if (names.length > 128) throw new Error('training-checkpoint-file-budget')
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+\.(?:json|pt|safetensors|model|txt|jinja|tiktoken|md)$/.test(name)) throw new Error('training-checkpoint-unexpected-file')
    const file = assertSafePath(path.join(root, name)), before = fs.statSync(file), hash = crypto.createHash('sha256')
    if (!before.isFile()) throw new Error('training-checkpoint-file-type')
    total += before.size; if (!Number.isSafeInteger(total) || total > 64 * 1024 ** 3) throw new Error('training-checkpoint-byte-budget')
    for await (const b of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) hash.update(b)
    const after = fs.statSync(file)
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('training-checkpoint-changed')
    files[name] = { bytes: before.size, sha256: hash.digest('hex') }
  }
  if (['adapter_model.safetensors', 'adapter_config.json', 'optimizer.pt', 'trainer_state.json'].some((s) => !files[s])) throw new Error('training-checkpoint-incomplete')
  return immutableJson({ files, bytes: total, digest: evidenceDigest(files) })
}
export async function certifyLocalCheckpoint({ session, plan, jobDirectory, directory, attemptId, step, cursor, fixture = false }) {
  const relative = relativeCheckpoint(jobDirectory, directory), m = readJson(path.join(directory, 'trainer_state.json')), goal = localTrainingGoal(plan), state = session.read()
  if (m.schema !== 'cfb.lora-checkpoint/2' || m.protocol !== LOCAL_WORKER_PROTOCOL || m.planDigest !== plan.digest || m.datasetDigest !== plan.dataset.digest || m.sourceDigest !== plan.sourceDigest || m.attemptId !== attemptId || m.step !== step || m.cursor !== cursor || m.testRead !== false || m.candidateOnly !== true || m.simulated !== fixture || !Number.isInteger(step) || step < 0 || step > goal.steps || cursor !== Math.min(step * plan.profile.recipe.gradientAccumulation, goal.batches) || (state.trainedStep || 0) !== step) throw new Error('training-checkpoint-binding')
  const artifact = await fingerprintLocalCheckpoint(directory)
  const body = { schema: 'cfb.local-checkpoint-witness/1', protocol: LOCAL_WORKER_PROTOCOL, planDigest: plan.digest, datasetDigest: plan.dataset.digest,
    sourceDigest: plan.sourceDigest, attemptId, relativeDirectory: relative, step, cursor, computeSteps: state.steps, elapsedMs: state.elapsedMs || 0, simulated: fixture, artifact }
  return session.store.putJson(body, { kind: 'local-checkpoint' })
}
export async function inspectCertifiedCheckpoint({ session, plan, jobDirectory, ref }) {
  const state = session.read()
  if (!ref || !(state.localCheckpointRefs || []).includes(ref)) throw new Error('training-checkpoint-unverified')
  const proof = session.store.getJson(ref, { kind: 'local-checkpoint' })
  if (proof.schema !== 'cfb.local-checkpoint-witness/1' || proof.planDigest !== plan.digest || proof.datasetDigest !== plan.dataset.digest || proof.sourceDigest !== plan.sourceDigest || proof.computeSteps > state.steps) throw new Error('training-checkpoint-witness-binding')
  const directory = path.join(path.resolve(jobDirectory), ...proof.relativeDirectory.split('/'))
  relativeCheckpoint(jobDirectory, directory)
  const actual = await fingerprintLocalCheckpoint(directory)
  if (actual.digest !== proof.artifact.digest) throw new Error('training-checkpoint-artifact-drift')
  return immutableJson({ ...proof, directory, ref })
}
export async function reconcileLocalTraining({ session, plan, directory, checkpointRef = null, attestForeignExit = null }) {
  assertTrainingPlan(plan)
  const state = session.read(), attempt = state.localAttempts?.at(-1)
  if (!['recoverable', 'unknown', 'running', 'paused'].includes(state.phase) || state.pending?.type === 'http') throw new Error('training-local-reconciliation-state')
  const exit = assertWorkerStopped(attempt, { attestForeignExit }), checkpoint = await inspectCertifiedCheckpoint({ session, plan, jobDirectory: directory, ref: checkpointRef || state.latestCheckpointRef })
  if (checkpoint.simulated !== plan.simulated) throw new Error('training-recovery-simulation-binding')
  const recoveryRef = session.store.putJson({ schema: 'cfb.local-recovery/1', planDigest: plan.digest, attemptId: attempt.id, checkpointRef: checkpoint.ref,
    exit, computeStepsRetained: state.steps, elapsedMsRetained: state.elapsedMs || 0, restoredLogicalStep: checkpoint.step }, { kind: 'local-recovery' })
  const leasePath = path.join(directory, '.local-worker.lock')
  if (fs.existsSync(leasePath)) { const lease = readJson(leasePath); if (lease.attemptId !== attempt.id) throw new Error('training-local-worker-lease-binding'); fs.unlinkSync(leasePath) }
  session.update((s) => ({ ...s, phase: 'paused', pending: null, trainedStep: checkpoint.step, cursor: checkpoint.cursor, recoveryRef, latestCheckpointRef: checkpoint.ref,
    localAttempts: s.localAttempts.map((a) => a.id === attempt.id ? { ...a, exitConfirmed: true, recoveryRef } : a) }))
  return { reconciled: true, phase: 'paused', checkpointRef: checkpoint.ref, restoredLogicalStep: checkpoint.step, computeStepsRetained: state.steps, elapsedMsRetained: state.elapsedMs || 0, modelSuccessClaimed: false }
}
