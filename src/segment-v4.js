// dsh-cot-form-b / segment-v4.js —— compress-v4-ops 的流式增量编译（v12.2）
//
// 问题：birth 只在 reasoning block-end 才起火，而收网窗口（block-end → finish）通常只有 1–3 秒；
//   v4 的副模型输出是带锚点的 JSON，比 v3 散文长，整块编译经常压不完 ⇒ distill-timeout ⇒ 原文放行（白压）。
//
// 解法：主模型还在思考时就开始编译。
//   ① 每攒够约 compressV4SegmentChars 字符，就在段落 / 句子边界切一刀，把这一段立即送去标注（不等 block-end）；
//      提示词里附上此前各段已通过校验的条目（「此前已标注」），后段可以用 retracts 推翻前段。
//   ② block-end 时只剩最后一小段要标注；等它的时间与块长无关（有上界）。
//   ③ 收网到点仍没标完 ⇒ 不整块放弃：输出「已编译前缀的渲染稿 + 尚未编译部分的原文逐字」。
//      最新的推理保持逐字（它离下一步最近，最不该有损），更早的部分已经编译成状态。
//
// 为什么只有 v4 能这样做：v4 的产物是原子条目，由代码合并（段前缀 id、I7 同 key 取最新、retracts、全局去重）；
//   v3 的散文摘要无法拼接。
//
// 不变式：
//   · 只有**连续的已编译前缀**进入渲染；从第一个未完成 / 失败的段起，后面全部原文逐字（不跳段、不重排）；
//   · 每段先按本段原文单独校验（锚点必须在本段里；关键条目编造或拒绝率过高 ⇒ 该段算失败）；
//     合并后再按整块原文做一次完整校验、选取与渲染；
//   · cancel() 掐掉所有在飞的分段请求（birth 放弃 / 硬停 / 消费者退出 / 低于门槛时都会调用）。
import { validateOps, mergeSegmentOps, compileOpsV4, priorLines, v4RejectRatioOf } from './compile-v4.js'
import { compressPromptVersion } from './prompts.js'

const SENT_END = /[。！？!?；;\n]/

/**
 * 在 text[from, to) 里找切点：优先最后一个空行 / 换行，其次最后一个句末标点；返回切点（不含）或 -1。
 * 只在 minAt 之后找，避免切出过碎的段。
 */
export function findCut(text, from, minAt, to) {
  const s = String(text || '')
  const end = Math.min(to, s.length)
  const para = s.lastIndexOf('\n\n', end - 1)
  if (para >= minAt && para >= from) return para + 2
  const nl = s.lastIndexOf('\n', end - 1)
  if (nl >= minAt && nl >= from) return nl + 1
  for (let i = end - 1; i >= Math.max(minAt, from); i--) if (SENT_END.test(s[i])) return i + 1
  return -1
}

/** 在 text(from, to] 里找第一个边界（换行或句末标点之后的位置）；没有 ⇒ -1。 */
export function findFirstCut(text, from, to) {
  const s = String(text || '')
  for (let i = Math.max(0, from); i < Math.min(to, s.length); i++) if (SENT_END.test(s[i])) return i + 1
  return -1
}

/**
 * 为一个 reasoning 块创建分段编译器。
 * @param opts.cfg            本条流的配置副本
 * @param opts.compileSegment async (segText, priorLines, signal, { onHeaders, trace }) => { ops, meta }（distill.js 的 makeV4SegmentCompiler）
 * @param opts.trace          (tag, data) => void
 * @param opts.index          块 index（只用于 trace）
 */
