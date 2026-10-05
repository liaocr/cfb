/**
 * 金标写法研究（GOLD-STANDARD v1 的实证附录）——把「怎么改是好的」变成计数，不是感想。
 *   node tools/gold-study.mjs            # 打印 + 写 .cfb-offline/ruler/gold-standard-study.md
 * 两件事：
 *   1) 全体条目按 12 轴量一遍，逐特征做「过 / 不过」分组对比 ⇒ 每条写法约束都带一个可复算的判别力；
 *   2) 本轮改过的条目（transfer/gold-history/*_reharden.json 是改前，注册表是改后）逐条列轴翻转与字数增减 ⇒ 证明「哪一改 flipped 哪一轴」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { measureGold, strokeLineIndex, AXES, locateCell } from './helpers/gold-standard.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const walk = (d) => { const o = []; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) o.push(...walk(p)); else if (f.name.endsWith('.json')) o.push(p) } return o }
const lines = strokeLineIndex()

const feats = (d, raw, full = '') => {
  const outside = d.split('\n').map((l) => l.replace(/「[^」]*」/g, ''))
  const quotes = [...d.matchAll(/「([^」]+)」/g)].map((m) => m[1])
  const at = d.search(/验收|读数|即收工|看到/)
  const win = at < 0 ? '' : d.slice(at, at + 400)
  return {
    chars: d.length,
    rawShare: +(d.length / Math.max(1, raw.length)).toFixed(3),
    quoteN: quotes.length,
    quoteGrounded: quotes.filter((q) => (raw + '\n' + full).includes(q)).length,
    quoteShare: +(quotes.reduce((s, q) => s + q.length, 0) / Math.max(1, d.length)).toFixed(2),
    ticks: (d.match(/`[^`\n]+`/g) || []).length,
    narration: outside.filter((l) => /(^|\s)(?:Let me|Let's|Hmm,|Actually,|I should|I realize|I need to)\b/.test(l)).length,
    fixLines: outside.filter((l) => /(?:edit_file|str_replace|apply_patch|改法|改成|改为|改回|回滚|替换)|\b(?:Fix|the fix|proper fix|clean fix)\s*[:：]|\brevert\s+\w+\s+to\b/i.test(l) || /^(?:[-*]\s*)?(?:这条线只有一处|落点|改法|改一处)/.test(l.trim())).length,
    declaresUnique: /只有一处|只落一个|唯一/.test(d) ? 1 : 0,
    branches: (win.match(/⇒/g) || []).length,
    hasAcceptWord: /验收|复核|读数值|跑/.test(d) ? 1 : 0,
    cmdInWindow: (win.match(/`[^`\n]{3,60}`|--(?:last|steps|file)/g) || []).length,
    linesN: d.split('\n').filter((x) => x.trim()).length,
    banWords: (d.match(/不许|禁止|严禁|不要调用|不得再/g) || []).length,
    sandboxTalk: (d.match(/沙箱|权限|白名单|环境不支持/g) || []).length
  }
}

const items = []
for (const base of ['gold', 'gold-rejected']) for (const f of walk(path.join(ROOT, 'transfer', base))) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (!j?.id || !j.draft) continue
  const m = measureGold(j, { lineRow: lines[j.id] || null })
  const cell = locateCell(j.id)
  items.push({ where: base, id: j.id, item: j, m, f: feats(j.draft, String(j.raw || ''), String(cell?.ledger?.raw || '')), fails: AXES.filter((a) => m.axes[a.id].pass === false).map((a) => a.id) })
}

// ── 1) 特征 × 结果：对每个离散特征算「该组 12 轴全过率」与「主要缺项」
const buckets = {
  '逐字引用 0 条 vs ≥1 条': (x) => (x.f.quoteN === 0 ? '无引用' : '有引用'),
  '引用能否在真机全文里逐字找到': (x) => (x.f.quoteN > x.f.quoteGrounded ? '有找不到' : '全部逐字可核'),
  '裸引原文思考流行数': (x) => (x.f.narration === 0 ? '0 行' : '≥1 行'),
  '反引号片段数': (x) => (x.f.ticks <= 1 ? '≤1 处' : x.f.ticks <= 3 ? '2–3 处' : '≥4 处'),
  '改法句数': (x) => (x.f.fixLines === 1 ? '恰好 1 条' : x.f.fixLines === 0 ? '0 条' : '≥2 条'),
  '是否声明「只有一处」': (x) => (x.f.declaresUnique ? '声明了' : '没声明'),
  '验收窗内分支数': (x) => (x.f.branches >= 2 ? '≥2' : x.f.branches === 1 ? '1' : '0'),
  '装置话术词（沙箱/权限/白名单）': (x) => (x.f.sandboxTalk === 0 ? '无' : '有'),
  '禁工具/禁校验话术': (x) => (x.f.banWords === 0 ? '无' : '有'),
  '稿长分位': (x) => (x.f.chars <= 500 ? '≤500 字' : x.f.chars <= 1000 ? '501–1000' : '>1000 字'),
  '能否钉回真机台账': (x) => (x.m.axes.R1.pass ? '可逐字回放' : x.m.axes.R1.value === null ? '未测' : '回放不起'),
  '注册条目 raw 是否全文': (x) => (x.m.rawChars >= (x.m.trajRawChars || x.m.rawChars) ? '全文' : '截断'),
  '本轮是否被我改过稿': (x) => (arch0(x.id) ? '改过' : '原稿')
}
// 「改过稿」判据：有 _reharden 归档且归档稿与现注册稿不同
function arch0(id) { const H = path.join(ROOT, 'transfer', 'gold-history'); if (!fs.existsSync(H)) return null
  for (const fam of fs.readdirSync(H)) for (const f of fs.readdirSync(path.join(H, fam))) { if (!f.endsWith('_reharden.json') || !f.startsWith(id + '.')) continue
    const j = JSON.parse(fs.readFileSync(path.join(H, fam, f), 'utf8')); return j } return null }
const md = ['# 金标写法研究（GOLD-STANDARD v1 附录，全部由工具现算）', '', `样本 ${items.length} 条（在册 ${items.filter((x) => x.where === 'gold').length} + 隔离区 ${items.filter((x) => x.where === 'gold-rejected').length}）· 12 轴全过 ${items.filter((x) => x.m.pass).length} 条`, '', '## 1. 每条写法约束的判别力（按特征分组，看「12 轴全过率」）', '', '| 特征分组 | n | 全过 | 过率 | 最常缺的轴 |', '|---|---:|---:|---:|---|']
for (const [name, fn] of Object.entries(buckets)) {
  const groups = {}
  for (const x of items) { const k = fn(x); (groups[k] = groups[k] || []).push(x) }
  for (const [g, list] of Object.entries(groups)) {
    const passed = list.filter((x) => x.m.pass).length
    const tally = {}
    for (const x of list) for (const a of x.fails) tally[a] = (tally[a] || 0) + 1
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, c]) => `${a}×${c}`).join(' ') || '—'
    md.push(`| ${name}：${g} | ${list.length} | ${passed} | ${(100 * passed / Math.max(1, list.length)).toFixed(0)}% | ${top} |`)
  }
}

// ── 2) 本轮改稿的轴翻转（改前 = gold-history/*_reharden.json，改后 = 注册表）
md.push('', '## 2. 改前 → 改后：哪一改翻掉了哪一轴', '', '| id | 稿长 | 反引号 | 裸引行 | 改法句 | 窗内分支 | 翻转轴 |', '|---|---|---|---|---|---|---|')
const HIST = path.join(ROOT, 'transfer/gold-history')
const arch = {}
if (fs.existsSync(HIST)) for (const fam of fs.readdirSync(HIST)) for (const f of walk(path.join(HIST, fam))) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j?.id && j.draft && f.endsWith('_reharden.json')) (arch[j.id] = arch[j.id] || []).push(j) }
let pairs = 0
for (const x of items) {
  const before = (arch[x.id] || []).sort((a, b) => a.draft.length - b.draft.length)[0]
  if (!before) continue
  pairs++
  const fb = feats(before.draft, String(x.item.raw || ''), String(locateCell(x.id)?.ledger?.raw || ''))
  const mb = measureGold({ ...x.item, draft: before.draft }, { lineRow: lines[x.id] || null })
  const flipped = AXES.map((a) => ({ a: a.id, from: mb.axes[a.id].pass, to: x.m.axes[a.id].pass })).filter((r) => r.from !== r.to).map((r) => `${r.a} ${r.from ? '✓→✗' : '✗→✓'}`).join('、') || '（无轴翻转）'
  md.push(`| ${x.id} | ${fb.chars}→${x.f.chars} | ${fb.ticks}→${x.f.ticks} | ${fb.narration}→${x.f.narration} | ${fb.fixLines}→${x.f.fixLines} | ${fb.branches}→${x.f.branches} | ${flipped} |`)
}
md.push('', `配对样本 ${pairs} 条（改前稿留在 \`transfer/gold-history/\`，可逐字节 diff）。`, '')

// ── 3) 未过项的缺项分布（"还剩什么、为什么"）
const tally = {}
for (const x of items) for (const a of x.fails) tally[a] = (tally[a] || 0) + 1
md.push('## 3. 当前缺项分布', '', '| 轴 | 未过条数 |', '|---|---:|', ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([a, c]) => `| ${a} ${AXES.find((y) => y.id === a).name} | ${c} |`))
md.push('', '## 4. 逐条原始读数（可复核）', '', '| 位 | id | 稿长 | ratio | 线 | 引用 | 裸引 | 反引号 | 改法句 | 分支 | rtf | vsRaw | 缺项 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|')
for (const x of items) md.push(`| ${x.where} | ${x.id} | ${x.f.chars} | ${x.m.axes.M1.value} | ${x.m.axes.M2.value ?? '—'} | ${x.f.quoteN}/${x.f.quoteGrounded} | ${x.f.narration} | ${x.f.ticks} | ${x.f.fixLines} | ${x.f.branches} | ${x.m.axes.E1.value ?? '—'} | ${x.m.axes.E2.value} | ${x.fails.join(',') || '—'} |`)

fs.writeFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-standard-study.md'), md.join('\n') + '\n')
fs.writeFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-standard-study.json'), JSON.stringify({ schema: 'cfb.gold-study/1', at: new Date().toISOString(), rows: items.map((x) => ({ where: x.where, id: x.id, pass: x.m.pass, fails: x.fails, feats: x.f, axes: Object.fromEntries(AXES.map((a) => [a.id, { value: x.m.axes[a.id].value, pass: x.m.axes[a.id].pass, gap: x.m.axes[a.id].gap, note: x.m.axes[a.id].note }])) })) }, null, 2) + '\n')
console.log(md.join('\n'))
console.log('\n· 全文（含逐条原始读数）另存：.cfb-offline/ruler/gold-standard-study.md 与 .json')
