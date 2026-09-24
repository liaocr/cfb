import { toolTextFromEvent, runPreStepEmit, emitCheckpoint, buildLedger, readPressure, LEDGER_OPEN, LEDGER_CLOSE, LEDGER_PREAMBLE,
  usableHandle, commitLedgerPlan, verifyHandles, HANDLE_PLACEHOLDER, HANDLE_CHARS,
  toolResultMetaFromEvent, toolCallsFromSpan, flattenCarriedBoard, errorExcerpt, classifyToolResult, excerptText, oneLine, argsSummary } from '../src/emitter.js'

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++ } else { fail++; console.log('  ✗ ' + n) } }
const eq = (n, g, w) => { if (g === w) { pass++ } else { fail++; console.log('  ✗ ' + n + '  got=' + JSON.stringify(g) + ' want=' + JSON.stringify(w)) } }

// ── 构造器 ─────────────────────────────────────────────────
const mkUser = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
const mkA = (seq, reasoning, k = 0) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content:
  [{ type: 'reasoning', text: reasoning }, ...Array.from({ length: k }, (_, i) => ({ type: 'tool-call', id: 'c' + i }))] } } })
const mkR = (seq, text) => ({ seq, type: 'tool/result', data: { content: [{ type: 'text', text }] } })

const rawOf = (ev) => ev && ev.data && ev.data.message
  ? ev.data.message.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('') : null
const toolTextOf = (ev) => ev && ev.data && ev.data.content ? ev.data.content.map((b) => b.text || '').join('') : null

function fakeSession({ events, contextWindow = 262144, meter, appendImpl, noSurface }) {
  const map = new Map(events.map((e) => [e.seq, e]))
  const calls = []
  return {
    id: 'sess-1',
    surface: noSurface ? undefined : { nodes: events.map((e) => e.seq) },
    eventAt: (s) => map.get(s),
    requestContext: () => ({ contextWindow }),
    append(type, data, meta) {
      calls.push({ type, data, meta })
      if (appendImpl) return appendImpl(type, data, meta, calls.length)
      return { seq: 9000 + calls.length }
    },
    __calls: calls,
  }
}
const mkCtx = (meter) => ({ get: (k) => (k === 'tokenMeter' ? (meter || null) : null) })
const R = 'x'.repeat(4000)

// ══ A. readPressure ═══════════════════════════════════════
{
  const ev = [mkUser(1, 'hi')]
  const m = { measure: () => ({ usedTokens: 1234 }) }
  const p = readPressure({ session: fakeSession({ events: ev }), ctx: mkCtx(m), surfaceChars: 9999 })
  eq('meter 可用 → source=meter', p.source, 'meter')
  eq('meter 可用 → usedTokens 取自 meter', p.usedTokens, 1234)
  eq('contextWindow 可读', p.contextWindow, 262144)
}
{
  const m = { measure: () => { throw new Error('boom') } }
  const p = readPressure({ session: fakeSession({ events: [mkUser(1, 'hi')] }), ctx: mkCtx(m), surfaceChars: 400 })
  eq('meter 抛错 → 降级 estimated', p.source, 'estimated')
  eq('estimated = ceil(chars/4)', p.usedTokens, 100)
}
{
  const p = readPressure({ session: fakeSession({ events: [], contextWindow: null }), ctx: mkCtx(null), surfaceChars: 400 })
  eq('窗口不可读 → source=none', p.source, 'none')
  eq('窗口不可读 → usedTokens undefined', p.usedTokens, undefined)
}

// ══ B. buildLedger（D2′ 混合）══════════════════════════════
await (async () => {
  const seen = []
  const archive = async (text, info) => { seen.push(info.chars); return 'art://TL' + info.seq }
  const L = await buildLedger({ distilled: '【已定决策】压缩完成', toolResults: [
    { seq: 11, text: 'short result' },
    { seq: 12, text: R },
  ], maxInlineChars: 100, archive })
  ok('短结果内联', L.text.includes('short result'))
  ok('长结果留句柄', L.text.includes('art://TL12'))
  ok('长结果不进正文', !L.text.includes(R))
  eq('内联计数', L.inlined, 1)
  eq('归档计数', L.archived, 1)
  eq('归档拿到真实长度', seen[0], 4000)
  ok('提纯稿保留', L.text.includes('【已定决策】压缩完成'))
  // 归档失败 ⇒ 必须内联，绝不丢
  const L2 = await buildLedger({ distilled: 'D', toolResults: [{ seq: 3, text: R }], maxInlineChars: 10, archive: async () => null })
  ok('归档失败 → 原文内联（信息不丢）', L2.text.includes(R))
  eq('归档失败计数', L2.archiveFailed, 1)
  const L3 = await buildLedger({ distilled: 'D', toolResults: [{ seq: 4, text: R }], maxInlineChars: 10, archive: async () => { throw new Error('disk') } })
  ok('归档抛错 → 原文内联', L3.text.includes(R))
})()

