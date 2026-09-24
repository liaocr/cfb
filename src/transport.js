// dsh-cot-form-b / transport.js —— HTTP 传输层（node:http/https 直连，零依赖）
//
//   requestOnce / requestStream  单次请求（不重试）；keep-alive 连接池；响应体 4MB 硬上限
//   makePrewarmer                可选 HEAD 预热（缺省关，三组对照实测为负收益）
//   retryDelayMs                 只对瞬时错误退避重试；4xx 参数拒绝走降级而不是重试
//   detectResponseProtocol / assembleSseFrames / collectSseFrames / extractFromJsonBody
//                                按响应实际协议解析（流式/非流式错配显式留痕，不靠重发掩盖）
import http from 'node:http'
import https from 'node:https'
import { resolveProviderEndpoint } from './provider.js'

// ── 传输层：持久连接（keep-alive）+ 预热 ────────────────────────────────────
//
// ⚠ 为什么不用 fetch：
//   ① 全局 fetch 是 undici，`undici` 包在本插件目录**不可导入**（无 node_modules），
//      所以拿不到 `new Agent({keepAliveTimeout})`，也就无法延长默认的 4 秒复用窗口。
//   ② `fetch` **不接受 `https.Agent`** —— 审稿人给的 `new https.Agent({...})` 代码片段
//      贴进 fetch 是无效的。要用 https.Agent 就必须走 node:https。
//   ③ node:https 还能给出 `req.reusedSocket` —— **可落 trace 的复用证据**，
//      这正是本项目「必须看 trace 说话」需要的那个观测口。
//   ⇒ 改用 node:http/https + 自持 Agent。零新增依赖。
// ⚠ agentCache 按**配置签名**分桶，不能只按"有没有缓存过"。
//   模块级单例 + 同进程多次 apply()（自测就是）时，只认第一次的 keepAlive 配置
//   ⇒ 后续 apply 的配置被静默忽略，测试会因为错误的原因通过。
let agentCache = new Map()
function getAgent(cfg) {
  const opts = {
    keepAlive: cfg.keepAlive !== false,
    keepAliveMsecs: cfg.keepAliveMsecs || 60000,
    maxSockets: 4,
    maxFreeSockets: 2,
  }
  const sig = opts.keepAlive + '|' + opts.keepAliveMsecs
  let hit = agentCache.get(sig)
  if (!hit) {
    hit = { 'http:': new http.Agent(opts), 'https:': new https.Agent(opts) }
    agentCache.set(sig, hit)
  }
  return hit
}

