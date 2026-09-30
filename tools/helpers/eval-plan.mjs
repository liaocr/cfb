// 零成本计划装配与客观归因；不连接任何模型。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as I from '../../index.js'
import { buildMessagesMR, callsOf, ruleMetrics, actionClass } from '../effect-mr.mjs'
import { mrMessages } from '../compile-mr.mjs'
import { TOOLS, responseText } from '../effect-eval.mjs'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { MINIMAL_TASK_IDS, APPROVED_API_LIMITS, APPROVED_API_LIMITS_V2 } from './api-budget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const TASK_IDS = MINIMAL_TASK_IDS
const INPUT_FILES = Object.freeze(['transfer/mr/chains.json', 'transfer/direct-d9a-r.json', 'transfer/mr/auto-d2d.json', 'tools/effect-mr-specs.json'])
const SOURCE_FILES = Object.freeze([...INPUT_FILES, 'index.js', ...fs.readdirSync(path.join(ROOT, 'src')).filter((p) => p.endsWith('.js')).sort().map((p) => 'src/' + p), ...fs.readdirSync(path.join(ROOT, 'tools/helpers')).filter((p) => p.endsWith('.mjs')).sort().map((p) => 'tools/helpers/' + p), 'tools/bounded-ab.mjs', 'tools/effect-ready.mjs', 'tools/effect-eval.mjs', 'tools/effect-mr.mjs', 'tools/compile-mr.mjs'])
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
  const variants = {}, evaluation = {}
  for (const id of TASK_IDS) {
    const chain = chains.find((c) => c.id === id), spec = specs.find((s) => s.id === id)
    if (!chain?.a1?.raw || !chain.a2?.raw || !spec?.obs?.red?.followup) throw new Error('frozen-chain-missing:' + id)
    const r1 = validRow(d1, id).text, prior = validRow(d2, id)
    // 与 compile-mr --recompile 同口径，只消费已捕获 side；不增加一次副模型请求。
    const calls = callsOf(chain.a2.content), callBlock = I.turnCallsBlock(calls)
    const ctx = I.buildCompressCtx(mrMessages(chain, r1)) + (callBlock ? '\n\n' + callBlock : '')
    const gate = I.compileV4Direct(prior.side, chain.a2.raw, I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: ctx }))
    if (!gate.ok || I.inventedIdentifiers(chain.a2.raw, gate.text, { extra: ctx + '\n' + I.programPartsText(ctx) }).length) throw new Error('frozen-recompile-rejected:' + id)
    evaluation[id] = { chain: { id, a1Call: chain.a1Call, a2Edit: chain.a2Edit, verifyCmd: chain.verifyCmd }, spec: { obs: { red: { next: spec.obs.red.next, avoid: spec.obs.red.avoid, expectClaim: spec.obs.red.expectClaim } } } }
    variants[id] = { r1, r2: gate.text, raw1Chars: chain.a1.raw.length, raw2Chars: chain.a2.raw.length, variant1Chars: r1.length, variant2Chars: gate.text.length }
    // 同一 canned red 观察。逐任务/逐样本交错，sample1反转以平衡先后顺序；仅 reasoning_content 不同。
    for (let sample = 0; sample < 2; sample++) for (const variant of sample === 0 ? ['raw', 'current'] : ['current', 'raw']) {
      const a = variant === 'raw' ? chain.a1.raw : r1, b = variant === 'raw' ? chain.a2.raw : gate.text
      jobs.push({ key: `${id}|${variant}|${sample}`, kind: 'main', task: id, variant, sample, obs: 'red', body: { model, messages: buildMessagesMR(chain, a, b, spec.obs.red.followup), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 4096, stream: false } })
    }
  }
  const sourceHashes = currentSourceHashes()
  return immutableJson({ schema: 'cfb.bounded-ab/1', approvalDate: '2026-09-30', model, baseUrl, pricing, canary, limits: APPROVED_API_LIMITS, sourceDigest: evidenceDigest(sourceHashes), sourceHashes, variants, evaluation, jobs, protocol: 'chat-completions-history-reasoning/1',
    preregistration: { expectedGain: 'flaky 的下一步类别；wrong-model/eacces 近似不变', metrics: ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid', 'action'], limitation: '已知开发 canned red 观察；规则下一步合规不等于修复完成或独立泛化；无 Likert/评委。' } })
}
// v2（用户2026-10-01新批准）：同一冻结矩阵与canary，附3个同体备用探针；仅在前一探针网络类失败后启用，成功后其余跳过不派发。
export function buildBoundedPlanV2(options = {}) {
  const base = buildMinimalPlan(options)
  const probe = base.jobs[0]
  const jobs = [probe, { ...probe, key: 'probe-r1' }, { ...probe, key: 'probe-r2' }, ...base.jobs.slice(1)]
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/2', approvalDate: '2026-10-01', limits: APPROVED_API_LIMITS_V2, jobs })
}
export function currentSourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map((p) => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex')]))
}
export function sourceDifferences(plan) {
  const current = currentSourceHashes()
  return [...new Set([...Object.keys(current), ...Object.keys(plan.sourceHashes || {})])].filter((p) => current[p] !== plan.sourceHashes?.[p]).sort()
}
export function resultOf(plan, job, r) {
  const frozen = plan.evaluation[job.task], text = responseText(r.message)
  return { task: job.task, variant: job.variant, sample: job.sample, rule: ruleMetrics(frozen.chain, frozen.spec, 'red', text), action: actionClass(frozen.chain, text) }
}
export function summarizeMinimal(plan, results) {
  const metrics = ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid'], unique = new Map(), rejected = [], duplicateKeys = new Set()
  for (const r of results) {
    const key = `${r.task}|${r.variant}|${r.sample}`
    if (!plan.jobs.some((j) => j.kind === 'main' && j.key === key) || typeof r.action !== 'string' || metrics.some((k) => ![0, 1].includes(r.rule?.[k]))) { rejected.push('sample-shape'); continue }
    if (unique.has(key)) { duplicateKeys.add(key); rejected.push('duplicate-sample') } else unique.set(key, r)
  }
  for (const k of duplicateKeys) unique.delete(k)
  const valid = [...unique.values()]
  const cells = TASK_IDS.map((task) => ({ task, ...Object.fromEntries(['raw', 'current'].map((variant) => {
    const paired = valid.filter((r) => r.task === task && r.variant === variant && valid.some((p) => p.task === task && p.sample === r.sample && p.variant !== variant))
    return [variant, { samples: paired.length, ...Object.fromEntries(metrics.map((m) => [m, paired.reduce((n, r) => n + r.rule[m], 0)])), actions: paired.map((r) => r.action) }]
  })) }))
  return { complete: valid.length === 12 && !rejected.length, validMainResponses: valid.length, pairedMainResponses: cells.reduce((n, c) => n + c.raw.samples + c.current.samples, 0), rejectedSamples: rejected, cells, limitation: plan.preregistration.limitation }
}
