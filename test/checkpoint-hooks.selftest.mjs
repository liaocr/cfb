// ★★ checkpoint 模式的**钩子级端到端**测试（2026-09-24）★★
//
// 为什么要单开一套：`plugin.js` 的 checkpoint 分支此前只有「纯函数层」覆盖（emitter.selftest 直接调
// runPreStepEmit），**没有一条从钩子入口出发的端到端测试** —— 也就是说这些接线没有被任何测试钉住：
//   · llm/stream 里 early-fire 的触发时机与键（raw 必须与 host 装配出的 reasoning 逐字相同）；
//   · agent/pre-step 里 session 捕获、cmbStore 服务获取、sessionId 同源；
//   · 结果如何从「伴生提纯」流到「合规发射」，以及每一步失败时的 no-op 语义。
// 本套件用**真实 HTTP**（本地夹具服务）+ 真实钩子入口把整条链跑通，判据全部落在这几条硬约束上：
//   ① 工具配对平衡（替换区间绝不切断 tool-call ↔ tool/result）；
//   ② 活跃尾部永不被遮蔽（否则模型看不到自己刚说的话 ⇒ 无限重答）；
//   ③ 真人原话与工具原文都不许凭空消失；
//   ④ 评估态零副作用（不写 CAS、不改表面）；
//   ⑤ 形状不认识 / 句柄读不回 ⇒ 拒发且原文逐字保留。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import * as I from '../index.js'
import { toolTextFromEvent } from '../src/emitter.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cp-hooks-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = home
const credentialsPath = path.join(home, 'keys'); fs.writeFileSync(credentialsPath, 'LOCAL: unused\n')

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
const SUMMARY = '【已定决策】压缩完成：本轮核验通过，未部署。\n【未决差距】缺少第二组参数核验。'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 本地伴生端点（真实 HTTP；SSE 形状与线上一致）────────────────────────────
function sse(res, text = SUMMARY) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n')
}
async function withServer(fn, handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (x) => { body += x })
    req.on('end', () => {
      try { requests.push(JSON.parse(body)) } catch { requests.push(null) }
      ;(handler || ((q, r) => sse(r)))(req, res, requests.length)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { await fn({ baseUrl: 'http://127.0.0.1:' + server.address().port, requests }) }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
}

// ── 假 CAS：既能按句柄**读回**，又记录每一次写入 ──────────────────────────────
//   ⚠ 句柄按 dshb-store 同式派生（HMAC-SHA256(sessionId, sha256(text))），
//     所以「跨 session 读不回」这条真机约束在本夹具里同样成立。
function mkStore({ owner = null, readable = true } = {}) {
  const texts = new Map(), writes = [], reads = []
  return {
    writes, reads,
    async putText(text, opts = {}) {
      writes.push({ text, opts })
      const h = 'art://' + crypto.createHmac('sha256', String(opts.sessionId || '')).update(sha(text)).digest('base64url').slice(0, 22)
      // owner = 记录上的归属会话（写的身份是 A、读的身份是 B ⇒ 所有权不符，真机是 resolve-owner-mismatch）
      texts.set(h, { text, sessionId: owner == null ? opts.sessionId : owner })
      return { handle: h, sha256: sha(text) }
    },
    async readRangeByHandle(handle, sid, start = 1, count = 1) {
      reads.push({ handle, sid })
      const rec = texts.get(handle)
      if (!rec || String(rec.sessionId || '') !== String(sid == null ? '' : sid)) return { lines: [], atEof: true }
      if (!readable) return { lines: [], atEof: true }
      const all = rec.text.split('\n')
      const lines = all.slice(Math.max(0, start - 1), Math.max(0, start - 1) + count)
      return { lines, atEof: start - 1 + lines.length >= all.length }
    },
  }
}

// ── 会话夹具（surface 即真机读取面：nodes + eventAt + append）───────────────
function mkSession({ events, id = 'sess-cp' }) {
  const map = new Map(events.map((e) => [e.seq, e]))
  const calls = []
  return {
    id, surface: { nodes: events.map((e) => e.seq) },
    eventAt: (s) => map.get(s),
    requestContext: () => ({ contextWindow: 262144 }),
    append(type, data, meta) { calls.push({ type, data, meta }); return { seq: 9000 + calls.length } },
    __calls: calls,
  }
}
const mkUser = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
const mkAssistant = (seq, { reasoning, calls = [] }) => ({
  seq, type: 'assistant/message',
  data: { message: { role: 'assistant', content: [
    ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
    ...calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, args: c.args })),
    ...(calls.length === 0 ? [{ type: 'text', text: '（回答）' }] : []),
  ] } },
})
const mkToolResult = (seq, text, opts = {}) => ({
  seq, type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: opts.id || 'call_1', isError: !!opts.isError, content: [{ type: 'text', text }] }] } },
})
const LONG_LINES = (n, tag) => Array.from({ length: n }, (_, i) => tag + ' line ' + i + ' ' + 'y'.repeat(20)).join('\n')   // ~26K

