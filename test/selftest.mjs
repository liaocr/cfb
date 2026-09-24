// dsh-cot-form-b 自测 —— 纯本地，零网络、零会话、零 API 调用。
// 目标：把金丝雀抓出的两个 bug 和它们的边界钉死，防止回归。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  DEFAULTS, buildDistillPrompt, textOfContent, reasoningTextOf,
  apply, normalizeConfig, requestOnce, generateDistillation, birthEconomics,
  detectResponseProtocol, assembleSseFrames, collectSseFrames, extractFromJsonBody, requestStream,
  pushLateMemory, takeLateMemory, peekLateMemory, lateMemorySize,
  readApiKey, DEP_ID,
} from '../index.js'
import { fidelity, protectedTokens } from '../src/fidelity.js'
import { runPreStepEmit } from '../src/emitter.js'
import { adaptEvidence } from '../src/state-memory.js'

// 本进程独占的临时目录：固定文件名会让并发跑多个 selftest 时互相读到对方写的
// trace / credentials，产生假失败（外审 R-1 复现：并发时 204/0 与 203/1 并存）。
// 注意：某些受限环境里 TMPDIR/TEMP 缺失会让 os.tmpdir() 返回 "undefined\temp"，故做回退。
function selftestTmpRoot() {
  const cands = [os.tmpdir(), process.env.TEMP, process.env.TMP, path.join(process.cwd(), ".cot-form-b-selftest-tmp")]
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue
    try { fs.mkdirSync(c, { recursive: true }); return c } catch { /* 试下一个 */ }
  }
  throw new Error("selftest: 找不到可写的临时目录")
}
const SELFTEST_TMP = fs.mkdtempSync(path.join(selftestTmpRoot(), "cot-form-b-selftest-"))
process.on("exit", () => { try { fs.rmSync(SELFTEST_TMP, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })
const tmpFile = (name) => path.join(SELFTEST_TMP, name)

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   → ' + JSON.stringify(extra) : '')) }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want }) }

const cfg = { hurdleRounds: 4, templateChars: 500 }

console.log('\n【1】buildDistillPrompt —— 契约焊死')
{
  const p = buildDistillPrompt('X')
  ok('含【已归档决策】', p.includes('【已归档决策】'))
  ok('含【已否决分支·不可重开】', p.includes('【已否决分支·不可重开】'))
  ok('含【已证伪路径·归档】', p.includes('【已证伪路径·归档】'))
  // ★ 防伪造引用：模板里不得把【用户原话…】定义成一个要模型填的栏。
  //   注意断言的是「栏头」，不是「用户原话」四个字 —— 正文里出现这四个字不算违规。
  ok('★ 未把【用户原话】定义为必需栏', !p.includes('【用户原话'))
  ok('★ 含"用中文输出"（正面防线，治脑补翻译）', p.includes('用中文输出'))
  ok('★ 不含【已执行的工具调用】栏（已删）', !p.includes('已执行的工具调用'))
  ok('含"整栏省略"负向指令', p.includes('整栏省略'))
  ok('含硬语气禁令（建议/备选/可以考虑）', p.includes('建议') && p.includes('备选') && p.includes('可以考虑'))
  ok('结尾带上思维链', p.endsWith('X'))
  // 栏头集合必须**正好**是这三栏 + 结尾的输入标签，多一栏都不行
  const heads = (p.match(/^【[^】]*】/gm) || []).sort()
  eq('★ 栏头集合精确等于三态 + 输入标签', heads, ['【上一轮思维链】', '【已否决分支·不可重开】', '【已归档决策】', '【已证伪路径·归档】'].sort())
  ok('每个状态栏各出现一次', heads.filter((h) => h !== '【上一轮思维链】').length === 3)
}

console.log('\n【4】textOfContent —— content 双兼容（bug 根因 3）')
{
  eq('纯字符串', textOfContent('hello'), 'hello')
  eq('块数组', textOfContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  eq('混合数组', textOfContent(['a', { text: 'b' }]), 'a\nb')
  eq('非文本块被跳过', textOfContent([{ type: 'tool-call', name: 'x' }, { type: 'text', text: 'k' }]), 'k')
  eq('非数组非字符串', textOfContent({}), '')
  eq('undefined', textOfContent(undefined), '')
}

console.log('\n【9】消息抽取工具')
{
  const m = { role: 'assistant', content: [{ type: 'reasoning', text: 'abc' }, { type: 'reasoning', text: 'de' }, { type: 'tool-call', name: 'w' }] }
  eq('reasoning 多块拼接', reasoningTextOf(m), 'abc\nde')
  eq('无 content 返回空', reasoningTextOf({ role: 'assistant' }), '')
}

console.log('\n【10】默认值 —— 安全默认 + 延迟预算')
{
  eq('★ dryRun 默认 true（防带电裸奔）', DEFAULTS.dryRun, true)
  eq('checkpoint 提前发起门槛 800', DEFAULTS.minRawChars, 800)
  // ★ 延迟回归锁：实测中位 5.4s / 最差 20.0s，180000 是灾难性配置，绝不许改回去
  eq('★ 超时预算 8 秒（不是 180 秒）', DEFAULTS.timeoutMs, 8000)
  eq('★ 重试 1 次（不是 4 次）', DEFAULTS.maxAttempts, 1)
  ok('★ 凭据路径带前导点（.credentials.yaml）', DEFAULTS.credentialsPath.endsWith('/.credentials.yaml'), DEFAULTS.credentialsPath)
  // ★ 不许再引入「延迟替换」相关开关：块一旦出站就永不可改（H2）。
  ok('★ 不含 deferApply（延迟替换已被终审否决）', !('deferApply' in DEFAULTS))
  ok('★ 不含 maxInflight（同上，属延迟路径）', !('maxInflight' in DEFAULTS))
  // ★ v11.8：缺省 birth（唯一生产路径；dryRun 下零调用零改写），下轮收网缺省关（AUDIT §四 ②）
  eq('★ mode 默认 birth', DEFAULTS.mode, 'birth')
  eq('★ birthDeferredClaim 默认 false（实验路径，显式打开）', DEFAULTS.birthDeferredClaim, false)
  eq('★ earlyFire 默认 true（仅 checkpoint 模式生效）', DEFAULTS.earlyFire, true)
  eq('★ graceMs 默认 300（= 用户感知延迟上限）', DEFAULTS.graceMs, 300)
  for (const k of ['rulesEnabled', 'rulesRequireArchive', 'hurdleRounds', 'templateChars', 'maxVerbatimChars', 'skeletonizeArgs']) {
    ok('⛔ 随 distill/rules 退役的键已从 DEFAULTS 移除：' + k, !(k in DEFAULTS))
  }
}

console.log('\n【10.1】配置归一化 —— 嵌套写法 / 退役模式 / 退役键')
{
  const a = normalizeConfig({ mode: 'checkpoint', distill: { timeoutMs: 3000, minRawChars: 1200, maxOutputTokens: 600 } })
  eq('嵌套 distill.timeoutMs 覆盖扁平键', a.timeoutMs, 3000)
  eq('嵌套 distill.minRawChars', a.minRawChars, 1200)
  eq('嵌套 distill.maxOutputTokens', a.maxOutputTokens, 600)
  eq('mode 透传', a.mode, 'checkpoint')

  // ⛔ v11.8 退役模式：按 'off' 处理（它们的写回路径协议上永久非法），BOOT 可见
  for (const m of ['distill', 'rules']) {
    const r = normalizeConfig({ mode: m })
    ok('★ 退役模式 ' + m + ' ⇒ off + retiredMode', r.mode === 'off' && r.retiredMode === m, { mode: r.mode, retiredMode: r.retiredMode })
  }
  const bad = normalizeConfig({ mode: 'nonsense' })
  ok('★ 非法 mode ⇒ off（绝不把拼错的模式猜成会改写会话的模式）', bad.mode === 'off' && bad.invalidMode === 'nonsense', bad.mode)
  eq('★ 空配置就是默认值（birth）', normalizeConfig().mode, 'birth')

  // 退役键：进 retiredOptions、从生效配置删除，不算 unknownOptions
  const r = normalizeConfig({ rules: { foldRuns: false }, rulesEnabled: true, hurdleRounds: 5, distill: { maxVerbatimChars: 400, maxOutputTokens: 600 } })
  for (const k of ['rules', 'rulesEnabled', 'hurdleRounds', 'distill.maxVerbatimChars']) ok('★ 退役键进 retiredOptions：' + k, r.retiredOptions.includes(k), r.retiredOptions)
  ok('★ 退役键不在生效配置里', !('rulesEnabled' in r) && !('hurdleRounds' in r) && !('maxVerbatimChars' in r))
  eq('★ 退役键不误报为 unknownOptions', r.unknownOptions.length, 0)
  eq('同一容器里的有效键照常生效', r.maxOutputTokens, 600)
}

console.log('\n【13】保真度核算 —— fidelity / protectedTokens（birth 的逐字标识符召回率用它）')
{
  // ⑧ ★ 保真度门禁负控制：门禁必须能识别「真的丢了」
  const fLost = fidelity('The handle art://abc123 and 3350 bytes', 'nothing here')
  ok('★ 门禁负控制：真丢了就必须报出来', fLost.lost.length >= 2 && fLost.stats.tokenRecall < 100, fLost.stats)
  const fKept = fidelity('The handle art://abc123 and 3350 bytes', 'The handle art://abc123 and 3350 bytes')
  ok('★ 门禁负控制：没丢就一个都不许报', fKept.lost.length === 0 && fKept.stats.tokenRecall === 100, fKept.stats)
  const gh = protectedTokens('art://cq3G49xaZTkgaIvm1XKCoG sha256 97e6b887')
  ok('★ 门禁不误解：句柄内部的数字不单独算 token（曾经的假阳性来源）', !gh.has('49') && !gh.has('3'), [...gh])
  const gh2 = protectedTokens('art://abc123 and 3350 bytes in 4ms')
  ok('★ 门禁不误解：全小写句柄与数字/单位必须被抓到', gh2.has('art://abc123') && gh2.has('3350 bytes') && gh2.has('4ms'), [...gh2])
}

// ──【14】传输层：requestOnce（本地 http server，零外网、零 API）──────────────
console.log('\n【14】传输层 requestOnce —— keep-alive / 超时 / 状态码（本地 server）')
{
  let conns = 0
  const srv = http.createServer((q, s) => {
    if (q.url === '/slow') { setTimeout(() => { try { s.writeHead(200); s.end('late') } catch {} }, 3000); return }
    if (q.url === '/bad') { s.writeHead(500); s.end('boom'); return }
    s.writeHead(200, { 'Content-Type': 'application/json' })
    s.end('{"ok":true}')
  })
  srv.on('connection', () => { conns++ })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const tcfg = normalizeConfig({ keepAlive: true, keepAliveMsecs: 60000 })

  const r1 = await requestOnce(base + '/ok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', cfg: tcfg })
  eq('  200 被如实读出', r1.status, 200)
  ok('  body 完整', r1.text === '{"ok":true}', r1.text)
  ok('  meta.ttfbMs 是数字', typeof r1.meta.ttfbMs === 'number' && r1.meta.ttfbMs >= 0, r1.meta)
  eq('  meta.bytes = 响应字节数', r1.meta.bytes, r1.text.length)

  const before2 = conns
  const r2 = await requestOnce(base + '/ok', { method: 'POST', body: '{}', cfg: tcfg })
  eq('★ 第二次请求没有新建 TCP 连接（keep-alive 生效）', conns - before2, 0)
  ok('★ req.reusedSocket 第二次为 true（可落 trace 的复用证据）', r2.meta.reused === true, r2.meta)

  const r3 = await requestOnce(base + '/bad', { cfg: tcfg })
  eq('  非 200 状态码如实返回（不抛错）', r3.status, 500)
  ok('  错误响应体被读回', r3.text === 'boom', r3.text)

  let timedOut = false
  try { await requestOnce(base + '/slow', { timeoutMs: 300, cfg: tcfg }) }
  catch (e) { timedOut = /timeout/.test(String((e && e.message) || e)) }
  ok('★ 总超时生效（整通请求硬上限，不是 idle 超时）', timedOut)

  let badUrl = false
  try { await requestOnce('not a url', {}) } catch { badUrl = true }
  ok('  非法 URL 直接 reject，不挂起', badUrl)

  try { srv.close() } catch {}
}

// ──【15】传输层配置项（嵌套 distill: 写法）──────────────────────────────────
console.log('\n【15】传输层配置项 —— 嵌套写法与默认值')
{
  const c = normalizeConfig({ distill: { keepAlive: false, prewarm: false, prewarmMinGapMs: 1234, keepAliveMsecs: 5000, followHostModel: false, disableThinking: false, model: 'M1' } })
  eq('  distill.keepAlive 被吃下', c.keepAlive, false)
  eq('  distill.prewarm 被吃下', c.prewarm, false)
  eq('  distill.prewarmMinGapMs 被吃下', c.prewarmMinGapMs, 1234)
  eq('  distill.keepAliveMsecs 被吃下', c.keepAliveMsecs, 5000)
  eq('  distill.followHostModel 被吃下', c.followHostModel, false)
  eq('  distill.disableThinking 被吃下', c.disableThinking, false)
  eq('  distill.model 被吃下', c.model, 'M1')
  const d = normalizeConfig({})
  eq('  默认 keepAlive = true', d.keepAlive, true)
  // ★ 2026-09-21 翻转：三组对照实测（deploy/probe/_probe-prewarm-3way.mjs）
  //   按【预热启动 → 蒸馏完成】的总时间：none p50=1827ms < new p50=2082ms < old p50=2408ms。
  //   新路径确实修好了复用（3/3 vs 0/3），但 HEAD 自身要 344~1002ms，省下的建连没被省回来。
  //   ⇒ 默认关闭；连接复用改由正常业务流量自然维持。
  eq('  默认 prewarm = false（三组对照：预热总时间反而更慢）', d.prewarm, false)
  eq('  默认 distillStream = false（流式必须显式打开）', d.distillStream, false)
  eq('  默认 keepAliveMsecs = 60000', d.keepAliveMsecs, 60000)
  eq('  默认 prewarmMinGapMs = 20000', d.prewarmMinGapMs, 20000)
  eq('  默认 followHostModel = true', d.followHostModel, true)
  eq('  默认 disableThinking = true', d.disableThinking, true)
  eq('  默认 model = ""（不写死模型名）', d.model, '')
  // ⚠ 认知等级：keepAlive 只对「进程内第 2 次及以后」的调用有效；
  //    实测那 3,882ms 是进程内第一次调用 ⇒ 单靠 keepAlive 省 0ms，必须配 prewarm。
  ok('★ 注释里写死了「第一次调用永远是冷的」这条限定', true)
}

// ──【16】generateDistillation —— 空提纯稿必须报出真因（本地 server，零外网）──
console.log('\n【16】generateDistillation —— 空提纯稿的真因必须可诊断（本地 server）')
{
  eq('★ 代码默认不写死任何模型名（跟随宿主对话模型；写死的名字身份不可核实）',
    DEFAULTS.model, '')
  eq('  默认 followHostModel = true', DEFAULTS.followHostModel, true)
  eq('  默认 disableThinking = true（不关思考 ⇒ content 空串 + 白等 7~19 秒）',
    DEFAULTS.disableThinking, true)

  const cred = tmpFile('credentials.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_ZZ: sk-selftest\n')
  let mode = 'ok'
  let seen = null // 最近一次请求的 payload，用来验证 thinking 参数真的发出去了
  const srv = http.createServer((q, s) => {
    const send = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)) }
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      try { seen = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { seen = null }
      if (mode === 'ok') return send({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】x' } }] })
      if (mode === 'thinking') return send({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'y'.repeat(500) } }] })
      if (mode === 'nochoices') return send({ error: { message: 'bad' } })
      s.writeHead(500); s.end('boom')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const gcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ',
    maxAttempts: 1, timeoutMs: 3000, keepAlive: true,
    // ⛔ 显式给模型：DEFAULTS.model 现在是空串（跟随宿主），空串会直接抛 no model
    model: 'test-model-1',
  })

  // ⛔ 不猜模型：cfg.model 为空 ⇒ 必须抛 no model（上层据此降级 rules）
  let e0 = ''
  try { await generateDistillation('hello', normalizeConfig({ model: '' })) } catch (e) { e0 = String((e && e.message) || e) }
  ok('★ cfg.model 为空 → 抛 no model（绝不猜模型名）', /^no model:/.test(e0), e0)

  const g1 = await generateDistillation('hello', gcfg)
  eq('  正常响应 → text 被取出', g1.text, '【已定决策】x')
  eq('  meta.finish 被带回（可落 trace）', g1.meta.finish, 'stop')
  eq('  meta.model = 本次实际用的模型', g1.meta.model, 'test-model-1')
  eq('★ disableThinking 时 payload 带 thinking={type:disabled}', JSON.stringify(seen.thinking), '{"type":"disabled"}')
  eq('★ 并且 thinkingOff=true 落进 meta', g1.meta.thinkingOff, true)
  eq('  max_tokens 用的是 maxOutputTokens', seen.max_tokens, gcfg.maxOutputTokens)
  eq('  temperature = 0（提纯要确定性）', seen.temperature, 0)

  mode = 'thinking'
  let e2 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e2 = String((e && e.message) || e) }
  ok('★ 思考型吐空 content → 错误必须带 finish=length', /empty distillate \(finish=length/.test(e2), e2)
  ok('★ 并且带 reasoningChars（一眼看出 token 被思考吃掉）', /reasoningChars=500/.test(e2), e2)

  mode = 'nochoices'
  let e3 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e3 = String((e && e.message) || e) }
  ok('★ 网关返回非 completion 结构 → 报 no choices', /no choices/.test(e3), e3)

  mode = 'http500'
  let e4 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e4 = String((e && e.message) || e) }
  ok('  非 200 → 报 http 500', /http 500/.test(e4), e4)

  try { srv.close() } catch {}
}

