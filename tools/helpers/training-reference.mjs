// 真正可训练的257类byte-bigram参考模型：只检验数据→梯度→检查点→续训，不是LLM。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { assertTrainingPlan, trainingDatasetPath, trainingModelPath } from './training-plan.mjs'
import { auditTrainingDataset, trainingJsonl } from './training-data.mjs'
import { openTrainingState } from './training-state.mjs'
import { readBytes, writeBytes, writeJson } from './eval-files.mjs'
const V = 257, SIZE = V * V
async function statistics(file) {
  const counts = new Map(); let total = 0
  for await (const row of trainingJsonl(file)) {
    if (row.objective !== 'sft') throw new Error('training-reference-sft-only')
    const prompt = Buffer.from(row.messages.map((m) => m.content).join('\n'), 'utf8'), target = [...Buffer.from(row.target, 'utf8'), 256]
    let prev = prompt.length ? prompt.at(-1) : 256
    for (const next of target) { if (!counts.has(prev)) counts.set(prev, new Float64Array(V)); counts.get(prev)[next]++; total++; prev = next }
  }
  return { counts, total }
}
function probabilities(weights, previous) {
  const start = previous * V, out = new Float64Array(V); let max = -Infinity, sum = 0
  for (let j = 0; j < V; j++) max = Math.max(max, weights[start + j])
  for (let j = 0; j < V; j++) { out[j] = Math.exp(weights[start + j] - max); sum += out[j] }
  for (let j = 0; j < V; j++) out[j] /= sum
  return out
}
function loss(weights, s) {
  let total = 0
  for (const [prev, c] of s.counts) { const p = probabilities(weights, prev); for (let j = 0; j < V; j++) if (c[j]) total -= c[j] * Math.log(Math.max(p[j], 1e-300)) }
  return total / s.total
}
function update(weights, s, lr) {
  const next = new Float64Array(weights)
  for (const [prev, c] of s.counts) {
    const p = probabilities(weights, prev), n = c.reduce((a, b) => a + b, 0)
    for (let j = 0; j < V; j++) next[prev * V + j] -= lr * (n * p[j] - c[j]) / s.total
  }
  return next
}
export async function trainReferenceModel({ plan, reviews, directory, markerPath, stopAfter = null, signal = null, progress = () => {} }) {
  assertTrainingPlan(plan)
  if (plan.profile.backend !== 'reference-byte' || !plan.simulated || plan.dataset.objective !== 'sft' || plan.profile.recipe.maxSteps > 128) throw new Error('training-reference-fixtures-only')
  const audit = await auditTrainingDataset({ directory: trainingDatasetPath(plan), reviews })
  if (audit.datasetDigest !== plan.dataset.digest) throw new Error('training-dataset-plan-drift')
  const train = await statistics(path.join(trainingDatasetPath(plan), plan.dataset.files.train.path)), selection = await statistics(path.join(trainingDatasetPath(plan), plan.dataset.files.selection.path))
  const session = openTrainingState({ directory, markerPath, plan, scope: 'reference:' + plan.digest })
  let state = session.read()
  if (state.pending || ['failed', 'unknown', 'cancelled'].includes(state.phase)) throw new Error('training-unresolved-step')
  if (state.phase === 'candidate') {
    const actual = crypto.createHash('sha256').update(readBytes(state.candidate.modelFile, SIZE * 8)).digest('hex')
    if (actual !== state.candidate.sha256) throw new Error('training-candidate-artifact-drift')
    return immutableJson({ cached: true, ...state.candidate })
  }
  let weights = new Float64Array(SIZE)
  // Buffer的slice可能共享不同byteOffset，因此显式复制到正好SIZE个float64。
  if (state.weightsRef) { const b = Buffer.from(session.store.get(state.weightsRef, { kind: 'reference-weights' })); if (b.length !== SIZE * 8) throw new Error('training-reference-checkpoint-size'); weights = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  const beforeLoss = state.initialLoss ?? loss(weights, train), start = Date.now(), elapsedBase = state.elapsedMs || 0; let ran = 0
  for (; state.steps < plan.profile.recipe.maxSteps; ) {
    if (signal?.aborted) { session.update((s) => ({ ...s, phase: 'paused' })); return { paused: true, steps: state.steps, externalApiCalls: 0 } }
    if (elapsedBase + Date.now() - start > plan.profile.limits.maxWallSeconds * 1000) throw new Error('training-wall-budget')
    const step = state.steps + 1
    session.update((s) => ({ ...s, phase: 'running', pending: { type: 'gradient-step', step }, initialLoss: beforeLoss }))
    const next = update(weights, train, plan.profile.recipe.learningRate), weightsRef = session.store.put(Buffer.from(next.buffer), { kind: 'reference-weights' })
    state = session.update((s) => ({ ...s, phase: 'running', steps: step, cursor: step, pending: null, weightsRef, initialLoss: beforeLoss, elapsedMs: elapsedBase + Date.now() - start }))
    weights = next; ran++; progress({ step, trainLoss: loss(weights, train), simulation: true })
    if (stopAfter !== null && ran >= stopAfter && step < plan.profile.recipe.maxSteps) { session.update((s) => ({ ...s, phase: 'paused' })); return { paused: true, steps: step, externalApiCalls: 0 } }
  }
  const bytes = Buffer.from(weights.buffer), sha256 = crypto.createHash('sha256').update(bytes).digest('hex'), modelFile = path.join(directory, 'reference-model.bin')
  writeBytes(modelFile, bytes)
  const candidate = { schema: 'cfb.trained-candidate/1', backend: 'reference-byte', simulated: true, modelFile, sha256, planDigest: plan.digest, datasetDigest: plan.dataset.digest,
    steps: state.steps, initialLoss: beforeLoss, trainLoss: loss(weights, train), selectionLoss: loss(weights, selection), testRead: false, externalApiCalls: 0, actualProviderCostUsd: 0,
    note: '参考byte模型只证参数更新/遮罩与续训，不代表CFB/LLM质量，不可生产发布。' }
  const sealed = { ...candidate, digest: evidenceDigest(candidate) }
  session.update((s) => ({ ...s, phase: 'candidate', pending: null, candidate: sealed })); writeJson(path.join(directory, 'candidate.json'), sealed)
  return immutableJson({ cached: false, ...sealed })
}
