#!/usr/bin/env node
// 离线训练准备默认；实际权重/收费作业需要明确execute与独立训练批准。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { normalizeTrainingExample } from '../src/training-core.js'
import { readJson, writeJson, assertSafePath } from './helpers/eval-files.mjs'
import { trainingJsonl, buildTrainingDataset, auditTrainingDataset } from './helpers/training-data.mjs'
import { exportTrainingWorkspace, importTrainingWorkspace } from './helpers/training-transfer.mjs'
import { prepareTrainingPlan, assertTrainingPlan, relocateTrainingPlan, DEFAULT_TRAIN_HOME, TRAIN_ROOT } from './helpers/training-plan.mjs'
import { openTrainingAuthorities, importHistoricalTrainingCandidates, doctorTraining, runTraining } from './helpers/training-workflow.mjs'
import { openTrainingState } from './helpers/training-state.mjs'
const HELP = `CFB训练准备（默认不联网，不安装依赖，不改生产模型）\n\n import-history --out FILE                   导入完整历史prompt/side，0条默认批准\n review --input FILE --out FILE --accept --checks FILE --reviewer NAME --mode expert|objective|fixture\n dataset --input FILE --out DIR              私有审核/版权/重复/族隔离，test本地保管\n audit --dataset DIR                         重验sha/HMAC审核/撤销/切分/导出等价\n prepare --dataset DIR --profile FILE --out FILE\n doctor --plan FILE [--approval REF]          只读依赖/缓存/训练能力/独立批准预检\n authorize --plan FILE --mode MODE --max-usd NUMBER --confirm-training\n run --plan FILE --execute --approval REF [--live] [--resume DIR]\n report --plan FILE [--approval REF]          只读已认证作业状态\n promote --plan FILE --candidate FILE --certificate REF   独立验证闸，仅登记不启用插件\n rollback                                   仅模型注册表回上一版本\n export/import --file FILE                  加密workspace，口令只从CFB_STATE_PASSPHRASE读取\n relocate --plan FILE --dataset DIR --out FILE  保持逻辑计划/预算，核对搬迁内容\n demo                                       真断网，实际byte小模型+远程HTTP替身\n\n训练权/真实价表/基模型缓存缺失必须blocked，旧USD2/13次A/B不能授权训练。\n配置只放环境变量名，禁止钥匙/口令CLI参数。默认home=.cfb-runtime/train-ready。\n`
export async function trainingMain(argv, { env = process.env, output = console.log } = {}) {
  const [command = 'help', ...args] = argv
  if (['help', '--help', '-h'].includes(command)) { output(HELP); return 0 }
  if (!['import-history', 'review', 'dataset', 'audit', 'prepare', 'doctor', 'authorize', 'run', 'report', 'promote', 'rollback', 'demo', 'export', 'import', 'relocate'].includes(command)) throw new Error('training-command')
  const o = { home: env.CFB_TRAIN_HOME || DEFAULT_TRAIN_HOME, accept: false, execute: false, live: false, confirm: false, cancel: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--accept') o.accept = true
    else if (a === '--execute') o.execute = true
    else if (a === '--live') o.live = true
    else if (a === '--cancel') o.cancel = true
    else if (a === '--confirm-training') o.confirm = true
    else if (['--home', '--input', '--out', '--dataset', '--profile', '--plan', '--approval', '--mode', '--checks', '--reviewer', '--max-usd', '--state', '--resume', '--candidate', '--certificate', '--evaluation-suite', '--file', '--model-path', '--objective'].includes(a)) { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('training-option-value'); o[a.slice(2)] = args[++i] }
    else if (a !== '--json') throw new Error('training-option')
  }
  const print = (v) => output(JSON.stringify(v, null, 2))
  if (command === 'demo') {
    if (env.CFB_OFFLINE !== '1') {
      const r = spawnSync(process.execPath, [path.join(TRAIN_ROOT, 'tools/verify-offline.mjs'), '--training-demo'], { cwd: TRAIN_ROOT, env, stdio: 'inherit', timeout: 180000 })
      if (r.error || r.status !== 0) throw new Error('training-demo-isolation')
    } else { const { trainingDemo } = await import('./helpers/training-demo.mjs'); print(await trainingDemo()) }
    return 0
  }
  if (command === 'export' || command === 'import') {
    if (!o.file) throw new Error('training-transfer-file-required')
    const markerDirectory = path.join(TRAIN_ROOT, 'transfer/training-sessions')
    if (command === 'export') {
      const markerFiles = fs.existsSync(markerDirectory) ? fs.readdirSync(markerDirectory).filter((n) => n.endsWith('.json')).map((n) => path.join(markerDirectory, n)) : []
      print(exportTrainingWorkspace({ home: o.home, file: o.file, markerFiles, passphrase: env.CFB_STATE_PASSPHRASE }))
    } else print(importTrainingWorkspace({ home: o.home, file: o.file, markerDirectory, passphrase: env.CFB_STATE_PASSPHRASE }))
    return 0
  }
  if (command === 'import-history') { if (!o.out) throw new Error('training-output-required'); print(importHistoricalTrainingCandidates(o.out)); return 0 }
  const authority = openTrainingAuthorities(o.home, {
    verifyReview: o.accept && command === 'review' ? (row, policy) => row.source.trainingAllowed && (policy.mode === 'fixture' ? row.source.kind === 'fixture' : row.source.kind !== 'fixture') : null,
    authorize: o.confirm && command === 'authorize' ? () => true : null,
  })
  if (command === 'review') {
    if (!o.accept || !o.input || !o.out || !o.checks || !o.reviewer || !o.mode) throw new Error('training-human-review-required')
    const checks = readJson(o.checks), file = assertSafePath(o.out, { createParents: true }), temp = file + '.reviewing-' + crypto.randomUUID()
    let rows = [], accepted = 0
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try {
        const flush = () => { if (!rows.length) return; const batch = authority.reviews.approveBatch(rows, { mode: o.mode, reviewer: o.reviewer, checks }); for (const r of batch) fs.writeSync(fd, JSON.stringify(r) + '\n'); accepted += batch.length; rows = [] }
        for await (const row of trainingJsonl(o.input)) { rows.push(normalizeTrainingExample(row)); if (rows.length >= 1024) flush() } flush(); fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.linkSync(temp, file)
      print({ reviewed: accepted, independentExpertiseProven: false, externalApiCalls: 0 }); return 0
    } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  }
  if (command === 'dataset') { if (!o.input || !o.out) throw new Error('training-input-output-required'); print(await buildTrainingDataset({ input: o.input, output: o.out, reviews: authority.reviews, objective: o.objective || 'sft' })); return 0 }
  if (command === 'audit') { print(await auditTrainingDataset({ directory: o.dataset, reviews: authority.reviews })); return 0 }
  if (command === 'prepare') { if (!o.dataset || !o.out) throw new Error('training-dataset-plan-required'); const p = o.profile ? readJson(o.profile) : readJson(path.join(TRAIN_ROOT, 'deploy/training-profile.example.json')); print(await prepareTrainingPlan({ dataset: o.dataset, reviews: authority.reviews, profile: p, file: o.out, evaluationSuite: o['evaluation-suite'] ? readJson(o['evaluation-suite']) : null })); return 0 }
  if (command === 'rollback') { print(authority.governance.rollback()); return 0 }
  if (!o.plan) throw new Error('training-plan-required')
  const plan = readJson(o.plan); assertTrainingPlan(plan)
  let approval = o.approval ? authority.governance.openApproval(o.approval, plan) : null
  if (command === 'relocate') {
    if (!o.dataset || !o.out) throw new Error('training-relocation-paths')
    const moved = await relocateTrainingPlan(plan, { datasetDirectory: o.dataset, modelDirectory: o['model-path'] || null }, authority.reviews); writeJson(o.out, moved, { exclusive: true }); print({ relocated: true, logicalPlanDigest: moved.digest, budgetReset: false }); return 0
  }
  if (command === 'authorize') {
    if (!o.confirm || !o.mode || o['max-usd'] === undefined) throw new Error('training-separate-approval-required')
    const approved = authority.governance.approve(plan, { mode: o.mode, owner: 'explicit-operator', maxUsd: Number(o['max-usd']) })
    print({ approvalRef: approved.ref, id: approved.id, planDigest: plan.digest, mode: approved.mode, maxUsd: approved.maxUsd, originalABApprovalReused: false }); return 0
  }
  if (command === 'doctor') { const d = await doctorTraining({ plan, reviews: authority.reviews, approval, env }); print(d); return d.status === 'training-preflight-ready' ? 0 : 2 }
  if (command === 'promote') { if (!o.candidate || !o.certificate) throw new Error('training-independent-certificate-required'); print(authority.governance.promote({ plan, candidate: readJson(o.candidate), certificateRef: o.certificate })); return 0 }
  const scope = plan.profile.backend === 'reference-byte' ? 'reference:' + plan.digest : approval?.id
  if (!scope) throw new Error('training-separate-approval-required')
  const directory = o.state || path.join(o.home, 'jobs', crypto.createHash('sha256').update(scope).digest('hex').slice(0, 20))
  const markerPath = path.join(TRAIN_ROOT, 'transfer/training-sessions', crypto.createHash('sha256').update(scope).digest('hex') + '.json')
  if (command === 'report') { const state = openTrainingState({ directory, markerPath, plan, scope, initialize: false }); print({ phase: state?.read().phase || 'not-started', steps: state?.read().steps || 0, httpRequests: state?.read().http.length || 0, candidate: state?.read().candidate || null, productionActivated: false }); return 0 }
  if (!o.execute) throw new Error('training-explicit-execute-required')
  const ctl = new AbortController(), abort = () => ctl.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try { print(await runTraining({ plan, reviews: authority.reviews, governance: authority.governance, approvalRef: o.approval, directory, markerPath, planFile: o.plan, execute: o.execute, live: o.live, env, signal: ctl.signal, resume: o.resume, cancel: o.cancel })); return 0 }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) trainingMain(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((e) => {
  console.error(/^(?:training|eval)-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'training-operation-failed'); process.exitCode = 1
})
