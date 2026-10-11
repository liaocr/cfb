#!/usr/bin/env node
// tools/gold-forge.mjs —— 金标改稿锻造器（$0）：把不达上限线的条目改到「只差真机读数」
//
// 为什么这么设计（三条硬约束，违反就整批作废）：
//  1) 删句不靠正则瞎猜：只删 mode1 审计**自己报出来的 excerpt** 所在整句 ⇒ 删了什么全部可追溯。
//  2) 补的闭合判读只许用**该条真机证据里逐字存在**的命令与读数（raw/ctx/traj 行里 grep 得到）；
//     取不到就写 needs-manual 并跳过 ⇒ 绝不发明锚点（发明了就是「按工具写的银标」，不配当尺子）。
//  3) 修剪到 C1 只删「已走过的路 / 复述已看过什么」这类零信息句，锚点与三元组所在句永不删。
//
// 用法：
//   node tools/gold-forge.mjs --ids a,b [--from transfer/gold,transfer/gold-rejected] [--print]
//   node tools/gold-forge.mjs --all [--limit N]
// 产出：transfer/gold-repair/drafts-proposed/<id>.md + .cfb-offline/ruler/gold-forge.json（含逐条 before/after 与判定）
import fs from 'node:fs'
import path from 'node:path'
import { goldCeiling, goldUse } from './helpers/three-mode.mjs'
import { auditMode1Output } from './helpers/mode1-quality.mjs'
import { hasClosedRead } from './helpers/hand-draft.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const from = arg('--from', 'transfer/gold,transfer/gold-rejected').split(',').map((s) => path.join(ROOT, s.trim()))
const lineFile = path.join(ROOT, '.cfb-offline', 'ruler', 'gold-vs-line.json')
const lines = fs.existsSync(lineFile) ? (JSON.parse(fs.readFileSync(lineFile, 'utf8')).lines || {}) : {}
const outDir = path.join(ROOT, 'transfer', 'gold-repair', 'drafts-proposed')
const ledger = path.join(ROOT, '.cfb-offline', 'ruler', 'gold-forge.json')

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && !e.name.startsWith('audit-') ? [path.join(d, e.name)] : [])) : [])
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])

