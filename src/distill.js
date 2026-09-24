// dsh-cot-form-b / distill.js —— 副模型调用：一次请求的完整生命周期
//
//   generateDistillation  端点/钥匙解析 → 关思考重试降级 → 对冲 → 传输 trace；三种编译模式共用
//   hedgedDistill         对冲请求（hedgeAfterMs，缺省关）：主请求迟迟没有 200 响应头时再发一份，先回头者胜
//   generateStateMemory   memory 模式：证据信封 → 判断稿 → 记忆条目（仍是一次模型调用）
//   distillOnce / distillOnceStream  非流式 / SSE 两种传输形态，同输入同输出形状
import crypto from 'node:crypto'
import { prepareJudgmentPrompt } from './evidence-ledger.js'
import { compileModeOf } from './config.js'
import {
  buildDistillPrompt, compressPromptVersion, compressTargets, buildCompressPromptV3, buildCompressPrompt,
  splitCompressPrompt,
} from './prompts.js'
import { endpointUrl, resolveProviderEndpoint, readApiKeyRef, readApiKey } from './provider.js'
import {
  buildStateCompilePrompt as buildStateCompilePromptSafe, parseStateCompile, createMemoryProjection,
  mergeByEvidence, MODEL_MEMORY_PREAMBLE, renderIncrement, renderCheckpoint, buildProblemUnits,
  MEMORY_POLICY_VERSION, SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION, memoryStats,
  renderProblemUnits,
} from './state-memory.js'
import { settledTraceData } from './trace.js'
import {
  requestStream, extractFromJsonBody, requestOnce, detectResponseProtocol, collectSseFrames,
  assembleSseFrames, isParamRejection, retryDelayMs,
} from './transport.js'

// One completion gate for JSON, SSE and protocol-mismatch paths.
function requireCompleteDistill(got, meta) {
  if (got && got.badFrame) {
    const err = new Error('malformed SSE frame: incomplete evidence')
    err.meta = { ...meta, badFrame: got.badFrame }; throw err
  }
  const finish = got && got.finish
  if (finish === 'stop' || finish === 'completed') return
  const err = new Error((String((got && got.out) || '').trim() ? 'incomplete' : 'empty') +
    ' distillate (finish=' + String(finish || 'missing') + ', reasoningChars=' + ((got && got.reasoningChars) || 0) + ')')
  err.meta = Object.assign({}, meta, { finish, reasoningChars: got && got.reasoningChars,
    outputChars: String((got && got.out) || '').length })
  throw err
}

/**
 * ★★ 2026-09-21 流式单次尝试（观测型迁移）★★
 * 与 distillOnce 同输入、同输出形状，只把传输改成 `stream: true`。
 * 产出 meta 里额外带：firstEventAt / firstContentAt / lastContentAt / completedAt /
 *   finishReason / outputChars / eventCount / truncated —— 用于把"输出前等待"与
 *   "可见输出阶段"分开（见外部审计的字段表）。
 * ⚠ 只认【非空 content delta】为首个内容：role-only delta、空串、usage、心跳一律不算。
 * ⚠ 半成品绝不冒充成功：未收到正常 finish 的流一律抛错，由上层原文放行。
 */
