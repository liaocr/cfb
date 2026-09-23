/**
 * DSH Settler 发射器流水线（agent/pre-step 全链路）。
 *
 *   感知 → 动态门槛 → 平衡选择 → 混合组装 → 合规发射
 *
 * 合规发射的形状逐字对齐官方 dsh-compaction-basic/lib/index.js:621-632：
 *
 *   session.append("user/message", checkpointMessage, {
 *     surfaceOp: { op: "replace", startSeq, endSeq },
 *     sourceEventSeqs: [...shadowedSeqs]
 *   })
 *
 * 三条铁律：
 *   ① 任何异常、任何异常读数、任何自检不过 ⇒ **什么都不做**（D3′ 保持原文）；
 *   ② 绝不丢信息：归档失败就内联，绝不让工具结果凭空消失；
 *   ③ source.kind 必须是 'plugin'，**绝不是 'user'** —— 否则会污染
 *      findLastUserMessage() 的「用户原话」机械注入。
 *
 * @module dsh-cot-form-b/emitter
 */

import { selectBalancedSpan, verifyBalancedSpan, eventsFromSurface } from './balanced-span.js'
import { minRawCharsFor, bandNameFor } from './headroom.js'
import { verdictOf } from './imperative.js'
import { compactToolText } from './state-memory.js'
import crypto from 'node:crypto'

export const LEDGER_OPEN = '<cot-ledger>'
export const LEDGER_CLOSE = '</cot-ledger>'
export const LEDGER_PREAMBLE =
  '[自动生成的工作记忆看板 · 非用户发言] 以下内容由系统紧凑化早前一段推理与工具执行得到；' +
  '原文已存入 CAS（句柄见下），折叠区间不再逐字重放，需要时按句柄回查。'

/** 估算兜底用的字符/token 比（无计量服务时才用，且会落 trace 标明来源）。 */
const CHARS_PER_TOKEN = 4

/**
 * ① 感知：读此刻物理水位。任何一步拿不到就诚实地把来源记下来，绝不假装知道。
 * @returns { usedTokens, contextWindow, source } source ∈ meter|estimated|none
 */
export function readPressure(deps) {
  const { session, ctx, surfaceChars } = deps
  let contextWindow
  try { contextWindow = session && session.requestContext && session.requestContext() && session.requestContext().contextWindow } catch { contextWindow = undefined }
  if (!Number.isFinite(contextWindow)) contextWindow = undefined

  // 首选官方计量服务
  try {
    const meter = ctx && typeof ctx.get === 'function' ? ctx.get('tokenMeter', false) : null
    if (meter && typeof meter.measure === 'function') {
      const m = meter.measure(session)
      const used = m && (m.usedTokens != null ? m.usedTokens : (m.pressureTokens != null ? m.pressureTokens : m.surfaceTokens))
      if (Number.isFinite(used) && Number.isFinite(contextWindow)) return { usedTokens: used, contextWindow, source: 'meter' }
    }
  } catch { /* 降级，不抛 */ }

  // 降级：字符估算（只在窗口可读时才有意义）
  if (Number.isFinite(contextWindow) && Number.isFinite(surfaceChars)) {
    return { usedTokens: Math.ceil(surfaceChars / CHARS_PER_TOKEN), contextWindow, source: 'estimated' }
  }
  return { usedTokens: undefined, contextWindow: contextWindow, source: 'none' }
}

/**
 * ④ 混合组装（D2′）：短工具结果内联，长工具结果进 CAS 留句柄。
 * 归档失败一律内联 —— 永不因为存储问题让内容消失。
 * @param toolResults [{ seq, text }]
 * @param archive async (text, info) => handle | null
 */
