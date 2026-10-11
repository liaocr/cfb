import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildExport } from '../tools/micro-generator/export-reviewed-corpus.mjs'
import { buildReviewQueue } from '../tools/micro-generator/prepare-review-queue.mjs'
import { buildFactDraftSuggestions } from '../tools/micro-generator/build-fact-draft-suggestions.mjs'
import { evaluate, frozenGateDigest, registryDigest } from '../tools/micro-generator/evaluate.mjs'
import { freezeGateConfig } from '../tools/micro-generator/freeze-gates.mjs'
import { selectSmallestPassing } from '../tools/micro-generator/select-smallest-passing.mjs'
import { inputSha256, readJsonl, sha256, validateAnnotation, validateFamilyIsolation, validatePrediction } from '../tools/micro-generator/lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERE = path.join(ROOT, 'tools/micro-generator')
const aiReviewProvenance = (scope) => ({
  mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1,
  humanReviewerCount: 0, independentSecondReview: false, reviewedAt: '2026-10-07', scope,
  limitations: ['AI single reviewer only; no independent human review or external run is implied.'],
})
const PYTHON = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return 'python3' } catch { return null } })()
let pass = 0, fail = 0, skip = 0
function test(name, fn) {
  if (!fn) { skip++; console.log('SKIP ' + name); return }
  try { fn(); pass++; console.log('PASS ' + name) }
  catch (error) { fail++; console.error('FAIL ' + name + '\n' + (error?.stack || error)) }
}

function makeCase(options = {}) {
  const caseId = options.caseId || 'case-x'
  const family = options.family || 'fresh-family-x'
  const split = options.split || 'blind'
  const raw = options.raw || `Source ${caseId}: Unicode 😀 value 42 must stay.`
  const ctx = options.ctx ?? 'Keep required numeric facts.'
  const referenceDraft = options.referenceDraft || 'Keep value 42.'
  const start = raw.indexOf('42')
  return {
    schema: 'cfb.micro-generator-annotation/1', caseId, family, finalSplit: split,
    provenanceSplit: 'new-family', raw, ctx, referenceDraft,
    sourceHashes: { rawSha256: sha256(raw), ctxSha256: sha256(ctx), referenceSha256: sha256(referenceDraft) },
    sourceCoverage: 'complete', annotationStatus: 'adjudicated', reviewers: ['arena-agent-mode'],
    reviewProvenance: aiReviewProvenance('raw-context-facts-and-reference-claims'), trainingEligible: true,
    facts: [{ factId: caseId + '-f1', proposition: 'The value 42 must be preserved.',
      sourceSpan: { field: 'raw', start, end: start + 2, quote: '42' }, importance: 'critical',
      polarity: 'positive', modality: 'required', conditions: [], entities: ['value'],
      mustPreserve: true, tags: ['number'] }],
    referenceReview: { status: 'adjudicated', factStatuses: [{ factId: caseId + '-f1', status: 'preserved' }],
      allMustPreserveFactsSatisfied: true, unsupportedClaimsReviewed: true, unsupportedClaimsCount: 0 },
  }
}
function makePrediction(annotation, { status = 'adjudicated', factStatus = 'preserved', artifactBytes = 640 } = {}) {
  const prediction = {
    schema: 'cfb.micro-generator-prediction/1', caseId: annotation.caseId, family: annotation.family,
    split: annotation.finalSplit, inputSha256: inputSha256({ raw: annotation.raw, ctx: annotation.ctx }),
    model: { id: 'candidate-a', revision: '0123456789abcdef0123456789abcdef01234567', weightsSha256: 'a'.repeat(64),
      quantization: 'Q8_0', runtime: 'test', artifactBytes, parameterCount: 600000000 },
    promptVersion: 'test-v1', promptSha256: 'b'.repeat(64), decoding: { temperature: 0 },
    latencyMs: 10, promptTokens: 10, completionTokens: 5, draft: 'Keep value 42.',
    review: status === 'adjudicated' ? {
      status, factCoverage: 'complete', facts: [{ factId: annotation.facts[0].factId, status: factStatus }],
      claimCoverage: 'complete', claims: [{ claimId: 'claim-1', text: 'Value is 42.', status: 'supported', sourceFactIds: [annotation.facts[0].factId] }],
      reviewers: ['arena-agent-mode'], reviewProvenance: aiReviewProvenance('prediction-facts-and-claims'),
    } : { status: 'pending', factCoverage: 'pending', facts: [], claimCoverage: 'pending', claims: [], reviewers: [], reviewProvenance: null },
  }
  if (annotation.finalSplit === 'blind') {
    const gates = makeFrozenGates([annotation.family])
    prediction.blindProtocol = {
      gateId: gates.gateId,
      gateConfigSha256: gates.frozenConfigSha256,
      blindRegistrySha256: gates.blindFamilyRegistry.registrySha256,
    }
  }
  return prediction
}
function makeFrozenGates(families = ['fresh-family-x']) {
  const draft = JSON.parse(fs.readFileSync(path.join(HERE, 'evaluation-gates.template.json'), 'utf8'))
  return freezeGateConfig(draft, {
    families,
    knownFamilies: draft.knownFamilyNames,
    now: '2026-10-07T00:00:00.000Z',
    thresholds: {
      minBlindFamilies: 1, minCasesPerBlindFamily: 1,
      weightedFactRecallOverallMin: 0.95, weightedFactRecallPerBlindFamilyMin: 0.95,
      criticalOmissionsPerBlindFamilyMax: 0, uncertainMustPreservePerBlindFamilyMax: 0,
      contradictoryClaimsPerBlindFamilyMax: 0, unsupportedClaimsPer100Max: 0, uncertainClaimsPer100Max: 0,
      medianDraftToRawCharRatioMax: 0.75,
    },
  })
}

