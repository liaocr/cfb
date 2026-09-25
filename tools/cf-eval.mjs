#!/usr/bin/env node
// tools/cf-eval.mjs —— 反事实续写评测（counterfactual continuation eval）
//
// 问的不是「摘要像不像原文」，而是：**把历史里的推理块换成压缩稿之后，主模型的下一步还对不对？**
// 同一段会话前缀，分别用 raw / compress-v3 / compress-x1 三种推理块去续写，逐样本判分：
//   next      下一步动作命中参考动作（任一即可）
//   avoid     重走了已被否定的路径（越低越好）
//   violate   违反了约束（越低越好）
//   success = next && !avoid && !violate
// 另记 promptTokens（上下文实付）、completionTokens / reasoningChars（续写是否因信息缺失而变长）。
//
// ⚠ 这是**离线评测**：会真实调用你给的端点（主模型 + 压缩模型），费用自负。插件线上行为不受影响。
// ⚠ 压缩提示词与拼装代码直接复用 src/（prompts.js / extractive.js）⇒ 评的就是线上那一套。
//
// 用法：
//   node tools/cf-eval.mjs --fixtures tools/cf-fixtures --base-url https://api.deepseek.com \
//        --api-key-env DEEPSEEK_API_KEY --model deepseek-reasoner --compressor-model deepseek-chat \
//        --variants raw,v3,x1 --samples 3 --out cf-report.json
//   其它：--guideline-file g.txt（x1 补充准则） --min-chars 800 --concurrency 4 --max-tokens 4096
//         --temperature 0.7 --extra-body '{"thinking":{"type":"enabled"}}' --compressor-extra-body '{...}'
//         --compress-only（只压缩并打印，不调主模型） --target-min 250 --target-max 450 --tail-chars 400 --max-keep-ratio 0.7
//         --reasoning-field reasoning_content|think-tag（历史推理怎么回传：DeepSeek 思考模式 + tools 要求
//           每条历史 assistant 带 reasoning_content；不收该字段的端点用 think-tag 把推理以 <think> 前缀放进 content）
//
// Fixture（JSON；--fixtures 可给文件或目录）：
//   { "id": "...", "tools": [OpenAI tool 定义，可选],
//     "messages": [OpenAI chat messages；assistant 可带 reasoning_content / tool_calls；tool 带 tool_call_id],
//     "compress": [要压缩的 assistant 消息下标，可选；缺省 = reasoning_content ≥ --min-chars 的全部],
//     "expect": { "next":    [{ "tool": "edit_file", "args": ["user.js", "await"] }, { "text": "正则" }],
//                 "avoid":   [{ "tool": "bash", "args": ["SELECT count"] }],
//                 "violate": [{ "tool": "edit_file", "args": ["test/"] }] } }
//   动作匹配：tool 名相等且 JSON 参数包含 args 里每个子串；或 { "text": 正则 } 匹配回答正文。
//
// 零依赖；Node ≥ 20（全局 fetch）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCompressPromptV3 } from '../src/prompts.js'
import { prepareExtractive, finalizeExtractive } from '../src/extractive.js'

// ── 参数 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { variants: ['raw', 'v3', 'x1'], samples: 3, minChars: 800, concurrency: 4, maxTokens: 4096,
    temperature: null, targetMin: 250, targetMax: 450, tailChars: 400, compressOnly: false, apiKeyEnv: 'DEEPSEEK_API_KEY' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--fixtures') o.fixtures = v()
    else if (a === '--base-url') o.baseUrl = v()
    else if (a === '--api-key-env') o.apiKeyEnv = v()
    else if (a === '--model') o.model = v()
    else if (a === '--compressor-model') o.compressorModel = v()
    else if (a === '--compressor-base-url') o.compressorBaseUrl = v()
    else if (a === '--variants') o.variants = v().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--samples') o.samples = Number(v())
    else if (a === '--min-chars') o.minChars = Number(v())
    else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--max-tokens') o.maxTokens = Number(v())
    else if (a === '--temperature') o.temperature = Number(v())
    else if (a === '--extra-body') o.extraBody = JSON.parse(v())
    else if (a === '--compressor-extra-body') o.compressorExtraBody = JSON.parse(v())
    else if (a === '--guideline-file') o.guideline = fs.readFileSync(v(), 'utf8')
    else if (a === '--guideline') o.guideline = v()
    else if (a === '--target-min') o.targetMin = Number(v())
    else if (a === '--target-max') o.targetMax = Number(v())
    else if (a === '--tail-chars') o.tailChars = Number(v())
    else if (a === '--max-keep-ratio') o.maxKeepRatio = Number(v())
    else if (a === '--compress-only') o.compressOnly = true
    else if (a === '--reasoning-field') o.reasoningField = v()
    else if (a === '--out') o.out = v()
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error('unknown argument: ' + a)
  }
  return o
}