// ⛔ 真机 tool/result 提取器（11,802 条实测，命中率 100%）。**唯一实现**，
//   线上接线与离线重放必须共用它 —— 早期版本在 index.js 里内联了另一份、读错了位置
//   （读 data.content，而真机根本不存在这个字段），导致全部工具结果被静默丢弃。
//   真机形状：tool/result → data.message.content[] = [{ type:'tool-result', toolCallId,
//             isError, content:[{ type:'text', text }] }]
//   任何不认识的块一律返回 null（触发上层拒发），绝不静默丢内容。
export function toolTextFromEvent(ev) {
  const blocks = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(blocks)) return null
  let out = ''
  for (const b of blocks) {
    if (!b || b.type !== 'tool-result') return null
    const inner = b.content
    if (typeof inner === 'string') { out += inner; continue }
    if (!Array.isArray(inner)) return null
    for (const ib of inner) {
      if (!ib) continue
      if (ib.type !== 'text') return null
      out += typeof ib.text === 'string' ? ib.text : ''
    }
  }
  return out
}

export async function buildLedger(deps) {
  const { distilled, toolResults = [], maxInlineChars = 2000, archive, trace, cleanView } = deps
  const parts = [String(distilled == null ? '' : distilled).trim()]
  let inlined = 0, archived = 0, archiveFailed = 0, viewSaved = 0
  // ★★ 2026-09-22 证据边界（评审第 5 点）★★
  //   清洗只作用于**模型输入视图**（内联进 ledger 的那份）；
  //   **CAS 归档一律拿原文** —— 原始证据必须字节保真。
  //   两者的分界就在这个循环里：先算 view，归档仍用 text。
  const toView = (t) => {
    if (cleanView === false) return t
    const c = compactToolText(t)
    viewSaved += c.saved
    return c.text
  }
  for (const tr of toolResults) {
    const text = String(tr && tr.text != null ? tr.text : '')
    if (text.length <= maxInlineChars) {
      parts.push('[工具结果 seq=' + tr.seq + ']\n' + toView(text))
      inlined++
      continue
    }
    let handle = null
    // ⚠ 归档用原文（text），绝不用清洗后的视图
    if (typeof archive === 'function') {
      try { handle = await archive(text, { seq: tr.seq, chars: text.length }) } catch { handle = null }
    }
    if (handle) {
      parts.push('[工具结果 seq=' + tr.seq + ' · ' + text.length + ' 字符 · 原文 ' + handle + ']')
      archived++
    } else {
      // 归档失败 ⇒ 原文内联（信息不丢铁律），但仍走视图清洗
      parts.push('[工具结果 seq=' + tr.seq + ']\n' + toView(text))
      archiveFailed++
    }
  }
  const body = parts.filter((p) => p.length > 0).join('\n\n')
  // D8 精神：**非阻断度量**。只记录祈使句命中，绝不改一个字、绝不阻断发射。
  // 合闸判据：连续若干轮 ledger-imperative 的 verdict=clean 之前，不带电。
  const imp = verdictOf(body)
  if (typeof trace === 'function') {
    trace('ledger-built', { inlined, archived, archiveFailed, chars: body.length, viewSaved })
    trace('ledger-imperative', { verdict: imp.verdict, count: imp.count, ids: imp.ids.join(',') })
  }
  return { text: body, inlined, archived, archiveFailed }
}

/**
 * 收集表面上【全部】由本插件产生的看板 seq（供"看板单例自吞噬"使用）。
 * 只读，零副作用；没有则返回 []。
 *
 * ★ 为什么是"全部"而不是"最后一条"：
 *   只吞最新一条时，每步 = +1 新看板 −1 旧看板，**净变化为 0**，历史遗留的看板
 *   会永久钉在表面上（09-17 真机实测：连续 user 游程 ≈ 看板数，近似 1:1）。
 *   要兑现【表面上本插件看板恒 ≤ 1】这条硬不变量，必须一次吞干净。
 *   吞并范围**只限本插件自己的产物**，绝不触及用户/模型写下的任何原文。
 */
