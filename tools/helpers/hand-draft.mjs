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
import { programPartsText } from '../../src/compile-v4.js'
import { jaccard } from './candidates.mjs'

const ANCHOR_RE = /[A-Za-z_$][\w.$\-]{2,}|\d+(?:\.\d+)?/g
const STOP = new Set(['old_text', 'new_text', 'edit_file', 'edit', 'read_file', 'bash', 'tool_call', 'the', 'and', 'for', 'npm', 'node', 'test', 'true', 'false', 'null', 'undefined', 'const', 'let', 'var', 'return', 'function', 'import', 'export', 'from', 'async', 'await', 'PASS', 'FAIL', 'pass', 'fail', 'grep', 'sed', 'cat', 'head', 'tail', 'rg', 'command', 'found', 'AssertionError', 'Error'])
const CLI_ALLOW = new Set(['chmod', 'chown', 'sudo', 'mkdir', 'rm', 'ls', 'stat', 'wc', 'echo', 'find', 'cp', 'mv', 'touch', 'kill', 'ps', 'env', 'pwd', 'cd'])
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
/** 文本里的锚点：标识符 / 路径 / 数字（去掉工具协议词与极常见的语言关键字）。
 *  带点 / 斜杠 / 连字符的词同时登记它的各段（`process.env.CFB_REAL_DSH_HOME` ⇒ 也有 `CFB_REAL_DSH_HOME`、`env`）：稿里单提子标识符不算发明。两边同一规则，比对才对称。 */
