#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inputSha256, readJsonl, sha256, validateAnnotation, validateFamilyIsolation, writeJsonl } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function reviewedForTraining(row) {
  if (row.trainingEligible !== true) return false
  if (row.annotationStatus !== 'adjudicated' || row.sourceCoverage !== 'complete') return false
  if (row.referenceReview?.status !== 'adjudicated' || row.referenceReview.allMustPreserveFactsSatisfied !== true) return false
  if (row.referenceReview.unsupportedClaimsReviewed !== true || row.referenceReview.unsupportedClaimsCount !== 0) return false
  const byId = new Map((row.referenceReview.factStatuses || []).map((x) => [x.factId, x.status]))
  return row.facts.length > 0 && row.facts.every((fact) => {
    const status = byId.get(fact.factId)
    return status && (!fact.mustPreserve || status === 'preserved')
  })
}
function toTrainingExample(row) {
  return {
    schema: 'cfb.micro-generator-training-example/1',
    caseId: row.caseId, family: row.family, split: row.finalSplit,
    raw: row.raw, ctx: row.ctx, draft: row.referenceDraft,
    facts: row.facts, sourceCoverage: row.sourceCoverage,
    annotationStatus: row.annotationStatus, reviewers: row.reviewers, reviewProvenance: row.reviewProvenance,
    referenceReview: row.referenceReview, trainingEligible: true,
    sourceHashes: row.sourceHashes,
  }
}

function conflictingInputTargets(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (typeof row.raw !== 'string' || typeof row.ctx !== 'string') continue
    const hash = inputSha256({ raw: row.raw, ctx: row.ctx })
    const group = groups.get(hash) || { inputSha256: hash, caseIds: new Set(), targetHashes: new Set(), families: new Set() }
    group.caseIds.add(row.caseId)
    group.targetHashes.add(row.sourceHashes?.referenceSha256 || sha256(String(row.referenceDraft ?? '')))
    group.families.add(row.family)
    groups.set(hash, group)
  }
  return [...groups.values()].filter((group) => group.targetHashes.size > 1).map((group) => ({
    inputSha256: group.inputSha256,
    caseIds: [...group.caseIds].sort(),
    targetHashes: [...group.targetHashes].sort(),
    families: [...group.families].sort(),
  })).sort((a, b) => a.inputSha256.localeCompare(b.inputSha256))
}

export function buildExport(rows) {
  const errors = rows.flatMap((row) => validateAnnotation(row))
  const targetConflicts = conflictingInputTargets(rows)
  errors.push(...validateFamilyIsolation(rows, { splitKey: 'finalSplit' }))
  const unassigned = rows.filter((row) => row.finalSplit == null).map((row) => `${row.caseId}: no final family split assigned`)
  const groups = { train: [], dev: [], blind: [] }
  const excluded = []
  for (const row of rows) {
    if (!groups[row.finalSplit]) { excluded.push({ caseId: row.caseId, reason: 'unassigned-or-invalid-split' }); continue }
    if (!reviewedForTraining(row)) { excluded.push({ caseId: row.caseId, reason: 'fact-or-reference-review-incomplete' }); continue }
    if (row.finalSplit === 'blind') groups.blind.push(row)
    else groups[row.finalSplit].push(toTrainingExample(row))
  }
  const trainingFamilies = [...new Set(groups.train.map((x) => x.family))].sort()
  const devFamilies = [...new Set(groups.dev.map((x) => x.family))].sort()
  const blindFamilies = [...new Set(groups.blind.map((x) => x.family))].sort()
  const overlap = (a, b) => a.filter((x) => b.includes(x))
  const blockers = []
  if (errors.length) blockers.push('queue-integrity-errors')
  if (unassigned.length) blockers.push('some-cases-have-no-final-split')
  if (!groups.train.length) blockers.push('no-ai-reviewed-training-examples')
  if (!groups.dev.length) blockers.push('no-ai-reviewed-family-heldout-dev-examples')
  if (trainingFamilies.length < 2) blockers.push('need-at-least-two-training-families')
  if (devFamilies.length < 1) blockers.push('need-at-least-one-dev-family')
  if (overlap(trainingFamilies, devFamilies).length) blockers.push('train-dev-family-overlap')
  if (overlap(trainingFamilies, devFamilies).length || overlap(trainingFamilies, blindFamilies).length || overlap(devFamilies, blindFamilies).length) blockers.push('family-split-leakage')
  if (targetConflicts.length) blockers.push('identical-input-has-multiple-reference-targets')
  const trainingReady = blockers.length === 0
  const blindLeakage = overlap(trainingFamilies, blindFamilies).length || overlap(devFamilies, blindFamilies).length
  const confirmatoryBlockers = []
  if (!groups.blind.length) confirmatoryBlockers.push('no-registered-blind-examples')
  if (blindLeakage) confirmatoryBlockers.push('blind-family-split-leakage')
  if (targetConflicts.length) confirmatoryBlockers.push('identical-input-has-multiple-reference-targets')
  confirmatoryBlockers.push('frozen-gates-and-blind-registry-must-be-validated-by-evaluator')
  const confirmatoryReady = false
  const manifest = {
    schema: 'cfb.micro-generator-export-manifest/1',
    queueSha256: sha256(JSON.stringify(rows)),
    reviewPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
    counts: { queueRows: rows.length, train: groups.train.length, dev: groups.dev.length, blindPrivate: groups.blind.length, excluded: excluded.length },
    conflictingInputTargets: targetConflicts,
    families: { train: trainingFamilies, dev: devFamilies, blindPrivate: blindFamilies },
    trainingReady,
    confirmatoryEvaluationReady: confirmatoryReady,
    confirmatoryBlockers,
    blockers,
    unassigned,
    excluded,
    safety: {
      blindPrivateArtifactMustNotBeUploadedToKaggle: true,
      blindPrivateArtifactWrittenOnlyToExplicitExternalPath: true,
      evaluationClaimsRequireFrozenGatesAndCompleteOutputAdjudication: true,
    },
  }
  return { groups, manifest, errors }
}

