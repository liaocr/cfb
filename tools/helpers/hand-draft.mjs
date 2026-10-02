// tools/helpers/hand-draft.mjs —— 闭环 v4.6「三模式」的零 API 部分：
//   模式 1：助手代替副模型手写压缩稿（hand 臂）—— 测的是 f(主模型 | 稿)，不含副模型变量；
//   模式 2：以结局验证过的手写稿（gold）为标准量副模型（draftDistance）—— 测的是 g(稿 | 策略, 原文)，不含主模型变量；
//   模式 3：现有端到端（raw vs policy:X）终验，并检验预测「模式 3 增益 ≈ 模式 2 达标率 × 模式 1 天花板」。
//
// 本文件只做两件事：
//   (a) 手写稿协议与闸（G2「决策不变」）：手写稿只许改「记忆」，不许改「决定」——
//       三元组 ⊆ 原文三元组、原文没有落定句则稿里不许有、稿里每条已排除 / 验收 / 未解句的锚点都要在原文或 ctx 里出现。
//       （G1「无发明标识符 / 长度包络 / 三元组保留」由生产的 compileV4Direct + birthAccept 在同一条 birthOffline 路径上把关，这里不重复。）
//       这是防「助手知道答案」抬高天花板的机械闸：答案只能以新标识符或新决定的形式泄漏，两者都被挡。
//   (b) 槽位抽取 + draftDistance：按槽位的锚定事实（决策一致 → 已排除召回 → 验收 → 未解召回 → 锚点精确率 → 长度窗），
//       不是 BLEU/ROUGE（表面重合奖励照抄，而 flash 恰恰爱照抄样例）；锚点精确率 < 1 直接判负，照抄别家族样例会在这里露馅。
//       这把尺在驱动任何采纳前必须先在模式 3 里证明「召回高 ⇒ 结局好」（与 L1/L2 同一纪律），证不出就只当诊断。
import { buildLedger } from '../../src/messages.js'
import { jaccard } from './candidates.mjs'

const ANCHOR_RE = /[A-Za-z_$][\w.$\-]{2,}|\d+(?:\.\d+)?/g
const STOP = new Set(['old_text', 'new_text', 'edit_file', 'read_file', 'bash', 'tool_call', 'the', 'and', 'for', 'npm', 'node', 'test', 'true', 'false', 'null', 'undefined', 'const', 'let', 'var', 'return', 'function', 'import', 'export', 'from', 'async', 'await'])
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
/** 文本里的锚点：标识符 / 路径 / 数字（去掉工具协议词与极常见的语言关键字）。
 *  带点 / 斜杠 / 连字符的词同时登记它的各段（`process.env.CFB_REAL_DSH_HOME` ⇒ 也有 `CFB_REAL_DSH_HOME`、`env`）：稿里单提子标识符不算发明。两边同一规则，比对才对称。 */
export function anchorsOf(text) {
  const out = new Set()
  const add = (a) => { if (a.length < 3 && !/^\d/.test(a)) return; if (STOP.has(a) || /^[.\-$]+$/.test(a)) return; out.add(a) }
  for (const m of String(text || '').matchAll(ANCHOR_RE)) { const a = m[0].replace(/[.\-]+$/, ''); add(a); if (/[./\-]/.test(a)) for (const part of a.split(/[./\-]+/)) add(part) }
  return out
}
/** 单段稿的槽位（与生产台账同一套抽取：落定 / 已排除 / 验收 / 未解 / 提议三元组）。 */
export function slotsOf(text) {
  const L = buildLedger([{ role: 'user', content: '任务' }, { role: 'assistant', content: '', reasoning_content: String(text || '') }])
  return {
    decided: L.decided.map((x) => x.text),
    excluded: L.excluded.map((x) => x.text),
    accept: L.accept.map((x) => x.text),
    open: L.open.map((x) => x.text),
    triples: L.edits.filter((e) => e.oldText).map((e) => ({ oldText: norm(e.oldText), newText: norm(e.newText) }))
  }
}

/**
 * G2 决策不变闸：返回 {ok, violations:[{kind, detail}]}。
 *   invented-triple    稿里的 old_text/new_text 三元组不在原文三元组里
 *   invented-decision  原文没有落定句（改法只落一个…），稿里却有
 *   ungrounded:<slot>  稿里某条落定 / 已排除 / 验收 / 未解句的锚点一个都不在原文 ∪ ctx 里（有锚点才查；无锚点的句子放过）
 */
export function handDraftGate(raw, draft, ctx = '') {
  const R = slotsOf(raw), D = slotsOf(draft)
  const hay = anchorsOf(String(raw) + '\n' + String(ctx))
  const violations = []
  for (const t of D.triples) if (!R.triples.some((r) => r.oldText === t.oldText && r.newText === t.newText)) violations.push({ kind: 'invented-triple', detail: `old_text 是 \`${t.oldText.slice(0, 80)}\`` })
  // 落定句：原文有落定句，或这句话本身带着原文里已有的三元组（决定的内容就是那个三元组）才算有依据；否则是把原文没下的决定替主模型下了
  const tripleIn = (sentence) => slotsOf(sentence).triples.some((t) => R.triples.some((r) => r.oldText === t.oldText && r.newText === t.newText))
  for (const d of D.decided) if (!R.decided.length && !tripleIn(d)) violations.push({ kind: 'invented-decision', detail: d.slice(0, 120) })
  for (const slot of ['decided', 'excluded', 'accept', 'open']) for (const s of D[slot]) {
    const as = [...anchorsOf(s)]; if (!as.length) continue
    if (!as.some((a) => hay.has(a))) violations.push({ kind: 'ungrounded:' + slot, detail: s.slice(0, 120) })
  }
  return { ok: violations.length === 0, violations, slots: { raw: R, draft: D } }
}