// ── 走真实 llm/stream 钩子触发 early-fire ────────────────────────────────────
async function driveEarlyFire(hooks, raw) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: raw },
    { type: 'block-start', index: 1, blockType: 'tool-call' },   // ← 触发 maybeFire
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'bash' },
  ]
  const out = []
  for await (const c of hooks.get('llm/stream')({ model: 'fixture', provider: 'p', messages: [] }, () => (async function* () { for (const c of chunks) yield c })())) out.push(c)
  return out
}
const readTrace = (f) => (fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { const m = l.match(/^\[[^\]]+\] \[([^\]]+)\] (.*)$/); return m ? [m[1], JSON.parse(m[2])] : null } catch { return null }
  }).filter(Boolean)
  : [])
async function waitTrace(traceFile, tag, tries = 300) {
  for (let i = 0; i < tries; i++) { if (readTrace(traceFile).some(([t]) => t === tag)) return true; await sleep(10) }
  return false
}

// ── 组装：apply 一次，返回钩子表 ─────────────────────────────────────────────
function applyPlugin({ store, baseUrl, over = {}, traceFile }) {
  const hooks = new Map()
  const ctx = { on: (n, fn) => hooks.set(n, fn), get: (k) => (k === 'cmbStore' ? store : null) }
  const config = {
    ...I.DEFAULTS, enabled: true, dryRun: false, mode: 'checkpoint',
    model: 'fixture', followHostModel: false, followHostProvider: false, credentialRef: 'LOCAL', credentialsPath,
    baseUrl, keepAlive: false, minRawChars: 800, graceMs: 1500, timeoutMs: 8000,
    trace: true, traceFile: traceFile || path.join(home, 'trace-' + Math.random().toString(36).slice(2) + '.log'),
    ...over,
  }
  I.apply(ctx, config)
  return { hooks, config }
}
const cpEvents = (RAW, toolText) => [
  mkUser(1, '只核验，不部署。'),
  mkAssistant(2, { reasoning: RAW, calls: [{ id: 'call_1', name: 'bash', args: { cmd: 'run tests' } }] }),
  mkToolResult(3, toolText),
  mkUser(4, '继续'),
  mkAssistant(5, { reasoning: '尾部推理', calls: [] }),
]

