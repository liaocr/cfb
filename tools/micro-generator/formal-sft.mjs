#!/usr/bin/env node
// Formal flat-SFT adapter. Existing exporters remain research/legacy; this entry
// requires complete review, source proof, new ruler, reader study and CPU receipts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inputSha256, sha256, readJsonl, validateFamilyIsolation } from './lib.mjs'
import { boundAnnotationDigest, flatRowDigest, digestJson, validateCompleteReview } from './review-contract.mjs'
import { PROGRAM_DIR, readObject, fileRef } from './program.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHA = /^[a-f0-9]{64}$/
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0
const encodeRows = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')

function loadBound(root, ref, label, blockers) {
  if (!ref || !nonempty(ref.path) || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').some((s) => !s || s === '.' || s === '..') || !SHA.test(ref.sha256 || '')) { blockers.push(label + ': missing/invalid bound artifact'); return null }
  const full = path.join(root, ref.path)
  try {
    const real = fs.realpathSync(full), relative = path.relative(fs.realpathSync(root), real)
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(real).isFile() || sha256(fs.readFileSync(real)) !== ref.sha256) throw new Error('unsafe-or-drifted')
  } catch { blockers.push(label + ': hash mismatch/missing/unsafe file'); return null }
  try { return JSON.parse(fs.readFileSync(full, 'utf8')) } catch { blockers.push(label + ': invalid JSON'); return null }
}
export function toFlatSft(annotation, { repo, system }) {
  if (!nonempty(repo) || ['unknown','null','none'].includes(repo.toLowerCase())) throw new Error('formal-SFT-known-repository-required')
  if (!nonempty(system)) throw new Error('formal-SFT-system-prompt-required')
  return { id: annotation.caseId, repo, system, user: JSON.stringify({ raw: annotation.raw, ctx: annotation.ctx }), assistant: annotation.referenceDraft }
}

