// 校准与评估（$0，无 API）。输出 results.json、teacher-pass-ids.jsonl。
// 规则（事先固定，见 README.md）：
//   1) 阈值 TAU=0.8 固定，不随结果调整；下面的 τ 曲线只报告，不用来选 τ。
//   2) dev = 教师 v4-full 中 raw>=3100 的行（只读；无结局标签，只校准"能否区分匹配/错配"）。
//   3) 负对照：把每条 draft 与另一条随机行的 raw+ctx 配对（固定种子）。
//   4) 通过率下限：匹配稿在 dev 上的通过率 >= 0.5，否则尺子被淘汰（"什么都不过"的尺子不要）。
//   5) gold 只作为测试集，只报告，不参与任何选择。
import fs from 'node:fs'
import path from 'node:path'
import { ruler, TAU, MIN_RAW } from './ruler-v2.mjs'

const ROOT = '/home/user/cfb'
const OUT = path.join(ROOT, 'transfer/ruler-v2')
const FLOOR = 0.5

// ---- 确定性随机 ----
let seed = 20261011
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

// ---- dev：教师 v4-full（只读）----
const teacher = fs.readFileSync(path.join(ROOT, '.cfb-offline/teacher/v4-full.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const dev = teacher.filter((r) => (r.raw || '').length >= MIN_RAW && r.draft)
const n = dev.length
const perm = dev.map((_, i) => { let j; do { j = Math.floor(rnd() * n) } while (j === i); return j })

const matched = dev.map((r) => ruler(r))
const mismatched = dev.map((r, i) => ruler({ raw: dev[perm[i]].raw, ctx: dev[perm[i]].ctx, draft: r.draft }))
const rate = (arr, k) => arr.filter((x) => x[k]).length / arr.length
const pm = rate(matched, 'pass'), pn = rate(mismatched, 'pass')
const gates = (arr) => ({ R1: +rate(arr, 'R1').toFixed(3), G2: +rate(arr, 'G2').toFixed(3), G3: +rate(arr, 'G3').toFixed(3), pass: +rate(arr, 'pass').toFixed(3) })

// τ 曲线：仅报告
const curve = [0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
  const m = dev.map((r) => ruler(r, { tau: t })), x = dev.map((r, i) => ruler({ raw: dev[perm[i]].raw, ctx: dev[perm[i]].ctx, draft: r.draft }, { tau: t }))
  return { tau: t, matchedPass: +rate(m, 'pass').toFixed(3), mismatchedPass: +rate(x, 'pass').toFixed(3) }
})

// ---- gold 测试集（只报告）----
const goldFiles = []
;(function w(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? w(p) : f.endsWith('.json') && goldFiles.push(p) } })(path.join(ROOT, 'transfer/gold'))
const gold = goldFiles.map((f) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  const r = ruler({ raw: j.raw || '', ctx: j.ctx || '', draft: j.draft || '' })
  return { id: j.id, goldStatus: j.goldStandard?.status || '?', vsRaw: j.outcome?.vsRaw || '?', ...r }
})

// ---- 淘汰判定 ----
const floorOk = pm >= FLOOR
const verdict = floorOk ? (pm - pn > 0.2 ? 'candidate (dev floor 通过；区分度 > 0.2)' : 'weak separation') : 'excluded: 匹配稿通过率低于下限'

// ---- D6：教师 dev 池上的只读过滤，输出新文件（不改 teacher）----
const passIds = dev.map((r, i) => ({ id: r.id, pass: matched[i].pass, R1: matched[i].R1, G2: matched[i].G2, G3: matched[i].G3, recall: matched[i].recall, ratio: matched[i].ratio })).filter((x) => x.pass)
fs.writeFileSync(path.join(OUT, 'EXCLUDED-ruler-pass-ids.jsonl'), passIds.map((x) => JSON.stringify(x)).join('\n') + '\n')

const result = {
  schema: 'cfb.ruler-v2/calibration/1',
  date: '2026-10-11',
  tau: TAU, ratioMax: 0.5, tail: 300, minRaw: MIN_RAW, floor: FLOOR,
  dev: { source: '.cfb-offline/teacher/v4-full.jsonl (read-only, no outcome labels)', n, matched: gates(matched), mismatched: gates(mismatched), matchedPass: +pm.toFixed(3), mismatchedPass: +pn.toFixed(3), separation: +(pm - pn).toFixed(3) },
  tauCurveReportOnly: curve,
  verdict,
  gold: { n: gold.length, applicable: gold.filter((g) => g.applies).length, rows: gold },
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ dev: result.dev, verdict, goldApplicable: result.gold.applicable, goldPass: gold.filter((g) => g.pass).length, teacherPass: passIds.length }, null, 2))
console.log('tau curve', JSON.stringify(curve))
