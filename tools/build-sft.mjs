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
// 设计决定二：只让过尺子的稿子进集。训练集里混进一份「看起来像稿子」的垃圾，
// 模型就学会产出那种垃圾，而没有任何指标会报警。
//
// 设计决定三：按**仓库**切分 train/dev，不随机切。同一仓库的多个单元高度相似
// （同样的文件、术语、修法），随机切会把几乎相同的样本同时放进两边，dev 分数虚高 ——
// 而虚高的 dev 分数**不会以任何方式报警**。
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
const rows = []
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
  if (!r.pass) { for (const g of r.failed) rejects[g] = (rejects[g] || 0) + 1; continue }
  rows.push({ id, repo: o.family || o.repository || 'unknown', system: SYSTEM,
    user: '[题面]\n' + ctx + '\n\n[思考过程]\n' + raw,
    assistant: draft,
    meta: { rawChars: raw.length, ctxChars: ctx.length, draftChars: draft.length,
      ratio: Number((draft.length / raw.length).toFixed(4)), score: r.score, license: o.license || null,
      usage: o.usage || null } })
}

const train = [], dev = []
for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
  (H(r.repo) % 1000 < DEV_RATIO * 1000 ? dev : train).push(r)
}

fs.mkdirSync(OUT, { recursive: true })
const wr = (f, a) => fs.writeFileSync(path.join(OUT, f), a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : ''))
wr('train.jsonl', train)
wr('dev.jsonl', dev)

const avg = (a, k) => a.length ? Number((a.reduce((s, x) => s + x.meta[k], 0) / a.length).toFixed(1)) : 0
const report = {
  in: path.relative(ROOT, IN), prompt: path.relative(ROOT, PROMPT_PATH), promptChars: SYSTEM.length,
  format: { template: 'native chat_template (System/User/Assistant)', tokenizedBy: 'trainer via apply_chat_template',
    thinking: false, why: '底座按这套标记训练了 5T token；自造分隔符要它先忘一套再学一套' },
  read: lines.length, dup, empty, kept: rows.length, rejected: lines.length - rows.length - dup - empty,
  rejects,
  split: { train: train.length, dev: dev.length, byRepo: true, algorithm: 'fnv1a(repo)%1000 < ' + DEV_RATIO * 1000 },
  repos: { total: new Set(rows.map((r) => r.repo)).size, train: new Set(train.map((r) => r.repo)).size, dev: new Set(dev.map((r) => r.repo)).size },
  chars: { train: { raw: avg(train, 'rawChars'), ctx: avg(train, 'ctxChars'), draft: avg(train, 'draftChars') } },
  ratio: avg(train, 'ratio'), score: avg(train, 'score'),
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')

console.log('SFT 数据集：读 %d -> 保留 %d（训练 %d / 验证 %d）', lines.length, rows.length, train.length, dev.length)
console.log('  格式：底座原生 chat_template（System/User/Assistant），非思考模式')
console.log('  仓库：总 %d，训练 %d，验证 %d（按仓库切分，无泄漏）', report.repos.total, report.repos.train, report.repos.dev)
console.log('  训练集均值：raw %d / ctx %d / draft %d 字，压缩比 %s，软分 %s',
  report.chars.train.raw, report.chars.train.ctx, report.chars.train.draft, report.ratio, report.score)
const rk = Object.entries(rejects).sort((a, b) => b[1] - a[1])
if (rk.length) console.log('  未进集原因：' + rk.map(([k, v]) => k + ' x' + v).join('、'))
console.log('  产出：' + path.relative(ROOT, OUT) + '/{train,dev}.jsonl + report.json')