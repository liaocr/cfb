import {
  selectBalancedSpan, verifyBalancedSpan, eventDelta, balanceAfterEach, balanceBefore,
  countToolCalls, eventsFromSurface, ASSISTANT_MESSAGE, TOOL_RESULT,
} from '../balanced-span.js'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('  ✗ ' + name) } }
const eq = (name, got, want) => { if (got === want) { pass++ } else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) } }

let SEQ = 0
const resetSeq = () => { SEQ = 0 }
const U = () => ({ seq: ++SEQ, type: 'user/message' })
const A = (n = 0) => ({ seq: ++SEQ, type: 'assistant/message', toolCallCount: n })
const R = () => ({ seq: ++SEQ, type: 'tool/result' })
const sur = (...fns) => { resetSeq(); const out = []; for (const f of fns) { const v = f(); Array.isArray(v) ? out.push(...v) : out.push(v) } return out }
const Rs = (k) => () => Array.from({ length: k }, () => R())
// ★ 2026-09-17 路线 A：活跃尾部保护（keepTail 缺省 1）。
//   本文件的历史夹具多为"单步表面"，在尾部保护下会一律返回 null。
//   为了让"区间闭合逻辑"的覆盖一条都不丢，下面这些夹具统一在末尾追加一个
//   活跃尾部步（user + 纯文本 assistant），断言仍然针对**前一步**。
let TAILSEQ = 90000
const tailStep = () => [{ seq: ++TAILSEQ, type: 'user/message' }, { seq: ++TAILSEQ, type: 'assistant/message', toolCallCount: 0 }]
const wt = (e) => e.concat(tailStep())

// ══ 1. eventDelta 必须逐字对齐官方 tool-pairing.js ═══════════
eq('assistant 无 tool-call ⇒ +0', eventDelta({ type: ASSISTANT_MESSAGE }), 0)
eq('assistant 2 个 tool-call ⇒ +2', eventDelta({ type: ASSISTANT_MESSAGE, toolCallCount: 2 }), 2)
eq('tool/result ⇒ -1', eventDelta({ type: TOOL_RESULT }), -1)
eq('user/message ⇒ 0', eventDelta({ type: 'user/message' }), 0)
eq('未知类型 ⇒ 0', eventDelta({ type: 'compaction/summary' }), 0)
eq('null ⇒ 0', eventDelta(null), 0)
eq('从原始 data 形状数 tool-call', countToolCalls({ type: ASSISTANT_MESSAGE, data: { message: { content: [{ type: 'text' }, { type: 'tool-call' }, { type: 'tool-call' }] } } }), 2)
eq('toolCallCount 优先于 data', eventDelta({ type: ASSISTANT_MESSAGE, toolCallCount: 3, data: { message: { content: [] } } }), 3)

// ══ 2. 余额计算 ═══════════════════════════════════════════
{
  const e = sur(U, () => A(1), R, () => A(0))
  eq('balanceAfterEach', JSON.stringify(balanceAfterEach(e)), JSON.stringify([0, 1, 0, 0]))
  eq('balanceBefore(0)', balanceBefore(e, 0), 0)
  eq('balanceBefore(3) 带 1 个未回填调用', balanceBefore(e, 2), 1)
}

// ══ 3. 核心场景 ═══════════════════════════════════════════
eq('空表面 ⇒ null', selectBalancedSpan([]), null)
eq('非数组 ⇒ null', selectBalancedSpan(null), null)
eq('只有 user ⇒ null', selectBalancedSpan(sur(U)), null)

