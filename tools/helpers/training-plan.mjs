// 不可变训练配方与源/数据/基模型绑定；不下载、不训练、不批准收费。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { hasTrainingSecrets, freezeTrainingEvaluation } from '../../src/training-core.js'
import { assertSafePath, readJson, writeJson } from './eval-files.mjs'
import { fingerprintModelCache } from './training-io.mjs'
import { auditTrainingDataset } from './training-data.mjs'
export const TRAIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_TRAIN_HOME = path.join(TRAIN_ROOT, '.cfb-runtime/train-ready')
export function trainingSourceDigest() {
  const list = ['src/training-core.js', 'src/evidence-program.js', 'src/evidence-store.js', 'tools/train-ready.mjs', 'training/lora_trainer.py', 'training/requirements.optional.txt', ...fs.readdirSync(path.join(TRAIN_ROOT, 'tools/helpers')).filter((p) => p.startsWith('training-') && p.endsWith('.mjs')).sort().map((p) => 'tools/helpers/' + p)]
  return evidenceDigest(Object.fromEntries(list.map((p) => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(TRAIN_ROOT, p))).digest('hex')])))
}
const DEFAULT_RECIPE = Object.freeze({ maxSteps: 100, epochs: 1, learningRate: 0.0002, seed: 42, maxSeqLength: 8192, batchSize: 1, gradientAccumulation: 16, checkpointEvery: 10, loraRank: 8, loraAlpha: 16, loraDropout: 0, precision: 'fp32', targetModules: ['q_proj', 'v_proj'], preferenceBeta: 0.1 })
export function normalizeTrainingProfile(p) {
  if (!p || p.schema !== 'cfb.training-profile/1' || !['reference-byte', 'local-lora', 'remote-finetune'].includes(p.backend) || hasTrainingSecrets(p) || Object.keys(p).some((k) => !['schema', 'backend', 'model', 'recipe', 'limits', 'provider'].includes(k))) throw new Error('training-profile')
  const recipe = { ...DEFAULT_RECIPE, ...(p.recipe || {}) }
  if (Object.keys(recipe).some((k) => !Object.hasOwn(DEFAULT_RECIPE, k)) || !Number.isInteger(recipe.maxSteps) || recipe.maxSteps < 1 || recipe.maxSteps > 1000000 || !Number.isInteger(recipe.epochs) || recipe.epochs < 1 || recipe.epochs > 100 || !Number.isFinite(recipe.learningRate) || recipe.learningRate <= 0 || recipe.learningRate > 1 || !Number.isInteger(recipe.seed) || !Number.isInteger(recipe.maxSeqLength) || recipe.maxSeqLength < 64 || recipe.maxSeqLength > 131072 || !Number.isInteger(recipe.batchSize) || recipe.batchSize < 1 || recipe.batchSize > 256 || !Number.isInteger(recipe.gradientAccumulation) || recipe.gradientAccumulation < 1 || recipe.gradientAccumulation > 1024 || !Number.isInteger(recipe.checkpointEvery) || recipe.checkpointEvery < 1 || recipe.checkpointEvery > recipe.maxSteps || !Number.isInteger(recipe.loraRank) || recipe.loraRank < 1 || recipe.loraRank > 128 || !Number.isFinite(recipe.loraAlpha) || recipe.loraAlpha <= 0 || !Number.isFinite(recipe.loraDropout) || recipe.loraDropout < 0 || recipe.loraDropout >= 1 || !['fp32', 'bf16', 'fp16'].includes(recipe.precision) || !Array.isArray(recipe.targetModules) || !recipe.targetModules.length || recipe.targetModules.some((m) => typeof m !== 'string' || !/^[\w.]+$/.test(m)) || !Number.isFinite(recipe.preferenceBeta) || recipe.preferenceBeta <= 0) throw new Error('training-recipe')
  const limits = { maxWallSeconds: 3600, maxTrainTokenUpperEst: 10000000, maxHttpRequests: 8, maxUsd: null, maxComputeSteps: recipe.maxSteps, ...(p.limits || {}) }
  if (Object.keys(limits).some((k) => !['maxWallSeconds', 'maxTrainTokenUpperEst', 'maxHttpRequests', 'maxUsd', 'maxComputeSteps'].includes(k)) || !Number.isInteger(limits.maxWallSeconds) || limits.maxWallSeconds < 1 || limits.maxWallSeconds > 86400 || !Number.isSafeInteger(limits.maxTrainTokenUpperEst) || limits.maxTrainTokenUpperEst < 1 || !Number.isInteger(limits.maxHttpRequests) || limits.maxHttpRequests < 1 || limits.maxHttpRequests > 64 || limits.maxUsd !== null && (!Number.isFinite(limits.maxUsd) || limits.maxUsd <= 0 || limits.maxUsd > 10000)) throw new Error('training-limits')
  if (!Number.isSafeInteger(limits.maxComputeSteps) || limits.maxComputeSteps < recipe.maxSteps || limits.maxComputeSteps > 2000000) throw new Error('training-compute-budget')
  const model = p.model || { id: null, path: null, revision: null, licenseAccepted: false }
  if (Object.keys(model).some((k) => !['id', 'path', 'revision', 'licenseAccepted'].includes(k)) || typeof model.licenseAccepted !== 'boolean') throw new Error('training-model')
  if (model.path) assertSafePath(model.path, { directory: true })
  return immutableJson({ schema: p.schema, backend: p.backend, model, recipe, limits, provider: p.provider ?? null })
}
export async function prepareTrainingPlan({ dataset, reviews, profile, file, evaluationSuite = null }) {
  const root = assertSafePath(dataset, { directory: true }), p = normalizeTrainingProfile(profile), audit = await auditTrainingDataset({ directory: root, reviews }), manifest = readJson(path.join(root, 'manifest.json'))
  const tokenUpper = manifest.tokenUpperEst.train * p.recipe.epochs * (manifest.objective === 'preference' ? 4 : 1)
  if (!Number.isSafeInteger(tokenUpper) || tokenUpper > p.limits.maxTrainTokenUpperEst) throw new Error('training-token-budget')
  if (p.backend === 'reference-byte' && (!manifest.simulated || manifest.objective !== 'sft')) throw new Error('training-reference-fixtures-only')
  const baseModelCache = p.backend === 'local-lora' ? await fingerprintModelCache(p.model.path) : null
  if (evaluationSuite) evaluationSuite = freezeTrainingEvaluation(evaluationSuite)
  const body = { schema: 'cfb.training-plan/1', evaluationSuite, baseModelCache, dataset: { directory: root, digest: audit.datasetDigest, objective: manifest.objective, reviewAuthorityId: manifest.reviewAuthorityId, counts: manifest.counts, files: manifest.files },
    simulated: manifest.simulated, profile: p, trainingTokenUpperEst: tokenUpper, sourceDigest: trainingSourceDigest(), targetBoundary: 'complete-compiler-response',
    testPolicy: 'custody-only-no-upload-no-epoch-selection', defaultActivation: false }
  const plan = immutableJson({ ...body, digest: evidenceDigest(body) }); writeJson(file, plan, { exclusive: true }); return plan
}
export function assertTrainingPlan(value) {
  const { digest, executionPaths, ...body } = value || {}
  if (body.schema !== 'cfb.training-plan/1' || evidenceDigest(body) !== digest || normalizeTrainingProfile(body.profile).backend !== body.profile.backend || body.testPolicy !== 'custody-only-no-upload-no-epoch-selection' || body.defaultActivation !== false) throw new Error('training-plan-drift')
  if (body.sourceDigest !== trainingSourceDigest()) throw new Error('training-source-drift')
  if (executionPaths) { if (Object.keys(executionPaths).some((k) => !['datasetDirectory', 'modelDirectory'].includes(k))) throw new Error('training-relocation-paths'); for (const p of Object.values(executionPaths)) assertSafePath(p, { directory: true }) }
  return value
}
export function inspectLocalTrainingDependencies(python = 'python3') {
  // CLI负责启动静态doctor脚本；不import torch、更不下载模型。
  return { python, optional: ['torch', 'transformers', 'peft', 'safetensors'], installAutomatically: false }
}

export const trainingDatasetPath = (plan) => plan.executionPaths?.datasetDirectory || plan.dataset.directory
export const trainingModelPath = (plan) => plan.executionPaths?.modelDirectory || plan.profile.model.path
export async function relocateTrainingPlan(plan, { datasetDirectory, modelDirectory = null }, reviews) {
  assertTrainingPlan(plan)
  const audit = await auditTrainingDataset({ directory: datasetDirectory, reviews })
  if (audit.datasetDigest !== plan.dataset.digest) throw new Error('training-relocation-dataset-mismatch')
  if (modelDirectory) { const model = await fingerprintModelCache(modelDirectory); if (!model || model.digest !== plan.baseModelCache?.digest) throw new Error('training-relocation-model-mismatch') }
  // 物理位置不更改逻辑planDigest/原批准/已花额度；新位置仍须内容与审核完全等价。
  return immutableJson({ ...plan, executionPaths: { datasetDirectory: path.resolve(datasetDirectory), ...(modelDirectory ? { modelDirectory: path.resolve(modelDirectory) } : {}) } })
}