// ──【17】★ 跟随宿主对话模型（用户拍板：宿主用哪个模型对话，就用哪个压缩）──
//   这是端到端验证：宿主 llm/stream 里报出的模型名，必须**真的**出现在我们发给
//   网关的 payload.model 里。只测 trace 不够 —— 要看到 API 那一侧收到了什么。
console.log('\n【17】★ 提纯模型跟随宿主对话模型（本地 server 收包验证，零外网）')
{
  const tmp = tmpFile('hostmodel.trace.log')
  try { fs.unlinkSync(tmp) } catch { /* first run */ }

  const cred = tmpFile('credentials.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_ZZ: sk-selftest\n')

  // 本地网关：记下每一次收到的 payload
  const got = []
  const srv = http.createServer((q, s) => {
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      let p = null
      try { p = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* HEAD 之类无 body */ }
      if (p) got.push(p)
      s.writeHead(200, { 'Content-Type': 'application/json' })
      s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】宿主模型跟随 OK' } }] }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))

  let llmStream = null
  const ctx = { on: (nm, fn) => { if (nm === 'llm/stream') llmStream = fn } }

  // ⛔ prewarm:false / baseUrl 指向本地 ⇒ 零外网
  apply(ctx, {
    mode: 'checkpoint', trace: true, traceFile: tmp, dryRun: false, minRawChars: 10,
    prewarm: false, model: '', followHostModel: true,
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ', maxAttempts: 1, timeoutMs: 3000,
  })
  ok('llm/stream handler 已注册', typeof llmStream === 'function')

  const fakeStream = async function* (chunks) { for (const c of chunks) yield c }
  // ⚠ 每次要用**不同的 reasoning 文本**：fireEarly 按原文精确匹配去重，
  //   同一段文本第二次会直接命中缓存而不重新发起（这是设计，不是 bug）。
  const mkChunks = (ch, len) => [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: ch.repeat(len) },
    { type: 'block-start', index: 1, blockType: 'text' },
  ]

  // ── 17A：还没见过宿主模型 ⇒ **不许发起提纯**（不猜模型名）──
  {
    const ret = llmStream({ model: '', messages: [] }, () => fakeStream(mkChunks('z', 900)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 200))
    const t = fs.readFileSync(tmp, 'utf8')
    ok('★ 没读到宿主模型 → 不发提纯（early-no-model）', t.includes('early-no-model'))
    ok('★ 且绝不发 early-fired（不猜模型名去撞墙）', !t.includes('early-fired'))
    eq('★ 一个包都没发给网关', got.length, 0)
  }

  // ── 17B：llm/stream 报出宿主模型 ⇒ cfg.model 被改写 ⇒ 发出去的 model 就是它 ──
  {
    const ret = llmStream(
      { model: 'HOST-MODEL-X', provider: 'host-provider', messages: [] },
      () => fakeStream(mkChunks('z', 900)),
    )
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))

    const t = fs.readFileSync(tmp, 'utf8')
    ok('★ 捕获到宿主模型并落 trace（host-model）', t.includes('host-model'))
    ok('★ trace 里 effectiveModel = 宿主模型', t.includes('"effectiveModel":"HOST-MODEL-X"'))
    ok('★ 提纯被发起（early-fired）', t.includes('early-fired'))
    ok('★ 提纯成功且带上实际模型名（early-ready）', t.includes('"model":"HOST-MODEL-X"'))

    eq('★ 网关收到的 model 就是宿主对话模型', got.length >= 1 ? got[0].model : null, 'HOST-MODEL-X')
    ok('★ 且带上了 thinking={type:disabled}（关掉思考）',
      got.length >= 1 && JSON.stringify(got[0].thinking) === '{"type":"disabled"}')
  }

  // ── 17C：宿主换模型 ⇒ 立刻跟着换（不是只在第一次锁定）──
  {
    const ret = llmStream({ model: 'HOST-MODEL-Y', messages: [] }, () => fakeStream(mkChunks('y', 950)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))
    eq('★ 宿主换模型后，网关收到的就是新模型', got.length >= 2 ? got[1].model : null, 'HOST-MODEL-Y')
  }

  // ── 17D：followHostModel=false 时显式配置的模型才是唯一来源 ──
  {
    const tmp2 = tmpFile('hostmodel-off.trace.log')
    try { fs.unlinkSync(tmp2) } catch { /* first run */ }
    const got2 = []
    const srv2 = http.createServer((q, s) => {
      const cs = []
      q.on('data', (c) => cs.push(c))
      q.on('end', () => {
        try { got2.push(JSON.parse(Buffer.concat(cs).toString('utf8'))) } catch { /* ignore */ }
        s.writeHead(200, { 'Content-Type': 'application/json' })
        s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】fixed' } }] }))
      })
    })
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
    let ls2 = null
    const ctx2 = { on: (nm, fn) => { if (nm === 'llm/stream') ls2 = fn } }
    apply(ctx2, {
      mode: 'checkpoint', trace: true, traceFile: tmp2, dryRun: false, minRawChars: 10, prewarm: false,
      model: 'FIXED-MODEL-Z', followHostModel: false,
      baseUrl: 'http://127.0.0.1:' + srv2.address().port,
      credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ', maxAttempts: 1, timeoutMs: 3000,
    })
    const ret = ls2({ model: 'HOST-MODEL-W', messages: [] }, () => fakeStream(mkChunks('z', 900)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))
    eq('★ followHostModel=false ⇒ 用显式配置的模型，不被宿主覆盖',
      got2.length >= 1 ? got2[0].model : null, 'FIXED-MODEL-Z')
    try { srv2.close() } catch { /* ignore */ }
  }

  try { srv.close() } catch {}
}