{
  const e = wt(sur(U, () => A(0)))
  const s = selectBalancedSpan(e)
  eq('纯文本步（剪的是活跃尾部之前那一步）⇒ 只遮蔽那条 assistant', JSON.stringify(s.shadowedSeqs), JSON.stringify([e[1].seq]))
  eq('纯文本步 calls=0', s.calls, 0)
}
{
  const e = wt(sur(U, () => A(1), R))
  const s = selectBalancedSpan(e)
  eq('单工具步 ⇒ assistant+result', JSON.stringify(s.shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
  eq('单工具步 calls=1', s.calls, 1)
  eq('单工具步 results=1', s.results, 1)
}
{
  const e = wt(sur(U, () => A(3), Rs(3)))
  const s = selectBalancedSpan(e)
  eq('并行 3 工具 ⇒ 4 条全包', s.shadowedSeqs.length, 4)
  eq('并行 3 工具 calls=3', s.calls, 3)
}
{
  const e = wt(sur(U, () => A(2), R))
  eq('工具未回填（半截）⇒ null', selectBalancedSpan(e), null)
}
{
  const e = sur(U, () => A(1), R, U, () => A(2), Rs(2))
  const s = selectBalancedSpan(e)
  // ★ 路线 A：缺省 keepTail=1 ⇒ 最后那一步是"活跃尾部"，逐字保留；剪的是它之前那一步。
  eq('★ 交错多步 ⇒ 只包【活跃尾部之前】那一组（最后一步逐字保留）', JSON.stringify(s.shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
  eq('★ 遮蔽区间右端严格落在活跃尾部之前', s.endIdx < s.tailStartIdx, true)
  eq('★ 尾部起点 = 最后一条 assistant', e[s.tailStartIdx].seq, e[4].seq)
}
{
  const e = sur(U, () => A(1), R, U, () => A(2), Rs(2))
  const s = selectBalancedSpan(e, { targetSeq: e[1].seq })
  eq('显式 targetSeq ⇒ 包更早那组', JSON.stringify(s.shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
}
{
  const e = sur(U, () => A(1), R)
  eq('targetSeq 指向 user ⇒ null', selectBalancedSpan(e, { targetSeq: e[0].seq }), null)
  eq('targetSeq 不存在 ⇒ null', selectBalancedSpan(e, { targetSeq: 99999 }), null)
}
{
  const e = sur(U, () => A(1), R)
  eq('minShadowedEvents=3 但只有 2 条 ⇒ null', selectBalancedSpan(e, { minShadowedEvents: 3 }), null)
}

// ══ 3.5 看板单例自吞噬（absorbSeqs）═══════════════════════
{
  // 表面：[旧看板][目标步 A1+R][user][活跃尾部 A0]
  const e = sur(U, () => A(1), Rs(1), U, () => A(0))
  eq('不吞并 ⇒ 只包目标那一步', JSON.stringify(selectBalancedSpan(e).shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
  const s1 = selectBalancedSpan(e, { absorbSeqs: [e[0].seq] })
  eq('★ 吞并上一条看板 ⇒ 区间起点左移到看板', JSON.stringify(s1.shadowedSeqs), JSON.stringify([e[0].seq, e[1].seq, e[2].seq]))
  eq('★ 被吞的看板确实落在遮蔽区间内', s1.shadowedSeqs.includes(e[0].seq), true)
  eq('★ 尾部仍未被动', s1.endIdx < s1.tailStartIdx, true)
  eq('★ 吞并目标不在表面 ⇒ 区间原样不变', JSON.stringify(selectBalancedSpan(e, { absorbSeqs: [999999] }).shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
  eq('★ 空 absorbSeqs ⇒ 区间原样不变', JSON.stringify(selectBalancedSpan(e, { absorbSeqs: [] }).shadowedSeqs), JSON.stringify([e[1].seq, e[2].seq]))
  // ★★★ 人类回合不可逾越律（生产事故回归闸）★★★
  const ev2 = [
    { seq: 1, type: 'user/message' },                                  // 旧看板
    { seq: 2, type: 'user/message', source: { kind: 'user' } },        // ★真人新指令（夹心）
    { seq: 3, type: 'assistant/message', toolCallCount: 1 },
    { seq: 4, type: 'tool/result' },
    { seq: 5, type: 'assistant/message', toolCallCount: 0 },
  ]
  const q2 = selectBalancedSpan(ev2, { absorbSeqs: [1] })
  eq('★★★ 夹着真人发言 ⇒ 拒绝吞并旧看板（绝不横跨人类消息）', JSON.stringify(q2.shadowedSeqs), JSON.stringify([3, 4]))
  const ev3 = [
    { seq: 1, type: 'user/message' },   // 更旧看板
    { seq: 2, type: 'user/message' },   // 旧看板
    { seq: 3, type: 'assistant/message', toolCallCount: 1 },
    { seq: 4, type: 'tool/result' },
    { seq: 5, type: 'assistant/message', toolCallCount: 0 },
  ]
  const q3 = selectBalancedSpan(ev3, { absorbSeqs: [1, 2] })
  eq('★ 之间没有非看板消息 ⇒ 可一路吞到最旧看板', JSON.stringify(q3.shadowedSeqs), JSON.stringify([1, 2, 3, 4]))
}

// ══ 4. 安全阀：禁止一次性遮蔽整个表面 ═════════════════════
{
  const e = sur(() => A(0))
  eq('表面仅一条 assistant ⇒ 默认拒（全遮蔽）', selectBalancedSpan(e), null)
  const s = selectBalancedSpan(e, { allowWholeSurface: true })
  // ★ 路线 A：活跃尾部保护【优先于】allowWholeSurface —— 唯一的 assistant 就是活跃尾部，
  //   连"显式放行整表遮蔽"也压不过它（否则又会剪在模型正说话的嘴唇上）。
  eq('★ 即使显式 allowWholeSurface，活跃尾部保护仍优先 ⇒ null', s, null)
}
{
  const e = sur(() => A(1), R)
  eq('表面仅 assistant+result ⇒ 默认拒', selectBalancedSpan(e), null)
}
{
  const e = sur(() => A(0), U)
  const s = selectBalancedSpan(e)
  // ★ 路线 A：表仅一条 assistant ⇒ 它就是活跃尾部 ⇒ 一律 null（保持原文，D3′）
  eq('★ 表仅一条 assistant（= 活跃尾部）⇒ 一律 null', s, null)
}

// ══ 5. 损坏表面一律不动 ═══════════════════════════════════
{
  const e = sur(R, () => A(0))   // 孤儿 tool/result
  eq('起始即负余额 ⇒ null', selectBalancedSpan(e), null)
  eq('verify 报 surface-corrupt-neg', verifyBalancedSpan(e, { startIdx: 0, endIdx: 1, shadowedSeqs: [1, 2] }).reason, 'surface-corrupt-neg')
}

// ══ 6. verifyBalancedSpan 负控制 ═════════════════════════
{
  const e = sur(U, () => A(2), Rs(2), U, () => A(0))
  const good = selectBalancedSpan(e)
  ok('正样本通过', verifyBalancedSpan(e, good).ok)
  eq('故意切在未闭合处 ⇒ end-cut-unbalanced',
    verifyBalancedSpan(e, { startIdx: 1, endIdx: 2, shadowedSeqs: [e[1].seq, e[2].seq] }).reason, 'end-cut-unbalanced')
  eq('起点切点不平衡 ⇒ start-cut-unbalanced',
    verifyBalancedSpan(e, { startIdx: 2, endIdx: 3, shadowedSeqs: [e[2].seq, e[3].seq] }).reason, 'start-cut-unbalanced')
  eq('seq 对不上 ⇒ seq-mismatch',
    verifyBalancedSpan(e, { startIdx: 1, endIdx: 3, shadowedSeqs: [999, e[2].seq, e[3].seq] }).reason, 'seq-mismatch')
  eq('越界 ⇒ span-range', verifyBalancedSpan(e, { startIdx: 0, endIdx: 99, shadowedSeqs: [] }).reason, 'span-range')
  eq('形状非法 ⇒ span-shape', verifyBalancedSpan(e, null).reason, 'span-shape')
}

// ══ 7. 穷举：小输入空间全量枚举，零 corrupt 硬不变式 ═══════
{
  const ALPHA = [
    { label: 'U', make: () => ({ type: 'user/message' }) },
    { label: 'A0', make: () => ({ type: 'assistant/message', toolCallCount: 0 }) },
    { label: 'A1', make: () => ({ type: 'assistant/message', toolCallCount: 1 }) },
    { label: 'A2', make: () => ({ type: 'assistant/message', toolCallCount: 2 }) },
    { label: 'R', make: () => ({ type: 'tool/result' }) },
  ]
  let cases = 0, spans = 0, corrupt = 0, targetMissed = 0, nonMinimal = 0, tailShadowed = 0
  const MAXLEN = 6
  const build = (picks, upto) => {
    const out = []
    for (let i = 0; i < upto; i++) { const ev = ALPHA[picks[i]].make(); ev.seq = i + 1; out.push(ev) }
    return out
  }
  for (let len = 1; len <= MAXLEN; len++) {
    const total = Math.pow(ALPHA.length, len)
    for (let code = 0; code < total; code++) {
      const picks = []
      let c = code
      for (let i = 0; i < len; i++) { picks.push(c % ALPHA.length); c = Math.floor(c / ALPHA.length) }
      const events = build(picks, len)
      cases++
      const span = selectBalancedSpan(events)
      if (span === null) continue
      spans++
      if (!verifyBalancedSpan(events, span).ok) corrupt++
      // ★ 路线 A：目标 = 跳过活跃尾部（缺省 keepTail=1）之后的那条 assistant，即【倒数第二条】
      const asstIdx = []
      for (let i = 0; i < events.length; i++) if (events[i].type === ASSISTANT_MESSAGE) asstIdx.push(i)
      if (asstIdx.length < 2) { targetMissed++; continue }   // 产出了 span 却不足两步 = 违规
      const t = asstIdx[asstIdx.length - 2]
      if (t < span.startIdx || t > span.endIdx) targetMissed++
      // ★ 尾部不变量：最后一条 assistant 必须逐字保留，绝不许落进遮蔽区间
      if (span.endIdx >= asstIdx[asstIdx.length - 1]) tailShadowed++
      // 极小性：切点内部不得再出现平衡切点
      const bal = balanceAfterEach(events)
      for (let k = span.startIdx + 1; k <= t; k++) if (bal[k - 1] === 0) nonMinimal++
      for (let k = t; k < span.endIdx; k++) if (bal[k] === 0) nonMinimal++
    }
  }
  ok('穷举了足够多的用例（' + cases + ' 例）', cases > 5000)
  ok('穷举中产出的区间全部自检通过（零 corrupt）', corrupt === 0)
  ok('穷举中目标必落在区间内', targetMissed === 0)
  ok('穷举中区间全部极小（无冗余遮蔽）', nonMinimal === 0)
  ok('★ 穷举中活跃尾部从未被遮蔽（leaves the recent tail unchanged）', tailShadowed === 0)
}

// ══ 8. 性质测试：随机良构表面 ═══════════════════════════
{
  const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const rnd = mulberry32(20260917)
  let checks = 0, bad = 0, unterminatedNull = 0
  for (let trial = 0; trial < 400; trial++) {
    const turns = 1 + Math.floor(rnd() * 6)
    const events = []
    let seq = 0
    for (let t = 0; t < turns; t++) {
      events.push({ seq: ++seq, type: 'user/message' })
      const k = Math.floor(rnd() * 4)
      events.push({ seq: ++seq, type: 'assistant/message', toolCallCount: k })
      for (let i = 0; i < k; i++) events.push({ seq: ++seq, type: 'tool/result' })
    }
    const asstIdx = []
    for (let i = 0; i < events.length; i++) if (events[i].type === ASSISTANT_MESSAGE) asstIdx.push(i)
    const span = selectBalancedSpan(events)
    // ★ 路线 A：不足两步（没有"活跃尾部之前"的步）⇒ 必须一律 null
    if (asstIdx.length < 2) { if (span !== null) bad++; continue }
    if (span === null) { bad++; continue }
    checks++
    if (!verifyBalancedSpan(events, span).ok) bad++
    // ★ 必须恰好是【倒数第二组】：倒数第二条 assistant 及其全部 result；
    //   最后一条 assistant（活跃尾部）必须逐字保留。
    const target = asstIdx[asstIdx.length - 2]
    const tailA = asstIdx[asstIdx.length - 1]
    if (span.startIdx !== target) bad++
    if (span.endIdx !== target + events[target].toolCallCount) bad++
    if (span.endIdx >= tailA) bad++          // 尾巴绝不许被咬
    // 中途截断：倒数第二步缺最后一条 result，而尾步完好 ⇒ 必须优雅回退 null。
    //   （不能只删除末尾——删了尾步，选择器会改去剪更早的组，考不到"未闭合保持原文"。）
    const k2 = events[target].toolCallCount
    if (k2 > 0 && asstIdx.length >= 3) {
      const cut = events.slice(0, target + k2 - 1).concat(events.slice(target + k2))
      if (selectBalancedSpan(cut) === null) unterminatedNull++
    }
  }
  ok('随机良构表面 400 例全部产出合法极小尾组（bad=' + bad + '）', bad === 0)
  ok('随机截断的未闭合表面全部回退 null（' + unterminatedNull + ' 例）', unterminatedNull >= 100)
}

// ══ 9. eventsFromSurface 适配器 ═══════════════════════════
{
  const store = new Map([[1, { seq: 1, type: 'user/message' }], [2, { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } }]])
  const evs = eventsFromSurface([1, 2], (s) => store.get(s))
  eq('适配器条数', evs.length, 2)
  eq('适配器抽出 tool-call 数', evs[1].toolCallCount, 1)
  eq('表面与日志不一致 ⇒ null', eventsFromSurface([1, 7], (s) => store.get(s)), null)
  eq('死引用（eventAt 抛错）⇒ null', eventsFromSurface([1], () => { throw new Error('boom') }), null)
}

console.log('balanced-span.js 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)