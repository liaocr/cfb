#!/usr/bin/env node
// v11.10 全面优化的回归钉子：
//   §1 取消泄漏（flush / 硬停 / 无 finish / 消费者提前退出）      §2 配置（漏登记键、退役键、显式化旋钮）
//   §3 token 估算与 token 闸门 / token 门槛                       §4 残留锁接管（fs-lock.js，三处锁）
//   §5 trace 轮转与正文片段开关                                  §6 provider / 凭据解析缓存
//   §7 makeBirthCompiler（编译器工厂，真实本机 HTTP）
// 全部本机执行，零外网、零 API 调用。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { birthTransform, birthSettle } from '../src/birth.js'
import { normalizeConfig, DEFAULTS } from '../src/config.js'
import { makeBirthCompiler } from '../src/distill.js'
import { prepareEvidenceLedger, ledgerDirectory } from '../src/evidence-ledger.js'
import { openLockExclusive, isStaleLock, parseLockOwner, lockStats } from '../src/fs-lock.js'
import { provenanceOf } from '../src/messages.js'
import { readProviderSpec, readApiKey, clearProviderCache } from '../src/provider.js'
import { commitSnapshot, snapshotPath } from '../src/snapshot-store.js'
import { estimateTokens, wideShare } from '../src/tokens.js'
import { makeTraceWriter } from '../src/trace.js'

let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-hardening-'))

// ═══ §1 取消泄漏 ═══════════════════════════════════════════════════════════════
// 副模型 5 秒才回；收网预算 150ms。断言：放弃应用的每一条路径都掐掉在飞请求。
function birthRig({ finishKind = 'stop', consumerBreak = false, sourceThrows = false, deferred = false } = {}) {
  const seen = { aborted: false, traces: [] }
  const raw = 'x'.repeat(4000)
  async function* src() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: raw }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    if (sourceThrows) throw new Error('upstream boom')
    if (finishKind) yield { type: 'finish', reason: { kind: finishKind } }
  }
  const deps = {
    cfg: { mode: 'birth', dryRun: false, birthMinChars: 100, birthFinishWaitMs: 150, finishHeadersGraceMs: 0, stateCompress: true, compileMode: 'compress', birthDeferredClaim: deferred },
    sessionId: 's1', archive: async () => 'art://fixture-handle-000000',
    trace: (tag, data) => seen.traces.push({ tag, data }),
    distill: (_raw, signal) => new Promise((res, rej) => {
      signal?.addEventListener('abort', () => { seen.aborted = true; rej(Object.assign(new Error('cancelled'), { cancelled: true })) })
      setTimeout(() => res({ text: 'short' }), 5000).unref()
    }),
  }
  const run = async () => {
    const out = []
    try {
      for await (const c of birthTransform(src(), deps)) { out.push(c); if (consumerBreak && c.type === 'block-start' && c.index === 1) break }
    } catch (e) { seen.threw = e }
    await sleep(30)
    return out
  }
  return { seen, run, raw }
}