// 单次请求（不做重试）。返回 { status, text, meta }
// meta 里的 reused / connectMs / ttfbMs 是**实测的复用证据**，直接落 trace。
export function requestOnce(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 8000, cfg = null, signal = null, onHeaders = null } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const agent = cfg ? getAgent(cfg)[u.protocol] : undefined
    const t0 = Date.now()
    // ★ 2026-09-21 阶段探针（外部审计 P0-1）：把一次请求切成
    //   connectMs（建连）/ ttfbMs（响应头）/ firstByteMs（首个正文字节）/ totalMs（读完）。
    //   非流式下 firstByte≈ttfb（服务端常攒完才发头），但只要上游改成 chunked，这两个数
    //   立刻能把「排队」与「生成」分开 —— 这正是当前最缺、且无法从总时长反推的信息。
    const meta = { reused: null, connectMs: null, ttfbMs: null, firstByteMs: null, status: null, bytes: null, chunks: 0, totalMs: null, cancelled: false }
    let killer = null
    let settled = false
    const done = (fn, v) => { if (settled) return; settled = true; if (killer) clearTimeout(killer); fn(v) }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      agent,
    }, (res) => {
      meta.ttfbMs = Date.now() - t0
      meta.reused = req.reusedSocket === true
      meta.status = res.statusCode
      // ★ v11.7 响应头信号：排队结束的唯一直接证据（供 hedging 取消与收尾宽限使用）。绝不抛。
      if (typeof onHeaders === 'function') { try { onHeaders({ status: res.statusCode, ttfbMs: meta.ttfbMs }) } catch {} }
      // ★ 统一响应入口的旁证：协议判定以【响应体结构】为主，Content-Type 只作补充
      meta.contentType = res.headers['content-type'] || null
      const chunks = []
      let bytes = 0
      res.on('data', (c) => {
        if (meta.firstByteMs === null) meta.firstByteMs = Date.now() - t0
        meta.chunks += 1
        bytes += c.length
        // 上限 4MB：与 requestStream 对齐；正常 completion 远小于此，超限即放弃，绝不无限累积
        if (bytes > RESPONSE_BYTES_MAX) {
          const err = new Error('response exceeds 4MB'); err.meta = meta
          req.destroy(err); done(reject, err); return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        meta.bytes = buf.length
        meta.totalMs = Date.now() - t0
        done(resolve, { status: res.statusCode, text: buf.toString('utf8'), meta })
      })
      res.on('error', (e) => done(reject, e))
    })
    req.on('socket', (s) => {
      if (s.connecting) s.once('secureConnect', () => { meta.connectMs = Date.now() - t0 })
      else if (isHttps) meta.connectMs = Date.now() - t0
    })
    req.on('error', (e) => { e.meta = meta; done(reject, e) })
    // ★ 2026-09-21 主动取消（外部审计 P0-2）：放弃应用后，不再让一个注定被丢弃的请求
    //   继续占用本地连接槽与上游算力。注意：本地 abort 是否真的终止了【服务端】计算，
    //   本机无法证明 —— 它只能保证我们这边立刻松手。这一点在文档里如实标注。
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        const err = new Error('cancelled')
        err.cancelled = true
        err.meta = meta
        meta.cancelled = true
        meta.totalMs = Date.now() - t0
        try { req.destroy(err) } catch { /* ignore */ }
        done(reject, err)
      }
      const detach = () => { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', detach)
      }
    }
    // 总超时（对齐原 AbortSignal.timeout 的语义：整通请求的硬上限）
    if (timeoutMs > 0) killer = setTimeout(() => {
      const err = new Error('timeout ' + timeoutMs + 'ms')
      err.meta = meta
      try { req.destroy(err) } catch { /* ignore */ }
      done(reject, err)
    }, timeoutMs)
    if (body != null) req.write(body)
    req.end()
  })
}

/**
 * ★★ 2026-09-21 观测型流式迁移（外部审计 P0-1）★★
 * 目的：把现在混在一起的"响应到达前的等待"与"可见输出阶段"拆开。
 * 只改【插件 ↔ 蒸馏服务】之间的传输方式；会话协议、用户可见行为、兜底语义全部不变。
 *
 * 必须守住的边界（逐条对应外部审计的清单）：
 *   ① 网络 chunk ≠ SSE 事件 ⇒ 跨 chunk 缓冲，按【字节】找 \n 切行
 *      （0x0A 不可能出现在 UTF-8 多字节序列内部，故按字节切行天然 UTF-8 安全）
 *   ② 收到一部分摘要 ≠ 成功 ⇒ 只有协议确认正常完成才算 ok，由调用方判定
 *   ③ 连接断开 ≠ 正常完成 ⇒ 'aborted' 单独报，绝不冒充 end
 *   ④ finish_reason=length ≠ 完整摘要 ⇒ 原样带出去，由调用方拒绝
 *
 * @returns {Promise<{status:number, meta:object, events:Array<{at:number,data:string}>}>}
 */
