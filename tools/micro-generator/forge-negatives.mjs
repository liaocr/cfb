#!/usr/bin/env node
// forge-negatives.mjs —— 受控负例：对每条锻造稿注入一种已知缺陷，验证尺子能把它照出来。
//
// 这一步回答的问题：尺子不是"只会说好话"——它在同一批正例上判 7/7 通过，
// 在注入缺陷后必须精确掉到对应轴上。每类注入只做可预测的最小改动（追加行 / 删行），
// 期望轴与实际触发轴都记录在案；触发多于一条轴也算数（耦合如实记录，不粉饰）。
//
// 用法：
//   node tools/micro-generator/forge-negatives.mjs \
//     --units <units.jsonl> [--units ...] \
//     --forge <forge-drafts-batch0.jsonl> [--forge ...] \
//     --out transfer/models/micro-generator-forge/forge-negatives.jsonl
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreBirthDraft } from './forge-birth-units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argAll = (name) => { const out = []; process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]) }) ; return out }
const unitsFiles = argAll('units'), forgeFiles = argAll('forge')
const outArg = process.argv.indexOf('--out') > 0 ? process.argv[process.argv.indexOf('--out') + 1] : null

const readJsonl = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const units = new Map()
for (const f of unitsFiles) for (const u of readJsonl(f)) units.set(u.unitId, u)
const drafts = new Map()
for (const f of forgeFiles) for (const r of readJsonl(f)) drafts.set(r.unitId, r.referenceDraft)

const AXES = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
/** 每类注入：名字、期望轴、对稿的变换（追加/删行） */
const CORRUPTIONS = [
  {
    id: 'baseline',
    expect: [],                      // 正对照：必须仍然 7/7
    apply: (d) => d,
    why: '未改动的正例（正对照）',
  },
  {
    id: 'fabricate-identifier',
    expect: ['M5'],
    apply: (d) => d + '\n另：`ReticulateCheckRegistry.scanAll()` 的调用点也要同步。',
    why: '追加一行含证据里不存在的标识符 ⇒ M5（无据标识符）',
  },
  {
    id: 'second-fix-line',
    expect: ['M8'],
    apply: (d) => d + '\n改法（备选）：把同样的处理也套到构造入口。',
    why: '追加第二条改法行 ⇒ M8（落点唯一：改法句 = 1）',
  },
  {
    id: 'menu-word',
    expect: ['M8'],
    apply: (d) => d + '\n或者也可以先回滚再重试。',
    why: '追加菜单词「或者也可以」 ⇒ M8（不许给两条路）',
  },
  {
    id: 'apparatus-talk',
    expect: ['M6'],
    apply: (d) => d + '\n注：沙箱白名单已内置该命令，无需再试探。',
    why: '追加装置话术 ⇒ M6（环境限制/白名单不是结论）',
  },
  {
    id: 'drop-acceptance',
    expect: ['M4'],
    apply: (d) => d.split('\n').filter((l) => !/^\s*验收[:：]/.test(l)).join('\n'),
    why: '删掉「验收：」行 ⇒ M4（窗内无可执行验收；若 M3 一并掉，属已知耦合）',
  },
  {
    id: 'double',
    expect: ['M5', 'M8'],
    apply: (d) => d + '\n另：`ReticulateCheckRegistry.scanAll()` 的调用点也要同步。\n或者也可以先回滚再重试。',
    why: '无据标识符 + 菜单词 ⇒ M5 与 M8（组合注入）',
  },
]

const out = []
for (const [unitId, draft] of drafts) {
  const unit = units.get(unitId)
  if (!unit) continue
  for (const c of CORRUPTIONS) {
    const text = c.apply(draft)
    const s = scoreBirthDraft(unit, text, { forge: { forgeNotes: `negative:${c.id}`, corruption: c.id } })
    const tripped = AXES.filter((id) => s.axes[id].pass === false)
    out.push({
      schema: 'cfb.birth-forge-negative/1',
      unitId, corruption: c.id, expectedAxes: c.expect, trippedAxes: tripped,
      targetCaught: c.expect.length ? c.expect.every((id) => tripped.includes(id)) : tripped.length === 0,
      status: s.status, draftChars: text.length,
      axes: Object.fromEntries(AXES.map((id) => [id, { pass: s.axes[id].pass, note: s.axes[id].note }])),
      why: c.why,
    })
  }
}

if (outArg) {
  const p = path.resolve(ROOT, outArg)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, out.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`wrote ${out.length} negative rows to ${path.relative(ROOT, p)}`)
}

console.log('\n注入 → 触发矩阵（n = 单元数）')
console.log('corruption'.padEnd(24) + '期望轴'.padEnd(12) + '被抓住  实际触发轴分布')
for (const c of CORRUPTIONS) {
  const rows = out.filter((r) => r.corruption === c.id)
  const caught = rows.filter((r) => r.targetCaught).length
  const dist = {}
  for (const r of rows) { const k = r.trippedAxes.join('+') || '（无）'; dist[k] = (dist[k] || 0) + 1 }
  console.log(c.id.padEnd(24) + (c.expect.join('+') || '（正对照）').padEnd(12) + `${caught}/${rows.length}`.padEnd(8) + JSON.stringify(dist))
}
const total = out.filter((r) => r.corruption !== 'baseline')
const caughtAll = total.filter((r) => r.targetCaught).length
console.log(`\n总体：${caughtAll}/${total.length} 注入被目标轴精确抓住；正对照 ${out.filter((r) => r.corruption === 'baseline' && r.targetCaught).length}/${out.filter((r) => r.corruption === 'baseline').length} 保持全过`)