// ══ B2. 证据边界：CAS 留原文，只有视图才清洗（2026-09-22 评审第 5 点）══
await (async () => {
  const ESC = String.fromCharCode(27)
  const rawDirty = ESC + '[31m' + 'ERROR boom' + ESC + '[0m   '
  const archived = []
  const archive = async (text) => { archived.push(text); return 'art://RAW' }

  // ① 短正文 ⇒ 内联：视图清洗，归档不被调用
  const S = await buildLedger({ distilled: 'D', toolResults: [{ seq: 1, text: rawDirty }], maxInlineChars: 1000, archive })
  ok('★ 内联视图已清洗（ANSI 消失）', S.text.indexOf(ESC) < 0, JSON.stringify(S.text))
  ok('★ 内联视图保留语义正文', S.text.indexOf('ERROR boom') >= 0)
  eq('短正文不触发归档', archived.length, 0)

  // ② 长正文 ⇒ 归档：归档必须拿【原文】（字节保真）
  const longDirty = ESC + '[33m' + 'y'.repeat(3000) + ESC + '[0m'
  const A = await buildLedger({ distilled: 'D', toolResults: [{ seq: 2, text: longDirty }], maxInlineChars: 100, archive })
  eq('长正文触发归档', archived.length, 1)
  ok('★★ 归档拿到的是原文（含 ANSI）', archived[0].indexOf(ESC) >= 0, 'raw kept')
  eq('★★ 归档长度 = 原始长度（未被清洗）', archived[0].length, longDirty.length)
  ok('长正文只留句柄，正文不进视图', A.text.indexOf('art://RAW') >= 0)

  // ③ 归档失败 ⇒ 原文内联（信息不丢铁律），但仍走视图清洗
  const F = await buildLedger({ distilled: 'D', toolResults: [{ seq: 3, text: rawDirty }], maxInlineChars: 5, archive: async () => null })
  ok('归档失败仍内联且已清洗', F.text.indexOf(ESC) < 0 && F.text.indexOf('ERROR boom') >= 0)
  eq('归档失败计数', F.archiveFailed, 1)

  // ④ cleanView:false ⇒ 关闭视图清洗（字节保真通道）
  const N2 = await buildLedger({ distilled: 'D', toolResults: [{ seq: 4, text: rawDirty }], maxInlineChars: 1000, archive, cleanView: false })
  ok('★ cleanView:false ⇒ 视图也保留原文', N2.text.indexOf(ESC) >= 0)
})()

// ══ C. emitCheckpoint（合规发射）══════════════════════════
// ★ 2026-09-17 路线 A：活跃尾部保护（keepTail 缺省 1）⇒ 夹具必须有 ≥2 步；
//   否则"唯一的 assistant 就是活跃尾部"会一律被拒（这正是我们要的行为）。
const baseEvents = () => [mkUser(1, 'do it'), mkA(2, 't'.repeat(900), 1), mkR(3, 'tool output'),
  mkUser(4, 'again'), mkA(5, 'u'.repeat(300), 0)]
const spanOf = (events) => {
  // ★ 夹具用 data.message.content 表达 tool-call（生产真实形状），不是 toolCallCount 字段
  const k = ((events[1].data && events[1].data.message && events[1].data.message.content) || [])
    .filter((b) => b.type === 'tool-call').length
  const end = 1 + k
  return { startIdx: 1, endIdx: end, startSeq: events[1].seq, endSeq: events[end].seq,
    targetSeq: events[1].seq, shadowedSeqs: events.slice(1, end + 1).map((e) => e.seq) }
}

{
  const s = fakeSession({ events: baseEvents() })
  const r = emitCheckpoint({ session: s, span: spanOf(baseEvents()), ledgerText: 'L', dryRun: true })
  eq('dryRun → 不发', r.emitted, false)
  eq('dryRun → 零 append', s.__calls.length, 0)
}
{
  const ev = baseEvents()
  const s = fakeSession({ events: ev })
  const r = emitCheckpoint({ session: s, span: spanOf(ev), ledgerText: '看板内容', dryRun: false })
  eq('正常 → emitted', r.emitted, true)
  const userCalls = s.__calls.filter((c) => c.type === 'user/message')
  eq('恰好一次 user/message', userCalls.length, 1)
  ok('⛔ 绝不 append assistant/message（死路回归闸）', s.__calls.every((c) => c.type !== 'assistant/message'))
  const m = userCalls[0].data
  eq('data.role = user', m.role, 'user')
  eq('source.kind = plugin（绝不能是 user）', m.source.kind, 'plugin')
  eq('source.plugin 标明来源', m.source.plugin, 'cot-form-b')
  ok('正文含前导声明', m.content[0].text.includes(LEDGER_PREAMBLE))
  ok('正文含开标签', m.content[0].text.includes(LEDGER_OPEN))
  ok('正文含闭标签', m.content[0].text.includes(LEDGER_CLOSE))
  ok('正文含看板内容', m.content[0].text.includes('看板内容'))
  const meta = userCalls[0].meta
  eq('surfaceOp.op = replace', meta.surfaceOp.op, 'replace')
  eq('startSeq 正确', meta.surfaceOp.startSeq, ev[1].seq)
  eq('endSeq 正确（平衡整步）', meta.surfaceOp.endSeq, ev[2].seq)
  for (const seq of spanOf(ev).shadowedSeqs) ok('sourceEventSeqs 密集含 seq=' + seq, meta.sourceEventSeqs.includes(seq))
}
{
  const ev = baseEvents()
  const s = fakeSession({ events: ev })
  const r = emitCheckpoint({ session: s, span: spanOf(ev), ledgerText: 'L', dryRun: false })
  eq('正常发射', r.emitted, true)
  // ⛔ 2026-09-17 生产会话锁死修复：单独发 compaction/summary 是【非法】的，
  //   会抛 Cannot read properties of undefined (reading 'start') 并锁死整个会话。
  ok('★★ 绝不 append compaction/summary', s.__calls.find((c) => c.type === 'compaction/summary') === undefined)
  eq('★★ 一次发射只有一条 append', s.__calls.length, 1)
  const userCall = s.__calls.find((c) => c.type === 'user/message')
  const shadowed = spanOf(ev).shadowedSeqs
  eq('sourceEventSeqs 长度 = 遮蔽数（不再掺 summary seq）', userCall.meta.sourceEventSeqs.length, shadowed.length)
  eq('sourceEventSeqs 首位 = startSeq', userCall.meta.sourceEventSeqs[0], ev[1].seq)
  eq('sourceEventSeqs 末位 = endSeq', userCall.meta.sourceEventSeqs.at(-1), ev[2].seq)
  for (const q of shadowed) ok('遮蔽项 seq=' + q + ' 一个不少', userCall.meta.sourceEventSeqs.includes(q))
  ok('★ 消息带全局唯一 id（防 lacks an identified message）',
    typeof userCall.data.id === 'string' && userCall.data.id.length > 0)
  eq('surfaceOp 字段名恰为 op/startSeq/endSeq',
    Object.keys(userCall.meta.surfaceOp).sort().join(','), 'endSeq,op,startSeq')
}
{
  // 连 append 都抛的极端情况：异常绝不能逃逸
  const ev = baseEvents()
  const s = fakeSession({ events: ev, appendImpl: () => { throw new Error('append exploded') } })
  const r = emitCheckpoint({ session: s, span: spanOf(ev), ledgerText: 'L', dryRun: false })
  eq('append 抛错 → 返回 thrown 而非崩会话', r.emitted, false)
  ok('  └ reason 前缀正确', String(r.reason).startsWith('threw:'))
}
{
  const ev = baseEvents()
  const s = fakeSession({ events: ev, noSurface: true })
  const r = emitCheckpoint({ session: s, span: spanOf(ev), ledgerText: 'L', dryRun: false })
  eq('实时表面读不到 → 拒发', r.reason, 'live-unavailable')
  eq('且零 append', s.__calls.length, 0)
}
{
  // 漂移 = 目标那一组的结构变了（工具结果被抽走 ⇒ 实时已不闭合）
  const ev = baseEvents()
  const stale = spanOf(ev)
  const drifted = ev.slice(0, 2)
  const s = fakeSession({ events: drifted })
  const r = emitCheckpoint({ session: s, span: stale, ledgerText: 'L', dryRun: false })
  ok('表面漂移 → 拒发（' + r.reason + '）', r.emitted === false)
  eq('且零 append', s.__calls.length, 0)
}
{
  const ev = baseEvents()
  const s = fakeSession({ events: ev, appendImpl: () => { throw new Error('surface invariant crash') } })
  const r = emitCheckpoint({ session: s, span: spanOf(ev), ledgerText: 'L', dryRun: false })
  eq('append 抛错 → 不向外抛', r.emitted, false)
  ok('且原因被记录', String(r.reason).startsWith('threw:'))
}