function ownBoardSeqs(events, pluginName) {
  const found = []
  if (!Array.isArray(events)) return found
  for (const e of events) {
    if (!e || e.type !== 'user/message') continue
    const src = e.raw && e.raw.data && e.raw.data.source
    if (src && src.kind === 'plugin' && src.plugin === pluginName) found.push(e.seq)
  }
  return found
}

/**
 * ⑤ 合规发射。append 前用**实时**表面复检一次平衡（防选择与发射之间表面漂移）。
 * @returns { emitted, reason, returnedSeq? }
 */
export function emitCheckpoint(deps) {
  const { session, span, ledgerText, pluginName = 'cot-form-b', dryRun, trace, summaryRecord = true } = deps
  if (!span || !Number.isSafeInteger(span.startSeq) || !Number.isSafeInteger(span.endSeq) || span.startSeq > span.endSeq || span.startSeq < 0 || !Array.isArray(span.shadowedSeqs)) {
    if (trace) trace('emit-refused-range', { startSeq: span?.startSeq, endSeq: span?.endSeq })
    return { emitted: false, reason: 'invalid-range' }
  }
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: LEDGER_PREAMBLE + '\n\n' + LEDGER_OPEN + '\n' + ledgerText + '\n' + LEDGER_CLOSE }],
    // ⚠ 绝不能是 { kind: 'user' } —— 见模块头 ③
    source: Object.freeze({ kind: 'plugin', plugin: pluginName }),
  }
  const meta = { startSeq: span.startSeq, endSeq: span.endSeq, shadowed: span.shadowedSeqs.length }
  if (dryRun) { if (trace) trace('emit-dry-run', meta); return { emitted: false, reason: 'dry-run' } }

  // 实时复检
  try {
    const nodes = session && session.surface && session.surface.nodes
    const events = Array.isArray(nodes) && typeof session.eventAt === 'function'
      ? eventsFromSurface(nodes, (s) => session.eventAt(s))
      : null
    // 失败安全：读不到实时表面就不发射（宁可不做，也不冒把表面写坏的风险）
    if (!events) { if (trace) trace('emit-refused-no-live-surface', meta); return { emitted: false, reason: 'live-unavailable' } }
    // ★ 复检必须用与首次选择【完全相同】的尾部宽度与吞并目标，否则会误报 surface-drifted
    const liveAbsorb = ownBoardSeqs(events, pluginName)
    const live = selectBalancedSpan(events, {
      targetSeq: span.targetSeq, allowWholeSurface: false,
      keepTail: span.keepTail,
      absorbSeqs: liveAbsorb,
    })
    if (!live) { if (trace) trace('emit-refused-live-unbalanced', meta); return { emitted: false, reason: 'live-unbalanced' } }
    const v = verifyBalancedSpan(events, live)
    if (!v.ok) { if (trace) trace('emit-refused-live-verify', Object.assign(meta, { why: v.reason })); return { emitted: false, reason: 'live-verify:' + v.reason } }
    // 选择与发射之间表面漂移过 ⇒ 实时重选结果必须与当初选出的逐字一致，否则一字不发
    if (JSON.stringify(live.shadowedSeqs) !== JSON.stringify(span.shadowedSeqs)) {
      if (trace) trace('emit-refused-surface-drifted', meta)
      return { emitted: false, reason: 'surface-drifted' }
    }
  } catch (e) {
    if (trace) trace('emit-refused-live-threw', Object.assign(meta, { error: String((e && e.message) || e) }))
    return { emitted: false, reason: 'live-check-threw' }
  }

  // ⛔⛔ 绝不能在这里 append 单独的 compaction/summary —— 2026-09-17 生产会话锁死的根因。
  //
  // 惨案现场：旧代码发的是平铺 { plugin, start, end, shadowedSeqs }。DSH 投影引擎
  //   assertCurrentSurfaceSpan (dsh-session-persistence-jsonl/lib/worker.cjs:8690-8696):
  //     const range = data['shadowedRange']
  //     const start = surface.indexOf(range.start)   // range === undefined ⇒ 抛
  //   ⇒ "Cannot read properties of undefined (reading 'start')" ⇒ 整个会话锁死。
  //
  // 而且【仅仅补上 shadowedRange 也救不回来】—— 单发 summary 在协议上就是非法的。
  // 官方契约要求三件套严格配平 (worker.cjs:8561-8588)：
  //   compaction/start   { compactionId, turn }        ← 与已有 compaction 重叠即抛
  //   compaction/summary { compactionId, summary, shadowedRange{start,end},
  //                        shadowedSeqs, shadowedTokenCount }  ← 无 open 即抛；
  //                                                              shadowedSeqs 必须逐字等于表面切片
  //   compaction/end     { compactionId, turn }        ← turn 必须等于 open.turn；
  //                                                      无 error 时须已 summarized
  // 其中 turn 必须与 openTurn 全等；且 start 一旦成功就必须保证 end 配对，否则会给
  // 后续官方 compaction 留下 "overlaps an open compaction" 的定时炸弹。
  //
  // 结论：溯源记录【停发】。核心压缩（user/message + surfaceOp replace）完全不依赖它 ——
  // worker.cjs:8592-8595 的 compaction-owner 校验只对 source.plugin === 'compact' 生效，
  // 我方 plugin 是 'cot-form-b' ⇒ 零依赖、零额外风险。
  // 待把 compactionId/turn 三件套实现完整后再开（开关 summaryRecord 保留未用）。
  void summaryRecord
  const sources = [...span.shadowedSeqs]
  try {
    const out = session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq },
      sourceEventSeqs: sources,
    })
    if (trace) trace('emit-replaced', Object.assign(meta, { returnedSeq: out && out.seq }))
    return { emitted: true, returnedSeq: out && out.seq }
  } catch (e) {
    if (trace) trace('emit-threw', Object.assign(meta, { error: String((e && e.message) || e) }))
    return { emitted: false, reason: 'threw:' + String((e && e.message) || e) }
  }
}

