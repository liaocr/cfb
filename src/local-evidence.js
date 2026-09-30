// 32 个本地可执行工程场景。代理自写、已知参考，不是独立主模型 S0。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { freezeEffectSuite } from './effect-archive.js'
import { canonicalJson, immutableJson, createEvidenceProgram } from './evidence-program.js'
import { protectEvidenceContract } from './evidence-host.js'
import { createEvidenceStore } from './evidence-store.js'
import { createFileStateAdapter } from './evidence-checkpoint.js'
import { createEvidenceRuntime } from './evidence-runtime.js'
export const LOCAL_EVIDENCE_FAMILIES = immutableJson({ train: ['file-precondition', 'revision-freshness', 'equivalent-conditions', 'literal-replacement'],
  selection: ['source-integrity', 'rollback-recovery'], test: ['model-identity', 'command-output'] })
const names = Object.values(LOCAL_EVIDENCE_FAMILIES).flat()
const eq = (field, value) => ({ op: 'equals', field, value })
const ORACLE = `const fs = require('node:fs');
const truth = JSON.parse(fs.readFileSync('truth.json', 'utf8'));
const result = JSON.parse(fs.readFileSync('result.json', 'utf8'));
const bytes = fs.readFileSync('fixture.txt').toString('base64');
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const target = truth.feasible ? truth.goal : truth.initial;
const wantedState = truth.feasible ? {context: ['user task', 'applied'], workRemaining: 0} : {context: ['user task'], workRemaining: 1};
const correct = result.ok === truth.feasible && bytes === target && JSON.stringify(state) === JSON.stringify(wantedState);
console.log(JSON.stringify({correct}));
`
export function createLocalEvidenceSuite() {
  const parts = Object.fromEntries(Object.entries(LOCAL_EVIDENCE_FAMILIES).map(([split, families]) => [split, families.flatMap((family) => Array.from({ length: 4 }, (_, variant) => ({
    id: family + ':' + variant, family, input: { family, variant }, predicate: eq('correct', true) }))) ]))
  return freezeEffectSuite({ id: 'local-engineering-s0-v1', evaluatorVersion: 'actual-files-state-http-command-two-observers-v1', ...parts })
}
export function parseLocalEvidencePolicy(candidate) {
  if (candidate === null) return immutableJson({ mode: 'idle' })
  const policy = JSON.parse(candidate.body)
  if (!policy || Object.keys(policy).length !== 1 || !['idle', 'unchecked', 'checked'].includes(policy.mode)) throw new Error('local-policy-space')
  return immutableJson(policy)
}
function loopbackValue(url, signal) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { signal, agent: false }, (res) => {
      let data = ''; res.setEncoding('utf8')
      res.on('data', (s) => { data += s; if (data.length > 1024) req.destroy(new Error('local-response-budget')) })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    })
    req.setTimeout(1000, () => req.destroy(new Error('local-response-timeout'))); req.on('error', reject)
  })
}
/** 输入只有族/变体；执行器看不到 split/predicate。文件、JSON 状态、子进程、loopback 均实际操作。 */
export async function executeLocalEvidenceCase(candidate, input, { perturbation = 'none', observer = 'primary' } = {}) {
  if (!names.includes(input?.family) || !Number.isInteger(input.variant) || input.variant < 0 || input.variant > 3 ||
    !['none', 'format'].includes(perturbation) || !['primary', 'secondary'].includes(observer)) throw new Error('local-case-schema')
  const policy = parseLocalEvidencePolicy(candidate), { family, variant } = input, feasible = variant % 2 === 0
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-local-case-')), root = path.join(home, 'ws')
  let server = null, loopbackRequests = 0
  try {
    fs.mkdirSync(root)
    const oldText = perturbation === 'format' ? 'BEFORE\t中文\r\n' : 'BEFORE\n'
    const newText = family === 'literal-replacement' ? "$& $$ $` $' 中文🙂\n" : (perturbation === 'format' ? '\tAFTER 中文\r\n' : 'AFTER\n')
    let initial = Buffer.from(oldText)
    if (family === 'file-precondition' && !feasible) initial = Buffer.from(variant === 1 ? oldText.repeat(2) : 'unexpected original\n')
    if (family === 'literal-replacement' && !feasible) initial = variant === 1 ? Buffer.concat([initial, Buffer.from([255])]) : Buffer.from(oldText.repeat(2))
    fs.writeFileSync(path.join(root, 'fixture.txt'), initial)
    const initialState = { context: ['user task'], workRemaining: 1 }; fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(initialState))
    const readState = () => JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    const writeState = (s) => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(s))
    const wantedConditions = { cpus: 2, clock: 'deterministic', model: 'local-model-v1', fingerprint: 'local-fp-v1' }
    const actualConditions = { ...wantedConditions }
    if (family === 'equivalent-conditions' && !feasible) actualConditions[variant === 1 ? 'cpus' : 'clock'] = variant === 1 ? 1 : 'wall'
    if (family === 'model-identity') {
      server = http.createServer((req, res) => { loopbackRequests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: variant === 1 ? 'wrong-local-model' : 'local-model-v1', fingerprint: variant === 3 ? 'wrong-local-fp' : 'local-fp-v1' })) })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    }
    fs.writeFileSync(path.join(root, 'guard.txt'), 'frozen-checker-v1')
    const command = family === 'command-output' && !feasible ? variant === 1 ? "console.log('NOT_OK'); process.exitCode=1" : "console.log('x'.repeat(8192))" : "console.log('LOCAL_OK')"
    fs.writeFileSync(path.join(root, 'acceptance.cjs'), command)
    fs.writeFileSync(path.join(root, 'oracle.cjs'), ORACLE)
    fs.writeFileSync(path.join(root, 'truth.json'), JSON.stringify({ feasible, initial: initial.toString('base64'), goal: Buffer.from(newText).toString('base64') }))
    const checks = [
      { id: 'can-apply', role: 'precondition', kind: 'observation', conditions: wantedConditions, predicate: eq('ready', true) },
      { id: 'landed', role: 'acceptance', kind: 'file', path: 'fixture.txt', predicate: eq('text', newText) },
      family === 'command-output' ? { id: 'goal', role: 'acceptance', kind: 'command', executable: process.execPath, args: ['acceptance.cjs'], localOnly: true, timeoutMs: 1000, maxOutputBytes: 128,
        predicate: { op: 'and', items: [eq('exitCode', 0), { op: 'includes', field: 'stdout', value: 'LOCAL_OK' }] } } :
        { id: 'goal', role: 'acceptance', kind: 'observation', conditions: wantedConditions, predicate: eq('fixed', true) },
    ]
    const contract = protectEvidenceContract({ task: 'local-s0:' + family, version: '1', checks, actions: [
      { id: 'apply', type: 'replace', path: 'fixture.txt', oldText, newText, preconditions: ['can-apply'], checks: ['landed', 'goal'] },
    ] }, { root, paths: ['guard.txt', 'acceptance.cjs', 'oracle.cjs', 'truth.json'] })
    if (family === 'source-integrity' && !feasible) fs.writeFileSync(path.join(root, 'guard.txt'), 'tampered-source')
    const store = createEvidenceStore({ directory: path.join(home, 'store'), sessionId: 'local-case' })
    const adapter = createFileStateAdapter({ root, paths: ['fixture.txt'], readState, writeState,
      readConditions: () => actualConditions, afterAction: () => writeState({ context: ['user task', 'applied'], workRemaining: 0 }) })
    const observe = async (check, binding, signal) => {
      const conditions = { ...actualConditions }
      if (server) Object.assign(conditions, await loopbackValue('http://127.0.0.1:' + server.address().port + '/identity', signal))
      const file = fs.readFileSync(path.join(root, 'fixture.txt'))
      const landed = observer === 'secondary' ? file.toString('base64') === Buffer.from(newText).toString('base64') : file.equals(Buffer.from(newText))
      return { value: { ready: family !== 'file-precondition' || file.equals(Buffer.from(oldText)), fixed: landed && (family !== 'rollback-recovery' || feasible) },
        revision: family === 'revision-freshness' && variant === 1 ? 'past-revision' : binding.revision,
        roundId: family === 'revision-freshness' && variant === 3 ? 'past-round' : binding.roundId, conditions }
    }
    let result
    if (policy.mode === 'checked') {
      const runtime = createEvidenceRuntime({ contract, sessionId: store.sessionId, store, adapter, observe, allowEdits: true, allowCommands: family === 'command-output',
        roundTimeoutMs: 5000, contextOptions: { maxTokensEst: 32768 } })
      result = await runtime.runRound(createEvidenceProgram('宿主本地批准策略：先前置，后落地与目标验收。', { contract, sessionId: store.sessionId, actionIds: ['apply'] }), { roundId: 'scenario' })
    } else if (policy.mode === 'unchecked') {
      // 明确的无检查工程对照：真实写入，但没有前置/验收/回滚、且字符串替换会解释 $ 元字符。
      const text = fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8'); fs.writeFileSync(path.join(root, 'fixture.txt'), text.replace(oldText, newText))
      writeState({ context: ['user task', 'applied'], workRemaining: 0 }); result = { ok: true, status: 'unchecked-claim', reason: 'no-receipts' }
    } else result = { ok: false, status: 'idle', reason: 'no-action' } // 保守基线：不会误修，也不能完成可修任务。
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: result.ok }))
    const expectedBytes = feasible ? Buffer.from(newText) : initial
    const expectedState = feasible ? { context: ['user task', 'applied'], workRemaining: 0 } : initialState
    const primary = result.ok === feasible && fs.readFileSync(path.join(root, 'fixture.txt')).equals(expectedBytes) && canonicalJson(readState()) === canonicalJson(expectedState)
    const oracle = spawnSync(process.execPath, ['oracle.cjs'], { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: root }, encoding: 'utf8', timeout: 2000, maxBuffer: 4096 })
    const secondary = oracle.status === 0 ? JSON.parse(oracle.stdout).correct : null
    return immutableJson({ ...(typeof secondary === 'boolean' && primary === secondary ? { correct: primary } : { unknownReason: 'oracle-unavailable-or-disagreement' }), primary, secondary, agreement: primary === secondary,
      actualVerified: result.ok, status: result.status, reason: result.reason, managedStateRestored: !feasible && fs.readFileSync(path.join(root, 'fixture.txt')).equals(initial) && canonicalJson(readState()) === canonicalJson(initialState),
      loopbackRequests, externalApiCalls: 0, localOracleProcesses: 1 })
  } finally { if (server) await new Promise((r) => server.close(r)); fs.rmSync(home, { recursive: true, force: true }) }
}