export function anchorsOf(text) {
  const out = new Set()
  const add = (a) => { if (a.length < 3 && !/^\d{2,}/.test(a)) return; if (STOP.has(a) || /^[.\-$]+$/.test(a)) return; out.add(a) }
  const cleaned = String(text || '').replace(/\bsed\s+-n\s+['"]?\d+,\d+p['"]?/g, 'sed').replace(/[A-Za-z0-9_.$\/-]+…/g, '…')
  for (const m of cleaned.matchAll(ANCHOR_RE)) {
    const a = m[0].replace(/[.\-]+$/, '')
    add(a)
    if (/[./\-]/.test(a)) for (const part of a.split(/[./\-]+/)) add(part)
    if (/[a-z][A-Z]/.test(a)) for (const sub of a.split(/(?=[A-Z])/)) add(sub)
  }
  return out
}
const stripInHand = (s) => String(s || '').replace(/\n*【(?:在手信息|台账与在手)】[\s\S]*$/, '').trim()
/** 单段稿的槽位（与生产台账同一套抽取 + 多落点/逃生句/跨轮待办细粒度展开：落定 / 已排除 / 验收 / 未解 / 提议三元组）。 */
export function slotsOf(text) {
  const str = String(text || '')
  const bodyNoInHand = stripInHand(str)
  const L = buildLedger([{ role: 'user', content: '任务' }, { role: 'assistant', content: '', reasoning_content: str }])
  let decided = L.decided.map((x) => x.text)
  const excluded = L.excluded.map((x) => x.text)
  const accept = L.accept.map((x) => x.text)
  const open = L.open.map((x) => x.text)
  const triples = L.edits.filter((e) => e.oldText).map((e) => ({ oldText: norm(e.oldText), newText: norm(e.newText) }))
  for (const m of bodyNoInHand.matchAll(/old_text\s*是\s*`([^`\n]{1,220})`[^`]{0,160}?new_text\s*是\s*`([^`\n]{1,220})`/g)) {
    const ot = norm(m[1]), nt = norm(m[2])
    if (ot && !triples.some((t) => t.oldText === ot && t.newText === nt)) triples.push({ oldText: ot, newText: nt })
  }
  // 1. 多落点协同改法拆分为独立落定子句（按落点逐条计召回，消除单落点伪满分），并兜底超 220 字被 buildLedger 跳过的落定句
  const extraDecided = []
  for (const s of bodyNoInHand.split(/(?<=[。！？\n])\s*/)) {
    const t = norm(s)
    if (!t) continue
    if (/(?:本轮直接发了|改法分[一二两三\d]+处|改法只落)/.test(t) && /(?:一处.*；.*另一处|①.*；.*②|old_text\s*是[\s\S]*?；\s*(?:同文件|另一处|第二处|②))/.test(t)) {
      const head = (t.match(/^[^：:]+[：:]/) || [''])[0]
      const body = t.slice(head.length).trim()
      for (const cl of body.split(/；(?![^（(]*[）)])\s*(?=(?:另一处|第[二三]处|②|③|同文件|以及\s*edit_file))/)) {
        if (cl.trim()) extraDecided.push((head ? head + ' ' : '') + cl.trim())
      }
    } else if (!decided.length && /(?:^|[。；\n])\s*(?:改法只落一个|改法分[一二两三\d]+处|所以本轮直接发了)[：:]/.test(t)) {
      decided.push(t)
    }
  }
  if (extraDecided.length > 1) decided = extraDecided
  // 2. 抽取正文中的边界排除与伪证据排除（如「`done` 只留作标记不再参与」「`npm test` 的 PASS 不算证据」「`src/distill.js` 不动」），并把分号并列的「已排除：A；已排除：B」（含 >240 字被 buildLedger 跳过的长句）拆成独立条目（保证 gold 与 auto 对称）
  for (const m of bodyNoInHand.matchAll(/(?:^|[。；\n])\s*((?:已排除|排除)[：:][^。；\n]+)/g)) {
    const c = norm(m[1])
    if (c && !excluded.some((e) => e.includes(c) || c.includes(e))) excluded.push(c)
  }
  for (let idx = 0; idx < excluded.length; idx++) {
    if (/；\s*(?:已排除|排除)[：:]/.test(excluded[idx])) {
      const parts = excluded[idx].split(/；\s*(?=(?:已排除|排除)[：:])/).map((x) => norm(x)).filter(Boolean)
      excluded.splice(idx, 1, ...parts)
      idx += parts.length - 1
    }
  }
  for (const m of str.matchAll(/(?:`?(?:done|\[DONE\])`?\s*(?:只留作标记不再参与|不再合成\s*finish|伪造了\s*finish|的处理行与\s*birth\s*都不用动)|`?npm test`?[^。；\n]*PASS[^。；\n]{0,40}?不算证据[^。；\n]*|[^，；。\n]{3,90}(?:不是本次落点|无需再复现|不是原因[，,]?不动它|保持\s*\d+[^。；\n]*不动))/gi)) {
    const c = norm(m[0])
    if (!excluded.includes(c)) excluded.push(c)
  }
  for (const d of decided) {
    for (const m of d.matchAll(/[，,；;（(]\s*([^，；。\n（(）)]{3,80}?(?:不动|不改|保持\s*\d+|保留\s*[\w.]+\s*的?\s*\d+)[^，；。\n）)]*)/g)) {
      const c = norm(m[1])
      if (c && !excluded.includes(c)) excluded.push(c)
    }
  }
  // 3. 验收预注册扩展：纳入推翻分支（若回放仍…/如果验收不过…）与逃生兜底句（如果输出跟这两种都不像…）
  for (const s of bodyNoInHand.split(/(?<=[。！？\n])\s*/)) {
    const t = norm(s)
    if (/^(?:若|如果)(?:回放|验收|输出跟这两种都不像)/.test(t) && !accept.includes(t)) accept.push(t)
  }
  // 4. 跨轮待办与回放后后续计划抽取（「回放过了之后还有两件原文已经定下的事：A；以及 B」）
  for (const s of bodyNoInHand.split(/(?<=[。！？\n])\s*/)) {
    const t = norm(s)
    if (/(?:(?:回放|验收)过了之后还有[一二两三几\d]+件[^：:]*事|待办|后续待办)[：:]/.test(t)) {
      const body = t.replace(/^[^：:]+[：:]\s*/, '').replace(/[。；\s]+$/, '')
      for (const cl of body.split(/；\s*(?:以及)?/)) if (cl.trim()) open.push(cl.trim())
    }
  }
  return { decided, excluded, accept, open, triples }
}

/**
 * G2 决策不变闸：返回 {ok, violations:[{kind, detail}]}。
 *   invented-triple    稿里的 old_text/new_text 三元组不在原文三元组里
 *   invented-decision  原文没有落定句（改法只落一个…），稿里却有
 *   ungrounded:<slot>  稿里某条落定 / 已排除 / 验收 / 未解句的锚点一个都不在原文 ∪ ctx 里（有锚点才查；无锚点的句子放过）
 */
export function handDraftGate(raw, draft, ctx = '') {
  const R = slotsOf(String(raw) + '\n' + String(ctx)), D = slotsOf(draft)
  const rawCtxNorm = norm(String(raw) + '\n' + String(ctx))
  const hasFixIntent = R.decided.length > 0 || R.triples.length > 0 || /(?:edit_file|str_replace|apply_patch|改法|改成|改为|改回|回滚|替换)|\b(?:Fix|the fix|proper fix|clean fix)\s*[:：]|\brevert\s+\w+\s+to\b|\blet me write the edits\b/i.test(String(raw) + '\n' + String(ctx))
  const hay = anchorsOf(String(raw) + '\n' + String(ctx) + '\n' + programPartsText(ctx, { programParts: 'full' }) + '\n' + programPartsText(ctx, { programParts: 'compact' }))
  const violations = []
  const validTriple = (t) => R.triples.some((r) => r.oldText === t.oldText && r.newText === t.newText) ||
    (R.triples.length === 0 && hasFixIntent && rawCtxNorm.includes(t.oldText) && [...anchorsOf(t.newText)].every((a) => hay.has(a)))
  for (const t of D.triples) if (!validTriple(t)) violations.push({ kind: 'invented-triple', detail: `old_text 是 \`${t.oldText.slice(0, 80)}\`` })
  // 落定句：原文/台账有落定句或明确改法意图，且句子里的三元组有效才算有依据；否则是把原文没下的决定替主模型下了
  const tripleIn = (sentence) => slotsOf(sentence).triples.some(validTriple)
  for (const d of D.decided) if (!R.decided.length && !hasFixIntent && !tripleIn(d)) violations.push({ kind: 'invented-decision', detail: d.slice(0, 120) })
  for (const slot of ['decided', 'excluded', 'accept', 'open']) for (const s of D[slot]) {
    const as = [...anchorsOf(s)]; if (!as.length) continue
    if (!as.some((a) => hay.has(a))) violations.push({ kind: 'ungrounded:' + slot, detail: s.slice(0, 120) })
  }
  return { ok: violations.length === 0, violations, slots: { raw: R, draft: D } }
}