const current = buildReviewQueue(ROOT)
test('current source inventory produces a deterministic review-only queue', () => {
  assert.equal(current.rows.length, 17)
  assert.equal(current.manifest.trainingReady, false)
  assert.equal(current.manifest.knownFamilies.length, 3)
  assert.ok(current.rows.every((row) => row.trainingEligible === false && row.annotationStatus === 'unreviewed' && row.facts.length === 0))
  assert.ok(current.rows.every((row) => row.provenanceSplit === 'existing-dev' && row.finalSplit === null))
  assert.equal(new Set(current.rows.map((row) => row.caseId)).size, current.rows.length)
})

test('context-only fact-review starters have exact spans and remain strictly untrainable drafts', () => {
  const proposals = buildFactDraftSuggestions(current.rows)
  assert.equal(proposals.length, current.rows.length)
  assert.ok(proposals.every((row) => row.sourceCoverage === 'partial' && row.annotationStatus === 'draft' && row.trainingEligible === false))
  assert.ok(proposals.every((row) => row.reviewers.length === 0 && row.referenceReview.status === 'pending'))
  assert.ok(proposals.every((row) => validateAnnotation(row).length === 0))
  for (const row of proposals) for (const fact of row.facts) {
    assert.equal(row.ctx.slice(fact.sourceSpan.start, fact.sourceSpan.end), fact.sourceSpan.quote)
  }
})

