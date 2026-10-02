// tools/traj-fixtures-v2.mjs —— v4.3 新增的两个场景家族（零 API 加家族）：wrong-model（池里是留出）、sse-truncated（池里是 dev）。
//   与 v1 三题的区别：fixed() 不再用正则猜代码形状，而是跑一份**隐藏的语义 oracle**（临时写进仓库、跑完即删；只 import src/，不信任仓库里的可见测试），
//   任何位置的正确修法都算修好，改测试 / 改复现脚本不算。可见测试故意不覆盖故障（和线上一样「测试是绿的」），复现脚本（node scripts/…）真跑、写 trace，
//   这样 Agent 的验收路径是「复现 → 改 → 再复现」，不是「把红测试改绿」。
//   题面来自 v9 冻结题 wrong-model / sse-truncated 的同一故障故事 ⇒ L1 冻结题与 L2 场景同家族（与 eacces-config / flaky-timeout / perf-regression 一致）。
//   sse-truncated 的正确修法需要两处（[DONE] 不得推断 stop + ok 必须要求真实 finish_reason，或在 birth 层兜底）—— 这是 SWE-smith「合并 bug」式的多处修改题。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const runNode = (repo, file, { timeout = 5000 } = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, [file], { cwd: repo, encoding: 'utf8', timeout, env: { PATH: process.env.PATH || '', HOME: repo }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 20 }) } }
  catch (e) { return { code: e.status ?? 1, out: String((e.stdout || '') + (e.stderr || '')) || String(e.message) } }
}
/** 隐藏 oracle：写进 repo/.oracle/check.mjs（import ../src/…），跑完删除。 */
const oracleFixed = (repo, source) => {
  const dir = path.join(repo, '.oracle'); const file = path.join(dir, 'check.mjs')
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, source); return runNode(repo, '.oracle/check.mjs').code === 0 }
  catch { return false } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const testOutput = (repo) => {
  const dir = path.join(repo, 'test'); let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.selftest.mjs')).sort() } catch { /* 无测试目录 */ }
  if (!files.length) return 'verify: 没有 test/*.selftest.mjs'
  const lines = files.map((f) => { const r = runNode(repo, 'test/' + f); return `${r.code === 0 ? 'PASS' : 'FAIL'} test/${f}${r.code === 0 ? '' : '\n' + r.out.trim().split('\n').slice(0, 12).join('\n')}` })
  const fails = lines.filter((l) => l.startsWith('FAIL')).length
  return lines.join('\n') + `\n合计: ${files.length - fails} 通过 / ${fails} 失败`
}
const nodeAllowed = (c) => /^node (scripts\/[\w.-]+\.mjs|test\/[\w.-]+\.selftest\.mjs|verify\.mjs)(\s|$)/.test(c)

const WRONG_MODEL_ORACLE = `import assert from 'node:assert/strict'
import { makePlugin } from '../src/plugin.js'
const lines = []; const trace = (ev, o) => lines.push({ ev, ...o })
const plugin = makePlugin({ model: 'deepseek-v3.1', baseUrl: 'https://api.example' }, trace)
plugin.onRequest({ stream: true, model: 'deepseek-v3.1' }, { seq: 1, model: 'deepseek-v3.1' })
plugin.onRequest({ stream: true }, { seq: 2, model: 'deepseek-v3.2' })
plugin.onRequest({ stream: true }, { seq: 3, model: 'deepseek-v3.2' })
plugin.onRequest({ stream: true }, { seq: 4, model: 'deepseek-v3.3' })
const started = lines.filter((l) => l.ev === 'compiler-transport-started').map((l) => l.model)
assert.deepEqual(started, ['deepseek-v3.1', 'deepseek-v3.2', 'deepseek-v3.2', 'deepseek-v3.3'], '压缩那一跳必须用当前会话模型 ' + JSON.stringify(started))
const streams = lines.filter((l) => l.ev === 'llm-stream').map((l) => l.model)
assert.deepEqual(streams, ['deepseek-v3.1', 'deepseek-v3.2', 'deepseek-v3.2', 'deepseek-v3.3'])
`

