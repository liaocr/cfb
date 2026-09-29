#!/usr/bin/env node
// tools/draft-lint.mjs
// 把「稿的形态」量化成 15 条可机械判定的条目（理论 S8-R7…R10 的检查表），给每份稿打分，并与 effect 结果里主模型的实际动作对表。零调用。
//   node tools/draft-lint.mjs --recordings live-all/recordings.json --results effect-19 --report oI=/home/user/oracle/I.json --report oH:v4=/home/user/direct-oh.json [--only t1,t2]
// 只看稿本身，不看 followup / 参考答案 ⇒ 副模型稿与手写稿同一把尺。判读段 = 从一个「如果…」句起到下一个「如果…」句前（含后续补充句）。
//   L1 逐字锚点 ≥2 且无发明            L2 尾段判读闭合且判读段 ≥2         L3 改法段自带落点 + 可用句（不靠门补）
//   L4 落点出处句（原样/逐字/不带缩进）  L5 文件逐字（无 diff +/-、行号前缀当落点）  L6 「不再查什么」句在改法段内
//   L7 改法只落一个（同一段内无 A 或 B） L8 trigger 无含糊词                 L9 非改法段具体（命令/文件/此时不要改），不是光「再取证」
//   L10 逃生句                          L11 被排除候选 ≥2 且带理由           L12 全稿无两可改法
//   L13 长度 900–1600                    L14 原生语域（推理词 + 无列表标题）   L15 对齐可见回答（上一轮回答里说要确认的 = 这次调用）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const o = { reports: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--recordings') o.recordings = v()
    else if (a === '--results') o.results = v()
    else if (a === '--report') { const s = v(); const k = s.indexOf('='); o.reports.push({ name: s.slice(0, k), path: s.slice(k + 1) }) }
    else if (a === '--only') o.only = v().split(',')
    else throw new Error('未知参数 ' + a)
  }
  if (!o.recordings) throw new Error('需要 --recordings')
  return o
}