await test('§1a 正常 finish 到点放弃 ⇒ 取消（基线，v11.10 前即成立）', async () => {
  const r = birthRig(); await r.run()
  assert.equal(r.seen.aborted, true)
})
await test('§1b finish kind=error（硬停）⇒ 取消 + birth-flush 留痕 + 原文逐字放行', async () => {
  const r = birthRig({ finishKind: 'error' }); const out = await r.run()
  assert.equal(r.seen.aborted, true)
  const f = r.seen.traces.find((t) => t.tag === 'birth-flush')
  assert.ok(f && f.data.why === 'hard-stop:error' && f.data.cancelled === true, JSON.stringify(f))
  const end = out.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(end.block.text, r.raw)
})
await test('§1c 源流不给 finish 就结束 ⇒ 取消（why=no-finish）', async () => {
  const r = birthRig({ finishKind: null }); await r.run()
  assert.equal(r.seen.aborted, true)
  assert.ok(r.seen.traces.some((t) => t.tag === 'birth-flush' && t.data.why === 'no-finish'))
})
await test('§1d 源流抛错 ⇒ 取消（why=source-error）且主流错误原样抛出', async () => {
  const r = birthRig({ sourceThrows: true }); await r.run()
  assert.equal(r.seen.aborted, true)
  assert.equal(r.seen.threw && r.seen.threw.message, 'upstream boom')
  assert.ok(r.seen.traces.some((t) => t.tag === 'birth-flush' && t.data.why === 'source-error'))
})
await test('§1e 消费者提前退出（用户取消）⇒ 取消 + birth-consumer-return', async () => {
  const r = birthRig({ consumerBreak: true }); await r.run()
  assert.equal(r.seen.aborted, true)
  assert.ok(r.seen.traces.some((t) => t.tag === 'birth-consumer-return'))
  assert.ok(r.seen.traces.some((t) => t.tag === 'birth-distill-cancelled' && t.data.why === 'consumer-return'))
})
await test('§1f flush 路径尊重 birthDeferredClaim:true（结果留给下一轮，不取消）', async () => {
  const r = birthRig({ finishKind: 'error', deferred: true }); await r.run()
  assert.equal(r.seen.aborted, false)
})
await test('§1g 消费者提前退出时即使 deferredClaim:true 也取消（块从未出站，不可能被认领）', async () => {
  const r = birthRig({ consumerBreak: true, deferred: true }); await r.run()
  assert.equal(r.seen.aborted, true)
})

// ═══ §2 配置 ═══════════════════════════════════════════════════════════════════
await test('§2a birth.probeTimeoutMs 不再被误报为 unknownOptions，且生效', () => {
  const c = normalizeConfig({ birth: { probeTimeoutMs: 321 } })
  assert.deepEqual(c.unknownOptions, [])
  assert.equal(c.birthHandleProbeTimeoutMs, 321)
})
await test('§2b birthHandleInText 退役：扁平与嵌套都进 retiredOptions、从生效配置删除', () => {
  const c = normalizeConfig({ birthHandleInText: false, birth: { handleInText: true } })
  assert.deepEqual(c.retiredOptions, ['birthHandleInText', 'birth.handleInText'])
  assert.deepEqual(c.unknownOptions, [])
  assert.equal('birthHandleInText' in c, false)
  assert.equal('birthHandleInText' in DEFAULTS, false)
})
await test('§2c 新 token 键：嵌套别名 birth.minTokens/tokenGate/minSavedTokens 生效', () => {
  const c = normalizeConfig({ birth: { minTokens: 900, tokenGate: false, minSavedTokens: 40 } })
  assert.equal(c.birthMinTokens, 900); assert.equal(c.birthTokenGate, false); assert.equal(c.birthMinSavedTokens, 40)
  assert.deepEqual(c.unknownOptions, [])
})
await test('§2d 显式化的内部旋钮：值与各调用点原回落值逐字相同（行为零变化）', () => {
  const want = { keepTail: 1, pluginName: 'cot-form-b', emitterProducer: 'cot-checkpoint', maxInlineToolResultChars: 2000,
    staticMinRawChars: null, birthCancelOnGiveUp: true, birthDiskWaitMs: 400, econCacheDiscount: 0.02, econTemplateChars: 460,
    econR: 60, econCharsPerTurn: null, birthMinTokens: null, birthTokenGate: true, birthMinSavedTokens: 0, tracePreviewChars: 48 }
  for (const [k, v] of Object.entries(want)) assert.equal(DEFAULTS[k], v, k)
  assert.ok(DEFAULTS.traceMaxBytes > 0)
  // staticMinRawChars 必须保持「非有限数」—— 有限数会静态接管动态门槛
  assert.equal(Number.isFinite(DEFAULTS.staticMinRawChars), false)
})
await test('§2e 真正拼错的键照旧报 unknownOptions（白名单收紧后不回归）', () => {
  const c = normalizeConfig({ finishWaitMs: 1, birth: { finishWait: 2 } })
  assert.deepEqual(c.unknownOptions, ['finishWaitMs', 'birth.finishWait'])
})