const SSE_ORACLE = `import assert from 'node:assert/strict'
import { birthFromFrames } from '../src/birth.js'
const run = (frames) => { const lines = []; birthFromFrames(frames, { rawChars: 8123 }, (ev, o) => lines.push({ ev, ...o })); return lines }
const d = (s) => JSON.stringify({ choices: [{ delta: { content: s } }] })
const fin = (r) => JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] })
const complete = run([d('a'), d('b'), fin('stop'), '[DONE]'])
assert.ok(complete.some((l) => l.ev === 'birth-condensed'), '完整流必须被采纳 ' + JSON.stringify(complete))
assert.ok(!complete.some((l) => l.ev === 'birth-passthrough'))
const truncatedDone = run([d('a'), d('b'), '[DONE]'])
assert.ok(truncatedDone.some((l) => l.ev === 'birth-passthrough'), '只补 [DONE] 的截断流不得写进会话 ' + JSON.stringify(truncatedDone))
assert.ok(!truncatedDone.some((l) => l.ev === 'birth-condensed'))
const truncatedCut = run([d('a'), d('b')])
assert.ok(truncatedCut.some((l) => l.ev === 'birth-passthrough'), '没有结束信号的流不得写进会话 ' + JSON.stringify(truncatedCut))
const lengthStop = run([d('a'), fin('length'), '[DONE]'])
assert.ok(lengthStop.some((l) => l.ev === 'birth-condensed'), 'finish_reason=length 是上游明确结束，按完整处理')
const settled = truncatedDone.find((l) => l.ev === 'compiler-transport-settled')
assert.ok(settled && settled.ok === false, 'settled 必须报 ok:false ' + JSON.stringify(settled))
`

