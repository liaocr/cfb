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
    const rec = recordings.find((r) => r.id === s.id)
    if (!rec) continue
    const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
    const content = rec.events.filter((e) => e.k === 'c').map((e) => e.s).join('')
    const v = { raw, empty: '' }
    for (const { name, rows } of reports) {
      const row = rows.find((r) => r.id === s.id && r.mode === (name.includes(':') ? name.split(':')[1] : name))
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
export function sawReasoning(usage, variant, chars, base) {
  if (!usage || claudeShaped(usage)) return false
  if (variant === 'empty' || !chars) return true
  if (!Number.isFinite(base)) return true
  return Number(usage.prompt_tokens) >= base + 0.3 * chars
}

export function makeChat({ baseUrl, apiKey, timeoutMs = 240000 }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions'
  const once = async (body) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body) })
      const text = await res.text()
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300))
      const j = JSON.parse(text)
      return { message: (j.choices && j.choices[0] && j.choices[0].message) || {}, finish: j.choices && j.choices[0] && j.choices[0].finish_reason, usage: j.usage || null, ms: Date.now() - t0 }
    } finally { clearTimeout(t) }
  }
  // 连接层错误与中转 5xx 重试（中转偶发换 IP / 502）
  return async (body) => {
    for (let k = 0; ; k++) {
      try { return await once(body) } catch (e) {
        const msg = String(e && e.message)
        const http5 = /^HTTP 5\d\d/.test(msg)
        // 连接层错误重试 2 次；中转 5xx（502/503/504）退避重试 6 次（15 s 起，约 3 分钟）；其余 HTTP 错误不重试
        if ((/^HTTP /.test(msg) && !http5) || k >= (http5 ? 6 : 2)) throw e
        await new Promise((r) => setTimeout(r, http5 ? 15000 + 5000 * k : 8000))
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
  })
  const L = []
  L.push('| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 直接改 | 改对 | 规则命中 | 本轮思考字数 | prompt tokens |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const byVar = {}
  for (const v of vars) {
    const a = agg(ok.filter((r) => r.variant === v)); byVar[v] = a
    L.push(`| ${v} | ${a.n} | ${Math.round(a.ctxChars)} | ${f1(a.overall)} | ${f1(a.correct)} | ${f1(a.facts)} | ${f1(a.focus)} | ${(a.deadEnd * 100).toFixed(0)}% | ${(a.edit * 100).toFixed(0)}% | ${(a.editRight * 100).toFixed(0)}% | ${(a.next * 100).toFixed(0)}% | ${Math.round(a.reasoning)} | ${Math.round(a.prompt)} |`)
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

  if (!o.summarizeOnly) {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const chat = makeChat({ baseUrl: o.baseUrl, apiKey })
    const jobs = []
    for (const s of specs) {
      const t = TASKS.find((x) => x.id === s.id); const tv = table[s.id]
      if (!t || !tv) continue
      for (const v of order) {
        if (!(v in tv.variants)) continue
        for (let k = 0; k < o.samples; k++) if (!have.has(`${s.id}|${v}|${k}`)) jobs.push({ spec: s, task: t, content: tv.content, variant: v, reasoning: tv.variants[v], sample: k })
      }
    }
    console.log(`主调用 ${jobs.length} 次（+ 同数盲评），并发 ${o.concurrency}`)
    const base = {}
    for (const r of done) if (!r.error && r.variant === 'empty' && r.usage && !claudeShaped(r.usage)) base[r.task] = Math.max(base[r.task] || 0, Number(r.usage.prompt_tokens))
    const run = async (j) => {
      const rec = { task: j.spec.id, variant: j.variant, sample: j.sample, ctxReasoningChars: j.reasoning.length, rejected: [] }
      try {
        let r
        for (let k = 0; ; k++) {
          r = await chat({ model: o.model, messages: buildMessages(j.task, j.content, j.reasoning, j.spec.followup), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: o.maxTokens, stream: false })
          if (sawReasoning(r.usage, j.variant, j.reasoning.length, base[j.spec.id])) break
          rec.rejected.push(claudeShaped(r.usage) ? 'claude-shape' : 'prompt=' + (r.usage && r.usage.prompt_tokens))
          if (k >= 7) throw new Error('通道始终未送入思考：' + rec.rejected.join(','))
        }
        if (j.variant === 'empty') base[j.spec.id] = Math.max(base[j.spec.id] || 0, Number(r.usage.prompt_tokens))
        const text = responseText(r.message)
        Object.assign(rec, { finish: r.finish, usage: r.usage, ms: r.ms, reasoningChars: (r.message.reasoning_content || '').length, response: text, rule: ruleScore(j.spec, text), act: actScore(j.spec, text) })
        const jr = await chat({ model: o.model, messages: [{ role: 'user', content: judgePrompt(j.task, j.spec, text) }], thinking: { type: 'disabled' }, temperature: 0, max_tokens: 1500, stream: false })
        rec.judge = parseJudge(jr.message.content)
        if (!rec.judge) rec.error = 'judge-unparseable: ' + String(jr.message.content).slice(0, 120)
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