function parseArgs(argv) {
  const out = { queue: 'transfer/models/micro-generator-review-queue.jsonl', outDir: 'transfer/models/micro-generator-corpus', privateOut: null, write: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--queue') out.queue = argv[++i]
    else if (argv[i] === '--out-dir') out.outDir = argv[++i]
    else if (argv[i] === '--private-out') out.privateOut = argv[++i]
    else if (argv[i] === '--write') out.write = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const queueFile = path.resolve(ROOT, args.queue)
    const rows = readJsonl(queueFile)
    const result = buildExport(rows)
    const outDir = path.resolve(ROOT, args.outDir)
    const privateFile = args.privateOut ? path.resolve(ROOT, args.privateOut) : null
    if (privateFile) {
      const relPrivate = path.relative(outDir, privateFile)
      if (relPrivate === '' || (!relPrivate.startsWith('..' + path.sep) && relPrivate !== '..' && !path.isAbsolute(relPrivate))) throw new Error('--private-out must be outside --out-dir; keep blind labels separate from Kaggle uploads')
    }
    if (args.write) {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(result.manifest, null, 2) + '\n')
      if (result.errors.length) {
        fs.writeFileSync(path.join(outDir, 'preflight-errors.json'), JSON.stringify(result.errors, null, 2) + '\n')
        console.error(`[micro-generator-export] refused: ${result.errors.length} queue-integrity errors`)
        process.exitCode = 2
      } else if (!result.manifest.trainingReady) {
        for (const file of ['train.jsonl', 'dev.jsonl']) fs.rmSync(path.join(outDir, file), { force: true })
        console.log(`[micro-generator-export] trainingReady=false; no train/dev files written; blockers=${result.manifest.blockers.join(',')}`)
      } else {
        writeJsonl(path.join(outDir, 'train.jsonl'), result.groups.train)
        writeJsonl(path.join(outDir, 'dev.jsonl'), result.groups.dev)
        if (privateFile && result.groups.blind.length) {
          fs.mkdirSync(path.dirname(privateFile), { recursive: true })
          writeJsonl(privateFile, result.groups.blind)
        }
        console.log(`[micro-generator-export] wrote train=${result.groups.train.length}, dev=${result.groups.dev.length}; blind cases=${result.groups.blind.length}; blind labels are written only to a separate --private-out path`)
      }
    } else console.log(JSON.stringify(result.manifest, null, 2))
  } catch (error) {
    console.error(`[micro-generator-export] ${error.message}`)
    process.exitCode = 1
  }
}
