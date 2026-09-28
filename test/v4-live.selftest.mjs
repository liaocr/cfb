// test/v4-live.selftest.mjs —— tools/v4-live.mjs 的离线端到端自测（本地假 DeepSeek，不需要钥匙）
// 假服务：thinking enabled 的请求 = 主模型（流式 reasoning_content + content）；
//         thinking disabled 的请求 = 副模型（v4 ⇒ 按本段原文给 JSON Lines 条目；v3 ⇒ 给一段短文）。
// 副模型延迟：整块 v4 故意慢（900ms）、每段 150ms ⇒ 同一条录音下 v4 整块超时、v4 增量替换成功。
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
// ★ 不能用 spawnSync：假服务和它在同一个事件循环里，同步等子进程会把假服务饿死
const run = (args, env) => new Promise((ok) => {
  const p = spawn(process.execPath, args, { env })
  let stdout = '', stderr = ''
  p.stdout.on('data', (c) => { stdout += c }); p.stderr.on('data', (c) => { stderr += c })
  const t = setTimeout(() => p.kill('SIGKILL'), 60000)
  p.on('close', (status) => { clearTimeout(t); ok({ status, stdout, stderr }) })
})
import { fileURLToPath } from 'node:url'
import { parseArgs, modeConfig, summarize } from '../tools/v4-live.mjs'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)) } }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const PARAS = Array.from({ length: 10 }, (_, i) =>
  `第${i + 1}步：检查 stepFn${i + 1} 的返回值，发现它在 retry=${i} 时返回 null。` + '反复核对上下文，确认这一点没有问题。'.repeat(6))
const REASONING = PARAS.join('\n\n')

function sideReply(prompt) {
  const m = prompt.lastIndexOf('【本段】\n')
  const full = prompt.lastIndexOf('【上一轮思维链】\n')
  if ((m >= 0 || full >= 0) && prompt.includes('INCUMBENT')) {  // v4（条目协议）；v3 也用同一标记，靠协议词区分
    const body0 = m >= 0 ? prompt.slice(m + 5) : prompt.slice(full + 9)
    const body = body0.split('\n\n【标注要求重申】')[0]
    const lines = []
    let n = 0
    for (const para of body.split('\n\n')) {
      const s = para.trim(); if (!s) continue
      const first = s.split('。')[0]
      if (!first) continue
      lines.push(JSON.stringify({ id: 'o' + (++n), k: 'COMPUTED', ev: 'derived', text: first.slice(0, 50), anchor: first.slice(0, 12) }))
    }
    // 分段（无前段条目时与整块同一提示词格式）⇒ 按输入长度区分：短 = 一段（快），长 = 整块（慢）
    return { text: lines.join('\n'), ms: body.length < 900 ? 150 : 900 }
  }
  return { text: '结论：stepFn 系列在重试时返回 null，是同一根因。' + '补充。'.repeat(20), ms: 200 }
}

function startMock() {
  const seen = { main: 0, side: 0, auth: new Set() }
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', async () => {
      seen.auth.add(req.headers.authorization)
      const j = JSON.parse(b)
      const main = j.thinking && j.thinking.type === 'enabled'
      if (main) {
        seen.main++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (let i = 0; i < REASONING.length; i += 40) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: REASONING.slice(i, i + 40) } }] }) + '\n\n')
          await new Promise((r) => setTimeout(r, 6))
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '下一步：read_file stepFn1.js' } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 900 } }) + '\n\n')
        res.end('data: [DONE]\n\n')
        return
      }
      seen.side++
      if (process.env.V4LIVE_DEBUG) console.log('side-in', Date.now() % 100000, JSON.stringify(j).length)
      const prompt = j.messages.map((m) => m.content).join('\n')
      const r = sideReply(prompt)
      await new Promise((ok) => setTimeout(ok, r.ms))
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: r.text } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: r.text }, finish_reason: 'stop' }] }))
      }
    })
  })
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, url: 'http://127.0.0.1:' + srv.address().port })))
}

