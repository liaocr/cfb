#!/usr/bin/env node
// tools/acon-optimize.mjs —— 抽取式压缩准则的自我改进回路（ACON 对比失败分析 × GEPA 反思式进化）
//
// 进化对象：cfg.extractiveGuideline（追加在 src/extractive.js 缺省规则之后的补充准则）。
// 每一代：
//   ① 用 cf-eval 评当前准则（x1）与 raw 基线（raw 只评一次、缓存）；
//   ② UT 步（utility，ACON）：挑出「raw 续写成功、x1 续写失败」的对比对，
//      连同原文、压缩稿、参考动作、两边实际动作交给优化模型，问「压缩稿丢了什么」，产出修订准则；
//      没有失败对 ⇒ CO 步（compression）：问「在不丢成功的前提下还能删什么」，产出更紧的准则；
//   ③ 每代产出 --candidates 个候选，逐一评测；score = successRate − λ·keptRatio；
//   ④ 维护 (successRate↑, keptRatio↓) 的 Pareto 前沿；score 超过现任才换代（GEPA 的「只收改进」）。
// 产物（--out-dir）：guideline.best.txt、history.json（每个候选的指标与准则全文）、patch-snippet.txt。
//
// ⚠ 离线工具：会真实调用端点（主模型 × samples × fixtures × 候选数 × 代数），先用小 fixture 集试算费用。
// ⚠ 产物不会自动上线：把 guideline.best.txt 的内容贴进 patch 的 extractiveGuideline 才生效；
//   promptVersion 会带 ':g<指纹>'，线上 trace 自动按准则分桶。
//
// 用法：
//   node tools/acon-optimize.mjs --fixtures tools/cf-fixtures --base-url https://api.deepseek.com \
//        --api-key-env DEEPSEEK_API_KEY --model deepseek-reasoner --compressor-model deepseek-chat \
//        --optimizer-model deepseek-reasoner --iterations 3 --candidates 2 --samples 3 --out-dir acon-out
//   其它：--guideline-file g0.txt（起点） --lambda 0.3 --max-failures 4 --max-guideline-chars 900
//         以及 cf-eval 的全部参数（--extra-body / --compressor-extra-body / --tail-chars …）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXTRACTIVE_BASE_RULES } from '../src/extractive.js'
import { parseArgs as parseEvalArgs, makeClient, loadFixtures, runEval, contrastivePairs, printSummary, cacheKey } from './cf-eval.mjs'

export function parseArgs(argv) {
  const own = { iterations: 3, candidates: 2, lambda: 0.3, maxFailures: 4, maxGuidelineChars: 900, outDir: 'acon-out' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--optimizer-model') own.optimizerModel = v()
    else if (a === '--iterations') own.iterations = Number(v())
    else if (a === '--candidates') own.candidates = Number(v())
    else if (a === '--lambda') own.lambda = Number(v())
    else if (a === '--max-failures') own.maxFailures = Number(v())
    else if (a === '--max-guideline-chars') own.maxGuidelineChars = Number(v())
    else if (a === '--out-dir') own.outDir = v()
    else rest.push(a)
  }
  const ev = parseEvalArgs(rest)
  return { ...ev, ...own, variants: ['raw', 'x1'] }
}

const clip = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + '\n…（中略 ' + (s.length - n) + ' 字符）…\n' + s.slice(-Math.floor(n * 0.4)) }
const fmtExpect = (e) => JSON.stringify(e || {})

// v11.13 r2：压缩稿里会出现支线标记，优化器必须知道它们是什么，才能判断「丢的是支线内部的有用事实」这一类失败
const R2_NOTE = '（另：已放下的尝试会被折叠——只留提出假设的句子与否定理由句，句末标 ⟨已否定·seqN⟩ / ⟨已放弃⟩；⟨搁置⟩ 表示暂时放下但未被否定、内部未删。含报错的具体句子会被自动补回。）'

