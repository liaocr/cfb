#!/usr/bin/env node
// Canonical, read-only project control plane. Never calls paid APIs, trains, restores,
// consumes a blind ledger, or publishes. An audit can explicitly write a fresh report.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { auditTrajectoryRecords } from './helpers/trajectory-records.mjs'
import { parseManifest, sparseOmissions } from './helpers/worktree-integrity.mjs'
import { workStatus } from './micro-generator/program.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
const hashFile = (root, rel) => sha(fs.readFileSync(path.join(root, rel)))
function evidenceRef(root, ref, label, errors) {
  const rel = ref?.path
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split('/').some((p) => !p || p === '.' || p === '..') || rel.includes('\\') || !/^[a-f0-9]{64}$/.test(String(ref?.sha256 || ''))) {
    errors.push('invalid-evidence-reference:' + label); return null
  }
  if (!fs.existsSync(path.join(root, rel)) || hashFile(root, rel) !== ref.sha256) {
    errors.push('evidence-hash-mismatch:' + label); return null
  }
  return rel
}
function validRuler(report) {
  const validity = report?.validity || {}, checks = Object.entries(validity).filter(([key]) => key !== 'VALID')
  return validity.VALID === 'VALID' && checks.length > 0 && checks.every(([, value]) => value === 'PASS')
}

export function restoreSparseConfiguration(root = ROOT) {
  // Explicit repair for lost non-secret Git settings. Does not checkout, touch
  // index/source bytes, fetch, restore historical content or expose .git/config.
  const ledgerPath = 'transfer/audit-2026-10-11/checkout-scope.json'
  const ledger = readJson(root, ledgerPath), patternsPath = path.join(root, '.git/info/sparse-checkout')
  if (!Array.isArray(ledger.excluded) || !ledger.excluded.length || !fs.existsSync(patternsPath)) throw new Error('explicit-sparse-ledger-and-patterns-required')
  const patterns = fs.readFileSync(patternsPath, 'utf8').split('\n')
  const index = spawnSync('git', ['ls-files', '-v', '-z'], { cwd: root, encoding: 'utf8' })
  if (index.status !== 0) throw new Error('sparse-config-repair-requires-Git-index')
  const skipped = new Set(index.stdout.split('\0').filter((line) => line.startsWith('S ')).map((line) => line.slice(2)))
  for (const entry of ledger.excluded) {
    const rel = entry.path
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((x) => !x || x === '.' || x === '..') || !patterns.includes('!/' + rel) || !skipped.has(rel)) throw new Error('sparse-ledger-pattern-or-index-mismatch:' + rel)
  }
  const before = spawnSync('git', ['config', '--local', '--bool', '--get', 'core.sparseCheckout'], { cwd: root, encoding: 'utf8' })
  for (const [key, value] of [['core.sparseCheckout','true'], ['core.sparseCheckoutCone','false']]) {
    const set = spawnSync('git', ['config','--local',key,value], { cwd: root, encoding: 'utf8' })
    if (set.status !== 0) throw new Error('sparse-setting-write-failed:' + key)
  }
  return { schema: 'cfb.sparse-configuration-repair/1', previousSparseEnabled: before.stdout.trim() === 'true', sparseEnabled: true, coneMode: false, verifiedExclusionPaths: ledger.excluded.length, checkoutScopeSha256: hashFile(root, ledgerPath), worktreeOrIndexChanged: false, filesFetched: 0, historicalFilesRestored: 0, paidApiCalls: 0, modelExecutions: 0 }
}

