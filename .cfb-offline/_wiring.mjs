#!/usr/bin/env node
// 接线检查：短名单 -> 尺子，确认整条链是通的，且尺子对这个语料的形状判得对。
// 这一步不需要钱：用 draft := raw 这个「照抄稿」当输入，它必须被 G6 拦下。
import fs from 'node:fs'
import { judge, preflight } from '../tools/gen-ruler.mjs'
import { makeNegatives } from '../tools/gen-negatives.mjs'
const rows = fs.readFileSync('.cfb-offline/ruler/raw-mine-shortlist.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
console.log('短名单 ' + rows.length + ' 条')
let pfOk = 0, copyCaught = 0, otherGates = {}
for (const r of rows.slice(0, 200)) {
  const pf = preflight({ raw: r.raw, ctx: r.ctx })
  if (pf.ok) pfOk++
  const j = judge({ raw: r.raw, ctx: r.ctx, draft: r.raw })
  if (j.failed.includes('G6 not-copy')) copyCaught++
  for (const f of j.failed) if (f !== 'G6 not-copy') otherGates[f] = (otherGates[f] || 0) + 1
}
console.log('前 200 条：preflight 通过 ' + pfOk + '/200，draft:=raw 被 G6 拦下 ' + copyCaught + '/200')
console.log('  同时触发的其他门：' + JSON.stringify(otherGates))
console.log('  （照抄稿只该挂在 G6/G7；别的门也响说明那个门对这个语料形状过敏）')
// 负例生成器在这个语料形状上能不能跑（它需要一份稿；用 raw 的压缩近似代替不了，
// 这里只验它不崩且能产出，用来确认链条可接）
const sample = rows[0]
const negs = makeNegatives({ id: sample.unitId, raw: sample.raw, ctx: sample.ctx, draft: sample.raw })
console.log('\n  makeNegatives 在真实语料单元上产出 ' + negs.length + ' 条：' + negs.map((n) => n.axis).join(', '))
console.log('  （N2/N3/N4/N6 需要「好稿」当基座；这里基座是 raw 本身，所以能造出来的轴会变少 —— 这是正常的）')
