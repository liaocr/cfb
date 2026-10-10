#!/usr/bin/env node
// tools/eval-sft.mjs —— 学生（RWKV7 微模型）vs 教师（DeepSeek-V4-Flash）配对评测
//
// 为什么必须配对：训练集是按尺子过滤过的，但 **dev 集没有过滤**
// （见 build-sft.mjs 设计决定四）。所以 dev 上的"教师通过率"不是 100%，
// 而是一个真实基线。学生分数只有跟**同一批单元上的教师分数**比才有意义 ——
// 单看"学生过了 40%"什么也说明不了，因为可能这 40% 全是教师也过的简单单元。
//
// 输入：
//   --sft  <dir>    build-sft.mjs 的产出目录（读 dev.jsonl，assistant 即教师稿）
//   --gen  <file>   训练器产出的 dev-generations.jsonl，每行 {id, raw, ctx, draft}
// 输出：
//   控制台对照表 + <gen 同目录>/eval-sft.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge, RULER_VERSION } from './gen-ruler.mjs'
import { estimateTokens } from '../src/tokens.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const SFT = path.resolve(ROOT, arg('--sft', '.cfb-offline/sft'))
const GEN = arg('--gen')
if (!GEN) { console.log('用法: node tools/eval-sft.mjs --gen <dev-generations.jsonl> [--sft <dir>]'); process.exit(2) }
const GENP = path.resolve(ROOT, GEN)
const OUT = path.resolve(ROOT, arg('--out', path.join(path.dirname(GENP), 'eval-sft.json')))

// user 字段是 build-sft.mjs 用这一行拼出来的，所以这里必须用同一个标记切回去。
// 标记写错不会报错，只会让 ctx/raw 静默互换，然后所有指标一起错。
const MARK = '\n\n[思考过程]\n'

const rd = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

const dev = rd(path.join(SFT, 'dev.jsonl'))
const gen = rd(GENP)

const teacher = new Map()
for (const r of dev) {
  const i = r.user.indexOf(MARK)
  if (i < 0) { console.error('FATAL: dev.jsonl 里有行不含 [思考过程] 标记，格式对不上'); process.exit(1) }
  teacher.set(r.id, { ctx: r.user.slice('[题面]\n'.length, i), raw: r.user.slice(i + MARK.length), draft: r.assistant })
}

const rows = []
let missing = 0, empty = 0
for (const g of gen) {
  const t = teacher.get(g.id)
  if (!t) { missing++; continue }
  const sd = String(g.draft || '').trim()
  if (!sd) empty++
  // 用生成文件自带的 raw/ctx 重跑尺子：训练器是从 dev.jsonl 渲染出来的，
  // 但两边的 raw/ctx 必须一致，不一致就说明 dev.jsonl 换了而生成文件是旧的。
  if (g.raw !== undefined && g.raw !== t.raw) {
    console.error('FATAL: ' + g.id + ' 的 raw 与 dev.jsonl 不一致 —— 生成文件与数据集不是同一版'); process.exit(1)
  }
  const tj = judge({ raw: t.raw, ctx: t.ctx, draft: t.draft })
  const sj = judge({ raw: t.raw, ctx: t.ctx, draft: sd })
  rows.push({
    id: g.id, teacherPass: tj.pass, studentPass: sj.pass,
    teacherFailed: tj.failed, studentFailed: sj.failed,
    teacherScore: tj.score, studentScore: sj.score,
    teacherRatio: tj.detail.compression.ratio, studentRatio: sj.detail.compression.ratio,
    teacherChars: t.draft.length, studentChars: sd.length,
    studentTok: estimateTokens(sd), teacherTok: estimateTokens(t.draft),
    studentDraft: sd,
  })
}

