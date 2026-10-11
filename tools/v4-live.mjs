#!/usr/bin/env node
// tools/v4-live.mjs —— 真机（云端）测试：真实 DeepSeek 推理流 × 真实 birth 管线 × 真实副模型
//
// 做什么：
//   ① 录制：用主模型（缺省 deepseek-chat + thinking enabled）对一组 Agent 调试任务流式生成，
//      逐个 delta 记下到达时刻（真实时序），存成 recordings.json（之后可 --replay 复用，不再花主模型调用）。
//   ② 回放：把每条录音按原时序重放成宿主的 chunk 流（block-start / reasoning-delta / block-end / text / finish），
//      送进**生产代码** birthTransform，副模型走生产代码 makeBirthCompiler / makeV4SegmentCompiler
//      （同一模型关思考 —— 与插件缺省 disableThinking 一致）。每种模式用同一条录音、同一时序，公平对比。
//   ③ 报告：每块的结局（condensed / condensed-partial / distill-timeout / …）、原文与产物长度、
//      收网多等了多久（finish 被扣住的毫秒数）、v4 各不变量的拒绝数、分段情况，以及产物全文。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node tools/v4-live.mjs --out live-out                 # 录制 + 三种模式
//   node tools/v4-live.mjs --replay live-out/recordings.json --modes v4inc --out live-out2
//   node tools/v4-live.mjs --recompile live-out2/report.json --out re1     # 零调用：复用捕获的分段结果重编译（改了编译/渲染时用）
//   直写（v12.7；v12.8.8 起为 v4 缺省）：--modes v4 --cfg '{"distillStream":true}'（收网窗口自动抬到 compressV4DirectMinWaitMs；看 hold= 多等了多久）
//   选项：--model deepseek-chat  --base-url https://api.deepseek.com  --modes v3,v4,v4ops,v4inc（v4 = 直写 = 生产 v4 缺省；v4ops / v4inc = ops 整块 / 增量）
//         --tasks tasks.json（[{id, system?, user}]）  --only id1,id2  --cfg '{"birthFinishWaitMs":1500}'
//         --concurrency 3（录制并发）  --replay-concurrency 1（回放并发，缺省 1 = 与正常使用一致）  --api-key-env DEEPSEEK_API_KEY
// 钥匙只从环境变量读，写进 0600 临时凭据文件供生产代码读取，结束即删；不进报告、不进 trace。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeConfig } from '../src/config.js'
import { birthTransform } from '../src/birth.js'
import { makeBirthCompiler, makeV4SegmentCompiler } from '../src/distill.js'
import { createSegmenter } from '../src/segment-v4.js'
import { v4Budget, v4Incremental } from '../src/prompts.js'
import { endpointUrl } from '../src/provider.js'

