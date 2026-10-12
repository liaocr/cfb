#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { doctor, auditTrajectories, restoreSparseConfiguration } from '../tools/project.mjs'
import { SOURCE_CATALOG } from '../tools/micro-generator/program.mjs'
import { auditTrajectoryRecords, requireUnambiguousTrajectories, reusableRawIndex, findReusableRaw, trajectoryRecordDigest } from '../tools/helpers/trajectory-records.mjs'
import { parseManifest, sparseOmissions } from '../tools/helpers/worktree-integrity.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-integrity-'))
let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const raw = (sample, extra = {}) => ({ task: 'flaky-timeout', variant: 'raw', sample, at: 'old-time', roundMessages: [{ role: 'assistant', content: 'sample-' + sample }], ...extra })
try {
  test('raw reuse matches sample identity, not completion order', () => {
    const index = reusableRawIndex([raw(1), raw(0)])
    assert.equal(findReusableRaw(index, 'flaky-timeout', 0).roundMessages[0].content, 'sample-0')
    assert.equal(findReusableRaw(index, 'flaky-timeout', 1).roundMessages[0].content, 'sample-1')
  })
  test('no substitution when requested sample/task is absent', () => {
    const index = reusableRawIndex([raw(1)])
    assert.equal(findReusableRaw(index, 'flaky-timeout', 0), null)
    assert.equal(findReusableRaw(index, 'another-task', 1), null)
  })
  test('numeric and legacy string sample identities are not conflated', () => {
    const index = reusableRawIndex([raw('0')])
    assert.equal(findReusableRaw(index, 'flaky-timeout', 0), null)
  })
  test('missing identity is not repaired by file position', () => {
    assert.throws(() => reusableRawIndex([{ ...raw(0), sample: undefined }]), /invalid=1/)
    assert.throws(() => reusableRawIndex([raw(-1)]), /invalid=1/)
  })
  test('awaiting event followed by terminal counts once', () => {
    const a = auditTrajectoryRecords([raw(0, { status: 'awaiting-draft' }), raw(0)])
    assert.equal(a.eventCount, 2); assert.equal(a.rows.length, 1); assert.equal(a.pending.length, 0)
  })
  test('awaiting-only events are not scored observations', () => {
    const a = auditTrajectoryRecords([raw(0, { status: 'awaiting-draft' }), raw(0, { status: 'awaiting-draft', at: 'later' })])
    assert.equal(a.rows.length, 0); assert.equal(a.pending.length, 1)
  })
  test('unknown intermediate states are not assumed to be successes', () => {
    const a = auditTrajectoryRecords([raw(0, { status: 'running' })])
    assert.equal(a.rows.length, 0); assert.equal(a.invalid.length, 1)
  })
  test('identical retries and timestamp-only copies are deduplicated', () => {
    const a = auditTrajectoryRecords([raw(0), raw(0, { at: 'later' })])
    assert.equal(a.rows.length, 1); assert.equal(a.duplicates.length, 1)
  })
  test('nested property ordering does not invent conflicting evidence', () => {
    const a = auditTrajectoryRecords([raw(0, { quality: { a: 1, b: 2 } }), raw(0, { quality: { b: 2, a: 1 } })])
    assert.equal(a.rows.length, 1); assert.equal(a.conflicts.length, 0)
  })
  test('contradictory terminal results are quarantined, never last-wins', () => {
    const a = auditTrajectoryRecords([raw(0, { outcome: 'pass' }), raw(0, { outcome: 'fail', at: 'later' })])
    assert.equal(a.rows.length, 0); assert.equal(a.conflicts.length, 1)
    assert.throws(() => requireUnambiguousTrajectories([raw(0), raw(0, { mainCalls: 99 })]), /conflicts=1/)
  })
  test('errors before/after success do not create or replace a successful sample', () => {
    const a = auditTrajectoryRecords([raw(0, { error: 'failed' }), raw(0), raw(0, { error: 'later-failed' })])
    assert.equal(a.rows.length, 1); assert.equal(a.rows[0].error, undefined)
  })
  test('unusable raw evidence is not reusable', () => {
    assert.equal(findReusableRaw(reusableRawIndex([raw(0, { roundMessages: [] })]), 'flaky-timeout', 0), null)
    assert.equal(findReusableRaw(reusableRawIndex([raw(0, { error: 'timeout' })]), 'flaky-timeout', 0), null)
  })
  test('runner dry-run can reuse shuffled raw without requesting API work', () => {
    const source = path.join(temp, 'shuffled.jsonl'); fs.writeFileSync(source, [raw(1), raw(0)].map(JSON.stringify).join('\n') + '\n')
    const out = path.join(temp, 'dry-run')
    const p = spawnSync(process.execPath, ['tools/traj-run.mjs', '--samples', '2', '--only', 'flaky-timeout', '--variants', 'raw', '--fork', '--fork-from', source, '--dry-run', '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
    assert.match(p.stdout, /复用 raw 轨迹 2 条当 leader/); assert.match(p.stdout, /轨迹 0 条/); assert.match(p.stdout, /未发任何请求/)
    assert.equal(fs.existsSync(path.join(out, 'results.jsonl')), false)
  })
  test('runner refuses ambiguous source instead of overwriting receipt', () => {
    const source = path.join(temp, 'conflicts.jsonl'); fs.writeFileSync(source, [raw(0), raw(0, { outcome: 'conflict' })].map(JSON.stringify).join('\n') + '\n')
    const out = path.join(temp, 'conflict-run'); fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'receipt.json'), 'historical-receipt-sentinel')
    const p = spawnSync(process.execPath, ['tools/traj-run.mjs', '--only', 'flaky-timeout', '--variants', 'raw', '--fork', '--fork-from', source, '--dry-run', '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /trajectory-evidence-ambiguous/)
    assert.equal(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8'), 'historical-receipt-sentinel')
  })
  test('contradictory reusedFrom task/sample cannot be silently reused', () => {
    for (const reusedFrom of [{ task: 'other-task', sample: 0 }, { task: 'flaky-timeout', sample: 1 }]) {
      assert.throws(() => requireUnambiguousTrajectories([raw(0, { reusedFrom })]), /source-identity-mismatch/)
      assert.throws(() => reusableRawIndex([raw(0, { reusedFrom })]), /source-identity-mismatch/)
    }
  })
  test('runner refuses zero/fractional sample controls before creating output', () => {
    for (const value of ['0', '1.5']) {
      const out = path.join(temp, 'invalid-count-' + value)
      const p = spawnSync(process.execPath, ['tools/traj-run.mjs', '--samples', value, '--dry-run', '--out', out], { cwd: ROOT, encoding: 'utf8' })
      assert.notEqual(p.status, 0); assert.equal(fs.existsSync(out), false)
    }
  })
  test('planner requires exact requested sample, not two arbitrary rows', () => {
    const source = path.join(temp, 'planner-gap.jsonl'); fs.writeFileSync(source, [raw(0), raw(2)].map(JSON.stringify).join('\n') + '\n')
    const p = spawnSync(process.execPath, ['tools/cfb-cycle.mjs', 'plan-traj', '--dry', '--arms', 'raw,hand', '--scenarios', 'flaky-timeout', '--samples', '2', '--reuse-raw', source], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CFB_CYCLE_DIR: path.join(temp, 'planner') } })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /reuse-raw-sample-missing:flaky-timeout:1/)
  })
  test('planner uses perturbed identity and ignores unrelated rows in cost scope', () => {
    const source = path.join(temp, 'planner-perturb.jsonl')
    fs.writeFileSync(source, [raw(0, { task: 'flaky-timeout:decoy', rounds: 5 }), raw(0, { task: 'wrong-model', rounds: 1, transcript: [{ calls: [1] }] })].map(JSON.stringify).join('\n') + '\n')
    const dir = path.join(temp, 'planner-perturb')
    const p = spawnSync(process.execPath, ['tools/cfb-cycle.mjs', 'plan-traj', '--arms', 'raw,hand', '--scenarios', 'flaky-timeout', '--samples', '1', '--perturb', 'decoy', '--reuse-raw', source], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CFB_CYCLE_DIR: dir } })
    assert.equal(p.status, 0, p.stderr)
    const plans = fs.readdirSync(path.join(dir, 'runtime')); assert.equal(plans.length, 1)
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'runtime', plans[0], 'plan.json'), 'utf8'))
    assert.deepEqual(plan.scenarios, ['flaky-timeout:decoy']); assert.equal(plan.reuseRaw.rows, 1); assert.equal(plan.reuseRaw.extend, undefined)
  })
  test('event fingerprint ignores time and key order, not a new provider event', () => {
    assert.equal(trajectoryRecordDigest(raw(0, { at: 'a', metrics: { a: 1, b: 2 } })), trajectoryRecordDigest(raw(0, { at: 'b', metrics: { b: 2, a: 1 } })))
    assert.notEqual(trajectoryRecordDigest(raw(0, { providerResponseId: 'one' })), trajectoryRecordDigest(raw(0, { providerResponseId: 'two' })))
  })
  test('confirm discards awaiting events and cross-file copies cannot increase validity n', () => {
    const dir = path.join(temp, 'confirm-scope'), input = path.join(temp, 'confirm.jsonl')
    const terminal = [raw(0, { variant: 'champion', proxyScore: 2, fixed: true, fixedAtRound: 2, rounds: 3 }), raw(0, { variant: 'previous', proxyScore: 1, fixed: false, rounds: 3 })]
    fs.writeFileSync(input, [raw(0, { variant: 'champion', status: 'awaiting-draft' }), ...terminal, terminal[0]].map(JSON.stringify).join('\n') + '\n')
    const cli = (file) => spawnSync(process.execPath, ['tools/cfb-cycle.mjs', 'confirm', '--results', file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CFB_CYCLE_DIR: dir } })
    const first = cli(input); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /效度账本 \+2 对/)
    const copy = path.join(temp, 'renamed-confirm.jsonl'); fs.copyFileSync(input, copy)
    const repeated = cli(copy); assert.equal(repeated.status, 0, repeated.stderr); assert.match(repeated.stdout, /效度账本 \+0 对/)
    assert.equal(fs.readFileSync(path.join(dir, 'offline/ruler/validity.jsonl'), 'utf8').trim().split('\n').length, 2)
  })
  test('confirm rejects conflicting terminal input without creating a promotion ledger', () => {
    const dir = path.join(temp, 'confirm-conflict'), input = path.join(temp, 'conflicting-confirm.jsonl')
    fs.writeFileSync(input, [raw(0, { variant: 'champion' }), raw(0, { variant: 'champion', fixed: true })].map(JSON.stringify).join('\n') + '\n')
    const p = spawnSync(process.execPath, ['tools/cfb-cycle.mjs', 'confirm', '--results', input], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CFB_CYCLE_DIR: dir } })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /evidence-ambiguous/); assert.equal(fs.existsSync(path.join(dir, 'offline/ruler/validity.jsonl')), false)
  })
  test('project doctor succeeds without pretending a model is ready', () => {
    const r = doctor(ROOT); assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(r.readiness.ready, false)
    assert.equal(r.evidence.v9Status, 'INVALID'); assert.equal(r.paidApiCallsByThisCommand, 0)
  })
  test('retired recovery aliases fail closed without touching historical files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    assert.match(pkg.scripts.restore, /project.mjs retired/); assert.match(pkg.scripts.snapshot, /project.mjs retired/)
    const p = spawnSync(process.execPath, ['tools/project.mjs', 'retired', 'restore'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(p.status, 2); assert.match(p.stderr, /不可再生数据/)
  })
  test('future active ruler is separately hash-bound; old INVALID is not a permanent route deadlock', () => {
    const dir = path.join(temp, 'future-project'); fs.mkdirSync(dir)
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'PROJECT.json'), 'utf8'))
    const replay = JSON.parse(fs.readFileSync(path.join(ROOT, state.evidence.v9Replay), 'utf8'))
    const missing = JSON.parse(fs.readFileSync(path.join(ROOT, state.evidence.missingLedger), 'utf8'))
    const protectedPaths = fs.readFileSync(path.join(ROOT, state.evidence.frozenList), 'utf8').trim().split('\n').map((x) => x.slice(66))
    const files = [...state.authority, ...SOURCE_CATALOG.map((x) => x.path), ...Object.values(state.continuationProgram.evidence).map((x) => x.path), ...Object.values(state.evidence).filter((x) => typeof x === 'string'), ...protectedPaths, missing.originalManifest, ...missing.entries.map((x) => x.archivePath).filter(Boolean), ...Object.keys(replay.protectedHistoricalHashes).map((x) => 'data-v9/' + x), 'data-v9/labelled-pool.jsonl', 'src/config.js']
    for (const rel of new Set(files)) { if (!fs.existsSync(path.join(ROOT, rel))) continue; fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel)) }
    const digest = (x) => crypto.createHash('sha256').update(x).digest('hex')
    const prereg = 'synthetic future ruler preregistration; fixture, not evidence'; fs.writeFileSync(path.join(dir, 'new-prereg.md'), prereg)
    const report = JSON.stringify({ preregSha256: digest(prereg), validity: { hand: 'PASS', negatives: 'PASS', determinism: 'PASS', VALID: 'VALID' } }); fs.writeFileSync(path.join(dir, 'new-validity.json'), report)
    state.evidence.activeRuler = { preregistration: { path: 'new-prereg.md', sha256: digest(prereg) }, validation: { path: 'new-validity.json', sha256: digest(report) } }
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify(state))
    const r = doctor(dir); assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(r.evidence.activeRuler.valid, true); assert.equal(r.evidence.v9Status, 'INVALID'); assert.ok(!r.readiness.blockers.some((x) => x.includes('active preregistered'))); assert.equal(r.readiness.ready, false)
    state.claims.cpuQualityAndLatencyVerified = true; fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify(state))
    assert.equal(doctor(dir).ok, false, 'a boolean flip without a real bound receipt is not readiness')
    state.claims.cpuQualityAndLatencyVerified = false; state.claims.neverWorseThanRawGuaranteed = true; fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify(state))
    assert.ok(doctor(dir).errors.includes('unsupported-universal-nonregression-claim'))
  })
  test('source lineage resolves timestamp-only duplicate without first-run basename guessing', () => {
    const dir = path.join(temp, 'lineage')
    const store = (rel, rows) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map(JSON.stringify).join('\n') + '\n') }
    store('.cfb-runtime/traj/t1/results.jsonl', [raw(0), raw(0, { at: 'second-time' })])
    store('.cfb-offline/traj/t1/results.jsonl', [raw(0, { at: 'unrelated' })])
    store('.cfb-runtime/traj/t2/results.jsonl', [raw(0, { reusedFrom: { file: '/old/checkout/.cfb-runtime/traj/t1/results.jsonl', at: 'second-time', sample: 0 } })])
    const r = auditTrajectories(dir); assert.equal(r.unresolvedReferences.length, 0); assert.equal(r.relabelledRawIdentities.length, 0); assert.equal(r.logFiles, 3)
  })
  test('manifest parser rejects malformed, duplicate and escaping paths', () => {
    const h = 'a'.repeat(64)
    assert.equal(parseManifest(h + '  file.txt\n').get('file.txt'), h)
    for (const input of ['invalid\n', h + '  ../secret\n', h + '  /absolute\n', h + '  a\\b\n', h + '  file.txt\n' + h + '  file.txt\n']) assert.throws(() => parseManifest(input))
  })
  test('sparse exceptions require both explicit sparse config and Git skip-worktree identity', () => {
    const dir = path.join(temp, 'git'); fs.mkdirSync(dir)
    const git = (...args) => { const p = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr) }
    git('init', '-q'); fs.writeFileSync(path.join(dir, 'hidden.txt'), 'x'); fs.writeFileSync(path.join(dir, 'missing.txt'), 'y')
    git('add', 'hidden.txt', 'missing.txt'); git('update-index', '--skip-worktree', 'hidden.txt')
    fs.unlinkSync(path.join(dir, 'hidden.txt')); fs.unlinkSync(path.join(dir, 'missing.txt'))
    assert.equal(sparseOmissions(dir).size, 0)
    git('config', 'core.sparseCheckout', 'true')
    assert.deepEqual([...sparseOmissions(dir)], ['hidden.txt'])
  })
  test('lost sparse setting repair requires the retained pattern and skip-index identities', () => {
    const dir=path.join(temp,'sparse-repair');fs.mkdirSync(dir)
    const git=(...args)=>{const p=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout}
    git('init','-q');fs.writeFileSync(path.join(dir,'hidden.bin'),'fixture');git('add','hidden.bin');git('update-index','--skip-worktree','hidden.bin');fs.unlinkSync(path.join(dir,'hidden.bin'))
    fs.mkdirSync(path.join(dir,'transfer/audit-2026-10-11'),{recursive:true});fs.writeFileSync(path.join(dir,'transfer/audit-2026-10-11/checkout-scope.json'),JSON.stringify({excluded:[{path:'hidden.bin'}]}))
    fs.writeFileSync(path.join(dir,'.git/info/sparse-checkout'),'/*\n!/hidden.bin\n')
    const repaired=restoreSparseConfiguration(dir);assert.equal(repaired.worktreeOrIndexChanged,false);assert.equal(repaired.filesFetched,0);assert.equal(repaired.previousSparseEnabled,false);assert.equal(git('config','--bool','--get','core.sparseCheckout').trim(),'true');assert.equal(fs.existsSync(path.join(dir,'hidden.bin')),false)
    fs.writeFileSync(path.join(dir,'.git/info/sparse-checkout'),'/*\n');assert.throws(()=>restoreSparseConfiguration(dir),/pattern-or-index-mismatch/)
  })
  test('research SFT command cannot silently become an admission/export command', () => {
    const p = spawnSync(process.execPath, ['tools/build-sft.mjs'], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /SFT admission blocked/)
  })
  test('research builder fails on malformed JSON without creating artifacts', () => {
    const input = path.join(temp, 'broken.jsonl'), out = path.join(temp, 'bad-sft'); fs.writeFileSync(input, '{broken\n')
    const p = spawnSync(process.execPath, ['tools/build-sft.mjs', '--research-only', '--in', input, '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /invalid-source-json:1/); assert.equal(fs.existsSync(out), false)
  })
  test('research builder refuses conflicting source IDs even if an old rule would filter them', () => {
    const input = path.join(temp, 'conflict-sft.jsonl'), out = path.join(temp, 'conflict-sft')
    const row = { id: 'fixture', repo: 'fixture-repo', raw: 'a.ts needs repair', ctx: 'fixture context', draft: 'draft-a' }
    fs.writeFileSync(input, [row, { ...row, draft: 'draft-b' }].map(JSON.stringify).join('\n') + '\n')
    const p = spawnSync(process.execPath, ['tools/build-sft.mjs', '--research-only', '--in', input, '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /conflicting-source-id:fixture/); assert.equal(fs.existsSync(out), false)
  })
  test('missing frozen dev IDs are fatal, not a printed warning', () => {
    const input = path.join(temp, 'dev-source.jsonl'), ids = path.join(temp, 'ids.txt'), out = path.join(temp, 'missing-dev')
    fs.writeFileSync(input, JSON.stringify({ id: 'present', repo: 'fixture-repo', raw: 'too short', ctx: '', draft: 'too short' }) + '\n')
    fs.writeFileSync(ids, 'missing-frozen-id\n')
    const p = spawnSync(process.execPath, ['tools/build-sft.mjs', '--research-only', '--in', input, '--dev-ids', ids, '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(p.status, 0); assert.match(p.stderr, /frozen-dev-ids-missing:missing-frozen-id/); assert.equal(fs.existsSync(out), false)
  })
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
console.log(`PASS=${pass} FAIL=${fail} SKIP=0`)
process.exit(fail ? 1 : 0)
