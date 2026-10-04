#!/usr/bin/env node
// Score audited micro pairs through the dependency-free JS functions used by compileV5Local.
// Optional PyTorch fixtures provide numerical parity on real feature rows; no random-only parity claims.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  V5_MICRO_WEIGHTS,
  fingerprintV5MicroWeights,
  loadV5MicroWeights,
  scoreUnitWithWeights,
  scoreDraftPreferenceFeatures,
} from '../src/compile-v5-local.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const datasetPath = path.resolve(ROOT, value('--dataset', 'transfer/models/micro-dev-dataset.json'))
const weightsPath = path.resolve(ROOT, value('--weights', 'transfer/models/v5-micro-weights.json'))
const validationFamilyArg = value('--validation-family')
const reportPath = value('--report') ? path.resolve(ROOT, value('--report')) : null
const parityFixturesPath = value('--parity-fixtures')
  ? path.resolve(ROOT, value('--parity-fixtures'))
  : null
const finalBlindTest = args.includes('--final-blind-test')
const mustBeNewFamily = args.includes('--must-be-new-family')
const SLOT_NAMES = ['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE']
const familyKey = (v) => String(v || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')
const knownFamilies = new Set((value('--known-families', '') || '').split(',').map((v) => familyKey(v)).filter(Boolean))
const knownSourceArg = value('--known-source-ids', '') || ''
let knownSourceList
try {
  const parsed = JSON.parse(knownSourceArg)
  knownSourceList = Array.isArray(parsed) ? parsed : knownSourceArg.split(',')
} catch {
  knownSourceList = knownSourceArg.split(',')
}
const knownSourceIds = new Set(knownSourceList.map((id) => String(id).trim()).filter(Boolean))
const mean = (rows) => rows.length ? rows.reduce((s, r) => s + r.correct, 0) / rows.length : null
const meanNumber = (values) => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null

const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
if (dataset.schema !== 'cfb.micro-dev-dataset/3') throw new Error(`unsupported-dataset-schema:${dataset.schema}`)
if (dataset.holdoutTouched !== false) throw new Error('refusing-dataset-with-holdout-touch')
if (!Array.isArray(dataset.unitSamples) || !Array.isArray(dataset.unitStepPairs) || !Array.isArray(dataset.stepSimpoPairs)) {
  throw new Error('micro-pair-eval-missing-arrays')
}
const unitEndpointDegrees = new Map()
let unitEndpointReferences = 0
for (const pair of dataset.unitStepPairs) {
  if (!pair.trainingEligible) continue
  for (const index of [pair.winIdx, pair.loseIdx]) {
    if (!Number.isInteger(index) || index < 0 || index >= dataset.unitSamples.length) {
      throw new Error(`unit-pair-index-out-of-range:${pair.sourceId}`)
    }
    unitEndpointDegrees.set(index, (unitEndpointDegrees.get(index) || 0) + 1)
    unitEndpointReferences++
  }
}
const declaredEndpointCap = dataset.stats?.unitPairEndpointReuse?.cap
const actualMaxEndpointDegree = unitEndpointDegrees.size ? Math.max(...unitEndpointDegrees.values()) : 0
if (!Number.isInteger(declaredEndpointCap) || declaredEndpointCap < 1 || actualMaxEndpointDegree > declaredEndpointCap) {
  throw new Error(`unit-pair-global-endpoint-cap-violated:${actualMaxEndpointDegree}>${declaredEndpointCap}`)
}
const unitPairEndpointAudit = {
  eligiblePairs: dataset.unitStepPairs.filter((pair) => pair.trainingEligible).length,
  uniqueEndpoints: unitEndpointDegrees.size,
  endpointReferences: unitEndpointReferences,
  endpointsReused: [...unitEndpointDegrees.values()].filter((degree) => degree > 1).length,
  maxEndpointDegree: actualMaxEndpointDegree,
  cap: declaredEndpointCap,
}
const validationFamily = validationFamilyArg == null ? null : familyKey(validationFamilyArg)
const candidateWeights = loadV5MicroWeights(weightsPath)
const productionWeights = V5_MICRO_WEIGHTS

function makeUnitFeatures(row, index) {
  if (!row || !Array.isArray(row.features) || row.features.length !== 19 || !Number.isFinite(row.tokenCount)) {
    throw new Error(`invalid-unit-endpoint:${index}`)
  }
  return {
    vec: row.features,
    tok: row.tokenCount,
    temptationT: row.temptationT ?? row.features[9],
    cueExcluded: row.features[15],
  }
}

function unitMetric(weights, split) {
  const rows = []
  const scoreCache = new Map()
  const degrees = new Map()
  let ties = 0
  const getScore = (index) => {
    if (scoreCache.has(index)) return scoreCache.get(index)
    const feat = makeUnitFeatures(dataset.unitSamples[index], index)
    const result = scoreUnitWithWeights(feat, weights)
    const tokenPenalty = (weights.lambda || 0.0038) * feat.tok
    const excludedGateActive = result.temptationPred < (weights.temptationMin ?? 0.18) && feat.cueExcluded < 0.9
    const scored = { ...result, tokenPenalty, excludedGateActive }
    scoreCache.set(index, scored)
    return scored
  }

  for (const pair of dataset.unitStepPairs) {
    if (!pair.trainingEligible) continue
    const family = familyKey(pair.family)
    const pairSplit = validationFamily == null ? 'all' : family === validationFamily ? 'validation' : 'train'
    if (pairSplit !== split) continue
    const winRow = dataset.unitSamples[pair.winIdx]
    const loseRow = dataset.unitSamples[pair.loseIdx]
    if (!winRow || !loseRow) throw new Error(`unit-pair-index-out-of-range:${pair.sourceId}`)
    if (familyKey(winRow.family) !== family || familyKey(loseRow.family) !== family) {
      throw new Error(`unit-pair-cross-family:${pair.sourceId}`)
    }
    if (finalBlindTest && (winRow.sourceId !== pair.sourceId || loseRow.sourceId !== pair.sourceId)) {
      throw new Error(`final-test-unit-pair-cross-source:${pair.sourceId}`)
    }
    const win = getScore(pair.winIdx)
    const lose = getScore(pair.loseIdx)
    const correct = win.v > lose.v ? 1 : 0
    if (win.v === lose.v) ties++
    rows.push({ family, sourceId: pair.sourceId, correct })
    degrees.set(pair.winIdx, (degrees.get(pair.winIdx) || 0) + 1)
    degrees.set(pair.loseIdx, (degrees.get(pair.loseIdx) || 0) + 1)
  }

  const byFamily = {}
  for (const family of [...new Set(rows.map((r) => r.family))].sort()) {
    const group = rows.filter((r) => r.family === family)
    byFamily[family] = {
      correct: group.reduce((s, r) => s + r.correct, 0),
      total: group.length,
      accuracy: +mean(group).toFixed(4),
    }
  }
  const maxEndpointDegree = degrees.size ? Math.max(...degrees.values()) : 0
  const configuredCap = dataset.stats?.unitPairEndpointReuse?.cap
  if (configuredCap != null && maxEndpointDegree > configuredCap) {
    throw new Error(`unit-pair-endpoint-cap-violated:${maxEndpointDegree}>${configuredCap}`)
  }
  const endpointScores = [...scoreCache.values()]
  const tokenPenalties = endpointScores.map((score) => score.tokenPenalty)
  const scoreAudit = {
    uniqueEndpointsScored: endpointScores.length,
    tokenLengthPenaltyIncludedInRankScore: true,
    tokenPenaltyMean: meanNumber(tokenPenalties) == null ? null : +meanNumber(tokenPenalties).toFixed(6),
    tokenPenaltyMin: tokenPenalties.length ? +Math.min(...tokenPenalties).toFixed(6) : null,
    tokenPenaltyMax: tokenPenalties.length ? +Math.max(...tokenPenalties).toFixed(6) : null,
    excludedGateActiveEndpoints: endpointScores.filter((score) => score.excludedGateActive).length,
    scoredAsExcludedAfterGate: endpointScores.filter((score) => score.slot === 'EXCLUDED').length,
    scoredAsNoiseAfterGate: endpointScores.filter((score) => score.slot === 'NOISE').length,
  }
  return {
    correct: rows.reduce((s, r) => s + r.correct, 0),
    total: rows.length,
    accuracy: mean(rows) == null ? null : +mean(rows).toFixed(4),
    ties,
    byFamily,
    maxEndpointDegree,
    endpointReuseCap: configuredCap ?? null,
    scoreAudit,
  }
}

function draftMetric(weights, split) {
  const rows = []
  let ties = 0
  for (const pair of dataset.stepSimpoPairs) {
    if (!pair.trainingEligible) continue
    const family = familyKey(pair.family)
    const pairSplit = validationFamily == null ? 'all' : family === validationFamily ? 'validation' : 'train'
    if (pairSplit !== split) continue
    const chosen = scoreDraftPreferenceFeatures(pair.chosenPref, weights)
    const rejected = scoreDraftPreferenceFeatures(pair.rejectedPref, weights)
    const correct = chosen > rejected ? 1 : 0
    if (chosen === rejected) ties++
    rows.push({ family, correct })
  }
  const byFamily = {}
  for (const family of [...new Set(rows.map((r) => r.family))].sort()) {
    const group = rows.filter((r) => r.family === family)
    byFamily[family] = {
      correct: group.reduce((s, r) => s + r.correct, 0),
      total: group.length,
      accuracy: +mean(group).toFixed(4),
    }
  }
  return {
    correct: rows.reduce((s, r) => s + r.correct, 0),
    total: rows.length,
    accuracy: mean(rows) == null ? null : +mean(rows).toFixed(4),
    ties,
    byFamily,
  }
}

function evaluate(weights) {
  const splits = validationFamily == null ? ['all'] : ['train', 'validation']
  const unitPairs = Object.fromEntries(splits.map((split) => [split, unitMetric(weights, split)]))
  const draftPairs = Object.fromEntries(splits.map((split) => [split, draftMetric(weights, split)]))
  return {
    schema: weights.schema,
    weightsDigest: fingerprintV5MicroWeights(weights),
    unitPairs,
    draftPairs,
  }
}

function closeEnough(actual, expected, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance
}
function evaluateNumericalParity(fixtures, weights) {
  if (fixtures.schema !== 'cfb.micro-runtime-parity-fixtures/1') {
    throw new Error(`unsupported-parity-fixtures-schema:${fixtures.schema}`)
  }
  const tolerance = Number.isFinite(fixtures.tolerance) ? fixtures.tolerance : 0.001
  const report = {
    status: 'passed',
    reference: 'PyTorch student parameters recomputed with JS scorer equations before six-decimal JSON quantization',
    runtime: 'src/compile-v5-local.js scoring functions on the candidate JSON weights',
    tolerance,
    unitCases: 0,
    draftCases: 0,
    unitMaxAbsError: 0,
    unitSlotMismatches: 0,
    unitGateMismatches: 0,
    unitGateActiveCases: 0,
    draftMaxAbsError: 0,
  }
  for (const fixture of fixtures.unit || []) {
    const feat = {
      vec: fixture.features,
      tok: fixture.tokenCount,
      temptationT: fixture.temptationT ?? fixture.features[9],
      cueExcluded: fixture.cueExcluded ?? fixture.features[15],
    }
    const actual = scoreUnitWithWeights(feat, weights)
    const expected = fixture.expected
    const errors = [
      Math.abs(actual.v - expected.v),
      Math.abs(actual.temptationPred - expected.temptationPred),
      ...SLOT_NAMES.map((slot) => Math.abs(actual.probs[slot] - expected.probs[slot])),
    ]
    const maxError = Math.max(...errors)
    report.unitMaxAbsError = Math.max(report.unitMaxAbsError, maxError)
    if (actual.slot !== expected.slot) report.unitSlotMismatches++
    const gateActive = actual.temptationPred < (weights.temptationMin ?? 0.18) && feat.cueExcluded < 0.9
    if (gateActive) report.unitGateActiveCases++
    if (gateActive !== expected.excludedGateActive) report.unitGateMismatches++
    if (maxError > tolerance || actual.slot !== expected.slot || gateActive !== expected.excludedGateActive) {
      report.status = 'failed'
    }
    report.unitCases++
  }
  for (const fixture of fixtures.draft || []) {
    const actual = scoreDraftPreferenceFeatures(fixture.features, weights)
    const error = Math.abs(actual - fixture.expected)
    report.draftMaxAbsError = Math.max(report.draftMaxAbsError, error)
    if (error > tolerance) report.status = 'failed'
    report.draftCases++
  }
  if (!report.unitCases || !report.draftCases) throw new Error('parity-fixtures-must-cover-unit-and-draft-scoring')
  report.unitMaxAbsError = +report.unitMaxAbsError.toFixed(8)
  report.draftMaxAbsError = +report.draftMaxAbsError.toFixed(8)
  if (report.status !== 'passed') throw new Error(`python-js-numerical-parity-failed:${JSON.stringify(report)}`)
  return report
}

const actualFamilies = [...new Set(dataset.unitSamples.map((u) => familyKey(u.family)))].sort()
if (validationFamily != null && !actualFamilies.includes(validationFamily)) {
  throw new Error(`validation-family-not-in-dataset:${validationFamily}`)
}
if (finalBlindTest) {
  if (!mustBeNewFamily) throw new Error('final-blind-test-requires-must-be-new-family')
  if (dataset.finalBlind !== true) throw new Error('final-test-dataset-must-declare-finalBlind:true')
  if (dataset.semanticReview?.status !== 'completed') throw new Error('final-test-requires-completed-semantic-review')
  if (!dataset.semanticReview.reviewer || !dataset.semanticReview.reviewedAt) throw new Error('final-test-semantic-review-needs-reviewer-and-timestamp')
  const lineageReview = dataset.lineageReview
  if (lineageReview?.status !== 'completed' || !lineageReview.reviewer || !lineageReview.reviewedAt
      || !String(lineageReview.newFamilyRationale || '').trim()
      || !Array.isArray(lineageReview.knownFamiliesReviewed)
      || !Array.isArray(lineageReview.knownSourceIdsReviewed)) {
    throw new Error('final-test-requires-completed-family-lineage-audit')
  }
  const lineageChecked = new Set(lineageReview.knownFamiliesReviewed.map((family) => familyKey(family)))
  if (lineageChecked.size !== knownFamilies.size || [...knownFamilies].some((family) => !lineageChecked.has(family))) {
    throw new Error('final-test-lineage-audit-does-not-exactly-cover-training-families')
  }
  const lineageSourceChecked = new Set(lineageReview.knownSourceIdsReviewed.map((id) => String(id).trim()))
  if (lineageSourceChecked.size !== knownSourceIds.size
      || [...knownSourceIds].some((sourceId) => !lineageSourceChecked.has(sourceId))) {
    throw new Error('final-test-lineage-audit-does-not-exactly-cover-training-source-ids')
  }
  const finalSourceIds = new Set(dataset.unitSamples.map((row) => String(row.sourceId || '').trim()).filter(Boolean))
  if (!finalSourceIds.size || dataset.unitSamples.some((row) => !row.sourceId)) throw new Error('final-test-unit-source-id-missing')
  if ([...finalSourceIds].some((sourceId) => knownSourceIds.has(sourceId))) throw new Error('final-test-source-lineage-overlaps-training')
  const lineageSourceIds = new Set((lineageReview.independentSourceIds || []).map((id) => String(id).trim()).filter(Boolean))
  if (lineageSourceIds.size !== finalSourceIds.size || [...finalSourceIds].some((id) => !lineageSourceIds.has(id))) {
    throw new Error('final-test-lineage-audit-source-ids-do-not-match-data')
  }
  if (!dataset.unitStepPairs.every((pair) => finalSourceIds.has(String(pair.sourceId || '').trim()))
      || !dataset.stepSimpoPairs.every((pair) => finalSourceIds.has(String(pair.sourceId || '').trim()))) {
    throw new Error('final-test-pair-source-id-missing-or-unmatched')
  }
  if (dataset.semanticReview.unitSamplesReviewed !== dataset.unitSamples.length
      || dataset.semanticReview.unitPairsReviewed !== dataset.unitStepPairs.length
      || dataset.semanticReview.draftPairsReviewed !== dataset.stepSimpoPairs.length) {
    throw new Error('final-test-semantic-review-denominators-do-not-match')
  }
  const hasItemReview = (item, kind) => {
    const audit = item.labelAudit
    const review = audit?.semanticReview
    const basisPresent = kind === 'unit'
      ? Boolean(audit?.labelRule)
      : kind === 'unit-pair'
        ? Boolean(audit?.winRule && audit?.loseRule)
        : Boolean(audit?.reason || item.negType)
    const provenancePresent = Boolean(audit?.source) && basisPresent
    return provenancePresent && review?.status === 'confirmed'
      && Boolean(review.reviewer)
      && Boolean(String(review.rationale || '').trim())
  }
  if (!dataset.unitSamples.every((row) => row.trainingEligible === true && hasItemReview(row, 'unit'))
      || !dataset.unitStepPairs.every((pair) => pair.trainingEligible === true && hasItemReview(pair, 'unit-pair'))
      || !dataset.stepSimpoPairs.every((pair) => pair.trainingEligible === true && hasItemReview(pair, 'draft-pair'))) {
    throw new Error('final-test-contains-unreviewed-or-ineligible-labels')
  }
  if ((dataset.stats?.unitPairEndpointReuse?.cap ?? Infinity) > 2) throw new Error('final-test-unit-pair-endpoint-cap-exceeds-2')
  if (actualFamilies.length !== 1) throw new Error(`final-test-must-have-exactly-one-family:${actualFamilies.length}`)
  if ([...actualFamilies].some((family) => knownFamilies.has(family))) throw new Error('final-test-family-overlaps-training-families')
  if (validationFamily !== actualFamilies[0]) throw new Error('final-test-validation-family-must-be-the-new-family')
}
const report = {
  schema: 'cfb.micro-js-pair-eval/3',
  runtimeScorer: 'src/compile-v5-local.js:extractUnitFeatures (dataset-built JS vectors) + scoreUnitWithWeights + scoreDraftPreferenceFeatures',
  unitPairRankScore: 'pair accuracy compares scoreUnitWithWeights(...).v, including lambda * tokenCount; the same call applies EXCLUDED negative-priming gate to slot probabilities used by selection and reports gate counts',
  weightsPath: path.relative(ROOT, weightsPath),
  datasetPath: path.relative(ROOT, datasetPath),
  datasetSchema: dataset.schema,
  holdoutTouched: dataset.holdoutTouched,
  familyCount: actualFamilies.length,
  families: actualFamilies,
  unitPairEndpointAudit,
  validationFamily,
  validationFamilyWasUsedForCheckpointSelection: validationFamily != null && !finalBlindTest,
  evaluationPurpose: finalBlindTest ? 'final-independent-family' : 'development-or-candidate-validation',
  knownFamiliesExcludedFromFinalTest: finalBlindTest ? [...knownFamilies].sort() : undefined,
  familySplit: validationFamily == null ? 'all-rows (no train/validation split requested)' : {
    train: actualFamilies.filter((family) => family !== validationFamily),
    validation: [validationFamily],
  },
  production: evaluate(productionWeights),
  candidate: evaluate(candidateWeights),
  numericalParity: parityFixturesPath
    ? evaluateNumericalParity(JSON.parse(fs.readFileSync(parityFixturesPath, 'utf8')), candidateWeights)
    : null,
}
if (validationFamily != null && !report.candidate.unitPairs.validation.total) {
  throw new Error('no-audited-unit-pairs-in-validation-family')
}
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
