#!/usr/bin/env node
// Strict LOCAL planning/import only. Never opens credentials, invokes a provider,
// launches inference/training, consumes a blind ledger or signs a VALID ruler.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl, inputSha256, sha256 } from './lib.mjs'
import { digestJson } from './review-contract.mjs'
import { PROGRAM_DIR, fileRef, readObject, writeFresh } from './program.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ARMS = ['raw-a', 'raw-b', 'reference']
const hex = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v
const equal = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const identity = (v) => digestJson(canon(v))

export function readerAuthorizationScope(plan) {
  return identity({ id: plan.id, receiver: plan.receiver, servedVersion: plan.servedVersion,
    channelScopeSha256: plan.channelScopeSha256, toolsSha256: plan.toolsSha256, decodingSha256: plan.decodingSha256,
    cases: plan.cases, arms: plan.arms,
    limits: Object.fromEntries(Object.entries(plan.requestBudget || {}).filter(([k]) => !['approvalRef', 'authorized'].includes(k))) })
}
export function makeReaderStudyPlan(root = ROOT) {
  const cases = readJsonl(path.join(root, PROGRAM_DIR, 'reviewed-dev.jsonl'))
  const plan = { schema: 'cfb.reader-study-plan/1', id: 'reference-ceiling-development-2026-10-12', scope: 'already-exposed development references, not new blind or student promotion',
    preregistration: fileRef(root, 'tools/micro-generator/continuation-prereg.json'), annotations: fileRef(root, PROGRAM_DIR + '/reviewed-dev.jsonl'), completeReviews: fileRef(root, PROGRAM_DIR + '/complete-reviews.jsonl'),
    receiver: 'DeepSeek-V4.1-Flash', servedVersion: null, channelScopeSha256: null, toolsSha256: null, decodingSha256: null,
    channelScopeRef: null, toolsRef: null, decodingRef: null,
    arms: ARMS, cases: cases.map((a) => ({ caseId: a.caseId, family: a.family, inputSha256: inputSha256(a), rawSha256: sha256(a.raw), referenceSha256: sha256(a.referenceDraft), ctxSha256: sha256(a.ctx), birthStateRef: null })),
    requestBudget: { authorized: false, approvalRef: null, maximumPaidRequests: 0, maximumRetriesPerRequest: 0, maximumUsd: 0, credentialsInPlanAllowed: false },
    authorizationGate: 'Local programme approval is not a paid-call allocation. Bind a separate user-authorized scope/limits receipt before importing actual executions.',
    stateCapture: 'State schema cfb.reader-birth-state/1: case/input/raw/ctx hashes, compressorCtx, reasoningMessageIndex, exact requestBeforeReplacement, bound environmentSnapshots; changing only the designated reasoning field is allowed.',
    observationUnit: 'Initial continuation request/response and bound declared outcome review per arm. A full multi-round execution trajectory and cumulative bills are additional evidence; this importer does not certify either.',
    accounting: 'All registered cases remain in denominator, including rejected/missing/failure/fallback. Observed unique provider IDs are only a lower bound on full-study calls; character ratios are not bills.',
    expectedMinimumContinuationArms: cases.length * ARMS.length,
    independentSampleCount: null, status: 'blocked-missing-live-state-version-channel-and-budget',
    blockers: ['real source birth-state snapshots not provided', 'actual served version/channel/tools/decoding not pinned', 'paid-call scope and resource budget not authorized'],
    implementation: { localPlannerImporterSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))) },
    executeImplemented: false, paidApiCalls: 0, gpuRuns: 0, newBlindConsumed: 0 }
  return { ...plan, planSha256: digestJson(plan) }
}
function loadBoundBytes(root, ref, label, errors) {
  if (!ref || !hex(ref.sha256) || !nonempty(ref.path) || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').some((x) => !x || x === '.' || x === '..')) { errors.push(label + ': missing/invalid bound artifact'); return null }
  const file = path.join(root, ref.path)
  try {
    const real = fs.realpathSync(file), relative = path.relative(fs.realpathSync(root), real)
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(real).isFile()) throw new Error('outside-root')
    const bytes = fs.readFileSync(real)
    if (sha256(bytes) !== ref.sha256) throw new Error('hash')
    return bytes
  } catch { errors.push(label + ': artifact missing, hash mismatch or unsafe path'); return null }
}
function loadBoundJson(root, ref, label, errors) {
  const bytes = loadBoundBytes(root, ref, label, errors)
  if (!bytes) return null
  try { return JSON.parse(bytes.toString('utf8')) } catch { errors.push(label + ': invalid JSON artifact'); return null }
}