async function distillOnceStream(key, prompt, cfg, thinkingOff, ep, signal, inputChars = 0) {
  const style = ep && ep.api === 'openai-responses' ? 'responses' : 'chat'
  const url = (ep && ep.url) ? ep.url : endpointUrl(cfg.baseUrl, 'openai-completions')
  if (!url) throw new Error('no endpoint: neither host provider nor cfg.baseUrl resolved a URL')
  const payload = style === 'responses'
    ? { model: cfg.model, input: prompt, max_output_tokens: cfg.maxOutputTokens, temperature: 0, stream: true }
    : { model: cfg.model, messages: Array.isArray(cfg._promptMessages) ? cfg._promptMessages : [{ role: 'user', content: prompt }], max_tokens: cfg.maxOutputTokens, temperature: 0, stream: true }
  if (thinkingOff) {
    if (style === 'responses') payload.reasoning = { effort: 'none' }
    else payload.thinking = { type: 'disabled' }
  }
  const body = JSON.stringify(payload)
  let r
  try {
    r = await requestStream(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
        'Accept-Encoding': 'identity',
      },
      body, timeoutMs: cfg.timeoutMs, cfg, signal, onHeaders: cfg._onHeaders || null,
    })
  } catch (e) {
    // ★★ 2026-09-21 补数据缺口（本轮实测发现）★★
    //   失败/取消路径此前**不带 promptChars** —— 恰恰在最需要看输入体积的时候看不见。
    //   后果：无法区分「TTFB 把预算吃光」与「生成本身太慢」这两类完全不同的失败。
    //   这里只补请求指纹，**不改任何行为**，然后原样抛出。
    e.meta = Object.assign({}, e.meta, {
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      stream: true, thinkingOff, model: cfg.model, stage: e.meta?.headersAt == null ? 'await-headers' : (e.meta?.eventCount ? 'receive-body' : 'await-first-event'),
    })
    throw e
  }
  if (r.status !== 200) throw Object.assign(new Error('http ' + r.status + ' (stream)'), { meta: r.meta })
  // ★ 统一响应入口（反向错配）：要求流式（stream:true），上游却回了整段 JSON。
  //   按 JSON 解析并显式记录；仍然遵守「半成品绝不冒充成功」——空摘要照样抛错。
  if (r.meta && r.meta.nonSse) {
    r.meta.protocolMismatch = 'json-body-on-stream-request'
    let j
    try { j = JSON.parse(String(r.text || '')) } catch (e) {
      throw new Error('bad json (stream request got non-sse body): ' + String(r.text || '').slice(0, 120))
    }
    if (j.usage) r.meta.providerReportedUsage = j.usage
    const got = extractFromJsonBody(j, style)
    if (!got) throw new Error('no choices (stream request got non-sse body): ' + String(r.text || '').slice(0, 120))
    requireCompleteDistill(got, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true, model: cfg.model })
    if (!String(got.out).trim()) {
      throw new Error('empty distillate (finish=' + got.finish + ', reasoningChars=' + got.reasoningChars + ', protocol=json-on-stream)')
    }
    return {
      text: String(got.out).trim(),
      meta: Object.assign({ finish: got.finish, reasoningChars: got.reasoningChars, thinkingOff, model: cfg.model, inputChars,
        promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
        endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit' }, r.meta),
    }
  }

  let out = ''
  let finish = ''
  let reasoningChars = 0
  let firstContentAt = null
  let lastContentAt = null
  let sawDone = false
  let badFrame = 0
  for (const ev of r.events) {
    let j = ev.json
    if (j === undefined) { try { j = JSON.parse(ev.data) } catch { badFrame += 1; continue } }
    if (style === 'responses') {
      // responses 流：只认 output_text.delta
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string' && j.delta) {
        out += j.delta
        if (firstContentAt === null) firstContentAt = ev.at
        lastContentAt = ev.at
      } else if (j.type === 'response.completed') { finish = 'stop'; sawDone = true }
      else if (j.type === 'response.incomplete') { finish = 'length'; sawDone = true }
      else if (j.type === 'response.reasoning_summary_text.delta' || j.type === 'response.reasoning_text.delta') {
        reasoningChars += String(j.delta || '').length
      }
      continue
    }
    const ch = j && j.choices && j.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (typeof d.reasoning_content === 'string') reasoningChars += d.reasoning_content.length
    // ⚠ 只有【非空 content】才算"首个摘要内容"
    if (typeof d.content === 'string' && d.content.length > 0) {
      out += d.content
      if (firstContentAt === null) firstContentAt = ev.at
      lastContentAt = ev.at
    }
    if (ch.finish_reason) { finish = ch.finish_reason; sawDone = true }
  }
  if (r.meta.done) sawDone = true

  // ④ 未正常完成 ⇒ 绝不冒充成功（连接断开、缺 [DONE]、缺 finish_reason 都算）
  if (!sawDone || r.meta.truncated) {
    const err = new Error('stream incomplete (done=' + sawDone + ', truncated=' + r.meta.truncated +
      ', events=' + r.events.length + ', finish=' + (finish || 'none') + ')')
    err.meta = Object.assign({}, r.meta, { firstContentAt, lastContentAt, finish })
    throw err
  }
  // ④ finish_reason=length ⇒ 被截断的摘要不是完整摘要
  // ★ 2026-09-22 补漏（用户要求）：这条失败路径此前把 promptChars 丢了 —— 恰好在
  //   最需要看「输入到底多大」的时候看不见。原因：下面 Object.assign 的基对象里
  //   有 promptChars，但失败分支直接用了 r.meta（它没有该字段）。故此处显式带上。
  if (finish === 'length') {
    const err = new Error('empty distillate (finish=length, stream truncated by max_tokens)')
    err.meta = Object.assign({}, r.meta, {
      firstContentAt, lastContentAt, finish,
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true,
      reasoningChars, model: cfg.model,
    })
    throw err
  }
  requireCompleteDistill({ out, finish, reasoningChars, badFrame }, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true, model: cfg.model })
  if (!String(out).trim()) {
    const err = new Error('empty distillate (finish=' + finish + ', reasoningChars=' + reasoningChars + ', stream)')
    err.meta = Object.assign({}, r.meta, {
      firstContentAt, lastContentAt, finish,
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true,
      reasoningChars, model: cfg.model,
    })
    throw err
  }
  return {
    text: String(out).trim(),
    meta: Object.assign({
      finish, reasoningChars, thinkingOff, model: cfg.model, inputChars,
      inputChars, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      stream: true, eventCount: r.meta.eventCount, badFrame,
      outputChars: String(out).trim().length,
      firstEventAt: r.meta.firstEventAt, firstContentAt, lastContentAt, completedAt: r.meta.completedAt,
      // 阶段分解（都是相对 requestSentAt 的毫秒数，便于直接比较）
      toHeadersMs: r.meta.ttfbMs,
      toFirstEventMs: r.meta.firstEventAt === null ? null : r.meta.firstEventAt - r.meta.requestSentAt,
      toFirstContentMs: firstContentAt === null ? null : firstContentAt - r.meta.requestSentAt,
      contentSpanMs: (firstContentAt === null || lastContentAt === null) ? null : lastContentAt - firstContentAt,
      toCompleteMs: r.meta.totalMs,
      endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit',
    }, r.meta),
  }
}

