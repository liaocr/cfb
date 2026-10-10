#!/usr/bin/env node
// 用 L2 真读数给尺子做**精确**标定。
//
// 标签定义（这就是「不劣于原稿」的可操作化）：
//   同一条 (task, sample, 轮数) 上，raw 臂修好了而 hand 臂没修好
//     => 这份稿子**劣于原稿** => 尺子必须拒它。
//   hand 臂修好了
//     => 这份稿子至少不劣于原稿 => 尺子必须放它过（或至少不能全拒）。
// 这不是我编的判据，是仓库自己跑出来的 L2 读数，钱已经花过了。
import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'

const TRAJ = '.cfb-runtime/traj'
const res = [], hs = []
for (const d of fs.readdirSync(TRAJ, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  const rp = TRAJ + '/' + d.name + '/results.jsonl'
  if (fs.existsSync(rp)) for (const l of fs.readFileSync(rp, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.task && o.variant) res.push({ task: o.task, variant: o.variant, sample: o.sample, rounds: o.rounds, fixed: o.fixed, fixedAtRound: o.fixedAtRound, dir: d.name })
  }
  const hp = TRAJ + '/' + d.name + '/hand-samples.jsonl'
  if (fs.existsSync(hp)) for (const l of fs.readFileSync(hp, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.raw && o.draft) hs.push({ task: o.task, sample: o.sample, round: o.round, raw: o.raw, ctx: o.ctx, draft: o.draft, trainingEligible: o.trainingEligible, dir: d.name })
  }
}
const key = (r) => r.task + '|' + r.sample + '|' + (r.rounds != null ? r.rounds : r.round)
const rawFix = new Map()
for (const r of res) if (r.variant === 'raw' && r.fixed === true) rawFix.set(key(r), true)
const handFix = new Map(), handFail = new Map()
for (const r of res) if (r.variant === 'hand') {
  if (r.fixed === true) handFix.set(key(r), true)
  if (r.fixed === false) handFail.set(key(r), true)
}
const rows = []
for (const h of hs) {
  const k = key(h)
  let expect = null, why = ''
  if (handFix.get(k)) { expect = 'pass'; why = 'hand 臂修好了' }
  else if (handFail.get(k) && rawFix.get(k)) { expect = 'reject'; why = 'raw 修好了而 hand 没修好' }
  if (!expect) continue
  const j = judge({ raw: h.raw, ctx: h.ctx, draft: h.draft })
  rows.push({ k, expect, why, got: j.pass ? 'pass' : 'reject', score: j.score, failed: j.failed, id: h.task + '-s' + h.sample + '-r' + h.round, te: h.trainingEligible, dir: h.dir })
}
console.log('=== 尺子 vs L2 真读数（精确对齐 task|sample|轮数）===')
for (const r of rows.sort((a, b) => (a.expect + a.k).localeCompare(b.expect + b.k))) {
  const ok = r.expect === r.got
  console.log((ok ? '  一致 ' : '✗ 不一致') + '  ' + r.id.padEnd(34) + ' expect=' + r.expect.padEnd(7) + ' ruler=' + r.got.padEnd(7) + ' score=' + String(r.score).padEnd(7) + ' te=' + String(r.te).padEnd(6) + ' [' + r.why + ']' + (r.failed.length ? ' ' + r.failed.join(',') : ''))
}
const tp = rows.filter((r) => r.expect === 'pass' && r.got === 'pass').length
const fn = rows.filter((r) => r.expect === 'pass' && r.got === 'reject').length
const tn = rows.filter((r) => r.expect === 'reject' && r.got === 'reject').length
const fp = rows.filter((r) => r.expect === 'reject' && r.got === 'pass').length
console.log('\nn=' + rows.length + ' | 该放过的放过了(TP)=' + tp + ' 该放过的被误拒(FN)=' + fn + ' | 该拒的拒了(TN)=' + tn + ' 该拒的漏放(FP)=' + fp)
console.log('一致率 = ' + (rows.length ? (((tp + tn) / rows.length) * 100).toFixed(1) : 0) + '%')