export function requestStream(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 8000, cfg = null, signal = null, onHeaders = null } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const agent = cfg ? getAgent(cfg)[u.protocol] : undefined
    const meta = {
      reused: null, connectMs: null, ttfbMs: null, status: null, bytes: 0, chunks: 0,
      requestSentAt: null, headersAt: null, firstEventAt: null, completedAt: null,
      eventCount: 0, done: false, cancelled: false, truncated: false,
    }
    const events = []
    let killer = null
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true; if (killer) clearTimeout(killer)
      meta.totalMs ??= Date.now() - meta.requestSentAt
      meta.toFirstEventMs = meta.firstEventAt == null ? null : meta.firstEventAt - meta.requestSentAt
      meta.toFirstContentMs = meta.firstContentAt == null ? null : meta.firstContentAt - meta.requestSentAt
      meta.contentSpanMs = meta.firstContentAt == null ? null : meta.lastContentAt - meta.firstContentAt
      meta.afterContentMs = meta.lastContentAt == null ? null : Date.now() - meta.lastContentAt
      fn(v)
    }
    meta.requestSentAt = Date.now()

    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers, agent,
    }, (res) => {
      meta.headersAt = Date.now()
      meta.ttfbMs = meta.headersAt - meta.requestSentAt
      meta.reused = req.reusedSocket === true
      meta.status = res.statusCode
      if (typeof onHeaders === 'function') { try { onHeaders({ status: res.statusCode, ttfbMs: meta.ttfbMs }) } catch {} }
      meta.contentType = res.headers['content-type'] || null
      // ★ 统一响应入口（反向）：Content-Type 不是 event-stream 时留一份原文，
      //   以便「要求流式、上游却回整段 JSON」时仍能按 JSON 解析（而不是静默变成空摘要）。
      //   是 event-stream 就不留副本 —— 流式响应可达数百 KB，不做无谓复制。
      const rawChunks = String(meta.contentType || '').toLowerCase().includes('event-stream') ? null : []
      // ① 跨 chunk 缓冲：只把【完整的行】解出来，残段留到下一个 chunk
      let buf = Buffer.alloc(0)
      const takeLine = (lineBuf) => {
        let line = lineBuf.toString('utf8')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line || line.startsWith(':')) return          // 心跳/注释 ⇒ 不是事件
        if (!line.startsWith('data:')) return               // event:/id:/retry: 暂不消费
        const data = line.slice(5).trim()
        if (data === '[DONE]') { meta.done = true; return }
        if (meta.firstEventAt === null) meta.firstEventAt = Date.now()
        meta.eventCount += 1
        let parsed
        try {
          const obj = JSON.parse(data)
          parsed = obj
          const usage = obj.usage || obj.response?.usage || obj.message?.usage
          if (usage && typeof usage === 'object') meta.providerReportedUsage = { ...meta.providerReportedUsage, ...usage }
          const content = obj.type === 'response.output_text.delta' ? obj.delta : obj.choices?.[0]?.delta?.content
          if (typeof content === 'string' && content.length) {
            meta.firstContentAt ??= Date.now(); meta.lastContentAt = Date.now()
          }
        } catch {}
        // ★ 只解析一次：下游 parseStreamEvents 直接用 json，不再对同一帧二次 JSON.parse
        events.push({ at: Date.now(), data, json: parsed })
      }
      res.on('data', (c) => {
        meta.chunks += 1
        meta.bytes += c.length
        if (meta.bytes > RESPONSE_BYTES_MAX) {
          const err = new Error('stream response exceeds 4MB'); err.meta = meta
          req.destroy(err); done(reject, err); return
        }
        // 上限 4MB：正常 completion 远小于此；超限即放弃兜底，绝不无限增长
        if (rawChunks && meta.bytes <= RESPONSE_BYTES_MAX) rawChunks.push(c)
        buf = buf.length ? Buffer.concat([buf, c]) : c
        let idx
        while ((idx = buf.indexOf(0x0a)) !== -1) {
          takeLine(buf.subarray(0, idx))
          buf = buf.subarray(idx + 1)
        }
      })
      res.on('end', () => {
        // 收尾残段：上游若没给结尾换行，最后一行也要解出来
        if (buf.length) takeLine(buf)
        meta.completedAt = Date.now()
        meta.totalMs = meta.completedAt - meta.requestSentAt
        // 判据是【内容】：一个 SSE 事件都没解出来，才认为上游给的是整段 JSON
        const text = (rawChunks && meta.eventCount === 0) ? Buffer.concat(rawChunks).toString('utf8') : null
        if (text !== null) meta.nonSse = true
        done(resolve, { status: res.statusCode, meta, events, text })
      })
      // ③ 连接断开 ≠ 正常完成：单独标记，绝不冒充 end
      res.on('aborted', () => { meta.truncated = true })
      res.on('error', (e) => { meta.truncated = true; e.meta = meta; done(reject, e) })
    })
    req.on('socket', (s) => {
      if (s.connecting) s.once('secureConnect', () => { meta.connectMs = Date.now() - meta.requestSentAt })
      else if (isHttps) meta.connectMs = Date.now() - meta.requestSentAt
    })
    // ★ 错误一律附上 meta（否则调用方拿不到 truncated/done 判据 —— 测试 T20 抓到的）
    req.on('error', (e) => {
      if (meta.headersAt !== null) meta.truncated = true
      e.meta = meta
      done(reject, e)
    })
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        const err = new Error('cancelled')
        err.cancelled = true; err.meta = meta
        meta.cancelled = true; meta.totalMs = Date.now() - meta.requestSentAt
        try { req.destroy(err) } catch { /* ignore */ }
        done(reject, err)
      }
      const detach = () => { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else { signal.addEventListener('abort', onAbort, { once: true }); req.on('close', detach) }
    }
    if (timeoutMs > 0) killer = setTimeout(() => {
      const err = new Error('timeout ' + timeoutMs + 'ms')
      err.meta = meta
      try { req.destroy(err) } catch { /* ignore */ }
      done(reject, err)
    }, timeoutMs)
    if (body != null) req.write(body)
    req.end()
  })
}

