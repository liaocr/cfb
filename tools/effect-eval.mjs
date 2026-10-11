#!/usr/bin/env node
// tools/effect-eval.mjs —— 效果评测：上一轮思维链换成不同形态后，主模型「下一步」的判断质量
//
// 构造（真实 DSH 形态）：带 tools 的请求 ⇒ 上一轮 assistant 的 reasoning_content 会被拼进上下文（turn 20 实测：
// 2262 字 reasoning ⇒ prompt_tokens +1340、模型能读出其中埋的暗号）。所以替换 reasoning_content = 替换主模型看到的思考。
//   system  编码 Agent
//   user    任务原文（tools/v4-live.mjs TASKS）
//   assistant { content: 录制的回答, reasoning_content: 变体 }
//   user    工具结果（effect-specs.json 的 followup，按录制回答里的调用设计）+「下一步？」
// 变体：raw（录制原文）/ empty（无思考，对照）/ 报告里的各模式（只取真正 condensed* 的行，否则与 raw 相同，跳过）
// 有效性（turn 20 真机发现）：中转 a6api 至少两条通道——usage 带 claude_* 字段的那条**丢弃历史 reasoning_content**
// （同一输入 prompt_tokens 恒为无思考值），另一条正常拼接；且缺省不开思考（须显式 thinking:{type:'enabled'}）。
// ⇒ 每次主调用核验「模型确实看到了变体」：claude 形 usage 或 prompt_tokens < 该任务无思考基线 + 0.3×思考字数 ⇒ 作废重发（≤5 次）。
//   基线 = empty 组有效调用的 prompt_tokens（empty 组先跑）。
// 评分：① 规则 next/avoid 正则（在回答+工具调用上）② 盲评（同一模型关思考，只看参考答案与候选回答，不知道变体）
//
//   DEEPSEEK_API_KEY=... node tools/effect-eval.mjs --base-url https://a6api.com/v1 --model deepseek-v4.1-flash \
//     --recordings live-all/recordings.json --report v3=live-8s/report.json --report v4=live-8s-b/report.json \
//     --report v4inc=live-8s-b/report.json --samples 2 --out effect-out
//   结果逐条追加到 <out>/results.jsonl（断点续跑：已有的 (task,variant,sample) 跳过）；汇总写 <out>/summary.md

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { TASKS } from './v4-live.mjs'
import { classifyAction } from './effect-pairs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const SYSTEM = '你是在代码仓库里干活的编码 Agent，可用工具 bash / read_file / edit_file。每一轮：先给简短判断，再给出下一条工具调用。'
export const ASK = '\n\n根据这个结果，下一步？给出简短判断和下一条工具调用。'
export const TOOLS = [
  { type: 'function', function: { name: 'bash', description: '在仓库根目录执行 shell 命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'edit_file', description: '把文件中的 old_text 替换为 new_text', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
]

export function parseArgs(argv) {
  const o = { samples: 2, concurrency: 4, reports: [], maxTokens: 16000, out: 'effect-out', specs: path.join(HERE, 'effect-specs.json') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else if (a === '--recordings') o.recordings = v()
    else if (a === '--report') { const [name, p] = v().split('='); o.reports.push({ name, path: p }) }
    else if (a === '--specs') o.specs = v()
    else if (a === '--samples') o.samples = Number(v())
    else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--max-tokens') o.maxTokens = Number(v())
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--variants') o.variants = v().split(',')
    else if (a === '--require-fp') o.requireFp = true
    else if (a === '--out') o.out = v()
    else if (a === '--summarize') o.summarizeOnly = true
    else throw new Error('未知参数 ' + a)
  }
  return o
}

/** 变体表：{ taskId: { variant: reasoningText } } */
export function buildVariants(recordings, reports, specs) {
  const out = {}
  for (const s of specs) {
    // v12.8.1：spec.base —— 反驳题（同一任务、同一份稿，只换工具结果与参考答案）复用基题的录音与稿
    const baseId = s.base || s.id
    const rec = recordings.find((r) => r.id === baseId)
    if (!rec) continue
    const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
    const content = rec.events.filter((e) => e.k === 'c').map((e) => e.s).join('')
    const v = { raw, empty: '' }
    for (const { name, rows } of reports) {
      const row = rows.find((r) => r.id === baseId && r.mode === (name.includes(':') ? name.split(':')[1] : name))
      if (row && /^condensed/.test(row.why || '') && typeof row.text === 'string' && row.text.trim()) v[name.split(':')[0]] = row.text
    }
    out[s.id] = { content, variants: v }
  }
  return out
}

export function buildMessages(task, content, reasoning, followup) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: task.user },
    { role: 'assistant', content, reasoning_content: reasoning },
    { role: 'user', content: followup + ASK },
  ]
}

