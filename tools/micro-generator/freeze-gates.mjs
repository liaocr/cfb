#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { frozenGateDigest, registryDigest } from './evaluate.mjs'
import { AI_REVIEW_MODE, AI_REVIEWER_ID } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NUMERIC = [
  'minBlindFamilies', 'minCasesPerBlindFamily', 'weightedFactRecallOverallMin',
  'weightedFactRecallPerBlindFamilyMin', 'criticalOmissionsPerBlindFamilyMax',
  'uncertainMustPreservePerBlindFamilyMax', 'contradictoryClaimsPerBlindFamilyMax',
  'unsupportedClaimsPer100Max', 'uncertainClaimsPer100Max', 'medianDraftToRawCharRatioMax',
]
function parseArgs(argv) {
  const a = { inFile: null, outFile: null, families: [], values: {}, confirm: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--in') a.inFile = argv[++i]
    else if (key === '--out') a.outFile = argv[++i]
    else if (key === '--blind-family') a.families.push(argv[++i])
    else if (key === '--confirm-before-blind-generation') a.confirm = true
    else if (key.startsWith('--')) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      a.values[name] = Number(argv[++i])
    } else throw new Error(`unknown argument: ${key}`)
  }
  if (!a.inFile || !a.outFile || !a.confirm) throw new Error('usage: freeze-gates.mjs --in DRAFT.json --out FROZEN.json --blind-family NEW_FAMILY [repeat] --<all-thresholds> N --confirm-before-blind-generation')
  if (a.families.length === 0 || a.families.some((x) => !x)) throw new Error('at least one --blind-family is required')
  for (const name of NUMERIC) if (!Number.isFinite(a.values[name])) throw new Error(`missing numeric threshold --${name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`)
  return a
}

export function freezeGateConfig(draft, { families, thresholds, knownFamilies = draft.knownFamilyNames || [], now = new Date().toISOString() }) {
  if (draft.schema !== 'cfb.micro-generator-gates/1') throw new Error('gate schema mismatch')
  const policy = draft.reviewPolicy || {}
  if (policy.mode !== AI_REVIEW_MODE || policy.reviewerType !== 'ai' || policy.reviewerId !== AI_REVIEWER_ID ||
      policy.reviewerCount !== 1 || policy.humanReviewerCount !== 0 || policy.independentSecondReview !== false) {
    throw new Error('gate review policy must explicitly be AI single-reviewer with no independent human reviewer')
  }
  const registered = [...new Set(families)].sort()
  if (registered.length !== families.length) throw new Error('duplicate blind family')
  if (registered.some((family) => typeof family !== 'string' || !/^[A-Za-z0-9._-]+$/.test(family))) throw new Error('blind family ids must use ASCII letters, digits, dot, underscore, or hyphen')
  const overlap = registered.filter((family) => knownFamilies.includes(family))
  if (overlap.length) throw new Error(`blind family is already known: ${overlap.join(',')}`)
  for (const name of NUMERIC) if (!Number.isFinite(thresholds[name])) throw new Error(`missing or invalid threshold ${name}`)
  if (registered.length < thresholds.minBlindFamilies) throw new Error('registered blind-family count is below minBlindFamilies')
  if (thresholds.minBlindFamilies < 1 || thresholds.minCasesPerBlindFamily < 1) throw new Error('minimum family/case thresholds must be >= 1')
  if (thresholds.weightedFactRecallOverallMin < 0 || thresholds.weightedFactRecallOverallMin > 1 || thresholds.weightedFactRecallPerBlindFamilyMin < 0 || thresholds.weightedFactRecallPerBlindFamilyMin > 1) throw new Error('fact recall thresholds must be in [0,1]')
  for (const name of ['minBlindFamilies', 'minCasesPerBlindFamily', 'criticalOmissionsPerBlindFamilyMax', 'uncertainMustPreservePerBlindFamilyMax', 'contradictoryClaimsPerBlindFamilyMax']) {
    if (!Number.isInteger(thresholds[name]) || thresholds[name] < (name.startsWith('min') ? 1 : 0)) throw new Error(`invalid integer threshold ${name}`)
  }
  if (thresholds.unsupportedClaimsPer100Max < 0 || thresholds.uncertainClaimsPer100Max < 0 || thresholds.medianDraftToRawCharRatioMax < 0) throw new Error('rate/ratio thresholds must be >= 0')
  const gate = structuredClone(draft)
  gate.status = 'frozen'
  gate.freezeAt = now
  gate.blindFamilyRegistry = { status: 'frozen', families: registered, registrySha256: registryDigest(registered) }
  gate.thresholds = { ...thresholds }
  gate.statusNote = 'Frozen before blind generation; retain this exact config hash for every checkpoint comparison.'
  gate.frozenConfigSha256 = null
  gate.frozenConfigSha256 = frozenGateDigest(gate)
  return gate
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2))
    const draft = JSON.parse(fs.readFileSync(path.resolve(ROOT, a.inFile), 'utf8'))
    const frozen = freezeGateConfig(draft, { families: a.families, thresholds: a.values })
    const outFile = path.resolve(ROOT, a.outFile)
    if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite existing frozen-gate path ${a.outFile}; choose a new versioned path`)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(frozen, null, 2) + '\n')
    console.log(JSON.stringify({ status: frozen.status, gateId: frozen.gateId, gateSha256: frozen.frozenConfigSha256, blindFamilies: frozen.blindFamilyRegistry.families }))
  } catch (error) {
    console.error(`[micro-generator-freeze-gates] ${error.message}`)
    process.exitCode = 1
  }
}