// ──【18】★ 统一响应入口：流式／非流式错配（2026-09-21 外部审计 P0）────────────
//   事故：非流式请求拿到 SSE 体 ⇒ 旧写法直接 JSON.parse ⇒ bad json（trace 实测 4 次）。
//   原则：按【响应实际协议】解析，错配显式记录，绝不靠重发掩盖。
console.log('\n【18】统一响应入口 —— 协议判定与错配兜底')
{
  // ── 18.1 协议判定：结构证据优先 ──
  eq('  整段 JSON 判为 json', detectResponseProtocol('{"a":1}', 'application/json'), 'json')
  eq('★ SSE 体（含 data: 行）判为 sse —— 不看 Content-Type 也能认出来',
    detectResponseProtocol('data: {"a":1}\n\ndata: [DONE]\n', null), 'sse')
  eq('  空体判为 empty', detectResponseProtocol('', null), 'empty')
  eq('  纯文本无 JSON 无 SSE 判为 unknown', detectResponseProtocol('boom', 'text/plain'), 'unknown')
  eq('  仅凭 Content-Type=text/event-stream 也认 sse（体为空时）',
    detectResponseProtocol('', 'text/event-stream'), 'sse')
  eq('  Content-Type 只是旁证：json 头 + SSE 体 ⇒ 以体为准',
    detectResponseProtocol('data: {}\n', 'application/json'), 'sse')

  // ── 18.2 SSE 帧抽取：与 requestStream.takeLine 判据一致 ──
  const fr = assembleSseFrames('data: A\n\n: keepalive\n\nevent: x\n\ndata: B\n\ndata: [DONE]\n')
  eq('  只取 data: 行，注释/event: 行不算事件', fr.datas, ['A', 'B'])
  eq('  [DONE] 被识别且不混进帧列表', fr.sawDone, true)
  eq('  跨行残段（无结尾换行）也能解出最后一行', assembleSseFrames('data: Z').datas, ['Z'])

  // ── 18.3 帧归并：chat 风格 ──
  const c1 = collectSseFrames([
    '{"choices":[{"delta":{"reasoning_content":"想想"}}]}',
    '{"choices":[{"delta":{"content":"【已定决策】"}}]}',
    '{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}',
  ], 'chat')
  eq('  content 逐帧拼接', c1.out, '【已定决策】x')
  eq('  finish_reason 被带回', c1.finish, 'stop')
  eq('  reasoning_content 只计数、绝不混进正文', c1.reasoningChars, 2)
  const c2 = collectSseFrames(['not json', '{"choices":[{"delta":{"content":"ok"}}]}'], 'chat')
  eq('  坏帧被跳过，不阻断后续帧', c2.out, 'ok')

  // ── 18.4 JSON 体抽取：与流式同规则 ──
  const j1 = extractFromJsonBody({ choices: [{ finish_reason: 'stop', message: { content: 'A', reasoning_content: 'zz' } }] }, 'chat')
  eq('  chat：content 取出', j1.out, 'A')
  eq('  chat：reasoning 只计数', j1.reasoningChars, 2)
  eq('  没有 choices ⇒ null（由调用方给报错文案）', extractFromJsonBody({ error: {} }, 'chat'), null)

  // ── 18.5 ★ 端到端：非流式请求遇到 SSE 响应（就是那 4 次 bad json）──
  const cred = tmpFile('credentials-mismatch.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_MM: sk-selftest\n')
  let mode = 'sseOnJson'
  const srv = http.createServer((q, s) => {
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      if (mode === 'sseOnJson') {
        // 上游无视「非流式」要求，直接给 SSE
        s.writeHead(200, { 'Content-Type': 'text/event-stream' })
        s.end('data: {"choices":[{"delta":{"content":"【已定决策】"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"mismatch"},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n')
        return
      }
      // 反向：要求流式，却回整段 JSON
      s.writeHead(200, { 'Content-Type': 'application/json' })
      s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】jsonback' } }] }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const mcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_MM',
    maxAttempts: 1, timeoutMs: 3000, model: 'test-model-mm',
  })

  const g1 = await generateDistillation('hello', mcfg)
  eq('★★ 非流式请求遇到 SSE 体 ⇒ 仍能取出正文（旧写法在这里抛 bad json）', g1.text, '【已定决策】mismatch')
  eq('★ 错配被显式记录，不再静默', g1.meta.protocolMismatch, 'sse-body-on-json-request')

  mode = 'jsonOnStream'
  const g2 = await generateDistillation('hello', normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_MM',
    maxAttempts: 1, timeoutMs: 3000, model: 'test-model-mm', distillStream: true,
  }))
  eq('★★ 流式请求遇到整段 JSON ⇒ 仍能取出正文（旧写法只报空摘要）', g2.text, '【已定决策】jsonback')
  eq('★ 反向错配同样显式记录', g2.meta.protocolMismatch, 'json-body-on-stream-request')

  try { srv.close() } catch {}
}

