#!/usr/bin/env node
/**
 * 金标水平尺（GOLD-STANDARD v1 的命令行）——「达标 ⟺ 金标水平」的那把尺子怎么读：
 *   node tools/gold-score.mjs                                   # 批量：transfer/gold + transfer/gold-rejected
 *   node tools/gold-score.mjs --dirs=gold                        # 只看在册
 *   node tools/gold-score.mjs --id <id>                          # 单条（含轴 gap/margin/复算命令）
 *   node tools/gold-score.mjs --id <id> --draft f.md             # 花真机钱之前预判（E1/E2 会是「未测」）
 *   node tools/gold-score.mjs --pending p.json --draft f.md      # 拿当轮 pending 直接量
 *   node tools/gold-score.mjs --json=stdout | jq .rows[].status  # 机读
 *   node tools/gold-score.mjs --md=.cfb-offline/ruler/gold-score.md
 * 尺子只做测量：判定与阈值全在 tools/helpers/gold-standard.mjs（唯一权威定义），此处不另立口径。
 * 附带一致性对照：与注册闸 goldCeiling 的结论不符 ⇒ 打 ⚠ 并 exit 1（两套裁判必须说同一句话）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { GOLD_STANDARD_VERSION, THRESHOLDS, AXES, measureGold, strokeLineIndex } from './helpers/gold-standard.mjs'
import { goldCeiling } from './helpers/three-mode.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ((process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1) || d) }
const has = (k) => process.argv.includes(k) || process.argv.some((a) => a.startsWith(k + '='))
const SYM = (a) => a.pass === null ? '·' : a.pass ? '✓' : '✗'
const walk = (d) => { const o = []; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) o.push(...walk(p)); else if (f.name.endsWith('.json')) o.push(p) } return o }
const lines = strokeLineIndex()
const home = arg('--home', null)

const targets = []
if (arg('--pending', null)) {
  const pf = path.resolve(arg('--pending'))
  const j = JSON.parse(fs.readFileSync(pf, 'utf8'))
  targets.push({ item: { id: j.id, family: String(j.task || '').split(':')[0], task: j.task, sample: j.sample ?? 0, raw: j.raw, ctx: j.ctx }, draft: arg('--draft', null) ? fs.readFileSync(path.resolve(arg('--draft')), 'utf8') : null, where: 'pending' })
} else if (arg('--id', null)) {
  const id = arg('--id')
  let file = null
  for (const base of String(arg('--dirs', 'gold,gold-rejected')).split(',')) { const p = path.join(ROOT, 'transfer', base.trim()); for (const f of walk(p)) if (path.basename(f) === `${id}.json`) { file = f; break } }
  if (!file) { console.error(`注册表里找不到 id=${id}（--dirs 里都没有）`); process.exit(2) }
  targets.push({ item: JSON.parse(fs.readFileSync(file, 'utf8')), draft: arg('--draft', null) ? fs.readFileSync(path.resolve(arg('--draft')), 'utf8') : null, where: path.basename(path.dirname(file)) })
} else {
  for (const base of String(arg('--dirs', 'gold,gold-rejected')).split(',')) {
    const D = path.join(ROOT, 'transfer', base.trim())
    for (const f of walk(D).sort()) { let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue } if (j?.id && j.draft) targets.push({ item: j, draft: null, where: base.trim() }) }
  }
  if (!targets.length) { console.error('没有可量的条目（--dirs 指向的目录里没有带 draft 的 json）'); process.exit(2) }
}

const rows = []
for (const t of targets) {
  const m = measureGold(t.item, { draft: t.draft, lineRow: lines[t.item.id] || null, home })
  // 一致性对照：册内条目要能被生产闸复核（候选稿/隔离区条目不在生产视野里 ⇒ 只报不对照，不谎称一致）
  let mismatch = false, ce = null
  if (!t.draft && t.where !== 'pending') {
    try { ce = goldCeiling(t.item, lines[t.item.id] || null) } catch { ce = null }
    if (ce) {
      // 只判一个方向：尺子说这条稿的 C 轴全过，生产闸却说不收 ⇒ 两套裁判打架（尺子比闸严不算 bug，那是取严）
      const mineAll = ['M1', 'M2', 'M3', 'M4', 'M5'].every((x) => m.axes[x].pass === true)
      mismatch = mineAll && ce.ok === false
    }
  }
  rows.push({ where: t.where || '-', ...m, mismatch, ceiling: ce ? { ok: !!ce.ok, fails: (ce.fails || []).map((x) => String(x).split('：')[0]) } : null })
}
const out = { schema: 'cfb.gold-score/1', standard: GOLD_STANDARD_VERSION, thresholds: THRESHOLDS, rows }
if (has('--json') && (!arg('--json') || arg('--json') === 'stdout')) {
  console.log(JSON.stringify(out, null, 2))
  if (rows.some((r) => r.mismatch)) process.exit(1)
  process.exit(0)
}
console.log(`金标水平尺 ${GOLD_STANDARD_VERSION} · 轴 ${AXES.map((a) => a.id).join(' ')} · 阈 ratio≤${THRESHOLDS.ratioMax} 线≤${THRESHOLDS.lineMax} rtf≤${THRESHOLDS.rtfMax} 样本≥${THRESHOLDS.minSamples}`)
console.log('  ' + 'id'.padEnd(36) + AXES.map((a) => a.id.padEnd(3)).join('') + ' status            gap     margin  未测')
for (const r of rows) {
  console.log('  ' + String(r.id).padEnd(36) + AXES.map((a) => (SYM(r.axes[a.id]) + ' ').padEnd(3)).join('') + r.status.padEnd(17) + String(r.gap).padEnd(8) + String(r.margin).padEnd(8) + (r.unmeasured.join('/') || '—') + (r.mismatch ? '  ⚠ 与 goldCeiling 不一致' : '') + (r.drift && r.drift.length ? '  ⚠ 漂移' : ''))
  for (const a of AXES.filter((x) => r.axes[x.id].pass !== true)) {
    const x = r.axes[a.id]
    console.log(`      ${a.id} ${a.name}：value=${JSON.stringify(x.value)} gap=${x.gap} margin=${x.margin}${x.note ? '（' + x.note + '）' : ''} ⇒ 复算：${a.how}`)
  }
}
const gold = rows.filter((r) => r.status === 'gold'), prov = rows.filter((r) => r.status === 'provisional-gold')
console.log(`\n合计 ${rows.length}：gold ${gold.length} · provisional-gold ${prov.length} · not-gold ${rows.length - gold.length - prov.length}`)
console.log(`轴通过率：` + AXES.map((a) => `${a.id} ${rows.filter((r) => r.axes[a.id].pass).length}/${rows.length}`).join(' · '))
if (prov.length) console.log(`provisional（稿侧达标、凭据待补）：${prov.map((r) => r.id).join(', ')}`)
if (gold.length) console.log(`可当标尺（gold）：${gold.map((r) => r.id).join(', ')}`)
if (arg('--json') && arg('--json') !== 'stdout') fs.writeFileSync(path.resolve(arg('--json')), JSON.stringify(out, null, 2) + '\n')
if (arg('--md')) {
  const head = '| 位 | id | ' + AXES.map((a) => a.id).join(' | ') + ' | status | gap | margin |'
  const sep = '|---|---|' + AXES.map(() => ':-:').join('|') + '|---|---:|---:|'
  const body = rows.map((r) => `| ${r.where} | ${r.id} | ` + AXES.map((a) => SYM(r.axes[a.id])).join(' | ') + ` | ${r.status} | ${r.gap} | ${r.margin} |`)
  fs.writeFileSync(path.resolve(arg('--md')), [`# 金标水平尺读数（${GOLD_STANDARD_VERSION}）`, '', head, sep, ...body].join('\n') + '\n')
}
if (rows.some((r) => r.mismatch)) { console.log('⚠ 尺子与注册闸不一致：同一份稿两套裁判说了两句话 ⇒ 先修工具再谈金标'); process.exit(1) }