export function responseText(m) {
  const calls = (m.tool_calls || []).map((c) => `[tool_call ${c.function && c.function.name}] ${c.function && c.function.arguments}`)
  return [m.content || '', ...calls].filter(Boolean).join('\n')
}

export function ruleScore(spec, text) {
  const any = (xs) => (xs || []).some((p) => new RegExp(p, 'i').test(text))
  return { next: any(spec.next) ? 1 : 0, avoid: any(spec.avoid) ? 0 : 1 }
}

export function judgePrompt(task, spec, text) {
  const r = spec.reference
  return `你是严格的代码调试评审。下面是一个编码 Agent 的一轮工作：任务、它上一轮之后拿到的工具结果、它这一轮给出的判断与下一步调用。请对照参考答案打分。

【任务（节选）】
${task.user.slice(0, 1500)}

【最新工具结果】
${spec.followup}

【参考：正确的下一步】
${r.correct}
【参考：应当体现的关键事实】
${r.keyFacts.map((x) => '- ' + x).join('\n')}
【参考：死路（出现即扣分）】
${r.deadEnds.map((x) => '- ' + x).join('\n')}

【待评回答】
${text.slice(0, 6000)}

只输出一个 JSON 对象，不要其它文字：
{"correct":0-10 下一步是否正确且可直接执行（改对文件/改对地方满分；方向对但仍在取证给 4-6；方向错 0-3）,
 "deadEnd":true/false 是否走进了任一死路,
 "facts":0-10 判断里是否准确用上了关键事实（没有编造）,
 "focus":0-10 是否直奔要点、没有多余的枝节和反复,
 "overall":0-10 综合,
 "note":"一句话理由"}`
}

export function parseJudge(s) {
  const txt = String(s || '')
  const m = txt.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  // 截断的 JSON（note 没写完）：分数字段都在前面，逐个捞
  const num = (k) => { const x = new RegExp('"' + k + '"\\s*:\\s*(\\d+(?:\\.\\d+)?)').exec(txt); return x ? Number(x[1]) : undefined }
  const j = { correct: num('correct'), facts: num('facts'), focus: num('focus'), overall: num('overall') }
  if (j.overall == null || j.correct == null) return null
  const de = /"deadEnd"\s*:\s*(true|false)/.exec(txt)
  return { ...j, deadEnd: de ? de[1] === 'true' : false, note: '(截断)' }
}

/** 客观指标（不经盲评）：直接改（有 edit_file 调用）/ 改对（有 edit_file 且命中规则 next） */
export function actScore(spec, text) {
  const edit = /\[tool_call edit_file\]/.test(text) ? 1 : 0
  return { edit, editRight: edit && ruleScore(spec, text).next ? 1 : 0 }
}

export const claudeShaped = (u) => !!u && Object.keys(u).some((k) => k.startsWith('claude'))
/** 这次主调用是否真的把变体思考送进了模型 */
// 2026-09-28 探测：同一输入在不同后端 prompt_tokens 差 300–450（系统注入不同），「基线 + 0.3×字数」会误杀短变体。
// system_fingerprint = fp_dspure_app_v1 的后端已实测拼接历史思考（1 字 → 776，1000 字 → 1375）⇒ 直接认定有效。
export const TRUSTED_FP = new Set(['fp_dspure_app_v1'])
export function sawReasoning(usage, variant, chars, base, fp) {
  if (!usage || claudeShaped(usage)) return false
  if (variant === 'empty' || !chars) return true
  if (fp && TRUSTED_FP.has(fp)) return true
  if (!Number.isFinite(base)) return false   // 没有可信指纹/基线是 unknown，不是已送入历史推理
  return Number.isFinite(Number(usage.prompt_tokens)) && Number(usage.prompt_tokens) >= base + 0.3 * chars
}