/** UT 步提示词：对比失败分析 → 修订准则。 */
export function buildUtilityPrompt(guideline, failures, maxChars) {
  const L = []
  L.push('你在优化一个「推理记录选句器」的补充准则。选句器从 Agent 的思维链里挑出要保留的句子（原文逐字、按原顺序），其余删掉；后续主模型只能看到保留下来的句子。')
  L.push('')
  L.push('选句器的固定规则：')
  EXTRACTIVE_BASE_RULES.forEach((r, i) => L.push((i + 1) + '. ' + r))
  L.push(R2_NOTE)
  L.push('')
  L.push('当前补充准则：')
  L.push(String(guideline || '').trim() || '（空）')
  L.push('')
  L.push('下面是若干失败案例：用**原文**续写时主模型做对了，用**压缩稿**续写时做错了。')
  failures.forEach((f, k) => {
    L.push('')
    L.push('━━ 案例 ' + (k + 1) + '（' + f.id + '，成功率差 ' + f.gap + '）')
    L.push('期望的下一步 / 应避免 / 不得违反：' + fmtExpect(f.expect))
    L.push('原文续写的动作：' + JSON.stringify(f.rawActions).slice(0, 600))
    L.push('压缩稿续写的动作：' + JSON.stringify(f.variantActions).slice(0, 600))
    for (const b of f.blocks.slice(0, 2)) {
      L.push('【原文 msg#' + b.index + '】\n' + clip(b.raw, 2500))
      L.push('【压缩稿 msg#' + b.index + '】\n' + clip(b.text, 1500))
    }
  })
  L.push('')
  L.push('任务：逐案找出压缩稿**丢了哪类句子/信息**才导致续写出错（例如：否定某条路径的理由、用户约束、一个中间结论、计划的后半段、被折叠支线里后续仍要用的事实）。')
  L.push('然后写出修订后的**完整**补充准则：每条一句、可操作、说清「什么样的句子必须留」或「什么样的句子可以删」，不要针对具体文件名或具体案例。')
  L.push('保留当前准则中仍然有用的条目；总长度不超过 ' + maxChars + ' 字符。只输出准则正文，每行一条，不要编号以外的任何解释。')
  return L.join('\n')
}

/** CO 步提示词：没有失败时，尝试在不伤害成功的前提下删得更多。 */
export function buildCompressionPrompt(guideline, successes, maxChars) {
  const L = []
  L.push('你在优化一个「推理记录选句器」的补充准则。当前准则下，压缩稿续写全部成功。现在要在**不损失成功率**的前提下让压缩稿更短。')
  L.push('')
  L.push('固定规则：')
  EXTRACTIVE_BASE_RULES.forEach((r, i) => L.push((i + 1) + '. ' + r))
  L.push(R2_NOTE)
  L.push('')
  L.push('当前补充准则：')
  L.push(String(guideline || '').trim() || '（空）')
  successes.forEach((s, k) => {
    L.push('')
    L.push('━━ 成功案例 ' + (k + 1) + '（' + s.id + '，保留比例 ' + s.keptRatio + '）')
    for (const b of s.blocks.slice(0, 1)) L.push('【压缩稿】\n' + clip(b.text, 1500))
  })
  L.push('')
  L.push('任务：指出这些压缩稿里哪一类句子对后续动作没有贡献，把「可以删」的规则写进准则。保留仍有用的条目；总长度不超过 ' + maxChars + ' 字符。只输出准则正文，每行一条。')
  return L.join('\n')
}

