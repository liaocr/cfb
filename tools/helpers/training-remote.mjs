// 可选files/fine_tuning/jobs适配器。API兼容推理不等于支持微调；不调用时不读任何钥匙。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isTrainingApproval } from './training-governance.mjs'
import { assertTrainingPlan, trainingDatasetPath, trainingModelPath } from './training-plan.mjs'
import { auditTrainingDataset } from './training-data.mjs'
import { openTrainingState } from './training-state.mjs'
import { hasTrainingSecrets } from '../../src/training-core.js'
import { normalizeBaseUrl } from './eval-workflow.mjs'
import { immutableJson } from '../../src/evidence-program.js'
import { readBytes } from './eval-files.mjs'
export function remoteTrainingPreflight(plan, { approvedMaxUsd = null, now = Date.now() } = {}) {
  const p = plan.profile.provider, pricing = p?.pricing, model = plan.profile.model.id
  if (plan.profile.backend !== 'remote-finetune' || plan.dataset.objective !== 'sft' || !p || p.protocol !== 'files-finetuning-jobs/1' || p.supportsFineTuning !== true || !Array.isArray(p.models) || !p.models.includes(model) || plan.profile.model.licenseAccepted !== true || !model || /REQUIRED|PLACEHOLDER/.test(model)) throw new Error('training-provider-capability-unverified')
  if (Object.keys(p).some((k) => !['protocol', 'baseUrl', 'apiKeyEnv', 'supportsFineTuning', 'models', 'pricing', 'learningRateMultiplier'].includes(k))) throw new Error('training-provider-schema')
  normalizeBaseUrl(p.baseUrl)
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(p.apiKeyEnv || '') || /^GITHUB_|^GH_/.test(p.apiKeyEnv)) throw new Error('training-provider-key-reference')
  if (!pricing || !Number.isFinite(pricing.trainingUsdPerMillion) || pricing.trainingUsdPerMillion <= 0 || !Number.isFinite(pricing.fixedJobFeeUsd) || pricing.fixedJobFeeUsd < 0 || typeof pricing.source !== 'string' || !pricing.source.startsWith('https://') || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.verifiedAt || '')) throw new Error('training-training-price-required')
  const age = now - Date.parse(pricing.verifiedAt + 'T00:00:00Z'), source = new URL(pricing.source)
  if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000 || source.username || source.password || source.search || source.hash || !plan.simulated && source.hostname.endsWith('.invalid')) throw new Error('training-training-price-stale')
  const maximum = plan.trainingTokenUpperEst * pricing.trainingUsdPerMillion / 1e6 + pricing.fixedJobFeeUsd
  if (!Number.isFinite(approvedMaxUsd) || approvedMaxUsd <= 0 || maximum > approvedMaxUsd || maximum > (plan.profile.limits.maxUsd ?? 0)) throw new Error('training-separate-cost-approval-required')
  return { maximumEstimatedUsd: maximum, maximumHttpRequests: plan.profile.limits.maxHttpRequests, priceIsInferencePrice: false }
}
export async function runRemoteTraining({ plan, reviews, approval, directory, markerPath, apiKey, live = false, fetchImpl = globalThis.fetch, signal = null, pollOnce = true, cancel = false, now = Date.now() }) {
  assertTrainingPlan(plan)
  if (!live || !isTrainingApproval(approval) || approval.planDigest !== plan.digest || !['remote-money', 'fixture'].includes(approval.mode) || approval.datasetDigest !== plan.dataset.digest) throw new Error('training-separate-cost-approval-required')
  if (plan.simulated && (approval.mode !== 'fixture' || fetchImpl === globalThis.fetch)) throw new Error('training-simulation-no-network')
  const estimate = remoteTrainingPreflight(plan, { approvedMaxUsd: approval.maxUsd, now }), audit = await auditTrainingDataset({ directory: trainingDatasetPath(plan), reviews })
  if (audit.datasetDigest !== plan.dataset.digest) throw new Error('training-dataset-plan-drift')
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('training-api-key-missing')
  const session = openTrainingState({ directory, markerPath, plan, scope: approval.id }), base = normalizeBaseUrl(plan.profile.provider.baseUrl)
  if (session.read().phase === 'candidate') return immutableJson({ schema: 'cfb.remote-training-result/1', cached: true, status: 'succeeded', candidate: session.read().candidate, requests: session.read().http.length, estimate, actualCostUsd: null, productionActivated: false })
  const request = async (key, endpoint, { method = 'POST', body, json = false } = {}) => {
    const current = session.read(), cached = current.http.find((r) => r.key === key && r.status === 'accepted')
    if (cached) return cached.result
    if (current.pending || ['failed', 'unknown', 'cancelled'].includes(current.phase)) throw new Error('training-remote-unresolved')
    if (signal?.aborted) throw new Error('training-aborted')
    if (current.http.length >= plan.profile.limits.maxHttpRequests) throw new Error('training-http-budget')
    const keyTag = crypto.createHmac('sha256', session.store.authorityId).update(apiKey).digest('hex')
    if (current.keyTag && current.keyTag !== keyTag) throw new Error('training-auth-context-changed')
    session.update((s) => ({ ...s, phase: 'running', keyTag, pending: { type: 'http', key }, http: [...s.http, { key, status: 'pending' }] }))
    try {
      const headers = { authorization: 'Bearer ' + apiKey, ...(json ? { 'content-type': 'application/json' } : {}) }
      const r = await fetchImpl(base + endpoint, { method, redirect: 'error', headers, body: json ? JSON.stringify(body) : body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) })
      const text = await r.text(); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('training-response-byte-limit')
      if (!r.ok) throw new Error('training-http-' + r.status)
      let j; try { j = JSON.parse(text) } catch { throw new Error('training-response-json') }
      if (!j || typeof j !== 'object' || hasTrainingSecrets(j) || apiKey.length >= 16 && text.includes(apiKey)) throw new Error('training-response-secret-or-shape')
      if (typeof j.id !== 'string' || !/^[\w.-]{1,160}$/.test(j.id)) throw new Error('training-response-id')
      if (j.status !== undefined && !['queued', 'pending', 'processed', 'validating_files', 'running', 'succeeded', 'failed', 'cancelled'].includes(j.status)) throw new Error('training-response-status')
      if (j.fine_tuned_model !== undefined && j.fine_tuned_model !== null && (typeof j.fine_tuned_model !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(j.fine_tuned_model))) throw new Error('training-response-model')
      const clean = { id: j.id, status: j.status || null, fineTunedModel: j.fine_tuned_model || null }
      session.update((s) => ({ ...s, pending: null, http: s.http.map((x) => x.key === key ? { key, status: 'accepted', result: clean } : x) }))
      return clean
    } catch (e) {
      const code = /^training-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'training-network-unknown'
      session.update((s) => ({ ...s, phase: 'unknown', pending: { type: 'http', key, reason: code } }))
      throw new Error(code)
    }
  }
  const upload = async (split) => {
    const cached = session.read().http.find((x) => x.key === 'upload-' + split && x.status === 'accepted')
    if (cached) return cached.result.id
    const info = plan.dataset.files['export-' + split]
    if (!info || !info.path.startsWith('export/') || info.path.includes('test')) throw new Error('training-test-upload-forbidden')
    const bytes = readBytes(path.join(trainingDatasetPath(plan), info.path), 128 * 1024 * 1024)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new Error('training-upload-drift')
    const form = new FormData(); form.append('purpose', 'fine-tune'); form.append('file', new Blob([bytes], { type: 'application/jsonl' }), split + '.jsonl')
    return (await request('upload-' + split, '/files', { body: form })).id
  }
  if (cancel) {
    const known = session.read().http.find((r) => r.key === 'create-job' && r.status === 'accepted')
    if (!known) throw new Error('training-no-known-job-to-cancel')
    const r = await request('cancel-job', '/fine_tuning/jobs/' + encodeURIComponent(known.result.id) + '/cancel', { json: true, body: {} })
    session.update((s) => ({ ...s, phase: 'cancelled', pending: null }))
    return { schema: 'cfb.remote-training-cancel/1', jobId: r.id, cancelled: true, actualCostUsd: null, productionActivated: false }
  }
  const trainId = await upload('train'), selectionId = await upload('selection')
  const created = await request('create-job', '/fine_tuning/jobs', { json: true, body: { model: plan.profile.model.id, training_file: trainId, validation_file: selectionId,
    hyperparameters: { n_epochs: plan.profile.recipe.epochs, batch_size: plan.profile.recipe.batchSize, learning_rate_multiplier: plan.profile.provider.learningRateMultiplier || 1 } } })
  let status = created
  if (pollOnce && !['succeeded', 'failed', 'cancelled'].includes(status.status)) {
    const n = session.read().http.filter((r) => r.key.startsWith('poll-')).length
    status = await request('poll-' + n, '/fine_tuning/jobs/' + encodeURIComponent(created.id), { method: 'GET' })
  }
  if (status.status === 'succeeded' && typeof status.fineTunedModel === 'string' && status.fineTunedModel) {
    session.update((s) => ({ ...s, phase: 'candidate', candidate: { digest: crypto.createHash('sha256').update(status.fineTunedModel).digest('hex'), modelId: status.fineTunedModel, simulated: plan.simulated } }))
  } else if (['failed', 'cancelled'].includes(status.status)) session.update((s) => ({ ...s, phase: status.status, pending: null }))
  return immutableJson({ schema: 'cfb.remote-training-result/1', jobId: created.id, status: status.status, candidate: session.read().candidate,
    requests: session.read().http.length, estimate, actualCostUsd: null, productionActivated: false })
}
