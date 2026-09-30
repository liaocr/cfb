// 用实际reference训练callback串联有界迭代；observer预测byte，判据只在宿主suite。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { evidenceDigest } from '../../src/evidence-program.js'
import { freezeEffectSuite } from '../../src/effect-archive.js'
import { assertOfflineNamespace } from '../verify-offline.mjs'
import { openTrainingAuthorities } from './training-workflow.mjs'
import { trainingFixtureRows } from './training-demo.mjs'
import { buildTrainingDataset } from './training-data.mjs'
import { prepareTrainingPlan } from './training-plan.mjs'
import { trainReferenceModel } from './training-reference.mjs'
import { freezeTrainingIteration, runTrainingIteration } from './training-iteration.mjs'
export async function trainingIterationDemo() {
  const boundary = assertOfflineNamespace(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-training-iteration-'))
  try {
    const authority = openTrainingAuthorities(path.join(root, 'private'), { verifyReview: () => true, authorize: () => true })
    const rows = authority.reviews.approveBatch(trainingFixtureRows(), { mode: 'fixture', reviewer: 'fixture', checks: { identifierSafe: true, completeNative: true, goalVerified: true, criterionFrozen: true } })
    const input = path.join(root, 'input.jsonl'); fs.writeFileSync(input, rows.map(JSON.stringify).join('\n') + '\n')
    const dataset = path.join(root, 'data'); await buildTrainingDataset({ input, output: dataset, reviews: authority.reviews })
    const plans = []
    for (const steps of [2, 5, 8]) plans.push(await prepareTrainingPlan({ dataset, reviews: authority.reviews, profile: { schema: 'cfb.training-profile/1', backend: 'reference-byte', recipe: { maxSteps: steps, checkpointEvery: 1, learningRate: 1 } }, file: path.join(root, 'plan-' + steps + '.json') }))
    const items = Object.fromEntries(['train', 'selection', 'test'].map((split) => [split, [{ id: 'byte-' + split, family: 'byte-fixture-' + split, input: { previousByte: 130, condition: split === 'train' ? 'A' : split === 'selection' ? 'B' : 'C' }, predicate: { op: 'equals', field: 'predictedByte', value: 229 } }]]))
    // 基线全零预测0；实际目标第一个字“定”的UTF8首byte=229。
    const suite = freezeEffectSuite({ id: 'byte-goal-only', evaluatorVersion: 'independent-fixture-byte-observer-v1', ...items })
    const definition = freezeTrainingIteration({ id: 'reference-iteration', candidatePlans: plans, suite, evaluationScope: 'a'.repeat(64), maxCandidates: 3, maxComputeSteps: 15, timeoutMs: 10000 })
    const secret = crypto.randomBytes(32), seal = (v) => ({ ...v, signature: crypto.createHmac('sha256', secret).update(evidenceDigest(v)).digest('hex') })
    const authenticated = (r) => { const { signature, ...body } = r; return signature === crypto.createHmac('sha256', secret).update(evidenceDigest(body)).digest('hex') }
    let trainings = 0, observations = 0, testGivenToProposer = false
    const callbacks = {
      propose({ allowedCandidateDigests, feedback }) { if (JSON.stringify(feedback).includes('"test"')) testGivenToProposer = true; return allowedCandidateDigests[0] || null },
      async train({ plan }) {
        const trained = await trainReferenceModel({ plan, reviews: authority.reviews, directory: path.join(root, 'trained-' + plan.digest.slice(0, 16)), markerPath: path.join(root, 'trained-' + plan.digest.slice(0, 16) + '.json') })
        const { cached, ...candidate } = trained; if (!cached) trainings++; return seal({ candidate })
      },
      evaluate({ candidate, input }) {
        observations++; let predictedByte = 0
        if (candidate) { const b = fs.readFileSync(candidate.modelFile), w = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); let max = -Infinity; for (let j = 0; j < 257; j++) if (w[input.previousByte * 257 + j] > max) { max = w[input.previousByte * 257 + j]; predictedByte = j } }
        return seal({ observation: { predictedByte }, candidateDigest: candidate?.digest || null, inputDigest: evidenceDigest(input) })
      },
      authenticateTraining(r, b) { return authenticated(r) && r.candidate.planDigest === b.planDigest },
      authenticateObservation(r, b) { return authenticated(r) && r.candidateDigest === b.candidateDigest && r.inputDigest === b.inputDigest },
    }
    const options = { definition, directory: path.join(root, 'registry'), markerPath: path.join(root, 'iteration.public.json'), ...callbacks }
    const result = await runTrainingIteration(options), before = { trainings, observations }, replay = await runTrainingIteration(options)
    assert.equal(result.reservedCandidates, 3); assert.equal(result.computeUpperReserved, 15); assert.equal(result.testEffects.length, 0); assert.equal(result.released, false)
    assert.equal(replay.cached, true); assert.deepEqual({ trainings, observations }, before); assert.equal(testGivenToProposer, false)
    const engineeringSuite = freezeEffectSuite({ id: 'artifact-integrity-only', evaluatorVersion: 'protected-engineering-artifact-v1', ...Object.fromEntries(['train', 'selection', 'test'].map((split) => [split, [{ id: 'artifact-' + split, family: 'artifact-fixture-' + split, input: { nonce: split === 'train' ? 'X' : split === 'selection' ? 'Y' : 'Z' }, predicate: { op: 'equals', field: 'validChangedArtifact', value: true } }]])) })
    const engineering = freezeTrainingIteration({ id: 'engineering-route-only', candidatePlans: plans, suite: engineeringSuite, evaluationScope: 'b'.repeat(64), maxCandidates: 3, maxComputeSteps: 15, timeoutMs: 10000 })
    const engineeringOptions = { ...options, definition: engineering, evaluate({ candidate, input }) {
      observations++; let validChangedArtifact = false
      if (candidate) { const bytes = fs.readFileSync(candidate.modelFile), actual = crypto.createHash('sha256').update(bytes).digest('hex'); validChangedArtifact = actual === candidate.sha256 && bytes.some((v) => v !== 0) }
      return seal({ observation: { validChangedArtifact }, candidateDigest: candidate?.digest || null, inputDigest: evidenceDigest(input) })
    } }
    const engineeringResult = await runTrainingIteration(engineeringOptions)
    assert.equal(engineeringResult.testEffects.length, 1); assert.equal(engineeringResult.accepted, true); assert.equal(engineeringResult.released, false)
    const saved = { trainings, observations }; await runTrainingIteration(engineeringOptions); assert.deepEqual({ trainings, observations }, saved)
    return { schema: 'cfb.offline-training-iteration/1', boundary, actualReferenceTrainings: trainings, reservedComputeSteps: result.computeUpperReserved, authenticatedObservations: observations,
      rejectedGoalCase: { selected: !!result.selectedCandidate, testComparisons: result.testEffects.length, originalCriterionKept: true },
      engineeringRoute: { selected: !!engineeringResult.selectedCandidate, finalTestComparisons: engineeringResult.testEffects.length, released: false, modelQualityClaimed: false },
      selected: !!result.selectedCandidate, objectiveTestPassed: result.accepted, finalTestComparisons: result.testEffects.length, testGivenToProposer, replayExtraTrainings: 0, replayExtraObservations: 0,
      externalModelCalls: 0, paidTrainingCostUsd: 0, productionActivated: false, limitation: '真实训练了byte测试模型，受控迭代/host二元observer已串联；固定fixture不证明LoRA/CUDA/真实模型质量或独立泛化。' }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
