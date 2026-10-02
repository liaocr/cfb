// tools/helpers/generation.mjs —— 闭环 v3 的生成层：把「压缩器提示词」变成可搜索的策略（policy），
// 由提议器（LLM 读失败证据 → 文本梯度 → 提示词补丁）生成新策略，由编译计划（压缩器按新策略重压 side）落成候选稿。
//
// 为什么：v14.2 的候选只拨 compileV4Direct 之后的 4 个代码开关，真正的策略（compress-v4d9 提示词）不在搜索空间里，
// 「环是裁判不是生成器」。本层给环一个生成器，而且生成物是生产能原样采用的东西（提示词补丁 = 新的 prompt 版本）。
//
// 钱：全部走与 A/B 同一套账本 / 收据 / 审计（schema cfb.generation/1，scope cfb.generation.2026-10-02.gN，≤ 8 请求 / ≤ USD 0.3 / 次）。
//   compile：池内每题 1 次压缩器调用（temperature 0，与生产同体）；propose：1 次提议器调用；mint：铸造新题的 A/B 两步。
// 防泄漏：提议器只看 dev 题证据；补丁里出现 dev 题特有的标识符 / 数字 ⇒ policy-leak，整份作废（不许把题目答案写进提示词）。
import { applyPolicyPatches, validatePolicyPatches } from '../../src/policy.js'
import crypto from 'node:crypto'
import * as I from '../../index.js'
import { immutableJson, evidenceDigest } from '../../src/evidence-program.js'
import { SYSTEM, ASK, TOOLS } from '../effect-eval.mjs'
import { APPROVED_API_LIMITS_GEN } from './api-budget.mjs'

export const POLICY_SCHEMA = 'cfb.policy/1'
export const GEN_SCHEMA = 'cfb.generation/1'
export const GEN_ROLES = Object.freeze(['compile', 'propose', 'mint-a', 'mint-b'])
export const BASE_POLICY = Object.freeze({ schema: POLICY_SCHEMA, id: 'base', parent: null, base: 'compress-v4d9', patches: [], rationale: '生产现状（src/prompts.js buildCompressPromptV4Direct）', status: 'adopted', sides: {} })
export const PATCH_LIMITS = Object.freeze({ maxPatches: 3, maxAddedChars: 900, maxReplaceChars: 400, maxExemplarChars: 1200 })
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
export const policyId = (policy) => 'p-' + sha(JSON.stringify({ parent: policy.parent || null, patches: policy.patches || [] })).slice(0, 10)

/** 生产压缩器提示词（与 src/distill.js 同一构造；tool=null = 规范工具名）。 */
export function basePrompt(task) { return I.buildCompressPromptV4Direct(task.chain.a2.raw, task.ctx, null) }
/** 提示词的「头」= 规则 + 样例，不含任务上下文与思维链：提议器只看这部分，泄漏闸也只拿这部分当白名单。 */
export function promptHead(task) { return basePrompt(task).split('【当前任务与观察】')[0] }