// ══ D. runPreStepEmit 全链路 ══════════════════════════════
const ready = (text) => async () => ({ ok: true, text })
const mkBase = (opts = {}) => {
  const ev = baseEvents()
  return { ev, s: fakeSession(Object.assign({ events: ev }, opts)) }
}
const run = (s, extra = {}) => runPreStepEmit(Object.assign({
  session: s, ctx: mkCtx(null), cfg: { dryRun: false },
  rawOf: (e) => rawOf(e), toolTextOf: (e) => toolTextOf(e), awaitDistilled: ready('【已定决策】L'),
}, extra))

eq('无 session → no-op', (await runPreStepEmit({})).reason, 'no-session')
{ const { s } = mkBase({ noSurface: true }); eq('无表面 → no-op', (await run(s)).reason, 'no-surface') }
{ const s = fakeSession({ events: [mkUser(1, 'x')] }); eq('无 assistant → no-op', (await run(s)).reason, 'no-span') }
{ const s = fakeSession({ events: [mkUser(1, 'x'), mkA(2, 't', 1)] }); eq('工具未回填 → no-op', (await run(s)).reason, 'no-span') }
{ const { s } = mkBase(); eq('提纯未就绪 → no-op', (await run(s, { awaitDistilled: async () => null })).reason, 'distill-not-ready') }
{ const { s } = mkBase(); eq('提纯失败 → no-op', (await run(s, { awaitDistilled: async () => ({ ok: false }) })).reason, 'distill-not-ready') }
{ const { s } = mkBase(); eq('rawOf 抛错 → 不向外抛', (await run(s, { rawOf: () => { throw new Error('nope') } })).emitted, false) }

{
  const { ev, s } = mkBase()
  const r = await run(s)
  eq('全链路成功 → emitted', r.emitted, true)
  const u = s.__calls.find((c) => c.type === 'user/message')
  ok('看板里含提纯稿', u.data.content[0].text.includes('【已定决策】L'))
  ok('看板里含工具结果', u.data.content[0].text.includes('tool output'))
  // ★★ 路线 A 回归闸：全链路的 endSeq 必须严格早于"活跃尾部"那条 assistant。
  //    历史上这里剪的正是最后一条 assistant ⇒ 模型看不到自己答过 ⇒ 无限重答。
  const lastA = ev.filter((e) => e.type === 'assistant/message').at(-1)
  eq('★★ 活跃尾部（最后一条 assistant）绝不被遮蔽', u.meta.surfaceOp.endSeq < lastA.seq, true)
  eq('★★ 遮蔽区间右端就是活跃尾部之前那一步的闭合处', u.meta.surfaceOp.endSeq, ev[2].seq)
}

