#!/usr/bin/env node
// tools/rwkv7-report.mjs —— 把 RWKV7 推理产物转成 effect-eval 认的 report 格式
//
// 为什么需要这一步：effect-eval 的变体来自「生产压缩器跑出来的 report.json」，
// 而 RWKV7 的产物是另一套形状（drafts.jsonl）。两边字段名不同，直接喂进去不会报错，
// 只会让 buildVariants 一条都匹配不上、然后**静默地什么都不测**。
//
// report 格式（照 effect-eval.mjs:301 与 buildVariants 的实际读法）：
//   { rows: [ { id, mode, why, text } ] }
//   且 why 必须以 "condensed" 开头、text 非空，否则该行被跳过（同样是静默的）。
//
// 用法：
//   node tools/rwkv7-report.mjs --drafts drafts.jsonl --out rwkv7.json [--mode rwkv7]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge } from './gen-ruler.mjs'
import { guardDraft } from './g1-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const DRAFTS = arg('--drafts')
if (!DRAFTS) { console.log('用法: node tools/rwkv7-report.mjs --drafts <drafts.jsonl> --out <report.json>'); process.exit(2) }
const MODE = arg('--mode', 'rwkv7')
const OUT = path.resolve(ROOT, arg('--out', '.cfb-offline/effect/rwkv7.json'))
const PAIRS = path.resolve(ROOT, arg('--pairs', 'deploy/kaggle/data/effect-pairs.jsonl'))

const rd = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

const drafts = rd(path.resolve(ROOT, DRAFTS))
const pairs = new Map(rd(PAIRS).map((r) => [r.id, r]))

const rows = []
console.log('id'.padEnd(18) + '字数'.padEnd(8) + 'token'.padEnd(8) + '截断'.padEnd(7) + '闸门'.padEnd(8) + '软分'.padEnd(8) + '教师软分')
let miss = 0
for (const d of drafts) {
  const p = pairs.get(d.id)
  if (!p) { console.log('! ' + d.id + ' 不在 pairs 里，跳过'); miss++; continue }
  const text = String(d.draft || '').trim()
  // 生产口径的确定性闸门。**只记录，不改 text** —— 这一轮要量的是「模型自己产出的东西」，
  // 闸门+回退的效果是另一个实验（回退后变体≈raw，会把对比稀释成 raw vs raw）。
  const g = guardDraft(p.raw, p.ctx, text, { mode: 'strip' })
  const j = judge({ raw: p.raw, ctx: p.ctx, draft: g.draft })
  const jt = judge({ raw: p.raw, ctx: p.ctx, draft: '' })
  rows.push({
    id: d.id, mode: MODE, why: text ? 'condensed' : 'empty-output',
    text, draftChars: text.length, newTokens: d.newTokens ?? null,
    truncated: !!d.truncated, promptTokens: d.promptTokens ?? null, seconds: d.seconds ?? null,
    guardPass: j.gaugeable ? !!j.pass : null, soft: j.gaugeable ? j.score : null,
    guardChanged: g.draft !== text,
  })
  console.log(String(d.id).padEnd(18) + String(text.length).padEnd(8) + String(d.newTokens ?? '-').padEnd(8) +
    String(d.truncated ? '是' : '否').padEnd(7) +
    (j.gaugeable ? (j.pass ? '过' : '不过') : '不可测').padEnd(8) +
    (j.gaugeable ? j.score.toFixed(3) : '-').padEnd(8) + (jt.gaugeable ? jt.score.toFixed(3) : '-'))
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ rows }, null, 1))
console.log('')
console.log('写出 ' + path.relative(ROOT, OUT) + ' · ' + rows.length + ' 行' + (miss ? '（缺 ' + miss + '）' : ''))
const pass = rows.filter((r) => r.guardPass).length
console.log('闸门过 ' + pass + '/' + rows.length + ' · 被闸门改过的 ' + rows.filter((r) => r.guardChanged).length + ' 条')
console.log('撞 --max-new 被截断的 ' + rows.filter((r) => r.truncated).length + ' 条')
