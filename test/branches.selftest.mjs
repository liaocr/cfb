// ★★ v11.11 分支覆盖补齐：此前没有任何测试走到的分支 ★★
//
//   （v12.1：§1 evidence / §2 filterCoveredTools / §4 消费计量随 memory 模式删除一并移除）
//   §3 预热：200 / 节流 / 非 2xx 永久停用 / 跟随「本次调用」的 provider / 解析不出就不预热
//   §5 tokens.js 非字符串输入
// 全部零外网（本机 HTTP）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { clearProviderCache } from '../src/provider.js'
import { makePrewarmer } from '../src/transport.js'
import { estimateTokens, wideShare, scriptCounts } from '../src/tokens.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-branches-'))
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


try {
  // ═══ §3 预热 ═══════════════════════════════════════════════════════════════
  const heads = []
  let status = 200
  const server = http.createServer((req, res) => { heads.push({ method: req.method, url: req.url, port: server.address().port }); res.writeHead(status); res.end() })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const other = http.createServer((req, res) => { heads.push({ method: req.method, url: req.url, other: true }); res.writeHead(200); res.end() })
  await new Promise((r) => other.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const settingsPath = path.join(home, 'settings.yaml')
  fs.writeFileSync(settingsPath, ['llm-pi-ai:', '  providers:', '    other:', '      apiKeyEnv: K', '      api: openai-completions',
    '      baseURL: http://127.0.0.1:' + other.address().port + '/v1', ''].join('\n'))
  clearProviderCache()
  const mk = (over = {}) => {
    const traces = []
    const cfg = { prewarm: true, mode: 'birth', baseUrl: base + '/v1', keepAlive: false, settingsPath, ...over }
    return { pw: makePrewarmer(cfg, (tag, data) => traces.push({ tag, data })), traces }
  }
  try {
    await test('§3a HEAD 打 origin（不是 /v1/）⇒ prewarm-ok；5s 内再次调用被节流', async () => {
      heads.length = 0
      const { pw, traces } = mk()
      pw('boot'); await sleep(150); pw('again'); await sleep(100)
      assert.equal(heads.length, 1)
      assert.deepEqual([heads[0].method, heads[0].url], ['HEAD', '/'])
      assert.equal(traces.find((t) => t.tag === 'prewarm-ok').data.status, 200)
    })
    await test('§3b 非 2xx ⇒ 记录并**永久停用**（404 的 HEAD 会吃掉连接池）', async () => {
      heads.length = 0; status = 404
      const { pw, traces } = mk()
      pw('boot'); await sleep(150)
      assert.equal(traces.find((t) => t.tag === 'prewarm-bad-status').data.action, 'prewarm-disabled')
      status = 200
      pw('later'); await sleep(100)
      assert.equal(heads.length, 1, '停用后不再发任何预热')
    })
    await test('§3c v11.11：传入本次调用的配置 ⇒ 预热跟随这次调用的 provider（不读共享 cfg）', async () => {
      heads.length = 0
      const { pw } = mk()
      pw('block-start', { baseUrl: base + '/v1', followProvider: 'other', settingsPath })
      await sleep(150)
      assert.equal(heads.length, 1); assert.equal(heads[0].other, true)
    })
    await test('§3d prewarm:false / 模式不适用 / 解析不出端点 ⇒ 一律不预热', async () => {
      heads.length = 0
      mk({ prewarm: false }).pw('x'); mk({ mode: 'off' }).pw('x'); mk({ baseUrl: '' }).pw('x')
      await sleep(100)
      assert.equal(heads.length, 0)
    })
    await test('§3e 端点连不上 ⇒ prewarm-failed，绝不抛', async () => {
      const { pw, traces } = mk({ baseUrl: 'http://127.0.0.1:1/v1' })
      pw('x'); await sleep(200)
      assert.ok(traces.some((t) => t.tag === 'prewarm-failed'))
    })
  } finally {
    server.closeAllConnections(); other.closeAllConnections()
    await new Promise((r) => server.close(r)); await new Promise((r) => other.close(r))
  }

  // ═══ §5 tokens.js 非字符串输入 ═════════════════════════════════════════════
  await test('§5 token 估算对非字符串输入不抛：null/undefined ⇒ 0；数字按 String 处理；wideShare 非串 ⇒ 0', () => {
    assert.equal(estimateTokens(null), 0); assert.equal(estimateTokens(undefined), 0)
    assert.equal(estimateTokens(12345), Math.ceil(5 * 0.3))
    assert.equal(wideShare(123), 0); assert.equal(wideShare(''), 0); assert.equal(wideShare('中a'), 0.5)
    assert.deepEqual(scriptCounts(null), { wide: 0, other: 0 }); assert.deepEqual(scriptCounts(42), { wide: 0, other: 2 })
    assert.deepEqual(scriptCounts('中文ab'), { wide: 2, other: 2 })
  })
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
