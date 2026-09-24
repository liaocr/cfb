// dsh-cot-form-b / checkpoint.js —— checkpoint 模式（v11.11 从 plugin.js 抽出）
//
//   llm/stream     reasoning 一结束就提前发起副模型调用（early-fire，非阻塞），结果按原文精确匹配存槽
//   agent/pre-step 看板发射器（emitter.js runPreStepEmit）用 D4′ 相对宽限收网
//
// v11.11：early-fire 用**本次调用派生的配置**（host-follow.js），不再读被改写的共享 cfg ——
//   两个会话交错时，A 的提前调用不会拿到 B 的模型/provider。
import { generateDistillation } from './distill.js'
import { runPreStepEmit, toolTextFromEvent } from './emitter.js'
import { reasoningTextOf } from './messages.js'

/**
 * @param {{ cfg: object, trace: Function, ctx: any, probeHandle: Function,
 *           host: { hostModel: () => string|null, explicitModel: string } }} o
 */
export function createCheckpoint({ cfg, trace, ctx, probeHandle, host }) {
  // ── 提前发起的结果槽（只留最近 3 个，按 reasoning 原文精确匹配）──
  const early = new Map()
  const EARLY_MAX = 3

  function fireEarly(raw, callCfg) {
    if (!cfg.earlyFire || cfg.mode !== 'checkpoint') return
    if (!raw || raw.length < cfg.minRawChars) return
    // ★ 跟随宿主模型时，还没见过宿主模型就**不发起** —— 不猜模型名。
    //   直接跳过（pre-step 拿不到结果 ⇒ 原文保持）；比发一次注定失败的调用干净
    //   （不产生 `early-failed` 噪音，也不占 EARLY_MAX 槽位）。
    if (!callCfg.model) {
      trace('early-no-model', { rawChars: raw.length, followHostModel: cfg.followHostModel, explicitModel: host.explicitModel })
      return
    }
    if (early.has(raw)) return
    const e = { raw, settled: false, ok: false, text: null, err: null, firedAt: Date.now(), readyAt: null, meta: null }
    e.promise = generateDistillation(raw, callCfg).then((r) => {
      e.settled = true; e.ok = true; e.text = r.text; e.meta = r.meta; e.readyAt = Date.now()
      trace('early-ready', {
        rawChars: raw.length,
        tookMs: e.readyAt - e.firedAt,
        // ★ 实际用了哪个模型提纯（followHostModel 下应等于宿主对话模型）
        model: r.meta && r.meta.model,
        hostModel: host.hostModel(),
        modelSource: r.meta && r.meta.model === host.hostModel() ? 'host' : 'config',
        thinkingOff: r.meta && r.meta.thinkingOff,
        // ★ 传输层证据：这次调用到底复用了没有、握手花了多少
        reused: r.meta && r.meta.reused,
        connectMs: r.meta && r.meta.connectMs,
        ttfbMs: r.meta && r.meta.ttfbMs,
        // ★ 模型侧证据：finish_reason 与 reasoning 长度（诊断"空提纯稿"的真因）
        finish: r.meta && r.meta.finish,
        reasoningChars: r.meta && r.meta.reasoningChars,
        endpoint: r.meta && r.meta.endpoint,
      })
    }).catch((err) => {
      e.settled = true; e.ok = false; e.err = String((err && err.message) || err)
      trace('early-failed', { rawChars: raw.length, tookMs: Date.now() - e.firedAt, error: e.err })
    })
    early.set(raw, e)
    while (early.size > EARLY_MAX) early.delete(early.keys().next().value)
    trace('early-fired', { rawChars: raw.length, minRawChars: cfg.minRawChars })
  }

  const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

  // ★ D4′ 相对宽限收网：后台提纯若已就绪 ⇒ 0 等待；未就绪 ⇒ 最多再给 graceMs。
  //   两种结局都只是「用提纯稿」或「保持原文」，绝不抛错、绝不阻断宿主。
  async function awaitDistilled(raw, graceMs) {
    const e = early.get(raw)
    if (!e) return null
    if (e.settled) return e
    const cfgMs = Number.isFinite(cfg.graceMs) ? cfg.graceMs : 1000
    const budget = Number.isFinite(graceMs) ? Math.max(0, graceMs) : cfgMs
    if (budget > 0) await Promise.race([e.promise, sleep(budget)])
    return e.settled ? e : null
  }

  /** agent/pre-step：官方 user/message 检查点发射。从不抛。 */
  async function preStep(payload, n) {
    try {
      const cpSession = payload && payload.agent && payload.agent.session
      const cpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
      const r = await runPreStepEmit({
        session: cpSession,
        ctx,
        cfg,
        trace,
        rawOf: async (ev) => {
          const msg = ev && ev.data && ev.data.message
          return msg ? reasoningTextOf(msg) : null
        },
        // 复用 emitter.js 里的唯一实现（真机形状已实测 11,802/11,802 命中）
        toolTextOf: async (ev) => toolTextFromEvent(ev),
        // ★ P0-2：句柄是本路径唯一进模型上下文的地址 ⇒ 发射前读回抽样验证
        probeHandle,
        archive: async (text) => {
          if (!cpCmb || typeof cpCmb.putText !== 'function') return null
          try {
            const ref = await cpCmb.putText(text, {
              producer: cfg.emitterProducer || 'cot-checkpoint',
              sessionId: (cpSession && (cpSession.id || cpSession.sessionId)) || null,
              retention: 'session',
            })
            return (ref && ref.handle) || null
          } catch (e) { trace('emitter-archive-error', { error: String((e && e.message) || e) }); return null }
        },
        awaitDistilled,
      })
      trace(r && r.emitted ? 'checkpoint-emitted' : 'checkpoint-skip', {
        n, reason: r && r.reason, returnedSeq: r && r.returnedSeq,
      })
    } catch (e) {
      trace('checkpoint-error', { n, error: String((e && e.message) || e) })
    }
  }

  /** llm/stream：只读观察主流，reasoning 写完即提前发起。主流错误原样抛出。 */
  function wrapStream(inner, n, callCfg) {
    // ★ 保险：拿到的不是 async iterable 就**原样返回，绝不包装**。
    //   包装一个不认识的形状会让 `for await` 直接抛错 ⇒ 主模型调用当场失败。
    //   宁可这一轮不提前发起，也绝不许碰坏主流。
    if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
      trace('early-no-async-iter', { n, kind: inner === null ? 'null' : typeof inner })
      return inner
    }

    return (async function* () {
      const blockType = new Map() // index → blockType
      const buf = new Map()       // index → reasoning 文本（按 index 升序拼，与 reasoningTextOf 同口径）
      let fired = false
      const joinBuf = () => [...buf.keys()].sort((a, b) => a - b).map((k) => buf.get(k)).join('\n')
      const maybeFire = (why) => {
        if (fired) return
        const text = joinBuf()
        if (!text.trim()) return
        fired = true
        trace('early-trigger', { n, why, reasoningChars: text.length })
        fireEarly(text, callCfg)
      }
      try {
        for await (const chunk of inner) {
          try {
            const t = chunk && chunk.type
            const idx = chunk && chunk.index !== undefined ? chunk.index : 0
            if (t === 'block-start') {
              blockType.set(idx, chunk.blockType)
              // reasoning 之后紧接着 tool-call / text ⇒ reasoning 一定已经写完
              if (chunk.blockType === 'tool-call') maybeFire('tool-call-block-start')
              else if (chunk.blockType === 'text') maybeFire('text-block-start')
            } else if (t === 'text-delta') {
              if (blockType.get(idx) === 'reasoning') buf.set(idx, (buf.get(idx) || '') + String(chunk.text || ''))
            } else if (t === 'reasoning-delta') {
              buf.set(idx, (buf.get(idx) || '') + String(chunk.text || chunk.reasoning || ''))
            } else if (t === 'block-end') {
              const b = chunk.block
              if (b && b.type === 'reasoning') { buf.set(idx, String(b.text || buf.get(idx) || '')); maybeFire('reasoning-block-end') }
            } else if (t === 'tool-call-delta') {
              maybeFire('tool-call-delta')
            } else if (t === 'finish') {
              maybeFire('finish')
            }
          } catch { /* 观察失败绝不影响主流 */ }
          yield chunk
        }
      } catch (err) {
        trace('llm-stream-threw', { n, error: String((err && err.message) || err) })
        throw err
      }
    })()
  }

  return { preStep, wrapStream, fireEarly, awaitDistilled }
}