/** 把补丁应用到提示词 —— v14.10 起直接调用生产的 src/policy.js applyPolicyPatches（评测与生产同一函数，不再各写一份）。 */
export function applyPolicyToPrompt(prompt, policy) { return applyPolicyPatches(prompt, policy?.patches || []) }
/** 补丁预算 + 形状校验（不看内容是否聪明，只看是否越界）。 */
export function validatePatches(patches) {
  if (!Array.isArray(patches) || !patches.length || patches.length > PATCH_LIMITS.maxPatches) throw new Error('policy-patches-count')
  let added = 0
  for (const x of patches) {
    if (x.op === 'append') { if (!['rules', 'tail'].includes(x.section)) throw new Error('policy-patch-section'); added += String(x.text || '').length }
    else if (x.op === 'replace') { if (String(x.from).length > PATCH_LIMITS.maxReplaceChars || String(x.to).length > PATCH_LIMITS.maxReplaceChars) throw new Error('policy-patch-replace-size'); added += Math.max(0, String(x.to).length - String(x.from).length) }
    else if (x.op === 'exemplar') { if (String(x.text || '').length > PATCH_LIMITS.maxExemplarChars) throw new Error('policy-patch-exemplar-size'); if (String(x.text || '').trim().length < 40) throw new Error('policy-patch-exemplar-text') }   // 样例槽替换不计入新增字数（替换同长度量级的样例正文）
    else throw new Error('policy-patch-op')
  }
  if (added > PATCH_LIMITS.maxAddedChars) throw new Error('policy-patches-too-long:' + added)
  validatePolicyPatches(patches)   // v14.10：生产侧校验器也过一遍（normalizeConfig 用的就是它）——评测能落的策略，生产一定能加载
  return true
}
/** 泄漏闸：补丁里的强记号若只出现在 dev 题（u1/u2/raw/followup/spec）而不在基础提示词里 ⇒ 泄漏。 */
const TOKEN_RE = /[A-Za-z_][\w./-]{3,}|\d{3,}/g
export function leakCheck(patches, devTasks, prompt) {
  const text = patches.map((p) => (p.op === 'append' || p.op === 'exemplar' ? p.text : p.to)).join('\n')
  const toks = new Set((text.match(TOKEN_RE) || []).map((t) => t.toLowerCase()))
  const base = (String(prompt).match(TOKEN_RE) || []).map((t) => t.toLowerCase())
  const baseSet = new Set(base)
  // 泄漏 = 补丁里出现「某一道题特有」的标识符（路径 / 带 . _ / 的符号，或只在一道题里出现的词）。
  // 多道题共有的普通英文词（fail / error / test…）不算泄漏：那是领域词，不是题目答案。
  const hays = devTasks.map((t) => ({ id: t.id, hay: [t.chain.u1, t.chain.u2, t.chain.a2?.raw, t.chain.a1?.raw, t.spec?.obs?.red?.followup, JSON.stringify(t.spec?.obs?.red?.reference || {})].join('\n').toLowerCase() }))
  const leaks = []
  for (const tok of toks) {
    if (baseSet.has(tok)) continue
    const hits = hays.filter((h) => h.hay.includes(tok))
    if (!hits.length) continue
    const specific = /[./_]/.test(tok) || /[a-z][A-Z]/.test(tok) || hits.length === 1
    if (specific) for (const h of hits) leaks.push(h.id + ':' + tok)
  }
  return leaks
}

/** 失败证据（只给 dev 题）：输掉 / 打平的配对 + 两臂稿的开头 + 主模型下一步的动作与判据旗标。 */
export function failureEvidence({ history, plans, split, maxItems = 6 }) {
  const items = []
  for (const h of Object.values(history.hypotheses || {})) for (const o of h.outcomes || []) {
    if (split[o.task] === 'holdout' || o.outcome === 'win') continue
    const plan = plans[o.round]; const v = plan?.variants?.[o.task]
    items.push({ round: o.round, hypothesis: h.key, task: o.task, outcome: o.outcome, candidateAction: o.candidateAction, controlAction: o.controlAction, candidateScore: o.candidate, controlScore: o.control,
      controlHead: v ? v.control.slice(0, 500) : null, candidateHead: v ? v.candidate.slice(0, 500) : null, followup: plan?.evaluation?.[o.task]?.spec?.obs?.red?.followup?.slice(0, 300) || null })
    if (items.length >= maxItems) break
  }
  return items
}