test('AI-reviewed rewrite candidates preserve one reviewer, dev-only splits, and the resolved canonical conflict', () => {
  const candidates = readJsonl(path.join(ROOT, 'transfer/models/micro-generator-ai-reviewed-dev-candidates.jsonl'))
  const dispositions = readJsonl(path.join(ROOT, 'transfer/models/micro-generator-ai-review-dispositions.jsonl'))
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'transfer/models/micro-generator-ai-reviewed-dev-candidates.manifest.json'), 'utf8'))
  const splitTemplate = JSON.parse(fs.readFileSync(path.join(HERE, 'family-splits.template.json'), 'utf8'))
  const familySplits = new Map(splitTemplate.currentlyKnownFamilies.map((row) => [row.family, row]))
  assert.equal(candidates.length, 16)
  assert.equal(dispositions.length, 17)
  assert.equal(manifest.counts.originalQueueRows, current.rows.length)
  assert.equal(manifest.counts.uniqueRawCtxPairs, candidates.length)
  assert.deepEqual(manifest.counts.sourceFamilies, ['flaky-timeout', 'perf-regression', 'sse-truncated'])
  assert.equal(manifest.sourceQueueSha256, sha256(JSON.stringify(current.rows)))
  assert.deepEqual(new Set(dispositions.map((row) => row.originalCaseId)), new Set(current.rows.map((row) => row.caseId)))
  assert.equal(manifest.readiness.trainingReady, false)
  assert.equal(manifest.counts.trainingEligibleRows, 0)
  assert.equal(manifest.familySplitTemplateStatus, splitTemplate.status)
  assert.equal(manifest.familySplitTemplateSha256, sha256(JSON.stringify(splitTemplate)))
  assert.equal(manifest.candidateSha256, sha256(JSON.stringify(candidates)))
  assert.equal(manifest.dispositionSha256, sha256(JSON.stringify(dispositions)))
  assert.ok(candidates.every((row) => row.finalSplit === 'dev' && row.provenanceSplit === 'existing-dev'))
  assert.ok(candidates.every((row) => familySplits.get(row.family)?.finalSplit === row.finalSplit && familySplits.get(row.family)?.observedAs === row.provenanceSplit))
  assert.ok(candidates.every((row) => row.sourceCoverage === 'partial' && row.annotationStatus === 'reviewed' && row.trainingEligible === false))
  assert.ok(candidates.every((row) => row.reviewers.length === 1 && row.reviewers[0] === 'arena-agent-mode'))
  assert.ok(candidates.every((row) => row.reviewProvenance.mode === 'ai-single-reviewer' && row.reviewProvenance.humanReviewerCount === 0 && row.reviewProvenance.independentSecondReview === false))
  assert.ok(candidates.every((row) => validateAnnotation(row).length === 0))
  const conflicts = dispositions.filter((row) => row.conflictGroup === 'perf-regression-identical-input-two-targets')
  assert.equal(conflicts.length, 2)
  assert.equal(conflicts[0].proposedCanonicalCaseId, conflicts[1].proposedCanonicalCaseId)
  assert.ok(dispositions.every((row) => row.trainingEligible === false && row.reviewerPolicy.reviewerId === 'arena-agent-mode' && row.reviewerPolicy.independentSecondReview === false))
  const exportResult = buildExport(candidates)
  assert.deepEqual(exportResult.errors, [])
  assert.equal(exportResult.manifest.trainingReady, false)
  assert.equal(exportResult.groups.train.length, 0)
  assert.equal(exportResult.groups.dev.length, 0)
  assert.equal(exportResult.manifest.counts.excluded, 16)
  assert.ok(exportResult.manifest.blockers.includes('no-ai-reviewed-training-examples'))
})

test('existing queue is rejected for training with explicit missing-review blockers', () => {
  const result = buildExport(current.rows)
  assert.equal(result.errors.length, 0)
  assert.equal(result.manifest.trainingReady, false)
  assert.equal(result.groups.train.length, 0)
  assert.equal(result.groups.dev.length, 0)
  assert.ok(result.manifest.blockers.includes('no-ai-reviewed-training-examples'))
})

test('source spans are checked exactly using UTF-16 offsets', () => {
  const row = makeCase()
  assert.deepEqual(validateAnnotation(row), [])
  row.facts[0].sourceSpan.quote = '43'
  assert.ok(validateAnnotation(row).some((error) => error.includes('does not equal the source substring')))
})