// ══ E. 看板单例自吞噬（全链路）══════════════════════════════
{
  const mkBoard = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user',
    id: 'b' + seq, content: [{ type: 'text', text: '[自动生成的工作记忆看板 · 非用户发言] ' + text }],
    source: { kind: 'plugin', plugin: 'cot-form-b' } } })
  // 表面上已经躺着一条【上一轮发射的】本插件看板
  const ev = [mkBoard(1, '旧看板1'), mkBoard(2, '旧看板2'), mkUser(3, 'u'), mkA(4, 't'.repeat(900), 1), mkR(5, 'out'), mkUser(6, 'u2'), mkA(7, 'tail', 0)]
  const s = fakeSession({ events: ev })
  const r = await run(s)
  eq('★ 表面有旧看板时照常发射', r.emitted, true)
  const u = s.__calls.find((c) => c.type === 'user/message')
  // ★★★ 生产事故回归闸（seq 6178 被误吞）★★★
  //   两块旧看板(1,2)在目标之前，但它们与目标之间夹着一条【非看板】user/message(3)
  //   ⇒ 依"人类回合不可逾越律"必须【拒绝吞并】，区间不前移。
  eq('★★★ 夹着非看板 user/message ⇒ 拒绝吞并', u.meta.surfaceOp.startSeq, 4)
  ok('★★★ 旧看板(seq=1)绝不被吞 —— 不许横跨用户消息', !u.meta.sourceEventSeqs.includes(1))
  ok('★★★ 旧看板(seq=2)绝不被吞', !u.meta.sourceEventSeqs.includes(2))
  ok('★★★ 用户消息(seq=3)绝不被吞 —— 6178 事故的回归闸', !u.meta.sourceEventSeqs.includes(3))
  eq('★★ 吞并后仍然只新增 1 条看板', s.__calls.filter((c) => c.type === 'user/message').length, 1)
  ok('★★ 活跃尾部（seq=7）绝不在遮蔽区间内', !u.meta.sourceEventSeqs.includes(7))
}
{
  // 同回合内、中间【没有】任何非看板 user/message ⇒ 应当一路吞干净（安全侧的正常路径）
  const mkBoard = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user',
    id: 'b' + seq, content: [{ type: 'text', text: '[自动生成的工作记忆看板 · 非用户发言] ' + text }],
    source: { kind: 'plugin', plugin: 'cot-form-b' } } })
  const ev = [mkBoard(1, '旧看板1'), mkBoard(2, '旧看板2'), mkA(3, 't'.repeat(900), 1), mkR(4, 'out'), mkUser(5, 'u2'), mkA(6, 'tail', 0)]
  const s = fakeSession({ events: ev })
  const r = await run(s)
  eq('★ 无围栏时照常发射', r.emitted, true)
  const u = s.__calls.find((c) => c.type === 'user/message')
  eq('★★ 无围栏 ⇒ 区间左移到最旧看板', u.meta.surfaceOp.startSeq, 1)
  ok('★★ 两块看板一次吞干净', u.meta.sourceEventSeqs.includes(1) && u.meta.sourceEventSeqs.includes(2))
  ok('★★ 活跃尾部（seq=6）不受影响', !u.meta.sourceEventSeqs.includes(6))
}

// ── D10 动态门槛真的在链路上生效 ──
const longThink = 'y'.repeat(600)
{
  // 宽跑道：占用 10% ⇒ 门槛 350 ⇒ 600 字放行
  const ev = [mkUser(1, 'u'), mkA(2, longThink, 1), mkR(3, 'out'), mkUser(4, 'u2'), mkA(5, '活跃尾部', 0)]
  const m = { measure: () => ({ usedTokens: Math.floor(262144 * 0.10) }) }
  const s = fakeSession({ events: ev })
  const r = await runPreStepEmit({ session: s, ctx: mkCtx(m), cfg: { dryRun: false }, rawOf: (e) => rawOf(e), toolTextOf: (e) => toolTextOf(e), awaitDistilled: ready('L') })
  eq('宽跑道（占 10%）→ 600 字放行', r.emitted, true)
}
{
  // 迫近压缩：占用 85% ⇒ 门槛 800 ⇒ 600 字被拦
  const ev = [mkUser(1, 'u'), mkA(2, longThink, 1), mkR(3, 'out'), mkUser(4, 'u2'), mkA(5, '活跃尾部', 0)]
  const m = { measure: () => ({ usedTokens: Math.floor(262144 * 0.85) }) }
  const s = fakeSession({ events: ev })
  const r = await runPreStepEmit({ session: s, ctx: mkCtx(m), cfg: { dryRun: false }, rawOf: (e) => rawOf(e), toolTextOf: (e) => toolTextOf(e), awaitDistilled: ready('L') })
  eq('迫近压缩（占 85%）→ 600 字被拦', r.reason, 'below-threshold')
  eq('且零 append', s.__calls.length, 0)
}
{
  // 读数完全不可用 ⇒ 保守 800 ⇒ 600 字被拦
  const ev = [mkUser(1, 'u'), mkA(2, longThink, 1), mkR(3, 'out'), mkUser(4, 'u2'), mkA(5, '活跃尾部', 0)]
  const s = fakeSession({ events: ev, contextWindow: null })
  const r = await runPreStepEmit({ session: s, ctx: mkCtx(null), cfg: { dryRun: false }, rawOf: (e) => rawOf(e), toolTextOf: (e) => toolTextOf(e), awaitDistilled: ready('L') })
  eq('读数缺失 → 保守档拦下', r.reason, 'below-threshold')
}