/** 提议器消息：优化器角色 + 当前提示词 + 证据 + 严格 JSON 输出合同。 */
export function proposerMessages({ prompt, policy, evidence, devTaskIds }) {
  const sys = '你是「压缩编译器提示词」的优化器。压缩器把上一轮思维链压成一份给下一轮主模型用的稿；稿写得好的标准只有一个：主模型下一步更对（不假宣称修复、不盲改数字、不重复同一编辑、不重跑已知、能走到正确的下一条取证）。\n' +
    '你要做的是：读失败证据，提出对提示词的最小改动（补丁），改动必须是**通用规则**，不能写进任何具体任务的路径、标识符、数字或答案。只输出 JSON，不要解释正文。'
  const user = ['【当前策略】' + (policy.id || 'base') + '（父策略 ' + (policy.parent || '—') + '）；已有补丁：' + JSON.stringify(policy.patches || []),
    '', '【当前提示词（基础版，不含任务上下文与思维链）】', prompt.split('【当前任务与观察】')[0].slice(0, 6000),
    '', '【失败证据（只含开发题：' + devTaskIds.join(', ') + '）】', JSON.stringify(evidence, null, 1).slice(0, 7000),
    '', '【输出合同】只输出一个 JSON 对象：{"patches":[{"op":"append","section":"rules"|"tail","text":"…"} | {"op":"replace","from":"提示词里恰好出现一次的原文","to":"替换文"}],"rationale":"为什么这能改变主模型下一步","prediction":"预计在哪类失败上生效"}',
    '约束：补丁 ≤ ' + PATCH_LIMITS.maxPatches + ' 条，新增文字合计 ≤ ' + PATCH_LIMITS.maxAddedChars + ' 字；不出现任何任务特有的路径 / 标识符 / 数字；不加第二人称祈使句给主模型；不让稿更短；不新增事实。'].join('\n')
  return [{ role: 'system', content: sys }, { role: 'user', content: user }]
}
/** 解析提议器输出：取第一个 JSON 对象，校验预算与形状；泄漏与可应用性由调用方再查。 */
export function parseProposal(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('proposal-not-json')
  let o; try { o = JSON.parse(s.slice(a, b + 1)) } catch { throw new Error('proposal-not-json') }
  validatePatches(o.patches)
  return { patches: o.patches, rationale: String(o.rationale || '').slice(0, 1000), prediction: String(o.prediction || '').slice(0, 500) }
}
/** 由提议解析结果造策略对象（未编译）。 */
export function makePolicy({ parent, patches, rationale, prediction, origin }) {
  const p = { schema: POLICY_SCHEMA, parent: parent?.id || 'base', base: 'compress-v4d9', patches, rationale, prediction, origin, status: 'proposed', sides: {} }
  return { ...p, id: policyId(p) }
}

/** 压缩器请求体（v9 L1 `compile` 角色用；traj-run 的压缩臂不再用它，直接走 src/offline-birth.js 的生产同构体）—— 与生产 distillOnce 的 v4 直写**逐字段同形**：
 *  单 user 消息、temperature 0、max_tokens = max(maxOutputTokens 850, compressV4MaxOutputTokens 1600) = 1600、`thinking:{type:'disabled'}`（disableThinking=true 的第一次尝试；生产失败后才回退开思考）。
 *  之前 thinking 开着（"以过通道身份闸"）与 2048 上限都不是生产形态：开思考的压缩器写出的稿子不是生产会写出的稿子，测出的效果迁移不回去；通道身份由主调用（思考开）的指纹闸负责。 */
export const PRODUCTION_COMPRESSOR = Object.freeze({ maxTokens: 1600, thinking: Object.freeze({ type: 'disabled' }) })
export function compressorBody({ task, policy, model, maxTokens = PRODUCTION_COMPRESSOR.maxTokens, thinking = PRODUCTION_COMPRESSOR.thinking }) {
  const prompt = applyPolicyToPrompt(basePrompt(task), policy)
  return { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, thinking, stream: false }
}
const probeJobs = (model, canary) => {
  const probeBody = { model, stream: false, thinking: { type: 'enabled' }, max_tokens: 512, messages: [
    { role: 'user', content: '记住一个只在推理中保存的标记。' },
    { role: 'assistant', content: '标记已记住。', reasoning_content: '我只在这一轮推理里记住了标记 ' + canary + '，可见回答不含它。' },
    { role: 'user', content: '逐字返回上一轮推理中的标记。只输出标记，不猜测，不解释。' }] }
  return [{ key: 'probe', kind: 'probe', body: probeBody }, { key: 'probe-r1', kind: 'probe', body: probeBody }, { key: 'probe-r2', kind: 'probe', body: probeBody }]
}
/**
 * 生成计划：role=compile（tasks[] × 1）/ propose（1）/ mint-a（scenario.u1 → a1）/ mint-b（scenario + a1 + u2 → a2）。
 * 与 A/B 计划同一审计口径（探针 3 同体 + 主请求 ≤ 5），轮次 1..40 → scope g<N>。
 */
