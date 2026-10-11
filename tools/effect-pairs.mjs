#!/usr/bin/env node
// tools/effect-pairs.mjs —— 效果评测的逐样本归因助手（零调用）：把「同一任务上原文成功 / 压缩稿失败（或反过来）」的成对样本摆在一起。
//
// 为什么：本项目的迭代循环 = 原文 vs 压缩稿逐样本对读 → 归因 → 改提示词 / 程序门（与 ACON 的「成对轨迹失败分析」同构，arXiv 2510.00615）。
// 2026-09-29 之前这一步靠手写 node -e 一次次翻 results.jsonl；这里固定下来：
//   · 每个样本：分数、动作类别（edit / reread-known 再读已看过的文件 / probe 新取证 / none）、首个工具调用、盲评一句话
//   · 每个任务：raw 与变体的配对差；「压坏」（raw ≥ hi 且变体 ≤ lo）与「压好」（反过来）的样本成对列出
//   · 给了 --report 时，附上该变体压缩稿的收尾（最后一个「所以下一步」起），归因时直接看分支写法
//
//   node tools/effect-pairs.mjs --results /home/user/effect-16 --variants raw,oF,oC --report oF=/home/user/direct-of.json
//   选项：--only task1,task2  --hi 7 --lo 4（成对阈值）  --all（列出全部样本，不只成对的）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TASKS } from './v4-live.mjs'

export function parseArgs(argv) {
  const o = { variants: null, reports: [], hi: 7, lo: 4, all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--results') o.results = v()
    else if (a === '--variants') o.variants = v().split(',')
    else if (a === '--report') { const [name, p] = v().split('='); o.reports.push({ name, path: p }) }
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--hi') o.hi = Number(v())
    else if (a === '--lo') o.lo = Number(v())
    else if (a === '--all') o.all = true
    else throw new Error('未知参数 ' + a)
  }
  if (!o.results) throw new Error('需要 --results <effect 目录或 results.jsonl>')
  return o
}

/** 任务原文里已经给过内容的文件（[tool: read_file] xxx / 路径形 token）——再读它们就是「回头 read」 */
export function seenFiles(taskText) {
  const out = new Set()
  for (const m of String(taskText || '').matchAll(/\[tool:\s*[^\]]+\]\s*([^\s（(§]+)/g)) if (/[./]/.test(m[1])) out.add(m[1])
  for (const m of String(taskText || '').matchAll(/(?<![\w/])(?:[\w-]+\/)*[\w-]+\.(?:m?js|c?js|ts|json|ya?ml|py|go|rs|sh|md)\b/g)) out.add(m[0])
  return out
}