export const TRAJ_TASKS_V2 = [
  {
    id: 'wrong-model',
    prompt: '用户报告：插件压缩用的模型不是当前会话的模型，而是上一次会话的模型。用户给的 trace 片段在 trace/last.log。可用 `node scripts/smoke-session.mjs` 复现（模拟两次会话，写 trace/trace.log 并打印最后几行）。请找出原因并修好，修好后说明依据。验收：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model），旧宿主仍传 options.model 时也要对。',
    files: {
      'src/host-follow.js': "// 跟随宿主：记住宿主最近一次用的模型，压缩那一跳沿用它（避免副模型与会话模型不一致）\nlet lastModel = null\n\nexport function makeHostFollow(cfg) {\n  return {\n    observe(options) { if (options && options.model) lastModel = options.model },\n    callConfig(options) { return { ...cfg, model: lastModel || cfg.model } },\n  }\n}\n",
      'src/plugin.js': "import { makeHostFollow } from './host-follow.js'\nimport { birthTransform } from './birth.js'\n\nexport function makePlugin(cfg, trace) {\n  const host = makeHostFollow(cfg)\n  return {\n    // options：宿主传入的请求选项；n：当前会话的归一化请求\n    onRequest(options, n) {\n      // 宿主 0.9 起 options.model 已废弃（恒为 undefined），当前模型只在 n.model\n      host.observe(options, n)\n      const callCfg = host.callConfig(options)\n      trace('compiler-transport-started', { model: callCfg.model })\n      return birthTransform(n, { cfg: callCfg, trace })\n    },\n  }\n}\n",
      'src/birth.js': "export function birthTransform(n, { cfg, trace }) {\n  trace('llm-stream', { n: n.seq, model: n.model })\n  return { ...n, compressedWith: cfg.model }\n}\n",
      'src/transport.js': "// 预热：按配置里的模型提前建连（与压缩那一跳无关，用的是原始 cfg）\nexport function prewarmTargetUrl(cfg) { return cfg.baseUrl + '/v1/models/' + cfg.model }\nexport function makePrewarmer(cfg, trace) {\n  return (why) => { trace('prewarm', { url: prewarmTargetUrl(cfg), why }) }\n}\n",
      'scripts/smoke-session.mjs': "import fs from 'node:fs'\nimport { makePlugin } from '../src/plugin.js'\nconst lines = []; const trace = (ev, o) => lines.push('[' + ev + '] ' + JSON.stringify(o))\nconst cfg = { model: 'deepseek-v3.1', baseUrl: 'https://api.example' }\nconst plugin = makePlugin(cfg, trace)\n// 会话 1（昨天，旧宿主 0.8：options.model 还会传）\nplugin.onRequest({ stream: true, model: 'deepseek-v3.1' }, { seq: 11, model: 'deepseek-v3.1' })\n// 会话 2（现在，宿主 0.9：options.model 恒为 undefined，当前模型在 n.model）\nplugin.onRequest({ stream: true }, { seq: 12, model: 'deepseek-v3.2' })\nplugin.onRequest({ stream: true }, { seq: 13, model: 'deepseek-v3.2' })\nfs.mkdirSync('trace', { recursive: true }); fs.writeFileSync('trace/trace.log', lines.join('\\n') + '\\n')\nconsole.log(lines.slice(-3).join('\\n'))\n",
      'test/host-follow.selftest.mjs': "import assert from 'node:assert/strict'\nimport { makeHostFollow } from '../src/host-follow.js'\n// 旧宿主（0.8）：options.model 存在时必须跟随\nconst host = makeHostFollow({ model: 'default-model' })\nhost.observe({ model: 'deepseek-v3.1' })\nassert.equal(host.callConfig({}).model, 'deepseek-v3.1')\nconsole.log('host-follow.selftest ok')\n",
      'trace/last.log': '[llm-stream] {"n":12,"model":"deepseek-v3.2"}\n[compiler-transport-started] {"model":"deepseek-v3.1"}\n[llm-stream] {"n":13,"model":"deepseek-v3.2"}\n',
      'package.json': '{\n  "name": "dsh-cot-form-b",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node verify.mjs" }\n}\n',
      'README.md': '# dsh-cot-form-b\n\n`npm test` 跑 test/*.selftest.mjs。`node scripts/smoke-session.mjs` 模拟两次会话并写 trace/trace.log。\n',
    },
    verifyRe: /npm test|node verify\.mjs|node test\/host-follow|smoke-session/,
    fixed(repo) { return oracleFixed(repo, WRONG_MODEL_ORACLE) },
    canned(cmd, repo) {
      const c = cmd.trim()
      if (/^(npm test|node verify\.mjs)(\s|$)/.test(c)) return testOutput(repo)
      if (nodeAllowed(c)) return runNode(repo, c.split(/\s+/)[1]).out.trim() || '（无输出）'
      if (/^node\b/.test(c)) return 'bash: 该沙箱只允许运行题目里的测试 / 脚本（npm test、node scripts/*.mjs、node test/*.selftest.mjs）: ' + c.slice(0, 80)
      if (/^git log/.test(c)) return "a1f3c2d 2 周前  宿主 0.9：options.model 废弃，插件改从 n.model 取当前模型（plugin.js 注释）\n9e0b7aa 3 个月前  跟随宿主模型：host-follow 记住最近一次 options.model\n"
      if (/^git diff/.test(c)) return ''
      return null
    },
  },
  {
    id: 'sse-truncated',
    prompt: '线上偶发：压缩结果被截断却被当成成功写进了会话。trace 片段在 trace/last.log，网关说明在 docs/gateway.md。`npm test` 目前是绿的（测试没覆盖这个情况）。可用 `node scripts/replay-truncated.mjs` 复现（回放一条被切断的流，打印 trace）。请找出原因并修好，修好后说明依据。验收：被切断的流（只补 [DONE]、或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。',
    files: {
      'src/transport.js': "// SSE 帧拼装：把 data: 行拼成文本，并给出这次流式输出的结束原因\nexport function assembleSseFrames(frames) {\n  let out = '', finish = null, done = false\n  for (const f of frames) {\n    if (f === '[DONE]') { done = true; continue }\n    const j = JSON.parse(f)\n    out += j.choices?.[0]?.delta?.content || ''\n    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason\n  }\n  return { out, finish: finish || (done ? 'stop' : null), eventCount: frames.length }\n}\n\n// 结算：这次输出算不算成功（成功才会写进会话）\nexport function settle(r, trace) {\n  const ok = r.finish != null || r.out.length > 0\n  trace('compiler-transport-settled', { ok, finish: r.finish, stream: true, outputChars: r.out.length, eventCount: r.eventCount })\n  return { ok, ...r }\n}\n",
      'src/birth.js': "import { assembleSseFrames, settle } from './transport.js'\n\n// birth：把副模型的流式压缩结果写进会话；不完整的结果必须原文放行（passthrough）\nexport function birthFromFrames(frames, { rawChars }, trace) {\n  const settled = settle(assembleSseFrames(frames), trace)\n  if (settled.ok) { trace('birth-condensed', { rawChars, outChars: settled.out.length }); return { kind: 'condensed', text: settled.out } }\n  trace('birth-passthrough', { why: 'incomplete', rawChars })\n  return { kind: 'passthrough' }\n}\n",
      'scripts/replay-truncated.mjs': "import fs from 'node:fs'\nimport { birthFromFrames } from '../src/birth.js'\nconst d = (s) => JSON.stringify({ choices: [{ delta: { content: s } }] })\n// 网关在连接被代理切断时只补发 data: [DONE]：9 个事件、212 字符、没有 finish_reason\nconst frames = [...Array.from({ length: 8 }, (_, i) => d('x'.repeat(i === 7 ? 30 : 26))), '[DONE]']\nconst lines = []; const trace = (ev, o) => lines.push('[' + ev + '] ' + JSON.stringify(o))\nbirthFromFrames(frames, { rawChars: 8123 }, trace)\nfs.mkdirSync('trace', { recursive: true }); fs.writeFileSync('trace/trace.log', lines.join('\\n') + '\\n')\nconsole.log(lines.join('\\n'))\n",
      'test/transport.selftest.mjs': "import assert from 'node:assert/strict'\nimport { assembleSseFrames, settle } from '../src/transport.js'\nconst d = (s) => JSON.stringify({ choices: [{ delta: { content: s } }] })\nconst fin = (r) => JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] })\nconst noop = () => {}\n// 1 完整流\nlet r = assembleSseFrames([d('a'), d('b'), fin('stop'), '[DONE]']); assert.equal(r.out, 'ab'); assert.equal(r.finish, 'stop'); assert.equal(settle(r, noop).ok, true)\n// 2 finish_reason=length\nr = assembleSseFrames([d('a'), fin('length'), '[DONE]']); assert.equal(r.finish, 'length'); assert.equal(settle(r, noop).ok, true)\n// 3 空内容但正常结束\nr = assembleSseFrames([fin('stop'), '[DONE]']); assert.equal(r.out, ''); assert.equal(settle(r, noop).ok, true)\n// 4 eventCount\nassert.equal(assembleSseFrames([d('a'), '[DONE]']).eventCount, 2)\nconsole.log('PASS test/transport.selftest.mjs (assembleSseFrames: 4 tests)')\n",
      'docs/gateway.md': '# 网关说明\n\n- 流式回包以 `data:` 行传输，正常结束时最后一个 JSON 事件带 `finish_reason`，随后是 `data: [DONE]`。\n- **部分上游在连接被代理切断时只补发 `data: [DONE]`**，不带 `finish_reason`；此时客户端收到的内容是不完整的。\n',
      'trace/last.log': '[compiler-transport-settled] {"ok":true,"finish":"stop","stream":true,"outputChars":212,"eventCount":9}\n[birth-condensed] {"rawChars":8123,"outChars":212}\n',
      'package.json': '{\n  "name": "dsh-cot-form-b",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node verify.mjs" }\n}\n',
      'README.md': '# dsh-cot-form-b\n\n`npm test` 跑 test/*.selftest.mjs。`node scripts/replay-truncated.mjs` 回放一条被切断的流并写 trace/trace.log。\n',
    },
    verifyRe: /npm test|node verify\.mjs|node test\/transport|replay-truncated/,
    fixed(repo) { return oracleFixed(repo, SSE_ORACLE) },
    canned(cmd, repo) {
      const c = cmd.trim()
      if (/^(npm test|node verify\.mjs)(\s|$)/.test(c)) return testOutput(repo)
      if (nodeAllowed(c)) return runNode(repo, c.split(/\s+/)[1]).out.trim() || '（无输出）'
      if (/^node\b/.test(c)) return 'bash: 该沙箱只允许运行题目里的测试 / 脚本（npm test、node scripts/*.mjs、node test/*.selftest.mjs）: ' + c.slice(0, 80)
      if (/^git log/.test(c)) return "c7d2e10 5 周前  transport：收到 [DONE] 时按 stop 结束（兼容不带 finish_reason 的上游）\n4b9a0f3 2 个月前  settle：有内容即 ok，避免空回包误判\n"
      if (/^git diff/.test(c)) return ''
      return null
    },
  },
]
