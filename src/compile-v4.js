// dsh-cot-form-b / compile-v4.js —— compress-v4-ops 的确定性编译器（纯函数，零网络、同步）
//
// 流水线（docs/theory/CFB-THEORY-COMPLETE.md 第五卷 S1）：
//   副模型输出 ──► parseOps     容错解析 JSON（围栏 / 前后废话 / 裸数组 / JSON Lines）
//              ──► validateOps  硬不变量 I1–I5、I7、I8；单条失败 ⇒ 丢这一条；关键条目编造 ⇒ 整块回退原文
//              ──► selectOps    静态价值打分 + 必留条目 + 支撑闭包 + 预算内按性价比贪心
//              ──► renderOps    行式层（证据定粘性 / 替代先行 / 否定就近 / 过去时计划）+ 尾段（结论与未决问句）
//              ──► 出生文本（birthFinish 仍会再过一遍发明标识符闸、token 闸与净省判定）
//
// 为什么由代码写、不让副模型写：
//   · 措辞与顺序是可以被理论决定的（替代先行、否定就近、证据定粘性），交给副模型就只能「希望它照做」；
//   · 每条都带原文逐字锚点（I1）⇒ 编造可以被机械检出，而不是靠提示词劝说；
//   · 长度由预算决定，副模型的长度偏好不再影响结果。
//
// 与理论规格的差异（有意为之，均在此登记）：
//   · λ 控制器（S1 ⑦）需要跨轮传感器（读回 / 重复询问 / 打转），插件当前拿不到 ⇒ 用固定预算代替 λ；
//   · 渲染按「状态 → 当前方案 → 排除/搁置 → 计划 → 未决」分组、组内保持原文顺序，而不是纯贪心顺序：
//     分组保留因果可读性，未决问题放在最后（最靠近下一步生成的位置）；
//   · I6（已编译文本永不作为副模型输入）是结构保证：birth 只把 reasoning 原文交给副模型。
import { inventedIdentifiers, NEW_TEXT_LEAD_RE } from './fidelity.js'
import { wideShare } from './tokens.js'
import { condHints, fixHints, exampleSentences } from './prompts.js'
import { DEFAULTS } from './config.js'
import { parseEvidenceProposal, bindEvidenceProposal } from './evidence-program.js'

export const V4_KINDS = ['FACT', 'COMPUTED', 'INCUMBENT', 'REFUTED', 'SHELVED', 'OPEN', 'PLAN', 'READY', 'IF']
export const V4_EVS = ['tool', 'derived', 'guess']
export const V4_KIND2 = ['pivot', 'plan', 'hypothesize', 'localize', 'inspect', 'compute', 'verify', 'restate', 'answer']

// 必留：当前方案、证伪路（疫苗）、未决问题 —— 丢了它们，主模型会重走死路或把未决当已决（保真优先于长度）
const MUST_KEEP = new Set(['INCUMBENT', 'REFUTED', 'OPEN'])
// READY（已备好的改法）：原文里想好的具体改动 + 采用前提。turn 20 效果评测：原文保留它时主模型在观察证实前提后直接下手改
// （eacces 9.5 分），v3/v4 把它当「推测」删光后一律回头重读文件（≈2 分，比完全没有思考还差）。最后 READY_KEEP 条必留。
const READY_KEEP = 2
// IF（预先判读，v12.5）：原文对「即将到来的观察」各种结果的解读（若结果 A ⇒ 结论/动作）。归因（EFFECT-EVAL §7）：
// 原文每块有 1–7 句这种判读，v4 产物保留 0 句 —— 只留下「需查 finishReason 是 length 还是 stop」这个问题、删掉了答案表；
// 观察回来后主模型只能重新推一遍（回头读文件）。最后 IF_KEEP 条必留。
const IF_KEEP = 4
// 渲染预算下限（v12.5）：450 字装不下「判读 + 改法 + 死路」；效果评测里稍长的稿（≈935 字）明显好于 ≈550 字
export const V4_MIN_BUDGET = 800
// 静态价值（理论 v(i;λ) 在无跨轮传感器时的退化形式；只用于非必留条目之间的取舍）
const BASE = { INCUMBENT: 1.0, IF: 1.0, READY: 0.95, COMPUTED: 0.9, OPEN: 0.85, REFUTED: 0.8, SHELVED: 0.6, FACT: 0.6, PLAN: 0.35 }
const K2W = { pivot: 1.25, localize: 1.1, compute: 1.1, hypothesize: 1.0, answer: 0.4, plan: 0.8, inspect: 0.7, verify: 0.3, restate: 0.15 }
const EVW = { tool: 1.0, derived: 0.95, guess: 0.7 }
// 已备好的改法排最后（离下一步生成最近）；未决排在它前面
const GROUP = { FACT: 0, COMPUTED: 0, INCUMBENT: 1, REFUTED: 2, SHELVED: 2, PLAN: 3, OPEN: 4, IF: 5, READY: 6 }