/** 一条 gold 句子是否被另一段稿同槽位的句子「召回」：叶子锚点覆盖 ≥ 60%（或已排除/待办的目标锚点在同槽位命中 ≥ 60% 且理由锚点在全文命中 ≥ 60%），无锚点句退化为 bigram Jaccard ≥ 0.5 或子句匹配。 */
const leafAnchors = (text) => {
  const all = [...anchorsOf(text)]
  return all.filter((a) => (!/[./\-]/.test(a) && !/[a-z][A-Z]/.test(a)) || !all.some((b) => b !== a && a.includes(b)))
}
function recalled(goldSentence, candidates, fullBody = '') {
  if (!candidates || !candidates.length) return false
  const as = leafAnchors(goldSentence)
  if (as.length) {
    const have = anchorsOf(candidates.join('\n'))
    if (fullBody) {
      for (const pm of String(goldSentence || '').matchAll(/(?:\/[\w.-]+){2,}/g)) {
        const p = pm[0], base = p.split('/').pop()
        if (base && fullBody.includes(p.slice(0, p.lastIndexOf('/'))) && (have.has(base) || base.split('.').every((x) => !x || have.has(x)))) {
          for (const seg of anchorsOf(p)) have.add(seg)
        }
      }
    }
    if (as.filter((a) => have.has(a)).length / as.length >= 0.6) return true
    if (fullBody) {
      const head = String(goldSentence || '').split(/[，,（(]\s*(?:因为|由于|——|—)|且不再/)[0]
      const headAs = leafAnchors(head)
      const haveAll = anchorsOf(candidates.join('\n') + '\n' + fullBody)
      if (headAs.length && headAs.filter((a) => have.has(a)).length / headAs.length >= 0.5 && as.filter((a) => haveAll.has(a)).length / as.length >= 0.6) return true
    }
    return false
  }
  if (candidates.some((c) => jaccard(goldSentence, c) >= 0.5)) return true
  const stripSlot = (x) => norm(x).replace(/^(?:已排除|未解|待解|未定|决定|已定|改法(?:只落一个)?)[：:]\s*/, '').replace(/[`'"]/g, '').replace(/\bPASS\s+[\w./-]+/g, 'PASS').replace(/\s*的\s*/g, ' ').replace(/\s+/g, ' ').replace(/[。；\s]+$/, '')
  const gClauses = stripSlot(goldSentence).split(/[、；，]+/).map((s) => s.trim()).filter((s) => s.length >= 4)
  if (!gClauses.length) return false
  const cJoined = candidates.map(stripSlot).join('；')
  return gClauses.some((cl) => cJoined.includes(cl))
}
const recall = (goldList, candList, fullBody = '') => goldList.length ? +(goldList.filter((g) => recalled(g, candList, fullBody)).length / goldList.length).toFixed(3) : null

/**
 * draftDistance(auto, gold, {raw, ctx})：两段稿按槽位比对。层级键（与 GPC 同样的字典序比较）：
 *   decision（gold 有三元组 / 多落点落定句时 auto 的落点召回率）→ excludedRecall → acceptOk（验收与逃生句连续召回）→ openRecall（跨轮待办与未解连续召回）→ anchorPrecision → lengthOk
 * anchorPrecision = auto 的锚点里出现在 原文 ∪ ctx ∪ 程序部件 的比例（gold 不算：照抄 gold 不是本事；锚点若来自别处就是发明 / 抄样例）。
 * score 只是给人看的 0–1 加权汇总；gapToCeiling = 1 - score 量化距理论极限天花板（Gold=1.000）的真实差距。
 */
export function draftDistance(auto, gold, { raw = '', ctx = '', calls = [] } = {}) {
  const A = slotsOf(auto), G = slotsOf(gold)
  const callsText = Array.isArray(calls) && calls.length ? calls.map((c) => `${c.name || ''} ${typeof c.args === 'string' ? c.args : JSON.stringify(c.args || '')}`).join('\n') : ''
  const goldAcceptBackticks = [...String(gold || '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n')
  const hay = anchorsOf(String(raw) + '\n' + String(ctx) + '\n' + callsText + '\n' + goldAcceptBackticks + '\n' + programPartsText(ctx, { programParts: 'full' }) + '\n' + programPartsText(ctx, { programParts: 'compact' }))
  const autoAnchors = [...anchorsOf(auto)]
  const isGrounded = (a) => hay.has(a) || CLI_ALLOW.has(a) || (/[./\-]/.test(a) && !/\.[A-Za-z]{1,5}$/.test(a) && a.split(/[./\-]+/).every((p) => !p || STOP.has(p) || CLI_ALLOW.has(p) || hay.has(p)))
  const anchorPrecision = autoAnchors.length ? +(autoAnchors.filter(isGrounded).length / autoAnchors.length).toFixed(3) : 1
  const goldDecidedAnchors = anchorsOf([...G.decided, ...G.triples.map((t) => t.oldText + ' ' + t.newText)].join('\n'))
  const stripExWhy = (s) => String(s || '').replace(/（[^）]*才是[^）]*）/g, '').replace(/[，,（(：:]\s*(?:因为|那里|由于|若)[\s\S]*$/, '').replace(/再用\s+read_file[\s\S]*$/, '')
  const goldExcludedOnlyAnchors = [...anchorsOf(G.excluded.map(stripExWhy).join('\n'))].filter((a) => !goldDecidedAnchors.has(a) && !/^\d/.test(a))
  const stripDecNeg = (s) => String(s || '').replace(/（[^）]*read_file[^）]*）/g, '').replace(/[，,；;（(]\s*[^，；。\n）)]*?(?:不动|不改|不选|保持|保留|只留作标记|余量由)[^，；。\n）)]*[）)]?/g, '')
  const autoActionAnchors = anchorsOf([...A.decided.map(stripDecNeg), ...A.triples.map((t) => t.oldText + ' ' + t.newText)].join('\n'))
  const resurrectedAnchors = goldExcludedOnlyAnchors.filter((a) => autoActionAnchors.has(a))
  const deadEndResurrected = resurrectedAnchors.length > 0
  const bodyNoInHand = stripInHand(auto)
  const fullAutoText = String(auto || '')
  let decision = null
  const normT = (s) => norm(s).replace(/^[{\s`]+|[}\s`]+$/g, '')
  const gDecClean = G.decided.map(stripDecNeg)
  if (deadEndResurrected) decision = 0
  else if (G.decided.length > 1) decision = recall(gDecClean, A.decided.length ? A.decided : [bodyNoInHand], fullAutoText)
  else if (G.triples.length) {
    const tOk = G.triples.every((g) => A.triples.some((a) => {
      const oldOk = normT(a.oldText) === normT(g.oldText) || normT(a.oldText).includes(normT(g.oldText)) || normT(g.oldText).includes(normT(a.oldText))
      if (!oldOk || normT(a.newText) === normT(a.oldText)) return false
      const newOk = normT(a.newText) === normT(g.newText) || normT(a.newText).includes(normT(g.newText)) || normT(g.newText).includes(normT(a.newText))
      if (newOk) return true
      const aNewAs = leafAnchors(a.newText)
      return aNewAs.length > 0 && aNewAs.every((x) => goldDecidedAnchors.has(x) && !goldExcludedOnlyAnchors.includes(x))
    }))
    decision = tOk ? 1 : (!A.triples.length && G.decided.length && A.decided.length ? +(0.5 * recall(gDecClean, A.decided, fullAutoText)).toFixed(3) : 0)
  }
  else if (G.decided.length) decision = recall(gDecClean, A.decided.length ? A.decided : [bodyNoInHand], fullAutoText)
  const excludedRecall = recall(G.excluded, A.excluded, fullAutoText)
  const acceptOk = G.accept.length ? (A.accept.length ? recall(G.accept, [bodyNoInHand]) : 0) : null
  const openRecall = recall(G.open, A.open, fullAutoText)
  const lengthRatio = gold.length ? +(String(auto).length / String(gold).length).toFixed(2) : null
  const lengthOk = lengthRatio == null ? null : (lengthRatio >= 0.6 && lengthRatio <= 1.6 ? 1 : 0)
  const key = [decision ?? 1, excludedRecall ?? 1, acceptOk ?? 1, openRecall ?? 1, anchorPrecision, lengthOk ?? 1]
  const parts = [[decision, 0.35], [excludedRecall, 0.25], [acceptOk, 0.1], [openRecall, 0.1], [anchorPrecision, 0.15], [lengthOk, 0.05]].filter(([v]) => v != null)
  const w = parts.reduce((s, [, x]) => s + x, 0)
  const score = w ? +(parts.reduce((s, [v, x]) => s + v * x, 0) / w).toFixed(3) : null
  const gapToCeiling = score != null ? +(1 - score).toFixed(3) : null
  const verdict = anchorPrecision < 1 ? 'invented-anchors' : deadEndResurrected ? 'resurrected-dead-end' : decision === 0 ? 'decision-differs' : (excludedRecall != null && excludedRecall < 0.5) ? 'lost-exclusions' : (score != null && score >= 0.85 ? 'close' : 'partial')
  return { decision, excludedRecall, acceptOk, openRecall, anchorPrecision, lengthRatio, lengthOk, deadEndResurrected, ...(resurrectedAnchors.length ? { resurrectedAnchors } : {}), key, score, gapToCeiling, verdict, slots: { auto: A, gold: G } }
}
/** 字典序比较两把 key（越大越好）。 */
export function compareKeys(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (Math.abs(d) > 1e-9) return d > 0 ? 1 : -1 } return 0 }

/** 手写稿协议（写进 pending 文件，助手照此写；与副模型拿到的是同一份提示词）。 */
export const HAND_PROTOCOL = [
  '你现在是副模型（压缩器）本人：只看下面 prompt 里的【上一轮思维链】与上下文，按 prompt 的规则写稿；别的（场景答案、仓库里的 oracle）一概不许用。',
  '机械闸：(G1) 反引号片段 / 标识符必须在原文或上下文里出现过（compileV4Direct + birthAccept，与生产同）；(G2) 不许改决定——三元组只能是原文里的、原文没有落定句就不许写、已排除 / 验收 / 未解句必须带原文里的锚点。',
  '摘要给另一个环境中的后续执行者复用：写已观察事实、证据、当前决定、未解点与下一步方向；不替执行者下工具禁令，也不劝退必要检查。',
  '不得把本实验的轮数、最大轮数、预算、停止条件写成任务结论；不得断言沙箱、权限、白名单或其他运行环境必然允许/禁止某命令。若原文确有拒绝结果，只陈述那次观测，不外推环境保证。',
  '只许改「记忆」：该留什么、怎么排、哪些排除 / 验收 / 未解要带到下一轮。改「决定」（下一步调用、修法）一律判违规并暂停。',
  '写完存到 drafts/<id>.md（纯文本，不带标题），再用同一条命令继续跑（traj-run 自动续）。'
].join('\n')
