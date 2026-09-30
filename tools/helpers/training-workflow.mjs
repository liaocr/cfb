// 训练生命周期：离线数据/配方/doctor；实际训练必须显式批准，完成不自动上线。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createEvidenceStore } from '../../src/evidence-store.js'
import { privateTrainingPath, fingerprintModelCache } from './training-io.mjs'
import { normalizeTrainingExample } from '../../src/training-core.js'
import { readJson, writeJson, assertSafePath } from './eval-files.mjs'
import { createTrainingReviews, auditTrainingDataset } from './training-data.mjs'
import { assertTrainingPlan, TRAIN_ROOT, trainingDatasetPath, trainingModelPath } from './training-plan.mjs'
import { trainReferenceModel } from './training-reference.mjs'
import { createTrainingGovernance, isTrainingApproval } from './training-governance.mjs'
import { runRemoteTraining, remoteTrainingPreflight } from './training-remote.mjs'
import { coordinateLocalTraining, productionLocalWorkerAdapter } from './training-local-worker.mjs'
import { openTrainingState } from './training-state.mjs'
import { buildCompressPromptV4Direct, buildCompressCtx, turnCallsBlock } from '../../index.js'
import { callsOf } from '../effect-mr.mjs'
import { mrMessages } from '../compile-mr.mjs'
import crypto from 'node:crypto'
export function openTrainingAuthorities(home, { authorize = null, verifyReview = null, authenticateEvaluation = null } = {}) {
  const root = privateTrainingPath(home, { directory: true }), store = createEvidenceStore({ directory: path.join(root, 'authority'), sessionId: 'cfb.training-host-authority/1', maxBlobBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 })
  return { store, reviews: createTrainingReviews({ store, verify: verifyReview }), governance: createTrainingGovernance({ store, authorize, authenticateEvaluation }) }
}
export function importHistoricalTrainingCandidates(file) {
  const chains = readJson(path.join(TRAIN_ROOT, 'transfer/mr/chains.json')).chains, d1 = readJson(path.join(TRAIN_ROOT, 'transfer/direct-d9a-r.json')).rows, d2 = readJson(path.join(TRAIN_ROOT, 'transfer/mr/auto-d2d.json')).rows
  const rows = []
  for (const c of chains) {
    const a = d1.find((r) => r.id === c.id && typeof r.side === 'string'), b = d2.find((r) => r.id === c.id && typeof r.side === 'string')
    for (const round of [1, 2]) {
      const prior = round === 1 ? a : b, raw = round === 1 ? c.a1.raw : c.a2.raw
      if (!prior?.side || !raw) continue
      const ctx = round === 1 ? '' : buildCompressCtx(mrMessages(c, a?.text || c.a1.raw)) + '\n\n' + turnCallsBlock(callsOf(c.a2.content))
      // 严格生产边界：完整生产prompt→原始完整side；不是从说明稿抽句或添原文尾巴。
      rows.push(normalizeTrainingExample({ schema: 'cfb.training-example/1', uid: c.id + '-round-' + round, family: c.id, lineage: c.id, objective: 'sft',
        source: { kind: 'historical', id: 'transfer-mr-' + c.id, sha256: crypto.createHash('sha256').update(raw + '\0' + prior.side).digest('hex'), trainingAllowed: false, license: '' },
        messages: [{ role: 'user', content: buildCompressPromptV4Direct(raw, ctx) }], target: prior.side }))
    }
  }
  privateTrainingPath(file, { createParents: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  return { schema: 'cfb.historical-training-import/1', candidates: rows.length, trainingApproved: 0, status: 'quarantine-candidates-only', externalApiCalls: 0 }
}
const cleanEnvironment = () => Object.assign({ PYTHONDONTWRITEBYTECODE: '1' }, Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k))))
export async function doctorTraining({ plan, reviews, approval = null, env = {} }) {
  const checks = [], check = (id, pass) => checks.push({ id, status: pass ? 'pass' : 'blocked' })
  try { assertTrainingPlan(plan); check('immutable-plan-source', true) } catch { check('immutable-plan-source', false) }
  try { const a = await auditTrainingDataset({ directory: trainingDatasetPath(plan), reviews }); check('dataset-reviews-and-leakage', a.datasetDigest === plan.dataset.digest) } catch { check('dataset-reviews-and-leakage', false) }
  let worker = null
  if (plan.profile.backend === 'reference-byte') check('reference-fixture-only', plan.simulated && plan.dataset.objective === 'sft')
  else {
    check('not-simulated-real-training', !plan.simulated)
    check('separate-training-approval', isTrainingApproval(approval) && approval.planDigest === plan.digest)
    if (plan.profile.backend === 'local-lora') {
      const cache = await fingerprintModelCache(trainingModelPath(plan))
      check('base-model-cache-pinned', !!cache && cache.digest === plan.baseModelCache?.digest)
      const temp = path.join(os.tmpdir(), '.cfb-worker-doctor-' + crypto.randomUUID() + '.json')
      try {
        writeJson(temp, plan, { exclusive: true })
        const r = spawnSync('python3', [path.join(TRAIN_ROOT, 'training/lora_trainer.py'), '--plan', temp, '--doctor'], { encoding: 'utf8', timeout: 15000, env: cleanEnvironment() })
        try { worker = JSON.parse(r.stdout) } catch { worker = null }
        check('local-dependencies-and-model-cache', r.status === 0 && worker?.canExecute === true)
      } finally { fs.unlinkSync(temp) }
    } else {
      try { remoteTrainingPreflight(plan, { approvedMaxUsd: approval?.maxUsd }); check('provider-training-capability-and-price', true) } catch { check('provider-training-capability-and-price', false) }
      const ref = plan.profile.provider?.apiKeyEnv
      check('training-key-present', typeof ref === 'string' && !/^GITHUB_|^GH_/.test(ref) && typeof env[ref] === 'string' && !!env[ref].trim())
    }
  }
  return { schema: 'cfb.training-doctor/1', status: checks.every((c) => c.status === 'pass') ? 'training-preflight-ready' : 'blocked', backend: plan.profile.backend, checks, worker, networkTouched: false, actualTrainingVerified: plan.profile.backend === 'reference-byte' ? 'test-model-only' : false }
}
export async function executeLocalLoRA({ plan, reviews, approval, directory, markerPath, planFile, resume = null, execute = false, signal = null }) {
  if (!execute || !isTrainingApproval(approval) || approval.mode !== 'local-compute' || approval.planDigest !== plan.digest) throw new Error('training-local-compute-approval-required')
  const d = await doctorTraining({ plan, reviews, approval }); if (d.status !== 'training-preflight-ready') throw new Error('training-local-preflight-blocked')
  return coordinateLocalTraining({ plan, reviews, approval, directory, markerPath, planFile, resume, execute, signal, adapter: productionLocalWorkerAdapter() })
}
export async function runTraining({ plan, reviews, governance, approvalRef, directory, markerPath, planFile, execute = false, live = false, env = {}, signal = null, resume = null, cancel = false }) {
  assertTrainingPlan(plan)
  if (!execute) throw new Error('training-explicit-execute-required')
  if (plan.profile.backend === 'reference-byte') return trainReferenceModel({ plan, reviews, directory, markerPath, signal })
  const approval = governance.openApproval(approvalRef, plan)
  if (plan.profile.backend === 'local-lora') return executeLocalLoRA({ plan, reviews, approval, directory, markerPath, planFile, resume, execute, signal })
  if (!live) throw new Error('training-explicit-live-required')
  const doctor = await doctorTraining({ plan, reviews, approval, env }); if (doctor.status !== 'training-preflight-ready') throw new Error('training-preflight-blocked')
  return runRemoteTraining({ plan, reviews, approval, directory, markerPath, apiKey: env[plan.profile.provider.apiKeyEnv], live, signal, cancel })
}