// 预热：一次 HEAD，只把 socket 捂热，**不产生任何 completion ⇒ 零 token**。
// 实测（_probe-keepalive-win.mjs）：HEAD / 与 POST /v1/chat/completions 同 host:port
// ⇒ 共享 freeSockets 键 ⇒ 跨路径复用已实测为 true。
/**
 * 预热该打哪个 URL（2026-09-21 实机探针修正）。
 * ⛔ 绝不能用 `base + '/'` —— base 形如 `https://host/v1`，那会得到 `/v1/`，
 *    实测返回 **404**，而 404 的 HEAD **不把 socket 归还连接池**，反而吃掉池里的连接，
 *    使紧随其后的蒸馏 POST 每次都新建连接（生产实测 connectMs=227、reused=false）。
 * ✅ 打 origin（`https://host/`）实测 200，且随后的 POST reused=true、connectMs=0~1。
 *    socket 池按 host:port 键控，路径不同不影响复用。
 * @returns {string|null} 预热 URL；无法解析 ⇒ null（调用方应放弃预热）
 */
export function prewarmTargetUrl(base) {
  const b = String(base || '').trim()
  if (!b) return null
  try { return new URL(b).origin + '/' } catch { /* 非绝对 URL ⇒ 回落旧写法 */ }
  return b.replace(/\/+$/, '') + '/'
}