// ── 端点 ───────────────────────────────────────────────────────────────────
export function makeClient({ baseUrl, apiKey, timeoutMs = 180000 }) {
  const url = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/chat/completions'
  return async function chat(body) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify(body) })
      const text = await res.text()
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300))
      const j = JSON.parse(text)
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {}
      return { message: m, usage: j.usage || null }
    } finally { clearTimeout(t) }
  }
}

// ── fixture ────────────────────────────────────────────────────────────────
export function loadFixtures(p) {
  const st = fs.statSync(p)
  const files = st.isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f)) : [p]
  return files.map((f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.id = j.id || path.basename(f, '.json'); return j })
}

/** 会话前缀 → x1 用的证据（seq = 消息下标；只取 idx 之前的消息 = 时间截面）。 */
export function evidenceFromMessages(messages, before) {
  const names = new Map()
  const tools = [], asks = []
  for (let i = 0; i < Math.min(before, messages.length); i++) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) names.set(tc.id, tc.function && tc.function.name)
    else if (m.role === 'tool') tools.push({ seq: i, name: names.get(m.tool_call_id) || null, text: contentText(m.content), isError: false, exitCode: null })
    else if (m.role === 'user' && contentText(m.content).trim()) asks.push({ seq: i, text: contentText(m.content) })
  }
  return { tools: tools.slice(-12), asks: asks.slice(-2) }
}
const contentText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : ''

export function compressTargetsOf(fx, minChars) {
  if (Array.isArray(fx.compress)) return fx.compress.filter((i) => fx.messages[i] && fx.messages[i].role === 'assistant' && typeof fx.messages[i].reasoning_content === 'string')
  const out = []
  fx.messages.forEach((m, i) => { if (m && m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length >= minChars) out.push(i) })
  return out
}

// ── 压缩（与线上同一套提示词 / 拼装）────────────────────────────────────────
export async function compressBlock(variant, raw, ctx) {
  const { compressor, opts, evidence } = ctx
  const body = (content) => ({ model: opts.compressorModel || opts.model, messages: [{ role: 'user', content }], max_tokens: 2000, ...(opts.compressorExtraBody || {}) })
  if (variant === 'v3') {
    const r = await compressor(body(buildCompressPromptV3(raw, opts.targetMin, opts.targetMax)))
    return { text: String(r.message.content || '').trim(), usage: r.usage, ok: true }
  }
  if (variant === 'x1') {
    const cfg = { extractiveTailChars: opts.tailChars, extractiveGuideline: opts.guideline || '', extractiveMaxKeepRatio: opts.maxKeepRatio ?? 0.7 }
    const prep = prepareExtractive(raw, cfg, evidence)
    const r = await compressor(body(prep.prompt))
    try {
      const fin = finalizeExtractive(raw, prep, String(r.message.content || ''), cfg, evidence)
      return { text: fin.text, usage: r.usage, ok: true, stats: fin.stats }
    } catch (e) {
      // 与线上一致：拼装失败 ⇒ 原文放行（记为 fallback，不算压缩成功）
      return { text: raw, usage: r.usage, ok: false, error: e.code || String(e.message || e) }
    }
  }
  throw new Error('unknown variant ' + variant)
}

/** 把 fixture 的推理块替换成某个变体的压缩稿；返回新 messages 与压缩记录。 */
export async function buildVariantMessages(fx, variant, ctx) {
  const msgs = fx.messages.map((m) => ({ ...m }))
  const blocks = []
  if (variant === 'raw') return { messages: msgs, blocks }
  for (const i of compressTargetsOf(fx, ctx.opts.minChars)) {
    const raw = msgs[i].reasoning_content
    const evidence = evidenceFromMessages(fx.messages, i)
    const r = await compressBlock(variant, raw, { ...ctx, evidence })
    msgs[i].reasoning_content = r.text
    blocks.push({ index: i, rawChars: raw.length, outChars: r.text.length, ok: r.ok, error: r.error || null, stats: r.stats || null, text: r.text, raw })
  }
  return { messages: msgs, blocks }
}

