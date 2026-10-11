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
import { judge, RULER_VERSION, COMPRESSION_TARGET, COMPRESSION_HARD_MAX } from './gen-ruler.mjs'
// G1 的确定性后处理门。判据与尺子的 G1 **同源**（同一个 quoteSpans/anchorsOf/hasAnchor），
// 两边各写一份就会漂移，而漂移不会报错，只会让「门说修好了、尺子说没有」这种
// 谁也看不懂的现象发生。所以这里只 import，绝不复制。
import { guardDraft, orphanCount } from './g1-guard.mjs'
import { estimateTokens } from '../src/tokens.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const SFT = path.resolve(ROOT, arg('--sft', '.cfb-offline/sft'))
const GEN = arg('--gen')
if (!GEN) { console.log('用法: node tools/eval-sft.mjs --gen <dev-generations.jsonl> [--sft <dir>]'); process.exit(2) }
const GENP = path.resolve(ROOT, GEN)
const OUT = path.resolve(ROOT, arg('--out', path.join(path.dirname(GENP), 'eval-sft.json')))
// 默认开 strip。理由在 g1-guard.mjs 里：strip 与 off 一样干净（孤儿小句 0），
// 却把 dev 从 25/73 抬到 45/73；drop 多挣 1 条但留下 60 处残骸。
// --guard off 用来复现「没有这道门」的对照。
const GUARD = arg('--guard', 'strip')

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
  // 后处理门：稿子 -> 摘掉凭空引用 -> 再判。
  // 它**不可能让结果变差**：最坏情况是修复被安全阀退回、结果与不过门时一样，
  // 而不过门的稿子本来就走 raw 兜底（100% 无损）。所以这是纯增益的一步。
  const gd = guardDraft(t.raw, t.ctx, sd, { mode: GUARD })
  const gj = GUARD === 'off' ? sj : judge({ raw: t.raw, ctx: t.ctx, draft: gd.draft })
  rows.push({
    id: g.id, teacherPass: tj.pass, studentPass: sj.pass,
    // gaugeable 是**与稿子无关**的属性（只读 raw/ctx），两边必须恒等。
    // 它现在由尺子给成布尔，不再靠解析 'G0 no-leverage' 这个字符串 ——
    // 字符串一旦改措辞，分母就会静默错位，而分母错了没有任何指标会报警。
    teacherGaugeable: tj.gaugeable, studentGaugeable: sj.gaugeable,
    guardedPass: gj.pass, guardedFailed: gj.failed, guardedScore: gj.score,
    guardedChars: gd.draft.length, guardHits: gd.hits, guardChanged: gd.changed,
    guardReverted: !!gd.reverted, guardInvented: gd.invented || [],
    guardOrphans: GUARD === 'off' ? 0 : orphanCount(gd.draft),
    teacherFailed: tj.failed, studentFailed: sj.failed,
    teacherAdvisory: tj.advisory, studentAdvisory: sj.advisory,
    teacherMeetsTarget: tj.detail.compression.meetsTarget, studentMeetsTarget: sj.detail.compression.meetsTarget,
    teacherScore: tj.score, studentScore: sj.score,
    // 两个比都给：压缩判的是 token 比，字符比只作归因。只报一个的话，
    // 读的人会拿字符比去对文档里的 token 比，然后以为哪里算错了。
    teacherCharRatio: tj.detail.compression.ratio, studentCharRatio: sj.detail.compression.ratio,
    teacherTokRatio: tj.detail.compression.tokenRatio, studentTokRatio: sj.detail.compression.tokenRatio,
    teacherChars: t.draft.length, studentChars: sd.length,
    studentTok: estimateTokens(sd), teacherTok: estimateTokens(t.draft),
    studentDraft: sd,
  })
}