export function makePrewarmer(cfg, trace) {
  let lastAt = 0
  let inflight = null
  let prewarmDisabled = false
  // v11.11：callCfg = 本次调用派生的配置（host-follow.js）—— 端点跟随**这次**调用的宿主 provider，
  //   不再读被改写的共享 cfg。连接池（getAgent）与节流状态仍按插件实例共享。
  return function prewarm(why, callCfg) {
    const ep0 = callCfg && typeof callCfg === 'object' ? callCfg : cfg
    if (!cfg.prewarm || (cfg.mode !== 'distill' && cfg.mode !== 'checkpoint' && cfg.mode !== 'birth')) return
    // ★ 2026-09-21：一旦实测到非 2xx（会吃掉连接池），永久停用预热 —— 失败安全。
    if (prewarmDisabled) return
    if (inflight) return
    const now = Date.now()
    const ag = getAgent(cfg)
    let idle = 0
    for (const k of Object.keys(ag['https:'].freeSockets)) idle += ag['https:'].freeSockets[k].length
    // 池里已有热 socket，且没超过最小间隔 ⇒ 不必重复打扰网关
    if (idle > 0 && now - lastAt < (cfg.prewarmMinGapMs || 20000)) return
    if (now - lastAt < 5000) return
    lastAt = now
    // ★ 跟随宿主 provider 时，预热必须打宿主端点（否则捂热的是别人的 socket）
    //  2026-09-19：解析不出就**不预热**（原为回落 cfg.baseUrl，而那个默认值曾是作者商户）。
    //  预热只是省 411ms 的优化，不值得为它连一个不属于用户的端点。
    let base = ep0.baseUrl
    try {
      const ep = resolveProviderEndpoint(ep0, ep0.followProvider)
      if (ep && ep.baseURL) base = ep.baseURL
    } catch { /* 解析失败 ⇒ 回落显式 baseUrl */ }
    if (!base) return
    // ★★ 2026-09-21 实机探针修正（本文件此前的一条错误结论就此推翻）★★
    //   病：原来打 `base + '/'`，而 base 是 `https://<host>/v1` ⇒ 实际请求 `/v1/` ⇒ **404**。
    //       实测（deploy/probe/_probe-404-head.mjs，生产同款 Agent 参数）：
    //         POST → 池里有 1 条 socket
    //         HEAD /v1/chat/completions (404) → 该 socket **不归还** freeSockets
    //         紧随其后的 POST ⇒ reused=false、connectMs=227（= 生产 trace 的实测值）
    //       对照：HEAD 打 origin '/' (200) ⇒ 随后的 POST reused=true、connectMs=0。
    //   即：**404 的预热不但没捂热，反而吃掉池里的连接**，让每次蒸馏都新建连接。
    //   法：打 origin（'/'），那是唯一实测返回 200 的路径；socket 池按 host:port 键控，
    //       路径不同不影响复用。
    const url = prewarmTargetUrl(base)
    inflight = requestOnce(url, { method: 'HEAD', timeoutMs: 4000, cfg })
      .then((r) => {
        trace('prewarm-ok', { why, status: r.status, ttfbMs: r.meta.ttfbMs, reused: r.meta.reused, url })
        // ★ 自愈闸：任何非 2xx 的预热都可能正在消耗连接池 ⇒ 记一次并**永久停用预热**。
        //   宁可没有预热（退化成"什么都不做"），也不能让它变成负优化。
        if (!(r.status >= 200 && r.status < 300)) {
          prewarmDisabled = true
          trace('prewarm-bad-status', { why, status: r.status, url, action: 'prewarm-disabled' })
        }
      })
      .catch((e) => {
        trace('prewarm-failed', { why, error: String((e && e.message) || e) })
      })
      .then(() => { inflight = null })
  }
}

// 网关把「不认识的参数」拒掉时的错误长这样：http 400 ...
/** 响应体上限（流式与非流式共用）。 */
const RESPONSE_BYTES_MAX = 4 * 1024 * 1024

/**
 * 重试退避：按错误类分级 + 抖动。
 *   429 / 5xx / 网络类 ⇒ 基线 1200·attempt，±30% 抖动（避免并发编译同拍重试）；
 *   401 / 403 / 404 / 参数 4xx ⇒ 不重试（再试也是同样的结果，纯白付）。
 * 纯函数，供自测钉住。
 */
export function retryDelayMs(e, attempt, rand = Math.random) {
  const msg = String((e && e.message) || e)
  const m = /^http (\d{3})\b/.exec(msg)
  const status = m ? Number(m[1]) : (e && e.meta && typeof e.meta.status === 'number' ? e.meta.status : null)
  if (status != null && status !== 429 && status < 500) return null   // 非瞬时错误：不重试
  if (e && e.cancelled) return null
  const base = 1200 * Math.max(1, attempt)
  const jitter = (rand() * 2 - 1) * 0.3 * base
  return Math.max(100, Math.round(base + jitter))
}

export function isParamRejection(e) {
  return /^http (400|422)\b/.test(String((e && e.message) || e))
}

