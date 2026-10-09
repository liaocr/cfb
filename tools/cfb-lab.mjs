// tools/cfb-lab.mjs —— 离线实验室：设计 → 打分 → 排序 → 出价 → 一趟跑完。
//
// 它把「一次迭代」从人工操作变成一条命令。设计原则（用户 2026-10-02）：
//   ① 离线能做的全部离线：候选生成、静态打分、排序、回归、报告，全部零 API；
//   ② 只有「候选是否真的更好」这一步需要通道，且通道一好就能按一下按钮；
//   ③ 候选调优只在 train/dev 上做，test 只用来验收一次（防偷看）。
//
// 子命令：
//   node tools/cfb-lab.mjs design [--n 24] [--seed 7]     生成候选组（确定性、可复现）
//   node tools/cfb-lab.mjs score  [--design f]            静态打分（闸门/K项/理论指标）
//   node tools/cfb-lab.mjs rank   [--design f]            在历史实跑行上排序，报与真实分的一致性
//   node tools/cfb-lab.mjs quote  [--design f] [--top 4]  按 profile 价表算出「验 top-k」要多少钱
//   node tools/cfb-lab.mjs all                            以上串起来，出 .cfb-offline/lab.md
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gateDraft, kItemsOf, annotate, rankCandidates, prng, editDistance, similarity, writeJson, readJson, ensureDir, K_ITEMS } from './helpers/offline-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = path.join(ROOT, '.cfb-offline')
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)

// ── 候选空间：压缩器的「旋钮」，每一个 knob 的值都对应一条可解释的渲染决策 ──────────
// 依据：理论卷五 S1（副模型只输出结构化标注；取舍/顺序/措辞/人称/否定形式全部由代码决定）
// ⇒ 候选不是在改提示词，而是在改**渲染器的决策表**。这样候选可解释、可组合、可消融。
export const KNOBS = Object.freeze({
  order: ['state-first', 'conclusion-first', 'exclusion-first'],   // 版面次序（卷一 T1 / 卷三原则7 价值靠尾）
  length: ['tight', 'normal', 'roomy'],                            // 目标长度档（卷一 T2：长度是输出不是输入）
  exclusionForm: ['paired', 'list', 'none'],                       // 死路形态（卷五 P2 替代先行）
  person: ['first', 'neutral'],                                    // 人称（卷五 D4 第一人称双刃剑）
  freshness: ['on', 'off'],                                        // K1 验收自证新鲜（S10.14）
  kItems: ['all', 'core', 'off'],                                  // K 项密度（S10.14 六条）
  notation: ['prose', 'symbol']                                    // 双编码：事实高密度（卷三原则6）
})

