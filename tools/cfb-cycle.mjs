// tools/cfb-cycle.mjs —— 编排层：一台能一直往下练的机器。
//
// 一轮 = 观测 → 判断 → 生成 → 打分 → 选择 → [执行] → 回灌 → 报告
// 前四个阶段永远零 API；只有「执行」花通道的钱，且通道不好时它只产出待跑清单。
//
// 用法：
//   node tools/cfb-cycle.mjs run                 跑一轮（离线部分）
//   node tools/cfb-cycle.mjs run --round 3       指定轮次（用于累积历史）
//   node tools/cfb-cycle.mjs status              看当前状态与历史
//   node tools/cfb-cycle.mjs doctor              自检：所有部件是否就绪
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DIMENSIONS, DIMS_BY_RATER, judgeCapacity, DEFAULT_WEIGHTS, compositeScore, pairedBootstrap, pairedEffectSize } from './helpers/judge-layer.mjs'
import { LEVERS, priorityOrder, ablationSet, layeredSet, renderSpec, applyKnobs } from './helpers/levers.mjs'
import { fitWeights, toRow, rankAgreement, missingDimensionSignal, activeSelect } from './helpers/calibration.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OFFLINE = path.join(ROOT, '.cfb-offline')
const HISTORY = path.join(OFFLINE, 'history.json')
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)
const ensure = (d) => { fs.mkdirSync(d, { recursive: true }); return d }
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p, o) => { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }

function loadCorpus() { return readJson(path.join(OFFLINE, 'corpus.json')) }
function loadHistory() { return readJson(HISTORY, { schema: 'cfb.cycle-history/1', rounds: [] }) }

// ── 阶段 2+3：生成候选（对语料里的真实稿施加杠杆变换）
export function generateCandidates(corpus, { mode = 'layered' } = {}) {
  const cands = mode === 'kItems' ? ablationSet({ lever: 'kItems' }) : layeredSet()
  const out = []
  for (const c of cands) {
    const spec = renderSpec(c.knobs)
    for (const it of (corpus && corpus.items) || []) {
      if (!it.text) continue
      const text = applyKnobs(it.text, c.knobs)
      out.push({ id: c.id + '@' + it.key, arm: c.id, knobId: c.id, task: it.task, kind: it.kind,
        isBaseline: !!c.isBaseline, knobs: c.knobs, spec, text, chars: text.length, baseChars: it.chars, baseText: it.text, ctx: it.ctx })
    }
  }
  return out
}

// ── 阶段 4：离线打分（代码维度；评委维度在 live 之后补）
export function scoreCandidates(cands, { weights = DEFAULT_WEIGHTS } = {}) {
  return cands.map((c) => {
    const k = require$kItemsOf(c.text)
    const code = require$codeDimensions(c.text, c.ctx, k)
    const vec = { ...code }
    const comp = compositeScore(vec, weights)
    return { ...c, code, vector: vec, codeScore: comp.score, parts: comp.parts }
  })
}

// ── 阶段 5：选择（主动学习：一半探索、一半利用）
export function selectRound(scored, rows, budget) {
  const cands = scored.map((s) => ({ id: s.id, x: DIMENSIONS.map((d) => {
    const v = s.vector[d.id]; if (!Number.isFinite(v)) return NaN
    const [lo, hi] = d.scale; const x = hi > lo ? (v - lo) / (hi - lo) : 0
    return (d.id === 'invention' || d.id === 'redundancy') ? 1 - x : x
  }) }))
  return activeSelect(cands, rows, { budget })
}

// ── 阶段 7：回灌（把 live 结果并进训练集，重新拟合）
export function feedback({ observations = [] } = {}) {
  const rows = observations.map((o) => toRow(o.features, o.outcome))
  const fit = fitWeights(rows)
  const agree = rows.length >= 3 ? rankAgreement(rows, fit.weights) : { n: rows.length, rho: null }
  const miss = missingDimensionSignal(rows)
  return { rows: rows.length, fit, agreement: agree, missingDimension: miss }
}

