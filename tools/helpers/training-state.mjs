// 训练作业双平面CAS：丢仓/回滚不变成新预算；不保存API钥匙或语料正文到公开水位。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createEvidenceStore } from '../../src/evidence-store.js'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { privateTrainingPath } from './training-io.mjs'
import { readJson, writeJson, assertSafePath, syncDirectory } from './eval-files.mjs'
const PHASES = new Set(['prepared', 'running', 'paused', 'candidate', 'failed', 'unknown', 'cancelled'])
export function openTrainingState({ directory, markerPath, plan, scope, initialize = true }) {
  privateTrainingPath(directory, { directory: true })
  assertSafePath(markerPath)
  const sid = 'cfb.training-session/1:' + scope, ns = crypto.createHash('sha256').update(sid).digest('hex'), home = path.join(path.resolve(directory), ns)
  let marker = null; try { marker = readJson(markerPath, 65536) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (marker && (!fs.existsSync(path.join(home, '.head-training-session.json')) || !fs.existsSync(path.join(home, 'authority.key')))) throw new Error('training-state-restore-required')
  if (!initialize && !marker && !fs.existsSync(path.join(home, '.head-training-session.json'))) return null
  const store = createEvidenceStore({ directory, sessionId: sid, maxBlobBytes: 8 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 })
  const projection = (head, state) => {
    const body = { schema: 'cfb.training-watermark/1', scope, planDigest: plan.digest, authorityId: store.authorityId, sequence: head.sequence, revision: head.revision,
      phase: state.phase, steps: state.steps, httpRequests: state.http.length, pending: state.pending, candidateDigest: state.candidate?.digest || null }
    return { ...body, digest: evidenceDigest(body) }
  }
  const read = () => {
    const head = store.readHead('training-session')
    if (!head) return { head, state: { schema: 'cfb.training-state/1', scope, planDigest: plan.digest, phase: 'prepared', steps: 0, pending: null, http: [], candidate: null, cursor: 0, rng: plan.profile.recipe.seed, weightsRef: null } }
    const state = store.getJson(head.ref, { kind: 'training-state' }), publicState = readJson(markerPath, 65536)
    const { digest, ...publicBody } = publicState
    if (state.planDigest !== plan.digest || state.scope !== scope || !PHASES.has(state.phase) || digest !== projection(head, state).digest || evidenceDigest(publicBody) !== digest) throw new Error('training-state-watermark-conflict')
    return { head, state }
  }
  const save = (head, state, initial = false) => {
    if (!PHASES.has(state.phase) || !Number.isSafeInteger(state.steps) || state.steps < 0 || state.steps > plan.profile.recipe.maxSteps || !Array.isArray(state.http) || state.http.length > plan.profile.limits.maxHttpRequests) throw new Error('training-state-budget')
    const next = store.setHead('training-session', store.putJson(state, { kind: 'training-state' }), { expectedRevision: head?.revision || null })
    syncDirectory(store.directory); writeJson(markerPath, projection(next, state), { exclusive: initial }); return next
  }
  const first = store.readHead('training-session')
  if (!first) { if (marker) throw new Error('training-state-restore-required'); save(null, read().state, true) }
  read()
  const update = (fn) => { const { head, state } = read(), next = fn(state); if (!next || typeof next.then === 'function' || next.steps < state.steps || next.http.length < state.http.length) throw new Error('training-state-update'); save(head, next); return immutableJson(next) }
  return Object.freeze({ store, read: () => read().state, update, markerPath })
}
