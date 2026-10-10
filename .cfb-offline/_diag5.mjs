#!/usr/bin/env node
import fs from 'node:fs'
import { judge, causePairs, norm } from '../tools/gen-ruler.mjs'
import { makeNegatives } from '../tools/gen-negatives.mjs'
const REVERSE_RX = /\u800c\u4e0d\u662f|\u5e76\u975e|\u4e0d\u662f.{0,8}\u800c\u662f|\u53cd\u8fc7\u6765|\u53cd\u4e4b|\u800c\u975e|not because|rather than|\u4e0d\u5e94\u8be5.{0,6}\u800c\u5e94\u8be5/
const rows = fs.readFileSync('.cfb-offline/ruler/pairs-hand.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
let n = 0
for (const o of rows) {
  if (n >= 3) break
  const pos = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  if (!pos.pass) continue
  for (const neg of makeNegatives(o)) {
    if (neg.axis !== 'N4-invert') continue
    const r = judge({ raw: o.raw, ctx: o.ctx, draft: neg.draft })
    if (r.failed.length) continue
    n++
    const rp = new Set(causePairs(o.raw)), dp = causePairs(neg.draft)
    console.log('='.repeat(70))
    console.log(o.id, '|', neg.mutation)
    console.log('  rawPairs:', JSON.stringify([...rp]).slice(0, 400))
    console.log('  draftPairs:', JSON.stringify(dp).slice(0, 400))
    console.log('  reverseMarkerInDraft:', REVERSE_RX.test(neg.draft), ' norm(raw).len', norm(o.raw).length)
    console.log('  tail:', JSON.stringify(neg.draft.slice(-90)))
    break
  }
}
// --- L2 精确对齐：把 hand-samples 的 (task,sample,round) 接到 results.jsonl 的 hand 臂 ---
console.log('\n' + '='.repeat(70))
console.log('L2 精确对齐探针')
const res = []
for (const f of fs.readdirSync('.cfb-runtime/traj', { withFileTypes: true })) {
  if (!f.isDirectory()) continue
  const p = '.cfb-runtime/traj/' + f.name + '/results.jsonl'
  if (!fs.existsSync(p)) continue
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.task && o.variant) res.push({ task: o.task, variant: o.variant, sample: o.sample, rounds: o.rounds, fixed: o.fixed, fixedAtRound: o.fixedAtRound })
  }
}
console.log('results rows:', res.length)
console.log('hand 臂样本字段:', JSON.stringify(res.filter((r) => r.variant === 'hand').slice(0, 4)))
const hs = []
for (const f of fs.readdirSync('.cfb-runtime/traj', { withFileTypes: true })) {
  if (!f.isDirectory()) continue
  const p = '.cfb-runtime/traj/' + f.name + '/hand-samples.jsonl'
  if (!fs.existsSync(p)) continue
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    hs.push({ id: o.id, task: o.task, sample: o.sample, round: o.round, trainingEligible: o.trainingEligible })
  }
}
console.log('hand-samples 字段:', JSON.stringify(hs.slice(0, 4)))
