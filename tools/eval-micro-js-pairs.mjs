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
import { isMode1PairEligible, isMode1CaptureAuditEligible } from './helpers/mode1-quality.mjs'

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
// --validate-dataset-only：只跑 final-blind 的结构/血缘/审核校验，不打任何分数、不写报告。
// 用途：一次性盲测集在启用前做预检，且预检过程不可能泄露任何模型分数给调参者。
const validateDatasetOnly = args.includes('--validate-dataset-only')
const mustBeNewFamily = args.includes('--must-be-new-family')
const SLOT_NAMES = ['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE']
const DEV_FAMILIES = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
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
// ── 小样本评测统计（v14.20）：二项比例的 Wilson 区间，避免 138/40 对样本上直接比较点估计
const wilsonInterval = (successes, total, z = 1.96) => {
  if (!total) return null
  const phat = successes / total
  const denom = 1 + (z * z) / total
  const center = (phat + (z * z) / (2 * total)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom
  return { lower: +Math.max(0, center - half).toFixed(4), upper: +Math.min(1, center + half).toFixed(4) }
}
const pairStats = (rows) => {
  const total = rows.length
  const correct = rows.reduce((s, r) => s + r.correct, 0)
  const ties = rows.filter((r) => r.tie).length
  const halfCredit = correct + 0.5 * ties
  return {
    correct,
    total,
    ties,
    accuracy: total ? +(correct / total).toFixed(4) : null,
    tiesPolicy: 'strict: a tied pair scores 0 (headline metric, gate-comparable)',
    accuracyWithTiesHalfCredit: total ? +(halfCredit / total).toFixed(4) : null,
    wilson95: wilsonInterval(correct, total),
    wilsonLower95: wilsonInterval(correct, total)?.lower ?? null,
    wilsonLowerOneSided95: wilsonInterval(correct, total, 1.645)?.lower ?? null,
  }
}
const groupStats = (rows, keyOf) => {
  const out = {}
  for (const key of [...new Set(rows.map(keyOf))].sort()) {
    out[key] = pairStats(rows.filter((r) => keyOf(r) === key))
  }
  return out
}

const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
if (dataset.schema !== 'cfb.micro-dev-dataset/3') throw new Error(`unsupported-dataset-schema:${dataset.schema}`)
if (dataset.holdoutTouched !== false) throw new Error('refusing-dataset-with-holdout-touch')
if (!Array.isArray(dataset.unitSamples) || !Array.isArray(dataset.unitStepPairs) || !Array.isArray(dataset.stepSimpoPairs)) {
  throw new Error('micro-pair-eval-missing-arrays')
}
const expectedPairSplit = finalBlindTest ? 'final-blind' : 'dev'
const devFamilyAllowlist = new Set((dataset.stats?.devFamilyAllowlist || []).map((family) => familyKey(family)))
if (!finalBlindTest && (devFamilyAllowlist.size !== DEV_FAMILIES.size
    || [...DEV_FAMILIES].some((family) => !devFamilyAllowlist.has(family)))) {
  throw new Error('dataset-dev-family-allowlist-mismatch')
}
for (const [index, pair] of dataset.stepSimpoPairs.entries()) {
  if (pair?.split !== expectedPairSplit) {
    throw new Error(`draft-pair-split-missing-or-invalid:${index}:${pair?.split ?? 'missing'}`)
  }
  if (!finalBlindTest && !devFamilyAllowlist.has(familyKey(pair?.family))) {
    throw new Error(`draft-pair-family-not-in-dev-allowlist:${index}:${pair?.family ?? 'missing'}`)
  }
  if (!isMode1PairEligible(pair, { requireRecorded: true })) {
    throw new Error(`draft-pair-missing-clean-exact-text-bound-audit:${index}`)
  }
}
for (const [index, sample] of (dataset.handSamples || []).entries()) {
  if (sample?.trainingEligible !== true) continue
  if (!isMode1CaptureAuditEligible(sample)) {
    throw new Error(`positive-capture-missing-clean-exact-text-bound-audit-or-self-contained-target:${index}`)
  }
  const expectedSourceId = `mode1-capture:${sample.traj || 'unknown'}:${sample.id}`
  const linked = dataset.stepSimpoPairs.filter((pair) => pair.sourceId === expectedSourceId)
  const linkedTrainable = linked.filter((pair) => pair.trainingEligible === true)
  if (linkedTrainable.length !== sample.trainableTargetsAdded
      || linkedTrainable.some((pair) => pair.provenance?.qualityAudit?.textSha256 !== sample.qualityAudit?.textSha256)) {
    throw new Error(`positive-capture-not-connected-to-exact-training-target:${index}`)
  }
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
// 长度分层阈值：matched = |delta token| <= NEAR（与数据集构造的 near-length 口径一致），near = 次近，far = 明显不同长度
const NEAR_LENGTH_TOKENS = Number(process.env.CFB_MICRO_NEAR_LENGTH_TOKENS || dataset.stats?.pairConstruction?.nearLengthTokens || 3)
const NEAR_LENGTH_BAND = Number(process.env.CFB_MICRO_NEAR_LENGTH_BAND || 8)
const lengthStratumOf = (deltaTok) => {
  const abs = Math.abs(deltaTok)
  if (abs <= NEAR_LENGTH_TOKENS) return 'matched'
  if (abs <= NEAR_LENGTH_BAND) return 'near'
  return 'far'
}
const candidateWeights = loadV5MicroWeights(weightsPath)
const productionWeights = V5_MICRO_WEIGHTS

const EXPECTED_FEATURE_DIM = (() => {
  const stats = (() => { try { return JSON.parse(fs.readFileSync(datasetPath, 'utf8')).stats || {} } catch { return {} } })()
  return Number(stats.featureDim) || (19 + Math.max(0, Math.floor(Number(stats.textHashBuckets) || 0)))
})()
function makeUnitFeatures(row, index) {
  if (!row || !Array.isArray(row.features) || row.features.length !== EXPECTED_FEATURE_DIM || !Number.isFinite(row.tokenCount)) {
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
    const scored = { ...result, tok: feat.tok, tokenPenalty, excludedGateActive }
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
    // 与 λ·tok 解耦的纯排序分数：v 已扣除 lambda*tok，加回后即「不依赖长度惩罚」的名次分
    const rankOnlyWin = +(win.v + win.tokenPenalty).toFixed(6)
    const rankOnlyLose = +(lose.v + lose.tokenPenalty).toFixed(6)
    const deltaTok = +(win.tok - lose.tok).toFixed(4)
    if (!Number.isFinite(deltaTok)) {
      throw new Error(`unit-pair-token-delta-non-finite:${pair.sourceId}`)
    }
    rows.push({
      family,
      sourceId: pair.sourceId,
      correct,
      tie: win.v === lose.v,
      lengthGap: Math.abs(deltaTok),
      lengthStratum: lengthStratumOf(deltaTok),
      tokenDelta: deltaTok,
      rankOnlyCorrect: rankOnlyWin > rankOnlyLose ? 1 : 0,
      rankOnlyTie: rankOnlyWin === rankOnlyLose,
    })
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
    tokenPenaltyDecoupledMetricReported: true,
    tokenPenaltyCoupledMetricRole: 'headline accuracy stays on the production rank score v; scoreWithoutTokenPenalty reports the same pairs with lambda*tokenCount removed',
    tokenPenaltyMean: meanNumber(tokenPenalties) == null ? null : +meanNumber(tokenPenalties).toFixed(6),
    tokenPenaltyMin: tokenPenalties.length ? +Math.min(...tokenPenalties).toFixed(6) : null,
    tokenPenaltyMax: tokenPenalties.length ? +Math.max(...tokenPenalties).toFixed(6) : null,
    excludedGateActiveEndpoints: endpointScores.filter((score) => score.excludedGateActive).length,
    scoredAsExcludedAfterGate: endpointScores.filter((score) => score.slot === 'EXCLUDED').length,
    scoredAsNoiseAfterGate: endpointScores.filter((score) => score.slot === 'NOISE').length,
  }
  const stats = pairStats(rows)
  const rankOnlyRows = rows.map((r) => ({ correct: r.rankOnlyCorrect, tie: r.rankOnlyTie }))
  const lengthStratified = groupStats(rows, (r) => r.lengthStratum)
  const longerWinner = rows.filter((r) => r.tokenDelta > 0)
  const shorterWinner = rows.filter((r) => r.tokenDelta < 0)
  const equalLength = rows.filter((r) => r.tokenDelta === 0)
  return {
    ...stats,
    ties,
    byFamily,
    maxEndpointDegree,
    endpointReuseCap: configuredCap ?? null,
    // 长度分层：matched 子集是「长度不能解释胜负」的最强证据；far 子集暴露长度捷径
    lengthStratified,
    lengthStratumBounds: {
      matched: `|delta token| <= ${NEAR_LENGTH_TOKENS}`,
      near: `${NEAR_LENGTH_TOKENS} < |delta token| <= ${NEAR_LENGTH_BAND}`,
      far: `|delta token| > ${NEAR_LENGTH_BAND}`,
    },
    lengthMatchedSubset: lengthStratified.matched ?? { correct: 0, total: 0, accuracy: null, wilson95: null },
    lengthMatchedShare: rows.length ? +((lengthStratified.matched?.total ?? 0) / rows.length).toFixed(4) : null,
    medianLengthGap: rows.length ? +rows.map((r) => r.lengthGap).sort((a, b) => a - b)[Math.floor(rows.length / 2)].toFixed(4) : null,
    lengthShortcutAudit: {
      note: 'a longer winner means lambda*tokenCount works against the label; accuracy there cannot be a length shortcut',
      winnerLonger: pairStats(longerWinner),
      winnerShorter: pairStats(shorterWinner),
      equalLength: pairStats(equalLength),
    },
    // 与 λ·tok 解耦的名次分：两套分数必须给出同一结论，否则结论来自长度惩罚而非排序能力
    scoreWithoutTokenPenalty: {
      rankScoreDefinition: 'v + lambda*tokenCount (lambda*tokenCount removed from the compared score)',
      ...pairStats(rankOnlyRows),
      agreementWithFullScore: rows.length
        ? +(rows.filter((r) => (r.correct === 1) === (r.rankOnlyCorrect === 1)).length / rows.length).toFixed(4)
        : null,
    },
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
    rows.push({ family, correct, tie: chosen === rejected })
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
    ...pairStats(rows),
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
// 判定并列的阈值：期望概率 top1-top2 间隙 <= 2e-3 时，argmax 的胜负由六位小数量化噪声决定，
// 此时槽位翻转不算 parity 失败（本地实测存在间隙恰为 0 的单元）。
const SLOT_NEAR_TIE_EPS = 2e-3
// 门控阈值贴边带：|temptationPred - temptationMin| 或 |cueExcluded - 0.9| 在带内即不判失败。
const GATE_BOUNDARY_EPS = 2e-3
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
    // 2026-10-04：并列带/贴边带内的差异不计失败（parity 校验的是方程一致性，不是并列时的胜者）。
    slotMismatchesIgnoredNearTie: 0,
    gateMismatchesIgnoredBoundary: 0,
    slotNearTieEps: SLOT_NEAR_TIE_EPS,
    gateBoundaryEps: GATE_BOUNDARY_EPS,
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
    const expectedProbs = SLOT_NAMES.map((slot) => Number(expected.probs?.[slot] ?? NaN))
    const sortedExpected = expectedProbs.slice().sort((a, b) => b - a)
    const nearTie = Number.isFinite(sortedExpected[0]) && Number.isFinite(sortedExpected[1])
      ? (sortedExpected[0] - sortedExpected[1]) <= SLOT_NEAR_TIE_EPS
      : false
    const slotMismatch = actual.slot !== expected.slot
    if (slotMismatch) {
      if (nearTie) report.slotMismatchesIgnoredNearTie++
      else report.unitSlotMismatches++
    }
    const gateActive = actual.temptationPred < (weights.temptationMin ?? 0.18) && feat.cueExcluded < 0.9
    if (gateActive) report.unitGateActiveCases++
    const gateMismatch = gateActive !== expected.excludedGateActive
    const onBoundary = Math.abs(actual.temptationPred - (weights.temptationMin ?? 0.18)) <= GATE_BOUNDARY_EPS
      || Math.abs(feat.cueExcluded - 0.9) <= 1e-6
    if (gateMismatch) {
      if (onBoundary) report.gateMismatchesIgnoredBoundary++
      else report.unitGateMismatches++
    }
    if (maxError > tolerance || report.unitSlotMismatches > 0 || report.unitGateMismatches > 0) {
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
if (validateDatasetOnly) {
  const endpointSummary = dataset.stats?.unitPairEndpointReuse || {}
  console.log(JSON.stringify({
    status: 'dataset-structure-valid',
    schema: dataset.schema,
    finalBlind: dataset.finalBlind === true,
    family: actualFamilies,
    validationFamily,
    unitSamples: dataset.unitSamples.length,
    unitStepPairs: dataset.unitStepPairs.length,
    draftPairs: dataset.stepSimpoPairs.length,
    endpointCap: endpointSummary.cap ?? null,
    maxEndpointDegree: endpointSummary.maxDegree ?? null,
    semanticReview: {
      status: dataset.semanticReview?.status,
      units: dataset.semanticReview?.unitSamplesReviewed,
      unitPairs: dataset.semanticReview?.unitPairsReviewed,
      draftPairs: dataset.semanticReview?.draftPairsReviewed,
    },
    lineageReview: {
      status: dataset.lineageReview?.status,
      knownFamilies: dataset.lineageReview?.knownFamiliesReviewed?.length ?? null,
      knownSourceIds: dataset.lineageReview?.knownSourceIdsReviewed?.length ?? null,
      independentSourceIds: dataset.lineageReview?.independentSourceIds?.length ?? null,
    },
    note: 'structure only: no scoring was performed, so no accuracy can leak into candidate tuning',
  }, null, 2))
  process.exit(0)
}
const report = {
  schema: 'cfb.micro-js-pair-eval/4',
  runtimeScorer: 'src/compile-v5-local.js:extractUnitFeatures (dataset-built JS vectors) + scoreUnitWithWeights + scoreDraftPreferenceFeatures',
  unitPairRankScore: 'pair accuracy compares scoreUnitWithWeights(...).v, including lambda * tokenCount; the same call applies EXCLUDED negative-priming gate to slot probabilities used by selection and reports gate counts',
  metricsPolicy: {
    ties: 'strict (ties count 0) is the headline and gate-comparable metric; accuracyWithTiesHalfCredit is reported alongside',
    smallSampleStatistics: 'Wilson 95% interval and one-sided 95% lower bound per metric; with 138/40 pairs a 4pp difference is inside noise, so gates must be read with the lower bound',
    lengthStratification: 'unit pairs are bucketed by |delta token|; the matched bucket (length cannot explain the outcome) carries the load-bearing claim',
    tokenPenaltyDecoupling: 'every unit metric is also computed with lambda*tokenCount added back, so conclusions cannot come from the length penalty alone',
  },
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
