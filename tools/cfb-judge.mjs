// tools/cfb-judge.mjs —— 判断层工作台：测量、投票、一致性、分歧裁决（全部可离线自检）。
//
// 判断层的三条硬要求（用户 2026-10-02）：
//   ① 科学可量化：每个维度有定义/刻度/锚点/测量误差；
//   ② 上限要高：15 维向量（代码 9 / 评委 6）；但 v14.2 起只有代码维（含 6 个任务真值维）是选择信号，
//      评委维只做诊断——状态空间的 bit 数是「能分多细」，不是「关于质量的信息量」，二者别混（见 CLOSED-LOOP-V2.md）；
//   ③ 必须有大模型参与：语义维度交评委，代码只做确定性部分，二者交叉验证。
//
// 子命令：
//   node tools/cfb-judge.mjs capacity                报告判断层容量与分辨率上限
//   node tools/cfb-judge.mjs dims                    打印维度表（定义/刻度/锚点/谁测）
//   node tools/cfb-judge.mjs prompt --task f --ctx f --draft f   生成评委提示词
//   node tools/cfb-judge.mjs agree --votes f.json    多票一致性（ICC 近似）
//   node tools/cfb-judge.mjs check --votes f.json    校验评委输出合法性
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DIMENSIONS, DIMS_BY_RATER, judgeCapacity, binaryCeiling, judgeLadPrompt, parseJudgeLad, compositeScore, DEFAULT_WEIGHTS, raterAgreement, ruleLlmDisagreement, pairedBootstrap, pairedEffectSize } from './helpers/judge-layer.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)
const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const PAD = (s, n) => String(s).padEnd(n)
const NUM = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : '—')

function cmdCapacity() {
  const c = judgeCapacity(), b = binaryCeiling(2)
  console.log('判断层容量（分辨率上限，不是「关于质量的信息量」）')
  console.log('  维度数        : ' + c.dimensions + '（代码 ' + c.codeDims + ' / 评委 ' + c.llmDims + '）')
  console.log('  状态空间      : ' + c.states.toLocaleString() + ' 种（全部维度）  ⇒ log2 = ' + c.bits.toFixed(2) + ' bit / 次观测')
  console.log('  其中代码维    : ' + c.codeBits.toFixed(2) + ' bit / 次观测（选择信号只用这部分：selectionSignal=' + c.selectionSignal + '）')
  console.log('  二值判据对照  : ' + b.bits.toFixed(2) + ' bit / 次观测')
  console.log('')
  console.log('  含义：这些 bit 是「刻度能分多细」的上限；一次观测真正带来的、关于「候选是否更好」的信息')
  console.log('        要按配对胜负的后验来算（tools/cfb-cycle.mjs 的 expectedBitsNextPair，先验下一对 ≈ 0.19 bit）。')
  console.log('        评委维（llm）未经校准、锚点一致性未测，v14.2 起只做诊断，不进选择信号。')
  console.log('')
  console.log('  最低可分辨效应（pairedBootstrap，双侧 95%）：')
  for (const n of [5, 10, 20, 50, 100]) {
    // 近似：σ=1 刻度、效应 d 时，n 能分辨的最小 d
    console.log('    n=' + PAD(n, 5) + ' ⇒ 若 σ≈1 刻度，可分辨 d ≈ ' + (2.8 / Math.sqrt(n)).toFixed(2) + '（d<0.2 为微小、0.5 中等、0.8 大）')
  }
  console.log('')
  console.log('  权重默认值（将被回灌层用真实结果覆盖，不是写死的最终值）：')
  for (const [k, v] of Object.entries(DEFAULT_WEIGHTS)) console.log('    ' + PAD(k, 20) + (v > 0 ? '+' : '') + v)
}
function cmdDims() {
  console.log(PAD('维度', 22) + PAD('刻度', 10) + PAD('谁来测', 8) + '定义')
  console.log('-'.repeat(110))
  for (const d of DIMENSIONS) console.log(PAD(d.id, 22) + PAD('[' + d.scale[0] + ',' + d.scale[1] + ']', 10) + PAD(d.rater, 8) + d.def.slice(0, 66))
  console.log('')
  console.log('锚点（评委刻度对齐的依据，必须与黄金集一起维护）：')
  for (const d of DIMENSIONS.filter((x) => x.rater === 'llm')) console.log('  ' + PAD(d.id, 22) + JSON.stringify(d.anchors))
}
function cmdPrompt(args) {
  const p = judgeLadPrompt({ task: read(f(args, '--task')), ctx: read(f(args, '--ctx')), draft: read(f(args, '--draft')), followup: read(f(args, '--followup')), reference: read(f(args, '--reference')) })
  process.stdout.write(p)
}
function cmdAgree(args) {
  const file = f(args, '--votes')
  const votes = file && fs.existsSync(file) ? readJson(file) : null
  if (!votes) { console.log('需要 --votes <json>：数组，每项是一次评委输出'); process.exitCode = 1; return }
  const parsed = votes.map((v) => parseJudgeLad(v))
  const bad = parsed.filter((p) => !p.ok)
  console.log('票数 ' + votes.length + ' ；合法 ' + (votes.length - bad.length) + ' ；非法 ' + bad.length)
  if (bad.length) for (const b of bad) console.log('  非法: ' + b.reason)
  const okVotes = parsed.filter((p) => p.ok).map((p) => p.values)
  if (okVotes.length >= 2) {
    const ag = raterAgreement(okVotes)
    console.log('')
    console.log(PAD('维度', 22) + PAD('均值', 10) + PAD('标准差', 10) + PAD('ICC近似', 10) + '判定')
    for (const [k, v] of Object.entries(ag)) {
      const verdict = v.sd == null ? '样本不足' : v.sd <= 0.5 ? '一致' : v.sd <= 1.2 ? '尚可' : '**分歧大**'
      console.log(PAD(k, 22) + PAD(NUM(v.mean, 2), 10) + PAD(NUM(v.sd, 2), 10) + PAD(NUM(v.icc, 2), 10) + verdict)
    }
    console.log('')
    const cs = okVotes.map((v) => compositeScore(v).score)
    console.log('综合分: ' + cs.map((x) => NUM(x, 2)).join(' / ') + '  ⇒ 极差 ' + NUM(Math.max(...cs) - Math.min(...cs), 2))
    console.log('提示：极差 > 5 说明该样本的评委分歧足以改变结论，应送人工裁决或加票。')
  }
}
function cmdCheck(args) {
  const file = f(args, '--votes')
  if (!file || !fs.existsSync(file)) { console.log('需要 --votes <json>'); process.exitCode = 1; return }
  const votes = readJson(file)
  let bad = 0
  for (const [i, v] of votes.entries()) {
    const p = parseJudgeLad(v)
    if (!p.ok) { bad++; console.log('第 ' + i + ' 票不合法: ' + p.reason) }
    else if (p.missing.length) console.log('第 ' + i + ' 票缺维度: ' + p.missing.join(','))
  }
  console.log(bad ? '有 ' + bad + ' 票不合法' : '全部合法（' + votes.length + ' 票）')
  process.exitCode = bad ? 1 : 0
}

function main() {
  const [cmd = 'capacity', ...args] = process.argv.slice(2)
  if (cmd === 'capacity') cmdCapacity()
  else if (cmd === 'dims') cmdDims()
  else if (cmd === 'prompt') cmdPrompt(args)
  else if (cmd === 'agree') cmdAgree(args)
  else if (cmd === 'check') cmdCheck(args)
  else throw new Error('未知子命令 ' + cmd)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
