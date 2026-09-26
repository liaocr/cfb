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
// v11.13（docs/RESEARCH-PERFORMANCE.md P6）：
//   loop      续写**原样重发**了前缀里一次**失败过**的工具调用（重走已知失败 = 无效循环，Complexity Trap 2508.21433）
//   recheck   续写原样重发了前缀里一次**成功过**的调用（重新取回已知信息 = 压缩丢了模型还要的东西）
//   deltaVsRaw  按 fixture 配对的 bootstrap（固定种子，缺省 B=2000）95% 区间：variant − raw 的 success / loop / recheck。
//             区间跨 0 = 没有证据说明有差别；fixture 少于 2 个不给区间。
//   消融变体：x1:nofold+nofail+notargets+nodedupe（任意组合）= 关掉对应的 r2 特性，与 x1 并列跑即可看每项的贡献。
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
//         --seed 1 --bootstrap 2000（配对 bootstrap 的种子与重采样次数）
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
//   tool 消息可带 "is_error": true；没带时按内容启发式判断（Traceback / exit code 非 0 / ENOENT / command not found …）。
//
// 零依赖；Node ≥ 20（全局 fetch）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCompressPromptV3 } from '../src/prompts.js'
import { prepareExtractive, finalizeExtractive } from '../src/extractive.js'

// x1 消融修饰符 → 配置开关（与 src/config.js 的 r2 开关一一对应）
export const X1_MODIFIERS = Object.freeze({ nofold: 'extractiveFoldBranches', nofail: 'extractiveKeepFailures',
  notargets: 'extractiveKindTargets', nodedupe: 'extractiveStateDedupe' })
/** 'x1:nofold+nodedupe' → { base:'x1', cfg:{ extractiveFoldBranches:false, extractiveStateDedupe:false } }；未知修饰符直接抛错。 */
export function parseVariant(variant) {
  const [base, mods = ''] = String(variant).split(':')
  const cfg = {}
  for (const m of mods.split('+').map((x) => x.trim()).filter(Boolean)) {
    if (base !== 'x1' || !X1_MODIFIERS[m]) throw new Error('unknown variant modifier ' + m + ' in ' + variant)
    cfg[X1_MODIFIERS[m]] = false
  }
  return { base, cfg }
}

// ── 参数 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { variants: ['raw', 'v3', 'x1'], seed: 1, bootstrap: 2000, samples: 3, minChars: 800, concurrency: 4, maxTokens: 4096,
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
    else if (a === '--seed') o.seed = Number(v())
    else if (a === '--bootstrap') o.bootstrap = Number(v())
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
    else if (m.role === 'tool') tools.push({ seq: i, name: names.get(m.tool_call_id) || null, text: contentText(m.content), isError: toolResultIsError(m), exitCode: null })
    else if (m.role === 'user' && contentText(m.content).trim()) asks.push({ seq: i, text: contentText(m.content) })
  }
  return { tools: tools.slice(-12), asks: asks.slice(-2) }
}
/**
 * 工具结果是否失败：fixture 显式给 is_error / isError 优先；否则看内容。
 * 启发式只认「行首报错前缀」或具体的失败形态，避免把正文里偶然出现的 error 一词当成失败。
 */
const RE_TOOL_ERROR = /(^|\n)\s*(error|fatal|traceback|exception|panic)\b[:\s]|exit(?:ed)?(?: with)? (?:code|status):? *[1-9]|non-zero exit|command not found|no such file or directory|permission denied|\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|timed out/i
export function toolResultIsError(m) {
  if (!m) return false
  if (typeof m.is_error === 'boolean') return m.is_error
  if (typeof m.isError === 'boolean') return m.isError
  return RE_TOOL_ERROR.test(contentText(m.content))
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
  const pv = parseVariant(variant)
  if (pv.base === 'v3') {
    const r = await compressor(body(buildCompressPromptV3(raw, opts.targetMin, opts.targetMax)))
    return { text: String(r.message.content || '').trim(), usage: r.usage, ok: true }
  }
  if (pv.base === 'x1') {
    const cfg = { extractiveTailChars: opts.tailChars, extractiveGuideline: opts.guideline || '', extractiveMaxKeepRatio: opts.maxKeepRatio ?? 0.7, ...pv.cfg }
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
/** 参数归一：能解析成 JSON 就按键排序后再序列化（键序/空白不同也算同一调用），否则压空白。 */
export function normArgs(args) {
  const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys) : (x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x)
  try { return JSON.stringify(sortKeys(JSON.parse(args))) } catch { return String(args || '').replace(/\s+/g, ' ').trim() }
}
/** 前缀里的全部工具调用 + 其结果是否失败（按 tool_call_id 配对；没有结果的调用 isError=null）。 */
export function priorCalls(messages) {
  const out = []
  const byId = new Map()
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const a = actionsOf({ tool_calls: [c] })[0]
        const rec = { tool: a.tool, args: normArgs(a.args), isError: null }
        out.push(rec)
        if (c.id) byId.set(c.id, rec)
      }
    } else if (m.role === 'tool' && byId.has(m.tool_call_id)) byId.get(m.tool_call_id).isError = toolResultIsError(m)
  }
  return out
}
export function scoreSample(expect, message, prior) {
  const acts = actionsOf(message)
  const text = String((message && message.content) || '')
  const e = expect || {}
  const next = (e.next || []).length ? e.next.some((p) => matches(p, acts, text)) : null
  const avoid = (e.avoid || []).some((p) => matches(p, acts, text))
  const violate = (e.violate || []).some((p) => matches(p, acts, text))
  // 重发判定：同名工具 + 归一化参数完全相同。失败过的 ⇒ loop；成功过（或结果未知）的 ⇒ recheck
  let loop = false, recheck = false
  for (const a of acts) {
    const na = normArgs(a.args)
    const hits = (prior || []).filter((p) => p.tool === a.tool && p.args === na)
    if (hits.some((p) => p.isError === true)) loop = true
    else if (hits.length) recheck = true
  }
  return { next, avoid, violate, loop, recheck, success: next !== false && !avoid && !violate, actions: acts.map((a) => a.tool + ' ' + a.args.slice(0, 160)) }
}

