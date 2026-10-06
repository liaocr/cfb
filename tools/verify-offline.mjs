#!/usr/bin/env node
// 真断网验收：只有 loopback 的 Linux 网络命名空间。失败不回退到联网执行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/**
 * 断网证据的唯一判据：此刻这个进程是不是真的处在「只有 lo、零外部路由」的隔离里。
 * 返回 { ok, why, interfaces, externalRoutes }，不抛 —— 抛不抛由调用方决定。
 *
 * 该证据依赖 /proc/net/route —— 这是 **Linux 独有**的。非 Linux 平台拿不到同等强度的证据，
 * 因此 assertOfflineNamespace 必须**失败关闭**并给出可识别的错误码，而不是抛出 ENOENT 让调用方误以为是崩溃。
 */
function probeOfflineNamespace() {
  if (process.platform !== 'linux') return { ok: false, why: 'unverifiable-platform:' + process.platform }
  let routes
  try { routes = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1) } catch { return { ok: false, why: 'unverifiable-platform:no-proc-net-route' } }
  const interfaces = Object.entries(os.networkInterfaces()).filter(([, rows]) => rows?.length).map(([name]) => name)
  if (!interfaces.length || interfaces.some((name) => name !== 'lo') || routes.length) return { ok: false, why: 'required', interfaces, externalRoutes: routes.length }
  return { ok: true, interfaces, externalRoutes: routes.length }
}
export function assertOfflineNamespace() {
  const p = probeOfflineNamespace()
  if (!p.ok) throw new Error('offline-namespace-' + p.why)
  return { isolation: 'linux-user-network-namespace', interfaces: p.interfaces, externalRoutes: p.externalRoutes, externalApiCalls: 0 }
}
/**
 * 调用方据此决定「跳过」还是「失败」。
 * ★ v14.25.1 修正：判据从「本平台有没有能力取证」改成「此刻是否真在隔离里」，与 assertOfflineNamespace 同源。
 *   旧写法在**联网的 Linux** 上恒为 true ⇒ `test/eval-ready.selftest.mjs` 第 38 项会去跑一条需要 lo-only 的
 *   断言并当场抛 `offline-namespace-required` ⇒ `npm test` 在普通 Linux 上必红一项（`npm run verify:offline`
 *   在 `unshare -Urn` 内全绿）。跳过与通过仍是两件事：套件必须打 `SKIP=n`，绝不把跳过计成通过。
 */
export const offlineNamespaceVerifiable = () => probeOfflineNamespace().ok
function options(argv) {
  const result = { inside: false, suites: [], mode: 'all' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inside') result.inside = true
    else if (argv[i] === '--suites') {
      result.suites = String(argv[++i] || '').split(',')
      if (result.suites.some((s) => !/^[a-z0-9-]+$/.test(s))) throw new Error('offline-suite-arguments')
    } else if (argv[i] === '--ready-simulate') result.mode = 'ready-simulate'
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
    if (config.mode === 'ready-simulate') execute(['tools/effect-ready.mjs', 'simulate'])
    else {
      execute(['verify.mjs', ...config.suites])
      execute(['tools/audit-noninferiority.mjs'])
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
