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
import { MINIMAL_TASK_IDS, APPROVED_API_LIMITS, APPROVED_API_LIMITS_V2, APPROVED_API_LIMITS_V4, APPROVED_API_LIMITS_V5, APPROVED_API_LIMITS_V8, DRAFT_BLOCK_PREFIX, DRAFT_BLOCK_SUFFIX, planVersion } from './api-budget.mjs'

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
export function buildMinimalPlan({ model = 'deepseek-v4.1-flash', baseUrl = 'https://api.a6api.com/v1', pricing = null, canary = 'CFB_CANARY_' + crypto.randomBytes(16).toString('hex'), samples = 2 } = {}) {
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
    for (let sample = 0; sample < samples; sample++) for (const variant of sample % 2 === 0 ? ['raw', 'current'] : ['current', 'raw']) {
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
// v3（用户2026-10-01批准，生产等价可见协议）：【前提已更正，见v8】当时以为通道丢弃reasoning历史；
// raw臂=思考已丢的现实（无任何payload），current臂=压缩稿以冻结定界符可见拼接。两臂其余逐字节一致。
export function buildVisiblePlanV3(options = {}) {
  const base = buildBoundedPlanV2(options), canary = base.canary
  const probeBody = { model: base.model, stream: false, thinking: { type: 'enabled' }, max_tokens: 512, messages: [
    { role: 'user', content: '下面这条回复里包含一个标记，请记住它。' },
    { role: 'assistant', content: '收到，标记是 ' + canary + '，我已记住。' },
    { role: 'user', content: '逐字返回上一条回复中的标记。只输出标记本身，不解释，不加任何其他字符。' },
  ] }
  const jobs = base.jobs.map((job) => {
    if (job.kind === 'probe') return { ...job, body: probeBody }
    const messages = job.body.messages.map(({ reasoning_content, ...m }) =>
      job.variant === 'current' && typeof reasoning_content === 'string' && m.role === 'assistant'
        ? { ...m, content: DRAFT_BLOCK_PREFIX + reasoning_content + DRAFT_BLOCK_SUFFIX + m.content }
        : m)
    return { ...job, body: { ...job.body, messages } }
  })
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/3', approvalDate: '2026-10-01', jobs,
    protocol: 'chat-completions-visible-context/1',
    preregistration: {
      expectedGain: 'current(可见压缩稿)相对raw(思考已丢)在三题red上 falseDone/repeat 降低、next/avoid 提高，flaky 差异最大；若 raw 反超净指标先归因，不庆祝',
      metrics: ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid', 'action'],
      limitation: '【前提已于2026-10-01被v8推翻】当时以为通道丢弃reasoning历史；实际是聚合站内部分故障商户的上游丢弃，换商户后历史reasoning逐字进上下文。本协议按原样封存、不改分；净价值结论改由v8的reasoning回放协议给出。vllm指纹为中转自报连续性锚；canned red非独立泛化，无Likert/评委。' } })
}
// v4＝v3的输出预算修正：主请求max_tokens 4096→8192（v3实测current臂thinking+稿块烧穿4096被length截断），
// 且response-incomplete降级为样本级失败（收费/不重发/计入sampleFailureBudget=3）。对照关系与v3逐字节同构。
export function buildVisiblePlanV4(options = {}) {
  const base = buildVisiblePlanV3(options)
  const jobs = base.jobs.map((job) => job.kind === 'main' ? { ...job, body: { ...job.body, max_tokens: 8192 } } : job)
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/4', limits: APPROVED_API_LIMITS_V4, jobs,
    preregistration: { ...base.preregistration,
      limitation: base.preregistration.limitation + ' v3首个current样本在4096被length截断（收费作废、计划按旧语义停机）；v4提高输出预算并把截断记为样本级失败，截断本身作为「稿块是否延长思考」的观察量如实报告。' } })
}
// v5（用户2026-10-01「全面推进下一步」批准）：v4可见协议矩阵扩为6样本/格（36主+3探针），
// 效果判据预注册为claimOfV2（排除事件名词短语误配）；对照不变、通道闸不变、输出预算8192继承v4。
export function buildExpandedPlanV5(options = {}) {
  const base = buildMinimalPlan({ ...options, samples: 6 }), canary = base.canary
  const probeBody = { model: base.model, stream: false, thinking: { type: 'enabled' }, max_tokens: 512, messages: [
    { role: 'user', content: '下面这条回复里包含一个标记，请记住它。' },
    { role: 'assistant', content: '收到，标记是 ' + canary + '，我已记住。' },
    { role: 'user', content: '逐字返回上一条回复中的标记。只输出标记本身，不解释，不加任何其他字符。' },
  ] }
  const probe = { ...base.jobs[0], body: probeBody }
  const jobs = [probe, { ...probe, key: 'probe-r1' }, { ...probe, key: 'probe-r2' }, ...base.jobs.slice(1).map((job) => {
    const messages = job.body.messages.map(({ reasoning_content, ...m }) =>
      job.variant === 'current' && typeof reasoning_content === 'string' && m.role === 'assistant'
        ? { ...m, content: DRAFT_BLOCK_PREFIX + reasoning_content + DRAFT_BLOCK_SUFFIX + m.content }
        : m)
    return { ...job, body: { ...job.body, messages, max_tokens: 8192 } }
  })]
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/5', approvalDate: '2026-10-01', limits: APPROVED_API_LIMITS_V5, jobs,
    protocol: 'chat-completions-visible-context/1',
    preregistration: {
      expectedGain: 'n=6/格、claimOfV2判据下：current相对raw在wrong-model的falseDone降低；flaky动作分布向instrument/reread偏移且falseDone为0:0；eacces近似不变；任一任务raw净反超则先归因不庆祝',
      metrics: ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid', 'action'],
      claimVersion: 2,
      limitation: '【前提已于2026-10-01被v8推翻】当时以为通道丢弃reasoning历史（实为聚合站内故障商户所致）；raw臂常零正文、文本类指标两臂不对称（结构性偏差照记）；vllm指纹为中转自报连续性锚；canned red非独立泛化，无Likert/评委。' } })
}
// v6＝v5语义修正版（v5探针死于空reasoning硬停）：探针免思考要求；主请求逐响应验证失败→样本级(预算6)。矩阵/判据/对照与v5一致。
export function buildExpandedPlanV6(options = {}) {
  const base = buildExpandedPlanV5(options)
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/6',
    preregistration: { ...base.preregistration,
      limitation: base.preregistration.limitation + ' v5探针因空reasoning被channel-no-thinking整停（收据封存）；v6探针只测可见echo保真，主请求思考要求保留、逐响应验证失败按样本级计（预算6），每个accepted样本仍逐个过全部闸。' } })
}
// v7＝v6的指纹政策修正：池轮换使钉死fp数小时即失效（v6探针死于此）。fp放开但逐响应记录并公开直方图；
// 身份证据=型号精确+canary逐字回显+思考在跑+usage界；其余语义与v6一致。
export function buildExpandedPlanV7(options = {}) {
  const base = buildExpandedPlanV6(options)
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/7',
    preregistration: { ...base.preregistration,
      limitation: base.preregistration.limitation + ' v6探针死于池轮换后的channel-fingerprint（诊断：fp已变null且echo正常）；v7不设fp闸，逐响应记录fp并在报告公开直方图与配对同指纹计数，混池噪声由样本序交错对称化，身份证据回归实质闸。' } })
}
// v8（2026-10-01，**前提更正后的复跑**）：v3–v7 的「可见协议」建立在『通道丢弃历史 reasoning』之上，而该前提是聚合站内
// 故障商户造成的假象。换商户后 canary 复测证明历史 reasoning_content 逐字进入上下文（Δprompt 539、剂量-反应线性）。
// ⇒ v8 回到 v1 的**生产等价 reasoning 回放协议**：raw 臂＝录制原文 reasoning，current 臂＝压缩稿替换同一位置，
//    两臂其余逐字节一致（这正是 cfb 在生产里真正做的事）。判据升级 claimVersion 3（把 v7 五例伪阳性写成回归）。
export function buildReasoningReplayPlanV8(options = {}) {
  const base = buildMinimalPlan({ samples: 2, ...options })
  const probe = base.jobs[0]
  const jobs = [probe, { ...probe, key: 'probe-r1' }, { ...probe, key: 'probe-r2' },
    ...base.jobs.slice(1).map((job) => ({ ...job, body: { ...job.body, max_tokens: 8192 } }))]
  return immutableJson({ ...base, schema: 'cfb.bounded-ab/8', approvalDate: '2026-10-01', limits: APPROVED_API_LIMITS_V8, jobs,
    protocol: 'chat-completions-history-reasoning/1',
    preregistration: {
      expectedGain: 'claimOfV3 判据下（v7 五例伪阳性已回归）：current(压缩稿回放)相对 raw(原文回放) 在 flaky 的 falseDone/bump/reEdit/repeat 降低、next/avoid 提高；wrong-model/eacces 近似不变；任一任务 raw 净反超则先归因不庆祝',
      metrics: ['falseDone', 'bump', 'reEdit', 'repeat', 'next', 'avoid', 'action'],
      claimVersion: 3,
      limitation: '本协议测试的是「压缩稿 vs 原文」在 reasoning 可见前提下的净效果，这才是生产的真实对照；v3–v7 的可见协议结论按其冻结判据存档、不改分、不追溯。fp=null（池轮换，身份证据=型号+canary逐字回显+思考在跑+usage界）；canned red 非独立泛化；无 Likert/评委；n=2/格为小样本。' } })
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
  // 判据按 scope 版本冻结：v8起 claimOfV3；v5–v7 为 claimOfV2；v1–v4 为 claimOf。互不追溯。
  const claimVersion = planVersion(plan) >= 8 ? 3 : planVersion(plan) >= 5 ? 2 : 1
  return { task: job.task, variant: job.variant, sample: job.sample, rule: ruleMetrics(frozen.chain, frozen.spec, 'red', text, { claimVersion }), action: actionClass(frozen.chain, text) }
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
  return { complete: valid.length === plan.jobs.filter((j) => j.kind === 'main').length && !rejected.length, validMainResponses: valid.length, pairedMainResponses: cells.reduce((n, c) => n + c.raw.samples + c.current.samples, 0), rejectedSamples: rejected, cells, limitation: plan.preregistration.limitation }
}