// ── 报告
function report(round, ctx) {
  const L = []
  const cap = judgeCapacity()
  L.push('# 第 ' + round + ' 轮（离线可跑部分）', '', '生成: ' + new Date().toISOString(), '')
  L.push('## 判断层', '')
  L.push('- 维度 ' + cap.dimensions + '（代码 ' + cap.codeDims + ' / 评委 ' + cap.llmDims + '），状态空间 ' + cap.states.toLocaleString() + '，' + cap.bits.toFixed(2) + ' bit/次观测')
  L.push('- 二值判据仅 1.00 bit ⇒ 本判断层分辨率高 ' + (cap.bits).toFixed(1) + ' 倍，**天花板远高于当前水平**')
  L.push('')
  L.push('## 生成层：按理论效应量排序的杠杆', '')
  L.push('| 优先级 | 杠杆 | 取值 | 理论依据 |', '| --- | --- | --- | --- |')
  for (const l of priorityOrder()) L.push('| ' + l.priority + ' | ' + l.id + ' | ' + l.values.join(' / ') + ' | ' + l.theory + ' |')
  L.push('')
  L.push('## 本轮候选', '')
  if (ctx.cands) {
    const byArm = {}
    for (const c of ctx.cands) (byArm[c.arm] = byArm[c.arm] || []).push(c)
    L.push('| 臂 | 稿数 | 平均字数 | 平均代码分 |', '| --- | --- | --- | --- |')
    for (const [arm, xs] of Object.entries(byArm)) {
      const n = xs.length, chars = Math.round(xs.reduce((a, c) => a + c.chars, 0) / n)
      const sc = xs.reduce((a, c) => a + (c.codeScore || 0), 0) / n
      L.push('| ' + arm + ' | ' + n + ' | ' + chars + ' | ' + sc.toFixed(2) + ' |')
    }
  }
  L.push('')
  L.push('## 选中要花钱的（主动学习）', '')
  if (ctx.scored) {
    L.push('- 探索（不确定性最高）：' + ctx.scored.explore.map((c) => c.id).slice(0, 6).join(', '))
    L.push('- 利用（预期效用最高）：' + ctx.scored.exploit.map((c) => c.id).slice(0, 6).join(', '))
  }
  L.push('')
  L.push('## 回灌层', '')
  const fb = ctx.feedback
  L.push('- 训练观测数: ' + fb.rows)
  L.push('- 权重拟合: ' + (fb.fit.ok ? '成功（R² ' + fb.fit.r2 + '，置信 ' + fb.fit.confidence + '）' : '未拟合（' + fb.fit.reason + '）⇒ 收缩到默认权重'))
  L.push('- 排序一致性 ρ: ' + (fb.agreement.rho == null ? '样本不足' : fb.agreement.rho))
  L.push('- 缺维度信号: ' + (fb.missingDimension.ok ? fb.missingDimension.note : '样本不足'))
  L.push('')
  L.push('## 下一步（需要通道）', '')
  L.push('```')
  L.push('node tools/channel-check.mjs --base-url <url> --model <model>')
  L.push('node tools/effect-ready.mjs prepare --v8 --profile eval-profile.json')
  L.push('node tools/effect-ready.mjs run --v8 --live')
  L.push('```')
  return L.join('\n')
}

function cmdRun(args) {
  ensure(OFFLINE)
  const round = Number(f(args, '--round') || (loadHistory().rounds.length + 1))
  const corpus = loadCorpus()
  const hist = loadHistory()
  if (!corpus) { console.log('缺少语料：先跑 node tools/cfb-corpus.mjs'); process.exitCode = 1; return }
  const cands = generateCandidates(corpus, { mode: f(args, '--mode') || 'layered' })
  const scored = scoreCandidates(cands)
  const obs = hist.observations || []
  const rows = obs.map((o) => toRow(o.features, o.outcome))
  const picked = selectRound(scored, rows, Number(f(args, '--budget') || 8))
  const fb = feedback({ observations: obs })
  const md = report(round, { cands: scored, scored: picked, feedback: fb })
  writeJson(path.join(OFFLINE, 'round-' + round + '.json'), { schema: 'cfb.cycle-round/1', round, at: new Date().toISOString(), arms: [...new Set(cands.map((c) => c.arm))], candidates: scored.length, picked, feedback: fb })
  fs.writeFileSync(path.join(OFFLINE, 'round-' + round + '.md'), md)
  hist.rounds.push({ round, at: new Date().toISOString(), candidates: scored.length, arms: [...new Set(cands.map((c) => c.arm))] })
  writeJson(HISTORY, hist)
  console.log(md)
  console.log('\n已写入 .cfb-offline/round-' + round + '.md')
}
function cmdStatus() {
  const h = loadHistory()
  console.log('轮次历史: ' + h.rounds.length)
  for (const r of h.rounds) console.log('  第 ' + r.round + ' 轮 ' + r.at + ' 候选 ' + r.candidates + ' 臂 ' + r.arms.join('/'))
  console.log('观测数: ' + (h.observations || []).length)
}
function cmdDoctor() {
  const checks = [
    ['语料', fs.existsSync(path.join(OFFLINE, 'corpus.json'))],
    ['判断层维度表', DIMENSIONS.length >= 8],
    ['杠杆按效应量排序', priorityOrder()[0].id === 'kItems'],
    ['回灌权重可拟合', typeof fitWeights === 'function'],
  ]
  let ok = true
  for (const [n, v] of checks) { console.log((v ? 'PASS ' : 'FAIL ') + n); if (!v) ok = false }
  process.exitCode = ok ? 0 : 1
}
function main() {
  const [cmd = 'run', ...args] = process.argv.slice(2)
  if (cmd === 'run') cmdRun(args)
  else if (cmd === 'status') cmdStatus()
  else if (cmd === 'doctor') cmdDoctor()
  else throw new Error('未知子命令 ' + cmd)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

import { kItemsOf as require$kItemsOf } from './helpers/offline-core.mjs'
import { codeDimensions as require$codeDimensions } from './helpers/judge-layer.mjs'
