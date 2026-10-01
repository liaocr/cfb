#!/usr/bin/env node
// 离线准备为默认；只有 run --live 能进入已批准的有界网络路径。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { prepareEvaluation, doctorEvaluation, runEvaluation, reportEvaluation, DEFAULT_HOME, DEFAULT_HOME_V2, DEFAULT_HOME_V3, DEFAULT_HOME_V4, DEFAULT_HOME_V5, DEFAULT_HOME_V6, DEFAULT_HOME_V7, DEFAULT_HOME_V8, PUBLIC_RECEIPT_V8, PUBLIC_RECEIPT, PUBLIC_RECEIPT_V2, PUBLIC_RECEIPT_V3, PUBLIC_RECEIPT_V4, PUBLIC_RECEIPT_V5, PUBLIC_RECEIPT_V6, PUBLIC_RECEIPT_V7, PROFILE_EXAMPLE, ROOT } from './helpers/eval-workflow.mjs'
import { readJson } from './helpers/eval-files.mjs'
import { exportEvaluationBundle, importEvaluationBundle } from './helpers/eval-bundle.mjs'

const HELP = `CFB 联网准备工具（默认无网络/无费用）\n\n  prepare [--profile FILE] [--pricing FILE] [--home DIR]  冻结完整计划\n  doctor  [--home DIR]                                 只读预检，不探测网络\n  simulate                                             真断网本机HTTP整链演练\n  run --live [--home DIR] [--checkpoint FILE]                               显式执行USD2/13请求批准\n  report [--home DIR]                                   认证缓存重算完整配对\n  export --file FILE [--home DIR]                       加密检查点，口令来自环境\n  import --file FILE [--home DIR]                       恢复空目录，拒绝预算回滚\n\n模型钥匙只来自profile指定环境变量，不从CLI/文件读取。\n迁移口令只来自CFB_STATE_PASSPHRASE；不要把它或模型钥匙贴到聊天。\n公开预算收据固定在transfer/api-budget-approval.watermark.json；不能删/换收据来重获额度。\n--v2：使用2026-10-01新批准scope（3同体备用探针/网络类失败不株连未派发请求/独立v2收据与私有仓）；旧scope收据/账本封存不动。\n--v3：生产等价可见上下文协议（raw=思考已丢现实，current=可见压缩稿；探针测可见消息保真）；独立v3收据与私有仓。\n--v4：v3矩阵输出预算修正(8192)+length截断样本级容错(预算3)；独立v4收据与私有仓。\n--v5：扩样本复跑(6样本/格,36主+3探针,≈USD0.73预留)+claimOfV2预注册判据；独立v5收据与私有仓。\n--v6：v5语义修正(探针免思考要求/主请求逐响应验证失败样本级预算6)；独立v6收据与私有仓。\n--v7：fp闸放开但逐响应记录(池轮换现实)，身份证据=型号+canary回显+思考+usage界；独立v7收据与私有仓。\n--v8：历史reasoning回放协议(raw=原始思考原文,current=冻结压缩稿)，探针实测prompt_tokens随历史reasoning线性增长以证拼接；独立v8收据与私有仓。\n`
export async function readyMain(argv, { env = process.env, output = console.log, progress = (r) => console.error(JSON.stringify(r)) } = {}) {
  const [command = 'doctor', ...args] = argv
  if (['help', '--help', '-h'].includes(command)) { output(HELP); return 0 }
  if (!['prepare', 'doctor', 'simulate', 'run', 'report', 'export', 'import'].includes(command)) throw new Error('eval-command')
  const o = { home: env.CFB_EVAL_HOME || DEFAULT_HOME, live: false, profile: PROFILE_EXAMPLE }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') o.live = true
    else if (args[i] === '--v2') o.v2 = true
    else if (args[i] === '--v3') o.v3 = true
    else if (args[i] === '--v4') o.v4 = true
    else if (args[i] === '--v5') o.v5 = true
    else if (args[i] === '--v6') o.v6 = true
    else if (args[i] === '--v7') o.v7 = true
    else if (args[i] === '--v8') o.v8 = true
    else if (['--home', '--profile', '--pricing', '--file', '--checkpoint'].includes(args[i])) {
      const k = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('eval-option-value')
      o[k] = args[++i]
    } else if (args[i] !== '--json') throw new Error('eval-option')
  }
  if ([o.v2, o.v3, o.v4, o.v5, o.v6, o.v7, o.v8].filter(Boolean).length > 1) throw new Error('eval-option-context')
  const receipt = o.v8 ? PUBLIC_RECEIPT_V8 : o.v7 ? PUBLIC_RECEIPT_V7 : o.v6 ? PUBLIC_RECEIPT_V6 : o.v5 ? PUBLIC_RECEIPT_V5 : o.v4 ? PUBLIC_RECEIPT_V4 : o.v3 ? PUBLIC_RECEIPT_V3 : o.v2 ? PUBLIC_RECEIPT_V2 : PUBLIC_RECEIPT
  if ((o.v2 || o.v3 || o.v4 || o.v5 || o.v6 || o.v7 || o.v8) && o.home === (env.CFB_EVAL_HOME || DEFAULT_HOME)) o.home = o.v8 ? DEFAULT_HOME_V8 : o.v7 ? DEFAULT_HOME_V7 : o.v6 ? DEFAULT_HOME_V6 : o.v5 ? DEFAULT_HOME_V5 : o.v4 ? DEFAULT_HOME_V4 : o.v3 ? DEFAULT_HOME_V3 : DEFAULT_HOME_V2
  if (o.live && command !== 'run' || (o.pricing || o.profile !== PROFILE_EXAMPLE) && command !== 'prepare' || o.file && !['export', 'import'].includes(command) || o.checkpoint && command !== 'run') throw new Error('eval-option-context')
  const print = (r) => output(JSON.stringify(r, null, 2))
  if (command === 'prepare') {
    const profile = readJson(o.profile)
    // 显式准备时可用非敏感环境配置；已有计划/收据仍会拒绝任何变更。
    if (o.profile === PROFILE_EXAMPLE) {
      if (env.DEEPSEEK_MODEL) profile.model = env.DEEPSEEK_MODEL
      if (env.DEEPSEEK_BASE_URL) profile.baseUrl = env.DEEPSEEK_BASE_URL
    }
    print(prepareEvaluation({ home: o.home, receiptPath: receipt, profile, ...(o.pricing ? { pricing: readJson(o.pricing) } : {}), env, version: o.v8 ? 8 : o.v7 ? 7 : o.v6 ? 6 : o.v5 ? 5 : o.v4 ? 4 : o.v3 ? 3 : o.v2 ? 2 : 1 }))
    return 0
  }
  if (command === 'doctor') { const r = doctorEvaluation({ home: o.home, receiptPath: receipt, env }); print(r); return r.status === 'live-preflight-ready' ? 0 : 2 }
  if (command === 'report') { print(reportEvaluation({ home: o.home, receiptPath: receipt })); return 0 }
  if (command === 'simulate') {
    if (env.CFB_OFFLINE !== '1') {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/verify-offline.mjs'), '--ready-simulate'], { cwd: ROOT, env, stdio: 'inherit', timeout: 180000 })
      if (result.error || result.status !== 0) throw new Error('eval-simulation-isolation')
    } else {
      const { simulateReadyEvaluation } = await import('./helpers/eval-simulate.mjs')
      print(await simulateReadyEvaluation())
    }
    return 0
  }
  if (command === 'export' || command === 'import') {
    if (!o.file) throw new Error('eval-bundle-file-required')
    const operation = command === 'export' ? exportEvaluationBundle : importEvaluationBundle
    print(operation({ home: o.home, receiptPath: receipt, file: o.file, passphrase: env.CFB_STATE_PASSPHRASE }))
    return 0
  }
  if (!o.live) { print({ ...doctorEvaluation({ home: o.home, receiptPath: receipt, env }), executionRequested: false, next: 'run --live：只有明确live才可能发送已冻结的单探针/矩阵。' }); return 2 }
  const preflight = doctorEvaluation({ home: o.home, receiptPath: receipt, env })
  if (preflight.status !== 'live-preflight-ready') { print(preflight); return 2 }
  const ctl = new AbortController(), abort = () => ctl.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const r = await runEvaluation({ home: o.home, receiptPath: receipt, env, live: true, signal: ctl.signal, onProgress: progress, checkpointFile: o.checkpoint || null })
    print(r); return r.complete ? 0 : 3
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) readyMain(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((e) => {
  // 异常可能含原始JSON/URL/文件内容，输出只保留工具自己定义的错误码。
  console.error(/^(?:eval|api|profile|source|explicit)-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'eval-operation-failed')
  process.exitCode = 1
})