// 副模型常把 supersedes 写成条目 id（「s3.o11」）而不是旧值 —— 语义就是 retracts；原样渲染会把内部 id 漏进出生文本（v12.3 真机）
const ID_LIST_RE = /^\s*(?:s\d+\.)?o\d+(?:\s*[,，、]\s*(?:s\d+\.)?o\d+)*\s*$/
export function supersedesIds(v) { return typeof v === 'string' && ID_LIST_RE.test(v) ? v.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : null }
const REFINE_KEYS = new Set(['root-cause', 'fix', 'next'])
// 「错了」走 REFUTED（疫苗），「细化」静默替换 ⇒ 固定键条目不渲染 supersedes；id 形态已转 retracts；键名形态（timing-margin）不是旧值
function supersedesText(o, supIds) {
  if (supIds) return ''
  const key = str(o.key ?? '', 60)
  const v = str(o.supersedes, 160)
  if (REFINE_KEYS.has(key) || /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(v) || REFINE_KEYS.has(v)) return ''
  return v
}
const PROBE_RE = /下一步工具调用|工具调用[:：]|复现|查看|检查|确认|定位|grep|read_file|sed -n|taskset|\b(?:inspect|check|reproduce|look at)\b/i
const FIXWORD_RE = /改为|改成|替换|修改|改用|回滚|删掉|加上|增加|设为|拉大|修复[:：]|\b(?:change|replace|set|revert|rename)\b/i
const CAP = { at: 200, text: 300, anchor: 120, alt: 200, why: 200, then: 200, trigger: 160, supersedes: 160, src: 60, key: 60 }
const str = (x, n) => (typeof x === 'string' ? x : x == null ? '' : typeof x === 'number' ? String(x) : '').trim().slice(0, n)
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
const stripEnd = (s) => String(s || '').replace(/[\s。．.;；,，:：!！]+$/u, '')
const stripQ = (s) => stripEnd(s).replace(/[?？]+$/u, '')
// 条件句去掉副模型自带的引导词，避免「若若 / 若如果 / if if」（v12.5 真机 ops7d）
const cond = (s) => stripEnd(s).replace(/^(?:若是|若|如果|假如|假设|要是|if\s|when\s)\s*/iu, '')
const isQ = (s) => /[?？]\s*$/u.test(String(s || ''))
// 中文模板的拼接：只在「中文 ↔ ASCII 字母数字」交界处补空格（「已排除权限问题」「若 ECONNREFUSED 再回来」）
const ASCII_EDGE = /[A-Za-z0-9_`/.\-]/
const zj = (...parts) => parts.filter((x) => x !== '' && x != null).reduce((acc, p) => {
  if (!acc) return p
  const a = acc[acc.length - 1], b = p[0]
  return acc + ((ASCII_EDGE.test(a) && /[\u4e00-\u9fff]/.test(b)) || (/[\u4e00-\u9fff]/.test(a) && ASCII_EDGE.test(b)) ? ' ' : '') + p
}, '')

// ── ① 解析 ───────────────────────────────────────────────────────────────────
/**
 * 容错解析副模型输出。接受：{"ops":[…]}、裸数组 […]、markdown 围栏包裹、前后夹杂说明文字、JSON Lines。
 * @returns {{ ops: object[] } | { error: string }}
 */
export function parseOps(output) {
  let s = String(output == null ? '' : output).trim()
  if (!s) return { error: 'empty-output' }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const pick = (v) => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') {
      if (Array.isArray(v.ops)) return v.ops
      if (Array.isArray(v.items)) return v.items
      if (typeof v.k === 'string' || typeof v.kind === 'string') return [v]
    }
    return null
  }
  const objs = (arr) => (arr ? arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [])
  const tryParse = (t) => { try { const r = objs(pick(JSON.parse(t))); return r.length ? r : null } catch { return null } }
  // 顺序：整体 → JSON Lines（≥2 行各自是对象）→ 最外层括号截取。JSON Lines 必须先于括号截取，
  //   否则 deps 里的 [..] 会被当成最外层数组。
  let ops = tryParse(s)
  if (!ops) {
    const lines = s.split('\n').map((l) => l.trim().replace(/,$/, '')).filter((l) => l.startsWith('{'))
    if (lines.length >= 2) {
      const got = []
      for (const l of lines) { try { const v = JSON.parse(l); if (v && typeof v === 'object' && !Array.isArray(v)) got.push(v) } catch {} }
      if (got.length >= 2) ops = got
    }
  }
  if (!ops) {
    const o = s.indexOf('{'), a = s.indexOf('[')
    const starts = [o, a].filter((i) => i >= 0).sort((x, y) => x - y)
    for (const st of starts) {
      const close = s[st] === '{' ? '}' : ']'
      const end = s.lastIndexOf(close)
      if (end > st) { ops = tryParse(s.slice(st, end + 1)); if (ops) break }
    }
  }
  if (!ops) return { error: 'unparseable' }
  return { ops }
}

/** 字段归一化：别名、大小写、长度上限；不做任何判定。 */
export function normalizeOp(o, i) {
  let k = str(o.k ?? o.kind ?? o.type, 20).toUpperCase()
  const ev = str(o.ev ?? o.evidence, 20).toLowerCase()
  const kind2 = str(o.kind2 ?? o.role, 20).toLowerCase()
  const ids = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []).map((d) => str(d, 24)).filter(Boolean).slice(0, 8)
  const deps = ids(o.deps)
  const supIds = supersedesIds(o.supersedes)
  const retracts = [...new Set([...ids(o.retracts), ...(supIds || []).map((d) => str(d, 24))])].slice(0, 8)
  // IF：cond（别名 trigger / if）→ trigger；then 单独保存；缺 text 时由两者拼出（校验与去重都看 text）
  const isIf = k === 'IF'
  const cond = isIf ? str(o.cond ?? o.trigger ?? o.if, CAP.trigger) : ''
  const then = isIf ? str(o.then, CAP.then) : ''
  const text0 = str(o.text, CAP.text)
  // READY 必须是「改」而不是「查」：副模型常把即将执行的探查调用（复现 / 查看 / grep）标成 READY（ops8 真机），
  // 渲染成「我准备的改法：下一步工具调用：…复现」会把探查冒充成修复 ⇒ 降为 PLAN
  if (k === 'READY' && PROBE_RE.test(text0) && !FIXWORD_RE.test(text0)) k = 'PLAN'
  return {
    id: str(o.id, 20) || 'o' + (i + 1), idx: i, k, then,
    ev: V4_EVS.includes(ev) ? ev : 'derived',
    kind2: V4_KIND2.includes(kind2) ? kind2 : null,
    text: isIf && cond && then ? str(cond + ' ⇒ ' + then, CAP.text) : text0, anchor: str(o.anchor, CAP.anchor), key: str(o.key, CAP.key),
    src: str(o.src, CAP.src), alt: str(o.alt, CAP.alt), why: str(o.why, CAP.why),
    trigger: isIf ? cond : str(o.trigger, CAP.trigger), supersedes: supersedesText(o, supIds), deps, retracts,
    at: k === 'READY' ? str(o.at ?? o.old ?? o.locus, CAP.at).replace(/^`+|`+$/g, '') : '',
  }
}

// ── ② 校验 ───────────────────────────────────────────────────────────────────
// I5：工具来源的内容只能写成事实，永不写成「我决定 / 我应该」（注入放大防线）
const RE_DECIDE = /我(?:决定|应该|要去|必须)|I (?:decided|decide|should|must|will now)\b/i
// I8：第二人称 / 祈使（作为 assistant 自己的推理被读回时会变成对主模型的指令）。引号与反引号内的原文引用不算。
const RE_SECOND = /[你您]|\byou(?:r|rs)?\b/i
const outsideQuotes = (s) => String(s || '').replace(/`[^`]*`|"[^"]*"|“[^”]*”|'[^'\n]{0,80}'/g, ' ')

/**
 * 硬不变量校验。单条失败 ⇒ 丢这一条并计数；关键条目（INCUMBENT / COMPUTED）编造标识符 ⇒ fatal（整块回退原文）。
 *   I1 anchor 必须是原文的逐字子串（NFKC + 空白归一化后比较）
 *   I2 text / alt / why / trigger / supersedes 里的标识符必须出现在原文（fidelity.inventedIdentifiers）；src 里的编造只删 src
 *   I3 REFUTED 必须带 alt（配对准入：否定只能挂在替代方案后面出现）
 *   I4 ev≠tool 的否定一律降为 SHELVED（没有观测就只是搁置，不是证伪）
 *   I5 工具来源条目不得含「我决定 / 我应该」类措辞
 *   I7 同一 key 只保留最后一个值（后者取代前者）
 *   I8 不得含第二人称
 *   另：schema（k 合法、text 非空）、同文去重
 * @returns {{ kept, rejected: {id,k,rule,sample?}[], converted: {id,from,to}[], fatal: string|null, total }}
 */
/**
 * READY 位置锚点的代码保底（S8-R2′）：原文里用反引号 / 独立代码行引用过、且含该改法标识符的最后一段，逐字取出。
 * 只抽取、不生成；找不到返回空串。
 */
export function locusFromRaw(raw, text) {
  const ids = (String(text || '').match(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*/g) || []).filter((x) => x.length >= 4 && /[A-Z_.$]|[a-z][A-Z]/.test(x) || /^[a-z]+[A-Z]/.test(x))
  if (!ids.length) return ''
  const spans = []
  for (const m of String(raw || '').matchAll(/`([^`\n]{8,200})`/g)) spans.push(m[1])
  for (const line of String(raw || '').split('\n')) { const t = line.trim(); if (t.length >= 12 && t.length <= 200 && /[=(){};]/.test(t) && /^(?:const|let|var|if|return|export|function|[\w$.]+\s*[:=(])/.test(t)) spans.push(t) }
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i]
    if (!/[=(){};:]/.test(sp)) continue
    if (/^\s*\[tool|^\s*(?:sed|grep|rg|cat|ls|node|npm|npx|bash|git|taskset|curl|cd|echo)\b/.test(sp)) continue   // 命令不是代码位置
    if (ids.some((id) => sp.includes(id))) return sp
  }
  return ''
}

/** S8-R2″：从判读（IF）与结论（INCUMBENT / COMPUTED）取原文逐字代码行；去掉 READY 已带的；至多 max 行 */
export function actionLoci(raw, chosen, max = 2) {
  const have = new Set(chosen.filter((o) => o.k === 'READY' && o.at).map((o) => norm(o.at)))
  const out = []
  const src = chosen.filter((o) => o.k === 'IF').concat(chosen.filter((o) => o.k === 'INCUMBENT' || o.k === 'COMPUTED').reverse())
  for (const o of src) {
    if (out.length >= max) break
    const at = locusFromRaw(raw, [o.trigger, o.then, o.text].filter(Boolean).join(' '))
    if (at && !have.has(norm(at))) { have.add(norm(at)); out.push(at) }
  }
  return out
}

export function validateOps(rawOps, raw, ctx = '') {
  const src = String(raw || '')
  const hay = norm(src)
  // v12.7：标识符出处 = 原文 + 本回合观察（cfg.compressCtx）——观察里有、原文没复述的标识符不是发明（S8-R5/R7）；锚点仍只认原文
  const srcAll = ctx ? src + '\n' + String(ctx) : src
  const hayAll = ctx ? norm(srcAll) : hay
  const kept = [], rejected = [], converted = []
  let fatal = null
  const ops = (Array.isArray(rawOps) ? rawOps : []).map(normalizeOp)
  const seen = new Set()
  for (const op of ops) {
    const reject = (rule, sample) => { rejected.push(sample ? { id: op.id, k: op.k, rule, sample } : { id: op.id, k: op.k, rule }) }
    if (!V4_KINDS.includes(op.k) || !op.text) { reject('schema'); continue }
    const a = norm(op.anchor)
    if (a.length < 2 || !hay.includes(a)) { reject('I1'); continue }
    const inv = inventedIdentifiers(srcAll, [op.text, op.alt, op.why, op.trigger, op.then, op.supersedes].filter(Boolean).join('\n'))
    if (inv.length) {
      reject('I2', inv.slice(0, 3))
      if (op.k === 'INCUMBENT' || op.k === 'COMPUTED') fatal = fatal || 'critical-I2'
      continue
    }
    if (op.src && inventedIdentifiers(srcAll, op.src).length) op.src = ''
    if (/^tool:?/i.test(op.src) || op.ev === 'tool') {
      if (RE_DECIDE.test(op.text)) { reject('I5'); continue }
    }
    if ([op.text, op.alt, op.why, op.trigger, op.then].some((t) => RE_SECOND.test(outsideQuotes(t)))) { reject('I8'); continue }
    if (op.k === 'REFUTED' && op.ev !== 'tool') { converted.push({ id: op.id, from: 'REFUTED', to: 'SHELVED' }); op.k = 'SHELVED' }
    if (op.k === 'REFUTED' && !op.alt) { reject('I3'); continue }
    const sig = op.k + '|' + norm(op.text).toLowerCase()
    if (seen.has(sig)) { reject('dup'); continue }
    seen.add(sig)
    op.src = op.src.replace(/^tool:\s*/i, '')
    // 理论 S8-R2′：READY 的位置锚点必须是原文 / 观察的逐字子串；对不上就丢掉锚点（条目保留）
    if (op.at && !hayAll.includes(norm(op.at))) op.at = ''
    if (op.k === 'READY' && !op.at) op.at = locusFromRaw(src, op.text)
    kept.push(op)
  }
  // 增量编译：后段条目可以显式推翻前段条目（retracts）。被推翻的条目移除（不计入硬拒绝）。
  const retracted = new Set()
  for (const op of kept) for (const r of op.retracts) retracted.add(r)
  if (retracted.size) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (retracted.has(kept[i].id)) { rejected.push({ id: kept[i].id, k: kept[i].k, rule: 'retracted' }); kept.splice(i, 1) }
    }
  }
  // I7：同 key 保留最后一个；被取代者若很短且新值没写 supersedes，就把旧值挂上去（「取代 X」）
  // 死路（REFUTED / SHELVED）不参与：key=root-cause 的旧根因被证伪后仍是疫苗，不能被新根因「取代」掉
  const keyed = (op) => op.key && op.k !== 'REFUTED' && op.k !== 'SHELVED'
  const lastByKey = new Map()
  for (const op of kept) if (keyed(op)) lastByKey.set(op.key, op)
  // 支撑不是取代（ops9 真机：副模型给 FACT→COMPUTED→COMPUTED 整条推理链都标 key=root-cause，I7 删掉了 3/4）：
  // 胜者（传递地）deps 依赖它、或它是工具观测而胜者不是 ⇒ 它是胜者的依据，保留
  const byId = new Map(kept.map((o) => [o.id, o]))
  const dependsOn = (w, id, seen = new Set()) => (w.deps || []).some((d) => d === id || (!seen.has(d) && seen.add(d) && byId.has(d) && dependsOn(byId.get(d), id, seen)))
  const final = []
  for (const op of kept) {
    if (keyed(op) && lastByKey.get(op.key) !== op) {
      const winner = lastByKey.get(op.key)
      if (dependsOn(winner, op.id) || (op.ev === 'tool' && op.k === 'FACT' && winner.k !== 'FACT')) { final.push(op); continue }
      // 固定键（root-cause / fix / next）是「细化」不是「改值」：挂「取代 旧结论」会暗示旧的错了（v12.3 真机：旧根因只是粗一点的同一判断）
      if (!REFINE_KEYS.has(op.key) && !winner.supersedes && op.text.length <= 60 && norm(op.text) !== norm(winner.text)) winner.supersedes = op.text
      rejected.push({ id: op.id, k: op.k, rule: 'I7' })
      continue
    }
    final.push(op)
  }
  return { kept: final, rejected, converted, fatal, total: ops.length }
}

// ── ③ 选取 ───────────────────────────────────────────────────────────────────
/** 静态价值（无跨轮传感器时 v(i;λ) 的退化形式）。被依赖的条目加分（它支撑别的结论）。 */
export function scoreOp(op, depCount = 0) {
  return (BASE[op.k] || 0.3) * (op.kind2 ? K2W[op.kind2] : 1) * (EVW[op.ev] || 0.9) + 0.15 * Math.min(depCount, 3)
}

/**
 * 选取：必留条目全收 → 去掉纯冗余（复述可见工具输出、复核已知结论）→ 其余按「价值 / 字符」贪心装进预算 → 支撑闭包。
 * @param ops validateOps 的 kept
 * @param opts { budget, lang }
 * @returns {{ chosen, dropped: { restate, verify, budget } }}
 */
export function selectOps(ops, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : 450
  const byId = new Map(ops.map((o) => [o.id, o]))
  const depCount = new Map()
  for (const o of ops) for (const d of o.deps) if (byId.has(d)) depCount.set(d, (depCount.get(d) || 0) + 1)
  const dropped = { restate: 0, verify: 0, budget: 0 }
  const chosen = new Set()
  let used = 0
  const take = (o) => { if (!chosen.has(o.id)) { chosen.add(o.id); used += renderLine(o, lang).length + 1 } }
  const closure = (o, depth = 0) => {
    if (depth > 2) return
    for (const d of o.deps) { const x = byId.get(d); if (x && !chosen.has(x.id)) { take(x); closure(x, depth + 1) } }
  }
  const readyKeep = new Set([...ops.filter((o) => o.k === 'READY').slice(-READY_KEEP), ...ops.filter((o) => o.k === 'IF').slice(-IF_KEEP)].map((o) => o.id))
  const must = (o) => MUST_KEEP.has(o.k) || readyKeep.has(o.id)
  for (const o of ops) if (must(o)) take(o)
  for (const o of ops) if (must(o)) closure(o)
  const pool = []
  for (const o of ops) {
    if (chosen.has(o.id)) continue
    const needed = (depCount.get(o.id) || 0) > 0 || !!o.supersedes
    // 复述工具输出：原件仍在上下文里（R≈0.85），复述是纯冗余
    if (!needed && o.kind2 === 'restate' && (o.k === 'FACT' || o.ev === 'tool')) { dropped.restate++; continue }
    // 复核已知结论（「再检查一下 2+2=4」）：Thought Anchors 中价值最低的一类句子
    if (!needed && o.kind2 === 'verify' && o.k !== 'COMPUTED') { dropped.verify++; continue }
    pool.push(o)
  }
  pool.sort((x, y) => (scoreOp(y, depCount.get(y.id)) / (renderLine(y, lang).length + 1)) - (scoreOp(x, depCount.get(x.id)) / (renderLine(x, lang).length + 1)) || x.idx - y.idx)
  for (const o of pool) {
    const len = renderLine(o, lang).length + 1
    if (used + len > budget) { dropped.budget++; continue }
    take(o); closure(o)
  }
  return { chosen: ops.filter((o) => chosen.has(o.id)), dropped }
}

// ── ④ 渲染 ───────────────────────────────────────────────────────────────────
const T = {
  zh: {
    src: (s, sup) => (s || sup) ? '（' + [s ? zj('来源', s) : '', sup ? zj('取代', sup) : ''].filter(Boolean).join('；') + '）' : '',
    // v12.5 语域：reasoning_content 是主模型「自己的」思考 ⇒ 第一人称内心独白，而不是第三方笔记（「目前判断 / 当时计划」读起来像别人的过期记录）
    judged: '我目前判断：', guess: '我猜（未验证）：', incumbent: '我现在采用：', incumbentGuess: '我倾向（未验证）：',
    refuted: (alt, x, why) => alt + '（' + zj('已排除', x) + (why ? '：' + why : '') + '）',
    shelved: (alt, x, why, trig) => alt
      ? alt + '（' + zj('暂缓', x) + (why ? '：' + why : '') + (trig ? '；' + zj('若', trig, '再回来') : '') + '）'
      : zj('暂缓', x) + ((why || trig) ? '（' + [why, trig ? zj('若', trig, '再回来') : ''].filter(Boolean).join('；') + '）' : ''),
    plan: '接下来要：', open: '还要确认：',
    rule: (c, t) => '判读：' + zj(zj('若', cond(c)) + '，就', t),
    ready: (t, trig, at) => '我准备的改法：' + t + (at ? '（改动位置：`' + at + '`）' : '') + (trig ? '（' + zj('前提：', cond(trig)) + '）' : ''),
    tailReady: (t, trig, at) => (trig ? zj(zj('若', cond(trig)) + '，就', t) : '我准备的改法：' + t) + (at ? '，改的就是 `' + at + '` 这一行' : '') + '。',
    tailRule: (c, t) => zj(zj('若', cond(c)) + '，就', t) + '。',
    tailIncumbent: (t) => '所以我现在采用：' + t + '。', tailJudged: (t) => '所以我目前判断：' + t + '。', tailFact: (t) => '已确认：' + t + '。',
    // 未决在尾段写成陈述而不是问句：推理末尾的疑问句会把下一步推向「继续取证」（turn 20 效果评测）
    tailOpen: (t) => '还要确认：' + t + '。',
  },
  en: {
    src: (s, sup) => (s || sup) ? ' (' + [s ? 'source ' + s : '', sup ? 'replaces ' + sup : ''].filter(Boolean).join('; ') + ')' : '',
    judged: 'My current judgment: ', guess: 'My guess (unverified): ', incumbent: 'I am going with: ', incumbentGuess: 'I lean towards (unverified): ',
    refuted: (alt, x, why) => alt + ' (ruled out ' + x + (why ? ': ' + why : '') + ')',
    shelved: (alt, x, why, trig) => alt
      ? alt + ' (set aside ' + x + (why ? ': ' + why : '') + (trig ? '; revisit if ' + trig : '') + ')'
      : 'Set aside ' + x + ((why || trig) ? ' (' + [why, trig ? 'revisit if ' + trig : ''].filter(Boolean).join('; ') + ')' : ''),
    plan: 'Next: ', open: 'Still to confirm: ',
    rule: (c, t) => 'Reading: if ' + cond(c) + ', then ' + t,
    ready: (t, trig, at) => 'Prepared change: ' + t + (at ? ' (at `' + at + '`)' : '') + (trig ? ' (if ' + cond(trig) + ')' : ''),
    tailReady: (t, trig, at) => (trig ? 'If ' + cond(trig) + ', then ' + t : 'Prepared change: ' + t) + (at ? ' — the line is `' + at + '`' : '') + '.',
    tailRule: (c, t) => 'If ' + cond(c) + ', then ' + t + '.',
    tailIncumbent: (t) => 'So I am going with: ' + t + '.', tailJudged: (t) => 'So my current judgment is: ' + t + '.', tailFact: (t) => 'Confirmed: ' + t + '.',
    tailOpen: (t) => 'Still to confirm: ' + t + '.',
  },
}

/**
 * 单条渲染（理论 S5 渲染规则）：
 *   证据定粘性：tool → 陈述（带来源）；derived → 「目前判断」；guess → 「未验证的猜测」
 *   替代先行 + 否定就近：REFUTED/SHELVED 先写替代方案，被放弃的 X 只在括号里出现一次
 *   计划写成过去时（「当时计划」）：避免被读成对主模型的指令
 */
export function renderLine(op, lang = 'zh') {
  const L = T[lang] || T.zh
  const t = stripEnd(op.text)
  switch (op.k) {
    case 'FACT':
    case 'COMPUTED': {
      if (op.ev === 'guess') return '- ' + L.guess + t
      if (op.ev === 'derived' || op.k === 'COMPUTED') return '- ' + L.judged + t + (op.supersedes ? L.src('', op.supersedes) : '')
      return '- ' + t + L.src(op.src, op.supersedes)
    }
    case 'INCUMBENT': return '- ' + (op.ev === 'guess' ? L.incumbentGuess : L.incumbent) + t + (op.supersedes ? L.src('', op.supersedes) : '')
    case 'REFUTED': return '- ' + L.refuted(stripEnd(op.alt), t, stripEnd(op.why))
    case 'SHELVED': return '- ' + L.shelved(stripEnd(op.alt), t, stripEnd(op.why), stripEnd(op.trigger))
    case 'PLAN': return '- ' + L.plan + t
    case 'OPEN': return '- ' + L.open + stripQ(op.text)
    case 'READY': return '- ' + (op.auto ? t : L.ready(t, stripEnd(op.trigger), op.at))
    case 'IF': return '- ' + (op.trigger && op.then ? L.rule(stripEnd(op.trigger), stripEnd(op.then)) : t)
    // 代码补的条目是原文逐字句（本身就是第一人称的思考），不加前缀
    default: return '- ' + t
  }
}

/**
 * 整块渲染：行式层按组（状态 → 当前方案 → 排除/搁置 → 计划 → 未决），组内保持原文顺序；
 * 尾段（可关）：最重要的一条结论 + 至多两个未决问句（双编码：关键结论在末尾再出现一次，离下一步生成最近）。
 */
/**
 * 理论 S8-R4′：层 A 用连贯的第一人称推理散文（模型原生思考语域），不用项目符号 / 「标签：」。
 * 条目、取舍、顺序、逐字规则与行式完全相同，只换体裁。
 */
const endZh = (s) => /[。！？!?…]$/u.test(s) ? s : s + '。'
function proseSentence(op, lang) {
  const t = stripEnd(op.text)
  if (lang === 'en') {
    switch (op.k) {
      case 'FACT': return op.ev === 'tool' || !op.ev ? t + (op.src ? ' (' + op.src + ').' : '.') : 'I think ' + t + '.'
      case 'COMPUTED': return (op.ev === 'guess' ? 'My guess, not verified yet: ' : 'I think ') + t + '.'
      case 'INCUMBENT': return (op.ev === 'guess' ? 'I lean towards ' : 'I am going with ') + t + '.'
      case 'REFUTED': return 'I already ruled out ' + t + (op.why ? ', because ' + stripEnd(op.why) : '') + (op.alt ? ', so instead ' + stripEnd(op.alt) : '') + '.'
      case 'SHELVED': return 'I set aside ' + t + (op.why ? ' (' + stripEnd(op.why) + ')' : '') + (op.trigger ? ' unless ' + cond(op.trigger) : '') + (op.alt ? '; for now ' + stripEnd(op.alt) : '') + '.'
      case 'PLAN': return 'Next I want to ' + t + '.'
      case 'OPEN': return 'What I have not confirmed yet: ' + stripQ(op.text) + '.'
      case 'IF': return op.trigger && op.then ? 'If ' + cond(op.trigger) + ', then ' + stripEnd(op.then) + '.' : t + '.'
      case 'READY': return op.auto ? (op.at ? 'The fix: ' + t + ' — the line is `' + op.at + '`, usable as edit_file old_text.' : t + '.') : 'The change I have ready: ' + t + (op.at ? ' — the line is `' + op.at + '`' : '') + (op.trigger ? ', once ' + cond(op.trigger) : '') + '.'
      default: return t + '.'
    }
  }
  switch (op.k) {
    // oracle 第 3 轮（S8-R4″）：DeepSeek 原生思考语域 ——「看起来 / 所以 / 下一步工具调用是 / 如果…那么…」，不用「我判断」
    case 'FACT': return op.ev === 'tool' || !op.ev ? endZh(t + (op.src ? '（' + op.src + '）' : '')) : endZh(zj('看起来', t))
    case 'COMPUTED': return endZh(op.ev === 'guess' ? zj('可能', t) + '，还没验证' : zj('看起来', t))
    case 'INCUMBENT': return endZh(zj(op.ev === 'guess' ? '倾向于' : '目前的结论是', t))
    case 'REFUTED': return endZh(zj('已经排除', t) + (op.why ? '，因为' + stripEnd(op.why) : '') + (op.alt ? '，所以改走' + stripEnd(op.alt) : ''))
    case 'SHELVED': return endZh(zj('先不考虑', t) + (op.why ? '（' + stripEnd(op.why) + '）' : '') + (op.trigger ? '，除非' + cond(op.trigger) : '') + (op.alt ? '；现在的方向是' + stripEnd(op.alt) : ''))
    case 'PLAN': return endZh(zj('下一步工具调用是', t.replace(/^(?:下一步(?:工具调用)?[:：]?\s*)/u, '')))
    case 'OPEN': return endZh(zj('还没确认的是', stripQ(op.text)))
    case 'IF': return endZh(op.trigger && op.then ? zj(zj('如果', cond(op.trigger)) + '，那么', stripEnd(op.then)) : t)
    // S8-R5：锚点带出处与逐字性声明（oracle 第 2 轮：节选代码行缺出处 ⇒ 主模型先 read_file 全文）
    case 'READY': return op.auto
      ? endZh(op.at ? zj('改法是', t) + '；这一行的逐字原文是 `' + op.at + '`，可以直接当 edit_file 的 old_text，不用再读文件' : t)
      : endZh((op.trigger ? zj(zj('如果', cond(op.trigger)) + '，那么需要改', t) : zj('需要改的是', t)) + (op.at ? '；这一行的逐字原文是 `' + op.at + '`，可以直接当 edit_file 的 old_text' : ''))
    default: return endZh(t)
  }
}
const PROSE_PARA = { FACT: 0, COMPUTED: 0, INCUMBENT: 0, REFUTED: 1, SHELVED: 1, PLAN: 2, OPEN: 2, IF: 3, READY: 3 }
// 段落：状态（含看过的代码）→ 死路 → 计划 / 未决 → 「所以」结论 → 判读 / 已备改法（收尾，S8-R3）。散文里不再另出重复的尾段。
export function renderProse(ordered, lang, loci = [], concl = '') {
  const paras = [[], [], [], [], []]
  for (const o of ordered) { const g = PROSE_PARA[o.k] ?? 0; paras[g === 3 ? 4 : g].push(proseSentence(o, lang)) }
  for (const at of loci) paras[0].push(lang === 'en' ? 'The exact code seen earlier (verbatim, usable as edit_file old_text): `' + at + '`.' : '前面看到的原文（逐字，可以直接当 edit_file 的 old_text）：`' + at + '`。')
  if (concl) paras[3].push(concl)
  const sep = lang === 'en' ? ' ' : ''
  return paras.filter((p) => p.length).map((p) => p.join(sep)).join('\n\n')
}

export function renderOps(chosen, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const L = T[lang]
  const ordered = chosen.slice().sort((a, b) => (GROUP[a.k] - GROUP[b.k]) || (a.idx - b.idx))
  if (opts.prose) {
    let conclS = ''
    if (opts.tail !== false) {
      const inc = ordered.filter((o) => o.k === 'INCUMBENT' && o.ev !== 'guess')
      const c = inc.length ? inc[inc.length - 1]
        : ordered.filter((o) => (o.k === 'COMPUTED' || (o.k === 'FACT' && o.kind2 === 'pivot')) && o.ev !== 'guess').sort((a, b) => scoreOp(b) - scoreOp(a) || b.idx - a.idx)[0]
      if (c) conclS = lang === 'en' ? 'So ' + stripEnd(c.text) + '.' : endZh(zj('所以', stripEnd(c.text)))
    }
    return renderProse(ordered, lang, opts.loci || [], conclS)
  }
  const lines = ordered.map((o) => renderLine(o, lang))
  if (!opts.prose) for (const at of (opts.loci || [])) lines.push('- ' + (lang === 'en' ? 'Relevant code I looked at: `' : '我看过的相关代码：`') + at + '`')
  const tail = []
  if (opts.tail !== false) {
    const inc = ordered.filter((o) => o.k === 'INCUMBENT' && o.ev !== 'guess')
    const concl = inc.length ? inc[inc.length - 1]
      : ordered.filter((o) => (o.k === 'COMPUTED' || (o.k === 'FACT' && o.kind2 === 'pivot')) && o.ev !== 'guess').sort((a, b) => scoreOp(b) - scoreOp(a) || b.idx - a.idx)[0]
    if (concl) {
      const t = stripEnd(concl.text)
      tail.push(concl.k === 'INCUMBENT' ? L.tailIncumbent(t) : concl.ev === 'tool' && concl.k === 'FACT' ? L.tailFact(t) : L.tailJudged(t))
    }
    // 有判读表时不再重复未决问题：判读本身就是「这个问题的各种答案意味着什么」，末尾停在问题上会把下一步推向重新推理
    const ifs = ordered.filter((x) => x.k === 'IF')
    // 理论 S8-R3：块尾不放问句 ⇒ 没拆出 trigger/then、原文又是问句的判读不进尾段
    const ifs2 = ifs.filter((x) => (x.trigger && x.then) || !isQ(x.text))
    const rules = (ifs2.some((x) => !x.auto) ? ifs2.filter((x) => !x.auto) : ifs2).slice(-3)
    if (!rules.length) for (const o of ordered.filter((x) => x.k === 'OPEN').slice(-2)) tail.push(L.tailOpen(stripQ(o.text)))
    for (const o of rules) tail.push(o.trigger && o.then ? L.tailRule(stripEnd(o.trigger), stripEnd(o.then)) : stripEnd(o.text) + (lang === 'en' ? '.' : '。'))
    // 尾段以已备好的改法收束（最后一条）：观察一旦证实前提，下一步就是它
    const rds = ordered.filter((x) => x.k === 'READY')
    const rd = (rds.some((x) => !x.auto) ? rds.filter((x) => !x.auto) : rds).slice(-1)[0]
    if (rd) tail.push(rd.auto ? stripEnd(rd.text) + (lang === 'en' ? '.' : '。') : L.tailReady(stripEnd(rd.text), stripEnd(rd.trigger), rd.at))
  }
  const sep = lang === 'en' ? ' ' : ''
  return lines.join('\n') + (tail.length ? '\n\n' + tail.join(sep) : '')
}

/** 渲染语言跟随原文（理论 S5 规则 4）：宽字符占比 ≥ 20% ⇒ 中文模板，否则英文模板。 */
export function renderLang(raw, threshold = 0.2) {
  try { return wideShare(String(raw || '')) >= threshold ? 'zh' : 'en' } catch { return 'zh' }
}

/**
 * v12.5 代码保底：副模型漏标的判读句 / 改法句，由程序把原文句子**逐字**补成 IF / READY 条目。
 * 实测（ops7）：判读句已逐字列进提示词，副模型仍在 2/5 块上一条 IF 都不标 —— 提示词约束不可靠，关键内容由代码兜底。
 * 逐字原文 ⇒ 不可能编造；已被某条目覆盖（锚点落在句内 / 句子落在条目文本里）的不补；已在原文尾巴里的不补。
 */
export function autoHintOps(raw, kept, suffix = '') {
  const covered = (h) => {
    const nh = norm(h)
    return kept.some((o) => (o.anchor && nh.includes(norm(o.anchor))) || (o.text && norm(o.text).includes(nh)))
  }
  const out = []
  // 只做保底：副模型已标过这一类就不补（补进来的逐字句与它的条目重复、还会抢走尾段）；
  // 带否定 / 犹豫措辞的不补（ops7b 实测：「可以考虑 sudo chown…但不应修改真实 home」被补成改法并排在尾段最后）；超长句不补也不截断
  const has = (k) => kept.some((o) => o.k === k)
  const NEG = /不应|不要|别再|不行|不确定|没用|行不通|不能|可能没|\bnot\b|\bdon't\b|\bshouldn't\b/i
  const add = (k, h0, i) => {
    const h = h0.replace(/^(?:[-*•]|\d+[.)]|[（(]\d+[）)])\s*/, '')   // v12.7：原文列表项去掉项目符号（仍是原文子串）
    if (has(k) || h.length > 150 || NEG.test(h) || covered(h) || (suffix && suffix.includes(h))) return
    out.push({ id: 'h' + k[0].toLowerCase() + (i + 1), idx: 10000 + out.length, k, ev: 'derived', kind2: null, text: stripEnd(h), anchor: h.slice(0, 40),
      key: '', src: '', alt: '', why: '', then: '', trigger: '', supersedes: '', deps: [], retracts: [], auto: true })
  }
  const fx = fixHints(raw, 3)
  const readyC = fx.filter((h) => h.length <= 150 && !NEG.test(h)).slice(-1)
  readyC.forEach((h, i) => add('READY', h, i))
  condHints(raw, 6).filter((h) => !fx.includes(h) && h.length <= 150 && !NEG.test(h)).slice(-2).forEach((h, i) => add('IF', h, i))
  return out
}

