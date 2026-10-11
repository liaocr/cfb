#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_REVIEW_MODE, AI_REVIEWER_ID, IMPORTANCE_WEIGHTS, readJson, readJsonl, sha256, stableCaseId, validateAnnotation, validateFamilyIsolation, validatePrediction } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const THRESHOLDS = [
  'minBlindFamilies', 'minCasesPerBlindFamily', 'weightedFactRecallOverallMin',
  'weightedFactRecallPerBlindFamilyMin', 'criticalOmissionsPerBlindFamilyMax',
  'uncertainMustPreservePerBlindFamilyMax', 'contradictoryClaimsPerBlindFamilyMax',
  'unsupportedClaimsPer100Max', 'uncertainClaimsPer100Max', 'medianDraftToRawCharRatioMax',
]
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const frozenGateDigest = (gate) => {
  const copy = structuredClone(gate)
  delete copy.frozenConfigSha256
  return sha256(stable(copy))
}
export const registryDigest = (families) => sha256(stable([...families].sort()))

function validateGates(gate, blindFamilies) {
  const errors = []
  const blockers = []
  if (gate?.schema !== 'cfb.micro-generator-gates/1') errors.push('gate-schema-mismatch')
  const reviewPolicy = gate?.reviewPolicy || {}
  if (reviewPolicy.mode !== AI_REVIEW_MODE || reviewPolicy.reviewerType !== 'ai' || reviewPolicy.reviewerId !== AI_REVIEWER_ID ||
      reviewPolicy.reviewerCount !== 1 || reviewPolicy.humanReviewerCount !== 0 || reviewPolicy.independentSecondReview !== false) {
    errors.push('gate-ai-single-review-policy-mismatch')
  }
  if (gate?.status !== 'frozen') blockers.push('gates-not-frozen')
  if (!gate?.freezeAt || !Number.isFinite(Date.parse(gate.freezeAt))) blockers.push('gate-freeze-timestamp-missing')
  if (!Array.isArray(gate?.knownFamilyNames)) errors.push('knownFamilyNames-must-be-array')
  const registry = gate?.blindFamilyRegistry
  if (registry?.status !== 'frozen') blockers.push('blind-family-registry-not-frozen')
  if (!Array.isArray(registry?.families) || !registry.families.length) blockers.push('no-blind-family-registered')
  const registered = [...new Set(registry?.families || [])].sort()
  if (registered.length !== (registry?.families || []).length) errors.push('duplicate-blind-family-registration')
  if (registry?.registrySha256 !== registryDigest(registry?.families || [])) errors.push('blind-family-registry-hash-mismatch')
  const known = new Set(gate?.knownFamilyNames || [])
  for (const family of registered) if (known.has(family)) errors.push(`blind-family-is-not-new:${family}`)
  if (stable(registered) !== stable([...blindFamilies].sort())) errors.push('registered-blind-families-do-not-match-evaluated-blind-families')
  if (gate?.frozenConfigSha256 !== frozenGateDigest(gate || {})) errors.push('frozen-gate-config-hash-mismatch')
  const thresholds = gate?.thresholds || {}
  for (const name of THRESHOLDS) {
    const value = thresholds[name]
    if (value == null) blockers.push(`threshold-not-frozen:${name}`)
    else if (!Number.isFinite(value) || value < 0) errors.push(`invalid-threshold:${name}`)
    else if (['minBlindFamilies', 'minCasesPerBlindFamily', 'criticalOmissionsPerBlindFamilyMax', 'uncertainMustPreservePerBlindFamilyMax', 'contradictoryClaimsPerBlindFamilyMax'].includes(name)) {
      if (!Number.isInteger(value)) errors.push(`threshold-must-be-integer:${name}`)
    } else if (value > 1 && name.toLowerCase().includes('recall')) errors.push(`ratio-threshold-out-of-range:${name}`)
  }
  const weights = gate?.factImportanceWeights
  if (!weights || Object.keys(IMPORTANCE_WEIGHTS).some((name) => !Number.isFinite(weights[name]) || weights[name] <= 0)) errors.push('importance-weights-invalid')
  return { errors, blockers }
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

function caseMetrics(annotation, prediction, weights) {
  const outcomes = new Map((prediction.review?.facts || []).map((row) => [row.factId, row.status]))
  const must = annotation.facts.filter((fact) => fact.mustPreserve)
  const weightTotal = must.reduce((sum, fact) => sum + weights[fact.importance], 0)
  const weightPreserved = must.reduce((sum, fact) => sum + (outcomes.get(fact.factId) === 'preserved' ? weights[fact.importance] : 0), 0)
  const claims = prediction.review?.claims || []
  const rawLength = annotation.raw.length
  return {
    caseId: annotation.caseId,
    family: annotation.family,
    split: annotation.finalSplit,
    rawChars: rawLength,
    draftChars: prediction.draft.length,
    draftToRawCharRatio: rawLength > 0 ? prediction.draft.length / rawLength : null,
    mustPreserveFactCount: must.length,
    mustPreserveWeight: weightTotal,
    weightedFactRecall: weightTotal > 0 ? weightPreserved / weightTotal : null,
    criticalOmissions: must.filter((fact) => fact.importance === 'critical' && ['omitted', 'contradicted'].includes(outcomes.get(fact.factId))).length,
    uncertainMustPreserve: must.filter((fact) => outcomes.get(fact.factId) === 'uncertain').length,
    contradictedMustPreserve: must.filter((fact) => outcomes.get(fact.factId) === 'contradicted').length,
    claimCount: claims.length,
    unsupportedClaims: claims.filter((claim) => claim.status === 'unsupported').length,
    contradictoryClaims: claims.filter((claim) => claim.status === 'contradictory').length,
    uncertainClaims: claims.filter((claim) => claim.status === 'uncertain').length,
  }
}

function aggregate(rows) {
  const factsWeight = rows.reduce((sum, row) => sum + row.mustPreserveWeight, 0)
  const recoveredWeight = rows.reduce((sum, row) => sum + (row.weightedFactRecall ?? 0) * row.mustPreserveWeight, 0)
  const claimCount = rows.reduce((sum, row) => sum + row.claimCount, 0)
  const unsupported = rows.reduce((sum, row) => sum + row.unsupportedClaims, 0)
  const uncertainClaims = rows.reduce((sum, row) => sum + row.uncertainClaims, 0)
  return {
    cases: rows.length,
    mustPreserveFacts: rows.reduce((sum, row) => sum + row.mustPreserveFactCount, 0),
    weightedFactRecall: factsWeight > 0 ? recoveredWeight / factsWeight : null,
    criticalOmissions: rows.reduce((sum, row) => sum + row.criticalOmissions, 0),
    uncertainMustPreserve: rows.reduce((sum, row) => sum + row.uncertainMustPreserve, 0),
    contradictedMustPreserve: rows.reduce((sum, row) => sum + row.contradictedMustPreserve, 0),
    unsupportedClaims: unsupported,
    contradictoryClaims: rows.reduce((sum, row) => sum + row.contradictoryClaims, 0),
    uncertainClaims: rows.reduce((sum, row) => sum + row.uncertainClaims, 0),
    claims: claimCount,
    unsupportedClaimsPer100: claimCount ? (unsupported / claimCount) * 100 : 0,
    uncertainClaimsPer100: claimCount ? (uncertainClaims / claimCount) * 100 : 0,
    medianDraftToRawCharRatio: median(rows.map((row) => row.draftToRawCharRatio)),
  }
}

export function evaluate({ annotations, predictions, gates }) {
  const integrityErrors = []
  const blockers = []
  const annotationById = new Map()
  for (const row of annotations) {
    integrityErrors.push(...validateAnnotation(row, { requireFinalSplit: true }))
    if (annotationById.has(row.caseId)) integrityErrors.push(`duplicate annotation caseId:${row.caseId}`)
    annotationById.set(row.caseId, row)
  }
  integrityErrors.push(...validateFamilyIsolation(annotations, { splitKey: 'finalSplit' }))
  const predictionById = new Map()
  const modelRows = new Map()
  for (const row of predictions) {
    if (predictionById.has(row.caseId)) integrityErrors.push(`duplicate prediction caseId:${row.caseId}`)
    predictionById.set(row.caseId, row)
    const annotation = annotationById.get(row.caseId)
    integrityErrors.push(...validatePrediction(row, annotation, { gates }))
    const model = row.model || {}
    const modelKey = stable({ id: model.id, revision: model.revision, weightsSha256: model.weightsSha256, quantization: model.quantization })
    const group = modelRows.get(modelKey) || { model, latencies: [] }
    if (Number.isFinite(row.latencyMs)) group.latencies.push(row.latencyMs)
    modelRows.set(modelKey, group)
  }
  if (modelRows.size > 1) integrityErrors.push('one evaluation report must contain predictions from exactly one checkpoint')

  const blindCases = annotations.filter((row) => row.finalSplit === 'blind')
  const blindFamilies = [...new Set(blindCases.map((row) => row.family))].sort()
  const gateState = validateGates(gates, blindFamilies)
  integrityErrors.push(...gateState.errors)
  blockers.push(...gateState.blockers)
  if (!blindCases.length) blockers.push('no-blind-cases')
  const evalRows = []
  for (const annotation of annotations) {
    const prediction = predictionById.get(annotation.caseId)
    if (!prediction) {
      if (annotation.finalSplit === 'blind') blockers.push(`missing-blind-prediction:${annotation.caseId}`)
      continue
    }
    if (annotation.finalSplit === 'blind') {
      if (annotation.annotationStatus !== 'adjudicated' || annotation.sourceCoverage !== 'complete' || annotation.facts.filter((fact) => fact.mustPreserve).length === 0) blockers.push(`source-facts-not-complete:${annotation.caseId}`)
      if (prediction.review?.status !== 'adjudicated') blockers.push(`prediction-not-adjudicated:${annotation.caseId}`)
    }
    if (prediction.review?.status === 'adjudicated' && annotation.annotationStatus === 'adjudicated' && annotation.sourceCoverage === 'complete') {
      evalRows.push(caseMetrics(annotation, prediction, gates?.factImportanceWeights || IMPORTANCE_WEIGHTS))
    }
  }
  for (const prediction of predictions) if (!annotationById.has(prediction.caseId)) integrityErrors.push(`prediction-without-annotation:${prediction.caseId}`)

  const familyRows = new Map()
  for (const row of evalRows) {
    const list = familyRows.get(row.family) || []
    list.push(row); familyRows.set(row.family, list)
  }
  const byFamily = Object.fromEntries([...familyRows].sort(([a], [b]) => a.localeCompare(b)).map(([family, rows]) => [family, aggregate(rows)]))
  const blindMetrics = aggregate(evalRows.filter((row) => row.split === 'blind'))
  const thresholds = gates?.thresholds || {}
  const failures = []
  if (blindFamilies.length < (thresholds.minBlindFamilies ?? Infinity)) failures.push('minBlindFamilies')
  for (const family of blindFamilies) {
    const m = byFamily[family]
    if (!m || m.cases < (thresholds.minCasesPerBlindFamily ?? Infinity)) failures.push(`minCasesPerBlindFamily:${family}`)
    if (m && m.weightedFactRecall != null && m.weightedFactRecall < (thresholds.weightedFactRecallPerBlindFamilyMin ?? Infinity)) failures.push(`weightedFactRecallPerBlindFamilyMin:${family}`)
    if (m && m.criticalOmissions > (thresholds.criticalOmissionsPerBlindFamilyMax ?? -1)) failures.push(`criticalOmissionsPerBlindFamilyMax:${family}`)
    if (m && m.uncertainMustPreserve > (thresholds.uncertainMustPreservePerBlindFamilyMax ?? -1)) failures.push(`uncertainMustPreservePerBlindFamilyMax:${family}`)
    if (m && m.contradictoryClaims > (thresholds.contradictoryClaimsPerBlindFamilyMax ?? -1)) failures.push(`contradictoryClaimsPerBlindFamilyMax:${family}`)
    if (m && m.unsupportedClaimsPer100 > (thresholds.unsupportedClaimsPer100Max ?? -1)) failures.push(`unsupportedClaimsPer100Max:${family}`)
    if (m && m.uncertainClaimsPer100 > (thresholds.uncertainClaimsPer100Max ?? -1)) failures.push(`uncertainClaimsPer100Max:${family}`)
  }
  if (blindMetrics.weightedFactRecall != null && blindMetrics.weightedFactRecall < (thresholds.weightedFactRecallOverallMin ?? Infinity)) failures.push('weightedFactRecallOverallMin')
  if (blindMetrics.medianDraftToRawCharRatio != null && blindMetrics.medianDraftToRawCharRatio > (thresholds.medianDraftToRawCharRatioMax ?? -1)) failures.push('medianDraftToRawCharRatioMax')
  if (integrityErrors.length) blockers.push('integrity-errors-present')
  const status = integrityErrors.length ? 'invalid-data'
    : blockers.length ? 'not-evaluable'
      : failures.length ? 'fail' : 'pass'
  const sourceDigest = sha256(stable(annotations.map((row) => ({ caseId: row.caseId, family: row.family, split: row.finalSplit,
    provenanceSplit: row.provenanceSplit || null, rawSha256: sha256(row.raw), ctxSha256: sha256(row.ctx), facts: row.facts,
    sourceCoverage: row.sourceCoverage, annotationStatus: row.annotationStatus, reviewers: row.reviewers,
    reviewProvenance: row.reviewProvenance || null, referenceReview: row.referenceReview }))))
  const predictionDigest = sha256(stable(predictions.map((row) => ({ caseId: row.caseId, inputSha256: row.inputSha256,
    draftSha256: sha256(row.draft), model: row.model, promptVersion: row.promptVersion, promptSha256: row.promptSha256,
    decoding: row.decoding, blindProtocol: row.blindProtocol || null, latencyMs: row.latencyMs,
    promptTokens: row.promptTokens, completionTokens: row.completionTokens, review: row.review }))))
  return {
    schema: 'cfb.micro-generator-evaluation-report/1',
    status,
    gateId: gates?.gateId || null,
    gateConfigSha256: gates?.frozenConfigSha256 || null,
    blindRegistrySha256: gates?.blindFamilyRegistry?.registrySha256 || null,
    sourceAnnotationSetSha256: sourceDigest,
    predictionSetSha256: predictionDigest,
    modelCandidates: [...modelRows.values()].map(({ model, latencies }) => ({
      id: model.id || null, revision: model.revision || null, weightsSha256: model.weightsSha256 || null,
      quantization: model.quantization || null, artifactBytes: model.artifactBytes ?? null,
      parameterCount: model.parameterCount ?? null, medianLatencyMs: median(latencies),
    })),
    reviewPolicy: { mode: AI_REVIEW_MODE, reviewerType: 'ai', reviewerId: AI_REVIEWER_ID, reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
    counts: { annotations: annotations.length, predictions: predictions.length, blindCases: blindCases.length, blindFamilies: blindFamilies.length, adjudicatedEvaluationCases: evalRows.length, aiSingleReviewerEvaluationCases: evalRows.length },
    overallBlind: blindMetrics,
    blindByFamily: Object.fromEntries(blindFamilies.map((family) => [family, byFamily[family] || null])),
    allScoredCasesByFamily: byFamily,
    gateFailures: failures,
    blockers: [...new Set(blockers)],
    integrityErrors,
    interpretation: 'Metrics use complete review labels from one explicitly identified AI reviewer; no independent human review is implied. Weighted recall and draft/raw ratio are computed from JS UTF-16 string lengths/fact labels; they are not automatic semantic judgments or tokenizer-based token compression.',
  }
}

function parseArgs(argv) {
  const out = { cases: null, predictions: null, gates: null, report: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cases') out.cases = argv[++i]
    else if (argv[i] === '--predictions') out.predictions = argv[++i]
    else if (argv[i] === '--gates') out.gates = argv[++i]
    else if (argv[i] === '--out') out.report = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!out.cases || !out.predictions || !out.gates) throw new Error('usage: node tools/micro-generator/evaluate.mjs --cases FILE.jsonl --predictions FILE.jsonl --gates FILE.json [--out FILE.json]')
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2))
    const report = evaluate({ annotations: readJsonl(path.resolve(ROOT, a.cases)), predictions: readJsonl(path.resolve(ROOT, a.predictions)), gates: readJson(path.resolve(ROOT, a.gates)) })
    const text = JSON.stringify(report, null, 2) + '\n'
    if (a.report) fs.writeFileSync(path.resolve(ROOT, a.report), text)
    console.log(JSON.stringify({ status: report.status, blindCases: report.counts.blindCases, blindFamilies: report.counts.blindFamilies, blockers: report.blockers.length, gateFailures: report.gateFailures.length, integrityErrors: report.integrityErrors.length }))
    if (report.status === 'invalid-data') process.exitCode = 2
  } catch (error) {
    console.error(`[micro-generator-evaluate] ${error.message}`)
    process.exitCode = 1
  }
}