// ── 内置任务：真实形态的 Agent 调试回合（带工具输出），足以诱发 3,000+ 字的思考 ─────────────
export const TASKS = [
  { id: 'eacces-config', user: `你是一个在仓库里干活的编码 Agent。下面是本轮拿到的信息，请分析原因，并给出下一步要执行的一条工具调用（只给调用，不要执行）。

[tool: bash] npm test
> dsh-cot-form-b@0.1.0 test
> node verify.mjs
  FAIL test/birth.selftest.mjs  Error: EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'
[tool: bash] ls -la /home/u/.dsh/storages/cot-form-b/
drwxr-xr-x 2 root root 4096 Sep 20 10:11 .
-rw-r--r-- 1 root root 88213 Sep 20 10:11 trace.log
[tool: bash] echo $DSH_HOME
/home/u/.dsh
[tool: read_file] verify.mjs (节选)
  // 每个套件在独立的临时 DSH_HOME 里跑
  const env = { ...process.env, DSH_HOME: tmp }
[tool: bash] id
uid=1000(u) gid=1000(u)
[tool: read_file] test/birth.selftest.mjs 第 1-12 行
  import { makeTraceWriter } from '../src/trace.js'
  const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` },
  { id: 'flaky-timeout', user: `你是编码 Agent。CI 里 test/hedge.selftest.mjs 大约每 5 次失败 1 次，本地从不失败。信息如下，分析最可能的原因并给出下一步一条工具调用。

[tool: bash] 最近 5 次 CI 日志摘要
run 1: PASS  17 passed  (hedge 3.1s)
run 2: FAIL  §4 对冲在主请求 200 之后不得再发  expected hedgeStartedAt=null, got 1712
run 3: PASS
run 4: PASS
run 5: FAIL  §4 同上 got 1698
[tool: read_file] test/hedge.selftest.mjs §4
  server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600
  assert.equal(meta.hedgeStartedAt, null)
[tool: read_file] src/distill.js hedgedDistill 节选
  const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)
  primary.then(() => { primarySettled = true })
[tool: bash] nproc (CI) → 2 ; nproc (本地) → 16` },
  { id: 'wrong-model', user: `你是编码 Agent。用户报告：插件压缩用的模型不是当前会话的模型，而是上一次会话的模型。信息如下。分析原因，给出下一步一条工具调用。

[tool: read_file] src/host-follow.js 节选
  let lastModel = null
  observe(options) { if (options && options.model) lastModel = options.model }
  callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }
[tool: read_file] src/plugin.js 节选
  host.observe(options, n)
  const callCfg = host.callConfig(options)
  ...
  return birthTransform(inner, { cfg: callCfg, ... })
[tool: bash] grep -n "prewarm" src/transport.js | head
  41: export function makePrewarmer(cfg, trace) {
  57:   return (why) => { ... fetch(prewarmTargetUrl(cfg)) ... }
[tool: bash] 用户的 trace 片段
  [llm-stream] {"n":12,"model":"deepseek-v3.2"}
  [compiler-transport-started] {"model":"deepseek-v3.1"}
  [llm-stream] {"n":13,"model":"deepseek-v3.2"}` },
  { id: 'sse-truncated', user: `你是编码 Agent。线上偶发：压缩结果被截断却被当成成功写进了会话。信息如下，分析原因，给出下一步一条工具调用。

[tool: bash] trace 片段
  [compiler-transport-settled] {"ok":true,"finish":null,"stream":true,"outputChars":212,"eventCount":9}
  [birth-condensed] {"rawChars":8123,"outChars":212}
[tool: read_file] src/transport.js assembleSseFrames 节选
  for (const f of frames) {
    if (f === '[DONE]') { done = true; continue }
    const j = JSON.parse(f); out += j.choices?.[0]?.delta?.content || ''
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason
  }
  return { out, finish: finish || (done ? 'stop' : null) }
[tool: bash] 网关文档：部分上游在连接被代理切断时只补发 data: [DONE]` },
  { id: 'perf-regression', user: `你是编码 Agent。升级后 birth 收网平均等待从 900ms 涨到 2400ms。信息如下，分析原因并给出下一步一条工具调用。

[tool: bash] analyze-trace 输出（升级前 / 后）
  ttfbMs p50: 610 / 640
  contentSpanMs p50: 280 / 1650
  outputChars p50: 390 / 1720
  promptVersion: compress-v3h:250-450 / compress-v3h:250-450
[tool: bash] git diff v11.9..v11.10 -- src/config.js
  -  maxOutputTokens: 850,
  +  maxOutputTokens: 4096,
  -  compressTargetMax: 450,
  +  compressTargetMax: 1800,
[tool: read_file] README 回滚开关表：compressTargetMax 只影响 v3 的长度目标` },
  { id: 'session-mixup', user: `你是编码 Agent。用户报告：A 会话的推理原文被归档到了 B 会话名下。信息如下，分析原因，给出下一步一条工具调用。

[tool: read_file] src/session-tracker.js 节选
  onPreStep(session) { this.last = session; this.seen.push({ id: session.id, at: Date.now() }) }
  forStream() { return { session: this.last, sessionId: this.last && this.last.id, ambiguous: false } }
[tool: bash] trace 片段（同一进程）
  [pre-step] session=A n=40
  [pre-step] session=B n=41
  [llm-stream] n=41 （A 的流，晚到）
  [birth-archive-settled] sessionId=B
[tool: read_file] README：v11.11 流归属交错 ⇒ 不可证 ⇒ 缺省原文放行` },
]

