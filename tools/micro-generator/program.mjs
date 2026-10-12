#!/usr/bin/env node
// One local control plane for the continuation programme. No API/model imports.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inputSha256, readJsonl, sha256 } from './lib.mjs'
import { assessReference, digestJson } from './review-contract.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PROGRAM_DIR = 'transfer/program-2026-10-12'
export const SOURCE_CATALOG = [
  { path: 'transfer/models/micro-generator-review-queue.jsonl', role: 'existing-dev-raw-reannotation', scope: 'existing-dev', model: null, harness: 'CFB historical capture; exact served version not attested', license: 'not-admitted' },
  { path: 'transfer/models/micro-generator-ai-reviewed-dev-candidates.jsonl', role: 'partial-review-proposals', scope: 'existing-dev', model: null, harness: 'derived from the same CFB raw/ctx', license: 'not-admitted' },
  { path: 'transfer/models/micro-generator-open-swe-seed/annotations.jsonl', role: 'off-target-auxiliary', scope: 'auxiliary-exposed', model: 'Qwen3.8-27B', harness: 'mini-swe-agent', license: 'upstream declarations retained; not target admission' },
  { path: PROGRAM_DIR + '/reviewed-dev.jsonl', role: 'complete-ai-review-development', scope: 'existing-dev', model: null, harness: 'retained CFB raw/ctx; no new reader execution', license: 'not-admitted' },
]
const HISTORICAL_REPORTS = [
  'transfer/models/micro-generator-gen/corpus-report.json',
  'transfer/models/micro-generator-gen-v3/corpus-report.json',
  'transfer/models/micro-generator-gen-batch3/corpus-report.json',
  'transfer/models/micro-generator-gen-v4/corpus-report.json',
  'transfer/models/micro-generator-gen-v5/corpus-report.json',
  'data-v9/validation.json',
]
export const readObject = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
export const fileRef = (root, rel) => ({ path: rel, sha256: sha256(fs.readFileSync(path.join(root, rel))) })
const exposed = (x) => ['existing-dev', 'auxiliary-exposed', 'synthetic-exposed'].includes(x)

export function buildSourceRegistry(root = ROOT, catalog = SOURCE_CATALOG) {
  const assets = [], groups = new Map(), caseIds = new Map(), errors = []
  let sourceRecords = 0
  for (const spec of catalog) {
    const full = path.join(root, spec.path)
    if (!fs.existsSync(full)) { assets.push({ path: spec.path, status: 'not-materialized', role: spec.role }); errors.push('required-retained-catalog-source-not-materialized:' + spec.path); continue }
    const rows = readJsonl(full)
    assets.push({ ...fileRef(root, spec.path), status: 'materialized', role: spec.role, records: rows.length })
    for (const [index, row] of rows.entries()) {
      sourceRecords++
      if (typeof row?.caseId !== 'string' || !row.caseId.trim() || typeof row.family !== 'string' || !row.family.trim() || typeof row.raw !== 'string' || !row.raw || typeof row.ctx !== 'string' || typeof row.referenceDraft !== 'string') { errors.push(`${spec.path}:${index + 1}: invalid retained input`); continue }
      const input = inputSha256(row), draft = sha256(row.referenceDraft)
      if (row.sourceHashes?.rawSha256 !== sha256(row.raw) || row.sourceHashes?.ctxSha256 !== sha256(row.ctx) || row.sourceHashes?.referenceSha256 !== draft) errors.push(`${row.caseId}: stale source hashes`)
      const identity = input + ':' + draft
      if (caseIds.has(row.caseId) && caseIds.get(row.caseId) !== identity) errors.push(`${row.caseId}: case ID reused for different content`)
      caseIds.set(row.caseId, identity)
      let group = groups.get(input)
      if (!group) {
        group = { inputSha256: input, rawSha256: sha256(row.raw), ctxSha256: sha256(row.ctx), rawChars: row.raw.length, ctxChars: row.ctx.length, families: [], records: [], targetHashes: [], exposure: [], roles: [], sourceAdmission: { admitted: false, modelVersionVerified: false, temporalBoundaryVerified: false, licenseReviewed: false, privacyReviewed: false }, trainingAdmitted: false }
        groups.set(input, group)
      }
      for (const [key, value] of [['families', row.family], ['targetHashes', draft], ['exposure', spec.scope], ['roles', spec.role]]) if (!group[key].includes(value)) group[key].push(value)
      group.records.push({ caseId: row.caseId, artifact: spec.path, line: index + 1, recordSha256: digestJson(row), referenceSha256: draft, sourceId: row.sourceId || null, originalSource: row.source || null, declaredSourceCoverage: row.sourceCoverage, declaredAnnotationStatus: row.annotationStatus, declaredTrainingEligible: row.trainingEligible === true, finalSplit: row.finalSplit, model: spec.model, harness: spec.harness, licenseState: spec.license })
      if (exposed(spec.scope) && (row.finalSplit === 'train' || row.finalSplit === 'blind')) errors.push(`${row.caseId}: exposed development/auxiliary record reassigned to ${row.finalSplit}`)
    }
  }
  const entries = [...groups.values()].sort((a, b) => a.inputSha256.localeCompare(b.inputSha256))
  for (const entry of entries) {
    for (const key of ['families', 'targetHashes', 'exposure', 'roles']) entry[key].sort()
    entry.targetDisagreement = entry.targetHashes.length > 1 ? 'multiple-drafts-not-automatically-a-conflict; equivalence/adjudication-needed' : 'single-retained-draft'
    entry.canReannotateForDevelopment = entry.roles.includes('existing-dev-raw-reannotation')
    entry.repo = entry.families.length === 1 && entry.families[0]?.startsWith('repo:') ? entry.families[0].slice(5) : null
  }
  for (const rel of HISTORICAL_REPORTS) if (fs.existsSync(path.join(root, rel))) {
    const report = readObject(root, rel)
    assets.push({ ...fileRef(root, rel), status: 'historical-report-only', role: 'research-not-training-admission', reportedCounts: report.train?.rows ? { trainRows: report.train.rows, devRows: report.dev?.rows ?? null } : null, reportedTeacher: report.teacher || null, qualification: 'Report metadata, not re-adjudicated rows; frozen v9 stays INVALID.' })
  }
  return {
    schema: 'cfb.source-registry/1', scope: 'explicit exposed-source catalog; no blind source discovery or automatic archive promotion',
    entries, assets, errors,
    counts: { retainedRecords: sourceRecords, uniqueRawCtx: entries.length, repeatedInputObservations: sourceRecords - entries.length, sourceFamilies: new Set(entries.flatMap((r) => r.families)).size, trainingAdmitted: 0 },
    automaticTrainingAdmission: false, independentSampleCount: null,
    qualification: 'Content deduplicated registry, not independent sample count; raw source quality and draft label quality are separate.',
  }
}

