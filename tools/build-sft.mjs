#!/usr/bin/env node
// tools/build-sft.mjs —— 把教师真稿变成监督微调数据集（$0、零依赖、确定性）
//
// 设计决定一：**用底座自己的 chat template，不自造分隔符。**
// 我第一版写的是自定义 `### 题面 / ### 思考过程 / ### 压缩稿` 标记，理由是「RWKV7 没有 chat template」。
// 那个前提是错的 —— 拉下 tokenizer_config.json 才看见它有完整的 chat_template：
//   <|rwkv_tokenizer_end_of_text|>System: …\n\nUser: …\n\nAssistant: …\n\n
// 底座 5 万亿 token 就是按这套标记训练的。自造分隔符等于让模型先忘掉一套格式再学一套，
// 白白浪费容量和样本。所以这里**不写死模板文本**，只存结构化的 system/user/assistant 三段，
// 由训练脚本调用 apply_chat_template 生成 —— 连 Jinja 都不用手抄，抄错就是静默的格式错配。
//
// 设计决定二：**训练集**只收过尺子的稿子。训练集里混进一份「看起来像稿子」的垃圾，
// 模型就学会产出那种垃圾，而没有任何指标会报警。
//
// 设计决定三：按**仓库**切分 train/dev，不随机切。同一仓库的多个单元高度相似
// （同样的文件、术语、修法），随机切会把几乎相同的样本同时放进两边，dev 分数虚高 ——
// 而虚高的 dev 分数**不会以任何方式报警**。
//
// 设计决定四：**先切分、再过滤训练集；dev 不过滤。**
// 反过来（先过滤再切分）会让 dev 只剩「教师本来就过尺子」的那部分，
// 于是学生哪怕只会照抄，dev 通过率也会天然接近 100%，跟教师 57% 的基线没法比 ——
// 那是一个只会报喜的指标。所以 dev 保留**全部**可用单元，并额外记录
// `devTeacherPass`（教师在这批单元上的通过率）当基线，学生分数跟它比才有意义。
//
// 输出每行：{ id, repo, system, user, assistant, meta }
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge } from './gen-ruler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const IN = path.resolve(ROOT, arg('--in', '.cfb-offline/teacher/drafts.jsonl'))
const OUT = path.resolve(ROOT, arg('--out', '.cfb-offline/sft'))
const DEV_RATIO = Number(arg('--dev-ratio', '0.1'))
const MIN_DRAFT = Number(arg('--min-draft', '40'))
const MIN_RAW = Number(arg('--min-raw', '800'))

// 提示词只存一份：教师用它产出，学生用它训练。两边各写一份副本就会漂移，
// 而漂移不会报错，只会让模型学到一个用不上的映射。
// ⚠ 提示词必须与**生成这批稿子时用的那一份**逐字相同。
// 2026-10 修 bug：这里原来读 compress-zh.txt（v1），而稿子是 teacher2-zh.txt（v4）生成的 ——
// 于是 system 说「压成中文稿、不超过 55%」，assistant 却是「跟原文语言、10~20%」。
// 指令与标签互相矛盾，学生会学到用不上的映射，而没有任何指标会报警。
const PROMPT_PATH = path.join(ROOT, 'transfer/prompts/teacher2-zh.txt')
// 保留换行：这是样例驱动的提示词，样例是 flash 唯一真正读的东西，压成一行就废了。
const SYSTEM = fs.readFileSync(PROMPT_PATH, 'utf8')
  .split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n').trim()

// FNV-1a：跨平台、跨 Node 版本稳定。绝不能用 Math.random 或对象键序来切分 ——
// 那会让同一个数据集两次跑出不同切分，于是 dev 分数不可复现。
const H = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }

const lines = fs.readFileSync(IN, 'utf8').split(/\r?\n/).filter((l) => l.trim())
const usable = []
const seen = new Set()
const rejects = {}
let dup = 0, empty = 0
for (const l of lines) {
  let o
  try { o = JSON.parse(l) } catch { continue }
  const id = o.id || o.unitId
  if (!id || seen.has(id)) { dup++; continue }
  seen.add(id)
  const draft = String(o.draft || '').trim()
  if (!draft) { empty++; continue }
  const raw = String(o.raw || '')
  const ctx = String(o.ctx || '')
  if (raw.length < MIN_RAW) { rejects['too-short-raw'] = (rejects['too-short-raw'] || 0) + 1; continue }
  if (draft.length < MIN_DRAFT) { rejects['draft-below-min'] = (rejects['draft-below-min'] || 0) + 1; continue }
  const r = judge({ raw, ctx, draft })
  usable.push({ id, repo: o.family || o.repository || 'unknown', raw, ctx, draft,
    pass: !!r.pass, failed: r.failed || [], score: r.score,
    license: o.license || null, usage: o.usage || null })
}