export function parseArgs(argv) {
  const o = { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', modes: ['v3', 'v4', 'v4inc'], apiKeyEnv: 'DEEPSEEK_API_KEY',
    out: 'v4-live-out', concurrency: 3, replayConcurrency: 1, cfg: {}, only: null, tasks: null, replay: null, maxTokens: 8192, recompile: null, scale: 0.1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--model') o.model = v()
    else if (a === '--base-url') o.baseUrl = v()
    else if (a === '--modes') o.modes = v().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--api-key-env') o.apiKeyEnv = v()
    else if (a === '--out') o.out = v()
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(v()) || 1)
    else if (a === '--replay-concurrency') o.replayConcurrency = Math.max(1, Number(v()) || 1)
    else if (a === '--cfg') o.cfg = JSON.parse(v())
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--tasks') o.tasks = v()
    else if (a === '--replay') o.replay = v()
    else if (a === '--max-tokens') o.maxTokens = Number(v())
    else if (a === '--recompile') o.recompile = v()
    else if (a === '--scale') o.scale = Number(v())
    else throw new Error('unknown arg ' + a)
  }
  for (const m of o.modes) if (!['v3', 'v4', 'v4ops', 'v4inc'].includes(m)) throw new Error('unknown mode ' + m)
  return o
}

// ── ① 录制：主模型流式思考，逐 delta 记时刻 ─────────────────────────────────
async function record(task, o, key) {
  const url = endpointUrl(o.baseUrl, 'openai-completions')  // 与副模型同一规则：base 已以 /v1 结尾（中转站常见）就不再叠加
  const body = { model: o.model, stream: true, max_tokens: o.maxTokens, thinking: { type: 'enabled' },
    messages: [...(task.system ? [{ role: 'system', content: task.system }] : []), { role: 'user', content: task.user }] }
  const t0 = Date.now()
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('main model HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300))
  const events = []
  let buf = '', finish = null, usage = null
  const dec = new TextDecoder()
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j; try { j = JSON.parse(data) } catch { continue }
      const d = j.choices && j.choices[0] && j.choices[0].delta
      const t = Date.now() - t0
      if (d && d.reasoning_content) events.push({ t, k: 'r', s: d.reasoning_content })
      if (d && d.content) events.push({ t, k: 'c', s: d.content })
      if (j.choices && j.choices[0] && j.choices[0].finish_reason) finish = j.choices[0].finish_reason
      if (j.usage) usage = j.usage
    }
  }
  const reasoning = events.filter((e) => e.k === 'r').map((e) => e.s).join('')
  const content = events.filter((e) => e.k === 'c').map((e) => e.s).join('')
  return { id: task.id, model: o.model, finish, usage, totalMs: Date.now() - t0, reasoningChars: reasoning.length, contentChars: content.length, events }
}

// ── ② 回放成宿主 chunk 流（原时序）──────────────────────────────────────────
async function* replay(rec, marks, scale = 1) {
  const t0 = Date.now(); marks.t0 = t0
  const wait = async (t) => { const d = t * scale - (Date.now() - t0); if (d > 0) await new Promise((r) => setTimeout(r, d)) }
  let phase = 'none', reasoning = '', content = ''
  for (const e of rec.events) {
    await wait(e.t)
    if (e.k === 'r') {
      if (phase === 'none') { phase = 'r'; yield { type: 'block-start', index: 0, blockType: 'reasoning' } }
      reasoning += e.s
      yield { type: 'reasoning-delta', index: 0, text: e.s }
    } else {
      if (phase === 'r') { marks.blockEndAt = Date.now(); yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } }
      if (phase !== 'c') { phase = 'c'; yield { type: 'block-start', index: 1, blockType: 'text' } }
      content += e.s
      yield { type: 'text-delta', index: 1, text: e.s }
    }
  }
  if (phase === 'r') { marks.blockEndAt = Date.now(); yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } }
  if (phase === 'c') yield { type: 'block-end', index: 1, block: { type: 'text', text: content } }
  marks.upstreamFinishAt = Date.now()
  yield { type: 'finish', reason: { kind: 'end' } }
}

