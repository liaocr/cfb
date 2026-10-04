// tools/helpers/candidates.mjs —— 候选稿生成器 v2（v14.2）：生产等价、零 API、每个候选可追溯。
//
// 为什么重写（2026-10-02 用户核实的缺陷）：旧 levers.applyKnobs 先贴附录再硬截断，真实稿 5–10k 字配 tight 1200
// ⇒ 9 个候选 7 个是同一份原稿前缀；kItems / selection / deadEnd / layout 全部失效，离线打分在拿稿子跟自己比。
// 死路文本还是写死的 eacces 内容，贴到别的题上就是注入错误（只是恰好被截断掉了）。
//
// 本文件的三条纪律：
//   ① **候选从生产管线长出来**：control = 真实副模型输出 side 经 compileV4Direct（与 eval-plan 冻结 r2 同口径）；
//      变体 = 生产配置键覆盖（bind / 长度）或对已编译稿的确定性变换（提示 / 三问 / 死路 / 取舍 / 版面）。
//   ② **每个候选都过生产闸门**：发明标识符（与 birth 同一函数）+ 长度上限；不过闸 ⇒ feasible:false，绝不送去花钱。
//   ③ **退化可见**：与 control 逐字相同的候选标 degenerate:true 并给出原因；doctor 据此报警，而不是让它混进打分。
//
// 任何变换都只「删 / 移 / 改标签」，不写新事实；死路条目只来自 ctx 台账或稿自己的「已排除」段，绝不写死。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as I from '../../index.js'
import { callsOf } from '../effect-mr.mjs'
import { mrMessages } from '../compile-mr.mjs'
import { truthSet } from './offline-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const FROZEN_INPUTS = Object.freeze(['transfer/mr/chains.json', 'transfer/direct-d9a-r.json', 'transfer/mr/auto-d2d.json', 'tools/effect-mr-specs.json'])

// ── 1. 旋钮表：每个旋钮说清「生产里对应什么」──────────────────────────────────
//   kind: config    ⇒ 直接是 src/config.js 的键，赢了就是一条配置 diff
//         program   ⇒ 对应 src/compile-v4.js 的程序部件，赢了需要加开关（propose 会写明函数与默认值）
//         transform ⇒ 离线变换（生产尚无对应物），赢了需要在 compileV4Direct 落地同一变换
export const KNOBS = Object.freeze({
  bind: { values: ['on', 'off'], kind: 'config', production: 'compressV4DirectBind', theory: 'S8-R7 判读分支的落点绑定' },
  kItems: { values: ['on', 'off'], kind: 'program', production: 'compile-v4.spliceProgramParts(verifyHints)', theory: 'S10.14 可推导的预见（红题 4.9→8.0 的来源）' },
  closing: { values: ['on', 'off'], kind: 'program', production: 'compile-v4.spliceProgramParts(closingQuestions)', theory: 'S10.17 K5 收工三问' },
  deadEnd: { values: ['paired', 'shelved', 'none'], kind: 'transform', production: null, theory: '卷五 P4 REFUTED/SHELVED 拆分' },
  selection: { values: ['keepAll', 'balanced', 'strict'], kind: 'transform', production: null, theory: '卷四 A2 v(i)=D·Pn·(1−R) 的句级代理' },
  layout: { values: ['state-first', 'conclusion-first'], kind: 'transform', production: null, theory: '卷三原则 7 价值靠尾 vs 结论先行' },
})
// 没有「长度」杠杆：红线「不把稿子压更短」。长度只作生产熔断包络（见 lengthEnvelope），不是优化方向。
export const BASELINE_KNOBS = Object.freeze({ bind: 'on', kItems: 'on', closing: 'on', deadEnd: 'paired', selection: 'keepAll', layout: 'state-first' })
/** 按理论效应量排的默认试验顺序（一轮只动一个杠杆）。 */
export const LEVER_ORDER = Object.freeze(['kItems', 'selection', 'deadEnd', 'closing', 'layout', 'bind'])

// ── 2. 冻结输入：与 eval-plan 同一组文件、同一口径 ─────────────────────────────
const jsonFile = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
const validRow = (rows, id) => rows.find((r) => r.id === id && r.accept === 'ok' && /^condensed/.test(r.why) && typeof r.text === 'string' && r.text) || null

export function loadFrozenTasks({ root = ROOT } = {}) {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))
  const { chains } = read(FROZEN_INPUTS[0]), d1 = read(FROZEN_INPUTS[1]).rows, d2 = read(FROZEN_INPUTS[2]).rows, specs = read(FROZEN_INPUTS[3])
  const out = []
  for (const chain of chains) {
    const spec = specs.find((s) => s.id === chain.id), r1 = validRow(d1, chain.id), prior = validRow(d2, chain.id)
    if (!spec || !r1 || !prior || !chain.a1?.raw || !chain.a2?.raw) continue
    out.push({ id: chain.id, chain, spec, r1: r1.text, r1Side: r1.side || null, r1Ctx: round1Context(chain), side: prior.side, ctx: productionContext(chain, r1.text) })
  }
  return out
}

