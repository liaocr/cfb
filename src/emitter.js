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
 *   ③ source.kind 必须是 'plugin'，**绝不是 'user'** —— 否则看板会被当成真人消息
 *      （state-memory 的来源判定据此区分人类要求与插件生成的记忆）。
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

/**
 * ★★ 2026-09-24 P1：让归档行「可检索」★★
 *
 * 问题（真机观测）：归档行此前只有 `[工具结果 seq=N · X 字符 · 原文 art://…]` ——
 *   · 没有工具名、没有调用参数、没有内容样本 ⇒ 模型看到一排句柄，**无从判断哪一根有用**；
 *   · 而回读一次的代价 ≈ 把整块原文按全价重新吃回上下文（见 docs/AUDIT-V11.5.md 的保本算术）。
 * 于是「该不该回读」这个决定只能靠猜 ⇒ 回看概率被人为抬高，压缩收益被读回成本吃掉。
 *
 * 现在每一条归档的工具结果后面补一段（**独立成段**，不碰句柄行本身）：
 *
 *   ↳ 工具 bash · 参数 rg -n "foo" src/
 *   ↳ 样本 src/foo.js:12: export function foo(… 〔省略 35,800 字符〕
 *
 * 要害是**格式约束**：句柄行必须是单独一段且逐字不变 —— `flattenCarriedBoard()` 只保留
 * 「单行且含 · 原文 」的段，把样本挂在同一段里会在旧看板被吞并时**连句柄一起丢掉**。
 */

/** 工具结果块的真机形状：`{ type:'tool-result', toolCallId, isError, content:[{type:'text',text}] }`。 */
export function toolResultMetaFromEvent(ev) {
  const blocks = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(blocks)) return null
  for (const b of blocks) if (b && b.type === 'tool-result') return { toolCallId: b.toolCallId || b.id || null, isError: b.isError === true }
  return null
}

/**
 * 从 span 内的 assistant 消息建立 `toolCallId → { name, args }` 索引。
 * 工具名不在 tool/result 块里（真机只在 tool-call 块里），所以必须回查调用侧。
 * 形状不认识 ⇒ 跳过（**绝不猜**：猜错的名字比没有名字更坏）。
 */
export function toolCallsFromSpan(events, span) {
  const out = new Map()
  if (!Array.isArray(events) || !span) return out
  for (let i = span.startIdx; i <= span.endIdx; i++) {
    const ev = events[i], d = ev && ev.raw && ev.raw.data
    const blocks = d && d.message && Array.isArray(d.message.content) ? d.message.content : null
    if (!blocks) continue
    for (const b of blocks) {
      if (!b || b.type !== 'tool-call') continue
      const id = b.id || b.toolCallId || null
      if (!id) continue
      const args = b.args != null ? b.args : b.arguments
      out.set(id, { name: typeof b.name === 'string' && b.name ? b.name : null, args })
    }
  }
  return out
}

