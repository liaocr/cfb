#!/usr/bin/env node
// tools/coverage-plan.mjs —— 扩量覆盖矩阵的对账器（零 API，见 docs/GOLD-EXPANSION-PROGRAM.md §3）
//
// 它只回答两个问题：格子还差几条、下一批该跑什么命令。
//   口径 = 5 家族 × (早 ≤r2 / 中 r3–5 / 晚 ≥r6) × (<2k / 2–5k / >5k) = 30 格，目标 40 条。
//   计数来源有两处，用途不同绝不混算：
//     transfer/gold（use=ruler）→ 标尺侧，能进矩阵；
//     traj hand-samples（trainingEligible + clean）→ 训练料侧，只报「已有素材」，不计入矩阵（否则等于拿训练料给自己打分）。
// 刻意不写 history、不占 t 号：预注册计划必须由 plan-traj 自己算 design digest，这里只出命令。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGold, goldUse } from './helpers/three-mode.mjs'
import { loadTrajTrainingSamples, rulerIdSet } from './helpers/traj-corpus.mjs'
import { TRAJ_TASKS } from './traj-fixtures.mjs'
import { evidenceDigest } from '../src/evidence-program.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const argOut = (() => { const i = argv.indexOf('--out'); return i >= 0 ? path.resolve(ROOT, argv[i + 1]) : path.join(ROOT, 'transfer', 'gold-repair', 'gold-coverage') })()
const asJson = argv.includes('--json')

// 每家族目标条数（文档 §3 表格）：已有底子薄的两个家族在晚轮 / 长文上多要一条
const TARGETS = { 'sse-truncated': 8, 'eacces-config': 8, 'wrong-model': 8, 'flaky-timeout': 8, 'perf-regression': 8 }
const BANDS = [['early', (r) => r <= 2], ['mid', (r) => r >= 3 && r <= 5], ['late', (r) => r >= 6]]
const LENS = [['<2k', (c) => c < 2000], ['2–5k', (c) => c >= 2000 && c <= 5000], ['>5k', (c) => c > 5000]]
// 每档目标取自 docs/GOLD-EXPANSION-PROGRAM.md §3 的表格：轮位 3 档与长度 3 档是**同一批条目的两种投影**（各加总 = 8），不是交叉相乘
const TARGET_CELLS = {
  'sse-truncated': { early: 1, mid: 2, late: 1, '<2k': 1, '2–5k': 2, '>5k': 1 },
  'eacces-config': { early: 1, mid: 2, late: 1, '<2k': 1, '2–5k': 2, '>5k': 1 },
  'wrong-model': { early: 1, mid: 2, late: 1, '<2k': 1, '2–5k': 2, '>5k': 1 },
  'flaky-timeout': { early: 1, mid: 2, late: 2, '<2k': 1, '2–5k': 2, '>5k': 2 },
  'perf-regression': { early: 1, mid: 2, late: 2, '<2k': 1, '2–5k': 2, '>5k': 2 },
}
const roundOf = (g) => Number(String(g.id).match(/-r(\d+)$/)?.[1] ?? g.round ?? 0) || 0
const famOf = (g) => String(g.family || '').replace(/^pool:/, '').split(':')[0].replace(/_(?:decoy|long-horizon).*$/, '')

const gold = loadGold(path.join(ROOT, 'transfer', 'gold'))
const ruler = gold.filter((g) => goldUse(g) !== 'train')
const trainScoped = gold.filter((g) => goldUse(g) === 'train')
const traj = loadTrajTrainingSamples({ root: ROOT, rulerIds: rulerIdSet(gold) })

const cells = []
for (const task of TRAJ_TASKS) {
  const fam = task.id
  const famItems = ruler.filter((g) => famOf(g) === fam)
  // 轮位轴按「该条目起草于第几轮」，长度轴按「原文规模」—— 同一批条目在两根轴上各归一次类，不是交叉相乘
  const axes = [...BANDS.map(([name, ok]) => ({ axis: '轮位', name, of: (g) => ok(roundOf(g)) })),
    ...LENS.map(([name, ok]) => ({ axis: '长度', name, of: (g) => ok(String(g.raw || '').length) }))]
  for (const ax of axes) {
    const hits = famItems.filter(ax.of)
    cells.push({ family: fam, axis: ax.axis, cell: ax.name, have: hits.length, target: (TARGET_CELLS[fam] || {})[ax.name] ?? 0, ids: hits.map((g) => g.id) })
  }
}
const perFam = TRAJ_TASKS.map((t) => {
  const fam = t.id
  const have = ruler.filter((g) => famOf(g) === fam)
  const byBand = Object.fromEntries(BANDS.map(([b, ok]) => [b, have.filter((g) => ok(roundOf(g))).length]))
  const byLen = Object.fromEntries(LENS.map(([l, ok]) => [l, have.filter((g) => ok(String(g.raw || '').length)).length]))
  return { family: fam, have: have.length, target: TARGETS[fam] || 8, gap: Math.max(0, (TARGETS[fam] || 8) - have.length), byBand, byLen, split: have.map((g) => g.split) }
})
const totalGap = perFam.reduce((a, x) => a + x.gap, 0)
const bandOfGap = (fam) => { const row = perFam.find((x) => x.family === fam); const b = BANDS.map(([n]) => n).sort((a, b) => row.byBand[a] - row.byBand[b])[0]; return b }
const lenOfGap = (fam) => { const row = perFam.find((x) => x.family === fam); const l = LENS.map(([n]) => n).sort((a, b) => row.byLen[a] - row.byLen[b])[0]; return l }
// 每家族下一批：优先填该家族最空的轮位档；长度档按「晚轮长文更容易过 G2」的经验给门槛
const minRawFor = { early: 800, mid: 2000, late: 5000 }
const commands = perFam.filter((r) => r.gap > 0).map((r) => {
  const band = bandOfGap(r.family)
  return `node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios ${r.family} --samples 1 --round-band ${band} --min-raw-chars ${minRawFor[band]} --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：${r.family} 缺口 ${r.gap} 条（当前档 ${band}/${lenOfGap(r.family)}）"`
})

