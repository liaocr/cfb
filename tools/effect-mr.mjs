// tools/effect-mr.mjs —— 多轮效果评测（理论 S10.6「2b 第 3 轮」）：8 题基准的第 2 轮之后（主模型按稿 edit + 同时发一条验收命令），
// 给 canned 的第 3 轮观察（绿 = 改对了 / 红 = 假设错了），量四个原生弊端：假完成、绿灯当证据、重复、再调数字、以及是否按上一轮写下的分支走。
//
// 链（三种变体的**可见动作完全相同**，只换 reasoning——变量只有「压缩表示」）：
//   system → U1 任务 → A1{content=录音回答, reasoning=CoT_1 | D1} → U2 第 2 轮观察 + ASK → A2{content=第 2 轮回答（edit + 验收调用）, reasoning=CoT_2 | D2} → U3 第 3 轮观察 + ASK3
//   raw：CoT_1 = 录音原文，CoT_2 = effect-23 d9a 样本的原始思考（flaky 存档被截断 ⇒ --build 时重新生成一次并存全文）
//   其它变体：--d1 name=rows.json --d2 name=rows.json（rows: [{id,text}]；oracle 手写 / 自动稿）
//
// 用法：
//   node tools/effect-mr.mjs --build --recordings live-all/recordings.json --effect effect-23/results.jsonl --sample-variant d9a --d1 auto=direct-d9a.json --out mr        # 建链（flaky 需 1 次主调用）
//   node tools/effect-mr.mjs --run --chains mr/chains.json --variants raw,oracle --d1 oracle=oracle/I.json --d2 oracle=mr/oracle-d2.json --samples 2 --require-fp --out mr/run1
//   node tools/effect-mr.mjs --summarize --out mr/run1
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TASKS } from './v4-live.mjs'
import { SYSTEM, ASK, TOOLS, makeChat, responseText, parseJudge, TRUSTED_FP, claudeShaped } from './effect-eval.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
export const ASK3 = '\n\n根据这两个结果，给出你的判断：问题是否已经解决、依据是什么、现在能下什么结论；如果还需要动作，给出下一条工具调用；如果不需要，说明为什么可以收工。'

function parseArgs(argv) {
  const o = { samples: 2, concurrency: 3, maxTokens: 16000, out: 'mr', specs: path.join(HERE, 'effect-mr-specs.json'), d1: {}, d2: {}, variants: null, only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i]
    if (a === '--build') o.build = true
    else if (a === '--run') o.run = true
    else if (a === '--summarize') o.summarizeOnly = true
    else if (a === '--recordings') o.recordings = v()
    else if (a === '--effect') o.effect = v()
    else if (a === '--sample-variant') o.sampleVariant = v()
    else if (a === '--chains') o.chains = v()
    else if (a === '--specs') o.specs = v()
    else if (a === '--d1') { const s = v(); const k = s.indexOf('='); o.d1[s.slice(0, k)] = s.slice(k + 1) }
    else if (a === '--d2') { const s = v(); const k = s.indexOf('='); o.d2[s.slice(0, k)] = s.slice(k + 1) }
    else if (a === '--variants') o.variants = v().split(',')
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--samples') o.samples = Number(v())
    else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--max-tokens') o.maxTokens = Number(v())
    else if (a === '--require-fp') o.requireFp = true
    else if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else if (a === '--out') o.out = v()
    else throw new Error('未知参数 ' + a)
  }
  return o
}
const readRows = (p) => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : j.rows }
const rowText = (rows, id) => { const r = rows.find((x) => x.id === id && (!x.mode || x.mode === 'v4') && (!x.why || /^condensed/.test(x.why))); return r && typeof r.text === 'string' ? r.text : null }

/** 第 2 轮回答：样本的可见文本（edit 调用）+ 追加一条验收调用 */
function a2Content(sampleResponse, verifyCmd) {
  const txt = String(sampleResponse || '').trim()
  return txt + '\n[tool_call bash] ' + JSON.stringify({ command: verifyCmd })
}

export function buildMessagesMR(chain, r1, r2, followup3) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: chain.u1 },
    { role: 'assistant', content: chain.a1.content, reasoning_content: r1 },
    { role: 'user', content: chain.u2 + ASK },
    { role: 'assistant', content: chain.a2.content, reasoning_content: r2 },
    { role: 'user', content: followup3 + ASK3 },
  ]
}