// ── 总入口 ──────────────────────────────────────────────────────────────────
/**
 * 副模型输出 + 原文 ⇒ 出生文本。任何整块失败都返回 { ok:false, reason }，由调用方原文放行。
 * @param cfg { compressV4BudgetChars?, compressTargetMax?, compressV4Tail?, compressV4MaxRejectRatio? }
 * @returns {{ ok: true, text, stats } | { ok: false, reason, stats }}
 */
export function compileV4(output, raw, cfg = {}, budget = null) {
  const stats = { outputChars: String(output || '').length }
  const parsed = parseOps(output)
  if (parsed.error) return { ok: false, reason: 'v4-' + parsed.error, stats }
  return compileOpsV4(parsed.ops, raw, cfg, budget, stats)
}

/**
 * ★ v12.6 compress-v4-direct 程序门（理论 S8-R6）：副模型直写散文，代码只做能机械判定的事。
 *   锚点硬校验：`…` 片段必须是原文（或任务观察）里一字不差的子串；不是就剥掉反引号（不许假称逐字）。
 *   判读 / 语域 / 出处只统计不熔断（样例 + 尾段重申已把漏判率压低；熔断 = 原文放行，先测漏率再收紧）。
 *   熔断只有两种：空输出、超长（compressV4DirectMaxChars，缺省 2000；v12.8.9 起 1800→2000：v4d5 完整闭合稿 1600–1950 字，2/10 撞 1800 整份丢掉换原文）。
 *   v12.7.1：1300 → 1600。1300 是按 v4d1 开放分支的稿定的（oD/oE/oF 侧输出 920–1247）；R7 要求每个改法分支闭合
 *   （`逐字落点` ≤200 字 + 可用句 ≈70 字 + 改成什么），两个分支就比开放形态多 200–500 字，v4d2 首压 5 份里 2 份（1382 / 1457）撞熔断 ⇒
 *   整份稿被丢、原文（3000–9000 字）放行，比一份 1457 字的稿坏得多。熔断的职责是拦「跑飞」（照抄原文 ≥3000），1600 仍拦得住。
 * @returns {{ ok: true, text, stats } | { ok: false, reason, stats }}
 */
// 样例专名（片段级剥离用；与 EXAMPLE_MARK_RE 同源，只列会被当成事实抄进「已排除 / 事实」的名词）
const EXAMPLE_TOKENS = ['换连接池重试', '连接池重试', '连接池', 'ping-db', 'logs/pool.log', 'net.yaml', '10.0.0.5']   // 不列 pool.js / 端口号：真实仓库里可能同名，反引号核真已覆盖代码段
const EXAMPLE_MARK_RE = /pool\.js|pool\.log|logs\/pool|net\.yaml|10\.0\.0\.5|\bdial\b|cfg\.port|8123|5432|ping-db|nc -zv|connected|连接池|超时是连不上|三次重试|主机不通|旧端口|端口/
export function compileV4Direct(side, raw, cfg = {}) {
  let text = String(side == null ? '' : side).trim()
  const stats = { outputChars: text.length }
  const fence = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  if (fence) { text = fence[1].trim(); stats.unfenced = true }
  if (!text) return { ok: false, reason: 'v4d-empty', stats }
  // v12.9.1：【验收提示】是程序从 ctx 算出来的（S10.14 K1–K3），稿照抄它的反引号片段（`: > ~/.dsh/trace.log`）不是发明 ⇒ 并入核真集合
  const hintText = /【台账】/.test(String(cfg.compressCtx || '')) ? verifyHints(cfg.compressCtx).join('\n') : ''
  const hay = norm(raw + '\n' + (cfg.compressCtx || '') + '\n' + hintText)
  let invented = 0, newText = 0
  const rawHay = raw + '\n' + (cfg.compressCtx || '') + '\n' + hintText
  // v12.9.0：样例整句抄写（d9a flaky：「调大超时试过没用，不选：超时是连不上的结果不是原因。」原样出现在与端口毫无关系的任务里）——
  //   原文 / 观察里没有这句就剥掉；否则它会被当成事实，多轮台账还会把它当「已排除」跨轮传播
  //   只剥带样例专有内容的句子（端口 / 连接池 / pool.js …）；逃生句、状态声明这类模板句本来就该照抄
  for (const sent of exampleSentences()) {
    if (!EXAMPLE_MARK_RE.test(sent)) continue
    if (text.includes(sent) && !hay.includes(norm(sent))) { text = text.split(sent).join(''); stats.parrotedExample = (stats.parrotedExample || 0) + 1 }
  }
  // v12.9.1：样例片段级抄写（auto-d2d flaky：「已排除：调大超时（治症状）、换连接池重试（要动多处、落点没看过）」——「换连接池重试」是样例的排除项，任务里没有连接池）
  //   原文 / 观察里没有该样例专名 ⇒ 剥掉含它的顿号 / 逗号列表项（连同紧跟的括注），句子其余部分保留；专名真在原文 / 观察里出现的一律不动
  for (const tok of EXAMPLE_TOKENS) {
    const core = tok.includes('连接池') ? '连接池' : tok.includes('pool') ? 'pool' : tok
    if (!text.includes(tok) || hay.includes(norm(core))) continue
    const re = new RegExp('(^|[、，,；：:])[^、，,。；：:\\n]*' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^、，,。；\\n（(]*(?:[（(][^）)\\n]*[）)])?', 'g')
    const before = text
    text = text.replace(re, (all, lead) => (lead === '、' || lead === '，' || lead === ',' ? '' : lead))
    if (text !== before) {
      stats.parrotedFragment = (stats.parrotedFragment || 0) + 1
      text = text.replace(/([：:；])[、，,]/g, '$1').replace(/(?:^|(?<=[。；\n]))[^。；\n]{0,6}(?:已排除|排除)[：:]\s*(?:[。；]|$)/gm, '').replace(/[：:]([。；])/g, '$1')
    }
  }
  const hayNums = new Set([...rawHay.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]))
  // v14.18.3：若副模型把不同行的两个 key:val 拼进同一个 old_text（如 `primaryDelayMs: 1500, hedgeAfterMs: 1600`），而原文/观察里只有单行 `{ hedgeAfterMs: 1600 }`，自动收敛到真实存在的单键落点（否则主模型照抄 old_text 会匹配失败）
  text = text.replace(/(old_text\s*是\s*)`?([A-Za-z_]\w*\s*:\s*\d+\s*,\s*([A-Za-z_]\w*\s*:\s*\d+))`?([\s\S]{0,120}?new_text\s*是\s*)`?([A-Za-z_]\w*\s*:\s*\d+\s*,\s*([A-Za-z_]\w*\s*:\s*\d+))`?/g, (all, p1, fullOld, tailOld, mid, fullNew, tailNew) => {
    if (hay.includes(norm(fullOld))) return all
    const bracedOld = `{ ${tailOld.replace(/\s+/g, ' ').trim()} }`, bracedNew = `{ ${tailNew.replace(/\s+/g, ' ').trim()} }`
    if (hay.includes(norm(bracedOld))) { stats.canonicalizedTriple = (stats.canonicalizedTriple || 0) + 1; return `${p1}\`${bracedOld}\`${mid}\`${bracedNew}\`` }
    return all
  })
  text = text.replace(/`([^`\n]{1,300})`/g, (all, span, at) => {
    const n = norm(span)
    if (n && hay.includes(n)) return all
    // 理论 S8-R8b：「new_text 是 `…` / 改成 `…`」引导的段是要写入的新文本，不是引用；按标识符级核真（段内标识符全部来自原文 / 观察即可）
    if (NEW_TEXT_LEAD_RE.test(text.slice(Math.max(0, at - 12), at)) && !inventedIdentifiers(rawHay, span).length) { newText++; return all }
    invented++
    return span
  })
  // v14.18.3：确定性数字锚定（消除副模型把 390/280/1720 四舍五入凑整成 400/300/1700，或心算 5000-1500=3500 造出原文未出现的数字）
  text = text.replace(/\b(\d{3,4})(?=ms\b|\s*(?:上下|左右|附近)|\b)/g, (all, numStr) => {
    if (hayNums.has(numStr)) return all
    const v = Number(numStr)
    if (v % 100 === 0) {
      const near = [...hayNums].map(Number).filter((h) => Number.isFinite(h) && h >= 100 && Math.abs(h - v) > 0 && Math.abs(h - v) <= 30).sort((a, b) => Math.abs(a - v) - Math.abs(b - v))
      if (near.length === 1) { stats.snappedNumbers = (stats.snappedNumbers || 0) + 1; return String(near[0]) }
    }
    return all
  })
  text = text.replace(/[，,；;]?\s*余量(?:由|从)\s*\d+\s*ms\s*拉(?:大)?到\s*(\d{3,4})\s*ms/g, (all, d) => hayNums.has(d) ? all : '，把竞态余量拉大')
  stats.inventedSpans = invented
  if (newText) stats.newTextSpans = newText
  stats.chars = text.length
  const tail = text.slice(Math.floor(text.length * 0.55))
  stats.closeLoop = /如果[^。？\n]{1,90}[，,]?\s*(?:那么|就|则)/.test(tail) || /\bif\b[^.\n]{1,90}[,，]?\s*(?:then|,)/i.test(tail)
  stats.provenance = /逐字/.test(text)
  stats.register = /看起来|所以|下一步工具调用/.test(text)
  if (cfg.compressCtx) stats.ctxChars = String(cfg.compressCtx).length   // 观察上下文到位与否（生产由 plugin 自动构造）
  // v12.9.1：多轮稿（ctx 含【台账】）四段 + 验收预注册（新鲜度 / 不算证据 / 比差 / 收工三问）合理长度 1800–2400（auto-d2c sse 2427 撞 2000 整份丢掉），
  //   熔断只拦「跑飞」（照抄原文 ≥3000）⇒ 多轮缺省 2600，单步仍 2000；显式 compressV4DirectMaxChars 两者都覆盖
  const multiRound = /【台账】/.test(String(cfg.compressCtx || ''))
  const maxChars = Number.isFinite(cfg.compressV4DirectMaxChars) && cfg.compressV4DirectMaxChars > 0 ? cfg.compressV4DirectMaxChars : (multiRound ? 2600 : 2000)
  if (text.length > maxChars) return { ok: false, reason: 'v4d-too-long', stats }
  // 理论 S8-R7：判读分支的动作闭合与落点绑定（可用句写进分支句内、绑定到具体逐字落点）
  if (cfg.compressV4DirectBind !== false) text = bindFixBranches(text, raw, cfg.compressCtx || '', stats)
  // R5 直改可用句（条件补句，effect-14 归因：缺了这句 ⇒ 主模型改前再取证一轮）：
  // 尾段已落到具体改法、有已核真的逐字代码行、却没写「可以直接当 old_text」⇒ 补一句真话（锚点已被门核真）。
  // v12.7 起只作保底：R7 的分支绑定没绑上任何分支时才补这句游离的通用句（effect-16：游离句不起作用，绑定句起作用）。
  const fixTail = /(改法是|需要改|改成|改为|改回|删掉|删去|加上|回滚|换成|修复落在|改测试|改配置|改这里|改\s+[\w./-]{2,})/.test(tail)
  const afford = /old_text|逐字原文已给出|可以直接当/.test(text)
  if (fixTail && !afford) {
    const verifiedAny = /`[^`\n]{1,220}`/.test(text)
    if (verifiedAny) {
      text = text.replace(/\s*$/u, '') + ' 上面逐字引出的代码行可以直接当 edit_file 的 old_text。'
      stats.repairedAffordance = true
    }
  }
  // v12.8.9：no-op 三元组——副模型把 old_text 原样抄成 new_text（d5 首压 wrong-model：逻辑改动被尾部「必须带 new_text」逼出一个等于 old_text 的 new_text）。
  //   主模型照抄就是一次空编辑；删掉 new_text 子句、留下 old_text 与改法意图句（R10.3：逻辑改动由有思考的一方设计）。
  text = text.replace(/old_text 是 `([^`\n]{1,220})`((?:（[^）]*）)?[，,、；;\s]*)new_text 是 `([^`\n]{1,220})`[，,、；;]?/g, (all, a, mid, b) => {
    if (norm(a) !== norm(b)) return all
    stats.noopNewText = (stats.noopNewText || 0) + 1
    return 'old_text 是 `' + a + '`' + mid.replace(/[，,、；;\s]*$/, '') + '，new_text 按下面说的意图改（副模型没给出那一行，由你来写）；'
  })
  // v12.9.2 多轮：① 已排除的候选写回后路（perf 稿把台账里排除的 maxOutputTokens 当「没新东西时走这条」）⇒ 删那一句；
  //   ② 同一括注重复（「（第 1 轮 read_file … 出处仍有效）」抄两三遍）⇒ 只留第一处；③ 程序部件拼进稿（延续段 + 验收提示）
  if (/【台账】/.test(String(cfg.compressCtx || ''))) {
    for (const dm of rawHay.matchAll(/\bsrc\/([A-Za-z0-9_-]+)\.legacy\.js\b/g)) {
      const stem = dm[1], leg = `src/${stem}.legacy.js`, main = `src/${stem}.js`
      if (!text.includes(`${stem}.legacy.js`) && text.includes(main)) {
        text = text.replace(new RegExp(`(${main.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})(\\s*(?:都)?不动)`), `$1 与 ${leg}$2`)
      }
    }
    text = stripExcludedFallback(text, cfg.compressCtx, stats)
    text = dedupeParentheticals(text, stats)
    const ppMode = (cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.programParts) || (cfg && cfg.programParts) || 'all'
    text = spliceProgramParts(text, cfg.compressCtx, stats, { programParts: ppMode })
  }
  stats.chars = text.length
  if (cfg.compressEditTool) { text = adaptEditTool(text, cfg.compressEditTool); stats.editTool = cfg.compressEditTool.name }
  return { ok: true, text, stats }
}