/**
 * ★★ 2026-09-21 统一响应入口（外部审计 P0：流式／非流式错配）★★
 * 事故证据：非流式请求拿到 SSE 响应体，trace 里 4 次
 *   bad json: data: {"id":"...","object":"chat.completion.chunk",...
 * 说明「我们要求的传输方式」与「上游实际给的响应协议」可以不一致。
 *
 * 原则：**不猜、不重试**。按【响应自身的结构】判协议，再选解析器；
 *   协议与请求模式不一致时**显式记录**，且绝不把「拼出了文字」当成功。
 *   ⚠ 不在这里加「失败后重发一次」——那会把本地解析缺陷变成重复调用与额外等待。
 */

/** 判定响应体的实际协议。结构证据优先，Content-Type 只作旁证。 */
export function detectResponseProtocol(text, contentType) {
  const ct = String(contentType == null ? '' : contentType).toLowerCase()
  const body = String(text == null ? '' : text)
  // SSE 的结构判据：存在以 data: 开头的行（与 requestStream 的 takeLine 同源）
  if (/(^|\r?\n)data:/.test(body)) return 'sse'
  if (ct.includes('text/event-stream')) return 'sse'
  const t = body.replace(/^\uFEFF/, '').trim()
  if (!t) return 'empty'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (ct.includes('json')) return 'json'
  return 'unknown'
}

/** 从【整段响应文本】里抽出 SSE data 帧（判据与 requestStream.takeLine 逐条一致）。 */
export function assembleSseFrames(text) {
  const datas = []
  let sawDone = false
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = raw
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') { sawDone = true; continue }
    datas.push(data)
  }
  return { datas, sawDone }
}

/** 把 SSE data 帧归并成与非流式同形的结果（chat / responses 两种风格）。 */
export function collectSseFrames(datas, style) {
  let out = ''
  let finish = ''
  let reasoningChars = 0, badFrame = 0
  for (const data of (Array.isArray(datas) ? datas : [])) {
    let j
    try { j = JSON.parse(data) } catch { badFrame++; continue }
    if (style === 'responses') {
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string' && j.delta) out += j.delta
      else if (j.type === 'response.completed') finish = 'stop'
      else if (j.type === 'response.incomplete') finish = 'length'
      else if (j.type === 'response.reasoning_summary_text.delta' || j.type === 'response.reasoning_text.delta') reasoningChars += String(j.delta || '').length
      continue
    }
    const ch = j && j.choices && j.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (typeof d.reasoning_content === 'string') reasoningChars += d.reasoning_content.length
    if (typeof d.content === 'string' && d.content) out += d.content
    if (ch.finish_reason) finish = ch.finish_reason
  }
  return { out, finish, reasoningChars, badFrame }
}

/**
 * 把【非流式 JSON 响应体】抽成 {out, finish, reasoningChars}。
 * chat / responses 两种风格共用 —— 非流式与流式两条路径的解析规则必须只有一处。
 * @returns {{out:string, finish:string, reasoningChars:number}|null} null = 没有 choices（调用方决定报错文案）
 */
export function extractFromJsonBody(j, style) {
  let out = ''
  let finish = ''
  let reasoningChars = 0
  if (style === 'responses') {
    const o = j || {}
    finish = o.status || (o.incomplete_details && o.incomplete_details.reason) || (o.error && o.error.message) || ''
    const chunks = []
    for (const item of (Array.isArray(o.output) ? o.output : [])) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text !== 'string') continue
          if (c.type === 'reasoning_text' || c.type === 'summary_text') reasoningChars += c.text.length
          else chunks.push(c.text)
        }
      }
      if (typeof item.text === 'string') chunks.push(item.text)
    }
    if (!chunks.length && typeof o.output_text === 'string') chunks.push(o.output_text)
    out = chunks.join('')
    return { out, finish, reasoningChars }
  }
  const ch = j && j.choices && j.choices[0]
  if (!ch) return null
  const msg = ch.message || {}
  out = msg.content || ''
  finish = ch.finish_reason
  reasoningChars = String(msg.reasoning_content || '').length
  return { out, finish, reasoningChars }
}
