#!/usr/bin/env node
// tools/gold-triage.mjs —— $0 台账：把在册 + 隔离区的金标逐条按上限线（§0A C1–C6）量化缺口
// 为什么要有这个文件：判定"改到哪一步了"必须可复算，不能靠人脑记 19 条的缺项。
// 用法：node tools/gold-triage.mjs [--dirs transfer/gold,transfer/gold-rejected] [--json out.json]
// 口径要点：
//   · C6 需要同 raw 的产线稿读数（tools/gold-vs-line.mjs 落 .cfb-offline/ruler/gold-vs-line.json）；
//     缺读数时本台账把 C6 单列成 line:'missing'，不与内容缺陷混在一起 —— 「先补稿，后花对照钱」。
//   · replayable：条目里是否带 ctx/calls（有 ⇒ tools/cfb-gold-repair.mjs replay 能 $0 复跑生产闸链）。
//   · hasTraj：能否在本地 traj 目录里找到该 id 的原始行（真机 transcript 可读 ⇒ 改稿前必须读）。
import fs from 'node:fs'
import path from 'node:path'
import { goldCeiling, goldUse } from './helpers/three-mode.mjs'
import { auditMode1Output } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const dirs = arg('--dirs', 'transfer/gold,transfer/gold-rejected').split(',').map((d) => path.join(ROOT, d.trim()))
const jsonOut = arg('--json', path.join(ROOT, '.cfb-offline', 'ruler', 'gold-triage.json'))

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && !e.name.startsWith('audit-') ? [path.join(d, e.name)] : [])) : [])
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])

// 本地所有 traj 目录里的行（hand/ledger/raw 各臂），按 id 或 (task,sample) 建索引 —— 只为回答"transcript 能不能读到"
const trajDirs = []
for (const base of [path.join(ROOT, 'transfer'), path.join(ROOT, '.cfb-runtime', 'traj'), path.join(ROOT, '.cfb-runtime', 'scratch')]) {
  if (!fs.existsSync(base)) continue
  for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) trajDirs.push(path.join(base, e.name))
}
const trajRows = []
for (const d of trajDirs) {
  for (const f of ['results.jsonl', 'hand-samples.jsonl', 'rows.jsonl', 'ledger.jsonl']) for (const r of readJsonl(path.join(d, f))) trajRows.push({ dir: d, ...r })
}
const findTraj = (g) => trajRows.filter((r) => (r.goldId && r.goldId === g.id) || (r.id && r.id === g.id) || (r.task && r.task === g.family && String(r.sample) === String(g.sample ?? '')))

const lineFile = arg('--line', path.join(ROOT, '.cfb-offline', 'ruler', 'gold-vs-line.json'))
const lines = (fs.existsSync(lineFile) ? (JSON.parse(fs.readFileSync(lineFile, 'utf8')).lines || {}) : {})
const rows = []
for (const dir of dirs) {
  for (const f of walk(dir)) {
    let g
    try { g = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    if (!g || !g.id || !g.raw) continue
    const raw = String(g.raw).length, stored = String(g.stored || g.draft || '').length
    const ce = goldCeiling(g, lines[g.id] ? { lineChars: lines[g.id].lineChars, lineRatio: lines[g.id].lineRatio } : null)
    const audit = auditMode1Output(String(g.draft || ''), String(g.raw) + '\n' + String(g.ctx || ''))
    rows.push({
      source: path.relative(ROOT, f), id: g.id, family: g.family || path.basename(path.dirname(f)), split: g.split, use: goldUse(g),
      raw, stored, ratio: stored && raw ? +(stored / raw).toFixed(3) : null,
      savedChars: raw - stored,
      c1to5: ce.fails.filter((x) => !x.startsWith('C6')).map((x) => x.slice(0, 2)),
      line: lines[g.id] ? `line=${lines[g.id].lineChars} stored=${stored} ${stored <= lines[g.id].lineChars ? '✓' : '✗ +' + (stored - lines[g.id].lineChars)}` : 'missing',
      vsRaw: g.outcome?.vsRaw ?? '?', roundsToFix: g.outcome?.roundsToFix ?? '?', rawRounds: g.outcome?.rawRoundsToFix ?? '?',
      verifiedAfterFix: g.outcome?.verifiedAfterFix ?? g.validatedAfterFix ?? '?',
      audit: g.qualityAudit?.status ?? (audit ? audit.status : '?'),
      replayable: !!(g.ctx && (g.calls || g.callsJsonl || g.rounds)),
      hasTraj: findTraj(g).length,
      ok: ce.ok === true,
    })
  }
}
rows.sort((a, b) => (a.ok === b.ok ? a.family.localeCompare(b.family) : a.ok ? -1 : 1))
fs.mkdirSync(path.dirname(jsonOut), { recursive: true })
fs.writeFileSync(jsonOut, JSON.stringify({ schema: 'cfb.gold-triage/1', at: new Date().toISOString(), total: rows.length, ok: rows.filter((r) => r.ok).length, rows }, null, 2) + '\n')
const pad = (s, n) => String(s).padEnd(n).slice(0, n)
console.log(`${pad('id', 34)} ${pad('ratio', 6)} ${pad('缺项', 10)} ${pad('C6', 22)} ${pad('vsRaw/rtf', 12)} ${pad('replay/traj', 12)} ok`)
for (const r of rows) {
  console.log(`${pad(r.id, 34)} ${pad(r.ratio ?? '-', 6)} ${pad((r.c1to5.join(',') || '—'), 10)} ${pad(r.line, 22)} ${pad(`${r.vsRaw}/${r.roundsToFix}`, 12)} ${pad(`${r.replayable ? 'Y' : 'n'}/${r.hasTraj}`, 12)} ${r.ok ? '✓' : ''}`)
}
console.log(`\n合计 ${rows.length} 条：达线 ${rows.filter((r) => r.ok).length} · 缺产线对照 ${rows.filter((r) => r.line === 'missing').length} · 可 replay($0) ${rows.filter((r) => r.replayable).length} · 能读到真机行 ${rows.filter((r) => r.hasTraj > 0).length}`)
console.log(`台账 → ${path.relative(ROOT, jsonOut)}`)