test('AI single-review provenance is explicit and multi/human reviewer claims are rejected', () => {
  const row = makeCase({ caseId: 'single-review', family: 'single-review-family', split: 'train' })
  assert.deepEqual(validateAnnotation(row), [])
  const falseHuman = structuredClone(row)
  falseHuman.reviewProvenance.reviewerType = 'human'
  assert.ok(validateAnnotation(falseHuman).some((error) => error.includes('reviewerType')))
  const falseSecond = structuredClone(row)
  falseSecond.reviewProvenance.humanReviewerCount = 1
  falseSecond.reviewProvenance.independentSecondReview = true
  falseSecond.reviewers = ['arena-agent-mode', 'reviewer-b']
  assert.ok(validateAnnotation(falseSecond).some((error) => error.includes('no second reviewer is required or claimed')))
  assert.ok(validateAnnotation(falseSecond).some((error) => error.includes('humanReviewerCount')))
  const prediction = makePrediction(row)
  assert.deepEqual(validatePrediction(prediction, row), [])
  prediction.review.reviewProvenance.independentSecondReview = true
  assert.ok(validatePrediction(prediction, row).some((error) => error.includes('independentSecondReview')))
  const badGateDraft = JSON.parse(fs.readFileSync(path.join(HERE, 'evaluation-gates.template.json'), 'utf8'))
  badGateDraft.reviewPolicy.reviewerType = 'human'
  assert.throws(() => freezeGateConfig(badGateDraft, { families: ['fresh-policy-test-family'] }), /gate review policy/)
})

test('family and duplicate-input split leakage is rejected', () => {
  const a = makeCase({ caseId: 'a', family: 'family-a', split: 'train' })
  const b = makeCase({ caseId: 'b', family: 'family-a', split: 'dev' })
  assert.ok(validateFamilyIsolation([a, b]).some((error) => error.includes('family leakage')))
  const c = makeCase({ caseId: 'c', family: 'family-c', split: 'dev', raw: a.raw, ctx: a.ctx })
  assert.ok(validateFamilyIsolation([a, c]).some((error) => error.includes('input leakage')))
})

test('only adjudicated fact-safe references export; blind rows remain private', () => {
  const train = makeCase({ caseId: 'train-a', family: 'train-family-a', split: 'train' })
  const train2 = makeCase({ caseId: 'train-a2', family: 'train-family-a2', split: 'train' })
  const dev = makeCase({ caseId: 'dev-b', family: 'dev-family-b', split: 'dev' })
  const blind = makeCase({ caseId: 'blind-c', family: 'fresh-family-c', split: 'blind' })
  const built = buildExport([train, train2, dev, blind])
  assert.deepEqual(built.errors, [])
  assert.equal(built.manifest.trainingReady, true)
  assert.equal(built.manifest.confirmatoryEvaluationReady, false)
  assert.ok(built.manifest.confirmatoryBlockers.includes('frozen-gates-and-blind-registry-must-be-validated-by-evaluator'))
  assert.equal(built.groups.train.length, 2)
  assert.equal(built.groups.dev.length, 1)
  assert.equal(built.groups.blind.length, 1)
  assert.equal(built.groups.train[0].schema, 'cfb.micro-generator-training-example/1')
  assert.deepEqual(built.groups.train[0].reviewers, ['arena-agent-mode'])
  assert.equal(built.groups.train[0].reviewProvenance.mode, 'ai-single-reviewer')
  assert.equal(built.manifest.reviewPolicy.independentSecondReview, false)
})

test('unreviewed or incomplete reference cannot enter the train export', () => {
  const row = makeCase({ caseId: 'unsafe', family: 'unsafe-family', split: 'train' })
  row.referenceReview.allMustPreserveFactsSatisfied = false
  const other = makeCase({ caseId: 'dev-safe', family: 'dev-safe', split: 'dev' })
  const built = buildExport([row, other])
  assert.equal(built.groups.train.length, 0)
  assert.equal(built.manifest.trainingReady, false)
  assert.ok(built.manifest.excluded.some((item) => item.caseId === 'unsafe'))
})

