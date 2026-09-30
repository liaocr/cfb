#!/usr/bin/env node
// 本次 USD2 / 13 dispatch 专用入口；默认只冻结预注册，--run 才能调用模型。
// 不导入旧 runner 的 main，不建链、不压新稿、不请评委、不因坏渠道重发。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { buildMessagesMR, callsOf, ruleMetrics, actionClass } from './effect-mr.mjs'
import { mrMessages } from './compile-mr.mjs'
import { TOOLS, responseText } from './effect-eval.mjs'
import { evidenceDigest, immutableJson } from '../src/evidence-program.js'
import { auditApiPlan, createBudgetedChat, inputTokenBound, APPROVED_API_LIMITS } from './helpers/api-budget.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, '.cfb-runtime/bounded-ab')
const TASK_IDS = Object.freeze(['flaky-timeout', 'wrong-model', 'eacces-config'])
const INPUT_FILES = Object.freeze(['transfer/mr/chains.json', 'transfer/direct-d9a-r.json', 'transfer/mr/auto-d2d.json', 'tools/effect-mr-specs.json'])
const SOURCE_FILES = Object.freeze([...INPUT_FILES, 'index.js', ...fs.readdirSync(path.join(ROOT, 'src')).filter((p) => p.endsWith('.js')).sort().map((p) => 'src/' + p), 'tools/bounded-ab.mjs', 'tools/helpers/api-budget.mjs', 'tools/effect-eval.mjs', 'tools/effect-mr.mjs', 'tools/compile-mr.mjs'])
const jsonFile = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
const validRow = (rows, id) => {
  const row = rows.find((r) => r.id === id && r.accept === 'ok' && /^condensed/.test(r.why) && typeof r.text === 'string' && r.text)
  if (!row) throw new Error('frozen-variant-missing:' + id)
  return row
}
export function buildMinimalPlan({ model = 'deepseek-v4.1-flash', baseUrl = 'https://api.a6api.com/v1', pricing = null, canary = 'CFB_CANARY_' + crypto.randomBytes(16).toString('hex') } = {}) {
  const { chains } = jsonFile(INPUT_FILES[0]), d1 = jsonFile(INPUT_FILES[1]).rows, d2 = jsonFile(INPUT_FILES[2]).rows, specs = jsonFile(INPUT_FILES[3])
  const jobs = [{ key: 'probe', kind: 'probe', body: { model, stream: false, thinking: { type: 'enabled' }, max_tokens: 512, messages: [
    { role: 'user', content: '记住一个只在推理中保存的标记。' },
    { role: 'assistant', content: '标记已记住。', reasoning_content: '我只在这一轮推理里记住了标记 ' + canary + '，可见回答不含它。' },
    { role: 'user', content: '逐字返回上一轮推理中的标记。只输出标记，不猜测，不解释。' },
  ] } }]
  const variants = {}
  for (const id of TASK_IDS) {
    const chain = chains.find((c) => c.id === id), spec = specs.find((s) => s.id === id)
    if (!chain?.a1?.raw || !chain.a2?.raw || !spec?.obs?.red?.followup) throw new Error('frozen-chain-missing:' + id)
    const r1 = validRow(d1, id).text, prior = validRow(d2, id)
    // 与 compile-mr --recompile 同口径，只消费已捕获 side；不增加一次副模型请求。
    const calls = callsOf(chain.a2.content), callBlock = I.turnCallsBlock(calls)
    const ctx = I.buildCompressCtx(mrMessages(chain, r1)) + (callBlock ? '\n\n' + callBlock : '')
    const gate = I.compileV4Direct(prior.side, chain.a2.raw, I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: ctx }))
    if (!gate.ok || I.inventedIdentifiers(chain.a2.raw, gate.text, { extra: ctx + '\n' + I.programPartsText(ctx) }).length) throw new Error('frozen-recompile-rejected:' + id)
    variants[id] = { r1, r2: gate.text, raw1Chars: chain.a1.raw.length, raw2Chars: chain.a2.raw.length, variant1Chars: r1.length, variant2Chars: gate.text.length }
    // 同一 canned red 观察。逐任务/逐样本交错 raw 与一个变体；仅 reasoning_content 不同。
    for (let sample = 0; sample < 2; sample++) for (const variant of ['raw', 'current']) {
      const a = variant === 'raw' ? chain.a1.raw : r1, b = variant === 'raw' ? chain.a2.raw : gate.text
      jobs.push({ key: `${id}|${variant}|${sample}`, kind: 'main', task: id, variant, sample, obs: 'red', body: { model, messages: buildMessagesMR(chain, a, b, spec.obs.red.followup), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 4096, stream: false } })
    }
  }
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((p) => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex')]))
  return immutableJson({ schema: 'cfb.bounded-ab/1', approvalDate: '2026-09-30', model, baseUrl, pricing, canary, limits: APPROVED_API_LIMITS, sourceDigest: evidenceDigest(sourceHashes), sourceHashes, variants, jobs,
    preregistration: { expectedGain: 'flaky 的下一步类别；wrong-model/eacces 近似不变', metrics: ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid', 'action'], limitation: '已知开发 canned red 观察；规则下一步合规不等于修复完成或独立泛化；无 Likert/评委。' } })
}
export function summarizeMinimal(plan, results) {
  const metrics = ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid']
  const cells = TASK_IDS.map((task) => ({ task, ...Object.fromEntries(['raw', 'current'].map((variant) => {
    // 只比较同任务、同 sample 的完整配对，不拿单边成功行算赢。
    const paired = results.filter((r) => r.task === task && r.variant === variant && results.some((p) => p.task === task && p.sample === r.sample && p.variant !== variant))
    return [variant, { samples: paired.length, ...Object.fromEntries(metrics.map((m) => [m, paired.reduce((n, r) => n + r.rule[m], 0)])), actions: paired.map((r) => r.action) }]
  })) }))
  return { complete: results.length === 12, validMainResponses: results.length, pairedMainResponses: cells.reduce((n, c) => n + c.raw.samples + c.current.samples, 0), cells, limitation: plan.preregistration.limitation }
}

async function main(argv) {
  let run = false, pricingFile = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') run = true
    else if (argv[i] === '--plan') run = false
    else if (argv[i] === '--pricing') pricingFile = argv[++i]
    else throw new Error('未知参数：' + argv[i])
  }
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
  const frozenPath = path.join(OUT, 'plan.json'), existing = fs.existsSync(frozenPath) ? JSON.parse(fs.readFileSync(frozenPath, 'utf8')) : null
  const plan = buildMinimalPlan({ model: process.env.DEEPSEEK_MODEL || existing?.model || 'deepseek-v4.1-flash', baseUrl: process.env.DEEPSEEK_BASE_URL || existing?.baseUrl || 'https://api.a6api.com/v1', pricing: pricingFile ? JSON.parse(fs.readFileSync(pricingFile, 'utf8')) : existing?.pricing || null, canary: existing?.canary })
  // 仅 --plan 且还没有请求台账时可更新冻结稿；已有台账由 planDigest 严格拒绝换稿/改价。
  const blockers = []
  let audit = null
  try { audit = auditApiPlan(plan) } catch (e) { blockers.push(e.message) }
  if (!process.env.DEEPSEEK_API_KEY) blockers.push('api-key-missing')
  const preflight = { schema: 'cfb.bounded-preflight/1', status: blockers.length ? 'blocked' : 'ready', blockers, inputTokenBounds: plan.jobs.map((j) => ({ key: j.key, inputTokens: inputTokenBound(j.body), maxOutputTokens: j.body.max_tokens })), audit, limits: APPROVED_API_LIMITS, sourceDigest: plan.sourceDigest }
  fs.writeFileSync(path.join(OUT, 'preflight.json'), JSON.stringify(preflight, null, 2), { mode: 0o600 })
  if (!run) {
    // 有台账后不覆盖已预注册的 plan；不会删/换 scope 来重新获得预算。
    if (existing && fs.existsSync(path.join(OUT, 'ledger')) && evidenceDigest(existing) !== evidenceDigest(plan)) throw new Error('api-plan-changed')
    fs.writeFileSync(frozenPath, JSON.stringify(plan, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ mode: 'plan-only', status: preflight.status, blockers, mainRequestsPlanned: 12, probeRequestsPlanned: 1, requestsDispatched: 0, costsUsd: 0, maxReservedUsd: audit?.totalReservedUsd ?? null, sourceDigest: plan.sourceDigest }, null, 2))
    return
  }
  if (blockers.length) throw new Error('preflight-blocked:' + blockers.join(','))
  if (!existing || evidenceDigest(existing) !== evidenceDigest(plan)) throw new Error('api-plan-not-frozen:先运行 --plan --pricing FILE')
  const budget = createBudgetedChat({ plan, apiKey: process.env.DEEPSEEK_API_KEY, directory: path.join(OUT, 'ledger') })
  const { chains } = jsonFile(INPUT_FILES[0]), specs = jsonFile(INPUT_FILES[3]), results = []
  let stopped = null
  const ctl = new AbortController(), abort = () => ctl.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    for (const job of plan.jobs) {
      const r = budget.cached(job.key) || await budget.run(job.key, { signal: ctl.signal })
      if (job.kind === 'probe') continue
      const chain = chains.find((c) => c.id === job.task), spec = specs.find((s) => s.id === job.task), text = responseText(r.message)
      results.push({ task: job.task, variant: job.variant, sample: job.sample, rule: ruleMetrics(chain, spec, 'red', text), action: actionClass(chain, text) })
    }
  } catch (e) { stopped = e.message }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
  const state = budget.snapshot(), summary = { ...summarizeMinimal(plan, results), stopped, requestsReserved: state.entries.length, reservedUsd: state.entries.reduce((n, e) => n + e.reservedNano, 0) / 1e9, judgeRequests: 0, retries: 0, sourceDigest: plan.sourceDigest }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
  if (stopped) process.exitCode = 1
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1 })