/**
 * 全链路编排。任何一步不满足即返回 no-op，永不抛错。
 * @param deps { session, ctx, cfg, rawOf, toolTextOf, archive, trace, awaitDistilled }
 */
export async function runPreStepEmit(deps) {
  const { session, ctx, cfg = {}, rawOf, toolTextOf, archive, trace } = deps
  const t = typeof trace === 'function' ? trace : () => {}
  try {
    if (!session || typeof session.append !== 'function') return { emitted: false, reason: 'no-session' }
    const nodes = session.surface && session.surface.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) { t('emit-no-surface'); return { emitted: false, reason: 'no-surface' } }
    const events = typeof session.eventAt === 'function' ? eventsFromSurface(nodes, (s) => session.eventAt(s)) : null
    if (!events) { t('emit-surface-log-mismatch'); return { emitted: false, reason: 'surface-mismatch' } }

    // ③ 平衡整步锁闭
    // ★ 2026-09-17 路线 A：活跃尾部宽度必须从配置进来（缺省 1）。
    //   历史事故：这里曾用"最后一条 assistant"作锚点 ⇒ 当轮回答被换成 user 检查点
    //   ⇒ 模型看不到自己答过 ⇒ 无限重答。见 balanced-span.js 顶部注释。
    // ★★ 看板单例自吞噬：把上一条本插件看板一并纳入遮蔽区间 ⇒ 表面恒 ≤ 1 份看板
    const boards = ownBoardSeqs(events, 'cot-form-b')
    const span = selectBalancedSpan(events, {
      allowWholeSurface: false,
      keepTail: cfg.keepTail,
      absorbSeqs: boards,
    })
    if (boards.length > 0) t('emit-absorb-boards', {
      boards: boards.length, seqs: boards.join(','),
      inSpan: span ? boards.every((q) => span.shadowedSeqs.includes(q)) : false,
    })
    if (!span) { t('emit-no-balanced-span'); return { emitted: false, reason: 'no-span' } }

    // 取这一组的原始推理与工具结果
    // ★ 有了"吞并旧看板"之后，span.startIdx 可能指向一条 user/message（旧看板），
    //   而推理原文在【目标那条 assistant】身上 ⇒ 必须按 targetSeq 取，不能按 startIdx。
    const last = events.find((x) => x.seq === span.targetSeq) || events[span.startIdx]
    const raw = typeof rawOf === 'function' ? await rawOf(last.raw, last.seq) : null
    if (!raw) { t('emit-no-raw', { seq: last.seq }); return { emitted: false, reason: 'no-raw' } }

    if (deps.requireUniqueRaw) {
      for (const ev of events) {
        if (ev.seq === last.seq || ev.type !== 'assistant/message') continue
        const other = await rawOf(ev.raw, ev.seq)
        if (other === raw) { t('emit-ambiguous-raw', { targetSeq: last.seq, otherSeq: ev.seq }); return { emitted: false, reason: 'ambiguous-raw' } }
      }
    }

    // ① 感知 + ② 动态门槛
    const surfaceChars = typeof session.surfaceChars === 'number' ? session.surfaceChars : undefined
    const pressure = readPressure({ session, ctx, surfaceChars })
    const minChars = minRawCharsFor(pressure.usedTokens, pressure.contextWindow, { staticMinRawChars: cfg.staticMinRawChars })
    t('emit-gate', { rawChars: raw.length, minChars, band: bandNameFor(minChars), pressureSource: pressure.source })
    if (raw.length < minChars) { t('emit-below-threshold'); return { emitted: false, reason: 'below-threshold' } }

    // ④ 伴生提纯收网（未就绪即保持原文；宽限由调用方在 pre-step 处用 waitMs 控制）
    const pending = typeof deps.awaitDistilled === 'function' ? await deps.awaitDistilled(raw, cfg.graceMs) : null
    if (!pending || !pending.ok || !pending.text) { t('emit-distill-not-ready'); return { emitted: false, reason: 'distill-not-ready' } }

    // ④′ 混合组装（D2′）
    // ⛔ 信息不丢硬闸（D2′ 红线）：span 里的每一条 tool/result 都【必须】能被提取出来。
    //   否则它既进不了看板、又被 replace 遮蔽掉 ⇒ 内容凭空消失。
    //   拿不准就整块拒发（D3′ 保持原文），绝不静默丢。
    let toolResultEvents = 0
    for (let i = span.startIdx; i <= span.endIdx; i++) if (events[i].type === 'tool/result') toolResultEvents++
    const toolResults = []
    if (toolResultEvents > 0) {
      if (typeof toolTextOf !== 'function') {
        t('emit-no-tool-extractor', { count: toolResultEvents })
        return { emitted: false, reason: 'tool-result-unreadable' }
      }
      for (let i = span.startIdx; i <= span.endIdx; i++) {
        const ev = events[i]
        if (ev.type !== 'tool/result') continue
        const text = await toolTextOf(ev.raw, ev.seq)
        if (text == null) {
          t('emit-tool-result-unreadable', { seq: ev.seq })
          return { emitted: false, reason: 'tool-result-unreadable' }
        }
        toolResults.push({ seq: ev.seq, text: String(text) })
      }
    }
    const ledger = await buildLedger({
      distilled: pending.text, toolResults,
      maxInlineChars: cfg.maxInlineToolResultChars, archive, trace: t,
    })

    if (typeof deps.validatePending === 'function' && !deps.validatePending()) {
      t('emit-stale-distill'); return { emitted: false, reason: 'stale-distill' }
    }
    // ⑤ 合规发射
    return emitCheckpoint({
      session, span, ledgerText: ledger.text,
      pluginName: cfg.pluginName, dryRun: cfg.dryRun, trace: t,
      summaryRecord: cfg.emitterSummaryRecord, targetSeq: last.seq,
    })
  } catch (e) {
    t('emit-error', { error: String((e && e.message) || e) })
    return { emitted: false, reason: 'error' }
  }
}
