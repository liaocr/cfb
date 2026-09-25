// dsh-cot-form-b / birth-claim.js —— birth 的「下轮收网」（Deferred Claim，实验；v11.11 从 plugin.js 抽出）
//
// 出生即提纯没赶上 finishWaitMs 的结果进暂存区（late-memory.js），在下一轮 agent/pre-step
// 用官方 user/message + surfaceOp replace 收网 —— 与 checkpoint 共用 emitter.js 的 runPreStepEmit。
// 只在 birthDeferredClaim:true 时调用。任何一步不满足 ⇒ no-op 保持原文，绝不抛错、绝不写坏表面。
import { runPreStepEmit, toolTextFromEvent } from './emitter.js'
import {
  lateMemorySize, lateMemory, lateKey, lateReceiptValid, peekLateMemory, peekLateMemoryPartial,
  explainLateMiss, lateInFlightCount, acknowledgeLateMemory,
} from './late-memory.js'
import { reasoningTextOf } from './messages.js'
import { normalizeBranchId } from './snapshot-store.js'
import { renderCheckpoint } from './state-memory.js'

/**
 * @param {{ payload: any, ctx: any, cfg: object, trace: Function, n: number, probeHandle: Function, consumption: { applied: Function } }} o
 * @returns {Promise<void>} 从不抛
 */
export async function runBirthClaim({ payload, ctx, cfg, trace, n, probeHandle, consumption }) {
  try {
    const bpSession = payload && payload.agent && payload.agent.session
    const bpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
    const bpSid = bpSession && (bpSession.id || bpSession.sessionId)
    // ★ 快速路径：本会话没有任何「没赶上的结果」⇒ 直接返回，
    //   不做表面读取、不做区间选择（收网器只在真有东西可收时才启动）。
    if (!lateMemorySize(bpSid, { branchId: normalizeBranchId(bpSession) })) { trace('birth-claim-idle', { n }); return }
    const claimScope = { branchId: normalizeBranchId(bpSession) }
    trace('birth-claim-opportunity', { n, sessionId: bpSid, branchId: claimScope.branchId, taskIds: (lateMemory.get(lateKey(bpSid, claimScope)) || []).map(x => x.taskId).filter(Boolean) })
    let pendingClaim = null
    const r = await runPreStepEmit({
      session: bpSession,
      requireUniqueRaw: true,
      validatePending: () => lateReceiptValid(bpSid, pendingClaim, claimScope),
      ctx,
      cfg,
      trace,
      rawOf: async (ev) => {
        const msg = ev && ev.data && ev.data.message
        return msg ? reasoningTextOf(msg) : null
      },
      // ★ 这里必须交**原文**：buildLedger 会用它写 CAS 归档。
      //   清洗只允许发生在「模型输入视图」那一侧（buildLedger 内联时），
      //   绝不能让归档副本被洗 —— 那是原始证据，必须字节保真。
      toolTextOf: async (ev) => toolTextFromEvent(ev),
      // ★ 零等待探测：让发射器在缺省目标未就绪时回头找「更早但已就绪」的候选（机会饥饿修正）
      isReady: async (raw) => !!(peekLateMemory(bpSid, raw, claimScope) || (cfg.lateClaimPartial === true && peekLateMemoryPartial(bpSid, raw, claimScope))),
      probeHandle,
      archive: async (text) => {
        if (!bpCmb || typeof bpCmb.putText !== 'function') return null
        try {
          const ref = await bpCmb.putText(text, {
            producer: cfg.emitterProducer || 'cot-checkpoint',
            sessionId: bpSid || null,
            retention: 'session',
          })
          return (ref && ref.handle) || null
        } catch (e) { trace('birth-claim-archive-error', { error: String((e && e.message) || e) }); return null }
      },
      // ★ birth 专属：结果不是「等」来的，是从暂存区**认领**来的。
      //   认领要求【全覆盖】：本消息的每一个推理块都有就绪结果，且拼起来逐字等于原文。
      //   只部分就绪 ⇒ 不认领、不消费（否则未就绪块的推理会凭空消失）。
      //   先 peek，只有发射成功才 acknowledge；拒发/漂移/dry-run 不消费。
      awaitDistilled: async (raw) => {
        let c = peekLateMemory(bpSid, raw, claimScope)
        if (!c && cfg.lateClaimPartial === true) {
          c = peekLateMemoryPartial(bpSid, raw, claimScope)
          if (c) trace('birth-claim-partial', { n, blocks: c.count, replacedChars: c.replacedChars, keptChars: c.keptChars })
        }
        if (!c) { trace('birth-claim-miss', { n, why: explainLateMiss(bpSid, raw, claimScope), rawChars: raw.length, inFlight: lateInFlightCount(bpSid, claimScope), stored: lateMemorySize(bpSid, claimScope) }); return null }
        // 多块时按块序拼接（顺序由 coverageMatch 保证，绝不按 promise 完成序）
        const text = c.texts.join('\n\n') || renderCheckpoint(c.entries)
        if (!text || !String(text).trim()) return null
        pendingClaim = c.receipt
        trace('birth-claim-hit', { n, blocks: c.count, chars: String(text).length, taskIds: c.receipt.map(x => x.taskId).filter(Boolean) })
        return { ok: true, text: String(text) }
      },
    })
    trace(r && r.emitted ? 'birth-claim-emitted' : 'birth-claim-skip', {
      n, reason: r && r.reason, returnedSeq: r && r.returnedSeq, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean),
    })
    if (r && r.emitted) {
      const consumed = acknowledgeLateMemory(bpSid, pendingClaim, claimScope)
      trace('birth-claim-acknowledged', { n, consumed, seq: r.returnedSeq ?? null, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean), rawChars: (pendingClaim || []).reduce((n, x) => n + x.raw.length, 0), summaryChars: (pendingClaim || []).reduce((n, x) => n + String(x.board || '').length, 0), accounting: 'characters-not-tokens-or-money' })
      for (const item of pendingClaim || []) consumption.applied(item.taskId, item.board)
      // A block-level ledger is NOT the entire latest persistent snapshot.
      // Do not mark that unrelated revision as host-applied.
    }
  } catch (e) {
    trace('birth-claim-error', { n, error: String((e && e.message) || e) })
  }
}