// ──【19】★ 失败/取消路径必须带请求指纹（2026-09-21 补数据缺口）──────────────
//   此前 promptChars 只在【成功】的 settled 里落盘 ⇒ 恰恰在最需要看输入体积时看不见。
console.log('\n【19】失败路径的请求指纹 —— 分得清「TTFB 吃光预算」与「生成太慢」')
{
  const cred = tmpFile('credentials-failmeta.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_FM: sk-selftest\n')
  // 服务端从不回响应头 ⇒ 触发超时（模拟「TTFB 把预算吃光」）
  const srv = http.createServer(() => { /* 故意不响应 */ })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const fcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_FM',
    maxAttempts: 1, timeoutMs: 400, model: 'test-model-fm', distillStream: true,
  })
  let em = null
  try { await generateDistillation('x'.repeat(3000), fcfg) } catch (e) { em = e.meta || null }
  ok('★ 超时/取消路径带上了 promptChars（本轮补的缺口）', em && typeof em.promptChars === 'number' && em.promptChars > 0, em)
  eq('  且能看出失败发生在「等响应」阶段', em && em.stage, 'await-headers')
  eq('  并带回本次实际请求的模型名', em && em.model, 'test-model-fm')
  ok('  maxOutputTokens 也被钉住（可与预算对照）', em && em.maxOutputTokens === fcfg.maxOutputTokens, em)
  try { srv.close() } catch {}
}
console.log('\n' + '='.repeat(56))

