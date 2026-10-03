// src/offline-birth.js —— 生产 birth 的**离线同构体**（v14.10 / 闭环 v4.5）。
//
//   生产（plugin → birth）一轮里发生的事，按顺序：
//     ① 流开始时用出站消息构造 ctx（messages.js buildCompressCtx）——此时本轮的工具调用还没产生，压缩器看不到它们；
//     ② reasoning 结束 ⇒ makeBirthCompiler(cfg)(raw)：提示词 compressPromptFor(cfg, raw)（含 cfg.compressPolicy 补丁）、
//        thinking 关（disableThinking）、max_tokens = max(maxOutputTokens, compressV4MaxOutputTokens)、重试 / 对冲 / 终止闸；
//        compileV4Direct 闸（长度包络 / 无发明标识符 / 三元组保留）不过 ⇒ 抛 ⇒ 原文放行（distill-failed）；
//     ③ finish 处拿到本轮 tool-call ⇒ spliceProgramParts(稿, ctx + 【本轮已发出的调用】)：延续段 / 验收提示 / 收工三问；
//     ④ birthAccept(raw, 稿, cfg)：空白 / 发明标识符 / token 不降 / 净省不足 ⇒ 原文放行。
//   评测工具（traj-run 的 auto 与 policy:<id> 臂、将来的任何离线压缩）都调这一个函数 ⇒ 评测稿 = 生产稿**由构造保证**：
//   不存在「工具自己拼的请求体」这条第二路径，auto ≡ policy:base，路径等价（parity）不再是需要花钱校准的问题。
//   注意与 v12.9.2–v14.9 评测约定的差别：那时工具把【本轮已发出的调用】接在 ctx 后再压缩（压缩器看得到调用），生产压缩器看不到；
//   这里按生产来 —— 压缩器不看调用，调用只用于 ③ 的程序部件。
import { makeBirthCompiler } from './distill.js'
import { turnCallsBlock, spliceProgramParts } from './compile-v4.js'
import { birthAccept, computeAdaptiveBirthControl } from './birth.js'
import { effectiveContinuationPath, effectiveProgramParts, effectiveAdaptiveFloor } from './policy.js'
import { applyCtxContinuationPolicy } from './messages.js'

/**
 * @param raw        本轮思维链原文
 * @param ctx        流开始时的上下文（buildCompressCtx(messages)），**不含**本轮调用块
 * @param calls      本轮实际发出的工具调用 [{name, args}]（finish 处才有）
 * @param cfg        normalizeConfig 过的配置（compressPrompt 'v4' / compressV4Direct true / compressPolicy 可选）
 * @param gate       false ⇒ 跳过 ④（只做诊断，生产永远不跳）
 * @param compile    测试注入：(raw, cfg) ⇒ {text, meta}；缺省 makeBirthCompiler(cfg)(raw, signal)（生产路径）
 * @returns {ok, text, why?, reason?, ms, promptVersion, policy, v4?, spliced?, accept?}
 */
export async function birthOffline({ raw, ctx = '', calls = [], cfg, signal = undefined, gate = true, compile = null }) {
  const pathMode = effectiveContinuationPath(cfg)
  const ppMode = effectiveProgramParts(cfg)
  const effectiveCtx = applyCtxContinuationPolicy(String(ctx || ''), pathMode)
  const adaptive = effectiveAdaptiveFloor(cfg) ? computeAdaptiveBirthControl(raw, effectiveCtx, null, cfg) : null
  const c = { ...cfg, compressCtx: effectiveCtx, ...(adaptive && !cfg.compressV4DirectMaxChars ? { compressV4DirectMaxChars: adaptive.effectiveMaxChars } : {}) }
  const t0 = Date.now(), policy = c.compressPolicy && c.compressPolicy.id || 'base'
  let g
  try { g = typeof compile === 'function' ? await compile(raw, c) : await makeBirthCompiler(c)(raw, signal) }
  catch (e) { return { ok: false, why: 'distill-failed', reason: String(e && e.message || e).slice(0, 160), text: raw, ms: Date.now() - t0, policy, promptVersion: e && e.meta && e.meta.promptVersion || null, v4: e && e.meta && e.meta.v4 || null, meta: e && e.meta || null } }
  let candidate = g.text, cfgAcc = c
  const st = {}
  if (Array.isArray(calls) && calls.length && /【台账】/.test(c.compressCtx) && !/【本轮已发出的调用】/.test(c.compressCtx)) {
    const block = turnCallsBlock(calls)
    if (block) { const ctx2 = c.compressCtx + '\n\n' + block; candidate = spliceProgramParts(candidate, ctx2, st, { programParts: ppMode }); cfgAcc = { ...c, compressCtx: ctx2 } }
  }
  const base = { ms: Date.now() - t0, policy, promptVersion: g.meta && g.meta.promptVersion || null, v4: g.meta && g.meta.v4 || null, spliced: st, ...(adaptive ? { adaptive } : {}), meta: g.meta || null }
  if (gate === false) return { ok: true, text: candidate, gated: false, ...base }
  const acc = birthAccept(raw, candidate, cfgAcc)
  if (!acc.ok) return { ok: false, why: acc.why, info: acc.info || null, text: raw, ...base }
  return { ok: true, text: candidate, accept: { netSaved: acc.netSaved, minSaved: acc.minSaved, tokens: acc.tokens || null }, ...base }
}

/** 评测用：由 traj-run 的参数构造与生产等价的 cfg（同一 normalizeConfig；只多了凭据与策略）。 */
export function offlineBirthConfig({ model, baseUrl, credentialsPath, policy = null, timeoutMs = 90000, normalizeConfig }) {
  return normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, model, baseUrl, credentialsPath, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs, compressPolicy: policy && policy.id !== 'base' ? { id: policy.id, patches: policy.patches || [], ...(policy.config ? { config: policy.config } : {}) } : null })   // v14.12.3：策略的程序部件配置（continuationPath）一并进 cfg
}