// ═══ §3 token 估算与闸门 ═══════════════════════════════════════════════════════
await test('§3a estimateTokens：英文 0.3/字、中文 0.6/字（DeepSeek 官方口径）、空串 0', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('a'.repeat(1000)), 300)
  assert.equal(estimateTokens('中'.repeat(1000)), 600)
  assert.equal(estimateTokens('中'.repeat(10) + 'a'.repeat(10)), 9)
  assert.equal(estimateTokens(null), 0)
  assert.equal(wideShare('中a'), 0.5)
})
const gateRig = (summary, extraCfg = {}) => {
  const traces = []
  return birthSettle({ index: 0, text: 'The quick brown fox jumps over the lazy dog. '.repeat(90) }, {
    cfg: { mode: 'birth', dryRun: false, birthMinChars: 100, birthFinishWaitMs: 500, stateCompress: true, compileMode: 'compress', ...extraCfg },
    sessionId: 's1', archive: async () => 'art://fixture-handle-000000', trace: (tag, data) => traces.push({ tag, data }),
    distill: async () => ({ text: summary }),
  }).then((r) => ({ r, traces }))
}
await test('§3b 英文原文 → 中文摘要：字符净省达标但 token 反增 ⇒ no-token-gain（原文放行）', async () => {
  // 原文 4,050 英文字符 ≈ 1,215 token；摘要 2,100 中文字符 ≈ 1,260 token
  const { r, traces } = await gateRig('摘'.repeat(2100))
  assert.equal(r.why, 'no-token-gain')
  const p = traces.find((t) => t.tag === 'birth-passthrough')
  assert.ok(p.data.netSaved > 0 && p.data.netSavedTokensEst < 0, JSON.stringify(p.data))
})
await test('§3c 同一场景 birthTokenGate:false ⇒ 回到纯字符判定（condensed）', async () => {
  const { r } = await gateRig('摘'.repeat(2100), { birthTokenGate: false })
  assert.equal(r.why, 'condensed')
})
await test('§3d 正常压缩：condensed 且 trace 带 *TokensEst 字段', async () => {
  const { r, traces } = await gateRig('摘要：狐狸跳过了狗，重复九十次。')
  assert.equal(r.why, 'condensed')
  const c = traces.find((t) => t.tag === 'birth-condensed')
  assert.ok(c.data.rawTokensEst > c.data.outTokensEst && c.data.unit === 'estimate-not-tokenizer', JSON.stringify(c.data))
})
await test('§3e birthMinSavedTokens 抬高门槛', async () => {
  const { r } = await gateRig('摘'.repeat(1500), { birthMinSavedTokens: 500 })   // 1215 − 900 = 315 < 500
  assert.equal(r.why, 'no-token-gain')
})
await test('§3f birthMinTokens（opt-in）按 token 接管字符门槛', async () => {
  // 原文 1,215 token：门槛 2000 ⇒ below-floor；门槛 1000 ⇒ 照常压缩（字符门槛 99999 被接管、不再生效）
  const a = await gateRig('摘要', { birthMinTokens: 2000 })
  assert.equal(a.r.why, 'below-floor')
  const b = await gateRig('摘要', { birthMinTokens: 1000, birthMinChars: 99999 })
  assert.equal(b.r.why, 'condensed')
})

