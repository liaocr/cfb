/**
 * 给金标条目盖章（GOLD-STANDARD v1 的结论落进注册表）——把「尺子说过没过」变成下游能读的字段。
 *   node tools/gold-attest.mjs                      # 两条池盖章（gold + gold-rejected）
 *   node tools/gold-attest.mjs --check              # 只报「没盖章 / 章过期」，不写盘（CI 用）
 *   node tools/gold-attest.mjs --dirs=gold --id x --dry
 * 为什么要有这一步：`gold-score` 的读数只在命令行里，工具链（plan-bench / cfb-judge / 训练料导出）读的是条目。
 * 不盖章的话，它们只能继续看 `use` 字段和注册当时的 `ceiling.ok` —— 那两个都会随改稿过期。
 * 安全边界（三条）：
 *   1) 只加/换 `goldStandard` 这一个键，绝不碰 `draft`/`raw`/`ctx` ⇒ `digest` 不变，历史基准不作废；
 *   2) 章里钉 `stampDigest`（盖章当时那份稿的 digest）⇒ 稿一改，章自动算过期（--check 会红），分数不许跟着稿子飘；
 *   3) 盖章只能降级：not-gold 的条目会从标尺侧（goldRulerOk）掉到训练侧（goldTrainOk），数据一条不删。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadGold, goldDigest, goldUse, goldRulerOk, goldTrainOk } from './helpers/three-mode.mjs'
import { measureGold, strokeLineIndex, AXES, GOLD_STANDARD_VERSION, THRESHOLDS } from './helpers/gold-standard.mjs'

const ROOT = process.env.CFB_ROOT ? path.resolve(process.env.CFB_ROOT) : path.resolve(import.meta.dirname, '..')   // 自测用 CFB_ROOT 指到临时根，绝不动真注册表
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ((process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1) || d) }
const DRY = process.argv.includes('--dry')
const CHECK = process.argv.includes('--check')
const onlyId = arg('--id', null)
const lineIdx = strokeLineIndex()

const rows = [], stale = [], missing = []
const all = []          // 内存里先备好「盖完章的那份」⇒ DRY/--check 也能算出前后差，不靠写完再读
let before = { ruler: 0, train: 0 }
for (const base of String(arg('--dirs', 'gold,gold-rejected')).split(',')) {
  const dir = path.join(ROOT, 'transfer', base.trim())
  for (const g of loadGold(dir)) {
    before.ruler += goldRulerOk(g) ? 1 : 0; before.train += goldTrainOk(g) && !g.missing ? 1 : 0
    all.push(g)
    if (onlyId && g.id !== onlyId) continue
    if (!g.draft) { missing.push({ where: base.trim(), id: g.id, why: '无 draft' }); continue }
    const m = measureGold(g, { lineRow: lineIdx[g.id] || null })
    const prev = g.goldStandard || null
    if (prev && prev.stampDigest !== g.digest) stale.push({ where: base.trim(), id: g.id, why: '稿已变 ⇒ 章过期（须真机重测）' })
    else if (prev && prev.version !== GOLD_STANDARD_VERSION) stale.push({ where: base.trim(), id: g.id, why: `标准升版 ${prev.version} → ${GOLD_STANDARD_VERSION}` })
    else if (!prev) missing.push({ where: base.trim(), id: g.id, why: '未盖章' })
    const stamp = {
      schema: 'cfb.gold-standard/1', version: GOLD_STANDARD_VERSION, at: new Date().toISOString(),
      status: m.status, gap: m.gap, margin: m.margin, unmeasured: m.unmeasured, drift: m.drift || [],
      home: m.provenance || null, draftChars: m.draftChars, baseRawChars: m.baseRawChars ?? null,
      thresholds: THRESHOLDS, stampDigest: g.digest,
      axes: Object.fromEntries(AXES.map((a) => [a.id, m.axes[a.id].pass === null ? null : { v: m.axes[a.id].value, ok: !!m.axes[a.id].pass }]))
    }
    rows.push({ where: base.trim(), id: g.id, from: prev?.status || null, to: stamp.status, gap: stamp.gap, margin: stamp.margin, unmeasured: stamp.unmeasured, drift: stamp.drift, file: g.file })
    g.goldStandard = stamp
    if (CHECK || DRY) continue
    const raw = JSON.parse(fs.readFileSync(g.file, 'utf8'))
    const next = {}
    for (const k of Object.keys(raw)) if (k !== 'goldStandard') next[k] = raw[k]
    next.goldStandard = stamp
    fs.writeFileSync(g.file, JSON.stringify(next, null, 2) + '\n')
  }
}
const after = { ruler: 0, train: 0 }
for (const g of all) { after.ruler += goldRulerOk(g) ? 1 : 0; after.train += goldTrainOk(g) ? 1 : 0 }
const by = (s) => rows.filter((r) => r.to === s).map((r) => r.id)
const flips = rows.filter((r) => r.from && r.from !== r.to)
const lines = [
  `金标盖章 ${GOLD_STANDARD_VERSION} · ${CHECK ? '只查不写' : DRY ? 'DRY' : '已写回'} · 处理 ${rows.length} 条`,
  `  状态：gold ${by('gold').length} · provisional ${by('provisional-gold').length} · not-gold ${by('not-gold').length}`,
  `  标尺侧（goldRulerOk）${before.ruler} → ${after.ruler} · 训练侧（goldTrainOk）${before.train} → ${after.train}（降级不删数据）`,
  `  待盖章 ${missing.length} 条 · 过期 ${stale.length} 条`,
  ...(flips.length ? ['  状态翻转：', ...flips.map((r) => `    ${r.where}/${r.id}：${r.from} → ${r.to}`)] : []),
  ...(stale.length ? ['  过期明细：', ...stale.map((r) => `    ${r.where}/${r.id}：${r.why}`)] : []),
  ...(CHECK ? [`  ⇒ --check 结论：${stale.length + missing.length === 0 ? '全部盖章且新鲜' : `有 ${stale.length + missing.length} 条需重盖章（node tools/gold-attest.mjs）`}`] : []),
  `  可当判分标尺：${after.ruler} 条${after.ruler ? '（' + by('gold').join(', ') + '）' : ''}`
]
console.log(lines.join('\n'))
if (!CHECK && !DRY) {
  fs.mkdirSync(path.join(ROOT, '.cfb-offline/ruler'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-attest.json'), JSON.stringify({ schema: 'cfb.gold-attest/1', version: GOLD_STANDARD_VERSION, at: new Date().toISOString(), before, after, rows, stale, missing }, null, 2) + '\n')
}
if (CHECK && stale.length + missing.length > 0) process.exit(1)