try {
  // ══ 1. 全链路：early-fire → pre-step 收网 → 合规 replace 发射 ══════════════
  await test('1. 全链路：early-fire → pre-step 收网 → 合规 replace 发射', async () => {
    const RAW = '推理正文：' + '检查模块 alpha 的五个校验步骤。'.repeat(60)
    const TOOL_LONG = LONG_LINES(900, 'tool')
    await withServer(async ({ baseUrl, requests }) => {
      const store = mkStore()
      const traceFile = path.join(home, 'trace-full.log')
      const { hooks } = applyPlugin({ store, baseUrl, traceFile })
      const events = cpEvents(RAW, TOOL_LONG)
      const session = mkSession({ events })

      await driveEarlyFire(hooks, RAW)
      assert.equal(await waitTrace(traceFile, 'early-ready'), true, '伴生提纯应在夹具时限内就绪')
      assert.equal(readTrace(traceFile).filter(([t]) => t === 'early-trigger').length, 1, 'early-fire 应恰好触发一次')
      assert.ok(requests.length >= 1, 'llm/stream 触发的提前调用应真的打到端点')

      const decision = await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({ marker: 'host-decision' }))
      assert.deepEqual(decision, { marker: 'host-decision' }, 'pre-step 必须原样把宿主的 decision 传下去')

      const emits = session.__calls.filter((c) => c.type === 'user/message')
      assert.equal(emits.length, 1, '应恰好发射一条检查点')
      const e = emits[0]
      // ① 合规形状（逐字对齐官方 dsh-compaction-basic）
      assert.equal(e.meta.surfaceOp.op, 'replace')
      assert.equal(e.data.source.kind, 'plugin', 'source.kind 绝不能是 user —— 否则看板会被当成真人发言')
      assert.equal(e.data.source.plugin, 'cot-form-b')
      assert.equal(Array.isArray(e.meta.sourceEventSeqs), true)
      // 遮蔽集合必须与替换区间逐字对应（official 契约：sourceEventSeqs 必须等于表面切片）
      assert.deepEqual(e.meta.sourceEventSeqs, [e.meta.surfaceOp.startSeq, e.meta.surfaceOp.endSeq])
      // ⚠ `shadowed` 只出现在 trace 的 meta 里（emitCheckpoint 的返回），**不在** append 的 meta 里
      assert.equal(e.meta.shadowed, undefined)
      // ② 工具配对平衡：区间必须同时覆盖 tool-call(2) 与 tool/result(3)
      assert.equal(e.meta.surfaceOp.startSeq, 2, '左端只能是目标 assistant')
      assert.equal(e.meta.surfaceOp.endSeq, 3, '右端必须把配对的 tool/result 一起吞进来，且不得越过真人 user')
      // ③ 活跃尾部永不被遮蔽
      assert.ok(e.meta.surfaceOp.endSeq < 5, '最后一条 assistant 绝不能被写进替换区间')
      // ④ 真人原话与工具原文都不许消失
      const text = e.data.content[0].text
      assert.ok(!text.includes(TOOL_LONG), '26K 工具原文不应整块进视图')
      assert.equal(events[0].data.content[0].text, '只核验，不部署。', '区间外的真人原话必须逐字保留')
      assert.equal(events[3].data.content[0].text, '继续')
      assert.ok(e.meta.surfaceOp.startSeq > 1, '真人回合不可逾越：替换区间绝不吞掉真人 user')
      // ⑤ 归档行带工具名 + 参数 + 样本（P1 可检索化）
      assert.ok(text.includes('原文 art://'), '长工具结果应留句柄：' + text.slice(0, 300))
      assert.ok(text.includes('↳ 工具 bash'), '归档行应带工具名（P1）')
      assert.ok(text.includes('run tests'), '归档行应带调用参数摘要（P1）')
      assert.ok(text.includes('↳ 样本'), '归档行应带内容样本（P1）')
      // ⑥ 读回闭环：文本里的句柄必须真的能读回原文
      const handle = 'art://' + text.split('原文 art://')[1].slice(0, 22)
      assert.equal(store.writes.length, 1, '长工具结果应恰好归档一次')
      assert.equal(store.writes[0].text, TOOL_LONG, '归档的必须是**原文**（清洗只作用于内联视图）')
      assert.equal(store.writes[0].opts.sessionId, 'sess-cp', '归档与读回必须同源 sessionId')
      assert.equal(store.writes[0].opts.retention, 'session')
      const back = await store.readRangeByHandle(handle, 'sess-cp', 1, 400)
      assert.ok(back.lines.length > 0, '文本里的句柄必须能按同 session 读回')
      assert.equal(back.lines[0], TOOL_LONG.split('\n')[0])
      // ⑦ trace 证据链完整
      const tags = readTrace(traceFile).map(([t]) => t)
      for (const t of ['early-trigger', 'early-ready', 'checkpoint-emitted', 'ledger-built', 'ledger-archive-commit', 'emit-handle-verify'])
        assert.ok(tags.includes(t), 'trace 缺 ' + t)
      const verify = readTrace(traceFile).find(([t]) => t === 'emit-handle-verify')
      assert.equal(verify[1].verdict, 'resolved', '读回验证必须留下正面证据')
      // ⑧ 看板范式：自带引言与边界，模型能分辨「插件记忆」与「用户新指令」
      assert.ok(text.includes('[自动生成的工作记忆看板 · 非用户发言]'), '看板必须自带署名/引言')
      assert.ok(text.includes('<cot-ledger>') && text.includes('</cot-ledger>'), '看板必须有显式边界标记')
    })
  })

  // ══ 2. 跨 session 句柄读不回 ⇒ 拒发（P0-2 的真机约束）══════════════════════
  await test('2. 跨 session 句柄读不回 ⇒ 拒发（写成功 ≠ 读得回）', async () => {
    const RAW = '推理正文：' + '交叉核对编号与数值。'.repeat(80)
    await withServer(async ({ baseUrl }) => {
      const store = mkStore({ owner: 'sess-OTHER' })   // 记录归属会话 A；读取方是会话 B
      const traceFile = path.join(home, 'trace-xsession.log')
      const { hooks } = applyPlugin({ store, baseUrl, traceFile })
      const events = cpEvents(RAW, LONG_LINES(900, 'zz'))
      const session = mkSession({ events, id: 'sess-cp' })
      await driveEarlyFire(hooks, RAW)
      assert.equal(await waitTrace(traceFile, 'early-ready'), true)
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      assert.equal(session.__calls.filter((c) => c.type === 'user/message').length, 0, '句柄读不回时绝不发射（否则模型拿到死指针）')
      const skip = readTrace(traceFile).find(([t]) => t === 'checkpoint-skip')
      assert.equal(skip && skip[1].reason, 'handle-unresolvable')
      const verify = readTrace(traceFile).find(([t]) => t === 'emit-handle-verify')
      assert.equal(verify && verify[1].verdict, 'unresolvable')
      assert.ok(store.writes.length >= 1, '写入本身是成功的 —— 这正是「写成功 ≠ 读得回」')
      assert.equal(events[1].data.message.content[0].text, RAW, '拒发时原文逐字保留')
    })
  })

  // ══ 3. 评估态（dryRun）零副作用 ═══════════════════════════════════════════
  await test('3. 评估态零副作用：不写 CAS、不改表面，仍出净收益与真 token 锚点', async () => {
    const RAW = '推理正文：' + '评估态只观测。'.repeat(120)
    await withServer(async ({ baseUrl, requests }) => {
      const store = mkStore()
      const traceFile = path.join(home, 'trace-dry.log')
      const { hooks } = applyPlugin({ store, baseUrl, traceFile, over: { dryRun: true } })
      const events = cpEvents(RAW, LONG_LINES(900, 'w'))
      const session = mkSession({ events })
      await driveEarlyFire(hooks, RAW)
      assert.equal(await waitTrace(traceFile, 'early-ready'), true)
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      assert.equal(session.__calls.length, 0, '评估态绝不改表面')
      assert.equal(store.writes.length, 0, '评估态绝不写 CAS（P0-1 的核心）')
      assert.equal(store.reads.length, 0, '评估态连读回验证也不做（没有待验证的写入）')
      // ⚠ checkpoint 的评估态**仍然发起一次提纯**（既有行为；birth 评估态是零调用）。
      //   本用例只钉住「不写 CAS、不改表面」，不改变这条既有权衡。
      assert.equal(requests.length, 1, '评估态仍发起一次提纯（既有行为，已知代价）')
      const tags = readTrace(traceFile)
      const sim = tags.find(([t]) => t === 'emit-archive-simulated')
      assert.ok(sim && sim[1].pending === 1, '待写量仍可观测')
      const skip = tags.find(([t]) => t === 'checkpoint-skip')
      assert.equal(skip && skip[1].reason, 'dry-run')
      const ns = tags.find(([t]) => t === 'emit-net-savings')
      assert.ok(ns && ns[1].netSavedChars > 0 && ns[1].archiveMode === 'simulated', '评估态仍算出净收益')
      assert.equal(ns[1].casWrites, undefined)
      const res = tags.find(([t]) => t === 'emit-net-savings-result')
      assert.equal(res[1].casWrites, 0)
      assert.equal(res[1].archiveSimulated, true)
    })
  })

  // ══ 4. 形状不认识 ⇒ 拒发，且原文逐字保留 ══════════════════════════════════
  await test('4. 工具结果形状不认识 ⇒ 整块拒发（绝不静默丢内容）', async () => {
    const RAW = '推理正文：' + '未知工具结果形状。'.repeat(100)
    await withServer(async ({ baseUrl }) => {
      const store = mkStore()
      const traceFile = path.join(home, 'trace-shape.log')
      const { hooks } = applyPlugin({ store, baseUrl, traceFile })
      const bad = { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'image', source: 'x' }] }] } } }
      const events = [mkUser(1, 'u'), mkAssistant(2, { reasoning: RAW, calls: [{ id: 'call_1', name: 'read', args: {} }] }), bad,
        mkUser(4, 'u2'), mkAssistant(5, { reasoning: 'tail', calls: [] })]
      const session = mkSession({ events })
      await driveEarlyFire(hooks, RAW)
      await waitTrace(traceFile, 'early-ready')
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      assert.equal(session.__calls.length, 0, '读不出的工具结果 ⇒ 整块拒发')
      assert.equal(store.writes.length, 0, '拒发路径零 CAS 写入（P0-1）')
      const skip = readTrace(traceFile).find(([t]) => t === 'checkpoint-skip')
      assert.equal(skip && skip[1].reason, 'tool-result-unreadable')
      assert.equal(toolTextFromEvent(bad), null)
      assert.equal(events[1].data.message.content[0].text, RAW)
    })
  })

  // ══ 5. 没有可用 CAS 服务 ⇒ 拒发（铁律：先归档后压缩）═══════════════════════
  await test('5. 没有 CAS 服务 ⇒ 绝不替换原文（铁律：先归档后压缩）', async () => {
    const RAW = '推理正文：' + '没有 CAS 就不许替换。'.repeat(100)
    await withServer(async ({ baseUrl }) => {
      const traceFile = path.join(home, 'trace-nostore.log')
      const { hooks } = applyPlugin({ store: null, baseUrl, traceFile })
      const events = cpEvents(RAW, LONG_LINES(900, 'x'))
      const session = mkSession({ events })
      await driveEarlyFire(hooks, RAW)
      await waitTrace(traceFile, 'early-ready')
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      assert.equal(session.__calls.length, 0, '拿不到句柄 ⇒ 绝不替换原文')
      const skip = readTrace(traceFile).find(([t]) => t === 'checkpoint-skip')
      assert.ok(['no-net-savings-after-archive', 'no-net-savings', 'handle-unresolvable'].includes(skip && skip[1].reason),
        '原因应为归档失败导致的净收益不足：' + JSON.stringify(skip))
      assert.equal(events[1].data.message.content[0].text, RAW)
    })
  })

  // ══ 6. 钩子级健壮性：宿主 decision 原样透传 / 非 iterable 不包装 ════════════
  await test('6. 钩子健壮性：decision 原样透传、坏形状不包装、mode=off 不介入', async () => {
    await withServer(async ({ baseUrl }) => {
      const { hooks } = applyPlugin({ store: mkStore(), baseUrl })
      const d = { keep: true }
      assert.deepEqual(await hooks.get('agent/pre-step')({}, async () => d), d, '无 payload ⇒ 原样透传，不抛')
      assert.deepEqual(await hooks.get('agent/pre-step')({ agent: {} }, async () => d), d)
      assert.deepEqual(await hooks.get('agent/pre-step')({ agent: { session: null } }, async () => d), d)
      const plain = [{ type: 'x' }]
      assert.equal(hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => plain), plain, '不是 async iterable ⇒ 原样返回')
      assert.equal(hooks.get('llm/stream')({ model: 'fixture', messages: [] }, () => null), null)
    })
    await withServer(async ({ baseUrl }) => {
      const { hooks } = applyPlugin({ store: mkStore(), baseUrl, over: { mode: 'off' } })
      const d = { keep: 2 }
      assert.deepEqual(await hooks.get('agent/pre-step')({ agent: { session: mkSession({ events: [mkUser(1, 'u')] }) } }, async () => d), d)
    })
  })

  // ══ 7. 伴生提纯终局失败 ⇒ 不发射、不改写（原文放行）═══════════════════════
  await test('7. 伴生提纯终局失败 ⇒ 不发射、原文逐字不变', async () => {
    const RAW = '推理正文：' + '伴生失败也必须放行原文。'.repeat(80)
    await withServer(async ({ baseUrl }) => {
      const store = mkStore()
      const traceFile = path.join(home, 'trace-fail.log')
      const { hooks } = applyPlugin({ store, baseUrl, traceFile })
      const events = cpEvents(RAW, 'small output')
      const session = mkSession({ events })
      await driveEarlyFire(hooks, RAW)
      assert.equal(await waitTrace(traceFile, 'early-failed'), true, '端点 500 ⇒ 应落 early-failed')
      await hooks.get('agent/pre-step')({ agent: { session } }, async () => ({}))
      assert.equal(session.__calls.length, 0, '提纯失败 ⇒ 不发射')
      assert.equal(events[1].data.message.content[0].text, RAW, '表面上的推理原文必须逐字保留')
    }, (q, r) => { r.writeHead(500); r.end('boom') })
  })
} finally {
  if (previous == null) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