// ═══ §4 残留锁接管 ═════════════════════════════════════════════════════════════
const deadPid = (() => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout) })()
const lockDir = path.join(tmp, 'locks'); fs.mkdirSync(lockDir)
await test('§4a 持锁进程已死（同机、pid ESRCH）⇒ 接管，并写入新持有者', () => {
  const lock = path.join(lockDir, 'a.lock')
  fs.writeFileSync(lock, deadPid + '@' + os.hostname() + '@1')
  assert.equal(isStaleLock(fs.readFileSync(lock, 'utf8')), true)
  const before = lockStats().staleRecovered
  const fd = openLockExclusive(lock); fs.closeSync(fd)
  assert.equal(lockStats().staleRecovered, before + 1)
  assert.equal(parseLockOwner(fs.readFileSync(lock, 'utf8')).pid, process.pid)
  fs.unlinkSync(lock)
  assert.deepEqual(fs.readdirSync(lockDir), [])   // 不留 .stale-* 垃圾
})
for (const [label, content] of [
  ['持锁进程活着（本进程的父进程）', () => process.ppid + '@' + os.hostname() + '@1'],
  ['本进程自己持有', () => process.pid + '@' + os.hostname() + '@1'],
  ['别的机器（共享目录无法判活）', () => deadPid + '@some-other-host@1'],
  ['旧格式 pid@ts（无主机名）', () => deadPid + '@1'],
  ['空文件（v11.9 的 evidence 锁）', () => ''],
]) {
  await test('§4b 不接管：' + label + ' ⇒ EEXIST（fail-closed 不变）', () => {
    const lock = path.join(lockDir, 'b.lock')
    fs.writeFileSync(lock, content())
    assert.throws(() => openLockExclusive(lock), (e) => e.code === 'EEXIST')
    fs.unlinkSync(lock)
  })
}
await test('§4c snapshot-store：崩溃残留锁不再永久阻塞 commitSnapshot', () => {
  const sid = 'sess-lock', f = snapshotPath(sid, 'main')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f + '.lock', process.ppid + '@' + os.hostname() + '@1')   // 活锁 ⇒ 仍然拒绝
  const busy = commitSnapshot({ sessionId: sid, branchId: 'main', entries: [{ id: 'e1', category: 'state', content: '甲', source: 'model' }], coveredSeqs: [1], sourceCutSeq: 1, at: 1 })
  assert.equal(busy.ok, false, JSON.stringify(busy))
  fs.writeFileSync(f + '.lock', deadPid + '@' + os.hostname() + '@1')       // 死锁 ⇒ 接管后成功
  const c = commitSnapshot({ sessionId: sid, branchId: 'main', entries: [{ id: 'e1', category: 'state', content: '甲', source: 'model' }], coveredSeqs: [1], sourceCutSeq: 1, at: 1 })
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(fs.existsSync(f + '.lock'), false)
})
await test('§4d evidence-ledger：死锁接管，活锁仍 evidence-index-busy', () => {
  const input = { sessionId: 'sess-ev', branchId: 'main', tools: [], cutSeq: 0 }
  const dir = ledgerDirectory('sess-ev', 'main'); fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, 'index.lock')
  fs.writeFileSync(lock, process.ppid + '@' + os.hostname() + '@1')
  assert.throws(() => prepareEvidenceLedger(input), /evidence-index-busy/)
  fs.writeFileSync(lock, deadPid + '@' + os.hostname() + '@1')
  prepareEvidenceLedger(input)
  assert.equal(fs.existsSync(lock), false)
})