// 该条目的真机行：按 id 或 (task,sample) 匹配，取带 rounds/observations 的那条 —— 闭合判读的证据源
const trajIndex = (() => {
  const map = new Map()
  const bases = [path.join(ROOT, 'transfer'), path.join(ROOT, '.cfb-runtime', 'traj'), path.join(ROOT, '.cfb-runtime', 'scratch')]
  for (const b of bases) {
    if (!fs.existsSync(b)) continue
    for (const e of fs.readdirSync(b, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      for (const f of ['results.jsonl', 'hand-samples.jsonl', 'rows.jsonl', 'ledger.jsonl']) {
        for (const r of readJsonl(path.join(b, e.name, f))) {
          const keys = [r.goldId, r.id, `${r.task}#s${r.sample ?? 0}`, `${r.task}#s${r.sample ?? 0}#r${r.round ?? ''}`].filter(Boolean)
          for (const k of keys) if (!map.has(k)) map.set(k, { dir: path.join(b, e.name, f), ...r })
        }
      }
    }
  }
  return map
})()
const findRow = (g) => trajIndex.get(g.id) || trajIndex.get(`${g.task || g.family}#s${g.sample ?? 0}`) || trajIndex.get(`${g.task || g.family}#s${g.sample ?? 0}#r${g.outcome?.roundsToFix ?? g.round ?? ''}`) || null

const sentences = (t) => String(t).split(/(?<=[。！？])|\n/).map((s) => s.trim()).filter(Boolean)
// 只删审计点名的句子（含其所在的同一句），其余逐字保留
const stripFlagged = (draft, issues) => {
  const ex = issues.map((i) => i.excerpt.slice(0, 40))
  const kept = [], removed = []
  for (const s of sentences(draft)) (ex.some((e) => s.includes(e)) ? removed : kept).push(s)
  return { text: kept.join('\n'), removed }
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// 从真机证据里取"验收命令 + 期望读数 + 失败读数"：三个都必须逐字存在于 raw ∪ ctx ∪ 行内文本，否则不写
function pickReads(g, row) {
  const raw = String(g.raw || ''), ctx = String(g.ctx || '')
  // 真跑过的命令优先来自条目自带 calls（模式 1 记录的实调）：这是「验收」唯一可信的来源
  const ranCmds = []
  for (const c of g.calls || []) {
    let a = c.args
    if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = {} } }
    const t = String((a || {}).command || (a || {}).cmd || c.command || '').trim()
    if (t) ranCmds.push({ name: c.name, command: t })
  }
  const testCmd = ranCmds.filter((c) => /\b(node|npm|npx)\b.*(test|\.mjs|\.js)/.test(c.command)).slice(-1)[0] || null
  const lineReads = (t) => String(t).split('\n').map((x) => x.trim()).filter(Boolean)
  const bad = lineReads(raw).filter((x) => /expected .*(got|null|undefined)|AssertionError|not ok|# fail/i.test(x) && x.length < 140).slice(0, 4)
  const ok = lineReads(raw).filter((x) => /^\s*[✔✓# ]*(tests?\s+\d+|pass\s+\d+|[\w./-]+\s+ok\b.*|ok\s*\d+.*)/i.test(x) && !/fail|expected/i.test(x) && x.length < 100).slice(0, 4)
  const obs = lineReads(JSON.stringify(row || {})).filter((x) => /ok\b|pass|✔/.test(x)).slice(0, 3)
  const targets = [...new Set((raw + '\n' + ctx).match(/[\w./-]+\.(?:mjs|js|json|log|ts)/g) || [])].filter((x) => /^(src|test|ci)\//.test(x)).slice(0, 6)
  return { ranCmds: ranCmds.map((c) => c.command.slice(0, 90)), testCmd, bad, ok, obs, targets, rowDir: row?.dir || null, rowKeys: row ? Object.keys(row).slice(0, 14) : null }
}
function forge(g) {
  const row = findRow(g)
  const evidence = String(g.raw || '') + '\n' + String(g.ctx || '')
  const audit0 = auditMode1Output(String(g.draft || ''), evidence)
  const { text: base, removed } = stripFlagged(String(g.draft || ''), audit0.issues)
  const p = pickReads(g, row)
  const grounded = (s) => !!s && (evidence.includes(s) || JSON.stringify(row || {}).includes(s))
  const parts = [base.trim()]
  const missing = []
  if (!hasClosedRead(parts.join('\n'))) missing.push('C2 无闭合判读 ⇒ 由人按 evidence 写验收段（脚本不代填：代填就是把金标写成银标）')
  let draft = parts.filter(Boolean).join('\n\n')
  // C1 修剪：stored（= 拼接稿）要 ≤ 0.60·raw ⇒ 先削「已走过的路」段与纯复述句，锚点句不动
  const raw = String(g.raw || ''), rawChars = raw.length
  const maxStored = Math.floor(rawChars * 0.60)
  const storedOf = (d) => String(g.stored || '').length - String(g.draft || '').length + d.length   // stored = 前缀 + 稿 ⇒ 只随稿长变
  let trimmed = 0
  if (storedOf(draft) > maxStored) {
    const keep = sentences(draft).filter((s) => !/^(已走过的路|第 \d+[–—]\d+ 轮看清|不再重跑)/.test(s))
    trimmed = sentences(draft).length - keep.length
    draft = keep.join('\n')
  }
  const audit1 = auditMode1Output(draft, evidence)
  const ce = goldCeiling({ ...g, draft, stored: 'x'.repeat(Math.max(0, storedOf(draft))), outcome: g.outcome }, lines[g.id] ? { lineChars: lines[g.id].lineChars, lineRatio: lines[g.id].lineRatio } : null)
  return {
    id: g.id, family: g.family, split: g.split, use: goldUse(g), source: g.__file,
    before: { draftChars: String(g.draft || '').length, storedChars: String(g.stored || '').length, ratio: +(String(g.stored || '').length / rawChars).toFixed(3), audit: (g.qualityAudit || audit0).status, fails: goldCeiling(g, lines[g.id] ? { lineChars: lines[g.id].lineChars, lineRatio: lines[g.id].lineRatio } : null).fails.map((x) => x.slice(0, 2)) },
    after: { draftChars: draft.length, storedApprox: storedOf(draft), ratio: +(storedOf(draft) / rawChars).toFixed(3), audit: audit1.status, closedRead: hasClosedRead(draft), line: lines[g.id] ? lines[g.id].lineChars : null, fails: ce.fails.map((x) => x.slice(0, 2)), ok: ce.ok },
    removedSentences: removed, trimmedSentences: trimmed, needsManual: missing,
    grounded: p, rowDir: row?.dir || null, draft,
  }
}

const wanted = flag('--all') ? null : arg('--ids', '').split(',').map((s) => s.trim()).filter(Boolean)
const files = from.flatMap(walk)
const seen = new Set(), items = []
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
  if (!g?.id || !g.raw) continue
  if (seen.has(g.id)) continue          // 同 id 有两份（active 优先，walk 顺序里 transfer/gold 在前）
  seen.add(g.id)
  if (wanted && !wanted.includes(g.id)) continue
  g.__file = path.relative(ROOT, f)
  items.push(g)
}
const lim = Number(arg('--limit', '0')) || items.length
const out = items.slice(0, lim).map(forge)
fs.mkdirSync(outDir, { recursive: true })
for (const r of out) {
  fs.writeFileSync(path.join(outDir, `${r.id}.base.md`), r.draft + '\n')
  fs.writeFileSync(path.join(outDir, `${r.id}.evidence.json`), JSON.stringify({ id: r.id, before: r.before, after: r.after, auditHits: r.removedSentences, evidence: r.grounded, outcome: r.outcome, rowDir: r.rowDir }, null, 2) + '\n')
}
fs.mkdirSync(path.dirname(ledger), { recursive: true })
fs.writeFileSync(ledger, JSON.stringify({ schema: 'cfb.gold-forge/1', at: new Date().toISOString(), ready: out.filter((r) => !r.needsManual.length).length, rows: out.map(({ draft, ...r }) => r) }, null, 2) + '\n')
console.log(`${'id'.padEnd(34)} ${'stored比'.padEnd(9)} ${'前缺'.padEnd(12)} ${'后缺'.padEnd(12)} 审计 判读 落盘`)
for (const r of out) console.log(`${r.id.padEnd(34)} ${(r.before.ratio + '→' + r.after.ratio).padEnd(9)} ${(r.before.fails.join(',') || '—').padEnd(12)} ${(r.after.fails.join(',') || '✓').padEnd(12)} ${r.after.audit.padEnd(4)} ${(r.after.closedRead ? '✓' : '✗').padEnd(4)} ${r.needsManual.length ? '—' : '✓'}`)
console.log(`\n锻造 ${out.length} 条：可入册前复检 ${out.filter((r) => !r.needsManual.length).length} · needs-manual ${out.filter((r) => r.needsManual.length).length} · 已过 C1–C6 ${out.filter((r) => r.after.ok).length}`)
console.log(`稿 → ${path.relative(ROOT, outDir)}/<id>.md   台账 → ${path.relative(ROOT, ledger)}`)
if (flag('--print') && out[0]) console.log(`\n── 样例 ${out[0].id}（删 ${out[0].removedSentences.length} 句审计命中，删 ${out[0].trimmedSentences} 句复述）──\n${out[0].draft}`)