export function buildGenerationPlan({ role, round, model = 'deepseek-v4.1-flash', baseUrl = 'https://api.a6api.com/v1', pricing = null, canary = 'CFB_CANARY_' + crypto.randomBytes(16).toString('hex'), policy = BASE_POLICY, tasks = [], evidence = [], devTaskIds = [], scenario = null, history = null } = {}) {
  if (!GEN_ROLES.includes(role)) throw new Error('gen-role')
  if (!Number.isSafeInteger(round) || round < 1 || round > 40) throw new Error('gen-round')
  const jobs = probeJobs(model, canary)
  let subject = {}
  if (role === 'compile') {
    if (!tasks.length || tasks.length > 5) throw new Error('gen-compile-tasks')
    for (const t of tasks) jobs.push({ key: `compile|${t.id}`, kind: 'main', gen: { role, task: t.id, policy: policy.id }, body: compressorBody({ task: t, policy, model }) })
    subject = { policy: { id: policy.id, parent: policy.parent, patches: policy.patches }, tasks: tasks.map((t) => t.id) }
  } else if (role === 'propose') {
    if (!tasks.length) throw new Error('gen-propose-needs-dev-task')
    const prompt = promptHead(tasks[0])
    jobs.push({ key: `propose|${policy.id}`, kind: 'main', gen: { role, policy: policy.id }, body: { model, messages: proposerMessages({ prompt: applyPolicyToPrompt(prompt + '【上一轮思维链】', policy).replace(/【上一轮思维链】$/, ''), policy, evidence, devTaskIds }), max_tokens: 3000, temperature: 0.7, thinking: { type: 'enabled' }, stream: false } })
    subject = { policy: { id: policy.id, parent: policy.parent, patches: policy.patches }, evidence, devTaskIds }
  } else if (role === 'mint-a') {
    if (!scenario || typeof scenario.id !== 'string' || typeof scenario.u1 !== 'string') throw new Error('gen-mint-scenario')
    jobs.push({ key: `mint-a|${scenario.id}`, kind: 'main', gen: { role, task: scenario.id }, body: { model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: scenario.u1 }], tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 8192, stream: false } })
    subject = { scenario: { id: scenario.id, u1: scenario.u1 } }
  } else {
    if (!scenario || typeof scenario.id !== 'string' || typeof scenario.u1 !== 'string' || !scenario.a1 || typeof scenario.u2 !== 'string') throw new Error('gen-mint-scenario')
    jobs.push({ key: `mint-b|${scenario.id}`, kind: 'main', gen: { role, task: scenario.id }, body: { model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: scenario.u1 }, { role: 'assistant', content: scenario.a1.content, reasoning_content: scenario.a1.raw }, { role: 'user', content: scenario.u2 + ASK }], tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 8192, stream: false } })
    subject = { scenario: { id: scenario.id, u1: scenario.u1, u2: scenario.u2 } }
  }
  return immutableJson({ schema: GEN_SCHEMA, approvalDate: '2026-10-02', round, role, model, baseUrl, pricing, canary, limits: APPROVED_API_LIMITS_GEN, jobs, subject,
    protocol: 'chat-completions-history-reasoning/1',
    preregistration: { purpose: role === 'compile' ? '按策略 ' + policy.id + ' 重压 side（候选稿的原料），不评分、不采纳' : role === 'propose' ? '提议器读 dev 题失败证据给出提示词补丁；补丁经预算 / 泄漏 / 可应用性三闸才成为策略' : '铸造新任务（扩池 / 留出），进池前须人工补 u2 / followup / spec',
      limitation: '生成请求不产生任何效果证据；效果只来自随后的 v9 配对回放（留出题采纳）。提议器输出可能平庸或违约，违约整份作废不重试。', retries: 0, judges: 0 } })
}
/** 生成计划的结果归约：按角色取正文。 */
export function genOutputs(plan, cached) {
  const out = []
  for (const job of plan.jobs) {
    if (job.kind !== 'main') continue
    const r = cached(job.key); if (!r) continue
    const m = r.message || {}
    out.push({ key: job.key, role: job.gen.role, task: job.gen.task || null, policy: job.gen.policy || null, content: typeof m.content === 'string' ? m.content : '', reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : '', toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => ({ name: c.function?.name || null, args: c.function?.arguments || null })) : [] })
  }
  return out
}
export const genDigest = (plan) => evidenceDigest(plan).slice(0, 16)