/** 主模型下一步的动作类别 */
export function classifyAction(taskText, response) {
  const r = String(response || '')
  if (/\[tool_call edit_file\]/.test(r)) return 'edit'
  const calls = [...r.matchAll(/\[tool_call (\w+)\] (\{[\s\S]*?\})(?=\n\[tool_call|\s*$)/g)]
  if (!calls.length) return 'none'
  const seen = seenFiles(taskText)
  const touchesSeen = (s) => [...seen].some((f) => s.includes(f))
  for (const [, name, args] of calls) {
    if (name === 'read_file' && touchesSeen(args)) return 'reread-known'
    if (name === 'bash' && /\b(?:sed -n|cat|head|tail|grep|rg)\b/.test(args) && touchesSeen(args)) return 'reread-known'
  }
  return 'probe'
}

const firstCall = (response) => { const m = /\[tool_call (\w+)\] (\{[\s\S]{0,160})/.exec(String(response || '')); return m ? m[1] + ' ' + m[2].replace(/\s+/g, ' ') : '(无工具调用)' }
const closing = (text) => { const s = String(text || ''); const i = s.lastIndexOf('所以下一步'); return (i >= 0 ? s.slice(i) : s.slice(-400)).replace(/\s+/g, ' ') }
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '—'

export function loadResults(p) {
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'results.jsonl') : p
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map()
  for (const r of all) { const k = `${r.task}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  return [...last.values()].filter((r) => !r.error && r.judge)
}

export function pairsReport(rows, o = {}) {
  const hi = o.hi ?? 7, lo = o.lo ?? 4
  const drafts = o.drafts || {}   // { variant: { taskId: text } }
  const tasks = [...new Set(rows.map((r) => r.task))].filter((t) => !o.only || o.only.includes(t))
  const variants = [...new Set(rows.map((r) => r.variant))].filter((v) => !o.variants || o.variants.includes(v))
  const L = []
  for (const t of tasks) {
    const task = TASKS.find((x) => x.id === t)
    const text = task ? task.user : ''
    const by = (v) => rows.filter((r) => r.task === t && r.variant === v).sort((a, b) => a.sample - b.sample)
    const raw = by('raw')
    L.push(`## ${t}`, '', '| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |', '|---|---|---|---|---|---|')
    for (const v of variants) {
      for (const r of by(v)) {
        L.push(`| ${v} | ${r.sample} | ${r.judge.overall} | ${classifyAction(text, r.response)} | ${firstCall(r.response).slice(0, 90).replace(/\|/g, '\\|')} | ${String(r.judge.note || '').slice(0, 80).replace(/\|/g, '\\|')} |`)
      }
    }
    for (const v of variants) {
      if (v === 'raw') continue
      const vs = by(v)
      if (!vs.length || !raw.length) continue
      const d = mean(vs.map((r) => Number(r.judge.overall))) - mean(raw.map((r) => Number(r.judge.overall)))
      const hurt = vs.filter((r) => Number(r.judge.overall) <= lo && raw.some((x) => Number(x.judge.overall) >= hi))
      const helped = vs.filter((r) => Number(r.judge.overall) >= hi && raw.some((x) => Number(x.judge.overall) <= lo))
      L.push('', `- **${v}** Δ=${(d >= 0 ? '+' : '') + f1(d)}（n=${vs.length} vs raw n=${raw.length}）` +
        (hurt.length ? `；压坏 ${hurt.length} 例（变体 ≤${lo} 而原文有 ≥${hi}）` : '') + (helped.length ? `；压好 ${helped.length} 例` : ''))
      if ((hurt.length || helped.length || o.all) && drafts[v] && drafts[v][t]) L.push(`  - ${v} 稿收尾：${closing(drafts[v][t]).slice(0, 700)}`)
      for (const r of hurt) L.push(`  - 压坏 #${r.sample}：${classifyAction(text, r.response)} ← ${firstCall(r.response).slice(0, 120)}；盲评：${String(r.judge.note || '').slice(0, 140)}`)
      for (const r of helped) L.push(`  - 压好 #${r.sample}：${classifyAction(text, r.response)} ← ${firstCall(r.response).slice(0, 120)}`)
    }
    L.push('')
  }
  // 总表：各变体的动作类别分布（回头 read 率是最贴近「专注力」的客观量）
  L.push('## 动作类别分布', '', '| 变体 | n | edit | reread-known | probe | none |', '|---|---|---|---|---|---|')
  for (const v of variants) {
    const vs = rows.filter((r) => r.variant === v && (!o.only || o.only.includes(r.task)))
    const c = { edit: 0, 'reread-known': 0, probe: 0, none: 0 }
    for (const r of vs) { const task = TASKS.find((x) => x.id === r.task); c[classifyAction(task ? task.user : '', r.response)]++ }
    const pct = (k) => vs.length ? Math.round(c[k] * 100 / vs.length) + '%' : '—'
    L.push(`| ${v} | ${vs.length} | ${pct('edit')} | ${pct('reread-known')} | ${pct('probe')} | ${pct('none')} |`)
  }
  return L.join('\n')
}

async function main(argv) {
  const o = parseArgs(argv)
  const rows = loadResults(o.results)
  const drafts = {}
  for (const { name, path: p } of o.reports) {
    const rep = JSON.parse(fs.readFileSync(p, 'utf8'))
    drafts[name] = Object.fromEntries((rep.rows || []).filter((r) => /^condensed/.test(r.why || '') && typeof r.text === 'string').map((r) => [r.id, r.text]))
  }
  console.log(pairsReport(rows, { ...o, drafts }))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