// ═══ §5 trace 轮转与正文片段开关 ═══════════════════════════════════════════════
await test('§5a trace 超过 traceMaxBytes ⇒ 改名 .1，新文件首行 trace-rotated（锚定格式）', () => {
  const file = path.join(tmp, 'rot', 'trace.log')
  const t = makeTraceWriter({ trace: true, traceFile: file, traceMaxBytes: 2000 })
  for (let i = 0; i < 40; i++) t('evt', { i, pad: 'p'.repeat(60) })
  assert.ok(fs.existsSync(file + '.1'))
  assert.ok(fs.statSync(file).size <= 2000 + 200)
  const first = fs.readFileSync(file, 'utf8').split('\n')[0]
  assert.match(first, /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[trace-rotated\] \{.*\}$/)
  // 证据不丢：两份文件合起来最后一条 evt 必在
  assert.ok(fs.readFileSync(file, 'utf8').includes('"i":39'))
})
await test('§5e 轮转后续写 BOOT 副本（rotatedCopy）⇒ analyze-trace 仍能把新文件归到正确构建', async () => {
  const { createTraceAudit } = await import('../tools/analyze-trace.mjs')
  const file = path.join(tmp, 'rotboot', 'trace.log')
  const t = makeTraceWriter({ trace: true, traceFile: file, traceMaxBytes: 2000 })
  t('BOOT', { selfId: 'build-xyz', birth: { finishWaitMs: 1500 } })
  for (let i = 0; i < 40; i++) t('evt', { i, pad: 'p'.repeat(60) })
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.match(lines[0], /\] \[trace-rotated\] /)
  assert.match(lines[1], /\] \[BOOT\] .*"selfId":"build-xyz".*"rotatedCopy":true/)
  const a = createTraceAudit()
  for (const l of lines) a.add(l)
  const r = a.result()
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].boot.selfId, 'build-xyz')
  assert.equal(r.groups[0].boot.rotatedCopy, true)
  assert.equal(r.rotations, 1)
})
await test('§5b traceMaxBytes:0 ⇒ 不轮转', () => {
  const file = path.join(tmp, 'norot', 'trace.log')
  const t = makeTraceWriter({ trace: true, traceFile: file, traceMaxBytes: 0 })
  for (let i = 0; i < 40; i++) t('evt', { i, pad: 'p'.repeat(60) })
  assert.equal(fs.existsSync(file + '.1'), false)
})
await test('§5c 进程重启后续写：首次写入 stat 已有大小，超限立即轮转', () => {
  const file = path.join(tmp, 'restart', 'trace.log')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'.repeat(5000) + '\n')
  const t = makeTraceWriter({ trace: true, traceFile: file, traceMaxBytes: 4000 })
  t('BOOT', {})
  assert.equal(fs.statSync(file + '.1').size, 5001)
})
await test('§5d provenanceOf previewChars:0 ⇒ 不记录任何用户正文片段；缺省仍 48', () => {
  const msgs = [{ role: 'user', content: '这是一段很长的用户原话'.repeat(10) }]
  assert.equal(provenanceOf(msgs, { previewChars: 0 }).items[0].head, undefined)
  assert.equal(provenanceOf(msgs).items[0].head.length, 48)
})

// ═══ §6 provider / 凭据解析缓存 ════════════════════════════════════════════════
await test('§6a settings.yaml 变更 ⇒ 缓存失效重读；返回副本不污染缓存', () => {
  clearProviderCache()
  const f = path.join(tmp, 'settings.yaml')
  const yml = (url) => 'llm-pi-ai:\n  providers:\n    p1:\n      api: openai-completions\n      baseURL: ' + url + '\n      apiKeyEnv: K1\n'
  fs.writeFileSync(f, yml('https://a.example/v1'))
  const s1 = readProviderSpec(f, 'p1'); s1.baseURL = 'mutated'
  assert.equal(readProviderSpec(f, 'p1').baseURL, 'https://a.example/v1')
  fs.writeFileSync(f, yml('https://bbbb.example/v1'))
  assert.equal(readProviderSpec(f, 'p1').baseURL, 'https://bbbb.example/v1')
  assert.equal(readProviderSpec(f, 'nope'), null)
  assert.equal(readProviderSpec(path.join(tmp, 'missing.yaml'), 'p1'), null)
})
await test('§6b 凭据变更 ⇒ 重读；找不到键每次都抛（不缓存失败）', () => {
  clearProviderCache()
  const f = path.join(tmp, 'creds.yaml')
  fs.writeFileSync(f, 'K1: sk-one\n')
  assert.equal(readApiKey({ credentialsPath: f, credentialRef: 'K1' }), 'sk-one')
  fs.writeFileSync(f, 'K1: sk-two-longer\n')
  assert.equal(readApiKey({ credentialsPath: f, credentialRef: 'K1' }), 'sk-two-longer')
  assert.throws(() => readApiKey({ credentialsPath: f, credentialRef: 'K2' }), /not found/)
  fs.writeFileSync(f, 'K1: sk-two-longer\nK2: sk-k2\n')
  assert.equal(readApiKey({ credentialsPath: f, credentialRef: 'K2' }), 'sk-k2')
})