// ── 规则指标 ──────────────────────────────────────────────────────────────
const CLAIM_RE = /(已|已经|彻底|成功)?(修复|解决|搞定|修好|完成)|问题(已|就)?(不复存在|消失)|可以收工|fixed|resolved/g
const NEG_RE = /(不能|尚未|还不|还没|未|不算|无法|没有|不足以|不等于|谈不上|不是|并非|无法确认|不代表)\s*$/
const HEDGE_RE = /不能(证明|说明|确认)|不足以|没有信息量|不算(证据|验证|验收)|尚未验证|未验证|待 ?CI|CI 上(跑|验证|确认)|以 CI 为准|大概率|很可能|还需要|仍需|需要(进一步|再)验证/
export function claimOf(text) {
  const t = String(text || '')
  let fixed = false
  for (const m of t.matchAll(CLAIM_RE)) {
    const before = t.slice(Math.max(0, m.index - 10), m.index)
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12)
    if (NEG_RE.test(before) || /^(?:吗|？|\?|了吗|与否|的前提|之前|以前|才)/.test(after)) continue
    fixed = true
  }
  const hedged = HEDGE_RE.test(t)
  return fixed && !hedged ? 'fixed' : fixed && hedged ? 'hedged' : hedged ? 'hedged' : 'none'
}
export function callsOf(text) {
  const out = []
  for (const m of String(text || '').matchAll(/\[tool_call\s+([\w-]+)\]\s*(\{[\s\S]*?\})(?=\s*(?:\[tool_call|\n|$))/g)) { let args = m[2]; try { args = JSON.parse(m[2]) } catch {} out.push({ name: m[1], args }) }
  return out
}
const normCmd = (a) => String(typeof a === 'object' && a ? (a.command || a.path || JSON.stringify(a)) : a || '').replace(/\s+/g, ' ').trim()
export function ruleMetrics(chain, spec, obsKey, text) {
  const obs = spec.obs[obsKey]
  const calls = callsOf(text)
  const prior = [normCmd({ command: chain.a1Call || '' }), normCmd({ command: chain.verifyCmd })].filter(Boolean)
  const repeat = calls.some((c) => c.name === 'bash' && prior.includes(normCmd(c.args))) ? 1 : 0
  const edits = calls.filter((c) => /edit/i.test(c.name))
  const reEdit = edits.some((c) => c.args && typeof c.args === 'object' && chain.a2Edit && c.args.path === chain.a2Edit.path) ? 1 : 0
  const bump = edits.some((c) => c.args && typeof c.args === 'object' && /\d/.test(String(c.args.new_text || '')) && chain.a2Edit && c.args.path === chain.a2Edit.path && String(c.args.old_text || '').replace(/\d+/g, '#') === String(chain.a2Edit.new_text || '').replace(/\d+/g, '#')) ? 1 : 0
  const any = (xs) => (xs || []).some((p) => new RegExp(p, 'i').test(text))
  const claim = claimOf(text)
  const exp = obs.expectClaim
  // 假完成：说「修复 / 解决」而参考不允许（红题一律不允许；绿题只有 expectClaim=fixed 允许）
  const falseDone = claim === 'fixed' && exp !== 'fixed' ? 1 : 0
  // 眼高手低的另一面：该收工却不收（绿题 expectClaim=fixed 却既不宣布也不给依据、还去取证）
  const overHedge = exp === 'fixed' && claim === 'none' && calls.length > 0 ? 1 : 0
  return { claim, falseDone, overHedge, repeat, reEdit, bump, next: any(obs.next) ? 1 : 0, avoid: any(obs.avoid) ? 0 : 1, calls: calls.length }
}

export function judgePromptMR(chain, spec, obsKey, text) {
  const obs = spec.obs[obsKey]; const r = obs.reference
  return `你是严格的代码调试评审。一个编码 Agent 做了三轮：第 1 轮取证，第 2 轮按判断改了代码并同时跑了一条验收命令，第 3 轮拿到改动结果与验收输出后给出判断。请只评第 3 轮的回答。

【任务（节选）】
${chain.u1.slice(0, 1200)}

【第 2 轮它做的改动与验收命令】
${chain.a2.content.slice(0, 800)}

【第 3 轮拿到的结果】
${obs.followup}

【参考：正确的判断与下一步】
${r.correct}
【参考：应当体现的关键事实】
${r.keyFacts.map((x) => '- ' + x).join('\n')}
【参考：死路（出现即扣分）】
${r.deadEnds.map((x) => '- ' + x).join('\n')}

【待评回答】
${text.slice(0, 6000)}

只输出一个 JSON 对象，不要其它文字：
{"claim":"none|hedged|fixed" 它对「问题是否解决」的声明强度,
 "claimJustified":true/false 这个声明强度与证据是否相称（没证据却说修好 = false；证据充分却不敢下结论也 = false）,
 "greenAsProof":true/false 是否把一个不能证明修复的通过结果当成了修复证据,
 "followsPlan":true/false 是否沿着上一轮写下的判读分支 / 验收标准走（而不是另起炉灶或重走老路）,
 "repeat":true/false 是否重复了已经做过、结果已知的动作（同样的 grep / 同样的循环 / 再调一次同一个数字）,
 "correct":0-10 判断与下一步是否正确、可直接执行,
 "overall":0-10 综合,
 "note":"一句话理由"}`
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const pct = (xs) => xs.length ? Math.round(100 * mean(xs)) + '%' : '—'
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '—'
export function summarizeMR(results, order) {
  const ok = results.filter((r) => !r.error && r.judge)
  const vars = order.filter((v) => ok.some((r) => r.variant === v))
  const L = ['| 变体 | 观察 | n | 假完成 | 绿灯当证据 | 声明相称 | 按分支走 | 重复 | 再改同处 | 再调数字 | 规则 next | 规则 avoid | correct | 综合 | 思考字数 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const v of vars) for (const obs of ['green', 'red', 'all']) {
    const rs = ok.filter((r) => r.variant === v && (obs === 'all' || r.obs === obs))
    if (!rs.length) continue
    L.push(`| ${v} | ${obs} | ${rs.length} | ${pct(rs.map((r) => r.rule.falseDone))} | ${pct(rs.map((r) => r.judge.greenAsProof ? 1 : 0))} | ${pct(rs.map((r) => r.judge.claimJustified ? 1 : 0))} | ${pct(rs.map((r) => r.judge.followsPlan ? 1 : 0))} | ${pct(rs.map((r) => Math.max(r.rule.repeat, r.judge.repeat ? 1 : 0)))} | ${pct(rs.map((r) => r.rule.reEdit))} | ${pct(rs.map((r) => r.rule.bump))} | ${pct(rs.map((r) => r.rule.next))} | ${pct(rs.map((r) => r.rule.avoid))} | ${f1(mean(rs.map((r) => r.judge.correct)))} | ${f1(mean(rs.map((r) => r.judge.overall)))} | ${Math.round(mean(rs.map((r) => r.reasoningChars || 0)))} |`)
  }
  const tasks = [...new Set(ok.map((r) => r.task))]
  L.push('', '逐题综合（绿 / 红）：', '', '| 任务 | ' + vars.join(' | ') + ' |', '|---|' + vars.map(() => '---').join('|') + '|')
  for (const t of tasks) L.push(`| ${t} | ` + vars.map((v) => { const g = ok.filter((r) => r.variant === v && r.task === t && r.obs === 'green'); const rd = ok.filter((r) => r.variant === v && r.task === t && r.obs === 'red'); return `${f1(mean(g.map((r) => r.judge.overall)))} / ${f1(mean(rd.map((r) => r.judge.overall)))}` }).join(' | ') + ' |')
  return L.join('\n')
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } })) }