/** 第 1 轮（单步）压缩上下文（任务 + 第 1 轮已发出的调用；5/5 题原文均 ≥3400 字、100% 过门槛）。 */
export function round1Context(chain) {
  const calls = callsOf(chain.a1?.content || ''), callBlock = I.turnCallsBlock(calls)
  return I.buildCompressCtx([{ role: 'user', content: chain.u1 }]) + (callBlock ? '\n\n' + callBlock : '')
}

/** 与 eval-plan.buildMinimalPlan 逐字同口径的压缩上下文（任务 + 第 1 轮稿 + 本轮已发出的调用）。 */
export function productionContext(chain, r1) {
  const calls = callsOf(chain.a2.content), callBlock = I.turnCallsBlock(calls)
  return I.buildCompressCtx(mrMessages(chain, r1)) + (callBlock ? '\n\n' + callBlock : '')
}

/** 生产熔断：副模型输出（拼程序部件之前）多轮 2600 / 单步 2000。 */
export function productionMaxChars(ctx) { return /【台账】/.test(String(ctx || '')) ? 2600 : 2000 }
/** 候选长度包络 = 生产熔断 + 程序部件（延续段 / 提示 / 三问）——生产成稿本来就允许到这里（flaky r2 实测 3062 字）。 */
export function lengthEnvelope(ctx) { return productionMaxChars(ctx) + I.programPartsText(ctx).length }

/** 生产编译：side → compileV4Direct（配置覆盖只允许白名单里的生产键）。 */
export function compileProduction(task, overrides = {}) {
  const cfg = I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: task.ctx, ...overrides })
  const r = I.compileV4Direct(task.side, task.chain.a2.raw, cfg)
  return r.ok ? { ok: true, text: r.text, stats: r.stats } : { ok: false, reason: r.reason, stats: r.stats }
}

/** 生产闸门（与 birth / eval-plan 同一函数）：发明标识符 + 长度。 */
export function productionGate(task, text) {
  const extra = task.ctx + '\n' + I.programPartsText(task.ctx)
  const invented = I.inventedIdentifiers(task.chain.a2.raw, text, { extra })
  const maxChars = lengthEnvelope(task.ctx)
  return { ok: invented.length === 0 && text.length > 0 && text.length <= maxChars, invented, chars: text.length, maxChars }
}