export function doctor(root = ROOT) {
  const state = readJson(root, 'PROJECT.json'), errors = [], warnings = []
  if (state.schema !== 'cfb.project-state/1' || state.route?.id !== 'pretrained-generative-student-only') errors.push('canonical-route-drift')
  for (const rel of state.authority || []) if (!fs.existsSync(path.join(root, rel))) errors.push('authority-file-missing:' + rel)
  const frozen = fs.readFileSync(path.join(root, state.evidence.frozenList), 'utf8').trim().split('\n').map((line) => {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!m) throw new Error('invalid-frozen-list')
    const matches = fs.existsSync(path.join(root, m[2])) && hashFile(root, m[2]) === m[1]
    if (!matches) errors.push('frozen-v9-drift:' + m[2])
    return { path: m[2], matches }
  })
  const validation = readJson(root, state.evidence.v9Validation)
  const rulerValid = validRuler(validation)
  if (rulerValid !== state.claims.v9RulerValid) errors.push('v9-status-contradicts-canonical-state')
  const activeRef = state.evidence.activeRuler
  let activeRuler = { valid: false, status: 'NOT_REGISTERED', validationPath: null }
  if (activeRef) {
    const prereg = evidenceRef(root, activeRef.preregistration, 'active-ruler-preregistration', errors)
    const reportPath = evidenceRef(root, activeRef.validation, 'active-ruler-validation', errors)
    if (reportPath === state.evidence.v9Validation || prereg?.startsWith('data-v9/')) errors.push('active-ruler-must-not-rebrand-frozen-invalid-v9')
    if (prereg && reportPath) {
      const report = readJson(root, reportPath)
      const bound = report.preregSha256 === activeRef.preregistration.sha256
      if (!bound) errors.push('active-ruler-preregistration-not-bound')
      activeRuler = { valid: bound && validRuler(report), status: report.validity?.VALID || 'MALFORMED', validationPath: reportPath }
    }
  }
  if (state.claims.neverWorseThanRawGuaranteed !== false) errors.push('unsupported-universal-nonregression-claim')
  for (const key of ['originalReaderReferenceUtilityVerified', 'cpuQualityAndLatencyVerified', 'currentTrainingAdmitted', 'candidatePromoted', 'liveHostVerified']) {
    if (typeof state.claims[key] !== 'boolean') errors.push('invalid-readiness-claim:' + key)
    if (state.claims[key] === true) {
      const reportPath = evidenceRef(root, state.evidence.readiness?.[key], key, errors)
      if (reportPath) {
        const report = readJson(root, reportPath)
        if (report.kind !== key || report.verified !== true || report.actualExecution !== true || report.fixtureOnly !== false) errors.push('readiness-requires-real-hash-bound-receipt:' + key)
      }
    }
  }
  const replay = readJson(root, state.evidence.v9Replay)
  if (!replay.ok || !Object.values(replay.comparisons || {}).every((v) => v === true)) errors.push('v9-replay-not-verified')
  for (const [rel, digest] of Object.entries(replay.protectedHistoricalHashes || {})) {
    if (hashFile(root, 'data-v9/' + rel) !== digest) errors.push('historical-v9-output-drift:' + rel)
  }
  const labels = fs.readFileSync(path.join(root, 'data-v9/labelled-pool.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  if (labels.some((r) => r.trainable !== false) && !rulerValid) errors.push('invalid-v9-labels-promoted')
  const missing = readJson(root, state.evidence.missingLedger)
  const historicalManifest = parseManifest(fs.readFileSync(path.join(root, missing.originalManifest), 'utf8'))
  const recovered = missing.entries.filter((e) => e.archivePath)
  for (const entry of missing.entries) {
    if (historicalManifest.get(entry.path) !== entry.expectedSha256) errors.push('lost-manifest-evidence-drift:' + entry.path)
    if (entry.archivePath && hashFile(root, entry.archivePath) !== entry.expectedSha256) errors.push('recovery-hash-mismatch:' + entry.path)
  }
  const model = readJson(root, state.evidence.modelMetadata)
  if (model.id !== state.route.firstCandidate || model.sha !== state.route.modelRevision || model.safetensors?.total !== state.route.actualParameters) errors.push('model-metadata-drift')
  const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8')
  if (!/compressLocalModel:\s*false/.test(config)) errors.push('legacy-rule-local-path-enabled-by-default')
  const omissions = sparseOmissions(root)
  if (fs.existsSync(path.join(root, '.git/info/sparse-checkout')) && spawnSync('git', ['config','--local','--bool','--get','core.sparseCheckout'], { cwd:root,encoding:'utf8' }).stdout.trim() !== 'true') errors.push('explicit-sparse-Git-configuration-not-enabled:use-scope-restore')
  if (omissions.size) warnings.push('sparse checkout: ' + omissions.size + ' deliberately unmaterialized tracked paths; not full asset validation')
  warnings.push('Core/plugin tests are not actual host, GPU, CPU model quality, or receiver-readback evidence.')
  const programmeBindings = {}
  for (const [kind, ref] of Object.entries(state.continuationProgram?.evidence || {})) programmeBindings[kind] = evidenceRef(root, ref, 'continuation-programme-' + kind, errors)
  if (!state.continuationProgram || state.continuationProgram.protocolValidity !== 'NOT_VALIDATED') errors.push('development-programme-status-missing-or-unearned-promotion')
  let programme = null
  try { programme = workStatus(root); errors.push(...[...programme.registry.errors, ...programme.review.errors].map((e) => 'programme:' + e)) } catch (e) { errors.push('programme:' + e.message) }
  const task = programmeBindings.taskContract ? readJson(root, programmeBindings.taskContract) : null
  if (!task || JSON.stringify(task.executionOrder) !== JSON.stringify(state.workflowOrder)) errors.push('workflow-order-not-bound-to-task-contract')
  const blockers = []
  if (task?.resources?.resourceBudgetConfirmed !== true) blockers.push('task resource budget and deployment limits are not confirmed')
  if (!state.claims.originalReaderReferenceUtilityVerified) blockers.push('same-birth raw/raw and raw/reference utility has not been measured on the original reader')
  if (!state.claims.cpuQualityAndLatencyVerified) blockers.push('CPU backend/tokenizer/quality/latency not validated')
  if (!activeRuler.valid) blockers.push('no valid active preregistered evaluator; preserve frozen v9 INVALID')
  if (!state.claims.currentTrainingAdmitted) blockers.push('no target-compatible fully reviewed admitted corpus')
  if (!state.claims.candidatePromoted) blockers.push('no promoted generative student')
  if (!state.claims.liveHostVerified) blockers.push('original receiver and real host not validated')
  return {
    schema: 'cfb.project-doctor/1', ok: errors.length === 0, errors, warnings,
    state, readiness: { ready: errors.length === 0 && blockers.length === 0, blockers },
    evidence: { frozenFiles: frozen, activeRuler, v9Status: validation.validity.VALID, v9UniqueLabels: labels.length,
      v9IndependentReplay: replay.ok, missingSnapshotPaths: missing.entries.length,
      exactRecoveryFiles: recovered.length, recoveredBytes: recovered.reduce((n, e) => n + e.bytes, 0),
      notDownloadedRecoveryCandidates: missing.entries.length - recovered.length, sparseOmissions: omissions.size,
      continuationProgramme: programme ? { phase: state.continuationProgram.phase, structurallyConsistent: programme.ok, registry: programme.registry, developmentReview: programme.review, readiness: programme.readiness, hashBoundProducts: Object.keys(programmeBindings) } : null },
    paidApiCallsByThisCommand: 0, gpuRunsByThisCommand: 0, blindTestsConsumedByThisCommand: 0,
  }
}

export function auditTrajectories(root = ROOT) {
  const files = []
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && entry.name === 'results.jsonl') files.push(file)
    }
  }
  for (const rel of ['.cfb-runtime/traj', '.cfb-offline/traj', 'transfer/traj1', 'transfer/traj2', 'transfer/traj3']) walk(path.join(root, rel))
  const runs = files.map((file) => {
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    return { run: path.basename(path.dirname(file)), file: path.relative(root, file).replaceAll('\\', '/'), events, audit: auditTrajectoryRecords(events) }
  })
  const relabelled = [], unresolvedReferences = []
  for (const run of runs) for (const row of run.audit.rows) {
    if (!row.reusedFrom) continue
    const ref = row.reusedFrom
    const sourceName = path.basename(path.dirname(String(ref.file || '').replace(/\\/g, '/')))
    const normalized = String(ref.file || '').replace(/\\/g, '/')
    const exact = runs.filter((r) => normalized === r.file || normalized.endsWith('/' + r.file))
    const possible = exact.length ? exact : runs.filter((r) => r.run === sourceName)
    const source = possible.length === 1 ? possible[0] : null
    // Match the original referenced event, including a timestamp-only duplicate.
    // A duplicate canonicalized to its first time is not a missing lineage record.
    const candidates = source?.events.filter((r) => r.variant === 'raw' && r.task === row.task && r.at === ref.at && !r.error && r.status !== 'awaiting-draft' && source.audit.rows.some((x) => x.task === r.task && x.variant === r.variant && x.sample === r.sample)) || []
    if (candidates.length !== 1) { unresolvedReferences.push({ run: run.run, task: row.task, sample: row.sample, ref }); continue }
    const original = candidates[0]
    if (original.sample !== row.sample || (ref.sample != null && ref.sample !== original.sample)) relabelled.push({ run: run.run, task: row.task, labelledSample: row.sample, originalRun: sourceName, originalSample: original.sample, sourceAt: ref.at })
  }
  return {
    scope: 'runtime-offline-and-three-legacy-traj-append-logs; per-file-counts-not-independent-n-or-quality-regrading', independentSampleCount: null, logFiles: runs.length,
    runs: runs.map(({ run, file, audit }) => ({ run, file, events: audit.eventCount, terminal: audit.rows.length, pending: audit.pending.length, errors: audit.errors.length, duplicateKeys: audit.duplicates.length, conflicts: audit.conflicts, invalid: audit.invalid })),
    eventRows: runs.reduce((n, r) => n + r.audit.eventCount, 0),
    unambiguousTerminalRows: runs.reduce((n, r) => n + r.audit.rows.length, 0),
    conflictKeys: runs.reduce((n, r) => n + r.audit.conflicts.length, 0),
    pendingKeys: runs.reduce((n, r) => n + r.audit.pending.length, 0),
    relabelledRawIdentities: relabelled, unresolvedReferences,
    qualification: 'Relabelled source identity invalidates naive cross-plan matching. It does not by itself prove that every within-run raw/hand pair was wrong. Historical bodies/receipts remain untouched; no promotion from these mixed statistics.',
  }
}