export function modeConfig(mode, base) {
  if (mode === 'v3') return { ...base, compressPrompt: 'v3' }
  // v12.8.8：compressV4Direct 缺省 true ⇒ `v4` = 生产 v4 缺省（直写整块）；ops 路改名 `v4ops`（整块）/ `v4inc`（增量，直写没有增量路 ⇒ 必须关直写）
  if (mode === 'v4') return { ...base, compressPrompt: 'v4', compressV4Incremental: false }
  if (mode === 'v4ops') return { ...base, compressPrompt: 'v4', compressV4Direct: false, compressV4Incremental: false }
  return { ...base, compressPrompt: 'v4', compressV4Direct: false, compressV4Incremental: true }
}

/**
 * 回放一条录音跑一种模式。
 * @param sim 离线重编译：{ capture: [{segText, ops, ms, error}], scale }——分段结果取自上次真机捕获（按段文本匹配、按原耗时 × scale 落定），零调用
 */
async function runMode(rec, mode, o, credPath, sim = null) {
  const scale = sim ? sim.scale : 1
  const scaled = sim ? { birthFinishWaitMs: Math.round((o.cfg.birthFinishWaitMs ?? 1500) * scale), finishHeadersGraceMs: Math.round((o.cfg.finishHeadersGraceMs ?? 1500) * scale), birthArchiveTimeoutMs: 60000 } : {}
  // v12.7：生产里 plugin 会把本回合任务 + 工具结果构造成 compressCtx（buildCompressCtx）；回放没有出站消息，用任务原文顶上（与 compile-direct 同口径）
  const task = (o.taskList || TASKS).find((t) => t.id === rec.id)
  const cfg = normalizeConfig(modeConfig(mode, {
    mode: 'birth', dryRun: false, model: o.model, baseUrl: o.baseUrl, credentialsPath: credPath, credentialRef: 'LIVE_KEY',
    followHostProvider: false, followHostModel: false, trace: false, compressCtx: (task && task.user) || '', ...o.cfg, ...scaled,
  }))
  const capture = []
  const t0 = Date.now()
  const traces = []
  const trace = (tag, data) => traces.push({ at: Date.now(), tag, data })
  const marks = {}
  const deps = {
    cfg, trace, sessionId: 'live-' + rec.id, archive: async () => 'art://live-' + rec.id,
    distill: makeBirthCompiler(cfg),
    segmenter: v4Incremental(cfg) ? ((cs) => (index) => createSegmenter({ cfg, compileSegment: cs, trace, index }))(sim ? simCompiler(sim) : capturing(makeV4SegmentCompiler(cfg), capture, t0)) : null,
    v4Budget: v4Budget(cfg),
  }
  let out = null, finishEmittedAt = null
  for await (const c of birthTransform(replay(rec, marks, scale), deps)) {
    if (c.type === 'block-end' && c.index === 0) out = c.block.text
    if (c.type === 'finish') finishEmittedAt = Date.now()
  }
  const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
  const pick = (tag) => traces.filter((t) => t.tag === tag).map((t) => t.data)
  const cond = pick('birth-condensed')[0] || null
  const passed = pick('birth-passthrough')[0] || pick('birth-below-floor')[0] || null
  const failed = pick('birth-distill-failed')[0] || null
  const segs = pick('v4-segment-settled')
  return {
    id: rec.id, mode, promptVersion: cond?.promptVersion || null,
    why: cond ? cond.why : passed ? passed.why : 'unknown',
    rawChars: raw.length, outChars: out == null ? null : out.length,
    ratio: out == null || !raw.length ? null : Number((out.length / raw.length).toFixed(3)),
    finishHoldMs: finishEmittedAt && marks.upstreamFinishAt ? finishEmittedAt - marks.upstreamFinishAt : null,
    blockEndToFinishMs: marks.blockEndAt && marks.upstreamFinishAt ? marks.upstreamFinishAt - marks.blockEndAt : null,
    distillMs: cond?.distillMs ?? null, waitedMs: (cond || passed)?.waitedMs ?? null, distillError: failed?.error || passed?.error || null,
    v4: cond?.v4 || failed?.v4 || null,
    segments: segs.length ? { n: segs.length, ok: segs.filter((s) => s.ok).length, msP50: pct(segs.map((s) => s.ms), 0.5), msMax: Math.max(...segs.map((s) => s.ms)),
      reasons: segs.map((s) => s.reason).filter(Boolean) } : null,
    identifierRecall: cond?.fidelity?.identifierRecall ?? null,
    traceTags: traces.reduce((m, t) => { m[t.tag] = (m[t.tag] || 0) + 1; return m }, {}),
    segmentErrors: pick('v4-segment-error').concat(pick('birth-partial-error')).map((d) => d.error).slice(0, 4),
    text: out,
    capture: sim ? undefined : capture,
    simulated: sim ? { scale, missing: sim.missing.length } : undefined,
    timeline: traces.map((t) => ({ ms: t.at - (marks.t0 || t.at), tag: t.tag, ...(t.tag.startsWith('v4-') || t.tag.startsWith('birth-') ? t.data : {}) })),
  }
}