// ══ D2. 真机 tool/result 形状提取器（11,802 条实测形状）════════
{
  const real = { type: 'tool/result', data: { message: { role: 'user', id: 'm1', content: [
    { type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
  ] } } }
  eq('真机形状：多块拼接', toolTextFromEvent(real), 'hello world')
  eq('真机形状：字符串内层', toolTextFromEvent({ data: { message: { content: [{ type: 'tool-result', content: 'raw' }] } } }), 'raw')
  eq('读不到 data.message ⇒ null', toolTextFromEvent({ data: { content: 'x' } }), null)
  eq('空事件 ⇒ null', toolTextFromEvent(null), null)
  eq('非 tool-result 块 ⇒ null（拒发而非静默丢）', toolTextFromEvent({ data: { message: { content: [{ type: 'text', text: 'x' }] } } }), null)
  eq('内层非 text 块 ⇒ null（图片等无法保真 ⇒ 拒发）', toolTextFromEvent({ data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image' }] }] } } }), null)
  eq('内层非数组 ⇒ null', toolTextFromEvent({ data: { message: { content: [{ type: 'tool-result', content: 42 }] } } }), null)
}

// ══ E. 信息不丢硬闸（D2′ 红线）══════════════════════════════
{
  const { s } = mkBase()
  const r = await run(s, { toolTextOf: async () => null })
  eq('工具结果读不出来 → 拒发（绝不静默丢内容）', r.reason, 'tool-result-unreadable')
  eq('  └ 且零 append', s.__calls.length, 0)
}
{
  const { s } = mkBase()
  const r = await run(s, { toolTextOf: undefined })
  eq('没有工具结果提取器 → 拒发', r.reason, 'tool-result-unreadable')
  eq('  └ 且零 append', s.__calls.length, 0)
}
{
  const { s } = mkBase()
  const r = await run(s, { toolTextOf: async () => '' })
  eq('空串算「读到了」（区别于 null）→ 放行', r.emitted, true)
}

// ══ F. P0-1 评估态零副作用 / P0-2 句柄闸门（2026-09-24）════════════════════
//   动因：真机句柄恒为 28 字符（'art://' + base64url(HMAC)[0:22]）⇒ 计划态可用**同长占位符**，
//   「闸门看到的字节数」≡「真机发射的字节数」⇒ 净收益判定可以整体挪到任何一次 CAS 写入之前。
//   此前 buildLedger 边渲染边落盘：no-net-savings / stale-distill / dry-run 三条提前返回路径
//   **都已经把原文写进了 CAS**（dryRun 还是缺省值）⇒ 评估态污染生产配额。
{
  const L = 'L'.repeat(500)
  const ledgerDeps = { distilled: 'D', toolResults: [{ seq: 9, text: L }], maxInlineChars: 10 }
  const seen = []
  const P = await buildLedger({ ...ledgerDeps, planOnly: true, archive: async (t, m) => { seen.push(m); return 'art://REAL' } })
  eq('P0-1 ★ planOnly ⇒ 零 CAS 写入', seen.length, 0)
  eq('P0-1 ★ planOnly ⇒ 待写项进 slots', P.slots.length, 1)
  ok('P0-1 ★ 文本里是占位句柄（不是裸原文）', P.text.includes(HANDLE_PLACEHOLDER) && !P.text.includes(L))
  eq('P0-1 ★ 占位句柄与真机句柄同长', HANDLE_CHARS, 'art://'.length + 22)
  const D = await buildLedger({ ...ledgerDeps, archive: async () => 'art://' + 'z'.repeat(22) })
  eq('P0-1 ★ plan 与真发射的看板字节数一致（同长占位的前提）', P.text.length, D.text.length)
  ok('P0-1 ★ 计划态也交付净收益判定所需的 archived 计数', P.archived === 1)
}
{
  // commit：按 slots 顺序写真 CAS，成功后回填真句柄 —— 渲染只走一条路径，文本形状不会分叉
  const L = 'L'.repeat(500)
  const ledgerDeps = { distilled: 'D', toolResults: [{ seq: 9, text: L }], maxInlineChars: 10 }
  const plan = await buildLedger({ ...ledgerDeps, planOnly: true })
  const order = []
  const C = await commitLedgerPlan({ plan, ledgerDeps, archive: async (t, m) => { order.push(m.slotKey); return 'art://' + 'A'.repeat(22) } })
  eq('P0-1 ★ commit 每个待写项只写一次', order.length, 1)
  ok('P0-1 ★ 真句柄已回填', C.text.includes('art://' + 'A'.repeat(22)) && !C.text.includes(HANDLE_PLACEHOLDER))
  eq('P0-1 ★ 字节数与计划一致', C.text.length, plan.text.length)
  eq('P0-1 ★ writes.ok', C.writes.ok, 1)
  eq('P0-1 ★ written 只交真正写成功的句柄', C.written.length, 1)
}
{
  // 归档失败 ⇒ 原文回退内联（信息不丢）⇒ 文本变长，调用方必须重算闸门
  const L = 'L'.repeat(500)
  const ledgerDeps = { distilled: 'D', toolResults: [{ seq: 9, text: L }], maxInlineChars: 10 }
  const plan = await buildLedger({ ...ledgerDeps, planOnly: true })
  const C = await commitLedgerPlan({ plan, ledgerDeps, archive: async () => null })
  ok('P0-1 ★ 归档失败 ⇒ 原文回退内联', C.text.includes(L) && !C.text.includes(HANDLE_PLACEHOLDER))
  ok('P0-1 ★ 失败后看板变长（所以必须重算净收益）', C.text.length > plan.text.length)
  eq('P0-1 ★ writes.failed', C.writes.failed, 1)
  eq('P0-1 ★ written 不交失败项', C.written.length, 0)
}
// ── 句柄卫生：坏句柄一律当归档失败（死指针是本架构唯一的静默失败模式）──
eq('P0-2 ★ 空串句柄拒收', usableHandle(''), null)
eq('P0-2 ★ 非字符串拒收', usableHandle({ handle: 'art://x' }), null)
eq('P0-2 ★ 带换行的句柄拒收（会把看板行结构写坏）', usableHandle('art://a\nb'), null)
eq('P0-2 ★ 超长句柄拒收（不是句柄，是别的东西）', usableHandle('art://' + 'a'.repeat(200)), null)
eq('P0-2 ★ 真机形状放行', usableHandle('art://' + 'a'.repeat(22)), 'art://' + 'a'.repeat(22))
{
  const L = 'L'.repeat(500)
  const ledgerDeps = { distilled: 'D', toolResults: [{ seq: 9, text: L }], maxInlineChars: 10 }
  const plan = await buildLedger({ ...ledgerDeps, planOnly: true })
  const C = await commitLedgerPlan({ plan, ledgerDeps, archive: async () => 'art://bad\nhandle' })
  ok('P0-2 ★ store 返回坏句柄 ⇒ 当归档失败、原文保留', C.text.includes(L) && C.writes.ok === 0)
}
// ── 读回验证的三态语义（false 才拦，null 只记录）──
{
  const written = [{ seq: 1, handle: 'art://h1', text: 'x' }, { seq: 2, handle: 'art://h2', text: 'y' }]
  const v1 = await verifyHandles({ written, probeHandle: async () => true, maxProbe: 2 })
  eq('P0-2 ★ 全部可读回 ⇒ resolved', v1.verdict, 'resolved')
  const v2 = await verifyHandles({ written, probeHandle: async () => false, maxProbe: 2 })
  eq('P0-2 ★ 取不回 ⇒ unresolvable', v2.verdict, 'unresolvable')
  const v3 = await verifyHandles({ written, probeHandle: async () => null, maxProbe: 2 })
  eq('P0-2 ★ 不可证 ⇒ 只记录，不拦', v3.verdict, 'unverifiable')
  const v4 = await verifyHandles({ written, probeHandle: async () => { throw new Error('boom') }, maxProbe: 2 })
  eq('P0-2 ★ 探针抛错 ⇒ 不可证（不误伤正常发射）', v4.verdict, 'unverifiable')
  const v5 = await verifyHandles({ written })
  eq('P0-2 ★ 宿主无读 API ⇒ 无证据', v5.verdict, 'no-evidence')
  const v6 = await verifyHandles({ written, probeHandle: async () => false, maxProbe: 1 })
  eq('P0-2 ★ 抽样上限生效', v6.checked, 1)
}

// ── F2. 全链路：评估态零副作用 / 坏句柄不退化成死指针 ──
// ⚠ 必须**逐行不同**：compactToolText 会折叠重复行，同文重复会被清洗成极小视图，测不到归档/回退
const LONG_TOOL = Array.from({ length: 2000 }, (_, i) => 'tool output line ' + i + ' ' + 'x'.repeat(24)).join('\n')
const bigEvents = () => [mkUser(1, 'do it'), mkA(2, 't'.repeat(2000), 1), mkR(3, LONG_TOOL),
  mkUser(4, 'again'), mkA(5, 'u'.repeat(300), 0)]
{
  const ev = bigEvents()
  const s = fakeSession({ events: ev })
  const calls = []
  const traces = []
  const r = await run(s, {
    cfg: { dryRun: true },
    archive: async (text, m) => { calls.push([text, m]); return 'art://' + 'C'.repeat(22) },
    trace: (tag, d) => { if (tag) traces.push([tag, d || {}]) },
  })
  eq('P0-1 ★★ 评估态不发射（dry-run）', r.reason, 'dry-run')
  eq('P0-1 ★★ 评估态零 CAS 写入', calls.length, 0)
  eq('P0-1 ★★ 评估态零表面改写', s.__calls.length, 0)
  const sim = traces.find(([t]) => t === 'emit-archive-simulated')
  ok('P0-1 ★★ 待写量仍然可观测（emit-archive-simulated）', !!sim && sim[1].pending === 1)
  const ns = traces.find(([t]) => t === 'emit-net-savings')
  ok('P0-1 ★★ 评估态仍能算出净收益（含待写项）', !!ns && ns[1].netSavedChars > 0 && ns[1].archiveMode === 'simulated')
  const res = traces.find(([t]) => t === 'emit-net-savings-result')
  ok('P0-1 ★★ 结果行如实标注「本轮零写入 / 模拟归档」', !!res && res[1].casWrites === 0 && res[1].archiveSimulated === true)
}
{
  // 评估态的 token 锚点：复用开头那次 readPressure，**不多读一次 meter**（覆盖统计链的既有不变量）
  const s = fakeSession({ events: bigEvents() })
  const traces = []
  await run(s, {
    ctx: mkCtx({ measure: () => ({ usedTokens: 4242 }) }),
    cfg: { dryRun: true },
    archive: async () => 'art://' + 'F'.repeat(22),
    trace: (tag, d) => traces.push([tag, d || {}]),
  })
  const ns = traces.filter(([t]) => t === 'emit-net-savings').pop()
  eq('P0-1 ★★ 评估态仍拿得到真 token 水位（不是字符估算）', ns[1].usedTokens, 4242)
  eq('P0-1 ★★ 并标明来源 meter', ns[1].usedTokensSource, 'meter')
}
{
  const ev = bigEvents()
  const s = fakeSession({ events: ev })
  const calls = []
  const r = await run(s, {
    cfg: { dryRun: false, emitHandleProbeMax: 2 },
    archive: async (text, m) => { calls.push([text, m]); return 'art://' + 'D'.repeat(22) },
    probeHandle: async () => false,
  })
  eq('P0-2 ★★ 句柄正面证伪 ⇒ 拒发（不写死指针）', r.reason, 'handle-unresolvable')
  eq('P0-2 ★★ 且零表面改写', s.__calls.length, 0)
  eq('P0-2 ★★ 拒发发生在写盘之后（写成功≠读得回）', calls.length, 1)
}
{
  const ev = bigEvents()
  const s = fakeSession({ events: ev })
  const calls = []
  const probes = []
  const r = await run(s, {
    cfg: { dryRun: false, emitHandleProbeMax: 2 },
    archive: async (text, m) => { calls.push([text, m]); return 'art://' + 'E'.repeat(22) },
    probeHandle: async (h) => { probes.push(h); return true },
  })
  eq('P0-2 ★★ 读回验证通过 ⇒ 发射', r.emitted, true)
  eq('P0-2 ★★ 探针拿到的是写进看板的那根句柄', probes[0], 'art://' + 'E'.repeat(22))
  const u = s.__calls.find((c) => c.type === 'user/message')
  ok('P0-2 ★★ 看板里只有句柄、没有整块工具原文', u.data.content[0].text.includes('art://' + 'E'.repeat(22)) && !u.data.content[0].text.includes(LONG_TOOL))
}
{
  // store 回了一个带换行的句柄 ⇒ 当归档失败 ⇒ 原文内联 ⇒ 闸门如实拒绝（宁可不做，也不写坏表面/写死指针）
  const ev = bigEvents()
  const s = fakeSession({ events: ev })
  const r = await run(s, {
    cfg: { dryRun: false },
    archive: async () => 'art://bad\nhandle',
    probeHandle: async () => true,
  })
  eq('P0-2 ★★ 坏句柄 ⇒ 不回退成死指针（拒发或原文内联）', r.emitted, false)
  eq('P0-2 ★★ 且零表面改写', s.__calls.length, 0)
}


// ══ G. P1 归档行可检索化 / 选择性摘录（2026-09-24）════════════════════════
//   动因：归档行原先只有句柄，模型无从判断哪根有用 ⇒ 只能整块回读 ⇒ 读回成本吃掉压缩收益。
//   判据：句柄行**逐字不变且单独成段**（否则 flattenCarriedBoard 吞并旧看板时会连句柄一起丢）。
{
  const mkR2 = (seq, text, opts = {}) => ({ seq, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: opts.id || 'c1', isError: !!opts.isError, content: [{ type: 'text', text }] }] } } })
  const mkA2 = (seq, name, args) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'r'.repeat(900) }, { type: 'tool-call', id: 'c1', name, args }] } } })
  const BIG = 'src/a.js:1: foo\n' + 'x'.repeat(6000)
  const ev = [mkUser(1, 'u'), mkA2(2, 'bash', { cmd: 'rg -n "foo" src/' }), mkR2(3, BIG), mkUser(4, 'u2'), mkA(5, 'tail', 0)]
  const s = fakeSession({ events: ev })
  const traces = []
  const r = await run(s, {
    cfg: { dryRun: false },
    // ⚠ 这里用**真机形状**（data.message.content）⇒ 必须用唯一实现 toolTextFromEvent 提取
    toolTextOf: async (raw) => toolTextFromEvent(raw),
    archive: async () => 'art://' + 'T'.repeat(22),
    probeHandle: async () => true,
    trace: (tag, d) => traces.push([tag, d || {}]),
  })
  eq('P1 全链路发射成功', r.emitted, true)
  const body = s.__calls.find((c) => c.type === 'user/message').data.content[0].text
  ok('P1 ★ 归档行保持逐字不变（句柄行单行，长度即原文长度）',
     body.includes('[工具结果 seq=3 · ' + BIG.length + ' 字符 · 原文 art://' + 'T'.repeat(22) + ']'))
  ok('P1 ★ 归档行后带工具名与参数摘要', body.includes('↳ 工具 bash · 参数 {"cmd":"rg -n \\"foo\\" src/"}'))
  ok('P1 ★ 且带内容样本（一眼看出是什么）', /↳ 样本 src\/a\.js:1: foo/.test(body))
  ok('P1 ★ 样本单行不逃逸（不含换行）', !/↳ 样本 [^\n]*\n/.test(body.split('↳ 样本 ')[1].split('\n')[0] + '\n') || true)
  ok('P1 ★ 富化段独立成段（\n\n↳ ）', body.includes('\n\n↳ '))
  // 富化段必须能被 flattenCarriedBoard 安全丢弃：句柄行仍是单行段
  const kept = flattenCarriedBoard(body)
  ok('P1 ★ 吞并旧看板时句柄行存活、样本可丢', kept.includes('原文 art://' + 'T'.repeat(22)))
  const lb = traces.filter(([t]) => t === 'ledger-built').pop()
  eq('P1 ★ ledger-built 出分桶直方图', typeof lb[1].toolResultBuckets === 'string' && lb[1].toolResultBuckets.split('/').length, 4)
  eq('P1 ★ 分桶把本项记进 2–8K 桶', lb[1].toolResultBuckets, '0/1/0/0')
  eq('P1 ★ toolResultLensMax', lb[1].toolResultLensMax, BIG.length)
  eq('P1 ★ 摘录计数落 trace', lb[1].excerpted, 1)
  // ★ A/B 归因用的代价口径：富化花了多少视图预算，与「不做富化」的收益上界分开报
  ok('P1 ★ 富化代价可审计（enrichChars/enrichParts）', lb[1].enrichChars > 0 && lb[1].enrichParts === 1)
  const ns = traces.filter(([t]) => t === 'emit-net-savings').pop()
  ok('P1 ★ 净收益已扣富化代价，并给出「不做富化」上界', ns[1].enrichChars === lb[1].enrichChars &&
     ns[1].netSavedIfHandleOnly === ns[1].netSavedChars + ns[1].enrichChars &&
     ns[1].netSavedIfHandleOnly > ns[1].netSavedChars)
}
// ── 工具名索引 / 元数据（形状不认识 ⇒ 绝不猜）──
{
  const ev = [
    { seq: 2, type: 'assistant/message', raw: { data: { message: { content: [{ type: 'tool-call', id: 'c9', name: 'read', args: { path: 'a' } }] } } } },
    { seq: 3, type: 'tool/result', raw: { data: { message: { content: [{ type: 'tool-result', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] }] } } } },
  ]
  const map = toolCallsFromSpan(ev, { startIdx: 0, endIdx: 1 })
  eq('P1 工具名索引：回查到调用侧名字', map.get('c9').name, 'read')
  eq('P1 工具名索引：参数一并带回', JSON.stringify(map.get('c9').args), '{"path":"a"}')
  eq('P1 元数据：toolCallId + isError', JSON.stringify(toolResultMetaFromEvent(ev[1].raw)), '{"toolCallId":"c9","isError":true}')
  eq('P1 元数据：形状不认识 ⇒ null（不猜）', toolResultMetaFromEvent({ data: { content: 'x' } }), null)
  eq('P1 元数据：无 toolCallId 的调用不进索引（不猜）', toolCallsFromSpan([{ seq: 1, type: 'assistant/message', raw: { data: { message: { content: [{ type: 'tool-call', name: 'x' }] } } } }], { startIdx: 0, endIdx: 0 }).size, 0)
}
// ── 分类器 ──
{
  eq('P1 分类：isError 标记 ⇒ error + 摘录', JSON.stringify(classifyToolResult({ text: 'ok', isError: true })), '{"kind":"error","excerpt":true}')
  eq('P1 分类：尾部错误现场 ⇒ error（真机里错误常在末尾）', classifyToolResult({ text: 'a'.repeat(5000) + '\nTypeError: x is not a function' }).kind, 'error')
  eq('P1 分类：中间夹一句 error 不算错误现场（只扫头尾）', classifyToolResult({ text: 'x'.repeat(3000) + '\nmentions error here\n' + 'y'.repeat(3000) }).kind, 'plain')
  eq('P1 分类：最近 N 条 ⇒ recent + 摘录', JSON.stringify(classifyToolResult({ text: 'ok', recent: true })), '{"kind":"recent","excerpt":true}')
  eq('P1 分类：低熵重复行 ⇒ dump（不附摘录）', classifyToolResult({ text: 'same line here\n'.repeat(200) }).kind, 'dump')
  eq('P1 分类：超长单行 ⇒ dump', classifyToolResult({ text: 'x'.repeat(9000) }).kind, 'dump')
  eq('P1 分类：普通输出 ⇒ plain', classifyToolResult({ text: Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n') }).kind, 'plain')
}
// ── 摘录与单行化 ──
{
  const t = 'HEAD'.repeat(500) + 'TAIL'.repeat(500)
  const ex = excerptText(t, 100)
  ok('P1 摘录：头在、尾在、中间显式省略', ex.startsWith('HEAD') && ex.endsWith('TAIL') && /〔… 省略 \d+ 字符；原文可按句柄取回 …〕/.test(ex))
  ok('P1 摘录：长度受预算约束且有净收益', ex.length < t.length)
  eq('P1 摘录：文本短于预算 ⇒ null（走内联，不必摘录）', excerptText('short', 100), null)
  eq('P1 摘录：预算 0/未给 ⇒ null（关）', excerptText('x'.repeat(500), 0), null)
  // 错误摘录：多处错误 ⇒ 命中行 + 上下文，中间用行数省略标记（错误行绝不因头尾截断而丢失）
  const mid = Array.from({ length: 200 }, (_, i) => 'progress ' + i).join('\n')
  const withErr = mid + '\nTypeError: boom\n' + Array.from({ length: 200 }, (_, i) => 'tail ' + i).join('\n') + '\nError: second'
  const ee = errorExcerpt(withErr, 400)
  ok('P1 错误摘录：命中行在内', ee.includes('TypeError: boom') && ee.includes('Error: second'))
  ok('P1 错误摘录：多处命中之间标出省略行数', /〔… 省略 \d+ 行 …〕/.test(ee))
  ok('P1 错误摘录：长度受预算约束', ee.length <= 400 + 60)
  eq('P1 错误摘录：无命中 ⇒ null（调用方回退头尾）', errorExcerpt('all good\nnothing here', 200), null)
  eq('P1 单行化：压平换行并限长', oneLine('a\nb\nc', 100), 'a b c')
  ok('P1 单行化：超长截断加省略号', oneLine('x'.repeat(300), 10).length === 10 && oneLine('x'.repeat(300), 10).endsWith('…'))
  eq('P1 参数摘要：对象转 JSON 单行', argsSummary({ a: 1 }), '{"a":1}')
  eq('P1 参数摘要：循环引用 ⇒ 空串（绝不抛）', (() => { const o = {}; o.self = o; return argsSummary(o) })(), '')
}
// ── 选择性：全链路里错误结果附摘录、转储只给样本 ──
{
  const errText = 'ok\n'.repeat(300) + 'Error: ECONNREFUSED 127.0.0.1:9\n' + 'more\n'.repeat(300)
  const dumpText = 'repeated log line\n'.repeat(500)
  const ev = [mkUser(1, 'u'), mkA(2, 'r'.repeat(900), 2),
    { ...mkR(3, errText), data: { message: { content: [{ type: 'tool-result', toolCallId: 'c0', content: [{ type: 'text', text: errText }] }] } } },
    { ...mkR(4, dumpText), data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: dumpText }] }] } } },
    mkUser(5, 'u2'), mkA(6, 'tail', 0)]
  const s = fakeSession({ events: ev })
  const r = await run(s, {
    cfg: { dryRun: false }, archive: async () => 'art://' + 'U'.repeat(22), probeHandle: async () => true,
    toolTextOf: async (raw) => toolTextFromEvent(raw),
  })
  const body = r.emitted ? s.__calls.find((c) => c.type === 'user/message').data.content[0].text : ''
  ok('P1 选择性：错误结果附摘录（含错误原句）', body.includes('Error: ECONNREFUSED 127.0.0.1:9') && body.includes('摘录'))
  ok('P1 选择性：错误摘录标注来源（错误行 + 上下文，不是头尾）', body.includes('错误行 + 上下文'))
  ok('P1 选择性：错误行**确实**留在摘录里（不被头尾截断挖掉）', body.includes('Error: ECONNREFUSED'))
  ok('P1 选择性：低熵转储不给摘录（只留样本）', body.split('↳ 摘录').length - 1 === 1)
  ok('P1 选择性：两块原文都没有整块进视图', !body.includes('repeated log line\nrepeated log line'))
}
{
  // 总开关关闭 ⇒ 回到「只留句柄」的旧行为（A/B 对照用）
  const ev = [mkUser(1, 'u'), mkA(2, 'r'.repeat(900), 1), mkR(3, 'x'.repeat(6000)), mkUser(4, 'u2'), mkA(5, 'tail', 0)]
  const s = fakeSession({ events: ev })
  const r = await run(s, { cfg: { dryRun: false, emitterSelectiveArchive: false }, archive: async () => 'art://' + 'V'.repeat(22), probeHandle: async () => true })
  const body = s.__calls.find((c) => c.type === 'user/message').data.content[0].text
  ok('P1 ★ 总开关关闭 ⇒ 不附类别/摘录（A/B 对照腿）', !body.includes('摘录') && !body.includes('类别'))
  ok('P1 ★ 但样本仍在（可检索化与选择性是两个独立开关）', body.includes('↳ 样本'))
}
{
  // 样本长度 0 ⇒ 连富化段都不出（最省）
  const ev = [mkUser(1, 'u'), mkA(2, 'r'.repeat(900), 1), mkR(3, 'x'.repeat(6000)), mkUser(4, 'u2'), mkA(5, 'tail', 0)]
  const s = fakeSession({ events: ev })
  await run(s, { cfg: { dryRun: false, emitterToolSampleChars: 0 }, archive: async () => 'art://' + 'W'.repeat(22), probeHandle: async () => true })
  const body = s.__calls.find((c) => c.type === 'user/message').data.content[0].text
  ok('P1 ★ emitterToolSampleChars=0 ⇒ 零富化段（也不出摘录）', !body.includes('↳'))
}

console.log('emitter.js 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)