// 单次尝试。thinkingOff=true 时带上 `thinking:{type:'disabled'}`（关掉模型的思考）
async function distillOnce(key, prompt, cfg, thinkingOff, ep, signal, inputChars = 0) {
  const style = ep && ep.api === 'openai-responses' ? 'responses' : 'chat'
  // ⚠ 端点来自 resolveProviderEndpoint()；ep 为 null 时回落显式配置。
  //   2026-09-19：原写法 `cfg.baseUrl.replace(...)` 在 baseUrl 为空时会产出
  //   '/v1/chat/completions' 这样的**相对 URL**，报错会很难查。空就明说（上层已拦，这里是第二道）。
  const url = (ep && ep.url) ? ep.url : endpointUrl(cfg.baseUrl, 'openai-completions')
  if (!url) throw new Error('no endpoint: neither host provider nor cfg.baseUrl resolved a URL')
  const payload = style === 'responses'
    ? { model: cfg.model, input: prompt, max_output_tokens: cfg.maxOutputTokens, temperature: 0 }
    : { model: cfg.model, messages: Array.isArray(cfg._promptMessages) ? cfg._promptMessages : [{ role: 'user', content: prompt }], max_tokens: cfg.maxOutputTokens, temperature: 0 }
  if (thinkingOff) {
    // 关思考的字段名按 api 风格给：chat 用 thinking，responses 用 reasoning.effort
    if (style === 'responses') payload.reasoning = { effort: 'none' }
    else payload.thinking = { type: 'disabled' }
  }
  const body = JSON.stringify(payload)
  const r = await requestOnce(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      // ⚠ node:https 不像 fetch 那样自动解压 ⇒ 显式要 identity，避免拿到二进制乱码
      'Accept-Encoding': 'identity',
    },
    body,
    timeoutMs: cfg.timeoutMs,
    cfg,
    signal,
    onHeaders: cfg._onHeaders || null,
  })
  if (r.status !== 200) throw new Error('http ' + r.status + ' ' + r.text.slice(0, 120))
  // ★★ 统一响应入口（2026-09-21）：先判【响应实际协议】，再选解析器 ★★
  //   事故：非流式请求收到 SSE 体 ⇒ 旧写法直接 JSON.parse ⇒ 'bad json'（trace 4 次）。
  //   错配时按【实际协议】解析并显式记录；绝不靠「失败后重发」掩盖本地解析缺陷。
  const protocol = detectResponseProtocol(r.text, r.meta && r.meta.contentType)
  let got
  if (protocol === 'sse') {
    r.meta.protocolMismatch = 'sse-body-on-json-request'
    got = collectSseFrames(assembleSseFrames(r.text).datas, style)
  } else {
    let j
    try { j = JSON.parse(r.text) } catch (e) { throw new Error('bad json: ' + r.text.slice(0, 120)) }
    if (j.usage) r.meta.providerReportedUsage = j.usage
    got = extractFromJsonBody(j, style)
    if (!got) throw new Error('no choices: ' + r.text.slice(0, 120))
  }
  const out = got.out
  const finish = got.finish
  const reasoningChars = got.reasoningChars
  requireCompleteDistill(got, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, model: cfg.model })
  // ★ 2026-09-15 实测：思考型模型会把整个 max_tokens 烧在 reasoning_content 上，
  //   然后 content 返回空串、finish_reason='length'。
  //   这时必须**把 finish_reason 和 reasoning 长度写进错误**，
  //   否则 trace 里只会看到一句含糊的 "empty distillate"，查不出真因。
  if (!String(out).trim()) {
    throw new Error('empty distillate (finish=' + finish + ', reasoningChars=' + reasoningChars + ')')
  }
  return {
    text: String(out).trim(),
    meta: Object.assign({ finish, reasoningChars, thinkingOff, model: cfg.model, inputChars,
      // ★ 2026-09-21 请求指纹（外部审计 P0-1）：把这次调用【实际发了什么】钉进 trace，
      //   否则「新旧构建交错测试」无法证明两次请求体是否等价。
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit' }, r.meta),
  }
}

// 返回 { text, meta }：meta 里带本次调用的连接复用证据 + 实际用的模型
/**
 * ★★ 2026-09-21 任务状态编译（有证据支撑的任务状态记忆）★★
 *
 * 与 generateDistillation **共用同一条传输/重试/超时/取消机制**：
 * 仍是**一次**模型调用，不加串行调用链。
 * 生产 birth 默认为确定性记录 + 两栏判断；无 frame 的导出调用保留旧六栏兼容。
 *
 * 输出仍受原有铁律约束：模型完整成功 AND CAS 成功 AND 输出可接受 AND 净省达标，
 * 否则原文放行（判定在 birthFinish，不在本函数）。
 */
export async function generateStateMemory(env, cfg, signal, runtime = {}) {
  const hybrid = !!env?.deterministicFrame
  const prepared = hybrid ? (runtime.preparedJudgment?.env === env ? runtime.preparedJudgment : prepareJudgmentPrompt(env)) : null
  const prompt = prepared ? prepared.prompt : buildStateCompilePromptSafe(env)
  let r
  try { r = await generateDistillation(env && env.cot, cfg, signal, prompt, { ...runtime, promptVersion: prepared?.version }) }
  catch (e) {
    e.meta = { ...e.meta, promptBuildMs: prepared?.buildMs ?? null, promptBuildCount: prepared ? 1 : null,
      promptVersion: prepared?.version ?? null, staticPrefixChars: prepared?.staticPrefixChars ?? null }
    throw e
  }
  const renderStarted = performance.now()
  const parsed = parseStateCompile(r && r.text)
  if (hybrid && (!parsed.labeled || !parsed.found.length || parsed.extra.length || parsed.found.some(k => k !== 'judgment' && k !== 'gap'))) {
    const error = new Error('invalid judgment-only response'); error.meta = { ...r?.meta, parseRenderMs: performance.now() - renderStarted, promptVersion: prepared?.version }; throw error
  }
  const mp = createMemoryProjection({ namespace: 'compile-' + crypto.randomUUID() })
  const blockIndex = env && env.host && env.host.blockIndex != null ? env.host.blockIndex : null
  mp.ingest(parsed, { at: env && env.at != null ? env.at : Date.now(), origin: 'model', evidence: 'inferred', blockIndex })
  // ★ 证据驱动归并：时间顺序只决定处理顺序，证据关系决定能否替代
  const entries = mergeByEvidence(mp.all())
  // birth 用**本轮增量**（完整状态由 checkpoint 承载），避免每块复述所有历史约束
  const renderOpts = { preamble: MODEL_MEMORY_PREAMBLE }
  const born = renderIncrement(entries, blockIndex, renderOpts) + (hybrid && env.deterministicFrame.indexPath ? '\n〔确定性证据索引（工具事件不等于任务完成）：' + env.deterministicFrame.indexPath + '〕' : '')
  const board = renderCheckpoint(entries, renderOpts)
  // ★ 问题单元：把同一问题的信息连起来（只归拢已有材料，不新增事实）
  const unitInfo = cfg.stateProblemUnits === false ? { units: [], orphan: [] } : buildProblemUnits(entries)
  return {
    // ⚠ 保持与 generateDistillation 同形状：birthFinish 只认 text/meta
    text: born,
    meta: Object.assign({}, (r && r.meta) || {}, {
      stateMemory: true,
      promptBuildMs: prepared?.buildMs ?? null, promptBuildCount: prepared ? 1 : null,
      promptVersion: prepared?.version ?? null, staticPrefixChars: prepared?.staticPrefixChars ?? null,
      parseRenderMs: performance.now() - renderStarted,
      compilerMode: hybrid ? 'grounded-judgment-v2' : 'legacy-six-section',
      deterministicRevision: env?.deterministicFrame?.revision ?? null,
      evidenceProvided: env?.deterministicFrame?.evidenceInput?.receipts || null,
      evidenceBodyChars: env?.deterministicFrame?.evidenceInput?.bodyChars ?? null,
      duplicateBodyCharsAvoided: env?.deterministicFrame?.evidenceInput?.duplicateBodyCharsAvoided ?? null,
      evidencePolicy: env?.deterministicFrame?.evidenceInput?.policy || null,
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      schemaVersion: SCHEMA_VERSION, compilerVersion: COMPILER_VERSION, rendererVersion: RENDERER_VERSION,
      parsedSections: parsed.found,
      parsedExtra: parsed.extra.length,
      memory: memoryStats(entries),
      birthChars: born.length,
      boardChars: board.length,
      problemUnits: unitInfo.units.length,
      orphanEntries: unitInfo.orphan.length,
    }),
    // 供 checkpoint 路径使用（本函数不自行提交任何东西）
    checkpointText: hybrid ? born : board,
    entries,
    // ★ 供并行块的有序归并使用（按源块顺序，不按完成顺序）
    parsed,
    units: unitInfo.units,
    unitsText: unitInfo.units.length ? renderProblemUnits(unitInfo.units) : null,
  }
}

/**
 * ★★ v11.7 对冲请求（hedged request）★★
 *
 * 为什么：蒸馏 TTFB 实测 min 1,382 / p50 3,109 / max 7,857（n=340），connectMs 3~15、reasoning_tokens 0、
 *   prompt 极小 ⇒ 那 3 秒是服务端首 token 前的排队，方差大、请求侧已无可挤。
 *   对排队型延迟，标准解是对冲：主请求发出 hedgeAfterMs 仍未收到**响应头**，再发一份完全相同的请求，
 *   谁先回头用谁，另一份立即 abort。两次独立抽样取 min ⇒ 尾部（p90 6~8s）被砍掉，p50 也下移。
 *
 * 成本纪律（硬约束「稳定优先」）：
 *   · 只在 hedgeAfterMs（缺省 = 关闭；建议 ≥ p50 ≈ 3000）之后才对冲 ⇒ 大多数请求只发一份，只有尾部触发；
 *   · 判据是**响应头**而不是完成：头一到就说明排队已结束，此时另一份还没出 token，abort 掉不计费；
 *   · 同一时刻**整个进程**至多 1 份对冲在飞（模块级计数，跨会话共享），并发绝不翻倍；
 *   · 对冲份用同一 prompt / 同一 key / 同一 endpoint ⇒ 结果等价，不引入任何新语义；
 *   · 任一失败不影响另一份；两份都失败 ⇒ 抛主份的错误（与不对冲时同形）。
 *   最坏情况：hedge 从未触发（= 今天的行为）；或触发后两份都慢（多付一次输入费，输出仍只有一份）。
 */
let hedgeInFlight = 0
export async function hedgedDistill(fn, key, prompt, cfg, thinkingOff, ep, signal, inputChars, emit = () => {}, requestId = null) {
  const after = Number(cfg.hedgeAfterMs)
  const enabled = Number.isFinite(after) && after > 0 && cfg.maxAttempts <= 1
  if (!enabled || (signal && signal.aborted)) return fn(key, prompt, cfg, thinkingOff, ep, signal, inputChars)
  const mkCtl = () => {
    const ctl = new AbortController()
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }) }
    return ctl
  }
  const primaryCtl = mkCtl()
  // primaryDone：主请求已结算（成功或失败）⇒ 计时器到点也不得再发对冲
  //   （v11.7 缺陷：主请求 8ms 就 400，计时器仍在 1000ms 发出对冲，白付一次输入费且推迟降级）。
  let primaryHeaders = false, primaryDone = false, hedgeCtl = null, hedgeTimer = null, hedgeStartedAt = null, winner = null
  let hedgeResolve = null
  const outer = typeof cfg._onHeaders === 'function' ? cfg._onHeaders : null
  // ⚠ 只有 **200** 的响应头才算「排队结束、开始生成」；4xx/5xx 的头不得宣布胜出、不得取消另一份、
  //   也不得对外报告 headers（否则一个瞬时 503 会把健康的那份掐掉 —— 自测抓出）。
  const primaryCfg = { ...cfg, _onHeaders: (info) => { if (!info || info.status !== 200) return; primaryHeaders = true; if (hedgeCtl && !winner) { winner = 'primary'; hedgeCtl.abort() } if (outer) outer(info) } }
  const primary = fn(key, prompt, primaryCfg, thinkingOff, ep, primaryCtl.signal, inputChars)
  const hedgeP = new Promise((resolve, reject) => {
    hedgeResolve = resolve
    hedgeTimer = setTimeout(() => {
      if (primaryDone || primaryHeaders || primaryCtl.signal.aborted || hedgeInFlight >= 1) { resolve(null); return }
      hedgeInFlight++
      hedgeCtl = mkCtl()
      hedgeStartedAt = Date.now()
      const hedgeCfg = { ...cfg, _onHeaders: (info) => { if (!info || info.status !== 200) return; if (!winner) { winner = 'hedge'; primaryCtl.abort() } if (outer) outer(info) } }
      emit('compiler-hedge-fired', { requestId, afterMs: after })
      fn(key, prompt, hedgeCfg, thinkingOff, ep, hedgeCtl.signal, inputChars)
        .then((r) => { hedgeInFlight--; resolve(r) }, (e) => { hedgeInFlight--; reject(e) })
    }, after)
  })
  const tag = (r, who) => { if (r && typeof r === 'object') r.meta = { ...r.meta, hedged: who, hedgeAfterMs: after, hedgeStartedAt }; return r }
  try {
    // 谁先**成功**用谁；先失败的一方不算数（另一方仍可能成功）
    const r = await new Promise((resolve, reject) => {
      let failed = 0, firstErr = null
      const fail = (e) => { failed++; firstErr ||= e; if (failed === 2) reject(firstErr) }
      primary.then((r) => { primaryDone = true; resolve(tag(r, 'primary')) }, (e) => {
        primaryDone = true
        if (e && e.cancelled && winner === 'hedge') { failed++; if (failed === 2) reject(firstErr || e) } else fail(e)
        // 主请求失败时对冲尚未发出 ⇒ 不再对冲，立即按主请求的错误结算（不陪计时器空等）
        if (hedgeStartedAt == null) { clearTimeout(hedgeTimer); hedgeResolve(null) }
      })
      hedgeP.then((r) => { if (r == null) { failed++; if (failed === 2) reject(firstErr) } else resolve(tag(r, 'hedge')) },
        (e) => { if (e && e.cancelled && winner === 'primary') { failed++; if (failed === 2) reject(firstErr || e) } else fail(e) })
    })
    emit('compiler-hedge-settled', { requestId, winner: r.meta.hedged, fired: hedgeStartedAt != null, ttfbMs: r.meta.ttfbMs })
    return r
  } finally {
    clearTimeout(hedgeTimer)
    if (!primaryCtl.signal.aborted) primaryCtl.abort()
    if (hedgeCtl && !hedgeCtl.signal.aborted) hedgeCtl.abort()
  }
}