// v12.9.2：已排除候选的标识符（台账「- 已排除：…」+ 稿自己的「已排除：…」段）；只收像标识符 / 路径的词（≥ 4 字符，含大小写混合、下划线、点或斜杠）
const GENERIC_ID_RE = /^(?:edit_file|old_text|new_text|read_file|bash|grep|node|npm|src|test|tests|lib|file|path|true|false|null|this|that|const|return|await|async|function)$/i
function excludedIdentifiers(text, ctx) {
  const segs = []
  const stripWhy = (s) => String(s || '').replace(/[，,（(]\s*(?:因为|由于|原因)[\s\S]*$/, '')
  for (const m of String(ctx || '').matchAll(/^- 已排除[：:]([^\n]+)/gm)) segs.push(stripWhy(m[1]))
  for (const m of String(text || '').matchAll(/(?:^|[。；\n])\s*已排除[：:]([^。；\n]+)/g)) segs.push(stripWhy(m[1]))
  const ids = new Set()
  for (const seg of segs) for (const w of seg.matchAll(/[A-Za-z_][\w.\/-]{3,}/g)) {
    const x = w[0].replace(/[.,;:]+$/, '')
    if (GENERIC_ID_RE.test(x) || !/[A-Z_.\/]|\d/.test(x) && x.length < 6) continue
    ids.add(x)
  }
  // 选定改法里出现的标识符不算「已排除候选」（auto-d2b eacces：「改测试文件让它用 DSH_HOME 也不选」里的 DSH_HOME 同时是落定行 `DSH_HOME: tmp` 的一部分——
  //   剥掉含它的提议句会把落定三元组连带删掉）：已定 / 已改 / 提议 / 延续段首句 / 本轮 edit 调用 / 稿里的落定句与第一个三元组，全部豁免
  const keep = []
  for (const m of String(ctx || '').matchAll(/^- 第 \d+ 轮(?:已定|已改|提议)[^\n]*/gm)) keep.push(m[0])
  const cm = String(ctx || '').match(/^【延续段】[^\n]*\n([^\n]+)/m); if (cm) keep.push(cm[1].split(/(?<=。)/)[0])
  for (const m of String(ctx || '').matchAll(/^- (?:edit_file|str_replace\w*|apply_patch|edit)\s[^\n]*/gm)) keep.push(m[0])
  for (const m of String(text || '').matchAll(/(?:改法只落一个|改法分[一二两三\d]+处|所以下一步工具调用是)[^。\n]*/g)) keep.push(m[0].split(/；\s*(?=仍在依赖的事实)/)[0])
  const first = String(text || '').match(/old_text 是 `[^`]*`[^。]*?new_text 是 `[^`]*`/); if (first) keep.push(first[0])
  for (const w of keep.join('\n').matchAll(/[A-Za-z_][\w.\/-]{3,}/g)) ids.delete(w[0].replace(/[.,;:]+$/, ''))
  return ids
}
const FALLBACK_ACTION_RE = /edit_file|old_text 是|new_text 是|改\s+[\w./-]+\s+的\s+`|另一个值行|第二个三元组|改回|让它回到/
const NEG_IN_SENT_RE = /不要|不动|不选|不改|已排除|排除|不再|别动|不能是/
export function stripExcludedFallback(text, ctx, stats = {}) {
  const ids = excludedIdentifiers(text, ctx)
  if (!ids.size) return text
  // 只看落定句 / 「所以下一步」之后的分支区（推翻路 / 后路），不碰落定句与第一分支之前的正文
  const startAt = (() => { const i = String(text).search(/所以下一步工具调用是|验收先写下|验收是/); return i < 0 ? String(text).length : i })()
  const head = text.slice(0, startAt), tail = text.slice(startAt)
  const sents = tail.split(/(?<=[。；])(?![^（(]*[）)])/)
  let removed = 0
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const kept = sents.filter((sent) => {
    if (!FALLBACK_ACTION_RE.test(sent)) return true
    if (/^\s*(?:所以下一步工具调用是|上一轮(?:已定|已改|提议)|改法只落一个|改法分[一二两三\d]+处|仍在依赖的事实|已走过的路)/.test(sent)) return true
    const words = new Set([...sent.matchAll(/[A-Za-z_][\w.\/-]{3,}/g)].map((w) => w[0].replace(/[.,;:]+$/, '')))
    // 命中的标识符若是被否定的对象（「不要动 X」「X 不选」）⇒ 这句不是在提议它，保留
    // 否定必须贴着这个标识符：前 14 字内有否定词、或其后 10 字内（不跨反引号 / 括号——「`maxOutputTokens: 850,`（本轮不动 compressTargetMax）」里的「不动」不是在否定 maxOutputTokens）
    const hit = [...ids].find((id) => words.has(id) && !new RegExp('(?:' + NEG_IN_SENT_RE.source + ')[^，。；`（()）]{0,14}' + esc(id) + '|' + esc(id) + '[^，。；`（()）]{0,10}(?:不选|不动|不改|已排除)').test(sent))
    if (!hit) return true
    removed++
    stats.excludedFallback = (stats.excludedFallback || []).concat(hit)
    return false
  })
  if (!removed) return text
  return head + kept.join('').replace(/[：:]\s*(?=如果输出跟这两种都不像)/, '。')
}
export function dedupeParentheticals(text, stats = {}) {
  const seen = new Set()
  let n = 0
  const out = String(text).replace(/（[^（）\n]{20,160}）/g, (all) => {
    if (!/出处仍有效|原样行|不带行首缩进|照用/.test(all)) return all
    const key = all.replace(/\s+/g, '')
    if (seen.has(key)) { n++; return '（出处同上）' }
    seen.add(key)
    return all
  })
  if (n) stats.dedupedParentheticals = n
  return out
}

/**
 * v12.8.1（不同宿主）：稿与门内部一律用本仓库的规范词 edit_file / old_text / new_text；最后一步换成宿主真实的工具名与参数名
 *（cfg.compressEditTool = { name, oldKey, newKey }，生产由 plugin 从出站 tools 认出）。只换整词，不碰反引号里的代码。
 */
export function adaptEditTool(text, tool) {
  if (!tool || !tool.name) return text
  const map = { edit_file: tool.name, old_text: tool.oldKey || 'old_text', new_text: tool.newKey || 'new_text' }
  const parts = String(text).split('`')
  for (let i = 0; i < parts.length; i += 2) parts[i] = parts[i].replace(/\b(edit_file|old_text|new_text)\b/g, (w) => map[w])
  return parts.join('`')
}