// ── 3. 句级工具 ──────────────────────────────────────────────────────────────
/** 分句：只在 。！？ 与换行之后切，反引号内不切（v12.8.8 的教训：`done ? 'stop'` 不是问号）；ASCII ?! 常在代码里，不切。 */
export function splitSentences(text) {
  const out = []
  let cur = '', inTick = false
  for (const ch of String(text || '')) {
    cur += ch
    if (ch === '`') { inTick = !inTick; continue }
    if (!inTick && /[。！？\n]/.test(ch)) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}
const BIGRAM_MEMO = new Map()   // v4.5：同一段文本（ctx / 候选句）在一次 plan 里会被两两比对上百次，bigram 集合按原文缓存（上限 4096 条，满了清空）
const bigrams = (s) => {
  const key = String(s); const hit = BIGRAM_MEMO.get(key); if (hit) return hit
  const x = key.replace(/\s+/g, ''); const out = new Set(); for (let i = 0; i + 1 < x.length; i++) out.add(x.slice(i, i + 2))
  if (BIGRAM_MEMO.size >= 4096) BIGRAM_MEMO.clear()
  BIGRAM_MEMO.set(key, out); return out
}
export function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0; for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}
const PROTECTED_RE = /`[^`\n]+`|old_text|new_text|edit_file|所以下一步工具调用|改法只落一个|能说修好要三件事|三件事都在手|上一轮已定|仍在依赖的事实|已排除|已搁置|[\w./-]+\.(?:mjs|js|ts|json|py|yml|yaml|md|log|txt)\b/
const META_RE = /^(?:看起来|总之|综上|也就是说|换句话说|需要注意的是|值得注意|顺便|另外)/

/** 一句话的 v(i) 代理：D（相对 ctx 的新信息）× Pn（像下一步要用的量）× (1−R)（相对前文/ctx 的冗余）。 */
export function sentenceValue(sent, { ctx, prior = [] }) {
  const ids = [...String(sent).matchAll(/[A-Za-z_$][\w.$\-]{2,}|\d+(?:\.\d+)?/g)].map((m) => m[0])
  const truth = truthSet(ctx)
  const novel = ids.length ? ids.filter((x) => !truth.has(x)).length / ids.length : 0.3
  const D = Math.max(0.1, Math.min(1, 0.4 + 0.6 * novel))
  const Pn = PROTECTED_RE.test(sent) ? 1 : /\d|若|如果|则|就|下一步|先|再|改|查|看|跑/.test(sent) ? 0.7 : 0.4
  const ctxLines = String(ctx || '').split('\n').filter((l) => l.length > 12)
  let R = 0
  for (const p of prior) R = Math.max(R, jaccard(sent, p))
  for (const l of ctxLines) { const j = jaccard(sent, l); if (j > R) R = j; if (R > 0.9) break }
  return { v: +(D * Pn * (1 - R)).toFixed(4), D: +D.toFixed(3), Pn, R: +R.toFixed(3), protectedSentence: PROTECTED_RE.test(sent) }
}

// ── 4. 变换（纯函数、确定性、只删不写）───────────────────────────────────────
/** 剥掉程序拼进去的验收提示（kItems=off）。 */
export function stripHints(text, ctx) {
  let t = String(text || '')
  for (const h of I.verifyHints(ctx)) { const key = h.slice(0, 24); if (key && t.includes(key)) t = t.split(h).join('').split(key).join('') }
  return t.replace(/\n{3,}/g, '\n\n').trim()
}
/** 剥掉收工三问（closing=off）。 */
const THREE_Q_RE = /能说修好要三件事|收工三问|三件事都在手/
export function stripClosing(text, ctx) {
  const q = I.closingQuestions(ctx)
  let t = String(text || '')
  if (q && t.includes(q)) t = t.split(q).join('')
  // 副模型自己写的三问句（程序没拼）：整句剥掉（含「；现在能说的：…」尾巴）
  t = splitSentences(t).filter((s) => !THREE_Q_RE.test(s)).join('')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}
const EXCLUDED_SEG_RE = /(?:^|(?<=[。；\n]))\s*已排除[：:]([^。\n]*(?:。|$))/g
/** 死路形态：paired = 稿里原样（已排除：X（依据）…）；shelved = 改标签为「已搁置（未取证，不作为结论）」；none = 整段删除。 */
export function deadEndTransform(text, mode) {
  const t = String(text || '')
  if (mode === 'paired') return t
  if (mode === 'none') return t.replace(EXCLUDED_SEG_RE, '').replace(/；\s*(?=未解|$)/g, '；').replace(/\n{3,}/g, '\n\n').trim()
  if (mode === 'shelved') return t.replace(EXCLUDED_SEG_RE, (all, body) => all.replace(/已排除[：:]/, '已搁置（未取证，不作为结论）：'))
  throw new Error('unknown-deadEnd:' + mode)
}
/** 句级取舍：keepAll 不动；balanced 删 R>0.85 的复述/重复句；strict 另删 v<0.2 的非保护句与纯口头禅句。受保护句永不删。 */
export function selectionTransform(text, ctx, mode) {
  if (mode === 'keepAll') return { text: String(text || ''), dropped: [] }
  const floor = mode === 'strict' ? 0.6 : 0.85, minV = mode === 'strict' ? 0.2 : -1
  const sents = splitSentences(text), kept = [], dropped = []
  for (const s of sents) {
    if (!s.trim()) { kept.push(s); continue }
    const val = sentenceValue(s, { ctx, prior: kept.filter((k) => k.trim()) })
    if (val.protectedSentence) { kept.push(s); continue }
    if (val.R > floor || val.v < minV || (mode === 'strict' && META_RE.test(s.trim()) && !/\d|`/.test(s))) { dropped.push({ sentence: s.trim().slice(0, 60), ...val }); continue }
    kept.push(s)
  }
  return { text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}