export async function generateDistillation(cot, cfg, signal, promptOverride, runtime = {}) {
  cfg = { ...cfg } // Freeze effective scalar request settings before asynchronous dispatch.
  if (!cfg.model) {
    // ⛔ 不猜模型名。followHostModel 开着但还没见过宿主模型 ⇒ 放弃提纯，由上层原文放行。
    throw new Error('no model: followHostModel 开着但尚未读到宿主对话模型，且 cfg.model 为空')
  }
  // ★ 端点与钥匙跟随宿主 provider；解析失败**不猜**。
  //   2026-09-19 加固：原实现「解析失败 ⇒ 回落显式 baseUrl/credentialRef」，而那两个
  //   默认值曾经是作者的商户 ⇒ 外人装上后会去连不属于他的端点。现在两条路都要求
  //   【有人真的给过值】：宿主 provider 解析，或 patch 里的显式配置。都没有 ⇒ 抛错，
  //   由上层原文放行 —— 与上面 no-model 完全同形。
  const ep = resolveProviderEndpoint(cfg, cfg.followProvider)
  if (!ep && !cfg.baseUrl) {
    throw new Error('no endpoint: followHostProvider 解析不出宿主 provider，且 cfg.baseUrl 为空')
  }
  let key
  if (ep && ep.apiKeyEnv) key = readApiKeyRef(cfg, ep.apiKeyEnv)
  else key = readApiKey(cfg)
  // ★ 2026-09-21 任务状态记忆：允许调用方提供自定义提示词（仍是**一次**模型调用）。
  //   不传就沿用旧的 buildDistillPrompt —— 旧路径完全不变，可随时回滚。
  const prompt = promptOverride != null ? String(promptOverride) : buildDistillPrompt(cot)
  // ★ 2026-09-22 切分：记下**真正要压缩的输入**长度，使放大倍数可核。
  //   compress 模式：inputChars = 本段 reasoning 的字符数 ⇒ promptChars/inputChars 应 ≈ 1.x
  //   memory  模式：inputChars 仍是 raw，但真实的证据体量在 evidenceBodyChars，
  //                两者之差就是 7.5x 放大的来源，必须能被同一张表看出来。
  const inputChars = typeof cot === 'string' ? cot.length : 0
  const emit = (tag, data) => { try { runtime.trace?.(tag, data) } catch {} }
  const execute = async (transportSignal, flightId = null) => {
    const rounds = Math.max(1, cfg.maxAttempts)
    // 每一轮先带「关掉思考」试，被网关拒（4xx）再裸试一次。
    // 参数拒绝才沿用既有降级路径；实际请求与费用不能凭 4xx 推断。
    const modes = cfg.disableThinking ? [true, false] : [false]
    let lastErr
    for (let attempt = 1; attempt <= rounds; attempt++) {
      for (let i = 0; i < modes.length; i++) {
        try {
          if (transportSignal && transportSignal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true })
          // ★ 2026-09-21 观测型流式迁移：cfg.distillStream=true 时走 SSE。
          //   两者【同输入、同输出形状】，只有传输方式不同 ⇒ 可 A/B。
          const fn = cfg.distillStream ? distillOnceStream : distillOnce
          const requestId = crypto.randomUUID()
          emit('compiler-transport-started', { requestId, flightId, attempt, thinkingOff: modes[i], model: cfg.model, timeoutMs: cfg.timeoutMs,
            endpoint: ep ? ep.provider + '|' + ep.api : 'legacy|explicit', maxOutputTokens: cfg.maxOutputTokens,
            stream: !!cfg.distillStream, promptVersion: runtime.promptVersion || null })
          try {
            const r = await hedgedDistill(fn, key, prompt, cfg, modes[i], ep, transportSignal, inputChars, emit, requestId)
            // ★ promptVersion 必须进 meta：birth-distill-settled / compiler-transport-settled 才能区分 v1/v2 做 A/B
            r.meta = { ...r.meta, requestId, flightId, promptVersion: runtime.promptVersion || r.meta?.promptVersion || null }
            emit('compiler-transport-settled', { ...settledTraceData(null, r.meta.totalMs, { ok: true, ...r }), requestId, flightId })
            return r
          } catch (e) {
            e.meta = { promptChars: prompt.length, inputChars, model: cfg.model, maxOutputTokens: cfg.maxOutputTokens,
              thinkingOff: modes[i], stream: !!cfg.distillStream, ...e.meta, requestId, flightId, promptVersion: runtime.promptVersion || e.meta?.promptVersion || null }
            emit('compiler-transport-settled', { ...settledTraceData(null, e.meta.totalMs, { ok: false, error: e.message, meta: e.meta }), requestId, flightId })
            throw e
          }
        } catch (e) {
          lastErr = e
          const canDowngrade = i < modes.length - 1 && isParamRejection(e)
          if (!canDowngrade) break
        }
      }
      if (attempt < rounds) {
        const delay = retryDelayMs(lastErr, attempt)
        if (delay == null) { emit('compiler-retry-skipped', { attempt, error: String((lastErr && lastErr.message) || lastErr) }); break }
        await new Promise((s) => setTimeout(s, delay))
      }
    }
    throw lastErr
  }
  if (!runtime.flights) return execute(signal)
  // Exact text, scope, effective endpoint/credential and all transport knobs.
  // Private ephemeral key; NEVER trace it or export a credential fingerprint.
  const identity = runtime.scope == null ? null : JSON.stringify([runtime.scope,
    ep?.url || endpointUrl(cfg.baseUrl, 'openai-completions'), ep?.api || 'openai-completions', ep?.provider || null,
    key, cfg.model, cfg.maxOutputTokens, cfg.timeoutMs, cfg.maxAttempts, cfg.disableThinking,
    cfg.distillStream, cfg.keepAlive, cfg.keepAliveMsecs]) + '\n' + prompt
  return runtime.flights.run(identity, execute, { signal, trace: runtime.trace })
}

