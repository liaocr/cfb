#!/usr/bin/env node
// tools/gold-check.mjs —— 一条改完的金标稿，到底达没达上限线？（$0）
// 与 replay 的分工：cfb-gold-repair replay 跑**生产闸链**（G2/compileV4Direct/birthAccept/越界 lint）并给出**真实 stored**；
// 本脚本拿那个真实 stored 去跑 §0A 的 C1–C6。长度不许自己估：生产拼接的延续段有 600–900 字，估了就是假达标。
// 用法：
//   node tools/gold-check.mjs --id <goldId> --draft <file.md> [--from transfer/gold,transfer/gold-rejected]
//   node tools/gold-check.mjs --pending .cfb-runtime/traj/tN/pending/<id>.json --draft <file.md>   # 真机新轨迹（还没入册）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { goldCeiling, goldUse } from './helpers/three-mode.mjs'
import { hasClosedRead, anchorsOf, handDraftGate } from './helpers/hand-draft.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const die = (m) => { console.error('✗ ' + m); process.exit(2) }
const id0 = arg('--id')
const draftFile = arg('--draft') || die('--draft 必填')
const pendFile = arg('--pending') ? path.resolve(ROOT, arg('--pending')) : null
const from = arg('--from', 'transfer/gold,transfer/gold-rejected').split(',').map((s) => path.join(ROOT, s.trim()))

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : [])) : [])
let g, source, registryId = id0
const pendPath = (() => {
  if (!pendFile) return null
  if (fs.existsSync(pendFile)) return pendFile
  const dir = path.dirname(pendFile), base = path.basename(pendFile)
  const alt = [path.join(dir, 'done', base), path.join(path.dirname(dir), 'pending', 'done', base)]
  const hit = alt.find((x) => fs.existsSync(x))
  if (!hit) die(`pending 文件不存在（也找不到 done/ 里的归档）：${path.relative(ROOT, pendFile)}`)
  return hit
})()
if (pendFile) {
  const p = JSON.parse(fs.readFileSync(pendPath, 'utf8'))
  g = { id: p.id, family: p.task, split: 'dev', raw: p.raw, ctx: p.ctx || '', calls: p.calls || [], draft: '', stored: '', outcome: null }
  source = path.relative(ROOT, pendFile); registryId = p.id
} else {
  if (!id0) die('--id 或 --pending 二选一')
  let file = null
  for (const d of from) { const hit = walk(d).find((f) => path.basename(f) === `${id0}.json`); if (hit) { file = hit; break } }
  if (!file) die(`找不到条目 ${id0}（在 ${from.map((d) => path.relative(ROOT, d)).join(', ')} 里）`)
  g = JSON.parse(fs.readFileSync(file, 'utf8')); source = path.relative(ROOT, file)
}
const draft = fs.readFileSync(path.resolve(draftFile), 'utf8').trim()
if (!draft) die('稿是空的')

// 1) 真实 stored
let storedNote = '', storedReal = 0, replayGreen = false, g2Unchanged = false, verdict = '?', inventedSpans = null
if (pendFile) {
    // v14.23.0：真机跑过的轮次以**生产实际写出的 stored** 为准（hand-samples.jsonl 里有），别用台账估——
  //   t98 实测：估 768、真机存 3114（程序部件 + 整段台账都进 stored），差了 4 倍 ⇒ 「$0 达线」必须是真机口径的达线。
  let real = 0
  try {
    const dir = path.dirname(path.dirname(pendFile))
    for (const f of ['hand-samples.jsonl', 'results.jsonl']) {
      const fp = path.join(dir, f)
      if (!fs.existsSync(fp)) continue
      for (const l of fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean)) {
        let r; try { r = JSON.parse(l) } catch { continue }
        const cand = [r, ...(Array.isArray(r?.compile) ? r.compile : [])]
        for (const c of cand) { const t = c && (c.storedChars ?? (c.stored ? String(c.stored).length : null)); if (t && (c.round === g.round || c.id === registryId || r.id === registryId)) real = Math.max(real, Number(t)) }
      }
    }
  } catch { /* 还没跑过真机 ⇒ 用估算 */ }
  const m = String(g.ctx || '').match(/^- 已走过的路：.*$/m)
  storedReal = real || ((m ? m[0].length : 0) + draft.length)
  if (real) storedNote = `生产实存 ${real} 字（估 ${(m ? m[0].length : 0) + draft.length}）`           // 生产把延续段原样拼在稿首
  const gate = handDraftGate(String(g.raw), draft, String(g.ctx))
  replayGreen = !!gate.ok; g2Unchanged = !!gate.ok; verdict = gate.verdict || (gate.ok ? 'gate-ok' : 'gate-rejected')
} else {
  let out = ''
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'cfb-gold-repair.mjs'), 'replay', '--id', registryId, '--draft', path.resolve(draftFile)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 })
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') }
  storedReal = Number((out.match(/stored (\d+) 字/) || [])[1] || 0)
  replayGreen = /离线全绿/.test(out)                            // 生产自己的判词，不另立口径
  g2Unchanged = /离线全绿：G2 决策不变/.test(out)
  inventedSpans = Number((out.match(/"inventedSpans":\s*(\d+)/) || [])[1] ?? null)
  verdict = (out.match(/"verdict":\s*"([\w-]+)"/) || [])[1] || '?'
}