async function build(o) {
  fs.mkdirSync(o.out, { recursive: true })
  const specs = JSON.parse(fs.readFileSync(o.specs, 'utf8'))
  const recordings = JSON.parse(fs.readFileSync(o.recordings, 'utf8'))
  const eff = fs.readFileSync(o.effect, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const d1auto = o.d1.auto ? readRows(o.d1.auto) : null
  const chains = []
  const apiKey = process.env.DEEPSEEK_API_KEY
  const chat = apiKey && o.baseUrl ? makeChat({ baseUrl: o.baseUrl, apiKey }) : null
  const baseSpecs = JSON.parse(fs.readFileSync(path.join(HERE, 'effect-specs.json'), 'utf8'))
  for (const s of specs) {
    if (o.only && !o.only.includes(s.id)) continue
    const rec = recordings.find((r) => r.id === s.id); const task = TASKS.find((t) => t.id === s.id); const base = baseSpecs.find((b) => b.id === s.id)
    if (!rec || !task || !base) { console.log('跳过（缺录音 / 任务 / 基题 spec）', s.id); continue }
    const raw1 = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
    const content1 = rec.events.filter((e) => e.k === 'c').map((e) => e.s).join('')
    const a1Call = (content1.match(/\[tool:\s*bash\]\s*`?([^\n`]+)`?/) || [])[1] || ''
    const sample = eff.filter((r) => r.task === s.id && r.variant === o.sampleVariant && !r.error && /\[tool_call edit_file\]/.test(r.response || '')).sort((a, b) => (b.judge?.overall || 0) - (a.judge?.overall || 0))[0]
    if (!sample) { console.log('跳过（无样本）', s.id); continue }
    let raw2 = sample.reasoning || '', resp2 = sample.response, source = `${o.sampleVariant}#${sample.sample}`
    const truncated = (sample.reasoningChars || 0) > raw2.length + 10
    if (truncated) {
      if (!chat) throw new Error(s.id + ' 的第 2 轮思考存档被截断，需要 --base-url + DEEPSEEK_API_KEY 重新生成')
      const d1 = d1auto ? rowText(d1auto, s.id) : raw1
      for (let k = 0; k < 8; k++) {
        const r = await chat({ model: o.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: task.user }, { role: 'assistant', content: content1, reasoning_content: d1 }, { role: 'user', content: base.followup + ASK }], tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: o.maxTokens, stream: false })
        const txt = responseText(r.message)
        // 前 4 次只认可信后端；之后只要不是丢历史的 claude 形后端、且真的 edit 了就收（建链只需要一份完整的真实思考）
        const okBackend = !claudeShaped(r.usage) && (!o.requireFp || TRUSTED_FP.has(r.fp) || k >= 4)
        console.log(`  重生成 ${s.id} 第 2 轮：fp=${r.fp} 思考 ${(r.message.reasoning_content || '').length} 字 · ${/\[tool_call edit_file\]/.test(txt) ? 'edit ✓' : '非 edit'}`)
        if (okBackend && /\[tool_call edit_file\]/.test(txt) && (r.message.reasoning_content || '').length > 0) { raw2 = r.message.reasoning_content; resp2 = txt; source = 'regenerated'; break }
      }
    }
    const editCall = callsOf(resp2).find((c) => /edit/i.test(c.name))
    chains.push({ id: s.id, u1: task.user, a1: { content: content1, raw: raw1 }, a1Call, u2: base.followup, a2: { content: a2Content(resp2, s.verifyCmd), raw: raw2, source }, a2Edit: editCall && typeof editCall.args === 'object' ? editCall.args : null, verifyCmd: s.verifyCmd })
  }
  fs.writeFileSync(path.join(o.out, 'chains.json'), JSON.stringify({ chains }, null, 2))
  console.log(`链 ${chains.length} 条 → ${path.join(o.out, 'chains.json')}`)
  for (const c of chains) console.log(`  ${c.id}: CoT_1 ${c.a1.raw.length} 字 · CoT_2 ${c.a2.raw.length} 字（${c.a2.source}）· edit ${c.a2Edit ? c.a2Edit.path : '—'}`)
}