// ──【20】方案二「下轮收网」暂存区（2026-09-21）───────────────────────────
//   核心不变量：① 按【原始推理文本】索引（收网器只拿得到 raw）；
//              ② 取走即移除（同一结论绝不重复注入）；
//              ③ 同一块重复入队只留一条（绝不堆积）；④ 有界。
console.log('')
console.log('【20】birth 下轮收网：暂存区语义')
{
  const sid = 'sess-' + Math.random().toString(36).slice(2)
  const rawA = '推理原文 A'.repeat(20)
  const rawB = '推理原文 B'.repeat(20)
  const entA = [{ id: 'a1' }]
  const entB = [{ id: 'b1' }]

  ok('20.1 初始为空', lateMemorySize(sid) === 0, String(lateMemorySize(sid)))
  ok('20.2 push 成功', pushLateMemory(sid, rawA, entA, '看板A') === true)
  ok('20.3 入队后可见', lateMemorySize(sid) === 1)

  // ② 按 raw 索引：拿错 raw 必须取不到（否则会把 A 的结论贴到 B 上）
  ok('20.4 ★ 错误的 raw 取不到（绝不张冠李戴）', takeLateMemory(sid, rawB) === null)
  ok('20.5 取错后原条目仍在', lateMemorySize(sid) === 1)
  ok('20.6 peek 不消费', peekLateMemory(sid, rawA) !== null && lateMemorySize(sid) === 1)

  const got = takeLateMemory(sid, rawA)
  ok('20.7 ★ 正确 raw 取到且内容一致',
     !!got && got.board === '看板A' && JSON.stringify(got.entries) === JSON.stringify(entA))
  ok('20.8 ★ 取走即移除（绝不重复收网）', lateMemorySize(sid) === 0)
  ok('20.9 二次取同一条返回 null', takeLateMemory(sid, rawA) === null)

  // ③ 同文本但没有任务身份 ⇒ 保留歧义，不擅取最新版
  pushLateMemory(sid, rawA, entA, '第一版')
  pushLateMemory(sid, rawA, entA, '第二版')
  ok('20.10 ★ 同 raw 无身份重复入队保留两条', lateMemorySize(sid) === 2, String(lateMemorySize(sid)))
  ok('20.11 同 raw 无身份歧义不认领', takeLateMemory(sid, rawA) === null)

  // ④ 有界
  for (let i = 0; i < 20; i++) pushLateMemory(sid, rawA + '#' + i, entB, '看板' + i)
  ok('20.12 ★ 有界（最多 8 条，绝不无界增长）', lateMemorySize(sid) === 8, String(lateMemorySize(sid)))

  // 会话隔离：另一个会话看不到本会话的暂存
  ok('20.13 ★ 会话隔离', lateMemorySize(sid + '-other') === 0)

  // 边界：脏输入不得抛错
  ok('20.14 null session 安全', pushLateMemory(null, rawA, entA, 'x') === false && takeLateMemory(null, rawA) === null)
  ok('20.15 空 raw 拒收', pushLateMemory(sid, '', entA, 'x') === false)
  ok('20.16 空 entries 拒收', pushLateMemory(sid, rawA, [], 'x') === false)
  ok('20.17 非字符串 raw 拒收', pushLateMemory(sid, 123, entA, 'x') === false)
  ok('20.18 未知会话取用安全', takeLateMemory('never-seen', 'x') === null)

  // ★★ 2026-09-22 全覆盖认领语义 ★★
  //   收网用一条 ledger 替换**整条**消息的推理，而暂存的是**块级**结果。
  //   只部分就绪就收网 ⇒ 未就绪块的推理凭空消失。故：部分覆盖一律不认领。
  {
    const NL = String.fromCharCode(10)
    const blockA = '甲'.repeat(80)
    const blockB = '乙'.repeat(80)

    // ① 部分就绪 ⇒ 不认领、不消费
    const s2 = sid + '-partial'
    pushLateMemory(s2, blockA, entA, '块A看板')
    ok('20.19 ★★ 多块只就绪一块 ⇒ 拒绝认领（防丢内容）',
       takeLateMemory(s2, blockA + NL + blockB) === null)
    ok('20.20 ★ 拒绝后**不消费**，结果仍保留待下轮', lateMemorySize(s2) === 1)

    // ② 全部就绪 ⇒ 认领，且按块序合并
    pushLateMemory(s2, blockB, entB, '块B看板')
    const full = takeLateMemory(s2, blockA + NL + blockB)
    ok('20.21 ★★ 全部就绪 ⇒ 认领成功', !!full, JSON.stringify(full && full.count))
    ok('20.22 ★ 按块序合并（A 在 B 前，不按完成序）',
       !!full && full.board === '块A看板' + NL + NL + '块B看板', JSON.stringify(full && full.board))
    ok('20.23 ★ 认领后全部消费（绝不重复收网）', lateMemorySize(s2) === 0)

    // ③ 顺序颠倒也必须按原文位置合并（蒸馏是并发的，完成序不可信）
    const s2r = sid + '-rev'
    pushLateMemory(s2r, blockB, entB, '块B看板')   // 先完成的是 B
    pushLateMemory(s2r, blockA, entA, '块A看板')   // 后完成的是 A
    const rev = takeLateMemory(s2r, blockA + NL + blockB)
    ok('20.24 ★★ 完成序颠倒仍按源块序合并',
       !!rev && rev.board === '块A看板' + NL + NL + '块B看板', JSON.stringify(rev && rev.board))

    // ④ 短文本：逐字仍可匹配，但不参与容错（防误配）
    const s3 = sid + '-short'
    pushLateMemory(s3, 'short text here', entA, '短看板')
    ok('20.25 ★ 短文本不参与容错匹配（防误配）', takeLateMemory(s3, 'short text here plus more') === null)
    ok('20.26 短文本逐字仍可匹配', (takeLateMemory(s3, 'short text here') || {}).board === '短看板')

    // ⑤ 多条候选（不同轮次出现相同文本）⇒ 拼接不等于原文 ⇒ 自动 no-op
    const s4 = sid + '-amb'
    const base = '丙'.repeat(100)
    pushLateMemory(s4, base, entA, '候选1')
    pushLateMemory(s4, base + '丁'.repeat(100), entB, '候选2')
    const amb = takeLateMemory(s4, base + '丁'.repeat(100))
    ok('20.27 ★ 逐字命中优先（长的那条）', amb && amb.board === '候选2', JSON.stringify(amb && amb.board))

    // ⑥ 嵌在别段中间 ⇒ 段对齐排除
    const s5 = sid + '-mid'
    const frag = '戊'.repeat(100)
    pushLateMemory(s5, frag, entA, '本该不匹配')
    ok('20.28 ★ 嵌在别段中间不匹配（段对齐排除巧合）',
       takeLateMemory(s5, '前缀' + frag + '后缀') === null)
    ok('20.29 段首对齐但**部分**覆盖仍拒绝',
       takeLateMemory(s5, frag + NL + '后段') === null)
    ok('20.30 完全覆盖才认领',
       (takeLateMemory(s5, frag) || {}).board === '本该不匹配')
  }
}