test('identical raw+ctx with multiple target drafts blocks export pending resolution', () => {
  const raw = 'Same source: preserve value 42.'
  const ctx = 'Keep the required value.'
  const first = makeCase({ caseId: 'same-input-a', family: 'same-family', split: 'train', raw, ctx, referenceDraft: 'Keep value 42.' })
  const second = makeCase({ caseId: 'same-input-b', family: 'same-family', split: 'train', raw, ctx, referenceDraft: 'The value 42 must remain.' })
  const dev = makeCase({ caseId: 'distinct-dev', family: 'distinct-dev-family', split: 'dev' })
  const built = buildExport([first, second, dev])
  assert.equal(built.manifest.trainingReady, false)
  assert.ok(built.manifest.blockers.includes('identical-input-has-multiple-reference-targets'))
  assert.equal(built.manifest.conflictingInputTargets.length, 1)
  assert.deepEqual(built.manifest.conflictingInputTargets[0].caseIds, ['same-input-a', 'same-input-b'])
})

test('unfrozen or missing new-family gates never yield a pass', () => {
  const annotation = makeCase()
  const prediction = makePrediction(annotation)
  const gates = makeFrozenGates()
  const draft = { ...gates, status: 'draft-not-frozen', freezeAt: null }
  draft.frozenConfigSha256 = frozenGateDigest(draft)
  const report = evaluate({ annotations: [annotation], predictions: [prediction], gates: draft })
  assert.equal(report.status, 'not-evaluable')
  assert.ok(report.blockers.includes('gates-not-frozen'))
  assert.equal(registryDigest(['fresh-family-x']), gates.blindFamilyRegistry.registrySha256)
})

test('adjudicated metrics enforce critical facts, unsupported claims, and compression gates', () => {
  const annotation = makeCase()
  const gates = makeFrozenGates()
  const prediction = makePrediction(annotation)
  const report = evaluate({ annotations: [annotation], predictions: [prediction], gates })
  assert.equal(report.status, 'pass')
  assert.equal(report.overallBlind.weightedFactRecall, 1)
  assert.equal(report.overallBlind.criticalOmissions, 0)
  assert.equal(report.modelCandidates[0].artifactBytes, 640)
  const wrongBlindProtocol = makePrediction(annotation)
  wrongBlindProtocol.blindProtocol.gateConfigSha256 = 'c'.repeat(64)
  const invalidProtocol = evaluate({ annotations: [annotation], predictions: [wrongBlindProtocol], gates })
  assert.equal(invalidProtocol.status, 'invalid-data')
  assert.ok(invalidProtocol.integrityErrors.some((error) => error.includes('does not match the evaluated frozen gate')))
  const bad = makePrediction(annotation, { factStatus: 'contradicted' })
  const failed = evaluate({ annotations: [annotation], predictions: [bad], gates })
  assert.equal(failed.status, 'fail')
  assert.ok(failed.gateFailures.includes('criticalOmissionsPerBlindFamilyMax:fresh-family-x'))
  const uncertainClaim = makePrediction(annotation)
  uncertainClaim.review.claims[0].status = 'uncertain'
  const uncertainReport = evaluate({ annotations: [annotation], predictions: [uncertainClaim], gates })
  assert.equal(uncertainReport.status, 'fail')
  assert.ok(uncertainReport.gateFailures.includes('uncertainClaimsPer100Max:fresh-family-x'))
})

test('size selection chooses the smallest artifact among reports sharing frozen evidence', () => {
  const annotation = makeCase()
  const gates = makeFrozenGates()
  const report = evaluate({ annotations: [annotation], predictions: [makePrediction(annotation, { artifactBytes: 640 })], gates })
  const smaller = structuredClone(report)
  smaller.modelCandidates[0].id = 'smaller'
  smaller.modelCandidates[0].artifactBytes = 500
  smaller.modelCandidates[0].parameterCount = 350000000
  smaller.predictionSetSha256 = 'd'.repeat(64)
  const selected = selectSmallestPassing([report, smaller])
  assert.equal(selected.status, 'selected-smallest-passing')
  assert.equal(selected.selected.model.id, 'smaller')
})

test('prediction reviewer must cover every fact and claim', () => {
  const annotation = makeCase()
  const prediction = makePrediction(annotation)
  prediction.review.facts = []
  assert.ok(validatePrediction(prediction, annotation).some((error) => error.includes('every annotated fact')))
})