// 有受力点的子集：G0 是**与稿子无关**的门（raw/ctx 本身没有可承重的东西），
// 它对教师和学生一视同仁，留在分母里只会同时压低两边、把对比稀释掉。
// 所以两个数都给：全体（G0 算失败，保守）和有受力点子集（G0 剔除，才是真正的对比）。
const scoreable = rows.filter((r) => !r.teacherFailed.includes('G0 no-leverage'))
const n = rows.length
const tPass = rows.filter((r) => r.teacherPass).length
const sPass = rows.filter((r) => r.studentPass).length
const sn = scoreable.length
const stPass = scoreable.filter((r) => r.teacherPass).length
const ssPass = scoreable.filter((r) => r.studentPass).length
const both = rows.filter((r) => r.teacherPass && r.studentPass).length
const sOnly = rows.filter((r) => !r.teacherPass && r.studentPass).length
const tOnly = rows.filter((r) => r.teacherPass && !r.studentPass).length
const neither = n - both - sOnly - tOnly
const fc = (k) => { const m = {}; for (const r of rows) for (const f of r[k]) m[f] = (m[f] || 0) + 1; return m }
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null }
const rate = (x) => n ? +(x / n).toFixed(4) : 0
const rate2 = (x, d) => d ? +(x / d).toFixed(4) : 0

const report = {
  schema: 'cfb.eval-sft/1', ruler: RULER_VERSION, at: new Date().toISOString(),
  sft: path.relative(ROOT, SFT), gen: path.relative(ROOT, GENP),
  n, missing, emptyStudent: empty,
  teacher: { pass: tPass, rate: rate(tPass), failCount: fc('teacherFailed') },
  student: { pass: sPass, rate: rate(sPass), failCount: fc('studentFailed') },
  scoreable: { n: sn, teacherPass: stPass, studentPass: ssPass,
    teacherRate: sn ? +(stPass / sn).toFixed(4) : 0,
    studentRate: sn ? +(ssPass / sn).toFixed(4) : 0,
    excluded: n - sn, why: 'raw/ctx 本身没有可承重锚点，尺子对它没有受力点（G0）' },
  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },
  chars: { teacher: { p50: q(rows.map((r) => r.teacherChars), 0.5) },
           student: { p50: q(rows.map((r) => r.studentChars), 0.5) } },
  ratio: { teacherP50: q(rows.map((r) => r.teacherRatio), 0.5), studentP50: q(rows.map((r) => r.studentRatio), 0.5) },
  rows,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')

const pc = (x) => (x * 100).toFixed(1) + '%'
console.log('尺子 ' + RULER_VERSION + ' · 配对评测 ' + n + ' 条' + (missing ? '（生成文件里有 ' + missing + ' 条对不上 dev）' : ''))
console.log('  教师 DeepSeek-V4-Flash 通过 %d/%d = %s', tPass, n, pc(rate(tPass)))
console.log('  学生 RWKV7-0.1B      通过 %d/%d = %s', sPass, n, pc(rate(sPass)))
console.log('  四格：都过 %d · 只学生过 %d · 只教师过 %d · 都不过 %d', both, sOnly, tOnly, neither)
console.log('  ── 有受力点子集（剔除 G0 的 %d 条）才是真正的对比 ──', n - sn)
console.log('  教师 %d/%d = %s · 学生 %d/%d = %s', stPass, sn, pc(rate2(stPass, sn)), ssPass, sn, pc(rate2(ssPass, sn)))
console.log('  压缩比 p50：教师 %s · 学生 %s', report.ratio.teacherP50, report.ratio.studentP50)
console.log('  字数 p50：教师 %d · 学生 %d', report.chars.teacher.p50, report.chars.student.p50)
const fmt = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' x' + v).join('、') || '（无）'
console.log('  学生失败分布：' + fmt(report.student.failCount))
console.log('  教师失败分布：' + fmt(report.teacher.failCount))
if (empty) console.log('  ⚠ 学生空稿 %d 条', empty)
console.log('  报告：' + path.relative(ROOT, OUT))