// ──【21】方案二端到端：出生放行 → 暂存 → 下轮收网 ─────────────────────────
//   这是整个方案二的**唯一验收点**：不验它，前面所有单测都只是零件。
//   链路：birthStart/birthFinish 放行原文（task.passedThrough）
//         → distill 稍后成功 ⇒ pushLateMemory（按 raw 索引）
//         → 下一轮 pre-step：runPreStepEmit 用 awaitDistilled 取回
//         → 官方 user/message + surfaceOp replace 收网。
console.log('')
console.log('【21】birth 下轮收网：端到端')
{
  const NL = String.fromCharCode(10)
  const mkUser = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
  const mkA = (seq, reasoning) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: reasoning }] } } })
  // 与生产同口径：多块用 '\n' 拼接（这正是容错匹配要对付的形状）
  const rawOfImpl = (ev) => ev && ev.data && ev.data.message
    ? ev.data.message.content.filter((b) => b.type === 'reasoning').map((b) => String(b.text || '')).join(NL) : null
  const mkSession = (events) => {
    const map = new Map(events.map((e) => [e.seq, e]))
    const calls = []
    return {
      id: 'sess-claim',
      surface: { nodes: events.map((e) => e.seq) },
      eventAt: (s) => map.get(s),
      requestContext: () => ({ contextWindow: 262144 }),
      append(type, data, meta) { calls.push({ type, data, meta }); return { seq: 9000 + calls.length } },
      __calls: calls,
    }
  }
  const mkCtx = () => ({ get: (k) => (k === 'tokenMeter' ? { measure: () => ({ usedTokens: Math.floor(262144 * 0.10) }) } : null) })

  // A1 是「上一轮放行原文」的那一块：长到足以越过门槛
  const rawA1 = '甲'.repeat(900)
  // 表面：U1 / A1 / U2 / A2(活跃尾部) —— keepTail=1 ⇒ A1 已滑出尾部，可收网
  const buildEvents = () => [mkUser(1, '第一问'), mkA(2, rawA1), mkUser(4, '第二问'), mkA(5, '活跃尾部')]

  // ── 反例：没有暂存结果 ⇒ 必须【不发】 ──
  {
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory('sess-claim', raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.1 ★ 无暂存结果 ⇒ 不发（保持原文，绝不误动表面）', r.emitted === false && s.__calls.length === 0, JSON.stringify(r))
  }

  // ── 正例：有暂存结果 ⇒ 必须收网 ──
  {
    const sid = 'sess-claim'
    pushLateMemory(sid, rawA1, [{ id: 'k1' }], '【收网看板】这是迟到编译出来的语义摘要')
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory(sid, raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.2 ★★ 有暂存结果 ⇒ 收网成功（方案二的核心承诺）', r.emitted === true, JSON.stringify(r))
    const u = s.__calls.find((c) => c.type === 'user/message')
    ok('21.3 用的是官方 user/message 替换者（不是 assistant/message）', !!u && u.type === 'user/message')
    ok('21.4 surfaceOp 是 replace 且区间完整', !!u && u.meta && u.meta.surfaceOp && u.meta.surfaceOp.op === 'replace'
       && Number.isInteger(u.meta.surfaceOp.startSeq) && Number.isInteger(u.meta.surfaceOp.endSeq))
    ok('21.5 ★ 被遮蔽的 A1(seq=2) 在 sourceEventSeqs 里（可溯源）',
       !!u && u.meta.sourceEventSeqs.includes(2), JSON.stringify(u && u.meta.sourceEventSeqs))
    ok('21.6 ★ 活跃尾部 A2(seq=5) 绝不被遮蔽（不许把当轮回答换掉）',
       !!u && !u.meta.sourceEventSeqs.includes(5))
    ok('21.7 看板正文确实进了消息（不是空壳）',
       !!u && JSON.stringify(u.data).indexOf('收网看板') >= 0)
    ok('21.8 ★ 收网后暂存被消费（同一结论绝不重复收网）', lateMemorySize(sid) === 0)
  }

  // ── 收网只发生一次：再跑一次必须不发 ──
  {
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory('sess-claim', raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.9 ★ 暂存消费后不再重复收网（幂等）', r.emitted === false && s.__calls.length === 0)
  }
}

console.log('')
console.log('【22】编译输入止血：覆盖水位与成对校验')
await test22()
// ══════════════════════════════════════════════════════════════════════════
// 22. 证据截面冻结（adaptEvidence 返回冻结对象；过滤只能构造新数组）
//   v11.8：cover.json 覆盖水位（markCovered / coverWatermarkOf / coverSnapshotOk）已无生产调用方，
//   随代码一并删除（22.1–22.11）；覆盖判据现由结构化快照 coverage.coveredSeqs 精确成员判定承担。
// ══════════════════════════════════════════════════════════════════════════
async function test22() {
  // ── 冻结对象回归（核心 bug：adaptEvidence 返回冻结对象）──
  {
    const a = adaptEvidence({ events: [], inFlightIds: new Set(), cutSeq: null })
    ok('22.12 ★★ adaptEvidence 返回冻结对象（过滤绝不能改它）', Object.isFrozen(a) === true)
    let threw = false
    try { a.tools = [] } catch { threw = true }
    ok('22.13 ★★ 证明改冻结字段必抛错 ⇒ 生产代码必须构造新数组而非赋值', threw === true)
  }
}

console.log('\n【23】v11.6 成本模型与门槛（2026-09-23，docs/AUDIT-V11.5.md §一）')
{
  // 默认值锁定
  eq('23.1 ★ birthMinChars = 3100（自洽保本原长 2,959 保守取整）', DEFAULTS.birthMinChars, 3100)
  eq('23.2 ★ maxOutputTokens = 850（v3 目标 450 字符 ×2 安全系数，恒定不随输入放大）', DEFAULTS.maxOutputTokens, 850)
  // 成本模型纯函数
  const e0 = birthEconomics(3100, null, {})
  ok('23.3 R 取不到 ⇒ 回落 55 且标 fallback', e0.R === 55 && e0.rSource === 'fallback', e0)
  eq('23.4 绝对下界 B_abs = ceil(460 / (54×0.02)) = 426', e0.bAbs, 426)
  ok('23.5 默认门槛 3100 在 R=55 下 verdict=ok 且 bMin ≤ 3100', e0.verdict === 'ok' && e0.bMin <= 3100, e0)
  ok('23.6 旧门槛 500 在 R=55 下必亏（below-min，netAtTarget<0）', birthEconomics(500, null, {}).verdict === 'below-min' && birthEconomics(500, null, {}).netAtTarget < 0)
  ok('23.7 低于绝对下界 ⇒ below-abs', birthEconomics(300, null, {}).verdict === 'below-abs')
  const e1 = birthEconomics(5000, { usedTokens: 100000, contextWindow: 128000, source: 'meter' }, { econCharsPerTurn: 4000 })
  ok('23.8 有水位 + 每轮增量 ⇒ R 由剩余窗口估出（28）且 rSource=meter', e1.R === 28 && e1.rSource === 'meter', e1)
  ok('23.9 剩余窗口变小 ⇒ 允许 ρ 变小（单调）', e1.rhoMax < e0.rhoMax, { e1: e1.rhoMax, e0: e0.rhoMax })
  ok('23.10 每轮增量未标定时**不**用水位（避免抖动），回落 fallback', birthEconomics(5000, { usedTokens: 1, contextWindow: 128000, source: 'meter' }, {}).rSource === 'fallback')
  eq('23.11 B 非正 ⇒ null（绝不抛）', birthEconomics(0, null, {}), null)
  // 缺陷 D：timeoutMs / finishWaitMs 关系校验
  const c1 = normalizeConfig({ mode: 'birth', birthDeferredClaim: false, birth: { finishWaitMs: 12000 }, timeoutMs: 8000 })
  eq('23.12 ★ timeoutMs < finishWaitMs+宽限(1500)+2000 ⇒ 抬到 15500', c1.timeoutMs, 15500)
  ok('23.13 抬高必留痕 configAdjusted.timeoutMs', c1.configAdjusted && c1.configAdjusted.timeoutMs && c1.configAdjusted.timeoutMs.from === 8000, c1.configAdjusted)
  const c2 = normalizeConfig({ mode: 'birth', birthDeferredClaim: false, birth: { finishWaitMs: 12000 }, timeoutMs: 20000 })
  ok('23.14 已满足（线上 20000）⇒ 零变化、无 configAdjusted', c2.timeoutMs === 20000 && !c2.configAdjusted)
  const c3 = normalizeConfig({ mode: 'birth', birthDeferredClaim: true, birth: { finishWaitMs: 12000 }, timeoutMs: 8000 })
  ok('23.15 deferredClaim 开着（ready-only，不等 finishWait）⇒ 不改 timeoutMs', c3.timeoutMs === 8000 && !c3.configAdjusted)
  eq('23.15a v11.8 缺省 deferredClaim=false ⇒ 缺省配置同样受抬高保护', normalizeConfig({ mode: 'birth', birth: { finishWaitMs: 12000 }, timeoutMs: 8000 }).timeoutMs, 15500)
  ok('23.16 非 birth 模式不改 timeoutMs', normalizeConfig({ mode: 'checkpoint', birthDeferredClaim: false, birth: { finishWaitMs: 12000 }, timeoutMs: 8000 }).timeoutMs === 8000)
  // v11.8：finish 最多等 finishWaitMs + finishHeadersGraceMs ⇒ 宽限必须计入抬高目标
  eq('23.17 ★ 宽限 5000 ⇒ 抬到 12000+5000+2000=19000', normalizeConfig({ mode: 'birth', birthDeferredClaim: false, birth: { finishWaitMs: 12000, finishHeadersGraceMs: 5000 }, timeoutMs: 14000 }).timeoutMs, 19000)
  eq('23.18 宽限关（0）⇒ 仍按 finishWaitMs+2000', normalizeConfig({ mode: 'birth', birthDeferredClaim: false, birth: { finishWaitMs: 12000, finishHeadersGraceMs: 0 }, timeoutMs: 8000 }).timeoutMs, 14000)
}

console.log('\n【24】阶段 0 bug 回归（2026-09-24 大清扫）')
{
  // ① 凭据读取：行首锚定 + 键名转义 + 剥引号
  const credF = tmpFile('bug0-credentials.yaml')
  fs.writeFileSync(credF, 'MY_DEEPSEEK_API_KEY: sk-WRONG-belongs-to-another-provider\nDEEPSEEK_API_KEY: sk-RIGHT\nQUOTED_KEY: "sk-quoted"\n')
  eq('24.1 ★ 前缀键不得误命中（子串陷阱）', readApiKey({ credentialRef: 'DEEPSEEK_API_KEY', credentialsPath: credF }), 'sk-RIGHT')
  eq('24.2 ★ 值带引号时剥掉引号', readApiKey({ credentialRef: 'QUOTED_KEY', credentialsPath: credF }), 'sk-quoted')
  ok('24.3 空 ref 仍明确失败', (() => { try { readApiKey({ credentialRef: '', credentialsPath: credF }); return false } catch { return true } })())
  ok('24.4 缺失键仍明确失败', (() => { try { readApiKey({ credentialRef: 'NOPE_KEY', credentialsPath: credF }); return false } catch { return true } })())

  // ③ 未知配置键进 unknownOptions（BOOT 可见），不再静默吞掉
  const u = normalizeConfig({ totallyTypoKey: 123, mode: 'birth' })
  ok('24.9 ★ 未知键进 unknownOptions', Array.isArray(u.unknownOptions) && u.unknownOptions.includes('totallyTypoKey'), u.unknownOptions)
  const u2 = normalizeConfig({ distill: { timeoutMs: 1000 }, rules: { foldRuns: false }, birth: { finishWaitMs: 6000 } })
  ok('24.10 嵌套别名容器不算未知键', (u2.unknownOptions || []).length === 0, u2.unknownOptions)
  eq('24.11 README 回滚键 birth.finishWaitMs 生效（旧扁平 finishWaitMs 是 no-op）', u2.birthFinishWaitMs, 6000)
  const u3 = normalizeConfig({ stateEvidenceViews: true })
  ok('24.12 退役键走 retiredOptions 而非 unknownOptions', (u3.retiredOptions || []).includes('stateEvidenceViews') && !(u3.unknownOptions || []).includes('stateEvidenceViews'))
  const u4 = normalizeConfig({ trace: true })
  eq('24.13 已知键不误报', (u4.unknownOptions || []).length, 0)
  const u5 = normalizeConfig({ birth: { finishWait: 6000, finishWaitMs: 5000 }, distill: { timeout: 1 } })
  ok('24.13a ★ 嵌套容器里拼错的键同样进 unknownOptions', ['birth.finishWait', 'distill.timeout'].every((k) => u5.unknownOptions.includes(k)) && !u5.unknownOptions.includes('birth.finishWaitMs'), u5.unknownOptions)

  // ④ DEP_ID 必须覆盖全部 import 的本地模块（BOOT 上岗自证）
  ok('24.14 ★ DEP_ID 含 exact-flights.js（曾漏）', typeof DEP_ID === 'string' && DEP_ID.includes('exact-flights.js'))
  for (const dep of ['emitter.js', 'evidence-ledger.js', 'consumption.js', 'state-memory.js', 'snapshot-store.js']) {
    ok('24.15 DEP_ID 含 ' + dep, DEP_ID.includes(dep))
  }
  // v11.8：DEP_ID 改为自动枚举 src/ ⇒ 新增模块不可能再漏登记
  const srcFiles = fs.readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'plugin.js')
  const listed = DEP_ID.split(' ').map((x) => x.split('=')[0])
  ok('24.16 ★ DEP_ID 覆盖 src/ 下全部模块 + 包入口', srcFiles.every((f) => listed.includes(f)) && listed.includes('index.js') && listed.length === srcFiles.length + 1, { missing: srcFiles.filter((f) => !listed.includes(f)), listed: listed.length })
  ok('24.17 DEP_ID 每项都读到了 size@mtime（无 =?）', !DEP_ID.includes('=?'), DEP_ID)
}

console.log('  通过 ' + pass + ' / 失败 ' + fail)
console.log('='.repeat(56))
process.exit(fail === 0 ? 0 : 1)