export function buildFormalSft({ root = ROOT, annotations, reviews, registry, contract, prompt, model, evidence = {} }) {
  const blockers = [], errors = [], rejected = [], accepted = [], lineage = []
  if (registry?.schema !== 'cfb.source-registry/1' || registry.errors?.length) blockers.push('source-registry-invalid')
  if (contract?.schema !== 'cfb.compression-task-contract/1' || contract.quality?.universalNeverWorseClaimAllowed !== false) blockers.push('task-contract-invalid')
  if (contract.resources?.resourceBudgetConfirmed !== true) blockers.push('resource-budget-not-confirmed')
  if (!nonempty(prompt)) blockers.push('training-prompt-missing')
  if (!nonempty(model?.id) || !/^[a-f0-9]{40}$/.test(model?.revision || '')) blockers.push('immutable-model-required')
  if (!Array.isArray(annotations) || !Array.isArray(reviews)) throw new Error('formal-inputs-must-be-arrays')
  if (annotations.some((r) => r.finalSplit === 'blind')) blockers.push('blind-labels-not-accepted-by-formal-exporter')
  errors.push(...validateFamilyIsolation(annotations))
  const reviewById = new Map(), registryByInput = new Map(), ids = new Set(), inputs = new Set()
  for (const review of reviews) { if (reviewById.has(review.caseId)) errors.push('duplicate-complete-review:' + review.caseId); reviewById.set(review.caseId, review) }
  for (const entry of registry?.entries || []) { if (registryByInput.has(entry.inputSha256)) errors.push('duplicate-registry-input'); registryByInput.set(entry.inputSha256, entry) }
  if (reviewById.size !== annotations.length || reviews.some((r) => !annotations.some((a) => a.caseId === r.caseId))) errors.push('annotation-review-case-sets-must-match')
  const exposedFamilies = new Set()
  for (const e of registry?.entries || []) if ((e.exposure || []).some((x) => /dev|exposed|blind/.test(x))) for (const f of e.families || []) exposedFamilies.add(f)
  for (const annotation of annotations) {
    const reasons = [], input = inputSha256(annotation), review = reviewById.get(annotation.caseId), entry = registryByInput.get(input)
    if (ids.has(annotation.caseId)) errors.push('duplicate-annotation-case:' + annotation.caseId); ids.add(annotation.caseId)
    if (inputs.has(input)) reasons.push('same-input-needs-one-adjudicated-canonical-target'); inputs.add(input)
    if (!['train','dev'].includes(annotation.finalSplit)) reasons.push('train-or-dev-split-required')
    if (annotation.trainingEligible !== true) reasons.push('explicit-training-eligibility-is-false')
    reasons.push(...validateCompleteReview(annotation, review))
    if (!entry || entry.rawSha256 !== sha256(annotation.raw) || entry.ctxSha256 !== sha256(annotation.ctx) || !entry.records?.some((r) => r.caseId === annotation.caseId && r.recordSha256 === boundAnnotationDigest(annotation))) reasons.push('registry-annotation-lineage-mismatch')
    if (annotation.finalSplit === 'train' && ((entry?.exposure || []).some((x) => /dev|exposed|blind/.test(x)) || exposedFamilies.has(annotation.family))) reasons.push('prior-exposed-input-cannot-become-train')
    const source = entry?.sourceAdmission
    if (!source || ['admitted','modelVersionVerified','temporalBoundaryVerified','licenseReviewed','privacyReviewed'].some((key) => source[key] !== true)) reasons.push('source-model-birth-license-privacy-not-admitted')
    const localSourceBlockers = [], sourceReview = loadBound(root, source?.reviewRef, 'source-review', localSourceBlockers)
    reasons.push(...localSourceBlockers)
    if (sourceReview && (sourceReview.schema !== 'cfb.source-admission-review/1' || sourceReview.inputSha256 !== input || sourceReview.status !== 'admitted' || sourceReview.fixtureOnly !== false || sourceReview.rawSha256 !== sha256(annotation.raw) || sourceReview.ctxSha256 !== sha256(annotation.ctx))) reasons.push('source-proof-content-mismatch')
    if (sourceReview && (sourceReview.sourceModel?.id !== contract.receiver.id || !nonempty(sourceReview.sourceModel?.servedVersion))) reasons.push('source-model-not-attested-in-initial-target-scope')
    if (!entry?.families?.includes(annotation.family)) reasons.push('registry-family-not-bound')
    if (!entry?.repo) reasons.push('repository-identity-not-attested')
    if (reasons.length) { rejected.push({ caseId: annotation.caseId, inputSha256: input, reasons: [...new Set(reasons)] }); continue }
    const flat = toFlatSft(annotation, { repo: entry.repo, system: prompt })
    accepted.push({ split: annotation.finalSplit, row: flat })
    lineage.push({ schema: 'cfb.flat-sft-lineage/1', id: flat.id, repo: flat.repo, family: annotation.family, split: annotation.finalSplit, inputSha256: input,
      rawSha256: sha256(annotation.raw), ctxSha256: sha256(annotation.ctx), targetSha256: sha256(flat.assistant), flatRowSha256: flatRowDigest(flat),
      annotationSha256: boundAnnotationDigest(annotation), completeReviewSha256: digestJson(review), sourceReviewSha256: source.reviewRef.sha256, sourceReviewRecordSha256: digestJson(sourceReview),
      annotation, completeReview: review, sourceReview,
      trainingPromptSha256: sha256(prompt), teacherPromptLineage: { originalSource: annotation.source || null, sourceId: annotation.sourceId || null, draftingMethod: sourceReview.draftingMethod || 'must-be-attested-in-source-review', note: 'Training prompt is not relabelled as the prompt that created historical drafts.' } })
  }
  const groups = { train: accepted.filter((r) => r.split === 'train').map((r) => r.row), dev: accepted.filter((r) => r.split === 'dev').map((r) => r.row) }
  if (!groups.train.length) blockers.push('no-admitted-train-cases')
  if (!groups.dev.length) blockers.push('no-admitted-whole-family-dev-cases')
  if (rejected.length) blockers.push('input-cases-rejected; inspect-full-rejection-ledger')
  const trainRepos = new Set(groups.train.map((r) => r.repo)), devRepos = new Set(groups.dev.map((r) => r.repo))
  if ([...trainRepos].some((r) => devRepos.has(r))) blockers.push('repository-leakage')
  const prereg = loadBound(root, evidence.preregistration, 'new-preregistration', blockers)
  const ruler = loadBound(root, evidence.ruler, 'new-ruler', blockers)
  if (evidence.preregistration?.path?.startsWith('data-v9/') || evidence.ruler?.path?.startsWith('data-v9/')) blockers.push('frozen-invalid-v9-cannot-sign-new-admission')
  if (prereg && (prereg.status !== 'frozen-for-content-and-original-reader-evaluation' || !prereg.promotionThresholds || !Object.keys(prereg.promotionThresholds).length || Object.values(prereg.promotionThresholds).some((v) => v === null))) blockers.push('new-thresholds-not-frozen')
  if (ruler) {
    const checks = Object.entries(ruler.validity || {}).filter(([key]) => key !== 'VALID')
    if (ruler.preregSha256 !== evidence.preregistration?.sha256 || ruler.validity?.VALID !== 'VALID' || !checks.length || checks.some(([,v]) => v !== 'PASS') || ruler.fixtureOnly !== false || ruler.originalReaderValidated !== true) blockers.push('ruler-not-valid-original-reader-bound')
  }
  const reader = loadBound(root, evidence.readerStudy, 'original-reader-study', blockers)
  if (reader && (reader.schema !== 'cfb.original-reader-study/1' || reader.actualExecution !== true || reader.fixtureOnly !== false || reader.receiver !== contract.receiver.id || reader.aAControlExecuted !== true || reader.allRegisteredCasesAccounted !== true || reader.referenceUtilityVerified !== true || reader.preregSha256 !== evidence.preregistration?.sha256 || !nonempty(reader.readerVersion))) blockers.push('reader-study-not-real-bound-full-case-AA-and-reference-utility')
  const cpu = loadBound(root, evidence.cpu, 'cpu-receipt', blockers)
  if (cpu && (cpu.kind !== 'cpuQualityAndLatencyVerified' || cpu.verified !== true || cpu.actualExecution !== true || cpu.fixtureOnly !== false || cpu.model?.id !== model.id || cpu.model?.revision !== model.revision)) blockers.push('CPU-candidate-feasibility-not-verified')
  if (errors.length) blockers.push('input-integrity-errors')
  const uniqueBlockers = [...new Set(blockers)]
  return { groups, lineage, errors, rejected,
    manifest: { schema: 'cfb.formal-sft-preflight/1', trainingReady: !uniqueBlockers.length, trainingExecuted: false, model,
      counts: { inputCases: annotations.length, train: groups.train.length, dev: groups.dev.length, rejected: rejected.length },
      implementation: { exporterSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), reviewContractSha256: sha256(fs.readFileSync(new URL('./review-contract.mjs', import.meta.url))) },
      sources: { annotationSetSha256: digestJson(annotations), completeReviewSetSha256: digestJson(reviews), registrySha256: digestJson(registry), taskContractSha256: digestJson(contract), trainingPromptSha256: sha256(prompt) },
      blockers: uniqueBlockers, errors, rejected,
      evidence, reviewPolicy: contract.data.reviewPolicy, scope: 'Integrity of complete attached reviews; not independent semantic certification.',
      paidApiCalls: 0, modelExecutions: 0, gpuRuns: 0, blindConsumed: 0,
    } }
}