// ═══ §7 makeBirthCompiler（真实本机 HTTP）══════════════════════════════════════
let lastBody = null
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c })
  req.on('end', () => {
    lastBody = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '摘要' }, finish_reason: 'stop' }] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const keyFile = path.join(tmp, 'keys'); fs.writeFileSync(keyFile, 'LOCAL: unused')
const base = normalizeConfig({ model: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port, credentialsPath: keyFile, credentialRef: 'LOCAL',
  followHostModel: false, followHostProvider: false, keepAlive: false, disableThinking: false, dryRun: false })
const COT = '【原推理】'.repeat(50)
await test('§7a compress + v3 ⇒ 绝对长度提示词，promptVersion 带参数', async () => {
  const cfg = normalizeConfig({ ...base, stateCompress: true, compressPrompt: 'v3' })
  let headers = 0
  const r = await makeBirthCompiler(cfg)(COT, undefined, { onHeaders: () => headers++ })
  const content = lastBody.messages[0].content
  assert.match(content, /目标长度 250~450 字符/)
  assert.ok(content.endsWith(COT))
  assert.equal(r.meta.promptVersion, 'compress-v3:250-450')
  assert.equal(headers, 1)
})
await test('§7b compress + compressSystemPrompt ⇒ system/user 拆分，字节等价', async () => {
  const cfg = normalizeConfig({ ...base, stateCompress: true, compressPrompt: 'v2', compressSystemPrompt: true })
  const r = await makeBirthCompiler(cfg)(COT, undefined, {})
  assert.equal(lastBody.messages.length, 2)
  assert.equal(lastBody.messages[0].role, 'system')
  assert.equal(lastBody.messages[0].content + '\n\n' + lastBody.messages[1].content, I.buildCompressPrompt(COT))
  assert.equal(r.meta.promptVersion, 'compress-v2:sys')
})
await test('§7c compress + v1 ⇒ 旧蒸馏提示词、不拆分', async () => {
  const cfg = normalizeConfig({ ...base, stateCompress: true, compressPrompt: 'v1', compressSystemPrompt: true })
  await makeBirthCompiler(cfg)(COT, undefined, {})
  assert.equal(lastBody.messages.length, 1)
  assert.equal(lastBody.messages[0].content, I.buildDistillPrompt(COT))
})
await test('§7d legacy ⇒ 旧蒸馏提示词', async () => {
  await makeBirthCompiler(base)(COT, undefined, {})
  assert.equal(lastBody.messages[0].content, I.buildDistillPrompt(COT))
})

// ═══ §9 llm-stream 溯源不再随会话长度平方增长 ════════════════════════════════
await test('§9 rolesRunLength / sparseLengths：游程与稀疏编码', async () => {
  const { rolesRunLength, sparseLengths } = await import('../src/messages.js')
  const roles = ['system', 'user', 'assistant', 'tool', 'tool', 'tool', 'assistant', null, 'user']
  assert.equal(rolesRunLength(roles.map((role) => (role ? { role } : null))), 'system user assistant tool*3 assistant ? user')
  assert.equal(rolesRunLength([]), '')
  assert.equal(rolesRunLength(undefined), '')
  assert.deepEqual(sparseLengths([0, 0, 120, 0, 7]), [[2, 120], [4, 7]])
  // 1000 条同 role 消息 ⇒ 常数长度
  assert.equal(rolesRunLength(Array.from({ length: 1000 }, () => ({ role: 'tool' }))), 'tool*1000')
})