/** 一条 gold 句子是否被另一段稿同槽位的句子「召回」：锚点覆盖 ≥ 60%，无锚点句退化为 bigram Jaccard ≥ 0.5。 */
function recalled(goldSentence, candidates) {
  const as = [...anchorsOf(goldSentence)]
  if (as.length) { const have = anchorsOf(candidates.join('\n')); return as.filter((a) => have.has(a)).length / as.length >= 0.6 }
  return candidates.some((c) => jaccard(goldSentence, c) >= 0.5)
}
const recall = (goldList, candList) => goldList.length ? +(goldList.filter((g) => recalled(g, candList)).length / goldList.length).toFixed(3) : null

/**
 * draftDistance(auto, gold, {raw, ctx})：两段稿按槽位比对。层级键（与 GPC 同样的字典序比较）：
 *   decision（gold 有三元组 / 落定句时 auto 是否同一决定）→ excludedRecall → acceptOk → openRecall → anchorPrecision → lengthOk
 * anchorPrecision = auto 的锚点里出现在 原文 ∪ ctx 的比例（gold 不算：照抄 gold 不是本事；锚点若来自别处就是发明 / 抄样例）。
 * score 只是给人看的 0–1 加权汇总；选稿用 key，不用 score。
 */
export function draftDistance(auto, gold, { raw = '', ctx = '' } = {}) {
  const A = slotsOf(auto), G = slotsOf(gold)
  const hay = anchorsOf(String(raw) + '\n' + String(ctx))
  const autoAnchors = [...anchorsOf(auto)]
  const anchorPrecision = autoAnchors.length ? +(autoAnchors.filter((a) => hay.has(a)).length / autoAnchors.length).toFixed(3) : 1
  let decision = null
  if (G.triples.length) decision = G.triples.every((g) => A.triples.some((a) => a.oldText === g.oldText && a.newText === g.newText)) ? 1 : 0
  else if (G.decided.length) decision = recalled(G.decided[0], A.decided.length ? A.decided : [auto]) ? 1 : 0
  const excludedRecall = recall(G.excluded, A.excluded)
  const acceptOk = G.accept.length ? (A.accept.length ? 1 : 0) : null
  const openRecall = recall(G.open, A.open)
  const lengthRatio = gold.length ? +(String(auto).length / String(gold).length).toFixed(2) : null
  const lengthOk = lengthRatio == null ? null : (lengthRatio >= 0.6 && lengthRatio <= 1.6 ? 1 : 0)
  const key = [decision ?? 1, excludedRecall ?? 1, acceptOk ?? 1, openRecall ?? 1, anchorPrecision, lengthOk ?? 1]
  const parts = [[decision, 0.35], [excludedRecall, 0.25], [acceptOk, 0.1], [openRecall, 0.1], [anchorPrecision, 0.15], [lengthOk, 0.05]].filter(([v]) => v != null)
  const w = parts.reduce((s, [, x]) => s + x, 0)
  const score = w ? +(parts.reduce((s, [v, x]) => s + v * x, 0) / w).toFixed(3) : null
  const verdict = anchorPrecision < 1 ? 'invented-anchors' : decision === 0 ? 'decision-differs' : (excludedRecall != null && excludedRecall < 0.5) ? 'lost-exclusions' : (score != null && score >= 0.85 ? 'close' : 'partial')
  return { decision, excludedRecall, acceptOk, openRecall, anchorPrecision, lengthRatio, lengthOk, key, score, verdict, slots: { auto: A, gold: G } }
}
/** 字典序比较两把 key（越大越好）。 */
export function compareKeys(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (Math.abs(d) > 1e-9) return d > 0 ? 1 : -1 } return 0 }

/** 手写稿协议（写进 pending 文件，助手照此写；与副模型拿到的是同一份提示词）。 */
export const HAND_PROTOCOL = [
  '你现在是副模型（压缩器）本人：只看下面 prompt 里的【上一轮思维链】与上下文，按 prompt 的规则写稿；别的（场景答案、仓库里的 oracle）一概不许用。',
  '机械闸：(G1) 反引号片段 / 标识符必须在原文或上下文里出现过（compileV4Direct + birthAccept，与生产同）；(G2) 不许改决定——三元组只能是原文里的、原文没有落定句就不许写、已排除 / 验收 / 未解句必须带原文里的锚点。',
  '只许改「记忆」：该留什么、怎么排、哪些排除 / 验收 / 未解要带到下一轮。改「决定」（下一步调用、修法）一律判违规并暂停。',
  '写完存到 drafts/<id>.md（纯文本，不带标题），再用同一条命令继续跑（traj-run 自动续）。'
].join('\n')