// 2) §0A C1–C6
const lines = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline', 'ruler', 'gold-vs-line.json'), 'utf8')).lines || {} } catch { return {} } })()
const row = lines[registryId] || null
const rawChars = String(g.raw || '').length
const ce = goldCeiling({ ...g, draft, stored: 'x'.repeat(storedReal || draft.length), outcome: g.outcome }, row ? { lineChars: row.lineChars, lineRatio: row.lineRatio } : null)
const fails = ce.fails.slice()
const warns = []
if (!replayGreen) fails.push('生产闸未全绿（见 handDraftGate / replay 输出）')
else if (!g2Unchanged && !pendFile) fails.push('G2 决策不变未通过')
if (verdict === 'invented-anchors') fails.push('越界 lint：verdict=invented-anchors ⇒ 稿里有证据外锚点，那是银标不是金标')
else if (inventedSpans) warns.push(`inventedSpans=${inventedSpans}（stored 逐字回显免检那一类，生产闸判过）`)
const ev = String(g.raw) + '\n' + String(g.ctx)
// 反引号片段逐字接地检查（生产闸真判这个 ⇒ 先自己查，省一次白跑）：new_text/协议词除外
const ticks = [...draft.matchAll(/`([^`]+)`/g)].map((m) => m[1])
const ungrounded = ticks.filter((x) => !ev.includes(x) && !/old_text|new_text/.test(x) && !/\{[^}]*\}/.test(x))
if (ungrounded.length) fails.push('反引号片段不在证据里逐字出现（会被生产闸判 invented-identifier）⇒ ' + JSON.stringify(ungrounded.slice(0, 4)))
const all = [...anchorsOf(draft)].filter((a) => !anchorsOf(ev).has(a))
const inventedLocal = all.filter((a) => !/^[-+]?\d+(?:\.\d+)?$/.test(a))   // 纯数字多是 new_text 里的目标值（属"决定"，由 G2/newTextSpans 管）⇒ 只提示不判死
if (all.length !== inventedLocal.length) warns.push('差集里的纯数字按 new_text 处理：' + JSON.stringify(all.filter((a) => !inventedLocal.includes(a))))
if (inventedLocal.length) fails.push('本地锚点差集非空（证据外标识符）⇒ ' + JSON.stringify(inventedLocal.slice(0, 6)))
if (!g.outcome) {
  const pending = fails.filter((x) => x.startsWith('C4') || x.startsWith('C5'))
  if (pending.length) { fails.splice(0, fails.length, ...fails.filter((x) => !pending.includes(x))); warns.push('C4/C5（提前量与 vsRaw）只能由真机给 ⇒ ' + pending.map((x) => x.slice(0, 2)).join('/')) }
}
const res = { id: registryId, source, pending: !!pendFile, use: g.use ?? goldUse(g), draftChars: draft.length, rawChars, storedReal: storedReal || null, ratio: storedReal ? +(storedReal / rawChars).toFixed(3) : null, line: row ? { lineChars: row.lineChars, lineRatio: row.lineRatio, g2Ok: row.g2Ok, over: storedReal - row.lineChars } : null, closedRead: hasClosedRead(draft), replayGreen, g2Unchanged, verdict, warns, fails, ok: fails.length === 0 }
const jf = arg('--json', path.join(ROOT, '.cfb-offline', 'ruler', `gold-check-${registryId}.json`))
fs.mkdirSync(path.dirname(jf), { recursive: true })
fs.writeFileSync(jf, JSON.stringify({ ...res, at: new Date().toISOString() }, null, 2) + '\n')
console.log(`${registryId}  稿 ${draft.length} → 真实 stored ${storedReal}（raw ${rawChars} ⇒ ratio ${res.ratio ?? '-'}）  产线 ${row ? row.lineChars : '缺对照'} ⇒ ${row ? (storedReal <= row.lineChars ? '✓ 不劣于产线' : '✗ 超 ' + (storedReal - row.lineChars) + ' 字') : '—'}`)
if (storedNote) console.log('stored 口径：' + storedNote)
console.log(`闸链 ${replayGreen ? '✓' : '✗'} · G2 决策不变 ${g2Unchanged ? '✓' : '✗'} · 闭合判读 ${res.closedRead ? '✓' : '✗'} · verdict ${verdict}`)
if (warns.length) console.log('提示：' + warns.join('；'))
if (fails.length) console.log('仍缺：\n  - ' + fails.join('\n  - '))
else console.log(pendFile ? '✓ $0 判据全过 ⇒ 可以续跑 traj-run 让真机给 C4/C5' : '✓✓ C1–C6 + 生产闸 + 越界 lint 全过 ⇒ 只差真机读数')
process.exitCode = fails.length ? 1 : 0