export function sourceAudit(root = ROOT) {
  const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (list.status !== 0) throw new Error('source-audit-requires-git-worktree')
  const extraArchives = readJson(root, 'transfer/audit-2026-10-11/missing-artifacts.json').entries.map((r) => r.archivePath).filter(Boolean)
  const paths = [...new Set([...list.stdout.split('\0').filter(Boolean), ...extraArchives])].sort().filter((rel) => fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile())
  const md = [], jsonErrors = [], jsonlErrors = [], syntaxErrors = []
  let jsonFiles = 0, jsonlFiles = 0, jsonlRows = 0, nodeSyntaxFiles = 0
  const pythonPaths = paths.filter((rel) => rel.endsWith('.py'))
  for (const rel of paths) {
    const full = path.join(root, rel)
    if (/\.md$/.test(rel)) { const bytes = fs.readFileSync(full); md.push({ path: rel, sha256: sha(bytes), bytes: bytes.length }) }
    if (/\.json$/.test(rel)) { jsonFiles++; try { JSON.parse(fs.readFileSync(full, 'utf8')) } catch (e) { jsonErrors.push({ path: rel, why: e.message }) } }
    if (/\.jsonl(\.gz)?$/.test(rel)) {
      jsonlFiles++
      try {
        const content = rel.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(full)).toString('utf8') : fs.readFileSync(full, 'utf8')
        content.split('\n').forEach((line, i) => { if (!line.trim()) return; jsonlRows++; try { JSON.parse(line) } catch (e) { jsonlErrors.push({ path: rel, line: i + 1, why: e.message }) } })
      } catch (e) { jsonlErrors.push({ path: rel, why: e.message }) }
    }
    if (/\.(mjs|js)$/.test(rel)) {
      nodeSyntaxFiles++
      const checked = spawnSync(process.execPath, ['--check', full], { cwd: root, encoding: 'utf8' })
      if (checked.status !== 0) syntaxErrors.push({ path: rel, why: checked.stderr?.slice(0, 600) })
    }
  }
  const py = spawnSync('python3', ['-c', 'import ast,json,sys; errors=[]\nfor p in json.load(sys.stdin):\n try: ast.parse(open(p,encoding="utf8").read(),filename=p)\n except Exception as e: errors.append({"path":p,"why":str(e)})\nprint(json.dumps(errors))'], { cwd: root, input: JSON.stringify(pythonPaths), encoding: 'utf8' })
  if (py.status !== 0) syntaxErrors.push({ path: '<python-parser>', why: py.stderr || py.error?.message || 'Python AST scan failed' })
  else syntaxErrors.push(...JSON.parse(py.stdout))
  const byHash = new Map()
  for (const row of md) { if (!byHash.has(row.sha256)) byHash.set(row.sha256, []); byHash.get(row.sha256).push(row.path) }
  return { scope: 'materialized-tracked-and-nonignored-files-plus-explicit-recovered-archives; machine-scan-not-pair-factual-review', files: paths.length,
    markdown: md.length, duplicateMarkdownGroups: [...byHash.values()].filter((group) => group.length > 1),
    jsonFiles, jsonlFiles, jsonlRows, nodeSyntaxFiles, pythonSyntaxFiles: pythonPaths.length, jsonErrors, jsonlErrors, syntaxErrors,
    ok: !jsonErrors.length && !jsonlErrors.length && !syntaxErrors.length }
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'doctor'
  if (command === 'retired') {
    console.error('停用的默认入口：' + (argv[1] || 'legacy') + '。历史恢复/快照可能覆盖不可再生数据；旧训练导出不是真生成式 SFT 准入。先备份、核验证据，并取得用户明确授权；仅显式 legacy 别名可供专家复核。'); return 2
  }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json') continue
    if (argv[i] === '--out' && argv[i + 1] && !argv[i + 1].startsWith('--')) { i++; continue }
    console.error('unknown/missing project argument: ' + argv[i]); return 2
  }

  if (command === 'scope-restore') { console.log(JSON.stringify(restoreSparseConfiguration(),null,2)); return 0 }
  if (command === 'plan') { console.log(fs.readFileSync(path.join(ROOT, 'docs/PROJECT-PLAN.md'), 'utf8')); return 0 }
  if (!['doctor', 'readiness', 'audit'].includes(command)) {
    console.error('用法：node tools/project.mjs <doctor|readiness|audit|plan|scope-restore> [--json] [--out NEW_FILE]。历史 restore/snapshot 不在默认主线。'); return 2
  }
  const result = doctor()
  if (command === 'audit') { result.trajectories = auditTrajectories(); result.sourceScan = sourceAudit(); result.ok &&= result.sourceScan.ok }
  const outAt = argv.indexOf('--out')
  if (outAt >= 0) {
    const destination = argv[outAt + 1]
    if (!destination || fs.existsSync(destination)) throw new Error('fresh-audit-output-required')
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true })
    fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n')
  }
  if (argv.includes('--json') || command === 'audit') console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`项目状态口径：${result.ok ? '一致' : '失败'}；生成式产品就绪：${result.readiness.ready ? '是' : '否'}`)
    console.log('唯一主线：' + result.state.route.id + '；首个候选 ' + result.state.route.firstCandidate + '@' + result.state.route.modelRevision)
    console.log(`v9=${result.evidence.v9Status}（已独立重放）；${result.evidence.exactRecoveryFiles}/${result.evidence.missingSnapshotPaths} 缺失资产已精确归档恢复；其余可定位、未下载。`)
    for (const blocker of result.readiness.blockers) console.log('BLOCKED: ' + blocker)
    for (const error of result.errors) console.error('ERROR: ' + error)
    for (const warning of result.warnings) console.log('NOTE: ' + warning)
    console.log('本命令 API=0 / GPU=0 / 新盲测=0；doctor 成功不代表模型达标。')
  }
  return !result.ok ? 1 : command === 'readiness' && !result.readiness.ready ? 2 : 0
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = main() } catch (e) { console.error(e.stack || e); process.exitCode = 1 }
}