const BRANCH_HEAD_RE = /(?:^|[，,；;：:—\s])(?:如果|若是|若|要是|假如)/
const BRANCH_THEN_RE = /(那么|就|则|⇒|→|=>)/
/** 分句：在 。；;！!？? 与换行处切，但反引号内不切（代码里的 ? ; 不是句号） */
export function splitSentences(text) {
  const out = []
  let cur = '', inTick = false, parenDepth = 0
  for (const ch of String(text || '')) {
    cur += ch
    if (ch === '`') inTick = !inTick
    else if (!inTick) {
      if (ch === '(' || ch === '（') parenDepth++
      else if ((ch === ')' || ch === '）') && parenDepth > 0) parenDepth--
    }
    if (!inTick && parenDepth === 0 && /[。；;！!？?\n]/.test(ch)) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
/** 尾段（后 60%）的判读段：从一个「如果…那么」句起，到下一个这样的句子前 */
export function tailSegments(text) {
  const src = String(text || '')
  const start = Math.floor(src.length * 0.4)
  const sents = splitSentences(src)
  let off = 0
  const tail = []
  for (const s of sents) { const at = src.indexOf(s, off); if (at + s.length > start) tail.push(s); off = at >= 0 ? at + s.length : off }
  const isBranch = (s) => BRANCH_HEAD_RE.test(s) && BRANCH_THEN_RE.test(s) && s.length >= 8
  const segs = []
  for (const s of tail) { if (isBranch(s)) segs.push([s]); else if (segs.length) segs[segs.length - 1].push(s) }
  return segs.map((xs) => ({ head: xs[0], text: xs.join('') }))
}

const AFFORD_RE = /old_text|逐字原文已给出|可以直接当|可直接当/
const PROV_RE = /原样|逐字原文|逐字|read_file 里|不带行首缩进|不带缩进|唯一/
const NOMORE_RE = /不用再|不再复现|不再读|就够了|不用先读|不需要再|不必再/
const REJECT_RE = /不选|排除|搁置|不走|不是它|无罪|陪跑|先不|不动它|不采|放弃/
const CONCRETE_RE = /bash|grep|docker|read_file|sed|taskset|analyze-trace|npm|node|stress|看[^，。]{0,14}(?:日志|代码|定义|来源|使用点|文件|那一行|赋值)|[\w./-]+\.(?:m?js|json|ya?ml|py)|此时不要|此时别|不要动|不动 |不要改|不改/
const PROBE_ONLY_RE = /^(?:再取证|那时再取证|再看看|另查|再查)[。；]?$/
const ALIGN_RE = /可见回答|上一轮回答|上一轮的回答|回答里说|回答里写|刚才说要确认|说要确认的/

/** 15 条形态条目；返回 { items, score, segments, fixSegments, chars } */
export function lintDraft(I, text, raw, ctx) {
  const r = I.compileV4Direct(text, raw, { compressCtx: ctx })
  const st = r.ok ? r.stats : {}
  const segs = tailSegments(text)
  const fix = [], other = []
  for (const s of segs) { const at = s.head.search(BRANCH_THEN_RE); const then = at >= 0 ? s.head.slice(at) : s.head; (I.isFixBranch(then) || I.isFixBranch(s.text.slice(at >= 0 ? at : 0)) ? fix : other).push(s) }
  const anchors = (String(text).match(/`[^`\n]{6,220}`/g) || []).length
  const items = {}
  items.L1 = anchors >= 2 && !(st.inventedSpans > 0) ? 1 : 0
  items.L2 = st.closeLoop && segs.length >= 2 ? 1 : 0
  items.L3 = fix.length >= 1 && fix.every((s) => /`[^`\n]{6,220}`/.test(s.text) && AFFORD_RE.test(s.text)) ? 1 : 0
  items.L4 = fix.length >= 1 && fix.some((s) => PROV_RE.test(s.text)) ? 1 : 0
  const badLocus = /`[+-]\s{1,3}[A-Za-z][^`]*`(?!（?(?:开头的加号|的加号|是 diff|里行首))/.test(text)
  items.L5 = !(st.fileVerbatimFixed > 0) && !(st.minusLineAsOldText > 0) && !badLocus ? 1 : 0
  items.L6 = fix.some((s) => NOMORE_RE.test(s.text)) ? 1 : 0
  items.L7 = fix.length >= 1 && fix.every((s) => !/(?:改法|改成|改回|回落|设为)[^。；]{0,40}(?:或者|或是|或)\s*(?:给|改|把|换|用)/.test(s.head)) ? 1 : 0
  items.L8 = !(st.hedgedTrigger > 0) ? 1 : 0
  const concrete = (s) => { const then = s.text.replace(/^.*?(?:那么|就|则)/, ''); return CONCRETE_RE.test(then) && !PROBE_ONLY_RE.test(then.trim()) }
  items.L9 = segs.length >= 2 && (other.length ? other.every(concrete) : fix.slice(1).every(concrete)) ? 1 : 0
  items.L10 = /都不像|先别改|先别动/.test(text) ? 1 : 0
  items.L11 = splitSentences(text).filter((s) => REJECT_RE.test(s)).length >= 2 ? 1 : 0
  items.L12 = !(st.disjunctiveFix > 0) ? 1 : 0
  items.L13 = text.length >= 900 && text.length <= 1600 ? 1 : 0
  items.L14 = /看起来|所以|下一步工具调用|我们需要/.test(text) && !/^\s*(?:[-*•]|\d+[.、]|#)/m.test(text) ? 1 : 0
  items.L15 = ALIGN_RE.test(text) ? 1 : 0
  const score = Object.values(items).reduce((a, b) => a + b, 0)
  return { items, score, segments: segs.length, fixSegments: fix.length, chars: String(text).length }
}
export const LINT_KEYS = Array.from({ length: 15 }, (_, i) => 'L' + (i + 1))

export function loadResults(dir) {
  const p = path.join(dir, 'results.jsonl')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error && r.judge)
}

async function main(argv) {
  const o = parseArgs(argv)
  const I = await import('../index.js')
  const { TASKS } = await import('./v4-live.mjs')
  const recs = JSON.parse(fs.readFileSync(o.recordings, 'utf8'))
  const results = o.results ? loadResults(o.results) : []
  const specs = JSON.parse(fs.readFileSync(new URL('./effect-specs.json', import.meta.url), 'utf8'))
  const baseOf = (task) => (specs.find((s) => s.id === task) || {}).base || task
  const rows = []
  for (const { name, path: p } of o.reports) {
    const variant = name.split(':')[0], mode = name.includes(':') ? name.split(':')[1] : null
    const rep = JSON.parse(fs.readFileSync(p, 'utf8')).rows
    for (const t of TASKS) {
      if (o.only && !o.only.includes(t.id)) continue
      const row = rep.find((x) => x.id === t.id && (!mode || x.mode === mode) && typeof x.text === 'string' && x.text.trim())
      if (!row) continue
      const rec = recs.find((x) => x.id === t.id); if (!rec) continue
      const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
      const lint = lintDraft(I, row.text, raw, t.user)
      const rs = results.filter((r) => r.variant === variant && baseOf(r.task) === t.id && !/~refute$/.test(r.task))
      const right = rs.filter((r) => r.act && r.act.editRight).length
      rows.push({ variant, task: t.id, ...lint, n: rs.length, right, overall: rs.length ? rs.reduce((a, r) => a + r.judge.overall, 0) / rs.length : NaN })
    }
  }
  const K = LINT_KEYS
  const L = []
  L.push('| 稿 | 任务 | 分 | ' + K.join(' | ') + ' | 字数 | 改对/样本 | 综合 |')
  L.push('|---|---|---|' + K.map(() => '---').join('|') + '|---|---|---|')
  for (const r of rows) L.push(`| ${r.variant} | ${r.task} | ${r.score} | ${K.map((k) => r.items[k] ? '●' : '·').join(' | ')} | ${r.chars} | ${r.n ? r.right + '/' + r.n : '—'} | ${Number.isFinite(r.overall) ? r.overall.toFixed(1) : '—'} |`)
  L.push('\n| 形态分 | 稿·任务 | 样本 | 改对率 | 综合均值 |')
  L.push('|---|---|---|---|---|')
  for (const [a, b] of [[0, 7], [8, 10], [11, 12], [13, 15]]) {
    const rs = rows.filter((r) => r.score >= a && r.score <= b && r.n)
    const n = rs.reduce((s, r) => s + r.n, 0), right = rs.reduce((s, r) => s + r.right, 0)
    const ov = n ? rs.reduce((s, r) => s + r.overall * r.n, 0) / n : NaN
    L.push(`| ${a}–${b} | ${rs.length} | ${n} | ${n ? Math.round(100 * right / n) + '%' : '—'} | ${n ? ov.toFixed(1) : '—'} |`)
  }
  L.push('\n| 条目 | 满足：样本 / 改对率 | 不满足：样本 / 改对率 | 差 |')
  L.push('|---|---|---|---|')
  const rate = (rs) => { const n = rs.reduce((s, r) => s + r.n, 0); return n ? [n, rs.reduce((s, r) => s + r.right, 0) / n] : [0, NaN] }
  for (const k of K) {
    const [ny, ry] = rate(rows.filter((r) => r.items[k] && r.n)), [nn, rn] = rate(rows.filter((r) => !r.items[k] && r.n))
    const pc = (x) => Number.isFinite(x) ? Math.round(x * 100) + '%' : '—'
    L.push(`| ${k} | ${ny} / ${pc(ry)} | ${nn} / ${pc(rn)} | ${Number.isFinite(ry) && Number.isFinite(rn) ? (ry - rn >= 0 ? '+' : '') + Math.round((ry - rn) * 100) + 'pp' : '—'} |`)
  }
  console.log(L.join('\n'))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