export function createSegmenter({ cfg = {}, compileSegment, trace = () => {}, index = null } = {}) {
  const segChars = typeof cfg.compressV4SegmentChars === 'number' && cfg.compressV4SegmentChars >= 200 ? cfg.compressV4SegmentChars : 1200
  // 首段减半：短块（3–4k 字、几秒写完）也能尽早开编（v12.3 真机：短块只来得及编 1 段）
  const firstChars = typeof cfg.compressV4FirstSegmentChars === 'number' && cfg.compressV4FirstSegmentChars >= 200 ? Math.min(cfg.compressV4FirstSegmentChars, segChars) : Math.max(200, Math.round(segChars / 2))
  const maxRatio = typeof cfg.compressV4MaxRejectRatio === 'number' ? cfg.compressV4MaxRejectRatio : 0.5
  const segments = []   // { n, start, end, text, status: 'pending'|'ok'|'failed', ops, kept, reason, abort, promise, firedAt, ms }
  let cut = 0
  let cancelled = false
  let finished = false
  const emit = (tag, data) => { try { trace(tag, { index, ...data }) } catch { /* 观测失败不影响主流 */ } }

  const okPrefix = () => {
    const out = []
    for (const s of segments) { if (s.status !== 'ok') break; out.push(s) }
    return out
  }

  const fire = (text, start, end, extra = {}) => {
    const n = segments.length + 1
    const segText = text.slice(start, end)
    const abort = new AbortController()
    // 此前已通过校验的条目（只取当下已完成的；绝不为了上下文而等待前段 —— 等待会把延迟串起来）
    const prior = priorLines(segments.filter((s) => s.status === 'ok').flatMap((s) => s.kept))
    const seg = { n, start, end, text: segText, status: 'pending', ops: null, kept: [], reason: null, abort, firedAt: Date.now(), ms: null }
    segments.push(seg)
    emit('v4-segment-fired', { n, start, end, chars: segText.length, priorOps: prior.length, tail: !!extra.tail })
    seg.promise = Promise.resolve()
      .then(() => compileSegment(segText, prior, abort.signal, { onHeaders: extra.onHeaders, trace, tail: !!extra.tail }))
      .then((r) => {
        const ops = (r && Array.isArray(r.ops)) ? r.ops : []
        const local = mergeSegmentOps([{ n, ops }])
        // 本段单独校验：锚点必须在本段原文里；前段 id 的 retracts 在这里不生效（合并时才生效）
        const v = validateOps(local, segText)
        if (v.fatal) throw Object.assign(new Error('v4-' + v.fatal), { v4seg: true })
        if (!v.kept.length) throw Object.assign(new Error('v4-no-valid-ops'), { v4seg: true })
        if (v.total >= 2 && v4RejectRatioOf(v) > maxRatio) throw Object.assign(new Error('v4-reject-ratio'), { v4seg: true })
        seg.ops = local; seg.kept = v.kept; seg.status = 'ok'
      })
      .catch((e) => { seg.status = 'failed'; seg.reason = String((e && e.message) || e) })
      .then(() => {
        seg.ms = Date.now() - seg.firedAt
        emit('v4-segment-settled', { n, ok: seg.status === 'ok', ms: seg.ms, reason: seg.reason, ops: seg.ops ? seg.ops.length : 0, kept: seg.kept.length })
      })
    return seg
  }

  /** 在当前累积文本上尝试切段（每个 reasoning-delta 调用一次；不够一段长时 O(1) 返回）。
   *  切点在「目标段长」附近找：先在 [0.6, 1.0] 倍段长内找最后一个边界，找不到再在 (1.0, 1.5] 倍内找第一个，
   *  仍找不到且已攒够 1.5 倍 ⇒ 按段长硬切（超长单行 / 代码）。一次调用可以切出多段（非流式、一次性给全文时）。 */
  const feed = (text) => {
    if (cancelled || finished) return
    const s = String(text || '')
    for (;;) {
      const size = segments.length === 0 ? firstChars : segChars
      if (s.length - cut < size) return
      const lo = cut + Math.floor(size * 0.6)
      const target = cut + size
      let at = findCut(s, cut, lo, target + 1)
      if (at < 0) at = findFirstCut(s, target, Math.min(s.length, cut + Math.floor(size * 1.5)))
      if (at < 0) { if (s.length - cut >= size * 1.5) at = target; else return }
      if (at <= cut) return
      fire(s, cut, at)
      cut = at
    }
  }

  /** 组装：[中间没编成的段 = 原文空洞，放前面] + 渲染稿（全部已编译段）+ [最后一个已编译段之后 = 原文尾巴]；
   *  一段都没编成 ⇒ null。v12.3 真机：旧规则「遇到失败段就停」让一个中间超时把后面全部变成原文（压缩率只剩 11%）。 */
  const assemble = (raw, budget) => {
    let last = -1
    segments.forEach((s, i) => { if (s.status === 'ok') last = i })
    if (last < 0) return null
    const upto = segments.slice(0, last + 1)
    const okSegs = upto.filter((s) => s.status === 'ok')
    const gaps = upto.filter((s) => s.status !== 'ok')
    const suffix = raw.slice(segments[last].end)
    // 各段的 ops 在 fire 时已经过 mergeSegmentOps（id 全局唯一、段内引用已加前缀），直接按段序拼接
    const merged = okSegs.flatMap((x) => x.ops)
    const stats = { segments: segments.length, compiledSegments: okSegs.length, gapSegments: gaps.length,
      failedSegments: segments.filter((s) => s.status === 'failed').length, pendingSegments: segments.filter((s) => s.status === 'pending').length }
    const out = compileOpsV4(merged, raw, cfg, budget, stats, { rawSuffix: suffix, rawPrefix: gaps.map((g) => g.text.trim()).join('\n\n'), segmented: true })
    if (!out.ok) return { ok: false, reason: out.reason, stats: out.stats }
    return { ok: true, text: out.text, stats: out.stats, partial: suffix.length > 0 || gaps.length > 0 }
  }

  return {
    get segments() { return segments },
    feed,
    /**
     * block-end：把剩下的部分作为最后一段送出，等所有段结束后合并。
     * 所有段都成功 ⇒ 完整编译；有段失败 ⇒ 已编译前缀 + 原文尾巴；一段都没成 ⇒ 抛错（birth 原文放行）。
     */
    async finish(raw, signal, budget = {}) {
      finished = true
      const s = String(raw || '')
      if (signal) {
        if (signal.aborted) this.cancel('pre-aborted')
        else signal.addEventListener('abort', () => this.cancel('aborted'), { once: true })
      }
      if (s.length > cut) { fire(s, cut, s.length, { tail: true, onHeaders: budget.onHeaders }); cut = s.length }
      await Promise.all(segments.map((x) => x.promise))
      if (cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true })
      const r = assemble(s, budget.v4Budget)
      if (!r) {
        const e = new Error('v4-no-compiled-segment')
        e.meta = { v4: { segments: segments.length, reasons: segments.map((x) => x.reason).filter(Boolean).slice(0, 4) } }
        throw e
      }
      if (!r.ok) { const e = new Error(r.reason); e.meta = { v4: r.stats }; throw e }
      return { text: r.text, meta: { promptVersion: compressPromptVersion(cfg), v4: { ...r.stats, incremental: true, partial: r.partial } } }
    },
    /** 收网到点时的最好结果：已编译前缀 + 原文尾巴（同步）；没有已编译前缀 ⇒ null。 */
    partial(raw, budget) {
      const r = assemble(String(raw || ''), budget)
      return r && r.ok ? r : null
    },
    cancel(why = 'cancel') {
      if (cancelled) return
      cancelled = true
      let n = 0
      for (const x of segments) if (x.status === 'pending') { try { x.abort.abort() } catch {} n++ }
      if (n) emit('v4-segments-cancelled', { why, pending: n })
    },
  }
}
