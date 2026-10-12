#!/usr/bin/env node
// Read-only reconstruction of already-published v9 evidence. Not a new blind test.
// Frozen sources and historical outputs are never edited; only output/root/import
// plumbing is relocated in an explicitly recorded harness.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const digest = (p) => sha(fs.readFileSync(p))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1] }
const OUT = path.resolve(arg('--out', path.join(ROOT, '.cfb-runtime/audit-2026-10-11-v9')))
if (fs.existsSync(OUT)) throw new Error('refuse-overwrite-v9-replay:choose-a-fresh---out')
const frozenList = fs.readFileSync(path.join(ROOT, 'transfer/route-2026-10-11/PREREG-v9.sha256'), 'utf8').trim().split('\n')
const frozen = frozenList.map((line) => {
  const m = /^([a-f0-9]{64})  (.+)$/.exec(line)
  if (!m || digest(path.join(ROOT, m[2])) !== m[1]) throw new Error('frozen-v9-drift:' + line)
  return { path: m[2], sha256: m[1] }
})
const historicalFiles = fs.readdirSync(path.join(ROOT, 'data-v9')).filter((name) => fs.statSync(path.join(ROOT, 'data-v9', name)).isFile())
const protectedHashes = Object.fromEntries(historicalFiles.map((name) => [name, digest(path.join(ROOT, 'data-v9', name))]))
fs.mkdirSync(OUT, { recursive: true })
const replayData = path.join(OUT, 'data-v9')
const relocate = (name) => {
  const original = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8')
  let copy = original.replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", 'const ROOT = ' + JSON.stringify(ROOT))
  copy = copy.replace("const OUT = path.join(ROOT, 'data-v9')", 'const OUT = ' + JSON.stringify(replayData))
  copy = copy.replace('path.join(path.dirname(fileURLToPath(import.meta.url)), NEGATIVES_FILE)', "path.join(ROOT, 'tools', NEGATIVES_FILE)")
  copy = copy.replace(/from '(\.\/[^']+)'/g, (_, rel) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(ROOT, 'tools', rel)).href))
  const destination = path.join(OUT, name)
  fs.writeFileSync(destination, copy)
  return { path: destination, originalSha256: sha(original), harnessSha256: sha(copy), changes: ['ROOT literal', 'OUT literal', 'absolute imports', 'frozen negatives metadata path only'] }
}
const pipeline = relocate('v9-pipeline.mjs'), label = relocate('v9-label.mjs')
const phases = []
for (const [source, cmd, expectedExit] of [[pipeline, 'hand', 0], [pipeline, 'calibrate', 2], [pipeline, 'validate', 3], [label, null, 0]]) {
  const args = [source.path, ...(cmd ? [cmd] : [])]
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const phase = cmd || 'label'
  fs.writeFileSync(path.join(OUT, phase + '.stdout.txt'), result.stdout || '')
  fs.writeFileSync(path.join(OUT, phase + '.stderr.txt'), result.stderr || '')
  phases.push({ phase, exitCode: result.status, expectedExit, matched: result.status === expectedExit })
}
if (phases.some((p) => !p.matched)) {
  const failure = { schema: 'cfb.v9-replay/1', ok: false, pipelineValid: false, trainingApproved: false, phases, frozen, harnesses: [pipeline, label] }
  fs.writeFileSync(path.join(OUT, 'REPLAY.json'), JSON.stringify(failure, null, 2) + '\n')
  console.error(JSON.stringify(failure, null, 2)); process.exit(1)
}
const read = (root, f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
const prior = path.join(ROOT, 'data-v9')
const thresholdsEqual = JSON.stringify(read(prior, 'thresholds.json')) === JSON.stringify(read(replayData, 'thresholds.json'))
const oldValidation = read(prior, 'validation.json'), newValidation = read(replayData, 'validation.json')
delete oldValidation.at; delete newValidation.at
const validationEqualExceptTimestamp = JSON.stringify(oldValidation) === JSON.stringify(newValidation)
const labelsByteIdentical = digest(path.join(prior, 'labelled-pool.jsonl')) === digest(path.join(replayData, 'labelled-pool.jsonl'))
const handByteIdentical = digest(path.join(prior, 'hand-standard.jsonl')) === digest(path.join(replayData, 'hand-standard.jsonl'))
const unchanged = historicalFiles.every((f) => protectedHashes[f] === digest(path.join(prior, f))) && frozen.every((f) => digest(path.join(ROOT, f.path)) === f.sha256)
const oldSummary = read(prior, 'labelled-pool.summary.json'), newSummary = read(replayData, 'labelled-pool.summary.json')
const oldPopulation = { ...oldSummary }, newPopulation = { ...newSummary }
for (const key of ['filesScanned', 'duplicateRows', 'duplicateSameTarget']) { delete oldPopulation[key]; delete newPopulation[key] }
const populationEqual = JSON.stringify(oldPopulation) === JSON.stringify(newPopulation)
const ok = phases.every((p) => p.matched) && unchanged && thresholdsEqual && validationEqualExceptTimestamp && labelsByteIdentical && handByteIdentical && populationEqual
const report = {
  schema: 'cfb.v9-replay/1', auditDate: '2026-10-11', ok,
  scope: 'published-historical-evidence-reconstruction-not-new-candidate-or-blind-test',
  pipelineValid: newValidation.validity.VALID === 'VALID', trainingApproved: false,
  frozen, harnesses: [pipeline, label], phases,
  comparisons: { thresholdsEqual, validationEqualExceptTimestamp, labelsByteIdentical, handByteIdentical, populationEqual, frozenAndHistoricalOutputsUnchanged: unchanged },
  scanScope: { historical: { files: oldSummary.filesScanned, duplicates: oldSummary.duplicateRows, duplicateSameTarget: oldSummary.duplicateSameTarget }, replay: { files: newSummary.filesScanned, duplicates: newSummary.duplicateRows, duplicateSameTarget: newSummary.duplicateSameTarget }, note: 'Missing redundant/legacy sources affect enumeration; byte-identical unique labels and reconstructed validation are separately checked.' },
  validation: newValidation, labelSummary: newSummary, protectedHistoricalHashes: protectedHashes,
}
fs.writeFileSync(path.join(OUT, 'REPLAY.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ok, pipelineValid: report.pipelineValid, comparisons: report.comparisons, scanScope: report.scanScope, report: path.join(OUT, 'REPLAY.json') }, null, 2))
process.exit(ok ? 0 : 1)
