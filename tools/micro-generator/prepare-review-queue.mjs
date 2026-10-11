#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256, stableCaseId, writeJsonl } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_QUEUE = 'transfer/models/micro-generator-review-queue.jsonl'
const DEFAULT_MANIFEST = 'transfer/models/micro-generator-review-queue.manifest.json'
const variantId = (id) => /_(?:decoy|long-horizon)(?:-|$)/.test(String(id || ''))
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

function findGoldFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return findGoldFiles(full)
    return entry.isFile() && entry.name.endsWith('.json') ? [full] : []
  }).sort()
}

function makeRecord({ id, family, source, sourceKind, provenanceSplit, raw, ctx, draft, audit, referenceStatus }) {
  const rawSha256 = sha256(raw), ctxSha256 = sha256(ctx), referenceSha256 = sha256(draft)
  return {
    schema: 'cfb.micro-generator-annotation/1',
    caseId: stableCaseId({ family, raw, ctx, draft }),
    family,
    finalSplit: null,
    provenanceSplit,
    sourceId: id,
    source,
    sourceKind,
    sourceAudit: audit || 'not-recorded',
    referenceStatus: referenceStatus || 'not-reviewed',
    raw,
    ctx,
    referenceDraft: draft,
    sourceCoverage: 'unreviewed',
    annotationStatus: 'unreviewed',
    reviewers: [],
    facts: [],
    referenceReview: {
      status: 'pending', factStatuses: [], allMustPreserveFactsSatisfied: null,
      unsupportedClaimsReviewed: false, unsupportedClaimsCount: null,
    },
    sourceHashes: { rawSha256, ctxSha256, referenceSha256 },
    trainingEligible: false,
    reviewOnlyReason: 'no complete AI single-reviewer source-fact and reference-claim review; existing family is development-known',
  }
}