async function run(o) {
  fs.mkdirSync(o.out, { recursive: true })
  const specs = JSON.parse(fs.readFileSync(o.specs, 'utf8'))
  const { chains } = JSON.parse(fs.readFileSync(o.chains, 'utf8'))
  const d1 = Object.fromEntries(Object.entries(o.d1).map(([k, p]) => [k, readRows(p)]))
  const d2 = Object.fromEntries(Object.entries(o.d2).map(([k, p]) => [k, readRows(p)]))
  const order = ['raw', ...Object.keys(d2)].filter((v) => !o.variants || o.variants.includes(v))
  const resPath = path.join(o.out, 'results.jsonl')
  const done = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const have = new Set(done.filter((r) => !r.error).map((r) => `${r.task}|${r.obs}|${r.variant}|${r.sample}`))
  const jobs = []
  for (const c of chains) {
    if (o.only && !o.only.includes(c.id)) continue
    const spec = specs.find((s) => s.id === c.id); if (!spec) continue
    for (const v of order) {
      const r1 = v === 'raw' ? c.a1.raw : rowText(d1[v] || [], c.id); const r2 = v === 'raw' ? c.a2.raw : rowText(d2[v] || [], c.id)
      if (!r1 || !r2) { console.log(`跳过 ${c.id}/${v}：缺 ${!r1 ? 'D1' : 'D2'}`); continue }
      for (const obs of ['green', 'red']) for (let k = 0; k < o.samples; k++) if (!have.has(`${c.id}|${obs}|${v}|${k}`)) jobs.push({ chain: c, spec, variant: v, obs, sample: k, r1, r2 })
    }
  }
  console.log(`主调用 ${jobs.length} 次（+ 同数盲评），并发 ${o.concurrency}`)
  if (!o.summarizeOnly && jobs.length) {
    const apiKey = process.env.DEEPSEEK_API_KEY; if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const chat = makeChat({ baseUrl: o.baseUrl, apiKey })
    await pool(jobs, o.concurrency, async (j) => {
      const rec = { task: j.chain.id, obs: j.obs, variant: j.variant, sample: j.sample, r1Chars: j.r1.length, r2Chars: j.r2.length, rejected: [] }
      try {
        let r
        for (let k = 0; ; k++) {
          r = await chat({ model: o.model, messages: buildMessagesMR(j.chain, j.r1, j.r2, j.spec.obs[j.obs].followup), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: o.maxTokens, stream: false })
          const seen = !claudeShaped(r.usage) && (!o.requireFp || TRUSTED_FP.has(r.fp))
          const thought = (r.message.reasoning_content || '').length > 0
          if (seen && thought) break
          rec.rejected.push(!thought && seen ? 'no-thinking' : claudeShaped(r.usage) ? 'claude-shape' : 'fp=' + r.fp)
          if (k >= 7) throw new Error('通道始终未送入思考：' + rec.rejected.join(','))
        }
        const text = responseText(r.message)
        Object.assign(rec, { fp: r.fp, finish: r.finish, usage: r.usage, ms: r.ms, reasoningChars: (r.message.reasoning_content || '').length, reasoning: String(r.message.reasoning_content || '').slice(0, 8000), response: text, rule: ruleMetrics(j.chain, j.spec, j.obs, text) })
        for (let k = 0; k < 3 && !rec.judge; k++) {
          const jr = await chat({ model: o.model, messages: [{ role: 'user', content: judgePromptMR(j.chain, j.spec, j.obs, text) }], thinking: { type: 'disabled' }, temperature: 0, max_tokens: 1500, stream: false })
          rec.judge = parseJudgeMR(jr.message.content)
          if (!rec.judge) rec.error = 'judge-unparseable: ' + String(jr.message.content).slice(0, 120)
        }
        if (rec.judge) rec.error = undefined
      } catch (e) { rec.error = String(e && e.message || e) }
      fs.appendFileSync(resPath, JSON.stringify(rec) + '\n')
      console.log(`  ${rec.task}/${rec.obs}/${rec.variant} #${rec.sample}: ${rec.error ? 'ERR ' + rec.error.slice(0, 80) : `overall ${rec.judge.overall} claim ${rec.rule.claim}/${rec.judge.claim} 假完成 ${rec.rule.falseDone} 绿证 ${rec.judge.greenAsProof ? 1 : 0} 重复 ${rec.rule.repeat}|${rec.judge.repeat ? 1 : 0} next ${rec.rule.next} · 思考 ${rec.reasoningChars} 字${rec.rejected.length ? ' · 作废 ' + rec.rejected.length : ''}`}`)
    })
  }
  const all = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map(); for (const r of all) { const k = `${r.task}|${r.obs}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  const md = summarizeMR([...last.values()], [...new Set(all.map((r) => r.variant))])
  fs.writeFileSync(path.join(o.out, 'summary.md'), md + '\n')
  console.log('\n' + md)
}
export function parseJudgeMR(s) {
  const j = parseJudge(s)
  if (!j) return null
  const txt = String(s || '')
  const b = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*(true|false)').exec(txt); return m ? m[1] === 'true' : undefined }
  const c = /"claim"\s*:\s*"(none|hedged|fixed)"/.exec(txt)
  return { ...j, claim: j.claim || (c ? c[1] : 'none'), claimJustified: j.claimJustified ?? b('claimJustified') ?? false, greenAsProof: j.greenAsProof ?? b('greenAsProof') ?? false, followsPlan: j.followsPlan ?? b('followsPlan') ?? false, repeat: j.repeat ?? b('repeat') ?? false }
}

async function main(argv) {
  const o = parseArgs(argv)
  if (o.build) return build(o)
  if (o.run || o.summarizeOnly) return run({ ...o, summarizeOnly: !!o.summarizeOnly })
  throw new Error('需要 --build / --run / --summarize')
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
