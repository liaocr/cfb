// 金标逐项上限闸审计：对 transfer/gold 与 transfer/gold-rejected 的每一条，用生产判据 goldCeiling 现算（/bin/bash，不写回）。
import fs from 'node:fs'
import path from 'node:path'
import { goldCeiling } from './helpers/three-mode.mjs'
import { auditMode1Gold } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const lines = fs.existsSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines || {} : {}
const walk = (d) => { const o = []; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) o.push(...walk(p)); else if (f.name.endsWith('.json')) o.push(p) } return o }
const rows = []
for (const base of ['transfer/gold', 'transfer/gold-rejected']) {
  for (const f of walk(path.join(ROOT, base))) {
    let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    if (!j || !j.id || !j.draft) continue
    const c = goldCeiling(j, lines[j.id] || null)
    const qa = auditMode1Gold(j, { reviewer: 'mode1-writer+apparatus-lint/1' })
    const onDraft = (qa.issues || []).filter((x) => x.field === 'draft').length, onStored = (qa.issues || []).filter((x) => x.field === 'stored').length
    rows.push({
      where: base.endsWith('rejected') ? 'rej' : 'act', id: j.id, draft: j.draft.length, ok: c.ok,
      fails: c.fails.map((x) => x.split('：')[0].slice(0, 30)).join('|') || '—',
      ratio: c.ratio ?? '-', line: c.lineChars ?? '-', rtf: j.outcome?.roundsToFix ?? '-', vs: j.outcome?.vsRaw || '-',
      audit: qa.status, onDraft, onStored, use: j.use || '-'
    })
  }
}
rows.sort((a, b) => (a.where === b.where ? b.draft - a.draft : a.where < b.where ? -1 : 1))
for (const r of rows) console.log(`${r.where} ${r.id.padEnd(34)} 稿${String(r.draft).padStart(4)} ${r.ok ? 'C1–C6 ✓' : 'C1–C6 ✗'} ${r.audit === 'clean' ? '话术 clean' : '话术 ' + r.audit + `(稿${r.onDraft}/存${r.onStored})`} ratio=${r.ratio} 线=${r.line} rtf=${r.rtf} ${r.vs}${r.ok ? '' : ' ' + r.fails}`)
const gold = rows.filter((r) => r.where === 'act'), rej = rows.filter((r) => r.where === 'rej')
const ruler = (list) => list.filter((r) => r.ok && r.audit === 'clean')
console.log(`\n在册 ${gold.length}：C1–C6 全过 ${gold.filter((r) => r.ok).length}、话术 clean ${gold.filter((r) => r.audit === 'clean').length}、两者都过（=可当标尺）${ruler(gold).length}`)
console.log(`rejected ${rej.length}：C1–C6 全过 ${rej.filter((r) => r.ok).length}、话术 clean ${rej.filter((r) => r.audit === 'clean').length}、两者都过 ${ruler(rej).length}`)
const only = rows.filter((r) => !r.ok).map((r) => r.fails.split('|')[0]).concat(rows.filter((r) => r.ok && r.audit !== 'clean').map(() => '装置话术(stored)'))
const tally = {}
for (const k of only) tally[k] = (tally[k] || 0) + 1
console.log('未达线原因分布：' + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · '))
fs.writeFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-final.md'), ['| 位 | id | 稿长 | C1–C6 | 装置话术 | ratio | 产线 | rtf | vsRaw | 缺项 |', '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.where} | ${r.id} | ${r.draft} | ${r.ok ? '✓' : '✗'} | ${r.audit}${r.audit === 'clean' ? '' : `(稿${r.onDraft}/存${r.onStored})`} | ${r.ratio} | ${r.line} | ${r.rtf} | ${r.vs} | ${r.ok ? '—' : r.fails} |`)].join('\n') + '\n')
console.log('逐项表写入 .cfb-offline/ruler/gold-final.md')