/** 历史推理的回传形状。缺省原样（reasoning_content 字段）。 */
export function shapeReasoning(messages, field) {
  if (!field || field === 'reasoning_content') return messages
  if (field !== 'think-tag') throw new Error('unknown --reasoning-field ' + field)
  return messages.map((m) => {
    if (!m || m.role !== 'assistant' || typeof m.reasoning_content !== 'string') return m
    const { reasoning_content, ...rest } = m
    return { ...rest, content: '<think>\n' + reasoning_content + '\n</think>\n' + contentText(m.content) }
  })
}

// ── 判分 ───────────────────────────────────────────────────────────────────
export function actionsOf(message) {
  const calls = Array.isArray(message && message.tool_calls) ? message.tool_calls : []
  return calls.map((c) => ({ tool: c.function ? c.function.name : c.name, args: c.function ? String(c.function.arguments || '') : JSON.stringify(c.args || {}) }))
}
export function matches(pattern, actions, text) {
  if (!pattern) return false
  if (pattern.text) return new RegExp(pattern.text, 'i').test(String(text || ''))
  return actions.some((a) => a.tool === pattern.tool && (pattern.args || []).every((s) => a.args.includes(s)))
}
export function scoreSample(expect, message) {
  const acts = actionsOf(message)
  const text = String((message && message.content) || '')
  const e = expect || {}
  const next = (e.next || []).length ? e.next.some((p) => matches(p, acts, text)) : null
  const avoid = (e.avoid || []).some((p) => matches(p, acts, text))
  const violate = (e.violate || []).some((p) => matches(p, acts, text))
  return { next, avoid, violate, success: next !== false && !avoid && !violate, actions: acts.map((a) => a.tool + ' ' + a.args.slice(0, 160)) }
}

// ── 并发池 ─────────────────────────────────────────────────────────────────
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let k = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i], i) }
  }))
  return out
}

/** 压缩稿缓存键：只有影响压缩结果的参数进键（raw/v3 不看准则）。 */
export const cacheKey = (id, variant, opts) => [id, variant, variant === 'x1' ? (opts.guideline || '') : '', opts.tailChars, opts.maxKeepRatio ?? '', opts.targetMin, opts.targetMax].join('|')

const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null }

/**
 * 跑一轮评测。可被 acon-optimize.mjs 复用。
 * @param opts parseArgs 的结果（或同形对象）
 * @param deps { chat, compressor, fixtures, cache? } cache：Map，键 fixtureId|variant|guideline ⇒ 复用压缩稿
 */