export function buildReviewQueue(root = ROOT) {
  const goldDir = path.join(root, 'transfer/gold')
  const datasetFile = path.join(root, 'transfer/models/micro-dev-dataset.json')
  const goldFiles = findGoldFiles(goldDir)
  const dataset = readJson(datasetFile)
  if (dataset.schema !== 'cfb.micro-dev-dataset/3') throw new Error(`unexpected micro dataset schema: ${dataset.schema}`)
  const excludedFamilies = new Set(dataset.holdoutFamiliesExcluded || [])
  const rows = []
  const seenTriples = new Set()
  const counts = { canonicalReferences: 0, acceptedCaptures: 0, deduplicatedTriples: 0, excludedHoldout: 0, excludedVariants: 0 }
  const add = (record) => {
    if (excludedFamilies.has(record.family)) { counts.excludedHoldout++; return }
    const key = `${record.sourceHashes.rawSha256}:${record.sourceHashes.ctxSha256}:${record.sourceHashes.referenceSha256}`
    if (seenTriples.has(key)) { counts.deduplicatedTriples++; return }
    seenTriples.add(key)
    rows.push(record)
  }

  for (const file of goldFiles) {
    const row = readJson(file)
    if (row.split !== 'dev' || row.use !== 'train') continue
    if (variantId(row.id)) { counts.excludedVariants++; continue }
    if (!row.raw || typeof row.ctx !== 'string' || !row.draft) continue
    add(makeRecord({
      id: row.id, family: row.family || row.task, source: rel(file), sourceKind: 'canonical-hand-reference',
      provenanceSplit: 'existing-dev', raw: row.raw, ctx: row.ctx, draft: row.draft,
      audit: row.qualityAudit?.status || 'missing', referenceStatus: row.goldStandard?.status || 'not-gold-standard',
    }))
    counts.canonicalReferences++
  }

  for (const row of dataset.handSamples || []) {
    if (row.split !== 'dev' || row.trainingEligible !== true || !row.raw || typeof row.ctx !== 'string' || !row.draft) continue
    const family = row.family || row.task
    if (!family || excludedFamilies.has(family)) { counts.excludedHoldout++; continue }
    add(makeRecord({
      id: row.id, family, source: 'transfer/models/micro-dev-dataset.json#handSamples', sourceKind: 'accepted-capture-review-queue',
      provenanceSplit: 'existing-dev', raw: row.raw, ctx: row.ctx, draft: row.draft,
      audit: row.qualityAudit?.status || 'missing',
    }))
    counts.acceptedCaptures++
  }
  rows.sort((a, b) => a.family.localeCompare(b.family) || a.caseId.localeCompare(b.caseId))
  const targetsByInput = new Map()
  for (const row of rows) {
    const inputHash = `${row.sourceHashes.rawSha256}:${row.sourceHashes.ctxSha256}`
    const targets = targetsByInput.get(inputHash) || new Set()
    targets.add(row.sourceHashes.referenceSha256)
    targetsByInput.set(inputHash, targets)
  }
  counts.distinctInputs = targetsByInput.size
  counts.inputsWithMultipleTargets = [...targetsByInput.values()].filter((targets) => targets.size > 1).length
  const knownFamilies = [...new Set(rows.map((x) => x.family))].sort()
  const queueText = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  const manifest = {
    schema: 'cfb.micro-generator-review-queue-manifest/1',
    reviewPolicy: { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
    queueSha256: sha256(queueText),
    sourceHashes: {
      microDatasetSha256: sha256(fs.readFileSync(datasetFile)),
      canonicalGoldFiles: goldFiles.filter((file) => {
        const row = readJson(file)
        return row.split === 'dev' && row.use === 'train' && !variantId(row.id)
      }).map((file) => ({ path: rel(file), sha256: sha256(fs.readFileSync(file)) })),
    },
    counts: { records: rows.length, ...counts, families: knownFamilies.length },
    knownFamilies,
    trainingReady: false,
    blockers: [
      'all exported records are unreviewed queue rows, not training examples',
      'source facts and reference claims need complete AI single-reviewer review with explicit provenance',
      'current families are existing development families, not a new blind family',
      'family-level final train/dev/blind assignments are not preregistered',
    ],
  }
  return { rows, queueText, manifest }
}

function args(argv) {
  const out = { write: false, check: false, queue: DEFAULT_QUEUE, manifest: DEFAULT_MANIFEST }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') out.write = true
    else if (argv[i] === '--check') out.check = true
    else if (argv[i] === '--queue') out.queue = argv[++i]
    else if (argv[i] === '--manifest') out.manifest = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (out.write && out.check) throw new Error('--write and --check are mutually exclusive')
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2))
    const built = buildReviewQueue()
    const queueFile = path.resolve(ROOT, a.queue), manifestFile = path.resolve(ROOT, a.manifest)
    if (a.check) {
      const queueOk = fs.existsSync(queueFile) && fs.readFileSync(queueFile, 'utf8') === built.queueText
      const manifestText = JSON.stringify(built.manifest, null, 2) + '\n'
      const manifestOk = fs.existsSync(manifestFile) && fs.readFileSync(manifestFile, 'utf8') === manifestText
      console.log(JSON.stringify({ queueOk, manifestOk, records: built.rows.length, families: built.manifest.knownFamilies.length }))
      if (!queueOk || !manifestOk) process.exitCode = 1
    } else if (a.write) {
      fs.mkdirSync(path.dirname(queueFile), { recursive: true })
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      writeJsonl(queueFile, built.rows)
      fs.writeFileSync(manifestFile, JSON.stringify(built.manifest, null, 2) + '\n')
      console.log(`[micro-generator-review-queue] wrote ${rel(queueFile)} (${built.rows.length} review-only rows)`)
      console.log(`[micro-generator-review-queue] wrote ${rel(manifestFile)}; trainingReady=false`)
    } else console.log(JSON.stringify(built.manifest, null, 2))
  } catch (error) {
    console.error(`[micro-generator-review-queue] ${error.message}`)
    process.exitCode = 1
  }
}
