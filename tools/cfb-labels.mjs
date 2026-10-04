// tools/cfb-labels.mjs —— 人工标注接口（零 API）。
//
// 为什么必须有人工层：判据（claimOf 系列）与评委都只是**代理**。理论卷五 S10.16 承认评委在
// 零温下也不确定；S10.13 更直接记录了「同一回答文本得 7 / 5 / 2 / 6」。既然代理不可靠，
// 就必须有一个人工裁决过的锚点，所有代理都对着它校准。本工具负责：
//   ① 从语料里生成待标注队列（确定性、去重、按难度分层）；
//   ② 校验人工标注文件（schema / 覆盖 / 冲突）；
//   ③ 报「黄金集规模 → 可分辨的效应量」，把「n 太小」从感觉变成一个数。
//
// 用法：
//   node tools/cfb-labels.mjs queue [--n 40]    生成 .cfb-offline/label-queue.json
//   node tools/cfb-labels.mjs check             校验 .cfb-offline/labels.json
//   node tools/cfb-labels.mjs power [--n 20]    报最小可分辨效应（近似）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { annotate, writeJson, readJson, ensureDir, prng } from './helpers/offline-core.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OFFLINE = path.join(ROOT, '.cfb-offline')
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)

export const LABEL_VALUES = Object.freeze(['fixed', 'hedged', 'none', 'unclear'])
export const LABEL_SCHEMA = Object.freeze({
  '$schema': 'cfb.labels/1', note: '人工裁决。label 是人对「这个问题是否已被宣称解决」的判断；label 与代理判据不一致的条目最有价值。',
  rows: [{ id: 'string', text: 'string', label: 'fixed|hedged|none|unclear', source: 'trace|recorded|synthetic', note: '' }],
})

/** 从语料与历史稿里抽待标注句：优先抽「代理判据会犹豫」的句子（含修复词但上下文复杂）。 */
export function buildQueue({ corpusPath = path.join(OFFLINE, 'corpus.json'), n = 40, seed = 11 } = {}) {
  const rows = []
  const seen = new Set()
  if (fs.existsSync(corpusPath)) {
    const c = readJson(corpusPath)
    for (const it of (c.items || [])) {
      if (typeof it.text !== 'string') continue
      for (const s of splitSentences(it.text)) {
        if (!/[修复解决搞定修好完成]/.test(s)) continue
        if (seen.has(s) || s.length < 6 || s.length > 120) continue
        seen.add(s)
        rows.push({ id: it.task + '#' + seen.size, text: s, source: it.kind === 'raw' ? 'recorded' : 'condensed', proxy: annotate(s).claim })
      }
    }
  }
  const rand = prng(seed)
  // 分层：代理说 fixed 的最值得人工复核（伪阳性成本最高）
  const byProxy = { fixed: [], hedged: [], none: [], unclear: [] }
  for (const r of rows) if (r.text) (byProxy[r.proxy] || byProxy.none).push(r)
  const pick = []
  for (const k of ['fixed', 'hedged', 'none']) {
    const pool = byProxy[k].map((r, i) => ({ r, s: rand(), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.r)
    pick.push(...pool.slice(0, Math.ceil(n / 3)))
  }
  return pick.slice(0, n).map((r) => ({ ...r, label: null, note: '' }))
}

function splitSentences(t) { return String(t || '').split(/(?<=[。！？；\n])/).map((s) => s.trim()).filter(Boolean) }

/** 校验人工标注：字段齐全、取值合法、无重复 id、覆盖够。 */
export function checkLabels(file = path.join(OFFLINE, 'labels.json')) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', file, hint: '先跑 node tools/cfb-labels.mjs queue，人工填 label 后存为 labels.json' }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rows = Array.isArray(j) ? j : (j.rows || [])
  const bad = []
  const ids = new Set()
  for (const [i, r] of rows.entries()) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) bad.push({ i, why: 'text 为空' })
    else if (!LABEL_VALUES.includes(r.label)) bad.push({ i, why: 'label 非法: ' + r.label, text: r.text.slice(0, 40) })
    else if (ids.has(r.id)) bad.push({ i, why: 'id 重复: ' + r.id })
    else ids.add(r.id)
  }
  const labeled = rows.filter((r) => LABEL_VALUES.includes(r.label)).length
  return { ok: bad.length === 0 && labeled >= 20, file, n: rows.length, labeled, bad,
    reason: bad.length ? 'invalid' : labeled < 20 ? 'insufficient' : 'ok',
    hint: labeled < 20 ? '黄金集少于 20 条时，判据的置信区间会很宽' : null }
}

/**
 * 最小可分辨效应（近似，二项、双侧 95%）：要区分两个比例 p0 / p1，n 需满足
 *   n ≥ (z·√(p0(1−p0)) + z·√(p1(1−p1)))² / (p1−p0)²
 * 这里给的是「在给定 n 下能分辨的最小绝对差」，即上式的反解（p0 = 0.5 的最坏情形）。
 */
export function powerAt(n, { z = 1.96 } = {}) {
  if (!Number.isFinite(n) || n < 2) return null
  // 解 (2z)²·0.25 / n = Δ² ⇒ Δ = 2z·0.5/√n
  const delta = (2 * z * 0.5) / Math.sqrt(n)
  return { n, minDetectableDelta: delta, percent: delta * 100 }
}

function main() {
  const [cmd = 'queue', ...args] = process.argv.slice(2)
  ensureDir(OFFLINE)
  if (cmd === 'queue') {
    const q = buildQueue({ n: Number(f(args, '--n') || 40) })
    writeJson(path.join(OFFLINE, 'label-queue.json'), { schema: 'cfb.labels/1', note: LABEL_SCHEMA.note, rows: q })
    console.log('待标注 ' + q.length + ' 条 → .cfb-offline/label-queue.json')
    console.log('填好 label（' + LABEL_VALUES.join('|') + '）后另存为 .cfb-offline/labels.json，再跑 check')
    const by = {}
    for (const r of q) by[r.proxy] = (by[r.proxy] || 0) + 1
    console.log('分层（按代理判据）: ' + JSON.stringify(by))
    return
  }
  if (cmd === 'check') {
    const r = checkLabels(path.join(OFFLINE, f(args, '--file') || 'labels.json'))
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = r.ok ? 0 : 1
    return
  }
  if (cmd === 'power') {
    const base = Number(f(args, '--n') || 20)
    console.log('黄金集/样本量 → 最小可分辨效应（双侧 95%，最坏情形 p=0.5）')
    for (const n of [base, base * 2, base * 4, base * 8]) { const p = powerAt(n); console.log('  n=' + String(n).padEnd(5) + ' → 可分辨绝对差 ' + (p.percent).toFixed(1) + ' 个百分点') }
    console.log('\n含义：n=20 时只能分辨 ≥44 个百分点的差异；想分辨 10 个百分点需要 n≈384。')
    console.log('这就是「n=2 判不了任何事」的定量版本，也是黄金集必须持续扩的原因。')
    return
  }
  throw new Error('未知子命令 ' + cmd)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