test('Python runners, Kaggle notebook cells, and JSON schemas parse cleanly', () => {
  for (const name of ['annotation.schema.json', 'prediction.schema.json', 'exported-example.schema.json', 'evaluation-gates.template.json', 'family-splits.template.json', 'dataset-policy.json']) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8')), name)
  }
  const notebook = JSON.parse(fs.readFileSync(path.join(HERE, 'kaggle_qwen3_qlora.ipynb'), 'utf8'))
  const code = notebook.cells.filter((cell) => cell.cell_type === 'code').map((cell) => cell.source.join(''))
  const pyFiles = ['gate_protocol.py', 'run_gguf.py', 'run_hf.py', 'train_qlora.py', 'build-ai-review-workbook.py'].map((name) => fs.readFileSync(path.join(HERE, name), 'utf8'))
  if (PYTHON) {
    const parse = [...code, ...pyFiles].map((source) => `ast.parse(${JSON.stringify(source)})`).join('\n')
    execFileSync(PYTHON, ['-c', `import ast\n${parse}`], { cwd: ROOT, stdio: 'pipe' })
  } else { skip++; console.log('SKIP Python AST parse (python3 unavailable)') }
})

test('blind inference authorization verifies frozen hashes and registered finalSplit', PYTHON ? () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-gen-blind-gates-'))
  try {
    const gates = makeFrozenGates(['brand-new-review-family'])
    const gatePath = path.join(temp, 'frozen-gates.json')
    fs.writeFileSync(gatePath, JSON.stringify(gates))
    const row = { caseId: 'blind-case', family: 'brand-new-review-family', finalSplit: 'blind', raw: 'Source 42.', ctx: 'Keep it.' }
    const py = 'import json,sys; from gate_protocol import authorize_blind_rows; print(json.dumps(authorize_blind_rows([json.loads(sys.argv[2])], sys.argv[1])))'
    const env = { ...process.env, PYTHONPATH: HERE }
    const allowed = JSON.parse(execFileSync(PYTHON, ['-c', py, gatePath, JSON.stringify(row)], { cwd: ROOT, env, encoding: 'utf8' }))
    assert.equal(allowed.gateConfigSha256, gates.frozenConfigSha256)
    assert.equal(allowed.blindRegistrySha256, gates.blindFamilyRegistry.registrySha256)
    assert.throws(() => execFileSync(PYTHON, ['-c', py, gatePath, JSON.stringify({ ...row, finalSplit: 'dev' })], { cwd: ROOT, env, stdio: 'pipe' }))
    const tampered = { ...gates, statusNote: 'changed after freezing' }
    const tamperedPath = path.join(temp, 'tampered-gates.json')
    fs.writeFileSync(tamperedPath, JSON.stringify(tampered))
    assert.throws(() => execFileSync(PYTHON, ['-c', py, tamperedPath, JSON.stringify(row)], { cwd: ROOT, env, stdio: 'pipe' }))
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
} : null)