// 先按仓库切分，再对训练集过滤（见设计决定四）
const train = [], dev = []
for (const u of usable.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
  if (H(u.repo) % 1000 < DEV_RATIO * 1000) { dev.push(u); continue }
  if (!u.pass) { for (const g of u.failed) rejects[g] = (rejects[g] || 0) + 1; continue }
  train.push(u)
}

const mk = (u) => ({ id: u.id, repo: u.repo, system: SYSTEM,
  user: '[题面]\n' + u.ctx + '\n\n[思考过程]\n' + u.raw,
  assistant: u.draft,
  meta: { rawChars: u.raw.length, ctxChars: u.ctx.length, draftChars: u.draft.length,
    ratio: Number((u.draft.length / u.raw.length).toFixed(4)), score: u.score,
    judgePass: u.pass, license: u.license, usage: u.usage } })
const rows = train.map(mk)
// dev 额外带顶层 raw/ctx：训练器把它们原样写进 dev-generations.jsonl，
// 于是那份生成结果**自带**打分所需的输入，不依赖"当时的 dev.jsonl 还在这儿"。
// 训练集不带 —— 训练器不读这两个字段，多存一份纯属浪费。
const devRows = dev.map((u) => ({ ...mk(u), raw: u.raw, ctx: u.ctx }))
const devPass = dev.filter((u) => u.pass).length

fs.mkdirSync(OUT, { recursive: true })
const wr = (f, a) => fs.writeFileSync(path.join(OUT, f), a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : ''))
wr('train.jsonl', rows)
wr('dev.jsonl', devRows)

const avg = (a, k) => a.length ? Number((a.reduce((s, x) => s + x.meta[k], 0) / a.length).toFixed(1)) : 0
const report = {
  in: path.relative(ROOT, IN), prompt: path.relative(ROOT, PROMPT_PATH), promptChars: SYSTEM.length,
  format: { template: 'native chat_template (System/User/Assistant)', tokenizedBy: 'trainer via apply_chat_template',
    thinking: false, why: '底座按这套标记训练了 5T token；自造分隔符要它先忘一套再学一套' },
  read: lines.length, dup, empty, usable: usable.length, kept: rows.length,
  rejected: usable.length - rows.length - dev.length,
  rejects,
  split: { train: rows.length, dev: devRows.length, byRepo: true,
    algorithm: 'fnv1a(repo)%1000 < ' + DEV_RATIO * 1000,
    devUnfiltered: true, why: 'dev 不过滤，否则通过率天然接近 100%，跟教师基线没法比' },
  devTeacherPass: { pass: devPass, total: dev.length,
    rate: dev.length ? Number((devPass / dev.length).toFixed(4)) : null,
    note: '学生在 dev 上的通过率要跟这个数比，不是跟 100% 比' },
  repos: { total: new Set(usable.map((r) => r.repo)).size,
    train: new Set(rows.map((r) => r.repo)).size, dev: new Set(devRows.map((r) => r.repo)).size },
  chars: { train: { raw: avg(rows, 'rawChars'), ctx: avg(rows, 'ctxChars'), draft: avg(rows, 'draftChars') } },
  ratio: avg(rows, 'ratio'), score: avg(rows, 'score'),
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')

console.log('SFT 数据集：读 %d -> 可用 %d -> 训练 %d / 验证 %d（验证集不过滤）',
  lines.length, usable.length, rows.length, devRows.length)
console.log('  格式：底座原生 chat_template（System/User/Assistant），非思考模式')
console.log('  仓库：总 %d，训练 %d，验证 %d（按仓库切分，无泄漏）', report.repos.total, report.repos.train, report.repos.dev)
console.log('  训练集均值：raw %d / ctx %d / draft %d 字，压缩比 %s，软分 %s',
  report.chars.train.raw, report.chars.train.ctx, report.chars.train.draft, report.ratio, report.score)
console.log('  教师基线：验证集 %d/%d = %s 通过 —— 学生分数跟这个比',
  devPass, dev.length, report.devTeacherPass.rate)
const rk = Object.entries(rejects).sort((a, b) => b[1] - a[1])
if (rk.length) console.log('  训练集未收原因：' + rk.map(([k, v]) => k + ' x' + v).join('、'))
console.log('  产出：' + path.relative(ROOT, OUT) + '/{train,dev}.jsonl + report.json')