// 指纹而非时间戳：输入不变 ⇒ 文件字节不变，仓库不产生「只是跑了一次」的假漂移
const fingerprint = evidenceDigest([ruler.map((g) => `${g.id}@${g.use || 'ruler'}`).join(','), traj.samples.map((g) => `${g.id}@${g.at || ''}`).join(',')]).slice(0, 16)
const report = { schema: 'cfb.gold-coverage/1', fingerprint, cells: cells.length, target: Object.values(TARGETS).reduce((a, b) => a + b, 0),
  rulerItems: ruler.length, trainScopedItems: trainScoped.length, trajTrainDocs: traj.samples.length, trajSkippedAsRuler: traj.stats.asRuler,
  perFamily: perFam, gap: totalGap, commands }
fs.mkdirSync(argOut, { recursive: true })
fs.writeFileSync(path.join(argOut, 'matrix.json'), JSON.stringify(report, null, 2) + '\n')
if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }

const md = []
md.push('# 金标扩量覆盖矩阵（对账）\n')
md.push(`> 由 \`node tools/coverage-plan.mjs\` 生成，零 API（输入指纹 ${fingerprint}）。格 = 5 家族 ×（3 轮位档 + 3 长度档）= ${cells.length}；两根轴是同一批条目的两种投影（各加总 = 目标 ${report.target} 条），不是交叉相乘。\n`)
md.push('### 每格明细（先投影表、再逐格，缺哪格一目了然）\n')
md.push('| 家族 | 轴 | 档 | 已有 | 目标 | 差额 | 用了哪几条 |')
md.push('|---|---|---|---|---|---|---|')
for (const c of cells) md.push(`| \`${c.family}\` | ${c.axis} | ${c.cell} | ${c.have} | ${c.target} | ${c.have >= c.target ? '✓ 满' : '**差 ' + (c.target - c.have) + '**'} | ${c.ids.length ? c.ids.join('、') : '—'} |`)
md.push('')
md.push(`标尺侧 ${report.rulerItems} 条（use=ruler）· 已放行成训练料的注册表条目 ${report.trainScopedItems} 条 · traj 训练料 ${report.trajTrainDocs} 条（另有 ${report.trajSkippedAsRuler} 条因命中已入册标尺被剔除，不计入本表）\n`)
md.push('| 家族 | 已有 | 目标 | 缺口 | 早≤r2 | 中r3–5 | 晚≥r6 | <2k | 2–5k | >5k |')
md.push('|---|---|---|---|---|---|---|---|---|---|')
for (const r of perFam) md.push(`| \`${r.family}\` | ${r.have} | ${r.target} | **${r.gap}** | ${r.byBand.early} | ${r.byBand.mid} | ${r.byBand.late} | ${r.byLen['<2k']} | ${r.byLen['2–5k']} | ${r.byLen['>5k']} |`)
md.push(`| **合计** | ${report.rulerItems} | ${report.target} | **${totalGap}** | | | | | | |\n`)
md.push('## 下一批（预注册命令，$0 出稿前不花钱）\n')
md.push('命令里不含 `--force`，跑之前自己核对是否已有同设计未执行的计划：\n')
md.push('```sh')
for (const c of commands) md.push(c)
md.push('```\n')
md.push('说明：`--round-band` / `--min-raw-chars` 只决定**挑哪一轮、要多长的原文**，不参与判定、不改闸值（实现见 `tools/cfb-cycle.mjs` cmdPlanTraj）。\n')
fs.writeFileSync(path.join(argOut, 'matrix.md'), md.join('\n'))
console.log(md.slice(2).join('\n'))
console.log(`\n写入 ${path.relative(ROOT, argOut)}/matrix.{md,json}`)