// ── S8-R7 判读分支的动作闭合与落点绑定 ───────────────────────────────────────
// effect-16 逐样本：分支里写了「改哪一行（逐字）+ 可直接当 old_text + 不再取证」的稿，主模型直接 edit_file（flaky oC 8.5、perf oF 10.0）；
// 只写方向（「拉开余量或改用 fake timers」）+ 末尾游离一句通用可用句的稿，主模型一律回头 read_file（flaky oE/oF 1.5–2.0）。
// 程序能机械做的：找出尾段的判读分支；含改法措辞的分支必须含一个已核真的 `…` 片段；没有就按标识符 / 数字 / 文件名重叠，
// 从已核真片段与任务观察里的代码行中绑定一个落点；把可用句写进该分支句内。析取（A 或 B）只统计，不改写（落定由提示词负责）。
const BRANCH_FIX_RE = /(改法|改成|改为|改回|改掉|改用|改测试|改配置|改这|改那|改源|改代码|改文件|改回去|改[^，。；]{0,12}(?:那一行|这一行|一行)|改\s+[\w./-]{2,}|(?:加|补|删|改)\s*`|修复|修掉|修改|修测试|删掉|删去|删除|加上|补上|补一|回滚|回落|回退|降回|降到|调回|换成|替换|拉开|拉大|放宽|调大|调小|设为|设成|设小|设大|edit_file|把[^，。；]{1,60}(?:改|删|加|换|拉|调|回落|回退|设)|直接改|就改|去改|需要改|应改|该改)/
// 弱改法词（换工具 / 换方案也会这么说）：then 里同时有取证措辞时不算改法（「改用 docker 再复现」是换复现手段）
const WEAK_FIX_RE = /^(?:改用|改为|换成|替换|加上|加|补上|补一|拉开|拉大|放宽|调大|调小|设为|设成|设小|设大)/
const PROBE_THEN_RE = /复现|再查|另查|去查|排查|再看|先看|查看|确认|检查|grep|read_file|再跑|重跑|再压|再测/
const BRANCH_HEAD_RE = /(?:^|[，,；;：:—\s])(?:如果|若是|若|要是|假如)/
const BRANCH_THEN_RE = /(那么|就|则|⇒|→|=>)/
const DISJ_RE = /(或者|或是|或|还是|\bor\b)/
// 改法措辞前面紧跟否定 ⇒ 这不是改法分支（「而不是改 src/distill.js」「不用再改」）
const NEG_BEFORE_RE = /(不是|不要|不用|不必|不该|不应|不再|不去|无需|别|而非|非)\s*$/
// 反引号片段前面是「补 / 加 / 改成 / 换成」⇒ 片段是要写入的新文本，不是落点
const NEW_TEXT_BEFORE_RE = /(补上|补一句|补|加上|加入|加|改成|改为|换成|替换为|替换成|设为|设成|写成|变成|改写为|改写成)\s*$/
/** 分支的 then 部分是否落到改法（含否定排除） */
export function isFixBranch(thenPart) {
  const re = new RegExp(BRANCH_FIX_RE.source, 'g')
  const probe = PROBE_THEN_RE.test(thenPart)
  for (const m of thenPart.matchAll(re)) {
    // 1. 前面有明确否定（「此时不要改」「不用再改」「不能盲目改」）
    if (NEG_BEFORE_RE.test(thenPart.slice(Math.max(0, m.index - 6), m.index))) continue
    // 2. 「不能凭…去改」「不要凭…去改」「我自己否了」：否定前置或后置的假设排除
    const leadContext = thenPart.slice(Math.max(0, m.index - 16), m.index)
    if (/(?:不能|不要|不可|切勿|不应)[^，。；]{0,12}(?:去|就|直接)?$/.test(leadContext)) continue
    const trailContext = thenPart.slice(m.index, Math.min(thenPart.length, m.index + 32))
    if (/(?:这条候选|这种方案|这种改法|这路)[^，。；]{0,12}(?:否了|放弃|排除|不采|不走|不选)/.test(trailContext)) continue
    // 3. 「设成了什么值 / 被设为」等反问状态描述不是改动动作
    if (/^(?:设为|设成|设小|设大)/.test(m[0]) && /(?:什么|哪|如何|怎样)/.test(thenPart.slice(m.index, m.index + 16))) continue
    // 4. 「按第一条分支改…」「按上述改法」等引用前文分支的条件描述不是本分支的改法动作
    if (/(?:按|依照|依据|参照)[^，。；：:]{0,12}(?:分支|条|上述|前面)[^，。；：:]{0,6}$/.test(leadContext)) continue
    // 「需要改用 docker 再复现」：去掉「需要 / 应该 / 直接」这类前导后看动词本身是不是弱改法词
    const lead = /^(?:需要|应该|应|该|就|直接|去)/.exec(m[0])
    const verbAt = m.index + (lead ? lead[0].length : 0)
    if (probe && WEAK_FIX_RE.test(thenPart.slice(verbAt, verbAt + 8))) continue
    return true
  }
  return false
}
const TOKEN_STOP = new Set(['the', 'and', 'for', 'not', 'null', 'true', 'false', 'undefined', 'edit_file', 'read_file', 'old_text', 'new_text',
  'bash', 'grep', 'tool', 'file', 'run', 'git', 'diff', 'npm', 'node', 'src', 'test', 'tests', 'lib', 'const', 'let', 'var', 'return', 'function',
  'import', 'export', 'from', 'this', 'that', 'with', 'into', 'then', 'else', 'when', 'ms', 'log', 'error', 'ok', 'json', 'yaml', 'yml', 'sh', 'js', 'mjs', 'ts'])
/** 分支 / 片段里的强 token：标识符（含点号、连字符形态及其各段）与 ≥3 位数字 */
export function strongTokens(s) {
  const out = new Set()
  for (const m of String(s || '').matchAll(/[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*/g)) {
    const t = m[0]
    if (t.length >= 3 && !TOKEN_STOP.has(t.toLowerCase())) out.add(t)
    for (const p of t.split(/[.\-]/)) if (p.length >= 3 && !TOKEN_STOP.has(p.toLowerCase())) out.add(p)
  }
  for (const m of String(s || '').matchAll(/(?<![\w.])\d{3,}(?![\w])/g)) out.add(m[0])
  return out
}
/** 任务观察（ctx）拆成工具块：[{ label, lines }]，label = 「[tool: xxx] 后面的那段」 */
function ctxBlocks(ctx) {
  const blocks = []
  let cur = { label: '', lines: [] }
  for (const line of String(ctx || '').split('\n')) {
    const h = /^\s*\[tool:\s*([^\]]+)\]\s*(.*)$/.exec(line)
    if (h) { if (cur.lines.length || cur.label) blocks.push(cur); cur = { label: (h[1] + ' ' + h[2]).trim(), lines: [] }; continue }
    const t = line.trim()
    if (t) cur.lines.push(t)
  }
  if (cur.lines.length || cur.label) blocks.push(cur)
  return blocks
}
/** 分支里点名的文件：路径 / 文件名（basename）；「测试」映射到 test 目录 */
function fileHints(branch) {
  const out = new Set()
  for (const m of String(branch || '').matchAll(/[\w./-]*[\w-]+\.(?:m?js|c?js|ts|tsx|jsx|json|ya?ml|py|go|rs|sh|md|toml|ini|env)\b/g)) {
    out.add(m[0].split('/').pop())
  }
  // 不带扩展名的点号文件名（「改 birth.selftest 这一行」）：与工具块标签比对
  for (const m of String(branch || '').matchAll(/(?<![\w.])[a-z][\w-]*(?:\.[a-z][\w-]*)+(?![\w.])/g)) if (!/\.(?:then|catch|env|model|js|mjs)$/.test(m[0])) out.add(m[0])
  // 「测试」只在点名要改的是测试（改测试 / 测试文件 / 测试里那一行）时才算文件线索；「传给测试进程」不算
  if (/改测试|测试文件|测试用例|测试里|测试的那|测试那一行|测试这一行|selftest|\btest file/i.test(branch)) out.add('test/')
  return out
}
function labelMatches(label, hints) {
  if (!label) return false
  for (const h of hints) {
    if (h === 'test/') { if (/(^|[\s/])test\//.test(label) || /\.selftest\./.test(label)) return true; continue }
    if (label.includes(h)) return true
  }
  return false
}
/** 候选落点：文中已核真的 `…` 片段 + 任务观察里含标识符的代码 / 配置行；带来源标签 */
function locusCandidates(text, ctx, raw = '', stats = {}) {
  const blocks = ctxBlocks(ctx)
  const labelOf = (span) => { const n = norm(span); for (const b of blocks) if (b.lines.some((l) => norm(l).includes(n))) return b.label; return '' }
  // v12.8.9：只以 git diff「-」行身份出现在原文 / 观察里的片段是旧值，不在当前文件里，不能当 old_text 候选
  //   （d5c perf：稿按 R8a 把 `-  maxOutputTokens: 850,` 写成文件形 `maxOutputTokens: 850,`，门把它绑成落点 ⇒ 主模型 sed 把两个值一起回滚）
  const hayLines = (String(raw || '') + '\n' + String(ctx || '')).split('\n')
  const minusOnly = (span) => { const n = norm(span); let hit = 0, minus = 0; for (const l of hayLines) { if (!norm(l).includes(n)) continue; hit++; if (/^\s*-(?!-)\s/.test(l)) minus++ } return hit > 0 && minus === hit }
  const seen = new Set()
  const out = []
  for (const m of String(text || '').matchAll(/`([^`\n]{1,220})`/g)) {
    const span = m[1].trim()
    if (!span || seen.has(span)) continue
    seen.add(span)
    if (!usableLocus(span)) continue
    if (minusOnly(span)) { stats.minusLineCandidateSkipped = (stats.minusLineCandidateSkipped || 0) + 1; continue }
    out.push({ span, label: labelOf(span), inText: true })
  }
  for (const b of blocks) {
    for (const l0 of b.lines) {
      // 理论 S8-R8a：落点的逐字性是相对文件的——git diff 的 `+` 与 grep / sed -n 的 `文件:行号:` 是观察格式，不是文件内容，先剥掉
      const { span: l, via } = fileVerbatim(l0)
      if (seen.has(l) || !usableLocus(l)) continue
      // 只要代码 / 配置形态的行（有标识符且带符号），不要工具输出里的散文
      if (!/[=:(){}\[\];'"`<>\/]/.test(l)) continue
      seen.add(l); out.push({ span: l, label: b.label, inText: false, via })
    }
  }
  return out
}
/**
 * 观察里的一行 → 文件里逐字的样子。diff 增加行 `+  x: 1,` → `x: 1,`（via 'diff'）；grep -n / sed -n 的 `src/a.js:233:  return …` 或
 * `233:  return …` → `return …`（via 'grep'）；其余原样（via ''）。diff 删除行不在此处理（usableLocus 一律拒绝）。
 * effect-18 perf/oH#0 主模型原话：「之前的推理说逐字原文是 `+  compressTargetMax: 1800,`，但实际文件里可能没有加号。最好先用 read_file 确认」。
 */
export function fileVerbatim(line) {
  const t = String(line || '')
  let m
  if ((m = /^\+(?!\+)\s*(\S.*)$/.exec(t))) return { span: m[1].trim(), via: 'diff' }
  if ((m = /^(?:[\w./\\-]+\.[A-Za-z0-9]{1,6}:)?\d{1,6}[:-]\s*(\S.*)$/.exec(t)) && !/^\d+[:-]\s*\d/.test(t)) return { span: m[1].trim(), via: 'grep' }
  return { span: t.trim(), via: '' }
}
// 能当 old_text 的片段：像一行代码 / 配置（有空格或结构符号），不是光秃标识符或路径（`CFB_REAL_DSH_HOME`、`/home/u/.dsh`）、
// 不是 git diff 删除行（`-  x: 850,`）、不是 shell 命令（`grep -R … src`）、不是日志 / 断言输出行（`FAIL test/… Error: EACCES…`）
const CMD_RE = /^(?:grep|rg|bash|sh|zsh|node|npm|npx|yarn|pnpm|taskset|docker|git|sed|awk|cat|ls|echo|curl|wget|find|for\s|while\s|stress|analyze-trace|python3?|pip|make|cd|export|source|kill|ps|top|nproc|seq|sudo|chmod|chown|rm)\b|\|\|\s*break|\s-lc\s|\$\(seq/
const LOG_RE = /^(?:FAIL|PASS|OK|Error|[A-Z]\w*Error|npm ERR|\[|\$|>|#|✓|✗|at\s|expected\s|got\s|run\s*\d)|\b(?:passed|failed)\b/
export function usableLocus(sp) {
  const t = String(sp || '').trim()
  return t.length >= 6 && t.length <= 220 && /\s|[=:(){}\[\];'"<>]/.test(t) && !/^[\w$.\/~\-]+$/.test(t) && !/^-\s/.test(t) &&
    !CMD_RE.test(t) && !LOG_RE.test(t) && strongTokens(t).size > 0
}
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 片段里的「键: 值 / 键 = 值」小段；含 token t（作键或作值）的第一段 */
const valueSegOf = (span, t) => {
  const word = new RegExp('(?:^|[^\\w$])' + reEsc(t) + '(?![\\w$])')
  for (const m of String(span).matchAll(/[A-Za-z_$][\w$.]*\s*[:=]\s*[^,;，；\s]+/g)) if (word.test(m[0])) return m[0]
  return null
}
/**
 * 给分支挑落点（理论 S8-R7 规则 3 的机械形式）：标识符 / 数字重叠 ×10（在手优先），分支点名的文件 +15（点名压过单个标识符重叠），
 * 值行（ident: literal / ident = literal，改一个值优于改逻辑）+4，代码形态 +2，文中已引 +1，未引的文件行按与全稿的重叠排序，长度只作平局裁决。
 * 选中的行若混着中文（工具节选把散文和代码写在一行），收窄到 `ident: value` 这一小段（仍是逐字子串）。
 */
export function bindLocus(branch, candidates, wholeText = '') {
  const toks = strongTokens(branch)
  const hints = fileHints(branch)
  const all = wholeText ? strongTokens(wholeText) : null
  let best = null
  for (const c of candidates) {
    const ct = strongTokens(c.span)
    const hit = [...toks].filter((t) => ct.has(t))
    const fileHit = labelMatches(c.label, hints)
    if (!hit.length && !fileHit) continue
    const valueTok = hit.find((t) => valueSegOf(c.span, t))
    // 值行：重叠 token 是键（`hedgeAfterMs: 1600` 之于 hedgeAfterMs）+4；只是值（之于 1600、`data: [DONE]` 之于 DONE）+2
    const asKey = valueTok && new RegExp('(?:^|[^\\w$])' + reEsc(valueTok) + '\\s*[:=]').test(c.span)
    // 只靠文件点名命中的行，用「与全稿的标识符重叠」在文件内部排序（讨论过的那一行，而不是 import 行）
    const ctxHit = all && !c.inText ? Math.min(6, [...ct].filter((t) => all.has(t)).length) : 0
    let score = hit.length * 10 + (fileHit ? 15 : 0) + (valueTok ? (asKey ? 4 : 2) : 0) + (/[=(){};]|,\s*$/.test(c.span) ? 2 : 0) + (c.inText ? 1 : 0) +
      (/^read_file\b/.test(c.label) ? 2 : 0) + ctxHit * 0.5 - c.span.length / 200   // 文件内容里的行天然是落点；bash 输出里的行（diff / grep -n）次之
    if (/^(?:import\s|export\s|from\s|\/\/|\/\*|#|\*)/.test(c.span)) score -= 5   // import / 注释行不是改动落点
    if (!best || score > best.score) best = { ...c, score, overlap: hit.length, fileHit, valueTok }
  }
  if (best && best.valueTok && /[\u4e00-\u9fff]/.test(best.span)) {
    const seg = valueSegOf(best.span, best.valueTok)
    if (seg) best = { ...best, span: seg, narrowed: true }
  }
  return best
}
/** 分支自己引的落点：第一个可用的 `…`（≥6 字、不是光秃标识符、前面不是「补 / 加 / 改成」这类新文本引导词） */
function ownLocus(part) {
  for (const m of String(part || '').matchAll(/`([^`\n]{1,220})`/g)) {
    const raw = m[1].trim()
    const { span, via } = fileVerbatim(raw)   // R8a：副模型自己引了 diff 的 `+ …` 行 ⇒ 落点写成文件里的样子
    if (!usableLocus(span)) continue
    if (NEW_TEXT_BEFORE_RE.test(part.slice(Math.max(0, m.index - 6), m.index))) continue
    return { span, via, quoted: raw }
  }
  return null
}
/** R8a：分支里所有 `+ …` / `file:NN: …` 形的引文改写成文件里的样子，并在第一处后面加一句说明；`- …` 行被当 old_text 只统计（它是旧值，不在文件里） */
function normalizeQuotedLoci(branch, stats = {}) {
  let out = branch, noted = false
  for (const m of String(branch || '').matchAll(/`([^`\n]{1,220})`/g)) {
    const raw = m[1].trim()
    if (/^-\s/.test(raw) && /old_text/.test(branch)) { stats.minusLineAsOldText = (stats.minusLineAsOldText || 0) + 1; continue }
    const { span, via } = fileVerbatim(raw)
    if (!via || span === raw || !usableLocus(span)) continue
    const note = noted ? '' : via === 'diff' ? '（git diff 里行首的加号是 diff 标记，文件里没有它，old_text 不要带加号和行首缩进）' : '（grep 输出里的文件名和行号是前缀，不是文件内容，old_text 不要带它们）'
    out = out.split('`' + raw + '`').join('`' + span + '`' + note)
    noted = true
    stats.fileVerbatimFixed = (stats.fileVerbatimFixed || 0) + 1
  }
  return out
}
/**
 * 把可用句写进分支句内：在分支的结尾标点之前插入。
 * R8a：落点若来自 diff / grep 输出，可用句要说明「加号 / 行号是观察格式，文件里这一行是 `…`」——对文件为真的担保才接得住主模型的自检；
 * 一句假担保（把 `+  x,` 说成逐字原文）会让整份稿的担保作废（effect-18 perf/oH#0）。
 */
function withAffordance(branch, hit) {
  const span = typeof hit === 'string' ? hit : hit.span
  const via = typeof hit === 'string' ? '' : hit.via
  const named = span.length <= 120 ? '`' + span + '`' : '上面那一行'
  const src = via === 'diff' ? '（git diff 里行首的加号是 diff 标记，文件里没有它，old_text 不要带加号和行首缩进）'
    : via === 'grep' ? '（grep 输出里的文件名和行号是前缀，不是文件内容，old_text 不要带它们）' : ''
  const clause = via ? '——文件里这一行是 ' + named + src + '，可以直接当 edit_file 的 old_text，不用先读文件确认'
    : '——落点 ' + named + ' 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件'
  const m = /([。；;！!]+\s*)$/u.exec(branch)
  return m ? branch.slice(0, m.index) + clause + m[1] : branch + clause + '。'
}
/**
 * 分句：在 。；;！!？? 与换行之后切，但**反引号内不切**——逐字代码行里的 `?` / `;`（`done ? 'stop' : null`、`a; b`）不是句号。
 * v12.8.8 修：此前按裸标点切，sse 的 v4d4 稿在 `(done ?` 处被切开，`'stop'` 被当落点、可用句插进了代码段中间 ⇒ 反引号段变成假引文，
 * birthAccept 报 invented-identifier，整份稿在真机被原文放行（compile-direct 一次就撞上）。导出供 draft-lint / 自测复用。
 */
export function splitSentencesTickAware(text) {
  const out = []
  let cur = '', inTick = false
  for (const ch of String(text || '')) {
    cur += ch
    if (ch === '`') { inTick = !inTick; continue }
    if (!inTick && /[。；;！!？?\n]/.test(ch)) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}
/**
 * 尾段判读分支的闭合与绑定（导出供工具 / 自测用）。返回新文本；统计写进 stats：
 *   branches（判读分支数）fixBranches（含改法措辞）boundBranches（已绑定 / 本次绑定）boundBy（'span'|'overlap'|'file' 列表）
 *   unboundFix（找不到落点的改法分支）disjunctiveFix（析取的改法分支）
 */
export function bindFixBranches(text, raw, ctx, stats = {}) {   // raw 暂未用：候选只取已核真片段与任务观察（原文里未引的行不算「在手」）
  const src = String(text || '')
  // 只看尾段（后 60%）的判读分支，但按整句切，不在句中截断（否则「如|果」被切开就找不到分支）
  const start = Math.floor(src.length * 0.4)
  const sents = []
  let off = 0
  for (const piece of splitSentencesTickAware(src)) {
    const t = piece.trim()
    if (t && off + piece.length > start) sents.push(t)   // 跨过 40% 线的整句也算尾段
    off += piece.length
  }
  const isBranch = (s) => BRANCH_HEAD_RE.test(s) && BRANCH_THEN_RE.test(s) && s.length >= 8
  const branches = sents.filter(isBranch)
  if (!branches.length) return text
  const AFFORD_RE = /old_text|逐字原文已给出|可以直接当/
  let cands = null
  let out = src
  let fixN = 0, bound = 0, unbound = 0, disj = 0
  const by = []
  // v12.8.9：副模型自己写出了「old_text 是 `…`」的分支 ⇒ 它会写三元组，其余分支缺可用句多半是「不要改 X」「回退到了默认」这类描述被 isFixBranch 误判
  //   （d7a eacces：把 env 行绑进了「此时不要改 verify.mjs」；d5c perf：把 - 行旧值绑进了取证分支）⇒ 有自闭合三元组时不再做重叠 / 文件兜底绑定
  const selfClosed = branches.some((b) => AFFORD_RE.test(b)) || /old_text 是 `/.test(src)   // v12.9.0：三元组写在「所以下一步」句里（多轮稿常见）也算自闭合
  for (const b of branches) {
    const thenAt = b.search(BRANCH_THEN_RE)
    const thenPart = thenAt >= 0 ? b.slice(thenAt) : b
    if (!isFixBranch(thenPart)) continue
    fixN++
    if (DISJ_RE.test(thenPart)) disj++
    // 分支句里、或紧接的下一句（oracle 稿的写法：「…这一行。这一行上面已有逐字原文，可以直接当 old_text。」）已有可用句 ⇒ 不动
    const next = sents[sents.indexOf(b) + 1]
    if (AFFORD_RE.test(b) || (next && !isBranch(next) && AFFORD_RE.test(next))) {
      bound++; by.push('had')
      // R8a 仍要过：副模型自己写的可用句若指着 diff 的 `+ …` / grep 的 `file:NN: …`，把引文改写成文件里的样子并说明（假担保会让整份稿的担保作废）
      const fixed = normalizeQuotedLoci(b, stats)
      if (fixed !== b) { const idx = out.lastIndexOf(b); if (idx >= 0) out = out.slice(0, idx) + fixed + out.slice(idx + b.length) }
      continue
    }
    let nb = null
    const own = ownLocus(thenPart) || ownLocus(b)
    if (own) {
      // R8a：分支里引的是 diff 的 `+ …` / grep 的 `file:NN: …` ⇒ 先把引文本身改写成文件里的样子，再接可用句
      const b2 = own.via && own.quoted !== own.span ? b.split('`' + own.quoted + '`').join('`' + own.span + '`') : b
      if (own.via && own.quoted !== own.span) stats.fileVerbatimFixed = (stats.fileVerbatimFixed || 0) + 1
      nb = withAffordance(b2, own); by.push('span')
    } else if (selfClosed) {
      stats.bindSkippedSelfClosed = (stats.bindSkippedSelfClosed || 0) + 1
    } else {
      if (!cands) cands = locusCandidates(src, ctx, raw, stats)
      const hit = bindLocus(thenPart, cands, src) || bindLocus(b, cands, src)
      if (hit) { nb = withAffordance(b, hit); by.push(hit.overlap ? 'overlap' : 'file') }
    }
    // R9 判读覆盖（只统计）：trigger 里带「例如 / 比如 / 可能 / 也许」的是仍待证明的假设，不是输出里会字面出现的特征
    if (/(?:如果|若是|若|要是|假如)[^，。；]{0,60}(?:例如|比如|可能|也许|大概|或许)/.test(b)) stats.hedgedTrigger = (stats.hedgedTrigger || 0) + 1
    if (!nb) { unbound++; continue }
    const idx = out.lastIndexOf(b)
    if (idx < 0) { unbound++; continue }
    out = out.slice(0, idx) + nb + out.slice(idx + b.length)
    bound++
  }
  stats.branches = branches.length
  if (fixN) stats.fixBranches = fixN
  if (bound) { stats.boundBranches = bound; stats.boundBy = by }
  if (unbound) stats.unboundFix = unbound
  if (disj) stats.disjunctiveFix = disj
  return out
}

/**
 * v12.8.9（理论 S8-R11 / 卷四 A1「代码算它能算的，副模型只做它才能做的」）：把「在手的代码行」在**压缩之前**算出来交给副模型。
 *   R7 的落点绑定原本在门里事后补救；d5/d6 逐稿归因发现关思考的副模型在 10k 字原文里**选错行**（sse 三次落在提到 [DONE] 的 if 行而不是
 *   造出 'stop' 的 return 行；flaky 落在 distill.js 的逻辑行而不是测试里的值行）——选择题比回忆题好做，所以把候选行列表直接放进提示词。
 *   候选 = 本轮工具结果（ctx）里代码 / 配置形态的行，剥掉 diff 加号与 grep 行号（R8a），排除 diff 的 - 行（旧值），按与原文尾段的标识符重叠排序；
 *   值行（ident: literal）标出来（R7 规则 3：改一个值优于改逻辑）。
 * @returns {Array<{ span, label, via, valueLine, overlap }>}
 */
export function inHandLines(cot, ctx, max = 8) {
  const blocks = ctxBlocks(ctx)
  const src = String(cot || '')
  const tailToks = strongTokens(src.slice(Math.floor(src.length * 0.6)))
  const allToks = strongTokens(src)
  const seen = new Set()
  const out = []
  // 只看会带出**文件内容**的工具块：read_file / cat / git diff / grep -n / sed -n；ls / id / nproc / analyze-trace 的输出是日志不是文件行
  const fileTool = (label) => /^(?:read_file|cat|head|tail)\b/.test(label) || /\b(?:git diff|git show|grep|rg|sed -n)\b/.test(label)
  const VALUE_SEG_RE = /[A-Za-z_$][\w$.]*\s*[:=]\s*(?:['"`][^'"`]*['"`]|-?\d[\w.]*|true|false|null)\s*,?/g
  for (const b of blocks) {
    if (!fileTool(b.label || '')) continue
    for (const l0 of b.lines) {
      if (/^\s*-(?!-)\s/.test(l0)) continue                       // diff 删除行：旧值，不是文件里的行
      const { span, via } = fileVerbatim(l0)
      if (!span || seen.has(span) || !usableLocus(span)) continue
      if (!/[=:(){}\[\];'"`<>\/]/.test(span)) continue
      if (/^(?:import\s|export\s|from\s|\/\/|\/\*|#|\*)/.test(span)) continue
      const toks = strongTokens(span)
      const overlap = [...toks].filter((t) => tailToks.has(t)).length * 2 + [...toks].filter((t) => allToks.has(t)).length
      if (!overlap) continue
      const whole = /^[A-Za-z_$][\w$.]*\s*[:=]\s*(?:['"`][^'"`]*['"`]|-?\d[\w.]*|true|false|null)\s*[,;]?$/.test(span)
      // 散文里夹着的值段（测试节选「server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600」）：单独列出值段——它是文件里的逐字子串，可直接当 old_text
      if (!whole && /[\u4e00-\u9fff]/.test(span)) {
        for (const m of span.matchAll(VALUE_SEG_RE)) {
          const seg = m[0].replace(/,$/, '').trim()
          if (seg.length < 6 || seen.has(seg) || !strongTokens(seg).size) continue
          const segToks = strongTokens(seg)
          if (![...segToks].some((t) => allToks.has(t))) continue
          seen.add(seg); out.push({ span: seg, label: b.label, via, valueLine: true, overlap: overlap + 1, segment: true })
        }
        continue
      }
      seen.add(span)
      out.push({ span, label: b.label, via, valueLine: whole, overlap, kind: whole ? '值行' : lineKind(span) })
    }
  }
  out.sort((a, c) => (c.overlap + (c.valueLine ? 1 : 0)) - (a.overlap + (a.valueLine ? 1 : 0)) || a.span.length - c.span.length)
  return out.slice(0, max)
}
/** 行的粗分类（给副模型的选择提示，R7 规则 3「定义处优先于调用处」的机械形式）：定义行 / 调用行 / 返回行 / 逻辑行 */
export function lineKind(span) {
  const t = String(span || '').trim()
  if (/^(?:export\s+)?(?:async\s+)?function\b|^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(t)) return '定义行'
  if (/^return\b/.test(t)) return '返回行'
  if (/^(?:await\s+)?[A-Za-z_$][\w$.]*\([^;]*\)\s*;?$/.test(t)) return '调用行'
  return '逻辑行'
}
/** 【在手的代码行】提示词块（无候选时返回空串） */
export function inHandLinesBlock(cot, ctx, max = 8) {
  const rows = inHandLines(cot, ctx, max)
  if (!rows.length) return ''
  const srcNote = (via) => via === 'diff' ? '（git diff 的 + 行，已去掉加号，这就是文件里的样子）' : via === 'grep' ? '（grep / sed 输出，已去掉「文件名:行号:」）' : ''
  const kindOf = (r) => r.segment ? '值段（该行里逐字的一小段，可直接当 old_text）' : r.kind || (r.valueLine ? '值行' : '逻辑行')
  const values = rows.filter((r) => r.valueLine)
  const multi = values.length >= 2 && new Set(values.map((r) => r.label)).size < values.length
    ? '\n（同一处工具结果里有 ' + values.length + ' 个值行在手：落定句只选其中一个；假设被推翻时通常就改另一个——第二分支写成它的三元组并注明不动第一个，不要写成取证）' : ''
  return '\n\n【在手的代码行】（程序从本轮工具结果里逐字摘出；old_text 只能从这里选、一字不改；值行优先于逻辑行，定义行优先于调用行，谁定义约定谁改、不逐个改使用者；不在这里的行不能当落点）\n' +
    rows.map((r) => `- ${r.label || '工具结果'}${srcNote(r.via)} · ${kindOf(r)}：\`${r.span}\``).join('\n') + multi
}

/**
 * v12.9.1（理论 S10.14 K1–K3、K6）：从 ctx 的【本轮已发出的调用】与观察里**算**出验收谓词——副模型只转述、不推断。
 *   K1 新鲜度：验收命令 tail / grep 一个已有日志且没先清空 / 没时间戳 ⇒ 这些行不自证是改后产生的（v4d7 自动稿把 `tail -n 2 ~/.dsh/trace.log` 写成「改完新起的进程」= 假担保）；
 *      命令含单元测试 ⇒ PASS 不证明原症状消失。
 *   K2 条件等价：命令含 taskset / --cpus / stress 等 ⇒ 输出说工具缺失 / 回退时通过没有信息量。
 *   K3 参数跟随：三元组只差一个数 v0 → v1、且上一轮失败输出里有 got/actual 数 g ∈ (v0, 2·v0] ⇒ 预先算好证伪式「仍失败且新数 ≈ v1 + (g − v0) ⇒ 症状跟着参数走，不是余量问题」。
 * 全部是确定性检出：不触发时为空（不劣于没有）。返回句子数组；verifyHintsBlock 拼成提示词块。
 */
export function verifyHints(ctx) {
  const c = String(ctx || '')
  const m = c.match(/【本轮已发出的调用】[^\n]*\n([\s\S]*?)(?=\n\n|$)/)
  if (!m) return []
  const lines = m[1].split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean)
  const hints = []
  const seen = new Set()
  const push = (s) => { if (!seen.has(s)) { seen.add(s); hints.push(s) } }
  const pre = c.slice(0, c.search(/\n【台账】|$/))   // 任务描述 + 第 1 轮观察（症状在这里）
  // 原症状本身是测试失败：任务句里说某测试失败，或第一条工具结果就是 npm test / node test 的 FAIL 输出
  const symptomIsTest = /(?:测试|test|selftest|spec|用例)[^。\n]{0,40}(?:失败|不通过|FAIL|fail|报错|EACCES|error)/i.test(pre) ||
    /\[tool: bash\]\s*(?:npm test|node test\/|npx (?:jest|mocha|vitest)|pytest)[\s\S]{0,400}?\b(?:FAIL|failed|失败|Error)\b/.test(pre)
  const bashes = lines.filter((l) => /^bash\s/.test(l)).map((l) => l.replace(/^bash\s+/, ''))
  const edits = lines.filter((l) => /^(?:edit_file|str_replace\w*|apply_patch|edit)\s/.test(l))
  // 引号里的 | ; & 不是管道（grep -E "a|b" ~/.dsh/trace.log）
  const LOG_READ_RE = /\b(?:tail|grep|egrep|cat|sed|awk|head|less)\b(?:"[^"\n]*"|'[^'\n]*'|[^|;&\n"'])*?((?:~\/|\.{1,2}\/|\/)?[\w.\/-]*(?:\.log|\.txt|\.jsonl|\.ndjson|\.out|trace(?:\.[\w]+)?)\b)/g
  const FRESH_RE = /(?::\s*>|\btruncate\b|\brm\b\s+-?\w*\s*[~.\/\w-]*(?:\.log|trace)|--since|\bdate\b|mktemp|\$\$|RUN_ID|\bwc -l\b|\bstat\b|\bls -l\w*\b)/
  // 追加日志（清空无害）与其他文件（fixture / 输出文件——绝不建议清空，只给「记行数再比」）
  const isAppendLog = (p) => /(?:^|\/)(?:[\w.-]*log[\w.-]*|trace(?:\.\w+)?|[\w.-]*\.log)$|(?:^|\/)logs?\//i.test(p)
  const STAT_RE = /--last\b|--since\b|\bp50\b|\bp9[059]\b|percentile|--window\b|\banalyze-|\breport\b|--stats?\b|\bsummary\b|--recent\b/
  for (const cmd of bashes) {
    const paths = new Set()
    for (const mm of cmd.matchAll(LOG_READ_RE)) if (mm[1] && !/^\d/.test(mm[1])) paths.add(mm[1])
    if (paths.size && !FRESH_RE.test(cmd)) {
      const p = [...paths][0]
      const remedy = isAppendLog(p)
        ? `先 \`: > ${p}\`（或先 \`wc -l ${p}\` 记下行数、之后只看新增的行）再跑同一条命令拿新鲜行`
        : `先 \`wc -l ${p}\` 记下行数（这个文件不是追加日志，不要清空它），再跑同一条命令、只看行数之后新增的行`
      push(`验收命令读的是 ${[...paths].join(' / ')} 里已有的行（tail / grep 一个已有文件），命令里没有先清空、也没有时间戳或本次运行 id ⇒ 这些行不自证是改后产生的：数字与上一轮那行一样就当旧行，既不能证实也不能证伪；那时第一步只有一条：${remedy}，不判定、不收工。`)
    } else if (STAT_RE.test(cmd) && !FRESH_RE.test(cmd)) {
      push(`验收命令是对已有记录的统计（窗口 / 分位数）：窗口里若混着改前的记录，数字就不新鲜；数字与上一轮一模一样就当同一批旧记录，既不能证实也不能证伪，那时第一步只有一条：先产生一批改后的新记录再跑同一条，不判定、不收工。`)
    } else if (!paths.size) {
      push('验收命令是新起进程的直接输出（不是翻旧日志、不是旧记录的统计），输出即本次结果，新鲜。')
    }
    // 原症状本身就是「测试失败」（CI 里某测试偶发失败 / npm test 报错）时，测试通过就是症状级验收，不提示；原症状是线上 / trace / 用户报告的现象时，单元测试 PASS 才不算
    if (!symptomIsTest && /(?:\bnode\s+test\/|\bnpm\s+(?:test|run\s+test)|\bnpx\s+(?:jest|mocha|vitest|ava)|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|selftest|\.test\.\w+|\.spec\.\w+)/.test(cmd)) push('验收命令里有单元测试：PASS 只证明被测函数的行为，不证明原症状消失——症状级验收要看原症状（trace / 线上现象）在原处、同等条件下不再出现；单元测试 PASS 不能当收工依据。')
    if (/\b(?:taskset|--cpus|cpulimit|stress(?:-ng)?|nice\b|ulimit|docker\s+run|cgexec)/.test(cmd)) push('验收命令依赖运行条件（taskset / 限核 / 负载）：若输出里出现 command not found、回退成不限核、或条件与上一轮复现时不同，这次通过没有信息量、不算证据；要在同等条件下重跑或推到能限核的地方跑。')
  }
  const obsPart = c.replace(m[0], '')
  for (const e of edits) {
    const mm = e.match(/old_text `([^`]*)` → new_text `([^`]*)`/)
    if (!mm) continue
    const [o, n] = [mm[1], mm[2]]
    const NUM_RE = /-?\d+(?:\.\d+)?/g
    const on = o.match(NUM_RE) || [], nn = n.match(NUM_RE) || []
    if (!on.length || on.length !== nn.length) continue
    if (o.replace(NUM_RE, '#') !== n.replace(NUM_RE, '#')) continue
    const diff = on.map((x, i) => (x !== nn[i] ? i : -1)).filter((i) => i >= 0)
    if (diff.length !== 1) continue
    const v0 = Number(on[diff[0]]), v1 = Number(nn[diff[0]])
    if (!(v0 > 0) || !Number.isFinite(v1) || v1 === v0) continue
    // 键名 = 变动数字前最近的标识符（`hedgeAfterMs: 1600` / `compressTargetMax: 1800,` / `--limit 30`）；文件 = 调用行里 tool 名后的路径
    const before = o.slice(0, o.split(NUM_RE).slice(0, diff[0] + 1).join('#').length)
    const km = before.match(/([A-Za-z_][\w.-]*)\s*[:=]\s*['"]?\s*$/) || before.match(/--([\w-]+)[=\s]+$/) || before.match(/([A-Za-z_][\w.-]*)[^\w]*$/)
    const key = km ? km[1] : null
    const fm = e.match(/^(?:edit_file|str_replace\w*|apply_patch|edit)\s+([^\s（(]+)/)
    const file = fm ? fm[1] : null
    // K3（S10.14）：症状跟着参数走 ⇒ 参数只是触发点；下一条是取证被等待的事件何时发生，不是改实现、不是再调数
    const gs = new Set()
    for (const g of obsPart.matchAll(/(?:\bgot\b|\bactual\b|实际(?:值|是|为)?|拿到|测得|耗时|took|elapsed|曾涉[^\n\d]*)\s*[:=：]?\s*((?:\d+(?:\.\d+)?)(?:\s*[、,，/\s]\s*\d+(?:\.\d+)?)*)/g)) {
      for (const x of g[1].split(/\s*[、,，/\s]\s*/)) { const v = Number(x); if (v > v0 && v <= 2 * v0) gs.add(v) }
    }
    if (gs.size) {
      const arr = [...gs].sort((a, b) => a - b)
      const ds = arr.map((g) => g - v0); const dmin = Math.min(...ds), dmax = Math.max(...ds)
      const dTxt = dmin === dmax ? String(dmin) : dmin + '~' + dmax
      push(`本轮改法是把数值 ${v0} 改成 ${v1}（\`${o}\` → \`${n}\`）；上一轮失败输出里的数字 ${arr.slice(0, 4).join('、')} = ${v0} + ${dTxt}。若验收仍失败且新数字 ≈ ${v1} + ${dTxt}（症状跟着参数走），那么这不是余量 / 阈值问题，${v1} 不是原因只是触发点：不要再调这个数字、不要改等待逻辑、不要回滚；下一条只写一条取证——在同一次失败运行里打印被这个阈值等待的那个事件实际发生的时刻（或值）和阈值触发的时刻，两者并排比先后，拿到先后再决定改哪里；取证之前不动实现。`)
    }
    // K6（S10.14）：改了参数、输出却纹丝不动 ⇒ 这条路径没读到新值；下一条是找消费点，不是试第二候选
    if (key) {
      const where = file ? `${file} 里的 \`${key}\`` : `\`${key}\``
      push(`本轮改法是把 ${where} 从 ${v0} 改成 ${v1}；若验收输出是改后新产生的（不是同一批旧记录）、数字却与上一轮一样（±噪声）、症状原样，那是改动落地却零效应 ⇒ 这条路径没读到新值（没读 \`${key}\`、读的是另一处定义 / 另一份配置、或进程没重载）：第一步只有一条，bash \`grep -n "${key}" ${file || '<改的文件>'}\` 确认改动落地；落地了下一条只写一条：bash \`grep -rn --exclude-dir=node_modules "${key}" .\` 找它的定义与真实消费点；不试第二候选、不再改这个值。`)
    }
  }
  return hints
}
/** 旧接口（v12.9.1 曾把提示块附在提示词末尾让副模型转述；v12.9.2 起提示由程序直接拼进稿，提示词里不再出现） */
export function verifyHintsBlock(ctx) {
  const h = verifyHints(ctx)
  if (!h.length) return ''
  return '\n\n【验收提示】（程序从本轮已发出的命令与上一轮观察里算出来的，不是猜的；每一条都要照实写进验收预注册，不能丢、不能反着写）\n' + h.map((x) => '- ' + x).join('\n')
}
/**
 * v12.9.2：【本轮已发出的调用】块——从本轮工具调用 [{ name, args }]（args 为对象或 JSON 串）渲染；
 *   compile-mr / traj-run（评测：A2 正文里的调用）与 birth.js（生产：finish 前流过的 tool-call 块）共用同一格式，verifyHints 才认。
 */
export function turnCallsBlock(calls) {
  const rows = []
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || !c.name) continue
    let j = c.args
    if (typeof j === 'string') { try { j = JSON.parse(j) } catch { j = { command: j } } }
    if (!j || typeof j !== 'object') j = {}
    const body = j.command || j.cmd || (j.path ? j.path + (j.old_text || j.old_str || j.old_string ? '（old_text `' + (j.old_text || j.old_str || j.old_string) + '` → new_text `' + (j.new_text || j.new_str || j.new_string || '') + '`）' : '') : JSON.stringify(j))
    rows.push('- ' + c.name + ' ' + body)
  }
  if (!rows.length) return ''
  return '【本轮已发出的调用】（这轮回答里已经发出的工具调用；验收命令只能从这里选）\n' + rows.join('\n')
}
const THREE_Q_RE = /能说修好要三件事|收工三问|三件事都在手/
/**
 * v12.9.2：程序部件拼进稿（理论 S10.19「程序写它能写的」）：
 *   ① 延续段——ctx 里的【延续段】散文原样放在稿开头；副模型若还是写了「上一轮已定…」开头的段落，删掉换成程序版（同源，程序版逐字）
 *   ② 验收提示——verifyHints(ctx) 的条款插在收工三问之前（没有三问就接在末尾），已在稿里的不重复
 *   幂等：同一 ctx 多次调用结果不变（生产里 compileV4Direct 先拼延续段，birthFinish 拿到本轮调用后再拼提示）。
 */
/**
 * v12.9.2 收工三问由程序写（S10.19 的推论）：三问的三个格在写稿时刻全部可由本轮调用 + 台账推出——
 *   落地证据 = 本轮 edit 的回执 + grep 落点（或前几轮台账里的已改回执）；原症状消失 = 看本轮验收命令的输出；新鲜度 = 程序附的条款。
 *   副模型漏写 ④ 时（长度预算下最先被砍的就是它）由这里补齐；写了就不动。只在 ctx 含【台账】时使用。
 */
export function closingQuestions(ctx) {
  const c = String(ctx || '')
  const m = c.match(/【本轮已发出的调用】[^\n]*\n([\s\S]*?)(?=\n\n|$)/)
  const lines = m ? m[1].split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean) : []
  const edits = lines.filter((l) => /^(?:edit_file|str_replace\w*|apply_patch|edit)\s/.test(l))
  const bashes = lines.filter((l) => /^bash\s/.test(l)).map((l) => l.replace(/^bash\s+/, ''))
  let landed = ''
  if (edits.length) {
    const e = edits[0]
    const fm = e.match(/^(?:edit_file|str_replace\w*|apply_patch|edit)\s+([^\s（(]+)/)
    const file = fm ? fm[1] : null
    const mm = e.match(/old_text `([^`]*)` → new_text `([^`]*)`/)
    let needle = null
    if (mm) {
      const NUM_RE = /-?\d+(?:\.\d+)?/g
      const on = mm[1].match(NUM_RE) || [], nn = mm[2].match(NUM_RE) || []
      const diff = on.length && on.length === nn.length && mm[1].replace(NUM_RE, '#') === mm[2].replace(NUM_RE, '#') ? on.map((x, i) => (x !== nn[i] ? i : -1)).filter((i) => i >= 0) : []
      if (diff.length === 1) {
        const before = mm[1].slice(0, mm[1].split(NUM_RE).slice(0, diff[0] + 1).join('#').length)
        const km = before.match(/([A-Za-z_][\w.-]*)\s*[:=]\s*['"]?\s*$/) || before.match(/--([\w-]+)[=\s]+$/) || before.match(/([A-Za-z_][\w.-]*)[^\w]*$/)
        needle = km ? km[1] : null
      }
      if (!needle) { const ids = [...mm[2].matchAll(/[A-Za-z_][\w.-]{3,}/g)].map((x) => x[0]).filter((x) => !GENERIC_ID_RE.test(x)); needle = ids.sort((a, b) => b.length - a.length)[0] || null }
    }
    landed = file && needle ? `缺：edit 回执加 bash \`grep -n "${needle}" ${file}\`` : file ? `缺：edit 回执加重读 ${file} 的落点行` : '缺：edit 回执加重读落点行'
  } else {
    const prev = [...c.matchAll(/^- 第 (\d+) 轮已改：edit_file ([^\s，,]*)[^\n]*?（结果：([^\n]*?)）(?=；|$)/gm)].pop()
    landed = prev ? `有：第 ${prev[1]} 轮 edit_file ${prev[2]} 回执「${prev[3]}」` : '缺：还没有改法落地'
  }
  const verify = bashes.find((b) => !/^grep\s+-n\s+"[^"]*"\s+\S+$/.test(b))
  const gone = verify ? `缺：看${verify.length <= 80 ? `本轮一起发出的 bash \`${verify}\` ` : '本轮一起发出的那条 bash 命令'}的输出，按上面写下的预期与「不算证据的绿灯」判` : '缺：看验收命令的输出，按上面写下的预期判'
  const now = edits.length ? '已改未验证' : /^- 第 \d+ 轮已改：/m.test(c) ? '已改、验收结果待判' : '还没有改法落地'
  return `能说修好要三件事都在手：改动落地的证据（${landed}）、原症状在同等条件下消失（${gone}）、这条观察是改后产生的（按上面程序附的新鲜度条款判）；现在能说的：${now}，三件都拿到之前不能说修复完成，拿到就收工、不再取证。`
}
/** 极简工程状态版提示与三问（programParts = 'compact'，消除冗长说教对主模型的过度思考示范诱导，同时 100% 保留动作锚点与真值判据）。 */
export function compactVerifyHints(ctx) {
  return verifyHints(ctx)
    .filter((h) => !h.startsWith('验收命令是新起进程的直接输出'))
    .map((h) => h
      .replace(/（tail \/ grep 一个已有文件），命令里没有先清空、也没有时间戳或本次运行 id ⇒ 这些行不自证是改后产生的：数字与上一轮那行一样就当旧行，既不能证实也不能证伪；那时第一步只有一条：/, '：若数字同上轮则')
      .replace(/（这个文件不是追加日志，不要清空它），再跑同一条命令、只看行数之后新增的行/, '取新增行再测')
      .replace(/（或先 `wc -l ([^`]+)` 记下行数、之后只看新增的行）再跑同一条命令拿新鲜行/, '或 `wc -l $1` 取新行再测')
      .replace(/验收命令是对已有记录的统计（窗口 \/ 分位数）：窗口里若混着改前的记录，数字就不新鲜；数字与上一轮一模一样就当同一批旧记录，既不能证实也不能证伪，那时第一步只有一条：/, '验收系窗口统计：若数字同上轮则')
      .replace(/验收命令里有单元测试：PASS 只证明被测函数的行为，不证明原症状消失——症状级验收要看原症状（trace \/ 线上现象）在原处、同等条件下不再出现；/, '')
      .replace(/那么这不是余量 \/ 阈值问题，([^，]+)不是原因只是触发点：不要再调这个数字、不要改等待逻辑、不要回滚；下一条只写一条取证——/, '则 $1 只是触发点（不调数、不改等待、不回滚），下一步')
      .replace(/那是改动落地却零效应 ⇒ 这条路径没读到新值（[^）]+）：第一步只有一条，/, '属零效应（未读新值）：先'))
}
export function compactClosingQuestions(ctx) {
  const full = closingQuestions(ctx)
  const landed = (full.match(/改动落地的证据（([^）]+)）/) || ['', '缺'])[1]
  const now = (full.match(/现在能说的：([^，]+)/) || ['', '待核'])[1]
  return `收工核对（${now}）：需集齐落地证据（${landed}）与新鲜输出下原症状消失，集齐前不说修复完成、不回滚、不要再跑同条旧命令。`
}
/** 程序写进稿里的全部部件（延续段 + 提示 + 三问）拼成一串——闸门的标识符核真把它当「允许出现的出处」（这些片段都由 ctx 推出，不是发明） */
export function programPartsText(ctx, opts = {}) {
  const c = String(ctx || '')
  if (!/【台账】/.test(c)) return ''
  const mode = (opts && opts.programParts) || 'all'
  if (mode === 'none') return ''
  const cont = ((c.match(/^【延续段】[^\n]*\n([\s\S]*?)(?=\n\n|\n\[|$)/m) || [])[1] || '').replace(/\s+/g, ' ').trim()
  if (mode === 'compact') {
    return [cont, ...verifyHints(c), ...compactVerifyHints(c), closingQuestions(c), compactClosingQuestions(c)].filter(Boolean).join('\n')
  }
  const wantHints = mode === 'all' || mode === 'no-closing'
  const wantClosing = mode === 'all' || mode === 'no-hints'
  return [cont, ...(wantHints ? verifyHints(c) : []), ...(wantClosing ? [closingQuestions(c)] : [])].filter(Boolean).join('\n')
}
export function spliceProgramParts(text, ctx, stats = {}, opts = {}) {
  let t = String(text || '')
  const c = String(ctx || '')
  const mode = (opts && opts.programParts) || (stats && stats.programParts) || 'all'
  if (mode === 'none') return t
  const cm = c.match(/^【延续段】[^\n]*\n([\s\S]*?)(?=\n\n|\n\[|$)/m)
  if (cm && cm[1].trim()) {
    const cont = cm[1].replace(/\s+/g, ' ').trim()
    if (!t.includes(cont)) {
      // 副模型自己写的延续句（逐句剥，直到第一句不像延续段为止；稿可能没有空行分段）
      const sents = t.split(/(?<=[。\n])/)
      let k = 0
      const CONT_SENT_RE = /^[\s「]*(?:上一轮(?:已定|提议|已改|写下)|仍在依赖的事实|已排除|未解|已走过的路|被推翻的假设|状态[是：:])|出处仍有效|不再重跑复现|台账里/
      while (k < sents.length && (CONT_SENT_RE.test(sents[k]) || !sents[k].trim())) k++
      let keptExcluded = ''
      if (k > 0 && k < sents.length) {
        if (!/已排除[：:]/.test(cont)) {
          const ex = sents.slice(0, k).join('').match(/已排除[：:][^。\n]+[。]?/)
          if (ex && ex[0].replace(/^已排除[：:]\s*/, '').replace(/[。；\s]/g, '').length > 0) keptExcluded = ex[0].trim().replace(/(?<![。])$/, '。')
        }
        stats.droppedContinuation = k
        t = sents.slice(k).join('')
      }
      t = cont + (keptExcluded ? keptExcluded : '') + '\n\n' + t.replace(/^\s+/, '')
      stats.continuation = 1
    }
  }
  if (mode === 'compact') {
    // 1) 压缩【延续段】内的固定套话与非报错文件头回显
    t = t
      .replace(/——第 (\d+(?:、\d+)*) 轮稿里逐字引用的行，本轮输出里不会再出现，出处仍有效。/g, '（第 $1 轮引，出处有效）。')
      .replace(/；这些不再重跑，除非中间改过东西。/g, '（不再重跑）。')
      .replace(/\s*→\s*「\$\s[^」]*」/g, '')
      .replace(/bash `cd "\$\(pwd\)" && /g, 'bash `')
      .replace(/\s+2>\/dev\/null(?=`)/g, '')
      .replace(/((?:read_file\s+`|bash\s+`(?:cat|ls|for\s+f\s+in)\b)[^`]*`)\s*→\s*「(?![^」]*(?:FAIL|ERR|Error|EACCES))[^」]*」/g, '$1')
      .replace(/→\s*「bash:\s*该沙箱[^」]*」/g, '→「沙箱拒」')
      .replace(/已排除[：:]\s*已排除[：:]/g, '已排除：')
      .replace(/、`[A-Za-z_\s(),.]{45,}`/g, '')
      .replace(/(已排除[：:][^。；\n]+；\s*已排除[：:][^。；\n]+)；\s*已排除[：:]新建临时复现脚本[^。；\n]*/g, '$1')
    // 2) 剥离副模型在正文里重复抄写的冗长版 K1/K2/K3/K6 提示与二次重复的 edit_file 样板，统一由极简版 compH 单次注入
    t = t
      .replace(/验收命令是新起进程的直接输出（不是翻旧日志、不是旧记录的统计），输出即本次结果，新鲜。/g, '')
      .replace(/这条观察新不新：[^。；\n]*是新起进程的直接输出，新鲜[；。]\s*/g, '')
      .replace(/这条观察新不新：[^。\n]*里已有的行[^。\n]*。/g, '')
      .replace(/这条观察新不新：[^。\n]*同一批旧记录[^。\n]*。/g, '')
      .replace(/(?:本轮改法是把数值[^。\n]*。)?若验收仍失败且新数字 ≈[^。\n]*取证之前不动实现。/g, '')
      .replace(/(?:本轮改法是把[^。\n]*；)?若验收输出是改后新产生的[^。\n]*不再改这个值。/g, '')
      .replace(/selftest PASS 不算证据，因为它只证明被测函数的行为、不证明原症状消失；/g, '单元测试 PASS 不能当收工依据；')
      .replace(/（(?:上一轮|第\s*\d+\s*轮)[`\s]*(?:read_file|cat|grep)[^）]*的原样行[^）]*）/g, '')
      .replace(/（一个没见过的[^）]*）/g, '')
    if ((t.match(/edit_file\s+\S+/g) || []).length >= 3) {
      t = t.replace(/看到这一点就够了，不用再读[^。\n]*：直接 edit_file [^。\n]+。/g, '即可收工（不再重读或补改）。')
    }
    const fullH = /【本轮已发出的调用】/.test(c) ? verifyHints(c) : []
    const compH = /【本轮已发出的调用】/.test(c) ? compactVerifyHints(c) : []
    for (let i = 0; i < fullH.length; i++) {
      if (t.includes(fullH[i])) {
        const rep = fullH[i].startsWith('验收命令是新起进程的直接输出') ? '' : (compH.find((x) => x.slice(0, 8) === fullH[i].slice(0, 8)) || fullH[i])
        t = t.replace(fullH[i], rep)
      }
    }
    const alreadyCovered = (h) => {
      if (t.includes(h.slice(0, 18))) return true
      if (h.includes('里已有的行') && /:\s*>\s*\S+|wc\s+-l/.test(t)) return true
      if (h.includes('command not found') && t.includes('command not found')) return true
      if (h.includes('单元测试 PASS') && /单元测试\s*PASS\s*不能当收工依据/.test(t)) return true
      if (h.includes('症状跟着参数走') && t.includes('症状跟着参数走')) return true
      if (h.includes('--exclude-dir=node_modules') && t.includes('--exclude-dir=node_modules')) return true
      return false
    }
    const fixInPlay = /^- (?:edit_file|str_replace\w*|apply_patch|edit)\s/m.test((c.match(/【本轮已发出的调用】[^\n]*\n([\s\S]*?)(?=\n\n|$)/) || ['', ''])[1]) || /^- 第 \d+ 轮(?:已定|已改|提议)/m.test(c)
    const missing = compH.filter((h) => !alreadyCovered(h))
    if (missing.length) {
      const block = missing.join('')
      const qm = t.match(/能说修好要三件事|收工三问|三件事都在手|收工核对（/)
      if (qm) {
        const at = qm.index
        const cut = Math.max(t.lastIndexOf('。', at), t.lastIndexOf('\n', at))
        const pos = cut < 0 ? at : cut + 1
        t = t.slice(0, pos) + block + t.slice(pos)
        stats.splicedHints = (stats.splicedHints || 0) + missing.length
      } else if (fixInPlay) {
        t = t.replace(/\s*$/, '') + block
        stats.splicedHints = (stats.splicedHints || 0) + missing.length
      }
    }
    const compQ = compactClosingQuestions(c)
    if (/能说修好要三件事都在手[^。]*。/.test(t) || (/【本轮已发出的调用】/.test(c) && /收工核对（[^。]*。/.test(t))) {
      t = t.replace(/(?:能说修好要三件事都在手|收工核对（)[^。]*。/, compQ)
      stats.splicedClosing = 1
    } else if (/【台账】/.test(c) && fixInPlay && !/收工核对（/.test(t)) {
      t = t.replace(/\s*$/, '') + (/[。！？」`]$/.test(t.trimEnd()) ? '' : '。') + compQ
      stats.splicedClosing = 1
    }
    return t
  }
  const wantHints = mode === 'all' || mode === 'no-closing'
  const wantClosing = mode === 'all' || mode === 'no-hints'
  const hints = wantHints && /【本轮已发出的调用】/.test(c) ? verifyHints(c) : []
  const missing = hints.filter((h) => !t.includes(h.slice(0, 24)))
  if (missing.length) {
    const block = missing.join('')
    const qm = t.match(THREE_Q_RE)
    if (qm) {
      // 插在三问所在句的句首（该句前面最近的句号 / 换行处）
      const at = qm.index
      const cut = Math.max(t.lastIndexOf('。', at), t.lastIndexOf('\n', at))
      const pos = cut < 0 ? at : cut + 1
      t = t.slice(0, pos) + block + t.slice(pos)
    } else t = t.replace(/\s*$/, '') + block
    stats.splicedHints = (stats.splicedHints || 0) + missing.length
  }
  // 三问只在「有改法在场」时补（本轮有 edit、或台账里已有已定 / 提议 / 已改）：纯取证轮三件全缺是空话，不占字
  const fixInPlay = /^- (?:edit_file|str_replace\w*|apply_patch|edit)\s/m.test((c.match(/【本轮已发出的调用】[^\n]*\n([\s\S]*?)(?=\n\n|$)/) || ['', ''])[1]) || /^- 第 \d+ 轮(?:已定|已改|提议)/m.test(c)
  if (/【台账】/.test(c) && wantClosing && fixInPlay && !THREE_Q_RE.test(t)) {
    t = t.replace(/\s*$/, '') + (/[。！？」`]$/.test(t.trimEnd()) ? '' : '。') + closingQuestions(c)
    stats.splicedClosing = 1
  }
  return t
}

/** 硬拒绝占比阈值（schema / I1–I8；去重、I7、retracted 不算「不可信」）。 */
export function v4RejectRatioOf(v) {
  const hard = v.rejected.filter((r) => r.rule !== 'dup' && r.rule !== 'I7' && r.rule !== 'retracted').length
  return v.total ? hard / v.total : 0
}
const maxRejectRatio = (cfg) => (typeof cfg.compressV4MaxRejectRatio === 'number' && cfg.compressV4MaxRejectRatio >= 0 && cfg.compressV4MaxRejectRatio <= 1 ? cfg.compressV4MaxRejectRatio : 0.5)

/**
 * 从已解析的条目编译（整块与增量共用）。
 * @param opts.rawSuffix 增量编译的「原文尾巴」：尚未编译完的最新一段推理，逐字接在渲染稿后面（此时不出尾段）
 * @param opts.rawPrefix 增量编译的「原文空洞」：中间编译失败 / 没赶上的段，逐字放在渲染稿**前面**
 *   （它们比渲染稿里后段的结论旧；放前面 ⇒ 最新状态仍在最后，不会被旧原文盖过）
 */
export function compileOpsV4(rawOps, raw, cfg = {}, budget = null, stats = {}, opts = {}) {
  const v = validateOps(rawOps, raw, cfg.compressCtx || '')
  const byRule = {}
  for (const r of v.rejected) byRule[r.rule] = (byRule[r.rule] || 0) + 1
  Object.assign(stats, { ops: v.total, valid: v.kept.length, rejected: byRule, converted: v.converted.length })
  const inv = v.rejected.filter((r) => r.rule === 'I2').flatMap((r) => r.sample || []).slice(0, 4)
  if (inv.length) stats.inventedSample = inv
  if (v.fatal) return { ok: false, reason: 'v4-' + v.fatal, stats }
  if (!v.kept.length) return { ok: false, reason: 'v4-no-valid-ops', stats }
  // 副模型在这块上整体不可信（锚点对不上、编造多）⇒ 整块原文，而不是拼一份残缺的状态
  if (v.total >= 2 && v4RejectRatioOf(v) > maxRejectRatio(cfg)) return { ok: false, reason: 'v4-reject-ratio', stats }
  // 模板语言跟随条目内容而不是原文（v12.5：perf 原文英文多 ⇒ 英文模板套中文条目，中英混杂）
  // 条目里标识符多，中文占比常在 10–20% ⇒ 阈值 0.1（ops7 实测：eacces 条目 0.2 以下被判成英文模板）
  const lang = renderLang(v.kept.map((o) => o.text).join('\n') || raw, 0.1)
  const b = Number.isFinite(budget) && budget > 0 ? budget
    : (typeof cfg.compressV4BudgetChars === 'number' && cfg.compressV4BudgetChars > 0 ? cfg.compressV4BudgetChars
      : Math.max(typeof cfg.compressTargetMax === 'number' && cfg.compressTargetMax > 0 ? cfg.compressTargetMax : 450, V4_MIN_BUDGET))
  const kept0 = opts.segmented ? freshenState(v.kept, stats) : v.kept
  const auto = cfg.compressV4AutoHints === false ? [] : autoHintOps(raw, kept0, typeof opts.rawSuffix === 'string' ? opts.rawSuffix : '')
  const kept = auto.length ? [...kept0, ...auto] : kept0
  if (auto.length) stats.autoHints = auto.length
  // 理论 S8-R7（ops 路）：没有落点的改法条目，按标识符 / 文件名重叠从原文引文与本回合观察（compressCtx）里绑一个逐字落点
  //   （validateOps 里的 locusFromRaw 只看原文；观察里的行——如测试节选的 `hedgeAfterMs: 1600`——此前绑不上）
  if (cfg.compressV4DirectBind !== false) {
    let cands = null
    for (const op of kept) {
      if (op.k !== 'READY' || op.at) continue
      if (!cands) cands = locusCandidates(raw, cfg.compressCtx || '')
      const hit = bindLocus(op.text, cands, raw)
      if (hit) { op.at = hit.span; stats.boundReady = (stats.boundReady || 0) + 1 }
    }
  }
  const sel = selectOps(kept, { budget: b, lang })
  const suffix = typeof opts.rawSuffix === 'string' ? opts.rawSuffix : ''
  // 有原文尾巴时不出尾段：尾巴本身就是最新的推理，「所以现在…」会比它旧
  // 理论 S8-R2″：动作接口逐字性 —— 判读 / 结论所指的原文逐字代码行（至多 2 行）必留，READY 已带的不重复
  const loci = cfg.compressV4Loci === false ? [] : actionLoci(raw, sel.chosen)
  if (loci.length) stats.loci = loci.length
  const body = renderOps(sel.chosen, { lang, tail: !suffix && cfg.compressV4Tail !== false, loci, prose: (cfg.compressV4Prose ?? DEFAULTS.compressV4Prose) !== false })
  const gap = typeof opts.rawPrefix === 'string' ? opts.rawPrefix.trim() : ''
  const withGap = gap ? gap + '\n\n' + body : body
  const text = suffix.trim() ? withGap + '\n\n' + suffix.replace(/^\s+/, '') : withGap
  const kinds = {}
  for (const o of sel.chosen) kinds[o.k] = (kinds[o.k] || 0) + 1
  Object.assign(stats, { selected: sel.chosen.length, kinds, dropped: sel.dropped, lang, budget: b, chars: text.length })
  if (suffix) stats.rawSuffixChars = suffix.length
  if (gap) stats.rawGapChars = gap.length
  if (!text.trim()) return { ok: false, reason: 'v4-empty-render', stats }
  if (cfg.compressEditTool) { text = adaptEditTool(text, cfg.compressEditTool); stats.editTool = cfg.compressEditTool.name }
  return { ok: true, text, stats }
}

// ── 增量编译的辅助（src/segment-v4.js 使用）───────────────────────────────
const segOf = (id) => { const m = /^s(\d+)\./.exec(id || ''); return m ? Number(m[1]) : 0 }
/**
 * 状态「后写者胜」（v12.3 真机发现）：各段各自标 INCUMBENT / OPEN，合并后全是必留 ⇒ 前段的旧判断、
 * 后来已解决的疑问一起堆进出生文本 —— 正是要消除的「左右互搏」残留。
 *   INCUMBENT：只有「最后一个含 INCUMBENT 的段」的算当前方案；更早的降为 COMPUTED（按价值竞争预算，不再必留）。
 *   OPEN：只有「最后一个含 OPEN 的段」的算未决；更早的丢弃（后来要么解决了、要么被重新提出），被依赖的除外。
 *   REFUTED 不动：死路是疫苗，任何时候都必留。
 */
export function freshenState(kept, stats = {}) {
  const lastWith = (k) => kept.reduce((m, o) => (o.k === k ? Math.max(m, segOf(o.id)) : m), 0)
  const li = lastWith('INCUMBENT'), lo = lastWith('OPEN')
  const needed = new Set(kept.flatMap((o) => o.deps || []))
  let demoted = 0, droppedOpen = 0
  const out = []
  for (const o of kept) {
    if (o.k === 'INCUMBENT' && segOf(o.id) < li) { out.push({ ...o, k: 'COMPUTED' }); demoted++; continue }
    if (o.k === 'OPEN' && segOf(o.id) < lo && !needed.has(o.id)) { droppedOpen++; continue }
    out.push(o)
  }
  if (demoted || droppedOpen) stats.stale = { demotedIncumbent: demoted, droppedOpen }
  return out
}

/**
 * 合并各段的条目：id 加段前缀（s{n}.{id}）使全局唯一；段内 deps / retracts 同样加前缀，
 * 指向前段的全局 id（副模型从【此前已标注】里抄来的）原样保留。
 * @param segments [{ n, ops }]（按段序）
 */
export function mergeSegmentOps(segments) {
  const out = []
  for (const seg of segments) {
    // 已是全局形态（sN.xxx）的引用一律指向前段、绝不再加前缀；副模型给自己的条目起了 sN.xxx 形态的 id ⇒ 本段内改名（v12.3 真机：出现过 s5.s4.o1）
    const GLOBAL = /^s\d+\./
    const ownId = (o, i) => { const id = str(o && o.id, 20); return !id || GLOBAL.test(id) ? 'x' + (i + 1) : id }
    const local = new Set((seg.ops || []).map((o, i) => ownId(o, i)))
    const g = (id) => (!GLOBAL.test(id) && local.has(id) ? 's' + seg.n + '.' + id : id)
    ;(seg.ops || []).forEach((o, i) => {
      if (!o || typeof o !== 'object') return
      const id = ownId(o, i)
      const fix = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []).map((d) => g(str(d, 24)))
      const sup = supersedesIds(o.supersedes)
      const rt = sup ? [...(Array.isArray(o.retracts) ? o.retracts : typeof o.retracts === 'string' && o.retracts ? [o.retracts] : []), ...sup] : o.retracts
      out.push({ ...o, id: 's' + seg.n + '.' + id, deps: fix(o.deps), retracts: fix(rt), ...(sup ? { supersedes: '' } : {}) })
    })
  }
  return out
}

/** 给下一段提示词用的「此前已标注」行：只列通过校验的条目，最近的优先，至多 max 条。 */
export function priorLines(kept, max = 30) {
  return kept.slice(-max).map((o) => o.id + ' [' + o.k + (o.key ? ' key=' + o.key : '') + '] ' + stripEnd(o.text).slice(0, 120))
}


/** 证据程序侧车：显式调用的新接口，不修改 compileV4Direct 的输入、闸或输出。 */
export function compileV4Evidence(side, raw, cfg = {}, options = {}) {
  const legacy = compileV4Direct(side, raw, cfg)
  if (!legacy.ok) return legacy
  const proposal = parseEvidenceProposal(legacy.text, { ctx: cfg.compressCtx || '', calls: options.calls || [] })
  const binding = options.contract ? bindEvidenceProposal(proposal, options.contract, options.sessionId) : { ok: false, reason: 'no-host-contract' }
  return { ...legacy, proposal, evidence: binding }
}
