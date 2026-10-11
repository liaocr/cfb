// tools/v9-inventory.mjs —— 盘点仓库里所有「压缩样本」行（messages: system/user(【CONTEXT】…【RAW】…)/assistant(稿)）。
// 只读。输出每个文件的行数、可解析行数、唯一 unitId 数。用法：node tools/v9-inventory.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = /node_modules|\.git[\\/]|\/traj\/|archive|\/pending|\/drafts/
function* walk(d) {
  let ents = []
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(d, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) yield* walk(p)
    else if (/\.jsonl(\.gz)?$/.test(e.name)) yield p
  }
}
export function readLines(p) {
  let buf = fs.readFileSync(p)
  if (p.endsWith('.gz')) buf = zlib.gunzipSync(buf)
  return buf.toString('utf8').split('\n').filter((l) => l.trim())
}
export function parseSample(line) {
  let r
  try { r = JSON.parse(line) } catch { return null }
  const m = Array.isArray(r.messages) ? r.messages : null
  const u = m && m.find((x) => x.role === 'user')?.content
  const a = m && m.find((x) => x.role === 'assistant')?.content
  if (typeof u !== 'string' || typeof a !== 'string') return null
  const iR = u.indexOf('【RAW】')
  if (iR < 0) return null
  const iC = u.indexOf('【CONTEXT】')
  const ctx = iC >= 0 && iC < iR ? u.slice(iC + '【CONTEXT】'.length, iR).trim() : ''
  const raw = u.slice(iR + '【RAW】'.length).trim()
  return { unitId: r.unitId || null, repo: r.repo || null, raw, ctx, target: a.trim(), meta: r }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = []
  for (const p of walk(ROOT)) {
    let lines
    try { lines = readLines(p) } catch { continue }
    let ok = 0, ids = new Set()
    for (const l of lines) { const s = parseSample(l); if (s) { ok++; if (s.unitId) ids.add(s.unitId) } }
    if (ok) rows.push({ file: path.relative(ROOT, p), lines: lines.length, parsed: ok, uniqueUnits: ids.size })
  }
  for (const r of rows) console.log(`${r.file.padEnd(90)} lines=${r.lines} parsed=${r.parsed} units=${r.uniqueUnits}`)
  console.log('files:', rows.length)
}