export async function runEval(opts, deps) {
  const fixtures = deps.fixtures
  const perFixture = []
  for (const fx of fixtures) {
    const row = { id: fx.id, variants: {} }
    for (const variant of opts.variants) {
      const key = cacheKey(fx.id, variant, opts)
      let built = deps.cache && deps.cache.get(key)
      if (!built) { built = await buildVariantMessages(fx, variant, { compressor: deps.compressor, opts }); if (deps.cache) deps.cache.set(key, built) }
      const ctxChars = built.messages.reduce((n, m) => n + String(m.reasoning_content || '').length, 0)
      let samples = []
      if (!opts.compressOnly) {
        samples = await pool(Array.from({ length: opts.samples }, (_, s) => s), opts.concurrency, async () => {
          try {
            const body = { model: opts.model, messages: shapeReasoning(built.messages, opts.reasoningField), max_tokens: opts.maxTokens, ...(fx.tools ? { tools: fx.tools } : {}),
              ...(opts.temperature != null ? { temperature: opts.temperature } : {}), ...(opts.extraBody || {}) }
            const r = await deps.chat(body)
            const sc = scoreSample(fx.expect, r.message)
            return { ...sc, promptTokens: r.usage ? r.usage.prompt_tokens : null, completionTokens: r.usage ? r.usage.completion_tokens : null,
              reasoningChars: String(r.message.reasoning_content || '').length }
          } catch (e) { return { error: String(e.message || e), success: false, next: false, avoid: false, violate: false } }
        })
      }
      row.variants[variant] = {
        contextReasoningChars: ctxChars,
        blocks: built.blocks.map(({ raw, ...b }) => b),
        samples,
        successRate: samples.length ? mean(samples.map((s) => (s.success ? 1 : 0))) : null,
      }
    }
    perFixture.push(row)
  }
  // 汇总
  const summary = {}
  for (const variant of opts.variants) {
    const rows = perFixture.map((r) => r.variants[variant])
    const all = rows.flatMap((r) => r.samples)
    const blocks = rows.flatMap((r) => r.blocks)
    summary[variant] = {
      fixtures: rows.length, samples: all.length,
      successRate: mean(rows.map((r) => r.successRate)),
      nextRate: mean(all.filter((s) => s.next != null).map((s) => (s.next ? 1 : 0))),
      avoidRate: mean(all.map((s) => (s.avoid ? 1 : 0))),
      violateRate: mean(all.map((s) => (s.violate ? 1 : 0))),
      errorRate: mean(all.map((s) => (s.error ? 1 : 0))),
      promptTokens: mean(all.map((s) => s.promptTokens)),
      completionTokens: mean(all.map((s) => s.completionTokens)),
      reasoningChars: mean(all.map((s) => s.reasoningChars)),
      contextReasoningChars: mean(rows.map((r) => r.contextReasoningChars)),
      compressedBlocks: blocks.length,
      compressFallbacks: blocks.filter((b) => !b.ok).length,
      keptRatio: mean(blocks.filter((b) => b.ok).map((b) => b.outChars / Math.max(1, b.rawChars))),
    }
  }
  return { summary, perFixture }
}

/**
 * ACON 式对比对：raw 续写成功、variant 续写失败（或成功率更低）的 fixture。
 * 附上压缩稿与原文，供优化器分析「压缩丢了什么」。
 */
export function contrastivePairs(report, variant, fixtures, cache, opts) {
  const out = []
  for (const row of report.perFixture) {
    const raw = row.variants.raw, v = row.variants[variant]
    if (!raw || !v || raw.successRate == null || v.successRate == null) continue
    if (raw.successRate > v.successRate) {
      const fx = fixtures.find((f) => f.id === row.id)
      const key = cacheKey(row.id, variant, opts)
      const built = cache && cache.get(key)
      out.push({ id: row.id, gap: +(raw.successRate - v.successRate).toFixed(3), expect: fx && fx.expect,
        rawActions: raw.samples.map((s) => s.actions), variantActions: v.samples.map((s) => s.actions),
        blocks: built ? built.blocks : [] })
    }
  }
  return out.sort((a, b) => b.gap - a.gap)
}

export function printSummary(summary, log = console.log) {
  const cols = ['successRate', 'nextRate', 'avoidRate', 'violateRate', 'promptTokens', 'completionTokens', 'contextReasoningChars', 'keptRatio', 'compressFallbacks']
  log(['variant'].concat(cols).join('\t'))
  for (const [v, s] of Object.entries(summary)) log([v].concat(cols.map((c) => (s[c] == null ? '-' : s[c]))).join('\t'))
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
  const fixtures = loadFixtures(opts.fixtures)
  const report = await runEval(opts, { chat, compressor, fixtures, cache: new Map() })
  printSummary(report.summary)
  const out = { tool: 'cf-eval', at: new Date().toISOString(), model: opts.model, compressorModel: opts.compressorModel || opts.model,
    variants: opts.variants, samples: opts.samples, guideline: opts.guideline || '', ...report }
  if (opts.out) { fs.writeFileSync(opts.out, JSON.stringify(out, null, 2)); console.log('report → ' + opts.out) }
  if (opts.compressOnly) for (const r of report.perFixture) for (const [v, x] of Object.entries(r.variants)) for (const b of x.blocks) console.log('\n=== ' + r.id + ' · ' + v + ' · msg#' + b.index + ' ' + b.rawChars + '→' + b.outChars + (b.ok ? '' : ' (fallback: ' + b.error + ')') + ' ===\n' + b.text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.stack || e); process.exit(1) })
}