// 有受力点的子集：G0 是**与稿子无关**的门（raw/ctx 本身没有可承重的东西），
// 它对教师和学生一视同仁（实测 dev 89 条，两边命中是同一批 16 条，不一致数 = 0），
// 留在分母里只会同时压低两边、把对比稀释掉。
// 所以两个数都给：全体（G0 算失败，保守）和有受力点子集（才是真正的对比）。
//
// ⚠ 这个分母以前是「34.8% 假天花板」的成因之一：那个数把 16 条**任何稿子都过不了**
// 的单元算进了分母。分子分母各错一次，结论就完全反了（34.8% -> 75.3%）。
const scoreable = rows.filter((r) => r.teacherGaugeable)
// 交叉校验：gaugeable 只读 raw/ctx，所以在教师和学生上必须恒等。
// 不一致只可能意味着两件事，都是硬故障：(1) 尺子被改坏了；
// (2) 生成文件与 dev.jsonl 不是同一版（raw 对得上、ctx 对不上）。
// 静默取一边会让分母悄悄错位 —— 分母错了没有任何指标会报警，所以这里直接退出。
const gaugeMismatch = rows.filter((r) => r.teacherGaugeable !== r.studentGaugeable)
if (gaugeMismatch.length) {
  console.error('FATAL: ' + gaugeMismatch.length + ' 条的 gaugeable 在教师/学生上不一致 —— 尺子或输入有问题')
  console.error('  例：' + gaugeMismatch.slice(0, 3).map((r) => r.id).join('、'))
  process.exit(1)
}
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
const fc = (k, src) => { const m = {}; for (const r of (src || rows)) for (const f of r[k]) m[f] = (m[f] || 0) + 1; return m }
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null }
const rate = (x) => n ? +(x / n).toFixed(4) : 0
const mean = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4) : 0
// 软分是不带阈值的连续量，比"过没过门"信息量大得多：
// 硬门把压缩比切成过/不过，阈值挪 0.1 就能让通过率动 10 个百分点（见 docs 里的敏感度表），
// 而软分不会因为挪一条线就跳变。所以两个都报 —— 只看通过率会被阈值牵着走。
const tScore = rows.map((r) => r.teacherScore)
const sScore = rows.map((r) => r.studentScore)
const scoreWins = rows.filter((r) => r.studentScore > r.teacherScore).length
const scoreLoss = rows.filter((r) => r.studentScore < r.teacherScore).length
const scoreTie = n - scoreWins - scoreLoss
const rate2 = (x, d) => d ? +(x / d).toFixed(4) : 0
// 软标准：过硬门 **且** 压缩达到 COMPRESSION_TARGET。
// 它不是门 —— 没过它照样算过门，只是记在 advisory 里。
// 「现在先软标准，以后再训练到 0.5」这句话就落在这里：这个数是**要训练到的目标**，
// 不是**当前的及格线**。等它上去了，把尺子的 COMPRESSION_HARD_MAX 设成 0.5 才重新装门。
const scTarget = (r, who) => scoreable.filter((x) => x[who + 'Pass'] && x[who + 'MeetsTarget']).length
const tTarget = scTarget(null, 'teacher')
const sTarget = scTarget(null, 'student')
const tOver = scoreable.filter((r) => r.teacherTokRatio > 1.0).length
const sOver = scoreable.filter((r) => r.studentTokRatio > 1.0).length
// 后处理门：过门数 + **有没有把本来过门的稿子弄坏**（那一项必须为 0，不为 0 就是门有 bug）
const gPass = scoreable.filter((r) => r.guardedPass).length
const gBroke = rows.filter((r) => r.studentPass && !r.guardedPass).length
const gFixed = rows.filter((r) => !r.studentPass && r.guardedPass).length
const gHit = rows.filter((r) => r.guardHits > 0).length
const gReverted = rows.filter((r) => r.guardReverted).length
const gOrphans = rows.reduce((a, r) => a + r.guardOrphans, 0)
const gScore = scoreable.map((r) => r.guardedScore)

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
  // 压缩：gen-ruler/4 起是**软标准**，不再是硬门。硬门上限当前 = COMPRESSION_HARD_MAX（null = 未装）。
  compressionTarget: {
    target: COMPRESSION_TARGET, hardMax: COMPRESSION_HARD_MAX,
    teacher: { pass: tTarget, rate: rate2(tTarget, sn) },
    student: { pass: sTarget, rate: rate2(sTarget, sn) },
    overRaw: { teacher: tOver, student: sOver },
    note: '过门 + token 比 <= ' + COMPRESSION_TARGET + '；这是要训练到的目标，不是及格线',
  },
  // 软标准就是这一块：它不拦稿，只记账。它是主指标，因为硬门只能回答「能不能用」，
  // 回答不了「好不好」。
  softStandard: {
    compressionTarget: COMPRESSION_TARGET,
    teacher: { pass: tTarget, rate: rate2(tTarget, sn), overRaw: tOver },
    student: { pass: sTarget, rate: rate2(sTarget, sn), overRaw: sOver },
    note: '过门 + token 比 <= ' + COMPRESSION_TARGET + '；这是要训练到的目标，不是及格线',
  },
  // 后处理门：把学生稿过一遍 G1 闸之后的成绩。
  // 「不劣于原稿」在这里是可验证的：brokePass 必须是 0。
  guard: { mode: GUARD, hits: gHit, fixed: gFixed, brokePass: gBroke, reverted: gReverted,
    orphanClauses: gOrphans,
    studentPass: gPass, studentRate: rate2(gPass, sn), studentMeanScore: mean(gScore),
    note: '摘掉引号里的凭空锚点。不修不编，只摘；最坏退回原稿，所以不可能变差' },
  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },
  chars: { teacher: { p50: q(rows.map((r) => r.teacherChars), 0.5) },
           student: { p50: q(rows.map((r) => r.studentChars), 0.5) } },
  ratio: {
    // 压缩的判据是 **token 比**（gen-ruler/2 起）。字符比会被"英文原文 -> 中文稿"
    // 这种语言切换骗过：字符腰斩、token 不降。两个都报，别只报字符比。
    token: { teacherP50: q(rows.map((r) => r.teacherTokRatio), 0.5),
             studentP50: q(rows.map((r) => r.studentTokRatio), 0.5),
             note: '压缩判据用的就是这条（gen-ruler/4 起不再是硬门）' },
    char: { teacherP50: q(rows.map((r) => r.teacherCharRatio), 0.5),
            studentP50: q(rows.map((r) => r.studentCharRatio), 0.5),
            note: '只作归因，不是判据' },
  },
  softScore: { teacherMean: mean(tScore), studentMean: mean(sScore),
    teacherP50: q(tScore, 0.5), studentP50: q(sScore, 0.5),
    studentWins: scoreWins, studentLosses: scoreLoss, ties: scoreTie,
    note: '不带阈值的连续量。gen-ruler/4 把压缩从硬门挪进软标准之后，这个数就是主指标' },
  rows,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')