;(async () => {
  await test('§1 参数解析 / 模式配置', () => {
    const o = parseArgs(['--modes', 'v4inc,v3', '--cfg', '{"birthFinishWaitMs":900}', '--only', 'a,b'])
    assert.equal(o.replayConcurrency, 1)
    assert.deepEqual(o.modes, ['v4inc', 'v3']); assert.equal(o.cfg.birthFinishWaitMs, 900); assert.deepEqual(o.only, ['a', 'b'])
    assert.throws(() => parseArgs(['--modes', 'v5']), /unknown mode/)
    assert.equal(modeConfig('v4', {}).compressV4Incremental, false)
    assert.equal(modeConfig('v4inc', {}).compressV4Incremental, true)
    assert.equal(modeConfig('v3', {}).compressPrompt, 'v3')
  })
  await test('§2 summarize：命中率只算够门槛的块', () => {
    const s = summarize([{ mode: 'v4inc', why: 'condensed', ratio: 0.2, outChars: 300, finishHoldMs: 100 },
      { mode: 'v4inc', why: 'below-floor', finishHoldMs: 0 }, { mode: 'v4inc', why: 'distill-timeout', finishHoldMs: 1500 }])
    assert.equal(s.v4inc.eligible, 2); assert.equal(s.v4inc.condensed, 1); assert.equal(s.v4inc.hitRate, 0.5); assert.equal(s.v4inc.finishHoldMsMax, 1500)
  })
  const mock = await startMock()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'v4live-'))
  try {
    await test('§3 端到端（假 DeepSeek）：录制 → 三模式回放；v4 整块超时、v4 增量替换成功；钥匙不落盘', async () => {
      const cfg = JSON.stringify({ birthFinishWaitMs: 500, finishHeadersGraceMs: 0, birthMinChars: 800, birthMinSavedChars: 50, birthTokenGate: false, compressV4SegmentChars: 500, prewarm: false })
      const r = await run([path.join(ROOT, 'tools/v4-live.mjs'), '--base-url', mock.url, '--out', out, '--only', 'eacces-config', '--cfg', cfg],
        { ...process.env, DEEPSEEK_API_KEY: 'sk-test-SECRET-123' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
      const by = Object.fromEntries(rep.rows.map((x) => [x.mode, x]))
      assert.equal(by.v4.why, 'distill-timeout', JSON.stringify(by.v4))
      assert.equal(by.v4inc.why, 'condensed', JSON.stringify({ ...by.v4inc, text: undefined }))
      assert.equal(by.v4inc.promptVersion, 'compress-v4-ops6:450:inc500')
      assert.ok(by.v4inc.segments && by.v4inc.segments.n >= 4 && by.v4inc.segments.ok === by.v4inc.segments.n)
      assert.ok(by.v4inc.text.includes('stepFn') && by.v4inc.outChars < by.v4inc.rawChars * 0.5, by.v4inc.text)
      assert.ok(by.v4inc.finishHoldMs < 500, 'hold=' + by.v4inc.finishHoldMs)
      assert.equal(by.v3.why, 'condensed')
      assert.equal(mock.seen.main, 1)
      assert.ok([...mock.seen.auth].every((a) => a === 'Bearer sk-test-SECRET-123'))
      for (const f of fs.readdirSync(out)) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('SECRET'), f + ' 含钥匙')
      assert.ok(fs.readFileSync(path.join(out, 'report.md'), 'utf8').includes('| v4inc |'))
    })
    await test('§4 --replay 复用录音：不再调主模型；无钥匙直接报错', async () => {
      const before = mock.seen.main
      const cfg = JSON.stringify({ birthFinishWaitMs: 500, finishHeadersGraceMs: 0, birthMinChars: 800, birthMinSavedChars: 50, birthTokenGate: false, compressV4SegmentChars: 500, prewarm: false })
      const r = await run([path.join(ROOT, 'tools/v4-live.mjs'), '--base-url', mock.url, '--replay', path.join(out, 'recordings.json'), '--modes', 'v4inc', '--out', out + '-2', '--cfg', cfg],
        { ...process.env, DEEPSEEK_API_KEY: 'sk-x' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(mock.seen.main, before)
      const e = await run([path.join(ROOT, 'tools/v4-live.mjs')], { ...process.env, DEEPSEEK_API_KEY: '' })
      assert.notEqual(e.status, 0); assert.ok(/DEEPSEEK_API_KEY/.test(e.stderr))
    })
    await test('§5 --recompile：零调用复用捕获的分段结果；产物与真机一致', async () => {
      const before = { main: mock.seen.main, side: mock.seen.side }
      const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
      const live = rep.rows.find((x) => x.mode === 'v4inc')
      assert.ok(Array.isArray(live.capture) && live.capture.length >= 4 && live.capture.every((c) => c.segText && (c.ops || c.error)))
      const r = await run([path.join(ROOT, 'tools/v4-live.mjs'), '--recompile', path.join(out, 'report.json'), '--scale', '0.5', '--out', out + '-3'],
        { ...process.env, DEEPSEEK_API_KEY: '' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual({ main: mock.seen.main, side: mock.seen.side }, before, '重编译不得发任何请求')
      const re = JSON.parse(fs.readFileSync(path.join(out + '-3', 'report.json'), 'utf8')).rows[0]
      assert.equal(re.why, live.why); assert.equal(re.text, live.text); assert.equal(re.simulated.missing, 0)
    })
  } finally {
    if (process.env.V4LIVE_DEBUG) console.log(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
    mock.srv.close(); fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(out + '-2', { recursive: true, force: true }); fs.rmSync(out + '-3', { recursive: true, force: true })
  }
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exit(fail ? 1 : 0)
})()
