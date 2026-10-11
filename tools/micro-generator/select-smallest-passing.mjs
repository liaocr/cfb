#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function parseArgs(argv) {
  const reports = []
  let out = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') reports.push(argv[++i])
    else if (argv[i] === '--out') out = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!reports.length) throw new Error('provide one or more --report evaluation.json files')
  return { reports, out }
}

export function selectSmallestPassing(reports) {
  const passing = reports.filter((report) => report.status === 'pass')
  const allGateIds = [...new Set(reports.map((report) => report.gateId))]
  const gateHashes = [...new Set(reports.map((report) => report.gateConfigSha256))]
  const blindHashes = [...new Set(reports.map((report) => report.blindRegistrySha256))]
  const sourceHashes = [...new Set(reports.map((report) => report.sourceAnnotationSetSha256))]
  const blockers = []
  if (allGateIds.length !== 1 || !allGateIds[0]) blockers.push('reports-do-not-share-one-gate-id')
  if (gateHashes.length !== 1 || !gateHashes[0]) blockers.push('reports-do-not-share-one-frozen-gate-hash')
  if (blindHashes.length !== 1 || !blindHashes[0]) blockers.push('reports-do-not-share-one-blind-registry')
  if (sourceHashes.length !== 1 || !sourceHashes[0]) blockers.push('reports-do-not-share-one-annotation-set')
  const candidates = []
  for (const report of passing) {
    const models = report.modelCandidates || []
    if (models.length !== 1) { blockers.push(`report-needs-exactly-one-model:${report.predictionSetSha256 || 'unknown'}`); continue }
    const model = models[0]
    if (!Number.isSafeInteger(model.artifactBytes) || model.artifactBytes <= 0) { blockers.push(`missing-deployment-artifact-size:${model.id || 'unknown'}`); continue }
    candidates.push({ model, gateId: report.gateId, gateConfigSha256: report.gateConfigSha256,
      blindRegistrySha256: report.blindRegistrySha256, sourceAnnotationSetSha256: report.sourceAnnotationSetSha256,
      predictionSetSha256: report.predictionSetSha256, weightedFactRecall: report.overallBlind?.weightedFactRecall,
      worstFamilyRecall: Math.min(...Object.values(report.blindByFamily || {}).map((x) => x?.weightedFactRecall ?? 0)),
      medianDraftToRawCharRatio: report.overallBlind?.medianDraftToRawCharRatio })
  }
  if (!passing.length) blockers.push('no-checkpoint-passed-the-confirmatory-gates')
  if (candidates.length !== passing.length) blockers.push('one-or-more-passing-reports-lack-size-metadata')
  let selected = null
  if (!blockers.length) {
    candidates.sort((a, b) => a.model.artifactBytes - b.model.artifactBytes
      || (a.model.parameterCount ?? Number.MAX_SAFE_INTEGER) - (b.model.parameterCount ?? Number.MAX_SAFE_INTEGER)
      || (a.model.medianLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.model.medianLatencyMs ?? Number.MAX_SAFE_INTEGER))
    selected = candidates[0]
  }
  return {
    schema: 'cfb.micro-generator-size-selection/1',
    status: selected ? 'selected-smallest-passing' : 'no-valid-selection',
    selectionCriterion: 'smallest deployment artifact bytes among checkpoints passing identical frozen fact/new-family gates; parameter count and median latency break ties',
    selected,
    candidates,
    blockers,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const reports = args.reports.map((file) => JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8')))
    const result = selectSmallestPassing(reports)
    const text = JSON.stringify(result, null, 2) + '\n'
    if (args.out) fs.writeFileSync(path.resolve(ROOT, args.out), text)
    console.log(JSON.stringify({ status: result.status, candidates: result.candidates.length, blockers: result.blockers }))
  } catch (error) {
    console.error(`[micro-generator-select] ${error.message}`)
    process.exitCode = 1
  }
}
