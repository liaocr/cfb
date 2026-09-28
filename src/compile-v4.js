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
import { inventedIdentifiers } from './fidelity.js'
import { wideShare } from './tokens.js'

export const V4_KINDS = ['FACT', 'COMPUTED', 'INCUMBENT', 'REFUTED', 'SHELVED', 'OPEN', 'PLAN']
export const V4_EVS = ['tool', 'derived', 'guess']
export const V4_KIND2 = ['pivot', 'plan', 'hypothesize', 'localize', 'inspect', 'compute', 'verify', 'restate', 'answer']

// 必留：当前方案、证伪路（疫苗）、未决问题 —— 丢了它们，主模型会重走死路或把未决当已决（保真优先于长度）
const MUST_KEEP = new Set(['INCUMBENT', 'REFUTED', 'OPEN'])
// 静态价值（理论 v(i;λ) 在无跨轮传感器时的退化形式；只用于非必留条目之间的取舍）
const BASE = { INCUMBENT: 1.0, COMPUTED: 0.9, OPEN: 0.85, REFUTED: 0.8, SHELVED: 0.6, FACT: 0.6, PLAN: 0.35 }
const K2W = { pivot: 1.25, localize: 1.1, compute: 1.1, hypothesize: 1.0, answer: 0.9, plan: 0.8, inspect: 0.7, verify: 0.3, restate: 0.15 }
const EVW = { tool: 1.0, derived: 0.95, guess: 0.7 }
const GROUP = { FACT: 0, COMPUTED: 0, INCUMBENT: 1, REFUTED: 2, SHELVED: 2, PLAN: 3, OPEN: 4 }

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
const CAP = { text: 300, anchor: 120, alt: 200, why: 200, trigger: 160, supersedes: 160, src: 60, key: 60 }
const str = (x, n) => (typeof x === 'string' ? x : x == null ? '' : typeof x === 'number' ? String(x) : '').trim().slice(0, n)
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
const stripEnd = (s) => String(s || '').replace(/[\s。．.;；,，:：!！]+$/u, '')
const stripQ = (s) => stripEnd(s).replace(/[?？]+$/u, '')
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
  const k = str(o.k ?? o.kind ?? o.type, 20).toUpperCase()
  const ev = str(o.ev ?? o.evidence, 20).toLowerCase()
  const kind2 = str(o.kind2 ?? o.role, 20).toLowerCase()
  const ids = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []).map((d) => str(d, 24)).filter(Boolean).slice(0, 8)
  const deps = ids(o.deps)
  const supIds = supersedesIds(o.supersedes)
  const retracts = [...new Set([...ids(o.retracts), ...(supIds || []).map((d) => str(d, 24))])].slice(0, 8)
  return {
    id: str(o.id, 20) || 'o' + (i + 1), idx: i, k,
    ev: V4_EVS.includes(ev) ? ev : 'derived',
    kind2: V4_KIND2.includes(kind2) ? kind2 : null,
    text: str(o.text, CAP.text), anchor: str(o.anchor, CAP.anchor), key: str(o.key, CAP.key),
    src: str(o.src, CAP.src), alt: str(o.alt, CAP.alt), why: str(o.why, CAP.why),
    trigger: str(o.trigger, CAP.trigger), supersedes: supersedesText(o, supIds), deps, retracts,
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
export function validateOps(rawOps, raw) {
  const src = String(raw || '')
  const hay = norm(src)
  const kept = [], rejected = [], converted = []
  let fatal = null
  const ops = (Array.isArray(rawOps) ? rawOps : []).map(normalizeOp)
  const seen = new Set()
  for (const op of ops) {
    const reject = (rule, sample) => { rejected.push(sample ? { id: op.id, k: op.k, rule, sample } : { id: op.id, k: op.k, rule }) }
    if (!V4_KINDS.includes(op.k) || !op.text) { reject('schema'); continue }
    const a = norm(op.anchor)
    if (a.length < 2 || !hay.includes(a)) { reject('I1'); continue }
    const inv = inventedIdentifiers(src, [op.text, op.alt, op.why, op.trigger, op.supersedes].filter(Boolean).join('\n'))
    if (inv.length) {
      reject('I2', inv.slice(0, 3))
      if (op.k === 'INCUMBENT' || op.k === 'COMPUTED') fatal = fatal || 'critical-I2'
      continue
    }
    if (op.src && inventedIdentifiers(src, op.src).length) op.src = ''
    if (/^tool:?/i.test(op.src) || op.ev === 'tool') {
      if (RE_DECIDE.test(op.text)) { reject('I5'); continue }
    }
    if ([op.text, op.alt, op.why, op.trigger].some((t) => RE_SECOND.test(outsideQuotes(t)))) { reject('I8'); continue }
    if (op.k === 'REFUTED' && op.ev !== 'tool') { converted.push({ id: op.id, from: 'REFUTED', to: 'SHELVED' }); op.k = 'SHELVED' }
    if (op.k === 'REFUTED' && !op.alt) { reject('I3'); continue }
    const sig = op.k + '|' + norm(op.text).toLowerCase()
    if (seen.has(sig)) { reject('dup'); continue }
    seen.add(sig)
    op.src = op.src.replace(/^tool:\s*/i, '')
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
  const final = []
  for (const op of kept) {
    if (keyed(op) && lastByKey.get(op.key) !== op) {
      const winner = lastByKey.get(op.key)
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
  for (const o of ops) if (MUST_KEEP.has(o.k)) take(o)
  for (const o of ops) if (MUST_KEEP.has(o.k)) closure(o)
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
    judged: '目前判断：', guess: '未验证的猜测：', incumbent: '当前方案：', incumbentGuess: '当前方案（未验证）：',
    refuted: (alt, x, why) => alt + '（' + zj('已排除', x) + (why ? '：' + why : '') + '）',
    shelved: (alt, x, why, trig) => alt
      ? alt + '（' + zj('暂缓', x) + (why ? '：' + why : '') + (trig ? '；' + zj('若', trig, '再回来') : '') + '）'
      : zj('暂缓', x) + ((why || trig) ? '（' + [why, trig ? zj('若', trig, '再回来') : ''].filter(Boolean).join('；') + '）' : ''),
    plan: '当时计划：', open: '未决：',
    tailIncumbent: (t) => '所以现在采用的是：' + t + '。', tailJudged: (t) => '所以目前判断：' + t + '。', tailFact: (t) => '已确认：' + t + '。',
    tailOpen: (t) => '还没弄清的是：' + t + '？',
  },
  en: {
    src: (s, sup) => (s || sup) ? ' (' + [s ? 'source ' + s : '', sup ? 'replaces ' + sup : ''].filter(Boolean).join('; ') + ')' : '',
    judged: 'Current judgment: ', guess: 'Unverified guess: ', incumbent: 'Current approach: ', incumbentGuess: 'Current approach (unverified): ',
    refuted: (alt, x, why) => alt + ' (ruled out ' + x + (why ? ': ' + why : '') + ')',
    shelved: (alt, x, why, trig) => alt
      ? alt + ' (set aside ' + x + (why ? ': ' + why : '') + (trig ? '; revisit if ' + trig : '') + ')'
      : 'Set aside ' + x + ((why || trig) ? ' (' + [why, trig ? 'revisit if ' + trig : ''].filter(Boolean).join('; ') + ')' : ''),
    plan: 'Plan at the time: ', open: 'Open: ',
    tailIncumbent: (t) => 'So the current approach is: ' + t + '.', tailJudged: (t) => 'So far the judgment is: ' + t + '.', tailFact: (t) => 'Confirmed: ' + t + '.',
    tailOpen: (t) => 'Still unclear: ' + t + '?',
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
    default: return '- ' + t
  }
}

/**
 * 整块渲染：行式层按组（状态 → 当前方案 → 排除/搁置 → 计划 → 未决），组内保持原文顺序；
 * 尾段（可关）：最重要的一条结论 + 至多两个未决问句（双编码：关键结论在末尾再出现一次，离下一步生成最近）。
 */
export function renderOps(chosen, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const L = T[lang]
  const ordered = chosen.slice().sort((a, b) => (GROUP[a.k] - GROUP[b.k]) || (a.idx - b.idx))
  const lines = ordered.map((o) => renderLine(o, lang))
  const tail = []
  if (opts.tail !== false) {
    const inc = ordered.filter((o) => o.k === 'INCUMBENT' && o.ev !== 'guess')
    const concl = inc.length ? inc[inc.length - 1]
      : ordered.filter((o) => (o.k === 'COMPUTED' || (o.k === 'FACT' && o.kind2 === 'pivot')) && o.ev !== 'guess').sort((a, b) => scoreOp(b) - scoreOp(a) || b.idx - a.idx)[0]
    if (concl) {
      const t = stripEnd(concl.text)
      tail.push(concl.k === 'INCUMBENT' ? L.tailIncumbent(t) : concl.ev === 'tool' && concl.k === 'FACT' ? L.tailFact(t) : L.tailJudged(t))
    }
    for (const o of ordered.filter((x) => x.k === 'OPEN').slice(-2)) tail.push(L.tailOpen(stripQ(o.text)))
  }
  const sep = lang === 'en' ? ' ' : ''
  return lines.join('\n') + (tail.length ? '\n\n' + tail.join(sep) : '')
}

/** 渲染语言跟随原文（理论 S5 规则 4）：宽字符占比 ≥ 20% ⇒ 中文模板，否则英文模板。 */
export function renderLang(raw) {
  try { return wideShare(String(raw || '')) >= 0.2 ? 'zh' : 'en' } catch { return 'zh' }
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
  const v = validateOps(rawOps, raw)
  const byRule = {}
  for (const r of v.rejected) byRule[r.rule] = (byRule[r.rule] || 0) + 1
  Object.assign(stats, { ops: v.total, valid: v.kept.length, rejected: byRule, converted: v.converted.length })
  const inv = v.rejected.filter((r) => r.rule === 'I2').flatMap((r) => r.sample || []).slice(0, 4)
  if (inv.length) stats.inventedSample = inv
  if (v.fatal) return { ok: false, reason: 'v4-' + v.fatal, stats }
  if (!v.kept.length) return { ok: false, reason: 'v4-no-valid-ops', stats }
  // 副模型在这块上整体不可信（锚点对不上、编造多）⇒ 整块原文，而不是拼一份残缺的状态
  if (v.total >= 2 && v4RejectRatioOf(v) > maxRejectRatio(cfg)) return { ok: false, reason: 'v4-reject-ratio', stats }
  const lang = renderLang(raw)
  const b = Number.isFinite(budget) && budget > 0 ? budget
    : (typeof cfg.compressV4BudgetChars === 'number' && cfg.compressV4BudgetChars > 0 ? cfg.compressV4BudgetChars
      : (typeof cfg.compressTargetMax === 'number' && cfg.compressTargetMax > 0 ? cfg.compressTargetMax : 450))
  const kept = opts.segmented ? freshenState(v.kept, stats) : v.kept
  const sel = selectOps(kept, { budget: b, lang })
  const suffix = typeof opts.rawSuffix === 'string' ? opts.rawSuffix : ''
  // 有原文尾巴时不出尾段：尾巴本身就是最新的推理，「所以现在…」会比它旧
  const body = renderOps(sel.chosen, { lang, tail: !suffix && cfg.compressV4Tail !== false })
  const gap = typeof opts.rawPrefix === 'string' ? opts.rawPrefix.trim() : ''
  const withGap = gap ? gap + '\n\n' + body : body
  const text = suffix.trim() ? withGap + '\n\n' + suffix.replace(/^\s+/, '') : withGap
  const kinds = {}
  for (const o of sel.chosen) kinds[o.k] = (kinds[o.k] || 0) + 1
  Object.assign(stats, { selected: sel.chosen.length, kinds, dropped: sel.dropped, lang, budget: b, chars: text.length })
  if (suffix) stats.rawSuffixChars = suffix.length
  if (gap) stats.rawGapChars = gap.length
  if (!text.trim()) return { ok: false, reason: 'v4-empty-render', stats }
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

