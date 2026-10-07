#!/usr/bin/env node
/**
 * Prepare a minimal sequence-level corpus inventory for a generative micro-compressor.
 * This deliberately does not train a model or copy source text into the manifest.
 * References and accepted captures remain separate until the AI single-reviewer fact review exists.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GOLD_DIR = path.join(ROOT, 'transfer', 'gold')
const MICRO_DATASET = path.join(ROOT, 'transfer', 'models', 'micro-dev-dataset.json')
const OUT = path.join(ROOT, 'transfer', 'models', 'micro-generator-preparation.json')
const sha = (value) => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
const rel = (value) => path.relative(ROOT, value).split(path.sep).join('/')
const variantId = (id) => /_(?:decoy|long-horizon)(?:-|$)/.test(String(id || ''))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function findGoldFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return findGoldFiles(file)
    return entry.isFile() && entry.name.endsWith('.json') ? [file] : []
  }).sort()
}

function sourceDigest({ raw, ctx, target }) {
  return {
    rawSha256: sha(raw),
    ctxSha256: sha(ctx),
    targetSha256: sha(target),
    inputSha256: sha(`${sha(raw)}:${sha(ctx)}`),
  }
}

function summarizeCapture(row) {
  const target = row.draft || ''
  const digest = sourceDigest({ raw: row.raw, ctx: row.ctx, target })
  return {
    id: row.id,
    family: row.family,
    task: row.task,
    source: 'transfer/models/micro-dev-dataset.json#handSamples',
    split: row.split,
    rawChars: String(row.raw || '').length,
    ctxChars: String(row.ctx || '').length,
    targetChars: target.length,
    ...digest,
    captureAudit: row.qualityAudit?.status || 'missing',
    aiSingleReviewerFactReview: 'not-recorded',
    trainingEligible: false,
    reason: 'accepted capture and apparatus-clean audit do not establish semantic completeness',
  }
}

function buildManifest() {
  const goldRows = []
  const excludedGold = { holdout: [], variants: [], nonTrainingUse: [] }
  for (const file of findGoldFiles(GOLD_DIR)) {
    const row = readJson(file)
    const source = rel(file)
    const entry = {
      id: row.id,
      family: row.family,
      split: row.split,
      use: row.use || null,
      source,
      rawChars: String(row.raw || '').length,
      ctxChars: String(row.ctx || '').length,
      targetChars: String(row.draft || '').length,
      ...sourceDigest({ raw: row.raw, ctx: row.ctx, target: row.draft }),
      qualityAudit: row.qualityAudit?.status || 'missing',
      goldStandardStatus: row.goldStandard?.status || null,
      aiSingleReviewerFactReview: 'not-recorded',
    }
    if (row.split !== 'dev') { excludedGold.holdout.push(entry); continue }
    if (variantId(row.id)) { excludedGold.variants.push(entry); continue }
    if (row.use !== 'train') { excludedGold.nonTrainingUse.push(entry); continue }
    if (!row.raw || !row.ctx || !row.draft) throw new Error(`incomplete sequence example: ${row.id}`)
    goldRows.push(entry)
  }

  const dataset = readJson(MICRO_DATASET)
  if (dataset.schema !== 'cfb.micro-dev-dataset/3') throw new Error(`unexpected micro dataset schema: ${dataset.schema}`)
  const captures = (dataset.handSamples || [])
    .filter((row) => row.split === 'dev' && row.trainingEligible === true && row.raw && row.ctx && row.draft)
    .map(summarizeCapture)
  const uniqueCaptures = [...new Map(captures.map((row) => [
    `${row.rawSha256}:${row.ctxSha256}:${row.targetSha256}`, row,
  ])).values()]

  const inputsToTargets = new Map()
  for (const row of uniqueCaptures) {
    const refs = inputsToTargets.get(row.inputSha256) || new Set()
    refs.add(row.targetSha256)
    inputsToTargets.set(row.inputSha256, refs)
  }
  const conflictingCaptureInputs = [...inputsToTargets]
    .filter(([, targets]) => targets.size > 1)
    .map(([inputSha256, targets]) => ({ inputSha256, distinctTargets: targets.size }))

  const families = [...new Set(goldRows.map((row) => row.family))].sort()
  const captureFamilies = [...new Set(uniqueCaptures.map((row) => row.family))].sort()
  const allDevFamilies = [...new Set([...families, ...captureFamilies])].sort()
  const holdoutFamilies = [...new Set(dataset.holdoutFamiliesExcluded || [])].sort()
  const manifest = {
    schema: 'cfb.micro-generator-preparation/1',
    createdAt: new Date().toISOString(),
    sourcePolicy: {
      input: 'raw + ctx',
      referenceTarget: 'draft (not stored; stored includes prior carried-forward state)',
      splitUnit: 'family; never randomly split rows from the same family',
      reviewPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
      holdoutsExcludedFromTraining: holdoutFamilies,
      decoyAndLongHorizonVariants: 'excluded as independent families; retain only as within-family robustness cases',
      capturePolicy: 'accepted captures are a review queue, not semantic gold; quality/audit gates do not certify factual coverage',
    },
    modelSizePolicy: {
      target: 'smallest model that passes fact-preservation and new-family generalization gates',
      hardParameterCap: null,
      selectionProcedure: 'establish a generative baseline, then distill/quantize downward and retain the smallest passing checkpoint',
      initialSmokeBaseline: 'Qwen/Qwen3-0.6B; candidate only, not a locked production model',
    },
    implementationArtifacts: {
      reviewQueueBuilder: 'tools/micro-generator/prepare-review-queue.mjs',
      contextFactReviewStarter: 'tools/micro-generator/build-fact-draft-suggestions.mjs',
      aiReviewWorkbookBuilder: 'tools/micro-generator/build-ai-review-workbook.py (AI single-review policy)',
      reviewedCorpusExporter: 'tools/micro-generator/export-reviewed-corpus.mjs',
      annotationContract: 'tools/micro-generator/annotation.schema.json',
      predictionContract: 'tools/micro-generator/prediction.schema.json',
      familySplitTemplate: 'tools/micro-generator/family-splits.template.json',
      gateTemplate: 'tools/micro-generator/evaluation-gates.template.json',
      gateFreezer: 'tools/micro-generator/freeze-gates.mjs',
      aiReviewGuide: 'tools/micro-generator/REVIEW-GUIDE.md (AI single-review policy)',
      evaluator: 'tools/micro-generator/evaluate.mjs',
      smallestPassingSelector: 'tools/micro-generator/select-smallest-passing.mjs',
      localGgufInference: 'tools/micro-generator/run_gguf.py',
      transformerInference: 'tools/micro-generator/run_hf.py',
      blindInferenceProtocol: 'tools/micro-generator/gate_protocol.py',
      kaggleQloraTrainer: 'tools/micro-generator/train_qlora.py',
      kaggleNotebook: 'tools/micro-generator/kaggle_qwen3_qlora.ipynb',
    },
    executionReadiness: {
      localTrainingAllowed: false,
      localTrainingReason: '2 CPU cores, about 1.9 GiB RAM, no detected GPU or training stack; this workspace is not a credible fine-tuning host',
      localCpuInference: 'not-run; the 0.6B Q8 GGUF file is about 639 MB but its repository scan metadata flags PAIT-GGUF-100; inspect the exact template before loading; CPU fit/throughput are unverified',
      qloraRunLocation: 'user-operated Kaggle GPU or equivalent; notebook prepared but not launched',
    },
    factAnnotationContract: {
      requiredBeforeConfirmatoryEvaluation: true,
      status: 'schema-ready-no-adjudicated-labels',
      fields: ['factId', 'proposition', 'sourceSpan', 'importance', 'polarity', 'modality', 'conditions', 'entities', 'mustPreserve'],
      rules: [
        'no anchor overlap is not evidence that a source fact is noise',
        'semantic paraphrases count as preserved; copied wording is not required',
        'critical omissions, polarity flips, dropped conditions/numbers, and unsupported claims are scored separately',
      ],
    },
    readiness: {
      fineTuneNow: false,
      status: 'preparation-only-no-domain-appropriate-train-data',
      blockers: [
        `only ${goldRows.length} canonical dev hand-reference sequences are available`,
        `only ${allDevFamilies.length} dev families are represented; no genuinely new-family blind set is registered`,
        'no source-to-summary atomic fact annotations are recorded',
        'accepted captures have not received complete AI single-reviewer semantic coverage review',
        'one identical raw+ctx input maps to two distinct reference drafts and remains excluded until a canonical target is chosen and reviewed',
      ],
    },
    counts: {
      canonicalDevReferences: goldRows.length,
      canonicalReferenceFamilies: families.length,
      canonicalReferenceFamilyNames: families,
      eligibleCaptureRows: captures.length,
      distinctCaptureInputTargetTriples: uniqueCaptures.length,
      distinctCaptureInputPairs: inputsToTargets.size,
      captureFamilies: captureFamilies.length,
      captureFamilyNames: captureFamilies,
      totalDevFamilyNames: allDevFamilies,
      holdoutGoldExcluded: excludedGold.holdout.length,
      decoyOrLongHorizonVariantsExcluded: excludedGold.variants.length,
      nonTrainingGoldExcluded: excludedGold.nonTrainingUse.length,
      captureInputsWithMultipleTargets: conflictingCaptureInputs.length,
    },
    canonicalDevReferences: goldRows,
    captureSemanticReviewQueue: uniqueCaptures,
    captureInputsWithMultipleTargets: conflictingCaptureInputs,
    exclusions: excludedGold,
  }
  return manifest
}

const manifest = buildManifest()
const outArg = process.argv.find((arg) => arg.startsWith('--write='))
if (outArg) {
  const target = path.resolve(ROOT, outArg.slice('--write='.length))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[micro-generator-prep] wrote ${rel(target)}`)
} else if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[micro-generator-prep] wrote ${rel(OUT)}`)
} else {
  console.log(JSON.stringify(manifest, null, 2))
}
console.log(`[micro-generator-prep] canonicalRefs=${manifest.counts.canonicalDevReferences} captures=${manifest.counts.eligibleCaptureRows} dedupedCaptures=${manifest.counts.distinctCaptureInputTargetTriples} families=${manifest.counts.totalDevFamilyNames} fineTuneNow=${manifest.readiness.fineTuneNow}`)