/**
 * ★ v11.10 birth 编译器工厂：按 compileMode 三选一构造 `deps.distill(input, signal, budget)`。
 *   原先是 plugin.js 里一段内联三元表达式（无法单测）；现在搬到这里，语义逐字不变：
 *     memory   → generateStateMemory(env, cfg, signal, { ...budget, flights })   证据信封 → 判断稿
 *     compress → 按 compressPromptVersion 选提示词 → generateDistillation(raw, …) 本段推理的摘要
 *     legacy   → generateDistillation(raw, cfg, signal)                         旧蒸馏提示词
 *   compress / legacy 只透传 trace（compiler-transport-* / compiler-hedge-*）。
 *   ⚠ 不传 flights：这两种模式没有 scope（证据截面只在 memory 模式存在）⇒ 共享永不命中，
 *     反而会把取消路径的传输 meta（ttfbMs/stage 等）换成合成错误，损失线上诊断数据。
 * @param cfg 本条流冻结的配置副本（调用方负责拷贝）
 * @param opts { flights } 精确在途共享（仅 memory 模式使用）
 */
export function makeBirthCompiler(cfg, opts = {}) {
  const runtimeOf = (budget) => ({ trace: budget && typeof budget.trace === 'function' ? budget.trace : undefined })
  const withHeaders = (budget) => (budget && typeof budget.onHeaders === 'function' ? { ...cfg, _onHeaders: budget.onHeaders } : cfg)
  const mode = compileModeOf(cfg)
  if (mode === 'memory') {
    return async (env, signal, budget) => generateStateMemory(env, cfg, signal, { ...budget, flights: opts.flights })
  }
  if (mode === 'compress') {
    return async (raw, signal, budget) => {
      // 提示词选择与版本号必须来自**同一次**裁决，否则 trace 会把 A 的产物记成 B 的版本。
      const pv = compressPromptVersion(cfg)
      const prompt = pv === 'compress-v1' ? buildDistillPrompt(raw)
        : pv.indexOf('compress-v3') === 0
          ? (() => { const t = compressTargets(cfg); return buildCompressPromptV3(raw, t.min, t.max) })()
          : buildCompressPrompt(raw)
      // 响应头信号只活在这次调用的 cfg 副本里，不进 BOOT、不进 trace
      const c = { ...withHeaders(budget) }
      // 缓存友好拆分（opt-in）：system=规则前缀、user=原文；字节等价，只改消息形状。v1 不拆（它无 marker）。
      if (cfg.compressSystemPrompt === true && pv !== 'compress-v1') {
        const sp = splitCompressPrompt(prompt)
        if (sp) c._promptMessages = [{ role: 'system', content: sp.system }, { role: 'user', content: sp.user }]
      }
      return generateDistillation(raw, c, signal, prompt, { ...runtimeOf(budget), promptVersion: pv })
    }
  }
  return async (raw, signal, budget) => generateDistillation(raw, withHeaders(budget), signal, undefined, runtimeOf(budget))
}