// 型号回显规范（2026-10-01，v8 发现）：某些中转对同一个型号接受点号写法、却用连字符写法回显
// （实测 a6api：请求 `deepseek-v4.1-flash` → 200 且 model=`deepseek-v4-1-flash`；直接请求连字符形式 → 400）。
// 这不是"随便都能过"：别名必须**由 profile 显式声明并接受审计**，绝不静默归一化——否则型号身份闸形同虚设。
// 只允许把点/连字符/下划线的差异视作同一型号，其余任何字符差异仍然拒绝。
const canonModel = (s) => String(s || '').toLowerCase().replace(/[._-]+/g, '-')
/** 响应字段只能作渠道证据；请求的 model 字符串不证明实际响应型号。 */
export function channelIssue(r, expectedModel, { requireFp = true, requireThinking = true, modelAliases = [] } = {}) {
  if (typeof expectedModel !== 'string' || !expectedModel) return 'channel-model-mismatch'
  const got = r?.model
  if (typeof got !== 'string' || !got) return 'channel-model-mismatch'
  // 精确相等永远接受；否则只接受 profile 显式声明的别名，且两侧规范化后必须全等。
  const declared = Array.isArray(modelAliases) && modelAliases.some((a) => typeof a === 'string' && canonModel(a) === canonModel(got))
  if (got !== expectedModel && !declared) return 'channel-model-mismatch'
  const canonExpected = canonModel(expectedModel)
  if (got !== expectedModel && canonModel(got) !== canonExpected) return 'channel-model-mismatch'
  if (!r.usage || claudeShaped(r.usage)) return 'channel-usage'
  if (requireFp && !TRUSTED_FP.has(r.fp)) return 'channel-fingerprint'
  if (requireThinking && (typeof r.message?.reasoning_content !== 'string' || !r.message.reasoning_content.trim())) return 'channel-no-thinking'
  return null
}

// 旧 CLI 的默认退避保留；有界评测显式 maxRetries:0。每一次 dispatch 都先过 beforeRequest。
export function makeChat({ baseUrl, apiKey, timeoutMs = 240000, maxRetries, beforeRequest, maxResponseBytes = 8 * 1024 * 1024, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if ((maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 6)) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024) throw new Error('chat-options')
  const endpoint = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions')
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('chat-endpoint')
  const once = async (body, signal) => {
    if (signal?.aborted) throw new Error('request-aborted')
    const ctl = new AbortController(), abort = () => ctl.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const t = setTimeout(abort, timeoutMs), t0 = Date.now()
    try {
      // 固定请求字节，避免预算检查后的 body 异步变异；重定向不转发凭据，也不产生隐式第二次请求。
      const encoded = JSON.stringify(body)
      if (beforeRequest) await beforeRequest(JSON.parse(encoded))
      if (ctl.signal.aborted || Date.now() - t0 >= timeoutMs) throw new Error(signal?.aborted ? 'request-aborted' : 'request-timeout')
      let res
      try { res = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: encoded }) }
      catch { throw new Error(ctl.signal.aborted ? (signal?.aborted ? 'request-aborted' : 'request-timeout') : 'request-network-error') }
      let text
      try {
        const declared = Number(res.headers?.get('content-length'))
        if (Number.isFinite(declared) && declared > maxResponseBytes) { await res.body?.cancel().catch(() => {}); throw new Error('response-byte-limit') }
        if (res.body?.getReader) {
          const reader = res.body.getReader(), parts = []; let bytes = 0
          try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break
              bytes += value.byteLength
              if (bytes > maxResponseBytes) { await reader.cancel().catch(() => {}); throw new Error('response-byte-limit') }
              parts.push(Buffer.from(value))
            }
            text = Buffer.concat(parts, bytes).toString('utf8')
          } finally { reader.releaseLock() }
        } else { text = await res.text(); if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw new Error('response-byte-limit') }
      } catch (e) { if (e.message === 'response-byte-limit') throw e; throw new Error(ctl.signal.aborted ? (signal?.aborted ? 'request-aborted' : 'request-timeout') : 'request-network-error') }
      if (!res.ok) throw new Error('HTTP ' + res.status)   // 不把网关错误正文/可能回显的凭据写进日志
      let j
      try { j = JSON.parse(text) } catch { throw new Error('response-json') }
      if (!j || typeof j !== 'object' || !Array.isArray(j.choices) || j.choices.length !== 1 || !j.choices[0]?.message || typeof j.choices[0].message !== 'object' || Array.isArray(j.choices[0].message)) throw new Error('response-shape')
      if (ctl.signal.aborted || Date.now() - t0 >= timeoutMs) throw new Error(signal?.aborted ? 'request-aborted' : 'request-timeout')
      return { model: j.model || null, message: j.choices[0].message, finish: j.choices[0].finish_reason, usage: j.usage || null, fp: j.system_fingerprint || null, ms: Date.now() - t0 }
    } finally { clearTimeout(t); signal?.removeEventListener('abort', abort) }
  }
  return async (body, { signal } = {}) => {
    for (let k = 0; ; k++) {
      try { return await once(body, signal) } catch (e) {
        const msg = String(e?.message), http5 = /^HTTP 5\d\d/.test(msg)
        // 预算拒绝、取消、JSON/协议错误不重试；只对明确的连接/5xx 错误应用旧退避。
        if (signal?.aborted || (!http5 && msg !== 'request-network-error') || k >= (maxRetries ?? (http5 ? 6 : 2))) throw e
        await sleep(http5 ? 15000 + 5000 * k : 8000)
      }
    }
  }
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } }))
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '—'