export function writeFormalBundle({ root = ROOT, out, result, annotations, reviews, registry, contract, prompt, evidence = {} }) {
  for (const [key, value] of [['annotationSetSha256',annotations], ['completeReviewSetSha256',reviews], ['registrySha256',registry], ['taskContractSha256',contract]]) if (digestJson(value) !== result.manifest.sources[key]) throw new Error('formal-input-changed-after-preflight:' + key)
  if (sha256(prompt) !== result.manifest.sources.trainingPromptSha256) throw new Error('formal-prompt-changed-after-preflight')
  if (Object.keys(evidence).some((k) => !['preregistration','ruler','readerStudy','cpu'].includes(k))) throw new Error('unexpected-formal-evidence-key')
  const dir = path.resolve(out)
  if (fs.existsSync(dir)) throw new Error('fresh-formal-export-directory-required')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'formal-preflight.json'), JSON.stringify(result.manifest, null, 2) + '\n', { flag: 'wx' })
  if (!result.manifest.trainingReady) return null
  const stageRegistry = structuredClone(registry), stageLineage = structuredClone(result.lineage), sourceReviews = {}, artifactRefs = {}, copied = {}, bindings = {}
  for (const item of stageLineage) {
    const source = stageRegistry.entries.find((e) => e.inputSha256 === item.inputSha256).sourceAdmission
    const ref = source.reviewRef, proofErrors = []
    const proof = loadBound(root, ref, 'source-review-at-export', proofErrors)
    if (proofErrors.length || digestJson(proof) !== item.sourceReviewRecordSha256) throw new Error('source-proof-changed-during-export')
    const filename = 'source-reviews/' + ref.sha256 + '.json', bytes = fs.readFileSync(path.join(root, ref.path))
    if (sha256(bytes) !== ref.sha256) throw new Error('source-proof-changed-during-export')
    const target = path.join(dir, filename); fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!sourceReviews[ref.sha256]) fs.writeFileSync(target, bytes, { flag: 'wx' })
    sourceReviews[ref.sha256] = { path: filename, sha256: ref.sha256 }
    source.reviewRef = sourceReviews[ref.sha256]; item.sourceReviewRef = sourceReviews[ref.sha256]
  }
  for (const split of ['train', 'dev']) {
    const text = encodeRows(result.groups[split]); fs.writeFileSync(path.join(dir, split + '.jsonl'), text, { flag: 'wx' })
    artifactRefs[split] = { sha256: sha256(text), rows: result.groups[split].length }
  }
  const lineageText = encodeRows(stageLineage); fs.writeFileSync(path.join(dir, 'lineage.jsonl'), lineageText, { flag: 'wx' })
  for (const [key, ref] of Object.entries(evidence)) {
    const verificationErrors = []; loadBound(root, ref, key + '-at-export', verificationErrors)
    if (verificationErrors.length) throw new Error('stage-receipt-changed-during-export:' + key)
    const filename = key + '.json', bytes = fs.readFileSync(path.join(root, ref.path))
    if (sha256(bytes) !== ref.sha256) throw new Error('stage-receipt-changed-during-export:' + key)
    fs.writeFileSync(path.join(dir, filename), bytes, { flag: 'wx' }); copied[key] = { path: filename, sha256: ref.sha256 }
  }
  for (const [key, filename, text] of [['annotations','annotations.jsonl',encodeRows(annotations)], ['reviews','complete-reviews.jsonl',encodeRows(reviews)], ['registry','source-registry.json',JSON.stringify(stageRegistry, null, 2) + '\n'], ['contract','task-contract.json',JSON.stringify(contract, null, 2) + '\n'], ['prompt','training-prompt.txt',prompt]]) {
    fs.writeFileSync(path.join(dir, filename), text, { flag: 'wx' }); bindings[key] = { path: filename, sha256: sha256(text) }
  }
  const admission = { schema: 'cfb.sft-admission/1', status: 'admitted', model: result.manifest.model, artifacts: artifactRefs,
    review: { status: 'complete', reviewerId: 'arena-agent-mode', humanReviewerCount: 0, independentSecondReview: false },
    ruler: { report: copied.ruler.path, sha256: copied.ruler.sha256 },
    formalLineage: { schema: 'cfb.formal-sft-lineage-bundle/1', path: 'lineage.jsonl', sha256: sha256(lineageText), rows: stageLineage.length, bindings, evidence: copied, sourceReviews },
    qualification: 'Attached AI review/source-proof integrity, not independent semantic correctness or authorization to execute training.' }
  // Admission is the final marker; incomplete/corrupt staged output cannot gain it.
  fs.writeFileSync(path.join(dir, 'admission.json'), JSON.stringify(admission, null, 2) + '\n', { flag: 'wx' })
  return admission
}