const pc = (x) => (x * 100).toFixed(1) + '%'
console.log('尺子 ' + RULER_VERSION + ' · 配对评测 ' + n + ' 条' + (missing ? '（生成文件里有 ' + missing + ' 条对不上 dev）' : ''))
console.log('  教师 DeepSeek-V4-Flash 通过 %d/%d = %s', tPass, n, pc(rate(tPass)))
console.log('  学生 RWKV7-0.1B      通过 %d/%d = %s', sPass, n, pc(rate(sPass)))
console.log('  四格：都过 %d · 只学生过 %d · 只教师过 %d · 都不过 %d', both, sOnly, tOnly, neither)
console.log('  ── 有受力点子集（gaugeable，剔除 %d 条无受力点的）才是真正的对比 ──', n - sn)
console.log('  教师 %d/%d = %s · 学生 %d/%d = %s', stPass, sn, pc(rate2(stPass, sn)), ssPass, sn, pc(rate2(ssPass, sn)))
console.log('  压缩比 p50（token 比，压缩的判据）：教师 %s · 学生 %s',
  report.ratio.token.teacherP50, report.ratio.token.studentP50)
console.log('  压缩比 p50（字符比，只作归因）  ：教师 %s · 学生 %s',
  report.ratio.char.teacherP50, report.ratio.char.studentP50)
console.log('  软分（无阈值）：教师均值 %s p50 %s · 学生均值 %s p50 %s',
  report.softScore.teacherMean, report.softScore.teacherP50,
  report.softScore.studentMean, report.softScore.studentP50)
console.log('  软分逐条胜负：学生赢 %d · 输 %d · 平 %d', scoreWins, scoreLoss, scoreTie)
console.log('  软标准（过门 + 压缩 <= %s，**要训练到的目标，不是及格线**）：教师 %d/%d = %s · 学生 %d/%d = %s',
  COMPRESSION_TARGET, tTarget, sn, pc(rate2(tTarget, sn)), sTarget, sn, pc(rate2(sTarget, sn)))
if (COMPRESSION_HARD_MAX == null) console.log('  压缩硬门：未装（COMPRESSION_HARD_MAX = null）—— gen-ruler/4 起改为软标准')
else console.log('  压缩硬门：token 比 <= %s', COMPRESSION_HARD_MAX)
if (tOver || sOver) console.log('  ⚠ 比原文还长（token 比 > 1.0）：教师 %d · 学生 %d', tOver, sOver)
console.log('  字数 p50：教师 %d · 学生 %d', report.chars.teacher.p50, report.chars.student.p50)
const fmt = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' x' + v).join('、') || '（无）'
console.log('  ── 过 G1 后处理门（' + GUARD + '）后 ──')
console.log('  学生 %d/%d = %s（命中 %d 条，修好 %d 条，弄坏 %d 条，退回 %d 条，孤儿小句 %d）',
  gPass, sn, pc(rate2(gPass, sn)), gHit, gFixed, gBroke, gReverted, gOrphans)
console.log('  软分（过门后）：教师 %s · 学生 %s', report.softScore.teacherMean, mean(gScore))
if (gBroke) console.error('  FATAL: 后处理门把 ' + gBroke + ' 条本来过门的稿子弄坏了 —— 门有 bug')
console.log('  学生失败分布（有受力点，未过门）：' + fmt(fc('studentFailed', scoreable)))
console.log('  教师失败分布（有受力点）：' + fmt(fc('teacherFailed', scoreable)))
if (empty) console.log('  ⚠ 学生空稿 %d 条', empty)
console.log('  报告：' + path.relative(ROOT, OUT))