export function reviewReport(root = ROOT) {
  const annotationPath = PROGRAM_DIR + '/reviewed-dev.jsonl', sidecarPath = PROGRAM_DIR + '/complete-reviews.jsonl'
  const annotations = fs.existsSync(path.join(root, annotationPath)) ? readJsonl(path.join(root, annotationPath)) : []
  const reviews = fs.existsSync(path.join(root, sidecarPath)) ? readJsonl(path.join(root, sidecarPath)) : []
  const byId = new Map(), extraErrors = []
  for (const row of reviews) { if (byId.has(row.caseId)) extraErrors.push('duplicate review: ' + row.caseId); byId.set(row.caseId, row) }
  const cases = annotations.map((a) => assessReference(a, byId.get(a.caseId)))
  for (const review of reviews) if (!annotations.some((a) => a.caseId === review.caseId)) extraErrors.push('orphan review: ' + review.caseId)
  if (!annotations.length) extraErrors.push('no complete development review examples')
  return { schema: 'cfb.development-review-report/1', annotationRef: annotations.length ? fileRef(root, annotationPath) : null, reviewRef: reviews.length ? fileRef(root, sidecarPath) : null, cases, errors: [...extraErrors, ...cases.flatMap((r) => r.errors)], completeAiReviewedCases: cases.filter((r) => r.reviewApparatusPass).length, humanReviews: 0, independentSecondReviews: 0, trainingAdmitted: false, originalReceiverValidated: false }
}

export function workStatus(root = ROOT) {
  const registry = buildSourceRegistry(root), review = reviewReport(root)
  const contract = readObject(root, 'tools/micro-generator/task-contract.json')
  return {
    schema: 'cfb.continuation-work-status/1', ok: !registry.errors.length && !review.errors.length,
    contract: fileRef(root, 'tools/micro-generator/task-contract.json'), preregistration: fileRef(root, 'tools/micro-generator/continuation-prereg.json'),
    registry: { counts: registry.counts, errors: registry.errors }, review,
    readiness: { ready: false, blockers: ['actual receiver/channel and wire capture unavailable', 'resource budget not confirmed', 'reference-versus-raw and A/A reader experiment not executed', 'new evaluator not validated and numerical deployment thresholds not frozen', 'zero admitted training cases', 'native tokenizer/CPU model capability and latency not executed'] },
    authorizations: contract.authorization,
    paidApiCallsByThisCommand: 0, modelExecutionsByThisCommand: 0, gpuRunsByThisCommand: 0, newBlindConsumedByThisCommand: 0,
  }
}

export function writeFresh(file, value) {
  if (fs.existsSync(file)) throw new Error('fresh-program-output-required: ' + file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status'
  if (!['status', 'registry', 'review'].includes(command)) throw new Error('use status|registry|review [--out NEW_FILE]')
  let out = null
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1] && !argv[i + 1].startsWith('--')) out = argv[++i]
    else if (argv[i] !== '--json') throw new Error('invalid program argument: ' + argv[i])
  }
  const result = command === 'registry' ? buildSourceRegistry() : command === 'review' ? reviewReport() : workStatus()
  if (out) writeFresh(path.resolve(ROOT, out), result)
  console.log(JSON.stringify(result, null, 2))
  return result.errors?.length || result.ok === false ? 1 : 0
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = main() } catch (e) { console.error(e.message); process.exitCode = 1 }
}