/** 压成单行、限长（用于「参数摘要」与「内容样本」，两处都绝不允许换行逃逸）。 */
export function oneLine(s, max) {
  const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  if (!(max > 0) || flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** 参数摘要：只取一层（够模型对上"这是哪次调用"），失败绝不抛。 */
export function argsSummary(args, max = 96) {
  if (args == null) return ''
  if (typeof args === 'string') return oneLine(args, max)
  try { return oneLine(JSON.stringify(args), max) } catch { return '' }
}

// 错误特征只扫**头尾**：36K 日志中间夹一句 "error" 不能把整块判成错误现场。
const ERR_RE = /(?:^|[\s'"`([{<]) ?(?:Error|Exception|Panic|Traceback|FATAL|Fatal|FAIL(?:ED|URE)?|AssertionError|SyntaxError|TypeError|ReferenceError|RangeError|E[A-Z]{2,6}Err(?:or)?|ERR_[A-Z_]+|EACCES|ENOENT|EPERM|EADDRINUSE|denied|refused|not found|no such file)\b/

/**
 * ★ P1 选择性归档分类（纯函数，无副作用）。
 *
 * 判据只影响**视图**（是否附摘录），**不影响归档**：原文一律字节保真进 CAS。
 * 这么设计是为了同时守住两条约束 —— ①信息不丢（归档永远有全量）；②回看概率（该回看的先给一眼）。
 *
 *   error  → 头尾任一出现错误特征 ⇒ 附摘录（错误现场是模型下一步必然要引用的东西）
 *   recent → 最近的 N 条工具结果 ⇒ 附摘录（模型刚跑完，正在引用）
 *   dump   → 低熵大块（重复行 / 超长单行 / 日志转储）⇒ 不附摘录，只留样本
 *   plain  → 其余 ⇒ 不附摘录
 */
export function classifyToolResult(o = {}) {
  const text = String(o.text == null ? '' : o.text)
  const head = text.slice(0, 2000), tail = text.length > 3500 ? text.slice(-1500) : ''
  if (o.isError === true || ERR_RE.test(head) || (tail && ERR_RE.test(tail))) return { kind: 'error', excerpt: true }
  // ⚠ dump 判定必须排在 recent 之前：一坨重复行转储就算刚跑完也不值得占视图预算
  //   （摘录它 = 白花几百字符买一堆 "repeated log line"）。
  const sample = text.slice(0, 20000)
  const lines = sample.split('\n')
  if (lines.length >= 40) {
    const uniq = new Set(lines.map((l) => l.trim()))
    if (uniq.size / lines.length < 0.15) return { kind: 'dump', excerpt: false }
  } else if (lines.length <= 3 && text.length > 8000) return { kind: 'dump', excerpt: false }
  if (o.recent === true) return { kind: 'recent', excerpt: true }
  return { kind: 'plain', excerpt: false }
}

/**
 * 头尾摘录：中间用显式省略标记挖空，并写明**可按句柄取回**。
 * ⚠ 这是**视图**构造，不是归档 —— 归档永远拿原文（见 buildLedger 的 toView 边界注释）。
 */
export function excerptText(text, budget) {
  const t = String(text == null ? '' : text)
  if (!Number.isFinite(budget) || budget <= 0 || t.length <= budget) return null
  const headLen = Math.max(0, Math.floor(budget * 0.6))
  const tailLen = Math.max(0, budget - headLen)
  const head = t.slice(0, headLen)
  const tail = tailLen > 0 ? t.slice(-tailLen) : ''
  const elided = t.length - head.length - tail.length
  return head + '\n〔… 省略 ' + elided + ' 字符；原文可按句柄取回 …〕\n' + tail
}

/**
 * ★ 错误摘录：**错误行 + 少量上下文**，而不是头尾截断。
 *
 * 血泪理由：错误现场几乎总在原文**中部**（前面是进度输出、后面是收尾输出），
 * 头尾截断会正好把唯一有价值的那几行挖掉 —— 那样摘录不但没用，还白占视图预算。
 */
export function errorExcerpt(text, budget) {
  const lines = String(text == null ? '' : text).split('\n')
  const hits = []
  for (let i = 0; i < lines.length && hits.length < 40; i++) if (ERR_RE.test(lines[i])) hits.push(i)
  if (!hits.length) return null
  const picked = new Map()
  for (const h of hits) for (let j = Math.max(0, h - 2); j <= Math.min(lines.length - 1, h + 3); j++) picked.set(j, lines[j])
  const idx = [...picked.keys()].sort((a, b) => a - b)
  let chars = 0, prev = null
  const out = []
  for (const i of idx) {
    if (prev !== null && i !== prev + 1) {
      const skipped = i - prev - 1
      const mark = '〔… 省略 ' + skipped + ' 行 …〕'
      if (chars + mark.length > budget) break
      out.push(mark); chars += mark.length + 1
    }
    const l = lines[i]
    if (chars + l.length > budget) { out.push('〔… 余下 ' + (idx.length - out.length) + ' 行已省略，可按句柄取回 …〕'); break }
    out.push(l); chars += l.length + 1; prev = i
  }
  return out.length ? out.join('\n') : null
}

/** 一条归档工具结果的富化段（样本 + 可选摘录）。返回 null ⇒ 不附加任何东西。 */
export function enrichArchivedToolLine(o = {}) {
  const { seq, text, name, args, kind, excerpt, sampleChars, excerptChars } = o
  const bits = []
  if (name) bits.push('工具 ' + oneLine(name, 40))
  const a = argsSummary(args, 96)
  if (a) bits.push('参数 ' + a)
  if (kind) bits.push('类别 ' + kind)
  const lines = []
  if (bits.length) lines.push('↳ ' + bits.join(' · '))
  const head = oneLine(text, sampleChars > 0 ? sampleChars : 0)
  if (head) lines.push('↳ 样本 ' + head)
  if (excerpt) {
    // 错误现场走「命中行 + 上下文」；其余走头尾。两者都是视图，归档一律原文。
    const isErr = kind === 'error'
    const ex = isErr ? (errorExcerpt(text, excerptChars) || excerptText(text, excerptChars))
      : excerptText(text, excerptChars)
    if (ex) lines.push('↳ 摘录（原文 ' + String(text).length + ' 字符，' + (isErr ? '错误行 + 上下文' : '头尾') + '）\n' + ex)
  }
  return lines.length ? lines.join('\n') : null
}

/**
 * ★ 2026-09-23 覆盖完整性：整段 replace 遮蔽的不只是 reasoning 与 tool/result。
 *   被吞并的旧看板正文、区间内每条 assistant 的**可见回答**（text 块）、tool-call 的
 *   name+args 此前都不在 ledger 里 ⇒ replace 后从模型视野里凭空消失（哨兵复现：
 *   OLD_BOARD / VISIBLE_ANSWER / ARGS 三类全丢）。现在由 collectSpanCarry() 抽出，
 *   与 tool/result 走同一条「短内联 / 长归档 / 归档失败内联」通路。
 *   目标 assistant 的 reasoning 由 distilled 摘要代表；区间内其它 reasoning 与真人 user 内容也必须保留。
 *
 * @returns { boards, reasoning, userInputs, answers, calls } 或 null（形状不认识 ⇒ 拒发）
 */
/** carry 段落标签（buildLedger 写入、flattenCarriedBoard 识别）。 */
const CARRY_LABELS = ['早前看板', '早前推理', '用户原话', '早前回答', '工具调用', '工具结果']
const CARRY_HEAD_RE = new RegExp('^\\[(' + CARRY_LABELS.join('|') + ') seq=\\d+(?: · \\d+ 字符 · 原文 \\S+)?\\]$')

/**
 * 把上一轮看板正文压平：内联的 carry 段整段去掉，只留「摘要正文」与「归档句柄行」。
 * 幂等：对已压平文本再压平结果不变。纯函数。
 */
export function flattenCarriedBoard(body) {
  const paras = String(body || '').split('\n\n')
  const kept = []
  for (const p of paras) {
    const first = p.split('\n', 1)[0].trim()
    if (!CARRY_HEAD_RE.test(first)) { kept.push(p); continue }
    // 句柄行（单行、含 · 原文 art://）保留；内联正文段整段丢弃
    if (first.includes(' · 原文 ') && p.trim() === first) kept.push(p)
  }
  return kept.join('\n\n')
}

export function collectSpanCarry(events, span, opts = {}) {
  const pluginName = opts.pluginName || 'cot-form-b'
  const out = { boards: [], reasoning: [], userInputs: [], answers: [], calls: [] }
  if (!Array.isArray(events) || !span) return out
  for (let i = span.startIdx; i <= span.endIdx; i++) {
    const ev = events[i]
    const raw = ev && ev.raw
    const d = raw && raw.data
    if (ev.type === 'user/message') {
      const src = d && d.source
      const blocks = d && d.message && Array.isArray(d.message.content) ? d.message.content : (Array.isArray(d && d.content) ? d.content : null)
      if (!blocks) return null
      let text = ''
      for (const b of blocks) { if (!b || b.type !== 'text') return null; text += typeof b.text === 'string' ? b.text : '' }
      if (!(src && src.kind === 'plugin' && src.plugin === pluginName)) {
        // 任意非插件 user/message 若落入替换区间，显式带走；不能靠「通常不会发生」丢真人输入。
        if (text.trim()) out.userInputs.push({ seq: ev.seq, text: text.trim() })
        continue
      }
      const o = text.indexOf(LEDGER_OPEN), c = text.lastIndexOf(LEDGER_CLOSE)
      const body = (o >= 0 && c > o) ? text.slice(o + LEDGER_OPEN.length, c) : text
      // 去掉已嵌套 carry，防止跨轮线性累积。
      const flat = flattenCarriedBoard(body)
      if (flat.trim()) out.boards.push({ seq: ev.seq, text: flat.trim() })
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const blocks = d && d.message && Array.isArray(d.message.content) ? d.message.content : null
    if (!blocks) return null
    let answer = ''
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'reasoning') {
        // 目标推理由 distilled 摘要代表；区间内其它 assistant 推理也会被 replace，必须带走。
        if (ev.seq !== opts.targetSeq && typeof b.text === 'string' && b.text.trim()) out.reasoning.push({ seq: ev.seq, text: b.text.trim() })
        continue
      }
      if (b.type === 'text') { answer += typeof b.text === 'string' ? b.text : ''; continue }
      if (b.type === 'tool-call') {
        const name = b.name || b.toolName || '?'
        let args = b.args == null ? (b.arguments == null ? '' : b.arguments) : b.args
        if (typeof args !== 'string') { try { args = JSON.stringify(args) } catch { args = String(args) } }
        out.calls.push({ seq: ev.seq, text: (b.id || b.toolCallId || '') + ' ' + name + ' ' + args })
        continue
      }
      // 未识别的 assistant 内容形状（image/audio/refusal 等）不可静默丢失，保留原表面。
      return null
    }
    if (answer.trim()) out.answers.push({ seq: ev.seq, text: answer.trim() })
  }
  return out
}

/** Replace 前可读正文长度估算；char proxy，不是 tokenizer token 数。 */
export function countSpanSourceChars(events, span) {
  if (!Array.isArray(events) || !span) return 0
  let total = 0
  const payloadChars = (v) => {
    if (typeof v === 'string') return v.length
    if (Array.isArray(v)) return v.reduce((n, x) => n + payloadChars(x), 0)
    if (!v || typeof v !== 'object') return 0
    let n = 0
    if (typeof v.text === 'string') n += v.text.length
    if (typeof v.name === 'string') n += v.name.length
    if (typeof v.id === 'string') n += v.id.length
    if (v.args != null || v.arguments != null) {
      const a = v.args == null ? v.arguments : v.args
      if (typeof a === 'string') n += a.length
      else { try { n += JSON.stringify(a).length } catch { n += String(a).length } }
    }
    if (v.content != null) n += payloadChars(v.content)
    return n
  }
  for (let i = span.startIdx; i <= span.endIdx; i++) {
    const ev = events[i], d = ev && ev.raw && ev.raw.data
    const blocks = d && d.message && Array.isArray(d.message.content) ? d.message.content : Array.isArray(d && d.content) ? d.content : null
    if (!blocks) continue
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'reasoning' || b.type === 'text') total += typeof b.text === 'string' ? b.text.length : 0
      else if (b.type === 'tool-call' || b.type === 'tool-result') total += payloadChars(b)
    }
  }
  return total
}

/**
 * ★★ 2026-09-24 两阶段组装（评估态零副作用）★★
 *
 * 真机句柄恒为 28 字符：`'art://' + base64url(HMAC-SHA256)[0:22]`（与 birth.js:deriveArtHandle 同式）。
 * 计划态用**同长占位符** ⇒ 「闸门看到的字节数」≡「真机发射的字节数」，于是净收益判定可以整体
 * 挪到任何一次 CAS 写入之前。此前 buildLedger 边渲染边落盘 ⇒ no-net-savings / stale-distill /
 * dry-run 三条提前返回路径**都已经把原文写进了 CAS**，白白吃配额（dryRun 还是缺省值）。
 */
export const HANDLE_PLACEHOLDER = 'art://' + 'x'.repeat(22)
export const HANDLE_CHARS = HANDLE_PLACEHOLDER.length

/**
 * 句柄要安全地待在**单行**模型文本里。非字符串 / 空 / 带换行 / 长到不像句柄 ⇒ 一律当归档失败。
 * ⚠ 悬空句柄是这套架构唯一的静默失败模式：原文已被 replace 遮蔽，而文本里的地址谁也读不回。
 *   所以宁可回退内联（信息不丢），也绝不把 store 返回的任意值写进原文位。
 */
export function usableHandle(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 96 && !/[\r\n]/.test(h) ? h : null
}

const handleLine = (label, seq, text, handle) =>
  '[' + label + ' seq=' + seq + ' · ' + text.length + ' 字符 · 原文 ' + handle + ']'

/** 会话 id 的读取口径（archive 与读回验证必须**严格同源**，否则宿主所有权校验会拒发）。 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null
  return session.id || session.sessionId || null
}

/**
 * ④′ 混合组装。`planOnly: true` ⇒ 零 I/O：该归档的项换成同长占位句柄，待写项记进 `slots`。
 * 真机发射前用 commitLedgerPlan() 按 slots 落盘并回填真句柄。
 */
export async function buildLedger(deps) {
  const { distilled, toolResults = [], maxInlineChars = 2000, archive, trace, cleanView, carry } = deps
  const planOnly = deps.planOnly === true
  const maxCarryChars = Number.isFinite(deps.maxCarryChars) && deps.maxCarryChars >= 0 ? deps.maxCarryChars : 3000
  const parts = [String(distilled == null ? '' : distilled).trim()]
  const slots = []
  let inlined = 0, archived = 0, archiveFailed = 0, viewSaved = 0
  let carryChars = 0, carryInlineChars = 0, carryOverflow = false
  let carryBudgetOverflow = 0, carryItemOversize = 0
  // 被吞并旧看板正文 / 区间内可见回答 / 工具调用参数：同一条「短内联、长归档」通路
  // ★ 预算：carry 内联总量 ≤ maxCarryChars。超出的项**整体**归档为句柄（归档失败才内联，信息不丢）。
  //   目的：P1 补齐覆盖不能反过来把编译输入体量吹回去；增长必须可观测（trace carryChars）。
  if (carry) {
    const items = []
    for (const b of carry.boards || []) items.push(['早前看板', b])
    for (const r of carry.reasoning || []) items.push(['早前推理', r])
    for (const u of carry.userInputs || []) items.push(['用户原话', u])
    for (const a of carry.answers || []) items.push(['早前回答', a])
    for (const c of carry.calls || []) items.push(['工具调用', c])
    for (const [label, item] of items) {
      const text = String(item && item.text != null ? item.text : '')
      if (!text) continue
      carryChars += text.length
      const itemOversize = text.length > maxInlineChars
      const budgetExceeded = !itemOversize && carryInlineChars + text.length > maxCarryChars
      const fits = !itemOversize && !budgetExceeded
      if (fits) { parts.push('[' + label + ' seq=' + item.seq + ']\n' + text); inlined++; carryInlineChars += text.length; continue }
      carryOverflow = true
      if (itemOversize) carryItemOversize++
      if (budgetExceeded) carryBudgetOverflow++
      if (planOnly) { parts.push(handleLine(label, item.seq, text, HANDLE_PLACEHOLDER)); slots.push({ slotKey: slots.length, seq: item.seq, kind: label, text }); archived++; continue }
      let handle = null
      if (typeof archive === 'function') {
        try { handle = usableHandle(await archive(text, { seq: item.seq, chars: text.length, kind: label, slotKey: slots.length })) } catch { handle = null }
      }
      if (handle) { parts.push(handleLine(label, item.seq, text, handle)); archived++ }
      else { parts.push('[' + label + ' seq=' + item.seq + ']\n' + text); archiveFailed++; carryInlineChars += text.length }
    }
  }
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
  // ★ P1 选择性视图：富化段**独立成段**，句柄行保持单行逐字不变（否则 flattenCarriedBoard 会丢句柄）
  const sampling = deps.emitToolSample !== false
  const sampleChars = Number.isFinite(deps.toolSampleChars) ? deps.toolSampleChars : 120
  const excerptChars = Number.isFinite(deps.excerptChars) ? deps.excerptChars : 800
  const selective = deps.selectiveArchive !== false
  const callMap = deps.toolCalls instanceof Map ? deps.toolCalls : null
  let excerpted = 0, errorSeen = 0, dumpSeen = 0, enrichChars = 0, enrichParts = 0
  const enrichOf = (tr, text) => {
    if (!sampling) return null
    const meta = callMap && tr.toolCallId ? callMap.get(tr.toolCallId) : null
    const cls = selective ? classifyToolResult({ text, isError: tr.isError, recent: tr.recent }) : { kind: null, excerpt: false }
    if (cls.kind === 'error') errorSeen++
    if (cls.kind === 'dump') dumpSeen++
    if (cls.excerpt) excerpted++
    const enrich = enrichArchivedToolLine({
      seq: tr.seq, text, name: (meta && meta.name) || tr.name || null, args: meta && meta.args,
      kind: cls.kind, excerpt: cls.excerpt, sampleChars, excerptChars,
    })
    if (enrich) { enrichChars += enrich.length; enrichParts++ }
    return enrich
  }
  for (const tr of toolResults) {
    const text = String(tr && tr.text != null ? tr.text : '')
    if (text.length <= maxInlineChars) {
      parts.push('[工具结果 seq=' + tr.seq + ']\n' + toView(text))
      inlined++
      continue
    }
    if (planOnly) {
      parts.push(handleLine('工具结果', tr.seq, text, HANDLE_PLACEHOLDER))
      const planEnrich = enrichOf(tr, text)
      if (planEnrich) parts.push(planEnrich)
      slots.push({ slotKey: slots.length, seq: tr.seq, kind: null, text })
      archived++
      continue
    }
    let handle = null
    // ⚠ 归档用原文（text），绝不用清洗后的视图
    if (typeof archive === 'function') {
      try { handle = usableHandle(await archive(text, { seq: tr.seq, chars: text.length, slotKey: slots.length })) } catch { handle = null }
    }
    if (handle) {
      parts.push(handleLine('工具结果', tr.seq, text, handle))
      const enrich = enrichOf(tr, text)
      if (enrich) parts.push(enrich)
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
    // ★ toolResultLens：逐项长度分布（升序，最多留 32 项）。没有它，maxInlineToolResultChars
    //   这个门槛就只能拍脑袋 —— 原先只有总和，看不出「2000 以下 vs 以上」各有多少项。
    const lens = toolResults.map((x) => String(x && x.text != null ? x.text : '').length).sort((a, b) => a - b)
    // 分桶直方图：maxInlineToolResultChars(2000) 这个门槛此前**无从标定** —— 只有总和，看不出
    // 「多少项在门槛以下 / 多少项在 8K 以上」。四个桶正好对应四类处置（内联 / 归档 / 归档+摘录 / 大块）。
    const buck = (n) => (n <= 2000 ? 0 : n <= 8000 ? 1 : n <= 32000 ? 2 : 3)
    const buckets = [0, 0, 0, 0]
    for (const n of lens) buckets[buck(n)]++
    trace('ledger-built', { inlined, archived, archiveFailed, chars: body.length, ledgerChars: body.length, distilledChars: String(distilled == null ? '' : distilled).trim().length, toolResultChars: toolResults.reduce((n, x) => n + String(x && x.text != null ? x.text : '').length, 0), toolResultItems: toolResults.length, toolResultLens: lens.slice(0, 32).join(','), toolResultLensTruncated: lens.length > 32, toolResultLensMax: lens.length ? lens[lens.length - 1] : 0, toolResultBuckets: buckets.join('/'), excerpted, errorSeen, dumpSeen, enrichChars, enrichParts, archivePending: slots.length, planOnly, summaryFirst: true, viewSaved, carryChars, carryInlineChars, carryOverflow, carryBudgetOverflow, carryItemOversize, maxCarryChars })
    trace('ledger-imperative', { verdict: imp.verdict, count: imp.count, ids: imp.ids.join(',') })
  }
  return { text: body, inlined, archived, archiveFailed, slots, planOnly, enrichChars, enrichParts }
}

/**
 * 把计划落成现实：按 slots **顺序**写 CAS，成功后用真句柄重渲染一次。
 *
 * 只有一遍渲染逻辑（仍由 buildLedger 负责），所以回填靠"注入查表式 archive"完成 ——
 * 渲染路径与真机逐字一致，绝不会在计划态和发射态之间出现两种文本形状。
 *
 * ★ 重渲染后文本可能变长（某个写入失败 ⇒ 该项回退内联原文）⇒ 调用方【必须】重算净收益再决定发射。
 * @param deps { plan, ledgerDeps, archive, trace }
 */
export async function commitLedgerPlan(deps) {
  const { plan, ledgerDeps, archive, trace } = deps
  const slots = (plan && plan.slots) || []
  if (slots.length === 0) return { ...plan, writes: { pending: 0, ok: 0, failed: 0, chars: 0 } }
  const handles = new Map()
  let wroteChars = 0
  for (const s of slots) {
    let h = null
    if (typeof archive === 'function') {
      try { h = usableHandle(await archive(s.text, { seq: s.seq, chars: s.text.length, kind: s.kind, slotKey: s.slotKey })) } catch (e) { h = null }
    }
    if (h) { handles.set(s.slotKey, h); wroteChars += s.text.length }
  }
  const failed = slots.length - handles.size
  if (typeof trace === 'function') trace('ledger-archive-commit', { pending: slots.length, ok: handles.size, failed, wroteChars })
  const rebuilt = await buildLedger({
    ...ledgerDeps,
    planOnly: false,
    archive: async (text, meta) => {
      const k = meta && meta.slotKey
      return k != null && handles.has(k) ? handles.get(k) : null
    },
  })
  // 供发射前的读回验证：只交出**真正写成功**的那些句柄（失败的项已回退内联，没有地址可验）
  const written = slots.filter((s) => handles.has(s.slotKey)).map((s) => ({ seq: s.seq, kind: s.kind, handle: handles.get(s.slotKey), text: s.text }))
  return { ...rebuilt, written, writes: { pending: slots.length, ok: handles.size, failed, chars: wroteChars } }
}

/**
 * ★★ P0-2 句柄读回验证（发射前）★★
 *
 * 为什么必须验：句柄是本架构里**唯一**会进模型上下文的地址（`[工具结果 seq=N · X 字符 · 原文 art://…]`），
 * 而"写成功"不等于"读得回"——三者都会让它变成死指针：
 *   ① 跨 session（宿主所有权校验 resolve-owner-mismatch）；
 *   ② 配额驱逐 / TTL 过期（总 256MB、单作用域 64MB、retention:'session'）；
 *   ③ 公式漂移（store 换了派生方式，写进去的地址和文本里的地址不是一个东西）。
 * 死指针在模型侧表现为"照着地址取回，什么都没有"——静默、且无从归因。
 *
 * 判据（保守）：只有**正面证伪**（探针明确说"取不回"）才拦住发射；探针缺席/抛错 = 不可证 ⇒ 只记录。
 * 因为"拦"的代价是保持原文（安全但白花钱），"放"的代价是死指针（静默失效），所以不可证时不冒险拦。
 *
 * @returns {{ checked, resolved, unresolved, unverifiable, verdict }}
 */
export async function verifyHandles(deps) {
  const { written = [], probeHandle, sessionId, trace, traceTag = 'emit-handle-verify' } = deps
  const maxProbe = Number.isFinite(deps.maxProbe) ? Math.max(0, deps.maxProbe) : 2
  const list = written.slice(0, maxProbe)
  const out = { checked: 0, resolved: 0, unresolved: 0, unverifiable: 0, verdict: 'no-evidence', handles: [] }
  if (typeof probeHandle !== 'function') {
    if (typeof trace === 'function') trace(traceTag, { ...out, reason: 'no-read-api', pending: written.length })
    return out
  }
  for (const w of list) {
    out.checked++
    let r
    try { r = await probeHandle(w.handle, w.text, sessionId) } catch { r = null }
    if (r === true) out.resolved++
    else if (r === false) { out.unresolved++; out.handles.push(w.handle) }
    else out.unverifiable++
  }
  out.verdict = out.unresolved > 0 ? 'unresolvable' : out.resolved > 0 ? 'resolved' : 'unverifiable'
  if (typeof trace === 'function') trace(traceTag, { ...out, pending: written.length, maxProbe })
  return out
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
    // ★ 真机 invalid-range 2 次。最可能的成因：吞并的旧看板 seq（后发射 ⇒ 数值更大）落在区间左端，
    //   而表面顺序上它排在更早位置 ⇒ startSeq > endSeq。宿主 replace 是否接受非单调 seq 区间
    //   没有合约依据，这里**不放宽**；但把足够的诊断落 trace，让判断能基于数据而不是猜。
    if (trace) trace('emit-refused-range', { startSeq: span?.startSeq, endSeq: span?.endSeq, targetSeq: span?.targetSeq,
      shadowedSeqs: Array.isArray(span?.shadowedSeqs) ? span.shadowedSeqs.join(',') : null,
      startIsAbsorbedBoard: !!(span && Array.isArray(span.shadowedSeqs) && span.startSeq > span.endSeq && span.startSeq === span.shadowedSeqs[0]),
      monotonic: Array.isArray(span?.shadowedSeqs) ? span.shadowedSeqs.every((q, i, a) => i === 0 || a[i - 1] < q) : null })
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
  const emitAttemptId = crypto.randomUUID()
  const rawTrace = typeof trace === 'function' ? trace : () => {}
  const t = (tag, data = {}) => rawTrace(tag, { ...data, emitAttemptId })
  const tokenMeterSample = () => {
    try {
      const meter = ctx && typeof ctx.get === 'function' ? ctx.get('tokenMeter', false) : null
      if (!meter || typeof meter.measure !== 'function') return { tokens: null, source: 'unavailable' }
      const m = meter.measure(session)
      const tokens = m && (m.usedTokens ?? m.pressureTokens ?? m.surfaceTokens)
      return Number.isFinite(tokens) ? { tokens, source: 'host-token-meter' } : { tokens: null, source: 'invalid-meter-result' }
    } catch (e) { return { tokens: null, source: 'meter-error:' + String((e && e.message) || e) } }
  }
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
    const boards = ownBoardSeqs(events, cfg.pluginName || 'cot-form-b')
    let span = selectBalancedSpan(events, {
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
    let last = events.find((x) => x.seq === span.targetSeq) || events[span.startIdx]
    let raw = typeof rawOf === 'function' ? await rawOf(last.raw, last.seq) : null
    // ★ 真机 no-raw 5 次：缺省目标是一条没有 reasoning 的 assistant（纯 text / tool-call）。
    //   旧逻辑直接放弃；现在它与「未就绪」同等对待 —— 交给下面的候选反查，反查不到再放弃。
    if (!raw && typeof deps.isReady !== 'function') { t('emit-no-raw', { seq: last.seq }); return { emitted: false, reason: 'no-raw' } }

    // ★ 2026-09-23 迟到候选反查（机会饥饿修正）：
    //   缺省目标 = 倒数第 keepTail+1 条 assistant。若它的摘要尚未就绪，而更早的某条 assistant
    //   的迟到结果**已经就绪**，旧逻辑永远不会再回头问它 ⇒ 用户付过的那次编译到 TTL 直接作废。
    //   现在：先问缺省目标；未就绪时按「从旧到新」逐条询问尾部之前的其它 assistant，
    //   每条都重新用 targetSeq 走 selectBalancedSpan（keepTail / 人类围栏 / 平衡切点三道闸原样生效）。
    //   由调用方以 deps.isReady(raw) 提供**零等待**探测；未提供则保持旧行为。
    if (typeof deps.isReady === 'function' && (!raw || !(await deps.isReady(raw)))) {
      let picked = null
      for (let i = 0; i < events.length && !picked; i++) {
        const ev = events[i]
        if (ev.type !== 'assistant/message' || ev.seq === span.targetSeq) continue
        if (i >= span.tailStartIdx) break
        const r0 = typeof rawOf === 'function' ? await rawOf(ev.raw, ev.seq) : null
        if (!r0 || !(await deps.isReady(r0))) continue
        const alt = selectBalancedSpan(events, { targetSeq: ev.seq, allowWholeSurface: false, keepTail: cfg.keepTail, absorbSeqs: boards })
        // ★ 看板单例不变量：absorbSeqs 只向左吞并。回头选更早的目标时，既有看板可能在它**右侧**
        //   ⇒ 吞不到 ⇒ 表面同时两份看板。吞不干净就不 retarget（宁可这轮不发，绝不出两份）。
        if (alt && !boards.every((q) => alt.shadowedSeqs.includes(q))) { t('emit-retarget-refused-board-singleton', { candidate: ev.seq }); continue }
        if (alt) picked = { span: alt, ev, raw: r0 }
      }
      if (picked) {
        t('emit-retarget-ready', { from: span.targetSeq, to: picked.ev.seq, defaultHadRaw: !!raw })
        span = picked.span; last = picked.ev; raw = picked.raw
      } else if (!raw) { t('emit-no-raw', { seq: last.seq, retargetTried: true }); return { emitted: false, reason: 'no-raw' } }
    }

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
    t('emit-gate', { rawChars: raw.length, minChars, band: bandNameFor(minChars), pressureSource: pressure.source,
      // ★ 真 token 锚点（host-token-meter 来源时）：字符/账单换算与 A/B 对照全靠它，别只留 pressureSource
      ...(Number.isFinite(pressure.usedTokens) ? { usedTokens: pressure.usedTokens } : {}),
      ...(Number.isFinite(pressure.contextWindow) ? { contextWindow: pressure.contextWindow } : {}) })
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
      // ★ P1：工具名只在调用侧（tool-call 块）里 ⇒ 先建索引，再逐条回查
      const callMap = toolCallsFromSpan(events, span)
      const seqs = []
      for (let i = span.startIdx; i <= span.endIdx; i++) if (events[i].type === 'tool/result') seqs.push(events[i].seq)
      // 「最近 N 条」= 区间内最后的 N 条（模型刚跑完，大概率正在引用）
      const keepRecent = Number.isFinite(cfg.emitterKeepRecentToolResults) ? Math.max(0, cfg.emitterKeepRecentToolResults) : 2
      const recentSeqs = new Set(keepRecent > 0 ? seqs.slice(-keepRecent) : [])
      for (let i = span.startIdx; i <= span.endIdx; i++) {
        const ev = events[i]
        if (ev.type !== 'tool/result') continue
        const text = await toolTextOf(ev.raw, ev.seq)
        if (text == null) {
          t('emit-tool-result-unreadable', { seq: ev.seq })
          return { emitted: false, reason: 'tool-result-unreadable' }
        }
        const meta = toolResultMetaFromEvent(ev.raw)
        const call = meta && meta.toolCallId ? callMap.get(meta.toolCallId) : null
        toolResults.push({
          seq: ev.seq, text: String(text),
          name: (call && call.name) || null, toolCallId: meta ? meta.toolCallId : null,
          isError: !!(meta && meta.isError), recent: recentSeqs.has(ev.seq),
        })
      }
    }
    // ⛔ 覆盖完整性（2026-09-23）：被吞并旧看板 / 可见回答 / 工具调用参数也不许凭空消失。
    const carry = collectSpanCarry(events, span, { pluginName: cfg.pluginName || 'cot-form-b', targetSeq: last.seq })
    if (!carry) { t('emit-span-unreadable'); return { emitted: false, reason: 'span-unreadable' } }
    t('emit-carry', { boards: carry.boards.length, reasoning: carry.reasoning.length, userInputs: carry.userInputs.length, answers: carry.answers.length, calls: carry.calls.length })
    // ★★ 2026-09-24 两阶段组装：先零 I/O 出计划 ⇒ 所有闸门都跑在任何 CAS 写入之前。★★
    //   占位句柄与真句柄同长（HANDLE_CHARS=28），所以计划态的字节数就是发射态的字节数；
    //   「净收益不足 ⇒ 保持原文」这条判定从此不再需要先写一份永远不会被引用的 CAS 条目。
    const ledgerDeps = {
      distilled: pending.text, toolResults, carry,
      maxInlineChars: cfg.maxInlineToolResultChars, maxCarryChars: cfg.maxCarryChars, archive, trace: t,
      // ★ P1：让归档行可检索（工具名 + 参数 + 样本 + 选择性摘录）
      toolCalls: toolCallsFromSpan(events, span),
      selectiveArchive: cfg.emitterSelectiveArchive !== false,
      emitToolSample: cfg.emitterToolSampleChars !== 0,
      toolSampleChars: cfg.emitterToolSampleChars,
      excerptChars: cfg.emitterExcerptChars,
    }
    const plan = await buildLedger({ ...ledgerDeps, planOnly: true })
    // Never replace with a board that is larger or only trivially smaller than the text it hides.
    // On failure the original surface remains verbatim; no source text is discarded.
    const spanSourceChars = countSpanSourceChars(events, span)
    const explicitSourceChars = raw.length + toolResults.reduce((n, x) => n + String(x.text || '').length, 0) +
      ['boards', 'reasoning', 'userInputs', 'answers', 'calls'].reduce((n, k) => n + (carry[k] || []).reduce((m, x) => m + String(x.text || '').length, 0), 0)
    const sourceChars = Math.max(spanSourceChars, explicitSourceChars)
    const sourceEstimateFallback = sourceChars > spanSourceChars
    const minSavedChars = Math.max(Number.isFinite(cfg.emitterMinSavingsChars) ? cfg.emitterMinSavingsChars : 100,
      Math.ceil(sourceChars * (Number.isFinite(cfg.emitterMinSavingsRatio) ? cfg.emitterMinSavingsRatio : 0.05)))
    let netSavedChars = sourceChars - plan.text.length
    // 会话级 token 水位：复用本函数开头那次 readPressure 的读数（**不再多读一次** meter）。
    //   字符数不能当账单依据，这一行是把「字符节省」与「真 token」对上的唯一锚点。
    t('emit-net-savings', {
      sourceChars, spanSourceChars, sourceEstimateFallback, ledgerChars: plan.text.length, netSavedChars, minSavedChars,
      sourceUnit: 'chars-not-tokenizer-tokens', archivePending: plan.slots.length,
      // ★ P1 代价可见：富化段花掉的视图预算（买「模型自己判断要不要回读」）。
      //   净收益已扣掉它；netSavedIfHandleOnly 给出「完全不做富化」的上界，供 A/B 归因。
      enrichChars: plan.enrichChars || 0, enrichParts: plan.enrichParts || 0,
      netSavedIfHandleOnly: netSavedChars + (plan.enrichChars || 0),
      archiveMode: cfg.dryRun === true ? 'simulated' : 'planned',
      ...(Number.isFinite(pressure.usedTokens) ? { usedTokens: pressure.usedTokens } : {}), usedTokensSource: pressure.source,
    })
    if (sourceChars > 0 && netSavedChars < minSavedChars) {
      t('emit-no-net-savings', { sourceChars, ledgerChars: plan.text.length, netSavedChars, minSavedChars, archivePending: plan.slots.length, casWrites: 0 })
      t('emit-net-savings-result', { stage: 'gate', emitted: false, reason: 'no-net-savings', sourceChars, ledgerChars: plan.text.length, netSavedChars, casWrites: 0 })
      return { emitted: false, reason: 'no-net-savings', sourceChars, ledgerChars: plan.text.length, netSavedChars }
    }

    if (typeof deps.validatePending === 'function' && !deps.validatePending()) {
      t('emit-stale-distill')
      t('emit-net-savings-result', { stage: 'pre-emit', emitted: false, reason: 'stale-distill', sourceChars, ledgerChars: plan.text.length, netSavedChars, casWrites: 0 })
      return { emitted: false, reason: 'stale-distill' }
    }

    // ★ 评估态（dryRun）连 CAS 都不碰：零配额消耗、零表面改写，而量出来的 ledgerChars
    //   与合闸后一致（同长占位句柄）。emitCheckpoint 仍会在最后拒绝 append。
    let ledger = plan
    let writes = { pending: plan.slots.length, ok: 0, failed: 0, chars: 0, simulated: true }
    if (cfg.dryRun === true) {
      t('emit-archive-simulated', {
        pending: plan.slots.length, pendingChars: plan.slots.reduce((n, x) => n + x.text.length, 0),
        note: 'dry-run: no CAS write, no surface change',
      })
    } else {
      ledger = await commitLedgerPlan({ plan, ledgerDeps, archive, trace: t })
      writes = { ...(ledger.writes || {}), simulated: false }
      // 有项归档失败 ⇒ 原文被内联回来、账变胖。必须重算闸门，否则等于拿计划态的"看着省"当真机收益。
      if (ledger.text.length > plan.text.length) {
        const netAfterArchive = sourceChars - ledger.text.length
        t('emit-net-savings-recheck', { ledgerCharsBefore: plan.text.length, ledgerChars: ledger.text.length, netSavedChars: netAfterArchive, minSavedChars })
        if (sourceChars > 0 && netAfterArchive < minSavedChars) {
          t('emit-net-savings-result', { stage: 'post-archive', emitted: false, reason: 'no-net-savings-after-archive', sourceChars, ledgerChars: ledger.text.length, netSavedChars: netAfterArchive, casWrites: writes.ok })
          return { emitted: false, reason: 'no-net-savings-after-archive', sourceChars, ledgerChars: ledger.text.length, netSavedChars: netAfterArchive }
        }
        netSavedChars = netAfterArchive
      }
      // 落盘是异步的 ⇒ 发射前再确认一次提纯/表面没漂（CAS 可能已写，但表面绝不写坏）
      if (typeof deps.validatePending === 'function' && !deps.validatePending()) {
        t('emit-stale-distill', { stage: 'post-archive', casWrites: writes.ok })
        t('emit-net-savings-result', { stage: 'post-archive', emitted: false, reason: 'stale-distill', sourceChars, ledgerChars: ledger.text.length, netSavedChars, casWrites: writes.ok })
        return { emitted: false, reason: 'stale-distill' }
      }
      // ★★ P0-2：句柄是本路径唯一会写进模型上下文的地址 ⇒ 发射前读回验证一次。★★
      //   正面证伪（取不回）才拦住发射；探针缺席/抛错 = 不可证 ⇒ 只落 trace，不拦。
      if (Array.isArray(ledger.written) && ledger.written.length > 0) {
        const v = await verifyHandles({
          written: ledger.written, probeHandle: deps.probeHandle, sessionId: sessionIdOf(session),
          maxProbe: cfg.emitHandleProbeMax, trace: t,
        })
        if (v.verdict === 'unresolvable') {
          t('emit-net-savings-result', { stage: 'handle-verify', emitted: false, reason: 'handle-unresolvable',
            casWrites: writes.ok, handleChecked: v.checked, handleUnresolved: v.unresolved })
          return { emitted: false, reason: 'handle-unresolvable' }
        }
      }
    }

    // Optional, read-only canary. The host token meter is sampled around the actual surface append;
    // disabled by default so no extra measurement work is added to normal turns.
    // ⚠ dryRun 下**这项前后差没有意义**（压根没有 append），所以仍然关掉；
    //   但 emit-gate / emit-net-savings 里的会话级 usedTokens 是只读采样，评估态照样有 token 锚点。
    const shouldMeasureTokens = cfg.emitterMeasureTokens === true && cfg.dryRun !== true
    const tokenBefore = shouldMeasureTokens ? tokenMeterSample() : null
    // ⑤ 合规发射
    const emitted = emitCheckpoint({
      session, span, ledgerText: ledger.text,
      pluginName: cfg.pluginName, dryRun: cfg.dryRun, trace: t,
      summaryRecord: cfg.emitterSummaryRecord, targetSeq: last.seq,
    })
    const tokenAfter = shouldMeasureTokens ? tokenMeterSample() : null
    const tokenDelta = tokenBefore && tokenAfter && tokenBefore.tokens != null && tokenAfter.tokens != null
      ? tokenBefore.tokens - tokenAfter.tokens : null
    t('emit-net-savings-result', {
      stage: 'emit', emitted: !!emitted.emitted, reason: emitted.reason || null,
      sourceChars, ledgerChars: ledger.text.length, netSavedChars,
      // ★ 配额与副作用可见性：这一轮到底往 CAS 写了几条、多少字符；simulated ⇒ 一条都没写。
      casWrites: writes.ok, casWriteChars: writes.chars, archiveSimulated: writes.simulated === true,
      ...(tokenBefore ? { tokenMeterBefore: tokenBefore.tokens, tokenMeterAfter: tokenAfter.tokens,
        measuredSurfaceTokenDelta: tokenDelta, tokenMeterSource: tokenBefore.source === tokenAfter.source ? tokenBefore.source : 'mixed' } : { tokenMeterSource: 'disabled' }),
    })
    return emitted
  } catch (e) {
    t('emit-error', { error: String((e && e.message) || e) })
    return { emitted: false, reason: 'error' }
  }
}