// ── 配对 bootstrap ──────────────────────────────────────────────────────────
/** mulberry32：固定种子的可复现 PRNG（报告必须能复算）。 */
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/**
 * 按 fixture 配对：d_i = variant_i − raw_i（两边都有值的 fixture 才进）。对 d 重采样 B 次取均值，给 2.5%/97.5% 分位。
 * @returns {{ n, mean, lo, hi } | null}  n<2 ⇒ lo/hi 为 null（一个点谈不上区间）
 */
export function pairedBootstrap(a, b, { B = 2000, seed = 1 } = {}) {
  const d = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) d.push(b[i] - a[i])
  if (!d.length) return null
  const m = d.reduce((x, y) => x + y, 0) / d.length
  if (d.length < 2) return { n: d.length, mean: +m.toFixed(4), lo: null, hi: null }
  const rnd = prng(seed)
  const means = new Float64Array(B)
  for (let k = 0; k < B; k++) { let sum = 0; for (let j = 0; j < d.length; j++) sum += d[(rnd() * d.length) | 0]; means[k] = sum / d.length }
  means.sort()
  const q = (p) => means[Math.min(B - 1, Math.max(0, Math.floor(p * B)))]
  return { n: d.length, mean: +m.toFixed(4), lo: +q(0.025).toFixed(4), hi: +q(0.975).toFixed(4) }
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
export const cacheKey = (id, variant, opts) => [id, variant, String(variant).split(':')[0] === 'x1' ? (opts.guideline || '') : '', opts.tailChars, opts.maxKeepRatio ?? '', opts.targetMin, opts.targetMax].join('|')

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
    const prior = priorCalls(fx.messages)
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
            const sc = scoreSample(fx.expect, r.message, prior)
            return { ...sc, promptTokens: r.usage ? r.usage.prompt_tokens : null, completionTokens: r.usage ? r.usage.completion_tokens : null,
              reasoningChars: String(r.message.reasoning_content || '').length }
          } catch (e) { return { error: String(e.message || e), success: false, next: false, avoid: false, violate: false, loop: false, recheck: false } }
        })
      }
      row.variants[variant] = {
        contextReasoningChars: ctxChars,
        blocks: built.blocks.map(({ raw, ...b }) => b),
        samples,
        successRate: samples.length ? mean(samples.map((s) => (s.success ? 1 : 0))) : null,
        loopRate: samples.length ? mean(samples.map((s) => (s.loop ? 1 : 0))) : null,
        recheckRate: samples.length ? mean(samples.map((s) => (s.recheck ? 1 : 0))) : null,
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
      loopRate: mean(all.map((s) => (s.loop ? 1 : 0))),
      recheckRate: mean(all.map((s) => (s.recheck ? 1 : 0))),
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
  // 配对 bootstrap：每个 variant 对 raw（同一 fixture 的 fixture 级比率配对）
  if (opts.variants.includes('raw')) {
    const col = (v, k) => perFixture.map((r) => (r.variants[v] ? r.variants[v][k] : null))
    for (const variant of opts.variants) {
      if (variant === 'raw') continue
      const bo = { B: opts.bootstrap || 2000, seed: opts.seed ?? 1 }
      summary[variant].deltaVsRaw = {
        success: pairedBootstrap(col('raw', 'successRate'), col(variant, 'successRate'), bo),
        loop: pairedBootstrap(col('raw', 'loopRate'), col(variant, 'loopRate'), bo),
        recheck: pairedBootstrap(col('raw', 'recheckRate'), col(variant, 'recheckRate'), bo),
      }
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
  const cols = ['successRate', 'nextRate', 'avoidRate', 'violateRate', 'loopRate', 'recheckRate', 'promptTokens', 'completionTokens', 'contextReasoningChars', 'keptRatio', 'compressFallbacks']
  log(['variant'].concat(cols).join('\t'))
  for (const [v, s] of Object.entries(summary)) log([v].concat(cols.map((c) => (s[c] == null ? '-' : s[c]))).join('\t'))
  const fmt = (x) => (x == null ? '-' : (x.mean >= 0 ? '+' : '') + x.mean + (x.lo == null ? ' (n=' + x.n + ', 无区间)' : ' [' + x.lo + ', ' + x.hi + '] n=' + x.n))
  for (const [v, s] of Object.entries(summary)) {
    if (s.deltaVsRaw) log('Δ vs raw · ' + v + '\tsuccess ' + fmt(s.deltaVsRaw.success) + '\tloop ' + fmt(s.deltaVsRaw.loop) + '\trecheck ' + fmt(s.deltaVsRaw.recheck))
  }
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