test('GGUF inference runner logs a pending prediction with matched input and weight hashes', PYTHON ? () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-gen-gguf-mock-'))
  try {
    const moduleDir = path.join(temp, 'mocklib')
    fs.mkdirSync(moduleDir)
    fs.writeFileSync(path.join(moduleDir, 'llama_cpp.py'), 'class Llama:\n    def __init__(self, **kwargs):\n        pass\n    def create_chat_completion(self, **kwargs):\n        return {"choices":[{"message":{"content":"Keep value 42."}}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n')
    const modelPath = path.join(temp, 'fake.gguf')
    fs.writeFileSync(modelPath, 'mock-model-bytes')
    const annotation = makeCase({ caseId: 'gguf-case', family: 'gguf-family', split: 'dev' })
    const inputPath = path.join(temp, 'input.jsonl')
    fs.writeFileSync(inputPath, JSON.stringify({ caseId: annotation.caseId, family: annotation.family, raw: annotation.raw, ctx: annotation.ctx }) + '\n')
    const outputPath = path.join(temp, 'predictions.jsonl')
    execFileSync(PYTHON, [path.join(HERE, 'run_gguf.py'), '--model', modelPath, '--input', inputPath,
      '--out', outputPath, '--revision', '0123456789abcdef0123456789abcdef01234567', '--quantization', 'Q8_0'],
      { cwd: ROOT, env: { ...process.env, PYTHONPATH: moduleDir }, stdio: 'pipe' })
    const prediction = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim())
    assert.equal(prediction.draft, 'Keep value 42.')
    assert.equal(prediction.review.status, 'pending')
    assert.equal(validatePrediction(prediction, annotation).length, 0)
    assert.equal(prediction.model.artifactBytes, fs.statSync(modelPath).size)

    const blindFamily = 'brand-new-gguf-family'
    const blindAnnotation = makeCase({ caseId: 'gguf-blind-case', family: blindFamily, split: 'blind' })
    const blindInputPath = path.join(temp, 'blind-input.jsonl')
    fs.writeFileSync(blindInputPath, JSON.stringify({ caseId: blindAnnotation.caseId, family: blindFamily,
      finalSplit: 'blind', raw: blindAnnotation.raw, ctx: blindAnnotation.ctx }) + '\n')
    const blindGates = makeFrozenGates([blindFamily])
    const gatesPath = path.join(temp, 'frozen-gates.json')
    fs.writeFileSync(gatesPath, JSON.stringify(blindGates))
    const blindOutputPath = path.join(temp, 'blind-predictions.jsonl')
    execFileSync(PYTHON, [path.join(HERE, 'run_gguf.py'), '--model', modelPath, '--input', blindInputPath,
      '--out', blindOutputPath, '--revision', '0123456789abcdef0123456789abcdef01234567', '--quantization', 'Q8_0',
      '--split', 'blind', '--gates', gatesPath], { cwd: ROOT, env: { ...process.env, PYTHONPATH: moduleDir }, stdio: 'pipe' })
    const blindPrediction = JSON.parse(fs.readFileSync(blindOutputPath, 'utf8').trim())
    assert.equal(blindPrediction.blindProtocol.gateConfigSha256, blindGates.frozenConfigSha256)
    assert.deepEqual(validatePrediction(blindPrediction, blindAnnotation, { gates: blindGates }), [])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
} : null)

test('Kaggle QLoRA preflight accepts a tiny synthetic family-disjoint reviewed fixture', PYTHON ? () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-gen-selftest-'))
  try {
    const train = makeCase({ caseId: 'train-only', family: 'train-family', split: 'train' })
    const train2 = makeCase({ caseId: 'train-only-2', family: 'train-family-2', split: 'train' })
    const dev = makeCase({ caseId: 'dev-only', family: 'dev-family', split: 'dev' })
    const exported = buildExport([train, train2, dev])
    assert.equal(exported.manifest.trainingReady, true)
    const trainPath = path.join(temp, 'train.jsonl'), devPath = path.join(temp, 'dev.jsonl')
    fs.writeFileSync(trainPath, exported.groups.train.map(JSON.stringify).join('\n') + '\n')
    fs.writeFileSync(devPath, exported.groups.dev.map(JSON.stringify).join('\n') + '\n')
    const args = [path.join(HERE, 'train_qlora.py'), '--train', trainPath, '--dev', devPath,
      '--min-train-families', '1', '--preflight-only']
    const output = execFileSync(PYTHON, args, { cwd: ROOT, encoding: 'utf8' })
    assert.match(output, /"ready": true/)
    const conflict = structuredClone(exported.groups.train[0])
    conflict.caseId = 'train-conflicting-target'
    conflict.draft = 'The task is finished.'
    conflict.sourceHashes.referenceSha256 = sha256(conflict.draft)
    fs.writeFileSync(trainPath, [...exported.groups.train, conflict].map(JSON.stringify).join('\n') + '\n')
    assert.throws(() => execFileSync(PYTHON, args, { cwd: ROOT, stdio: 'pipe' }), (error) => error.status === 2)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
} : null)

console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip}`)
if (fail) process.exitCode = 1
