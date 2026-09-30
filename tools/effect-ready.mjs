#!/usr/bin/env node
// 离线准备为默认；只有 run --live 能进入已批准的有界网络路径。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { prepareEvaluation, doctorEvaluation, runEvaluation, reportEvaluation, DEFAULT_HOME, PUBLIC_RECEIPT, PROFILE_EXAMPLE, ROOT } from './helpers/eval-workflow.mjs'
import { readJson } from './helpers/eval-files.mjs'
import { exportEvaluationBundle, importEvaluationBundle } from './helpers/eval-bundle.mjs'

const HELP = `CFB 联网准备工具（默认无网络/无费用）\n\n  prepare [--profile FILE] [--pricing FILE] [--home DIR]  冻结完整计划\n  doctor  [--home DIR]                                 只读预检，不探测网络\n  simulate                                             真断网本机HTTP整链演练\n  run --live [--home DIR]                               显式执行USD2/13请求批准\n  report [--home DIR]                                   认证缓存重算完整配对\n  export --file FILE [--home DIR]                       加密检查点，口令来自环境\n  import --file FILE [--home DIR]                       恢复空目录，拒绝预算回滚\n\n模型钥匙只来自profile指定环境变量，不从CLI/文件读取。\n迁移口令只来自CFB_STATE_PASSPHRASE；不要把它或模型钥匙贴到聊天。\n公开预算收据固定在transfer/api-budget-approval.watermark.json；不能删/换收据来重获额度。\n`
export async function readyMain(argv, { env = process.env, output = console.log, progress = (r) => console.error(JSON.stringify(r)) } = {}) {
  const [command = 'doctor', ...args] = argv
  if (['help', '--help', '-h'].includes(command)) { output(HELP); return 0 }
  if (!['prepare', 'doctor', 'simulate', 'run', 'report', 'export', 'import'].includes(command)) throw new Error('eval-command')
  const o = { home: env.CFB_EVAL_HOME || DEFAULT_HOME, live: false, profile: PROFILE_EXAMPLE }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') o.live = true
    else if (['--home', '--profile', '--pricing', '--file'].includes(args[i])) {
      const k = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('eval-option-value')
      o[k] = args[++i]
    } else if (args[i] !== '--json') throw new Error('eval-option')
  }
  if (o.live && command !== 'run' || (o.pricing || o.profile !== PROFILE_EXAMPLE) && command !== 'prepare' || o.file && !['export', 'import'].includes(command)) throw new Error('eval-option-context')
  const print = (r) => output(JSON.stringify(r, null, 2))
  if (command === 'prepare') {
    const profile = readJson(o.profile)
    // 显式准备时可用非敏感环境配置；已有计划/收据仍会拒绝任何变更。
    if (o.profile === PROFILE_EXAMPLE) {
      if (env.DEEPSEEK_MODEL) profile.model = env.DEEPSEEK_MODEL
      if (env.DEEPSEEK_BASE_URL) profile.baseUrl = env.DEEPSEEK_BASE_URL
    }
    print(prepareEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT, profile, ...(o.pricing ? { pricing: readJson(o.pricing) } : {}), env }))
    return 0
  }
  if (command === 'doctor') { const r = doctorEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT, env }); print(r); return r.status === 'live-preflight-ready' ? 0 : 2 }
  if (command === 'report') { print(reportEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT })); return 0 }
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
    print(operation({ home: o.home, receiptPath: PUBLIC_RECEIPT, file: o.file, passphrase: env.CFB_STATE_PASSPHRASE }))
    return 0
  }
  if (!o.live) { print({ ...doctorEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT, env }), executionRequested: false, next: 'run --live：只有明确live才可能发送已冻结的单探针/矩阵。' }); return 2 }
  const preflight = doctorEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT, env })
  if (preflight.status !== 'live-preflight-ready') { print(preflight); return 2 }
  const ctl = new AbortController(), abort = () => ctl.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const r = await runEvaluation({ home: o.home, receiptPath: PUBLIC_RECEIPT, env, live: true, signal: ctl.signal, onProgress: progress })
    print(r); return r.complete ? 0 : 3
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) readyMain(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((e) => {
  // 异常可能含原始JSON/URL/文件内容，输出只保留工具自己定义的错误码。
  console.error(/^(?:eval|api|profile|source|explicit)-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'eval-operation-failed')
  process.exitCode = 1
})