let SPEC_BY_ID = {}
export function summarize(results, variantOrder, specs = []) {
  if (specs.length) SPEC_BY_ID = Object.fromEntries(specs.map((s) => [s.id, s]))
  const ok = results.filter((r) => !r.error && r.judge)
  const vars = variantOrder.filter((v) => ok.some((r) => r.variant === v))
  const tasks = [...new Set(ok.map((r) => r.task))]
  const agg = (rs) => ({
    n: rs.length,
    overall: mean(rs.map((r) => Number(r.judge.overall))),
    correct: mean(rs.map((r) => Number(r.judge.correct))),
    facts: mean(rs.map((r) => Number(r.judge.facts))),
    focus: mean(rs.map((r) => Number(r.judge.focus))),
    deadEnd: mean(rs.map((r) => (r.judge.deadEnd ? 1 : 0))),
    next: mean(rs.map((r) => r.rule.next)),
    avoid: mean(rs.map((r) => r.rule.avoid)),
    reasoning: mean(rs.map((r) => r.reasoningChars)),
    prompt: mean(rs.map((r) => (r.usage && r.usage.prompt_tokens) || 0)),
    ctxChars: mean(rs.map((r) => r.ctxReasoningChars)),
    edit: mean(rs.map((r) => (r.act || actScore(SPEC_BY_ID[r.task] || { next: [] }, r.response || '')).edit)),
    editRight: mean(rs.map((r) => (r.act || actScore(SPEC_BY_ID[r.task] || { next: [] }, r.response || '')).editRight)),
    // v12.8.1 伤害列：错改 = 动手了但不是参考的改法（反驳题里照稿硬改就落在这里）；纸面「直接改%」不许把它盖掉
    editWrong: mean(rs.map((r) => { const a = r.act || actScore(SPEC_BY_ID[r.task] || { next: [] }, r.response || ''); return a.edit && !a.editRight ? 1 : 0 })),
    // v12.7：回头 read 率 = 再读任务里已给过内容的文件（JetBrains《Complexity Trap》「摘要使轨迹变长」的单步版；tools/effect-pairs.mjs 同一判定）
    reread: mean(rs.map((r) => { const t = TASKS.find((x) => x.id === r.task); return classifyAction(t ? t.user : '', r.response || '') === 'reread-known' ? 1 : 0 })),
  })
  const L = []
  L.push('| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 直接改 | 改对 | 错改 | 回头read | 规则命中 | 本轮思考字数 | prompt tokens |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const byVar = {}
  for (const v of vars) {
    const a = agg(ok.filter((r) => r.variant === v)); byVar[v] = a
    L.push(`| ${v} | ${a.n} | ${Math.round(a.ctxChars)} | ${f1(a.overall)} | ${f1(a.correct)} | ${f1(a.facts)} | ${f1(a.focus)} | ${(a.deadEnd * 100).toFixed(0)}% | ${(a.edit * 100).toFixed(0)}% | ${(a.editRight * 100).toFixed(0)}% | ${(a.editWrong * 100).toFixed(0)}% | ${(a.reread * 100).toFixed(0)}% | ${(a.next * 100).toFixed(0)}% | ${Math.round(a.reasoning)} | ${Math.round(a.prompt)} |`)
  }
  L.push('', '逐任务「综合」分（均值，括号内 = 本轮思考字数）：', '', '| 任务 | ' + vars.join(' | ') + ' |', '|---|' + vars.map(() => '---').join('|') + '|')
  for (const t of tasks) {
    L.push(`| ${t} | ` + vars.map((v) => { const rs = ok.filter((r) => r.task === t && r.variant === v); return rs.length ? `${f1(mean(rs.map((r) => Number(r.judge.overall))))} (${Math.round(mean(rs.map((r) => r.reasoningChars)))})` : '—' }).join(' | ') + ' |')
  }
  // 与 raw 的同任务配对差（只在两边都有的任务上）
  L.push('', '与 raw 的同任务配对差（综合分，Δ>0 = 比原文好）：', '')
  for (const v of vars) {
    if (v === 'raw') continue
    const ds = []
    for (const t of tasks) {
      const a = ok.filter((r) => r.task === t && r.variant === v), b = ok.filter((r) => r.task === t && r.variant === 'raw')
      if (a.length && b.length) ds.push(mean(a.map((r) => Number(r.judge.overall))) - mean(b.map((r) => Number(r.judge.overall))))
    }
    L.push(`- ${v}：Δ均值 ${f1(mean(ds))}（${ds.length} 个任务：${ds.map((d) => (d >= 0 ? '+' : '') + d.toFixed(1)).join(' ')}）`)
  }
  const errs = results.filter((r) => r.error)
  if (errs.length) L.push('', `错误 ${errs.length} 条：` + errs.map((r) => `${r.task}/${r.variant}#${r.sample}: ${String(r.error).slice(0, 80)}`).join('；'))
  return { markdown: L.join('\n'), byVar }
}

async function main(argv) {
  const o = parseArgs(argv)
  fs.mkdirSync(o.out, { recursive: true })
  const specs = JSON.parse(fs.readFileSync(o.specs, 'utf8')).filter((s) => !o.only || o.only.includes(s.id))
  const recordings = JSON.parse(fs.readFileSync(o.recordings, 'utf8'))
  const reports = o.reports.map(({ name, path: p }) => ({ name, rows: JSON.parse(fs.readFileSync(p, 'utf8')).rows }))
  const table = buildVariants(recordings, reports, specs)
  const order = ['raw', 'empty', ...o.reports.map((r) => r.name.split(':')[0])].filter((v) => !o.variants || o.variants.includes(v))
  const resPath = path.join(o.out, 'results.jsonl')
  const done = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const have = new Set(done.filter((r) => !r.error).map((r) => `${r.task}|${r.variant}|${r.sample}`))
  // v12.7.1：主调用成功、只是盲评没解析出来的行（judge-unparseable）只补盲评，不重发主调用（主调用带思考，是大头）
  const rejudge = new Map()
  for (const r of done) if (r.error && /^judge-unparseable/.test(r.error) && r.response && !have.has(`${r.task}|${r.variant}|${r.sample}`)) rejudge.set(`${r.task}|${r.variant}|${r.sample}`, r)

  if (!o.summarizeOnly) {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const chat = makeChat({ baseUrl: o.baseUrl, apiKey })
    const jobs = []
    for (const s of specs) {
      const t = TASKS.find((x) => x.id === (s.base || s.id)); const tv = table[s.id]
      if (!t || !tv) continue
      for (const v of order) {
        if (!(v in tv.variants)) continue
        for (let k = 0; k < o.samples; k++) if (!have.has(`${s.id}|${v}|${k}`)) jobs.push({ spec: s, task: t, content: tv.content, variant: v, reasoning: tv.variants[v], sample: k, prior: rejudge.get(`${s.id}|${v}|${k}`) })
      }
    }
    console.log(`主调用 ${jobs.length} 次（+ 同数盲评），并发 ${o.concurrency}`)
    const base = {}
    for (const r of done) if (!r.error && r.variant === 'empty' && r.usage && !claudeShaped(r.usage)) base[r.task] = Math.max(base[r.task] || 0, Number(r.usage.prompt_tokens))
    const run = async (j) => {
      const rec = j.prior ? { ...j.prior, error: undefined, rejudged: true } : { task: j.spec.id, variant: j.variant, sample: j.sample, ctxReasoningChars: j.reasoning.length, rejected: [] }
      try {
        let text = rec.response
        if (!j.prior) {
          let r
          for (let k = 0; ; k++) {
            r = await chat({ model: o.model, messages: buildMessages(j.task, j.content, j.reasoning, j.spec.followup), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: o.maxTokens, stream: false })
            const seen = o.requireFp ? !channelIssue(r, o.model) : sawReasoning(r.usage, j.variant, j.reasoning.length, base[j.spec.id], r.fp)   // --require-fp：所有变体（含 raw、empty）都钉在同一个已验证后端，避免跨后端混杂
            // v12.7.1：thinking 显式开着却一字未想 ⇒ 这条通道这次没跑思考（effect-18 perf/oH#1：0 字、直接 read README），与「没送入变体」同等作废
            const thought = (r.message.reasoning_content || '').length > 0
            if (seen && thought) break
            rec.rejected.push(!thought && seen ? 'no-thinking' : claudeShaped(r.usage) ? 'claude-shape' : 'prompt=' + (r.usage && r.usage.prompt_tokens) + (r.fp ? '@' + r.fp : ''))
            if (k >= 7) throw new Error('通道始终未送入思考：' + rec.rejected.join(','))
          }
          if (j.variant === 'empty') base[j.spec.id] = Math.max(base[j.spec.id] || 0, Number(r.usage.prompt_tokens))
          text = responseText(r.message)
          // v12.7.1：主模型本轮思考原文也落盘（头 6000 字）——归因时要看「短思考 ⇒ 回头 read」的样本到底在想什么，只有字数不够
          Object.assign(rec, { model: r.model, fp: r.fp, finish: r.finish, usage: r.usage, ms: r.ms, reasoningChars: (r.message.reasoning_content || '').length, reasoning: String(r.message.reasoning_content || '').slice(0, 6000), response: text, rule: ruleScore(j.spec, text), act: actScore(j.spec, text) })
        }
        // 盲评：解析不出（空内容 / 截断）再试 2 次，仍不行才记错（下次运行只补盲评）
        for (let k = 0; k < 3 && !rec.judge; k++) {
          const jr = await chat({ model: o.model, messages: [{ role: 'user', content: judgePrompt(j.task, j.spec, text) }], thinking: { type: 'disabled' }, temperature: 0, max_tokens: 1500, stream: false })
          if (channelIssue(jr, o.model, { requireFp: !!o.requireFp, requireThinking: false })) throw new Error('judge-channel-invalid')
          rec.judge = parseJudge(jr.message.content)
          if (!rec.judge) rec.error = 'judge-unparseable: ' + String(jr.message.content).slice(0, 120)
        }
        if (rec.judge) rec.error = undefined
      } catch (e) { rec.error = String(e && e.message || e) }
      fs.appendFileSync(resPath, JSON.stringify(rec) + '\n')
      console.log(`  ${rec.task} / ${rec.variant} #${rec.sample}: ${rec.error ? 'ERR ' + rec.error.slice(0, 80) : `overall ${rec.judge.overall} correct ${rec.judge.correct} deadEnd ${rec.judge.deadEnd} · 思考 ${rec.reasoningChars} 字 · prompt ${rec.usage && rec.usage.prompt_tokens}${rec.rejected.length ? ' · 作废重发 ' + rec.rejected.length : ''}`}`)
    }
    await pool(jobs.filter((j) => j.variant === 'empty'), o.concurrency, run)   // 先建无思考基线
    await pool(jobs.filter((j) => j.variant !== 'empty'), o.concurrency, run)
  }
  const all = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map(); for (const r of all) { const k = `${r.task}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  const { markdown } = summarize([...last.values()], order, specs)
  fs.writeFileSync(path.join(o.out, 'summary.md'), markdown + '\n')
  console.log('\n' + markdown)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