// 真机分段调用的捕获：段文本 / 前段条目 / 副模型解析后的条目 / 耗时 / 错误 —— 供 --recompile 零成本复用
function capturing(cs, capture, t0) {
  return async (segText, prior, signal, extra = {}) => {
    const at = Date.now()
    const rec = { segText, prior, tail: !!extra.tail, firedMs: at - t0, ms: null, ops: null, error: null }
    capture.push(rec)
    try { const r = await cs(segText, prior, signal, extra); rec.ops = r.ops; rec.ms = Date.now() - at; return r }
    catch (e) { rec.error = String((e && e.message) || e); rec.ms = Date.now() - at; throw e }
  }
}
// 离线：按段文本取捕获结果，按原耗时 × scale 落定；原来就失败 / 被取消的段照样失败；切段变了（找不到）⇒ 记 missing 并失败
function simCompiler(sim) {
  const byText = new Map()
  for (const c of sim.capture) if (!byText.has(c.segText) || c.ops) byText.set(c.segText, c)
  return (segText, prior, signal) => new Promise((resolve, reject) => {
    const c = byText.get(segText)
    if (!c) { sim.missing.push(segText.length); return reject(new Error('sim-missing-segment')) }
    // 被取消的段没有真实耗时：按「永远来不及」处理
    const ms = c.ops ? c.ms : (c.error && /cancel/i.test(c.error) ? 1e9 : (c.ms || 0))
    const t = setTimeout(() => (c.ops ? resolve({ ops: c.ops }) : reject(new Error(c.error || 'failed'))), Math.min(ms * sim.scale, 2 ** 31 - 1))
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')) }, { once: true })
  })
}

const pct = (xs, q) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null }