export function evaluateReaderObservations({ plan, observations, root = ROOT }) {
  const errors = [], rejected = [], duplicates = [], selected = new Map(), seenCalls = new Map(), conflictKeys = new Set()
  if (!plan || typeof plan !== 'object' || !Array.isArray(observations)) throw new Error('reader-import-plan-and-observation-array-required')
  const frozen = structuredClone(plan); delete frozen.planSha256
  if (plan.schema !== 'cfb.reader-study-plan/1' || !hex(plan.planSha256) || plan.planSha256 !== digestJson(frozen)) errors.push('study-plan-hash-mismatch')
  if (!equal(plan.arms, ARMS) || !Array.isArray(plan.cases) || !plan.cases.length || plan.expectedMinimumContinuationArms !== plan.cases.length * ARMS.length) errors.push('study-denominator-or-arms-invalid')
  const caseRows = Array.isArray(plan.cases) ? plan.cases : [], cases = new Map()
  for (const c of caseRows) {
    if (!c || !nonempty(c.caseId) || cases.has(c.caseId) || ['inputSha256', 'rawSha256', 'ctxSha256', 'referenceSha256'].some((k) => !hex(c[k]))) { errors.push('duplicate-or-invalid-registered-case'); continue }
    cases.set(c.caseId, c)
  }
  const annotationBytes = loadBoundBytes(root, plan.annotations, 'plan:annotations', errors)
  let annotations = []
  if (annotationBytes) try { annotations = annotationBytes.toString('utf8').split('\n').filter((s) => s.trim()).map(JSON.parse) } catch { errors.push('plan:invalid-annotations') }
  loadBoundBytes(root, plan.completeReviews, 'plan:complete-reviews', errors)
  loadBoundJson(root, plan.preregistration, 'plan:preregistration', errors)
  const annoById = new Map(annotations.map((a) => [a.caseId, a]))
  if (annotations.length !== caseRows.length || annoById.size !== annotations.length) errors.push('registered-case-set-not-bound-to-annotations')
  for (const c of cases.values()) {
    const a = annoById.get(c.caseId)
    if (!a || c.family !== a.family || c.inputSha256 !== inputSha256(a) || c.rawSha256 !== sha256(a.raw) || c.ctxSha256 !== sha256(a.ctx) || c.referenceSha256 !== sha256(a.referenceDraft)) errors.push('registered-input-not-bound:' + c.caseId)
  }
  const channel = loadBoundJson(root, plan.channelScopeRef, 'plan:channel', errors)
  const tools = loadBoundJson(root, plan.toolsRef, 'plan:tools', errors)
  const decoding = loadBoundJson(root, plan.decodingRef, 'plan:decoding', errors)
  for (const [key, refKey] of [['channelScopeSha256', 'channelScopeRef'], ['toolsSha256', 'toolsRef'], ['decodingSha256', 'decodingRef']]) if (!hex(plan[key]) || plan[key] !== plan[refKey]?.sha256) errors.push('plan:scope-ref-not-bound:' + key)
  if (!nonempty(plan.servedVersion) || !channel || channel.receiver !== plan.receiver || channel.servedVersion !== plan.servedVersion || !nonempty(channel.requestModel) || !nonempty(channel.endpoint)) errors.push('plan:served-channel-version-not-pinned')
  if (!Array.isArray(tools) || !decoding || typeof decoding !== 'object' || Array.isArray(decoding) || ['model', 'messages', 'tools'].some((k) => k in (decoding || {}))) errors.push('plan:tools-or-decoding-invalid')
  const budget = plan.requestBudget || {}
  if (budget.authorized !== true || !Number.isSafeInteger(budget.maximumPaidRequests) || budget.maximumPaidRequests < plan.expectedMinimumContinuationArms || !Number.isSafeInteger(budget.maximumRetriesPerRequest) || budget.maximumRetriesPerRequest < 0 || !Number.isFinite(budget.maximumUsd) || budget.maximumUsd <= 0 || budget.credentialsInPlanAllowed !== false) errors.push('live-study-budget-not-authorized-or-incomplete')
  const approval = loadBoundJson(root, budget.approvalRef, 'plan:budget-approval', errors)
  if (approval && (approval.kind !== 'user-authorized-reader-study-scope' || approval.authorized !== true || approval.scopeSha256 !== readerAuthorizationScope(plan))) errors.push('plan:budget-approval-not-bound')

  for (const [i, value] of observations.entries()) {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {}, reasons = [], registered = cases.get(row.caseId), key = row.caseId + ':' + row.arm
    if (row.schema !== 'cfb.reader-continuation-observation/1' || !registered || !ARMS.includes(row.arm)) reasons.push('unregistered-observation')
    if (row.planSha256 !== plan.planSha256 || row.inputSha256 !== registered?.inputSha256) reasons.push('plan-or-input-binding-mismatch')
    for (const name of ['birthStateSha256', 'channelScopeSha256', 'toolsSha256', 'decodingSha256']) if (!hex(row[name])) reasons.push('missing-' + name)
    if (row.readerModel !== plan.receiver || !nonempty(row.readerVersion) || row.readerVersion !== plan.servedVersion || row.channelScopeSha256 !== plan.channelScopeSha256 || row.toolsSha256 !== plan.toolsSha256 || row.decodingSha256 !== plan.decodingSha256) reasons.push('reader-scope-version-not-pinned-or-mismatched')
    if (row.executionMode !== 'actual-provider' || row.actualExecution !== true || row.fixtureOnly !== false) reasons.push('fixture-or-unattested-execution')
    if (!nonempty(row.callId)) reasons.push('provider-call-id-required')
    const recordDigest = identity(Object.fromEntries(Object.entries(row).filter(([k]) => !['at', 'timestamp', 'capturedAt'].includes(k))))
    if (nonempty(row.callId) && seenCalls.has(row.callId)) {
      const prior = seenCalls.get(row.callId)
      if (prior.digest === recordDigest) { duplicates.push({ caseId: row.caseId, arm: row.arm, line: i + 1 }); continue }
      conflictKeys.add(prior.key); conflictKeys.add(key); reasons.push('provider-call-id-conflict')
    } else if (nonempty(row.callId)) seenCalls.set(row.callId, { digest: recordDigest, key })
    const request = loadBoundJson(root, row.requestRef, key + ':request', reasons)
    const response = loadBoundJson(root, row.responseRef, key + ':response', reasons)
    const state = loadBoundJson(root, registered?.birthStateRef, key + ':state', reasons)
    const stateIndex = state?.reasoningMessageIndex, before = state?.requestBeforeReplacement
    if (state && (state.schema !== 'cfb.reader-birth-state/1' || state.caseId !== row.caseId || registered.birthStateRef.sha256 !== row.birthStateSha256 || state.inputSha256 !== registered.inputSha256 || state.rawSha256 !== registered.rawSha256 || state.ctxSha256 !== registered.ctxSha256 || sha256(String(state.compressorCtx || '')) !== registered.ctxSha256 || !Number.isSafeInteger(stateIndex) || stateIndex < 0 || before?.messages?.[stateIndex]?.role !== 'assistant' || typeof before?.messages?.[stateIndex]?.reasoning_content !== 'string' || sha256(before.messages[stateIndex].reasoning_content) !== registered.rawSha256)) reasons.push('birth-state-binding-mismatch')
    if (state) {
      if (!Array.isArray(state.environmentSnapshots) || !state.environmentSnapshots.length) reasons.push('birth-environment-snapshots-required')
      for (const ref of Array.isArray(state.environmentSnapshots) ? state.environmentSnapshots : []) loadBoundBytes(root, ref, key + ':environment', reasons)
    }
    const usage = response?.usage
    if (response && (response.id !== row.callId || response.model !== row.readerVersion || !Number.isSafeInteger(usage?.prompt_tokens) || !Number.isSafeInteger(usage?.completion_tokens) || usage.prompt_tokens < 0 || usage.completion_tokens < 0 || !Array.isArray(response.choices) || !response.choices.length || !response.choices[0].message)) reasons.push('provider-response-identity-usage-or-message-mismatch')
    if (request) {
      const wanted = row.arm === 'reference' ? registered?.referenceSha256 : registered?.rawSha256
      if (!Array.isArray(request.messages) || request.messages[stateIndex]?.role !== 'assistant' || typeof request.messages[stateIndex]?.reasoning_content !== 'string' || sha256(request.messages[stateIndex].reasoning_content) !== wanted) reasons.push('serialized-request-does-not-carry-registered-reasoning-at-birth-slot')
      if (before?.messages?.[stateIndex]) {
        const expected = structuredClone(before); expected.messages[stateIndex].reasoning_content = request.messages?.[stateIndex]?.reasoning_content
        if (!equal(request, expected)) reasons.push('request-modified-beyond-designated-reasoning-slot')
      }
      if (request.model !== channel?.requestModel || !equal(request.tools || [], tools)) reasons.push('serialized-request-model-or-tools-mismatch')
      for (const [k, v] of Object.entries(decoding || {})) if (!equal(request[k], v)) reasons.push('serialized-request-decoding-mismatch:' + k)
    }
    const result = row.outcome
    if (!result || typeof result.taskSuccess !== 'boolean' || typeof result.falseCompletion !== 'boolean' || !Number.isSafeInteger(result.constraintViolations) || result.constraintViolations < 0 || !Number.isSafeInteger(result.extraToolRounds) || result.extraToolRounds < 0 || !Number.isFinite(row.latencyMs) || row.latencyMs < 0 || !['completed', 'timeout', 'failed', 'fallback', 'refused'].includes(row.status) || (row.status !== 'completed' && result.taskSuccess)) reasons.push('full-case-outcome-incomplete-or-inconsistent')
    const grade = loadBoundJson(root, row.outcomeReviewRef, key + ':outcome-review', reasons)
    if (grade && (grade.caseId !== row.caseId || grade.callId !== row.callId || grade.responseSha256 !== row.responseRef?.sha256 || grade.requestSha256 !== row.requestRef?.sha256 || grade.birthStateSha256 !== row.birthStateSha256 || grade.outcomeSha256 !== digestJson(result || null) || grade.status !== 'complete' || !nonempty(grade.reviewerId) || grade.fixtureOnly !== false)) reasons.push('outcome-review-not-bound')
    if (selected.has(key)) { conflictKeys.add(key); reasons.push('multiple-terminal-observations-for-one-arm') }
    if (reasons.length) rejected.push({ caseId: row.caseId || null, arm: row.arm || null, line: i + 1, status: row.status || null, reasons: [...new Set(reasons)] })
    else selected.set(key, row)
  }
  for (const key of conflictKeys) selected.delete(key) // No first/last-wins or later "repair".
  if (seenCalls.size > budget.maximumPaidRequests) errors.push('observed-unique-provider-calls-exceed-budget')
  const complete = [], missing = []
  for (const registered of cases.values()) {
    const arms = Object.fromEntries(ARMS.map((arm) => [arm, selected.get(registered.caseId + ':' + arm)])), absent = ARMS.filter((arm) => !arms[arm])
    if (absent.length) { missing.push({ caseId: registered.caseId, missingArms: absent }); continue }
    if (new Set(Object.values(arms).map((r) => r.birthStateSha256)).size !== 1) { missing.push({ caseId: registered.caseId, missingArms: [], reason: 'unpaired-state' }); continue }
    const a = arms['raw-a'], b = arms['raw-b'], ref = arms.reference
    complete.push({ caseId: registered.caseId, family: registered.family,
      aASuccessDisagrees: a.outcome.taskSuccess !== b.outcome.taskSuccess,
      referenceSuccessDamage: a.outcome.taskSuccess && !ref.outcome.taskSuccess,
      referenceAddedViolations: Math.max(0, ref.outcome.constraintViolations - a.outcome.constraintViolations), referenceFalseCompletion: ref.outcome.falseCompletion,
      statuses: Object.fromEntries(ARMS.map((arm) => [arm, arms[arm].status])), tokenSavings: null, actualUsdSavings: null,
      qualification: 'Initial response identity plus bound outcome declaration only, not independently verified full continuation/whole-path economics.' })
  }
  if (missing.length) errors.push('all-registered-cases-not-accounted')
  if (rejected.length) errors.push('observations-rejected')
  return { schema: 'cfb.reader-study-import/1', planSha256: plan.planSha256, preregSha256: plan.preregistration?.sha256,
    status: errors.length ? 'not-evaluable' : 'descriptive-development-only', errors: [...new Set(errors)], rejected, duplicates, missing, complete,
    denominator: caseRows.length, acceptedObservationCount: selected.size, observedUniqueProviderCallIds: seenCalls.size,
    callCountIsLowerBoundNotWholeStudy: true, fullContinuationTrajectoriesVerified: false, actualBillingVerified: false, independentSampleCount: null,
    originalReaderValidated: false, referenceUtilityVerified: false, promotionAllowed: false,
    qualification: 'Local evidence integrity/descriptive declarations only. Full trajectory, host/version attestation, numerical gates, independence and cumulative billing are NOT manufactured.',
    paidApiCallsByThisCommand: 0, modelExecutionsByThisCommand: 0, gpuRunsByThisCommand: 0, newBlindConsumedByThisCommand: 0 }
}
export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'plan'; let out = null, observations = null, planPath = null
  for (let i = 1; i < argv.length; i++) {
    if (['--out', '--observations', '--plan'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const flag = argv[i], value = argv[++i]
      if (flag === '--out') { if (out) throw new Error('duplicate-out'); out = value }
      else if (flag === '--plan') { if (planPath) throw new Error('duplicate-plan'); planPath = value }
      else { if (observations) throw new Error('duplicate-observations'); observations = value }
    } else throw new Error('use plan [--out NEW_FILE] | evaluate --plan FILE --observations FILE [--out NEW_FILE]')
  }
  let report
  if (command === 'plan' && !observations && !planPath) report = makeReaderStudyPlan()
  else if (command === 'evaluate' && observations && planPath) report = evaluateReaderObservations({ plan: readObject(ROOT, planPath), observations: readJsonl(path.resolve(ROOT, observations)) })
  else throw new Error('local plan/evaluate only; no live execute command')
  if (out) writeFresh(path.resolve(ROOT, out), report)
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'not-evaluable' ? 2 : 0
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { process.exitCode = main() } catch (e) { console.error(e.stack || e); process.exitCode = 1 } }