await test('§9b 钩子级：llm/stream 真实接线写出游程 roles、稀疏 reasoningChars，previewChars=0 不留正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-llmstream-'))
  const traceFile = path.join(dir, 'trace.log')
  const hooks = new Map()
  I.apply({ on: (n, fn) => hooks.set(n, fn), get: () => null }, {
    ...I.DEFAULTS, enabled: true, dryRun: true, mode: 'birth', model: 'fixture', followHostModel: false, followHostProvider: false,
    trace: true, traceFile, tracePreviewChars: 0,
  })
  const SECRET = 'USER-SECRET-TEXT-0123456789'
  const messages = [
    { role: 'system', content: 'sys' }, { role: 'user', content: SECRET },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'r'.repeat(40) }, { type: 'text', text: 'ok' }] },
    { role: 'tool', content: 'a' }, { role: 'tool', content: 'b' }, { role: 'tool', content: 'c' },
  ]
  const out = []
  for await (const c of hooks.get('llm/stream')({ model: 'fixture', messages }, () => (async function* () { yield { type: 'finish' } })())) out.push(c)
  const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter((l) => l.includes('] [llm-stream] '))
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0].slice(lines[0].indexOf('] [llm-stream] ') + 15))
  assert.equal(rec.roles, 'system user assistant tool*3')
  assert.equal(rec.messageCount, 6)
  assert.ok(Array.isArray(rec.reasoningChars) && rec.reasoningChars.every((x) => Array.isArray(x) && x.length === 2))
  assert.deepEqual(rec.reasoningChars.map((x) => x[0]), [2])
  assert.equal(lines[0].includes(SECRET), false, 'tracePreviewChars=0 ⇒ 用户原文不进 trace')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ═══ §8 analyze-trace：birth 漏斗与收网等待依据 ═══════════════════════════════
await test('§8 analyze-trace：needWaitMs = 真工期 − 免费窗口（按 taskId 关联），覆盖率按当前 finishWaitMs', async () => {
  const { createTraceAudit } = await import('../tools/analyze-trace.mjs')
  const a = createTraceAudit()
  const L = (tag, obj) => a.add('[2026-09-24T00:00:00.000Z] [' + tag + '] ' + JSON.stringify(obj))
  L('BOOT', { selfId: 'x', birth: { finishWaitMs: 1000 }, finishHeadersGraceMs: 500 })
  // 四块：真工期 3000/2000/1800/9000，免费窗口各 1500 ⇒ needWait 1500/500/300/7500
  const plan = [[3000, 'passthrough'], [2000, 'condensed'], [1800, 'condensed'], [9000, 'passthrough']]
  plan.forEach(([ms, how], i) => {
    const taskId = 't' + i
    L('birth-finish-enter', { taskId, gapMs: 1500 })
    L('birth-distill-settled', { taskId, ok: true, ms })
    if (how === 'condensed') L('birth-condensed', { taskId, netSaved: 3000, netSavedTokensEst: 800, waitedMs: 100 })
    else L('birth-passthrough', { taskId, why: 'distill-timeout', waitedMs: 1000 })
  })
  L('birth-flush', { why: 'hard-stop:error' })
  L('birth-distill-cancelled', { why: 'consumer-return' })
  const b = a.result().groups[0].birth
  assert.deepEqual({ ...b.outcomes }, { 'distill-timeout': 2, condensed: 2 })
  assert.equal(b.condensedRate, 0.5)
  assert.equal(b.netSavedTokensEst, 1600)
  assert.equal(b.needWaitMs.n, 4); assert.equal(b.needWaitMs.p50, 500); assert.equal(b.needWaitMs.max, 7500)
  assert.equal(b.finishWait.coverageAtConfigured, 0.5)     // ≤1000: 300, 500
  assert.equal(b.finishWait.coverageWithGrace, 0.75)       // ≤1500: + 1500
  assert.deepEqual({ ...b.flush }, { 'hard-stop:error': 1 }); assert.deepEqual({ ...b.cancelled }, { 'consumer-return': 1 })
})

server.closeAllConnections(); await new Promise((r) => server.close(r))
fs.rmSync(tmp, { recursive: true, force: true })
console.log('PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