const CONCLUSION_RE = /(?:所以下一步工具调用是|改法只落一个|现在能说的[：:]|状态是(?:提议|已改|已验证)|已改未验证)/
/** 版面：conclusion-first 把「结论 / 下一步调用 / 状态」所在句子组提到稿首；找不到 ⇒ 原样（调用方标 degenerate）。 */
export function layoutTransform(text, mode) {
  const t = String(text || '')
  if (mode === 'state-first') return t
  const sents = splitSentences(t)
  const idx = sents.map((s, i) => (CONCLUSION_RE.test(s) ? i : -1)).filter((i) => i >= 0)
  if (!idx.length || idx[0] === 0) return t
  const lead = idx.map((i) => sents[i].trim()).join('')
  const rest = sents.filter((_, i) => !idx.includes(i)).join('').replace(/^\s+/, '')
  return (lead + '\n\n' + rest).replace(/\n{3,}/g, '\n\n').trim()
}
/** 长度：先保住受保护句，再按 v(i) 从低到高删非保护句直到不超过 maxChars；最后仍超 ⇒ 从尾部按句退。 */
export function fitToLength(text, ctx, maxChars) {
  let sents = splitSentences(text)
  const total = () => sents.reduce((a, s) => a + s.length, 0)
  if (total() <= maxChars) return { text: String(text || ''), dropped: [] }
  const dropped = []
  const scored = sents.map((s, i) => ({ i, s, ...sentenceValue(s, { ctx, prior: [] }) })).filter((x) => x.s.trim() && !x.protectedSentence).sort((a, b) => a.v - b.v)
  const gone = new Set()
  for (const x of scored) { if (total() - [...gone].reduce((a, i) => a + sents[i].length, 0) <= maxChars) break; gone.add(x.i); dropped.push({ sentence: x.s.trim().slice(0, 60), v: x.v }) }
  sents = sents.filter((_, i) => !gone.has(i))
  while (total() > maxChars && sents.length > 1) { const s = sents.pop(); dropped.push({ sentence: s.trim().slice(0, 60), v: null, why: 'tail' }) }
  return { text: sents.join('').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}

// ── 5. 候选装配 ──────────────────────────────────────────────────────────────
/** 给定旋钮，按「生产编译 → 程序部件 → 变换 → 长度 → 闸门」生成一份候选。 */
export function renderCandidate(task, knobs) {
  const k = { ...BASELINE_KNOBS, ...knobs }
  const compiled = compileProduction(task, { compressV4DirectBind: k.bind !== 'off' })
  if (!compiled.ok) return { ok: false, knobs: k, reason: 'compile:' + compiled.reason, text: null }
  let text = compiled.text
  const notes = []
  if (k.kItems === 'off') { const t = stripHints(text, task.ctx); if (t === text) notes.push('no-hints-to-strip'); text = t }
  if (k.closing === 'off') { const t = stripClosing(text, task.ctx); if (t === text) notes.push('no-closing-to-strip'); text = t }
  if (k.deadEnd !== 'paired') { const t = deadEndTransform(text, k.deadEnd); if (t === text) notes.push('no-excluded-segment'); text = t }
  if (k.selection !== 'keepAll') { const r = selectionTransform(text, task.ctx, k.selection); if (!r.dropped.length) notes.push('nothing-to-prune'); text = r.text }
  if (k.layout !== 'state-first') { const t = layoutTransform(text, k.layout); if (t === text) notes.push('no-conclusion-sentence'); text = t }
  const fit = fitToLength(text, task.ctx, lengthEnvelope(task.ctx))
  text = fit.text
  const gate = productionGate(task, text)
  return { ok: true, knobs: k, text, chars: text.length, gate, feasible: gate.ok, notes, trimmed: fit.dropped.length }
}

/** 一轮候选：control（BASELINE 或当前 champion）+ 每个杠杆各取值的单因子变体；逐任务标 degenerate / feasible。 */
export function generateCandidates(tasks, { champion = BASELINE_KNOBS, levers = LEVER_ORDER } = {}) {
  const out = []
  for (const task of tasks) {
    const control = renderCandidate(task, champion)
    out.push({ id: 'control@' + task.id, task: task.id, arm: 'control', lever: null, value: null, isControl: true, ...control, degenerate: false })
    for (const lever of levers) for (const value of KNOBS[lever].values) {
      if (champion[lever] === value) continue
      const c = renderCandidate(task, { ...champion, [lever]: value })
      const degenerate = !!(c.ok && control.ok && c.text === control.text)
      out.push({ id: lever + '=' + value + '@' + task.id, task: task.id, arm: lever + '=' + value, lever, value, isControl: false, ...c, degenerate, degenerateWhy: degenerate ? (c.notes || []).join(',') || 'identical-text' : null })
    }
  }
  return out
}

/** 按臂汇总：几个任务可行、几个退化、平均字数——doctor 与报告用。 */
export function armSummary(cands) {
  const by = {}
  for (const c of cands) {
    const a = (by[c.arm] = by[c.arm] || { arm: c.arm, lever: c.lever, value: c.value, tasks: 0, feasible: 0, degenerate: 0, usable: 0, chars: 0 })
    a.tasks++; if (c.feasible) a.feasible++; if (c.degenerate) a.degenerate++; if (c.feasible && !c.degenerate) a.usable++; a.chars += c.chars || 0
  }
  return Object.values(by).map((a) => ({ ...a, avgChars: a.tasks ? Math.round(a.chars / a.tasks) : 0 }))
}