export function summarize(rows) {
  const by = {}
  for (const r of rows) (by[r.mode] ||= []).push(r)
  const out = {}
  for (const [m, rs] of Object.entries(by)) {
    const eligible = rs.filter((r) => r.why !== 'below-floor')
    const hit = eligible.filter((r) => r.why === 'condensed' || r.why === 'condensed-partial')
    const whys = {}; for (const r of rs) whys[r.why] = (whys[r.why] || 0) + 1
    out[m] = { blocks: rs.length, eligible: eligible.length, condensed: hit.length, hitRate: eligible.length ? Number((hit.length / eligible.length).toFixed(2)) : null,
      whys, ratioP50: pct(hit.map((r) => r.ratio), 0.5), finishHoldMsP50: pct(rs.map((r) => r.finishHoldMs), 0.5), finishHoldMsMax: Math.max(...rs.map((r) => r.finishHoldMs || 0)),
      outCharsP50: pct(hit.map((r) => r.outChars), 0.5) }
  }
  return out
}

function markdown(o, recs, rows, sum) {
  const L = []
  L.push('# v4 真机测试报告', '', `模型：${o.model}（主模型 thinking enabled；副模型同一模型关思考）· 生成时间：${new Date().toISOString()}`, '')
  L.push('## 录音', '', '| 任务 | 推理字符 | 正文字符 | 主模型总耗时 ms |', '|---|---|---|---|')
  for (const r of recs) L.push(`| ${r.id} | ${r.reasoningChars} | ${r.contentChars} | ${r.totalMs} |`)
  L.push('', '## 汇总（按模式）', '', '| 模式 | 块 | 够门槛 | 替换成功 | 命中率 | 结局分布 | 产物/原文 p50 | 产物字符 p50 | finish 多扣 ms p50 / max |', '|---|---|---|---|---|---|---|---|---|')
  for (const [m, s] of Object.entries(sum)) L.push(`| ${m} | ${s.blocks} | ${s.eligible} | ${s.condensed} | ${s.hitRate} | ${Object.entries(s.whys).map(([k, v]) => k + '×' + v).join(' ')} | ${s.ratioP50} | ${s.outCharsP50} | ${s.finishHoldMsP50} / ${s.finishHoldMsMax} |`)
  L.push('', '## 逐块', '', '| 任务 | 模式 | 结局 | 原文 | 产物 | 比例 | block-end→finish ms | finish 多扣 ms | 副模型 ms | 分段 | v4 拒绝 |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) L.push(`| ${r.id} | ${r.mode} | ${r.why} | ${r.rawChars} | ${r.outChars} | ${r.ratio} | ${r.blockEndToFinishMs} | ${r.finishHoldMs} | ${r.distillMs ?? ''} | ${r.segments ? r.segments.ok + '/' + r.segments.n + ' p50 ' + r.segments.msP50 + 'ms' : ''} | ${r.v4 && r.v4.rejected ? JSON.stringify(r.v4.rejected) : ''} |`)
  L.push('', '## 产物全文（替换成功的块）', '')
  for (const r of rows) if (r.why === 'condensed' || r.why === 'condensed-partial') L.push(`### ${r.id} · ${r.mode} · ${r.why}（${r.rawChars} → ${r.outChars}）`, '', '```', r.text, '```', '')
  return L.join('\n')
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }))
  return out
}

/**
 * --recompile <上次真机的 report.json>：零 API 调用。录音（同目录 recordings.json 或 --replay 指定）按原时序 × scale 回放，
 * 分段结果取自上次捕获 ⇒ 只改了编译 / 合并 / 选取 / 渲染时，可以免费看新代码的产物。切段逻辑变了会记 missing。
 * 限制：不模拟响应头宽限（尾段通常赶不上窗口，影响小）。
 */
