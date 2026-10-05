// 金标逐项上限闸审计：对 transfer/gold 与 transfer/gold-rejected 的每一条，用生产判据 goldCeiling 现算（/bin/bash，不写回）。
import fs from 'node:fs'
import path from 'node:path'
import { goldCeiling } from './helpers/three-mode.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const lines = fs.existsSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines || {} : {}
const walk = (d) => { const o = []; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) o.push(...walk(p)); else if (f.name.endsWith('.json')) o.push(p) } return o }
const rows = []
for (const base of ['transfer/gold', 'transfer/gold-rejected']) {
  for (const f of walk(path.join(ROOT, base))) {
    let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    if (!j || !j.id || !j.draft) continue
    const c = goldCeiling(j, lines[j.id] || null)
    rows.push({
      where: base.endsWith('rejected') ? 'rej' : 'act', id: j.id, draft: j.draft.length, ok: c.ok,
      fails: c.fails.map((x) => x.split('：')[0].slice(0, 30)).join('|') || '—',
      ratio: c.ratio ?? '-', line: c.lineChars ?? '-', rtf: j.outcome?.roundsToFix ?? '-', vs: j.outcome?.vsRaw || '-'
    })
  }
}
rows.sort((a, b) => (a.where === b.where ? b.draft - a.draft : a.where < b.where ? -1 : 1))
for (const r of rows) console.log(`${r.where} ${r.id.padEnd(34)} 稿${String(r.draft).padStart(4)} ${r.ok ? '✓达标' : '✗'} ratio=${r.ratio} 线=${r.line} rtf=${r.rtf} ${r.vs} ${r.ok ? '' : r.fails}`)
console.log('达标', rows.filter((r) => r.ok).length, '/', rows.length)