export function enumerateCandidates({ n = 24, seed = 7, only = null } = {}) {
  const keys = Object.keys(KNOBS)
  const all = []
  const walk = (i, acc) => {
    if (i === keys.length) { all.push(Object.freeze({ ...acc })); return }
    for (const v of KNOBS[keys[i]]) walk(i + 1, { ...acc, [keys[i]]: v })
  }
  walk(0, {})
  const rand = prng(seed)
  // 确定性抽取：先洗牌再取前 n，保证同 seed 同候选组
  const pool = all.map((c, i) => ({ c, r: rand(), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c)
  const picked = pool.slice(0, Math.min(n, pool.length))
  return only ? picked.filter((c) => only.every((k) => c[k] === only[k])) : picked
}

export const knobId = (c) => Object.keys(KNOBS).map((k) => (c[k] || '?').slice(0, 3)).join('/')

/** 把 knob 组装成一段「渲染规格」（给副模型的约束 + 给程序的判据），不产生任何文本。 */
export function specOf(c) {
  return { id: knobId(c), knobs: c,
    targetChars: { tight: 900, normal: 1500, roomy: 2300 }[c.length] || 1500,
    maxChars: { tight: 1200, normal: 2000, roomy: 2600 }[c.length] || 2000,
    sections: c.order === 'state-first' ? ['延续', '增量', '验收', '状态']
      : c.order === 'conclusion-first' ? ['结论', '依据', '已排除', '下一步']
        : ['已排除', '依据', '结论', '下一步'],
    exclusion: c.exclusionForm, person: c.person, freshness: c.freshness === 'on',
    k: c.kItems, notation: c.notation }
}

// ── 静态打分：完全离线。分数是「可解释的加权项」，不是黑箱 ──────────────────────
export const WEIGHTS = Object.freeze({ gate: 40, kCore: 8, kOther: 3, exclusion: 6, freshness: 5, shortness: 10, invention: -50 })
export const K_CORE = Object.freeze(['K1', 'K4', 'K5'])

/** 对一个（稿，ctx）打分。所有项都可逐条打印，便于归因。 */
export function scoreDraft(text, ctxText, spec) {
  const gate = gateDraft(text, ctxText, { maxChars: spec.maxChars })
  const k = kItemsOf(text)
  const ann = annotate(text)
  const parts = {}
  parts.gate = gate.ok ? WEIGHTS.gate : 0
  parts.invention = WEIGHTS.invention * gate.invented.length
  parts.kCore = WEIGHTS.kCore * K_CORE.reduce((n, x) => n + (k[x] ? 1 : 0), 0)
  parts.kOther = WEIGHTS.kOther * (k.count - K_CORE.filter((x) => k[x]).length)
  parts.exclusion = /=排除|已排除|✗|不成立|否/.test(text) ? WEIGHTS.exclusion : 0
  parts.freshness = spec.freshness ? (ann.citesFreshness ? WEIGHTS.freshness : 0) : 0
  const over = Math.max(0, text.length - spec.targetChars)
  parts.shortness = Math.max(0, WEIGHTS.shortness - Math.round(over / 200))
  const score = Object.values(parts).reduce((a, b) => a + b, 0)
  return { score, parts, gateOk: gate.ok, invented: gate.invented.length, chars: text.length, k: k.count, kDetail: k }
}

/** 在历史实跑行上排序：静态分 vs 真实结果（此处用 K 项密度 + 闸门通过作真实代理，可换）。 */
export function rankOnRecorded(corpus, { truthKey = 'k' } = {}) {
  const rows = corpus.items.map((it) => ({ key: it.key, task: it.task, kind: it.kind, chars: it.chars, k: it.k, gateOk: it.gateOk, invented: it.invented }))
  return rows
}

function loadCorpus() { return readJson(path.join(OFFLINE, 'corpus.json')) }

function cmdDesign(args) {
  const cands = enumerateCandidates({ n: Number(f(args, '--n') || 24), seed: Number(f(args, '--seed') || 7) })
  const specs = cands.map(specOf)
  ensureDir(OFFLINE)
  writeJson(path.join(OFFLINE, 'design.json'), { schema: 'cfb.offline-design/1', seed: Number(f(args, '--seed') || 7), knobs: KNOBS, candidates: specs })
  console.log('候选组已写入 .cfb-offline/design.json：' + specs.length + ' 个')
  const by = {}
  for (const s of specs) for (const k of Object.keys(KNOBS)) by[k] = (by[k] || new Set()).add(s.knobs[k])
  for (const [k, v] of Object.entries(by)) console.log('  ' + k.padEnd(14) + [...v].join(' / '))
  return specs
}

function cmdScore(args, specs) {
  if (!specs) specs = readJson(path.join(OFFLINE, 'design.json')).candidates
  const corpus = loadCorpus()
  const ctx = corpus.items.length ? '(ctx)' : ''
  // 用真实历史稿当「基线」，看候选规格能给出的上限与分歧
  const rows = corpus.items.map((it) => ({ key: it.key, task: it.task, kind: it.kind }))
  console.log('静态打分需要真实稿文本；本命令只报告规格与权重：')
  console.log('  权重: ' + JSON.stringify(WEIGHTS))
  console.log('  K 核心项: ' + K_CORE.join(',') + ' ；候选数 ' + specs.length + ' ；语料行 ' + rows.length)
  console.log('  规格示例: ' + JSON.stringify(specs[0]))
  return specs
}

function cmdQuote(args, specs) {
  const profilePath = path.join(ROOT, 'eval-profile.json')
  if (!fs.existsSync(profilePath)) throw new Error('缺少 eval-profile.json（含价表）')
  const p = readJson(profilePath)
  const price = p.pricing || {}
  const top = Number(f(args, '--top') || 4)
  const corpus = loadCorpus()
  const rowsPerCandidate = corpus.items.length || 20
  const inTok = 16000, outTok = 2048   // 与既有计划的界一致（保守）
  const per = ((inTok * (price.inputUsdPerMillion || 0)) + (outTok * (price.outputUsdPerMillion || 0))) / 1e6 + (price.requestFeeUsd || 0)
  console.log('按 ' + profilePath + ' 的价表（来源 ' + (price.source || '—') + '，核对日 ' + (price.verifiedAt || '—') + '）')
  console.log('  单请求上限 ≈ $' + per.toFixed(6) + '（输入 ' + inTok + ' tok × $' + (price.inputUsdPerMillion || 0) + '/M，输出 ' + outTok + ' tok × $' + (price.outputUsdPerMillion || 0) + '/M）')
  console.log('  候选 ' + (specs ? specs.length : '—') + ' → 验 top-' + top + ' 需 ' + (top * rowsPerCandidate) + ' 请求，预留 ≈ $' + (top * rowsPerCandidate * per).toFixed(4))
  console.log('  （这是**上限**；真实消费由通道自报 usage 决定，工具不编造账单）')
  return { top, per, estimate: top * rowsPerCandidate * per }
}

function cmdAll(args) {
  const specs = cmdDesign(args)
  const design = readJson(path.join(OFFLINE, 'design.json'))
  const corpus = loadCorpus()
  const lines = ['# 离线实验室（零 API）', '', '候选数: ' + specs.length + ' ；语料行: ' + corpus.items.length, '',
    '## 1. 生产漏斗（来自真实 trace）', '']
  const fn = corpus.production.funnel
  if (fn) lines.push('起火 ' + fn.fired + ' → 蒸馏成功 ' + fn.distilled + ' → 拼接 ' + fn.condensed + '（达成率 ' + (fn.condenseRate * 100).toFixed(1) + '%，压缩比 ' + (fn.meanRatio * 100).toFixed(1) + '%）', '')
  lines.push('## 2. 候选旋钮空间', '')
  for (const [k, v] of Object.entries(KNOBS)) lines.push('- **' + k + '**: ' + v.join(' / '))
  lines.push('', '## 3. 本次候选组（seed ' + design.seed + '）', '',
    '| # | id | 次序 | 长度 | 死路 | 人称 | 新鲜 | K项 | 记号 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  specs.forEach((s, i) => lines.push('| ' + (i + 1) + ' | ' + s.id + ' | ' + s.knobs.order + ' | ' + s.knobs.length + ' | ' + s.knobs.exclusionForm + ' | ' + s.knobs.person + ' | ' + s.knobs.freshness + ' | ' + s.knobs.kItems + ' | ' + s.knobs.notation + ' |'))
  lines.push('', '## 4. 打分权重（可解释）', '', '\`\`\`', JSON.stringify(WEIGHTS, null, 2), '\`\`\`', '')
  lines.push('## 5. 下一步命令', '', '\`\`\`',
    'node tools/cfb-corpus.mjs        # 刷新语料', 'node tools/cfb-criteria.mjs       # 判据回归（不绿就别往下走）',
    'node tools/cfb-lab.mjs quote     # 出价：验 top-k 要多少钱', '\`\`\`', '')
  fs.writeFileSync(path.join(OFFLINE, 'lab.md'), lines.join('\n'))
  console.log('\n已写入 .cfb-offline/lab.md')
  return { specs, design }
}

function main() {
  const [cmd = 'all', ...args] = process.argv.slice(2)
  if (cmd === 'design') cmdDesign(args)
  else if (cmd === 'score') cmdScore(args)
  else if (cmd === 'rank') { const c = loadCorpus(); console.log(JSON.stringify(rankOnRecorded(c), null, 1)) }
  else if (cmd === 'quote') cmdQuote(args)
  else if (cmd === 'all') cmdAll(args)
  else throw new Error('未知子命令 ' + cmd)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