async function recompile(o) {
  const prev = JSON.parse(fs.readFileSync(o.recompile, 'utf8'))
  const recPath = o.replay || path.join(path.dirname(o.recompile), 'recordings.json')
  const recs = JSON.parse(fs.readFileSync(recPath, 'utf8'))
  fs.mkdirSync(o.out, { recursive: true })
  const rows = []
  for (const r of prev.rows.filter((x) => x.mode === 'v4inc' && Array.isArray(x.capture))) {
    const rec = recs.find((x) => x.id === r.id)
    if (!rec || (o.only && !o.only.includes(r.id))) continue
    const sim = { capture: r.capture, scale: o.scale, missing: [] }
    const row = await runMode(rec, 'v4inc', { ...o, cfg: { ...(prev.cfg || {}), ...o.cfg } }, '/nonexistent', sim)
    console.log(`  ${row.id}: ${row.why} ${row.rawChars}→${row.outChars}（上次 ${r.outChars}）missing=${sim.missing.length}`)
    rows.push(row)
  }
  const sum = summarize(rows)
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify({ recompiledFrom: o.recompile, scale: o.scale, summary: sum, rows }, null, 2))
  fs.writeFileSync(path.join(o.out, 'report.md'), markdown({ ...o, model: 'recompile(' + o.recompile + ')' }, recs.filter((x) => rows.some((r) => r.id === x.id)), rows, sum))
  console.log(`报告：${path.join(o.out, 'report.md')}`)
}

export async function main(argv) {
  const o = parseArgs(argv)
  if (o.recompile) return recompile(o)
  const key = process.env[o.apiKeyEnv]
  if (!key) throw new Error('环境变量 ' + o.apiKeyEnv + ' 为空（钥匙只从环境变量读）')
  fs.mkdirSync(o.out, { recursive: true })
  const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-live-'))
  const credPath = path.join(credDir, 'credentials.yaml')
  fs.writeFileSync(credPath, 'LIVE_KEY: "' + key + '"\n', { mode: 0o600 })
  process.env.DSH_HOME = credDir
  try {
    let recs
    if (o.tasks) { try { o.taskList = JSON.parse(fs.readFileSync(o.tasks, 'utf8')) } catch { /* 回放时没有 tasks 文件也行 */ } }
    if (o.replay) recs = JSON.parse(fs.readFileSync(o.replay, 'utf8'))
    else {
      let tasks = o.tasks ? JSON.parse(fs.readFileSync(o.tasks, 'utf8')) : TASKS
      o.taskList = tasks
      if (o.only) tasks = tasks.filter((t) => o.only.includes(t.id))
      console.log(`录制 ${tasks.length} 条主模型推理（并发 ${o.concurrency}）…`)
      recs = (await pool(tasks, o.concurrency, async (t) => {
        try { const r = await record(t, o, key); console.log(`  ✓ ${t.id}: 推理 ${r.reasoningChars} 字，${r.totalMs}ms`); return r }
        catch (e) { console.log(`  ✗ ${t.id}: ${e.message}`); return null }
      })).filter(Boolean)
      fs.writeFileSync(path.join(o.out, 'recordings.json'), JSON.stringify(recs))
    }
    if (o.only) recs = recs.filter((r) => o.only.includes(r.id))
    const rows = []
    for (const mode of o.modes) {
      // 缺省逐条回放（= 正常使用时同一时刻只有一个会话在压缩）；并行会让副模型请求挤在一起、被限流，延迟数字偏悲观
      console.log(`回放模式 ${mode}（${recs.length} 条，并发 ${o.replayConcurrency}，按原时序）…`)
      const rs = await pool(recs, o.replayConcurrency, (r) => runMode(r, mode, o, credPath).catch((e) => ({ id: r.id, mode, why: 'harness-error', error: String(e && e.message || e) })))
      for (const r of rs) console.log(`  ${r.id}: ${r.why} ${r.rawChars ?? ''}→${r.outChars ?? ''} hold=${r.finishHoldMs ?? ''}ms`)
      rows.push(...rs)
    }
    const sum = summarize(rows)
    fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify({ model: o.model, modes: o.modes, cfg: o.cfg, summary: sum, rows }, null, 2))
    fs.writeFileSync(path.join(o.out, 'report.md'), markdown(o, recs, rows, sum))
    console.log('\n' + JSON.stringify(sum, null, 2))
    console.log(`\n报告：${path.join(o.out, 'report.md')}`)
  } finally {
    fs.rmSync(credDir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
