// ★★ v11.11 分支覆盖补齐：此前没有任何测试走到的分支 ★★
//
//   §1 evidence.js：跨窗口结构性上下文（stateStructuralFirst，opt-in 但会随包发布）的逐类上限、
//      新者优先、时间序、窗口内不重取；索引构建抛错 ⇒ 回退扫描（v11.11 前该分支不可达，索引一抛整个采集就抛）
//   §2 filterCoveredTools 的四种判据形态
//   §3 预热：200 / 节流 / 非 2xx 永久停用 / 跟随「本次调用」的 provider / 解析不出就不预热
//   §4 消费计量：相同文本不归属、超大文本不入账、嵌套内容可识别
// 全部零外网（本机 HTTP）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createConsumptionMeter } from '../src/consumption.js'
import { collectEvidence, filterCoveredTools, COVER_TAIL_FLOOR } from '../src/evidence.js'
import { clearProviderCache } from '../src/provider.js'
import { makePrewarmer } from '../src/transport.js'
import { estimateTokens, wideShare, scriptCounts } from '../src/tokens.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-branches-'))
let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 合成会话：seq 1..N；前段散布用户原话 / 看板 / 运行时抬头，后段是普通工具往返 ──
function mkSession(n, special, { nodes } = {}) {
  const ev = new Map()
  for (let seq = 1; seq <= n; seq++) {
    const sp = special[seq]
    if (sp === 'user') ev.set(seq, { type: 'user/message', data: { origin: 'user', message: { content: [{ type: 'text', text: '用户要求 #' + seq }] } } })
    else if (sp === 'ledger') ev.set(seq, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '<cot-ledger> 看板 #' + seq + ' </cot-ledger>' }] } } })
    else if (sp === 'runtime') ev.set(seq, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Current runtime context. #' + seq }] } } })
    else if (seq % 2) ev.set(seq, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c' + seq, name: 'bash', args: {} }] } } })
    else ev.set(seq, { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c' + (seq - 1), content: 'out ' + seq }] } } })
  }
  return { id: 's', surface: { nodes: nodes || [...ev.keys()] }, eventAt: (s) => ev.get(s) || null }
}
const SPECIAL = { 2: 'user', 4: 'user', 6: 'ledger', 8: 'runtime', 10: 'user', 12: 'ledger', 14: 'runtime',
  16: 'user', 18: 'user', 20: 'user', 22: 'user', 24: 'user' }

try {
  // ═══ §1 evidence ═══════════════════════════════════════════════════════════
  await test('§1a structural 关（缺省）⇒ 只取窗口，不跨窗口取回', () => {
    const r = collectEvidence(mkSession(100, SPECIAL), { limit: 20 })
    assert.equal(r.structuralFetched, 0)
    assert.ok(r.events.every((e) => e.seq > 80))
    assert.equal(r.coverage.omittedEvidence, true)
  })
  await test('§1b structural 开 ⇒ 逐类上限（看板 1、运行时 1、用户 6）、新者优先、恢复时间序', () => {
    const r = collectEvidence(mkSession(100, SPECIAL), { limit: 20, structural: true })
    const kinds = r.structuralSeqs.map((s) => SPECIAL[s])
    assert.equal(kinds.filter((k) => k === 'ledger').length, 1)
    assert.equal(kinds.filter((k) => k === 'runtime').length, 1)
    assert.equal(kinds.filter((k) => k === 'user').length, 6)
    assert.ok(r.structuralSeqs.includes(12) && !r.structuralSeqs.includes(6), '看板只取最新一份')
    assert.ok(r.structuralSeqs.includes(14) && !r.structuralSeqs.includes(8), '运行时抬头只取最新一条')
    assert.ok(!r.structuralSeqs.includes(2) && r.structuralSeqs.includes(24), '用户原话取最新 6 条')
    assert.deepEqual(r.structuralSeqs, [...r.structuralSeqs].sort((a, b) => a - b), '时间序')
  })
  await test('§1c structuralLimit 封顶总数；0 = 关；窗口内的结构性节点不重复取', () => {
    assert.equal(collectEvidence(mkSession(100, SPECIAL), { limit: 20, structural: true, structuralLimit: 3 }).structuralFetched, 3)
    assert.equal(collectEvidence(mkSession(100, SPECIAL), { limit: 20, structural: true, structuralLimit: 0 }).structuralFetched, 0)
    const r = collectEvidence(mkSession(30, SPECIAL), { limit: 20, structural: true })
    assert.ok(r.structuralSeqs.every((s) => s <= 10), '只从窗口之外取')
    assert.equal(new Set(r.events.map((e) => e.seq)).size, r.events.length, '按 seq 去重')
  })
  await test('§1d 索引构建抛错（节点含不可序列化值）⇒ 回退扫描，不抛；structural 开时扫全部节点', () => {
    const s = mkSession(60, SPECIAL)
    s.surface.nodes = [...s.surface.nodes, 10n]      // BigInt ⇒ JSON.stringify 抛 ⇒ evidenceIndex 抛
    const off = collectEvidence(s, { limit: 20 })
    assert.ok(off.events.length > 0, '回退扫描窗口')
    assert.equal(off.structuralFetched, 0)
    const on = collectEvidence(s, { limit: 20, structural: true })
    assert.ok(on.structuralFetched > 0, '回退扫描也能跨窗口')
  })
  await test('§1e eventAt 抛错 / 返回空 ⇒ 跳过该节点；无会话 / 无节点 ⇒ 空证据', () => {
    const s = mkSession(10, {})
    s.eventAt = (seq) => { if (seq === 3) throw new Error('boom'); return seq === 4 ? null : mkSession(10, {}).eventAt(seq) }
    const r = collectEvidence(s, {})
    assert.ok(!r.events.some((e) => e.seq === 3 || e.seq === 4))
    assert.deepEqual(collectEvidence(null).events, [])
    assert.deepEqual(collectEvidence({ surface: { nodes: [] } }).events, [])
    assert.deepEqual(collectEvidence({ get surface() { throw new Error('x') } }).events, [])
  })

  // ═══ §2 filterCoveredTools ═════════════════════════════════════════════════
  const tools = Array.from({ length: 12 }, (_, i) => ({ resultSeq: i + 1, result: 'r'.repeat(10) }))
  await test('§2a Set / Array（字符串 seq 也认）/ number 水位线三种判据等价；尾部保底永不丢', () => {
    const a = filterCoveredTools(tools, new Set([1, 2, 3, 11]))
    const b = filterCoveredTools(tools, ['1', '2', '3', '11'])
    assert.equal(a.info.dropped, 3); assert.deepEqual(a.info, b.info)
    assert.ok(a.tools.some((t) => t.resultSeq === 11), '尾部 COVER_TAIL_FLOOR 条不省略')
    const c = filterCoveredTools(tools, 3)
    assert.equal(c.info.dropped, 3); assert.equal(c.info.savedChars, 30)
    assert.equal(COVER_TAIL_FLOOR, 8)
  })
  await test('§2b 非法判据 / 条数不超过保底 / 无命中 ⇒ 原样返回、info=null', () => {
    assert.equal(filterCoveredTools(tools, 'nope').info, null)
    assert.equal(filterCoveredTools(tools, NaN).info, null)
    assert.equal(filterCoveredTools(tools.slice(0, 8), new Set([1])).info, null)
    assert.equal(filterCoveredTools(tools, new Set([999])).info, null)
    assert.deepEqual(filterCoveredTools(null, new Set([1])).tools, [])
  })

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

  // ═══ §4 消费计量 ═══════════════════════════════════════════════════════════
  await test('§4 消费计量：嵌套内容可识别；两个任务同文 ⇒ 不归属；超大文本不入账；无条目时零开销', () => {
    const traces = []
    const m = createConsumptionMeter((tag, data) => traces.push({ tag, data }))
    m.observe({ messages: [{ content: 'x' }] })          // 无条目 ⇒ 直接返回
    m.applied('t1', '【摘要】独有文本')
    m.applied('t2', '【摘要】重复'); m.applied('t3', '【摘要】重复')
    m.applied('t4', 'x'.repeat(300 * 1024))
    m.applied('', 'ignored'); m.applied('t5', '')
    m.observe({ messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: '前缀【摘要】独有文本后缀' }, { type: 'text', content: [{ text: '【摘要】重复' }] }] }] })
    const hits = traces.filter((t) => t.tag === 'memory-presented-in-options').map((t) => t.data.taskId)
    assert.deepEqual(hits, ['t1'])
    assert.equal(traces[0].data.billedTokens, null, '明确不是账单')
    m.observe({ get messages() { throw new Error('boom') } })   // 观察失败绝不抛
  })
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
