#!/usr/bin/env node
// 真断网验收：只有 loopback 的 Linux 网络命名空间。失败不回退到联网执行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export function assertOfflineNamespace() {
  const interfaces = Object.entries(os.networkInterfaces()).filter(([, rows]) => rows?.length).map(([name]) => name)
  const routes = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
  if (!interfaces.length || interfaces.some((name) => name !== 'lo') || routes.length) throw new Error('offline-namespace-required')
  return { isolation: 'linux-user-network-namespace', interfaces, externalRoutes: routes.length, externalApiCalls: 0 }
}
function options(argv) {
  const result = { inside: false, suites: [], mode: 'all' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inside') result.inside = true
    else if (argv[i] === '--suites') {
      result.suites = String(argv[++i] || '').split(',')
      if (result.suites.some((s) => !/^[a-z0-9-]+$/.test(s))) throw new Error('offline-suite-arguments')
    } else if (['--demo', '--replay', '--lab', '--repair-development', '--repair-iterations', '--repair-regression', '--ready-simulate', '--training-demo'].includes(argv[i])) result.mode = argv[i].slice(2)
    else throw new Error('未知参数 ' + argv[i] + '；没有在线模式')
  }
  return result
}
function execute(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env: process.env, stdio: 'inherit', timeout: 180000 })
  if (result.error || result.status !== 0) throw result.error || new Error('offline-command-failed:' + args[0] + ':' + result.status)
}
function main(argv) {
  const config = options(argv)
  if (config.inside) {
    console.log('离线边界：' + JSON.stringify(assertOfflineNamespace()))
    if (config.mode === 'training-demo') execute(['tools/train-ready.mjs', 'demo'])
    else if (config.mode === 'ready-simulate') execute(['tools/effect-ready.mjs', 'simulate'])
    else if (config.mode !== 'all') execute(['tools/' + { demo: 'evidence-demo.mjs', replay: 'replay-evidence.mjs', lab: 'local-evidence-bench.mjs', 'repair-development': 'repair-development.mjs', 'repair-iterations': 'repair-iterations.mjs', 'repair-regression': 'repair-regression.mjs' }[config.mode]])
    else {
      execute(['verify.mjs', ...config.suites])
      execute(['tools/audit-noninferiority.mjs'])
      if (!config.suites.length) { execute(['tools/replay-evidence.mjs']); execute(['tools/evidence-demo.mjs']) }
    }
    return
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-offline-home-'))
  try {
    // 不继承 API/评委/代理/凭据环境；不加载真实 ~/.dsh 或 keys.env。
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, DSH_HOME: path.join(home, 'dsh'), LANG: 'C.UTF-8', TZ: 'UTC', CFB_OFFLINE: '1' }
    const result = spawnSync('unshare', ['-Urn', '--map-root-user', 'sh', '-eu', '-c', 'ip link set lo up; exec "$@"', 'cfb-offline', process.execPath, fileURLToPath(import.meta.url), '--inside', ...argv], { cwd: ROOT, env, stdio: 'inherit', timeout: 240000 })
    if (result.error || result.status !== 0) throw result.error || new Error('offline-isolation-or-tests-failed:' + result.status + '（不回退到联网测试）')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 1 } }