export function cleanGuideline(text, maxChars) {
  let s = String(text || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  s = s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
  return s.length > maxChars ? s.slice(0, maxChars).replace(/\n[^\n]*$/, '') : s
}

export const scoreOf = (m, lambda) => (m.successRate ?? 0) - lambda * (m.keptRatio ?? 1)

/** (successRate↑, keptRatio↓) 的非支配集。 */
export function paretoFront(items) {
  return items.filter((a) => !items.some((b) => b !== a
    && (b.successRate ?? 0) >= (a.successRate ?? 0) && (b.keptRatio ?? 1) <= (a.keptRatio ?? 1)
    && ((b.successRate ?? 0) > (a.successRate ?? 0) || (b.keptRatio ?? 1) < (a.keptRatio ?? 1))))
}

/**
 * 主回路（可注入 chat/compressor/optimizer 以便本机测试）。
 * @returns {{ best, history, front }}
 */
export async function optimize(opts, deps, log = console.log) {
  const cache = new Map()
  const fixtures = deps.fixtures
  const evalWith = async (guideline, variants) => {
    const o = { ...opts, guideline, variants }
    const rep = await runEval(o, { chat: deps.chat, compressor: deps.compressor, fixtures, cache })
    return { rep, o }
  }
  // 基线：raw 只评一次
  const base = await evalWith(opts.guideline || '', ['raw', 'x1'])
  printSummary(base.rep.summary, log)
  const metricsOf = (rep) => ({ successRate: rep.summary.x1.successRate, keptRatio: rep.summary.x1.keptRatio,
    avoidRate: rep.summary.x1.avoidRate, violateRate: rep.summary.x1.violateRate, promptTokens: rep.summary.x1.promptTokens,
    compressFallbacks: rep.summary.x1.compressFallbacks })
  const rawRow = new Map(base.rep.perFixture.map((r) => [r.id, r.variants.raw]))
  const withRaw = (rep) => ({ ...rep, perFixture: rep.perFixture.map((r) => ({ ...r, variants: { ...r.variants, raw: rawRow.get(r.id) } })) })

  let cur = { gen: 0, guideline: opts.guideline || '', ...metricsOf(base.rep), rep: base.rep, o: base.o }
  cur.score = scoreOf(cur, opts.lambda)
  const history = [{ gen: 0, step: 'baseline', guideline: cur.guideline, ...metricsOf(base.rep), score: cur.score, raw: { successRate: base.rep.summary.raw.successRate, promptTokens: base.rep.summary.raw.promptTokens } }]
  log('gen0 score=' + cur.score.toFixed(4) + ' success=' + cur.successRate + ' kept=' + cur.keptRatio)

  for (let gen = 1; gen <= opts.iterations; gen++) {
    const pairs = contrastivePairs(withRaw(cur.rep), 'x1', fixtures, cache, cur.o).slice(0, opts.maxFailures)
    let step, prompt
    if (pairs.length) { step = 'utility'; prompt = buildUtilityPrompt(cur.guideline, pairs, opts.maxGuidelineChars) }
    else {
      step = 'compression'
      const succ = cur.rep.perFixture.map((r) => {
        const b = cache.get(cacheKey(r.id, 'x1', cur.o))
        const kept = b && b.blocks.length ? b.blocks.reduce((n, x) => n + x.outChars / Math.max(1, x.rawChars), 0) / b.blocks.length : null
        return { id: r.id, keptRatio: kept == null ? null : +kept.toFixed(3), blocks: b ? b.blocks : [] }
      }).filter((s) => s.blocks.length).sort((a, b) => (b.keptRatio ?? 0) - (a.keptRatio ?? 0)).slice(0, opts.maxFailures)
      if (!succ.length) { log('gen' + gen + ': 没有可分析的块（fixture 里没有达到 --min-chars 的推理块），停止'); break }
      prompt = buildCompressionPrompt(cur.guideline, succ, opts.maxGuidelineChars)
    }
    log('gen' + gen + ' step=' + step + ' pairs=' + pairs.length)
    const cands = []
    for (let c = 0; c < opts.candidates; c++) {
      let g
      try {
        const r = await deps.optimizer({ model: opts.optimizerModel || opts.model, messages: [{ role: 'user', content: prompt }], max_tokens: 3000,
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}) })
        g = cleanGuideline(r.message.content, opts.maxGuidelineChars)
      } catch (e) { log('  candidate ' + c + ' optimizer error: ' + (e.message || e)); continue }
      if (!g || g === cur.guideline || cands.some((x) => x.guideline === g)) continue
      const ev = await evalWith(g, ['x1'])
      const m = metricsOf(ev.rep)
      const cand = { gen, step, guideline: g, ...m, score: scoreOf(m, opts.lambda), rep: ev.rep, o: ev.o }
      cands.push(cand)
      history.push({ gen, step, guideline: g, ...m, score: cand.score })
      log('  cand' + c + ' score=' + cand.score.toFixed(4) + ' success=' + m.successRate + ' kept=' + m.keptRatio)
    }
    const best = cands.sort((a, b) => b.score - a.score)[0]
    if (best && best.score > cur.score) { cur = best; log('  ⇒ 换代（score ' + best.score.toFixed(4) + '）') }
    else log('  ⇒ 保持现任')
  }
  const front = paretoFront(history)
  return { best: { gen: cur.gen, guideline: cur.guideline, successRate: cur.successRate, keptRatio: cur.keptRatio, score: cur.score }, history, front }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.fixtures || !opts.baseUrl || !opts.model) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
    process.exit(opts.help ? 0 : 2)
  }
  const apiKey = process.env[opts.apiKeyEnv] || ''
  const chat = makeClient({ baseUrl: opts.baseUrl, apiKey })
  const compressor = makeClient({ baseUrl: opts.compressorBaseUrl || opts.baseUrl, apiKey })
  const r = await optimize(opts, { chat, compressor, optimizer: chat, fixtures: loadFixtures(opts.fixtures) })
  fs.mkdirSync(opts.outDir, { recursive: true })
  fs.writeFileSync(path.join(opts.outDir, 'guideline.best.txt'), r.best.guideline + '\n')
  fs.writeFileSync(path.join(opts.outDir, 'history.json'), JSON.stringify({ tool: 'acon-optimize', at: new Date().toISOString(), lambda: opts.lambda, best: r.best, front: r.front, history: r.history }, null, 2))
  fs.writeFileSync(path.join(opts.outDir, 'patch-snippet.txt'), 'compressPrompt: x1\nextractiveGuideline: ' + JSON.stringify(r.best.guideline) + '\n')
  console.log('best gen' + r.best.gen + ' success=' + r.best.successRate + ' kept=' + r.best.keptRatio + ' → ' + opts.outDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.stack || e); process.exit(1) })
}