export function main(argv = process.argv.slice(2)) {
  const args = { annotations: PROGRAM_DIR + '/reviewed-dev.jsonl', reviews: PROGRAM_DIR + '/complete-reviews.jsonl', registry: PROGRAM_DIR + '/source-registry.json', contract: 'tools/micro-generator/task-contract.json', prompt: 'tools/micro-generator/prompt-v1.txt', out: null }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (['annotations','reviews','registry','contract','prompt','out','ruler','preregistration','reader-study','cpu'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i]
    else throw new Error('formal-SFT argument requires value: ' + argv[i])
  }
  const state = readObject(ROOT, 'PROJECT.json'), evidence = {}
  for (const [key, option] of [['preregistration','preregistration'],['ruler','ruler'],['readerStudy','reader-study'],['cpu','cpu']]) if (args[option]) evidence[key] = fileRef(ROOT, args[option])
  const annotationBytes = fs.readFileSync(path.resolve(ROOT, args.annotations)), reviewBytes = fs.readFileSync(path.resolve(ROOT, args.reviews)), registryBytes = fs.readFileSync(path.resolve(ROOT, args.registry)), contractBytes = fs.readFileSync(path.resolve(ROOT, args.contract)), promptBytes = fs.readFileSync(path.resolve(ROOT, args.prompt))
  const result = buildFormalSft({ annotations: readJsonl(path.resolve(ROOT, args.annotations)), reviews: readJsonl(path.resolve(ROOT, args.reviews)), registry: JSON.parse(registryBytes), contract: JSON.parse(contractBytes), prompt: promptBytes.toString('utf8'), model: { id: state.route.firstCandidate, revision: state.route.modelRevision }, evidence })
  if (args.out) writeFormalBundle({ out: path.resolve(ROOT, args.out), result, annotations: readJsonl(path.resolve(ROOT, args.annotations)), reviews: readJsonl(path.resolve(ROOT, args.reviews)), registry: JSON.parse(registryBytes), contract: JSON.parse(contractBytes), prompt: promptBytes.toString('utf8'), evidence })
  console.log(JSON.stringify(result.manifest, null, 2))
  return result.manifest.trainingReady ? 0 : 2
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { process.exitCode = main() } catch (e) { console.error(e.stack || e); process.exitCode = 1 } }
