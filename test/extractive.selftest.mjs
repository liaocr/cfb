#!/usr/bin/env node
// v11.12 抽取式压缩（compress-x1）+ 反事实续写评测 + ACON/GEPA 回路 的回归钉子：
//   §1 切句（逐字切片 / 围栏代码整体 / 中英文）         §2 解析（越界、围栏、垃圾 ⇒ null）
//   §3 拼装硬校验（顺序、证实降级、状态逐字、转折必留、标识符修复、尾巴逐字、英文标签）
//   §4 配置与版本号（缺省零影响、准则指纹）              §5 makeBirthCompiler x1（真实本机 HTTP）
//   §6 birthStart/birthFinish 端到端（证据冻结、句柄行只在已验证句柄后出现）
//   §7 tools/cf-eval.mjs（判分、对比对、think-tag）       §8 tools/acon-optimize.mjs（换代、Pareto）
// 全部本机执行，零外网、零 API 调用。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { normalizeConfig, DEFAULTS } from '../src/config.js'
import { makeBirthCompiler } from '../src/distill.js'
import * as CF from '../tools/cf-eval.mjs'
import * as AO from '../tools/acon-optimize.mjs'

let pass = 0, fail = 0
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e.stack || e)) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-extractive-'))

const RAW = [
  '用户说 /api/users 返回 500。',
  '我先看 src/routes/user.js 的第 42 行。',
  '这里 const u = db.find(id) 没有 await，所以 u 是 Promise。',
  '等等，db.find 真的是异步的吗？',
  '刚才 grep 显示 find 返回 Promise。',
  '那么 u.name 就是 undefined。',
  '可能也是数据库本身没有数据。',
  '不过刚才的查询结果显示有 3 条记录，所以不是这个原因。',
  '计算一下：3 条记录乘以每条 2 个字段等于 6 个值，这个不重要。',
  '另外顺手看了一下日志格式' + ' 和这个问题没有关系'.repeat(30) + ' 日志一切正常也没有别的告警。',
  '结论：在 db.find 前加 await 即可。',
  '下一步修改 user.js 第 42 行，然后跑 npm test 验证。',
].join('')
const EV = { tools: [{ seq: 41, name: 'bash', text: 'src/db.js:17: export async function find(id) { return rows }', isError: false, exitCode: 0 },
  { seq: 38, name: 'sql', text: 'count = 3 rows', isError: false, exitCode: 0 }], asks: [{ seq: 30, text: '不要改测试文件' }] }

// ═══ §1 切句 ═══════════════════════════════════════════════════════════════════
await test('§1a 中文切句：每片都是原文逐字切片，拼回无损', () => {
  const s = I.segmentSentences(RAW)
  assert.equal(s.length, 12)
  for (const x of s) assert.equal(RAW.slice(x.start, x.end), x.text)
  assert.equal(s.map((x) => x.text).join(''), RAW)
})
await test('§1b 围栏代码块整体算一句；英文按 ". " 切；超长句按逗号软切', () => {
  const raw = 'First check the file. Then run it!\n```js\nconst a = 1. b = 2\nfoo()\n```\nDone? ' + 'x, '.repeat(120) + 'end.'
  const s = I.segmentSentences(raw)
  assert.equal(s[0].text, 'First check the file.')
  assert.equal(s[1].text, 'Then run it!')
  assert.ok(s[2].text.startsWith('```js') && s[2].text.endsWith('```'), s[2].text)
  assert.equal(s[3].text, 'Done?')
  assert.ok(s.length > 5, '超长句必须被软切')
  for (const x of s) assert.equal(raw.slice(x.start, x.end), x.text)
})
await test('§1c 空/空白输入 ⇒ 空数组', () => {
  assert.deepEqual(I.segmentSentences(''), [])
  assert.deepEqual(I.segmentSentences('  \n\n '), [])
  assert.deepEqual(I.segmentSentences(null), [])
})

// ═══ §2 解析 ═══════════════════════════════════════════════════════════════════
await test('§2a 越界/重复/非整数编号丢弃；按原文顺序排序；plan 最多 2 个', () => {
  const sel = I.parseExtractiveOutput('```json\n{"kind":"explore","plan":[3,1,0],"keep":[5,2,2,99,-1,"4",1.5],"tags":[],"state":[]}\n```', 10)
  assert.deepEqual(sel.keep, [2, 4, 5])
  assert.deepEqual(sel.plan, [0, 1])
  assert.equal(sel.dropped, 3)
})
await test('§2b 前后有杂文也能取出 JSON；字符串里的括号不干扰', () => {
  const sel = I.parseExtractiveOutput('好的：{"kind":"closed","keep":[1],"tags":[{"i":1,"s":"verified","seq":"seq41","quote":"a } b"}],"state":[["文件","x.js"]]} 以上', 3)
  assert.equal(sel.kind, 'closed')
  assert.equal(sel.tags[0].seq, 41)
  assert.equal(sel.tags[0].quote, 'a } b')
  assert.deepEqual(sel.state, [{ k: '文件', v: 'x.js' }])
})
await test('§2c 不可解析 / 非对象 ⇒ null；未知 kind ⇒ explore；非法标签丢弃', () => {
  assert.equal(I.parseExtractiveOutput('不是 JSON', 5), null)
  assert.equal(I.parseExtractiveOutput('[1,2]', 5), null)
  const sel = I.parseExtractiveOutput('{"kind":"weird","keep":[],"tags":[{"i":9,"s":"verified"},{"i":1,"s":"sure"},{"i":1,"s":"unverified"},{"i":1,"s":"refuted"}]}', 5)
  assert.equal(sel.kind, 'explore')
  assert.equal(sel.tags.length, 1)
  assert.equal(sel.tags[0].s, 'unverified')
})

// ═══ §3 拼装硬校验 ═════════════════════════════════════════════════════════════
const S = I.segmentSentences(RAW)
const SEL = { kind: 'explore', plan: [1], keep: [2, 5, 6, 7, 10], tags: [
  { i: 4, s: 'verified', seq: 41, quote: 'export async function find' },
  { i: 7, s: 'refuted', seq: 38, quote: 'count = 3 rows' },
  { i: 6, s: 'verified', seq: 99, quote: '不存在的证据' },
  { i: 10, s: 'refuted', seq: 38, quote: '对不上的引用' },
], state: [{ k: '出错点', v: 'src/routes/user.js 的第 42 行' }, { k: '约束', v: '不要改测试文件' }, { k: '编造', v: '原文里没有的值' }], dropped: 0 }
await test('§3a 输出全部是原文句子、按原文顺序；尾巴逐字；丢掉的句子不出现', () => {
  const r = I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40 })
  let last = -1
  for (const x of S) {
    const at = r.text.indexOf(x.text)
    if (at < 0) continue
    assert.ok(at > last, '顺序必须与原文一致：' + x.text); last = at
  }
  assert.ok(!r.text.includes('计算一下'), '被覆盖的中间计算应删掉')
  assert.ok(!r.text.includes('日志格式'), '无关句应删掉')
  assert.ok(r.text.endsWith('下一步修改 user.js 第 42 行，然后跑 npm test 验证。'), '尾巴逐字')
  assert.equal(r.stats.tailSentences, 1)
})
await test('§3b 证实标签：引用逐字命中才给；对不上 ⇒ verified 降级为未验证、refuted 去标签', () => {
  const r = I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40 })
  assert.ok(r.text.includes('刚才 grep 显示 find 返回 Promise。⟨证实·seq41⟩'), r.text)
  assert.ok(r.text.includes('所以不是这个原因。⟨已否定·seq38⟩'))
  assert.ok(r.text.includes('可能也是数据库本身没有数据。⟨未验证⟩'))
  assert.ok(r.text.includes('结论：在 db.find 前加 await 即可。') && !r.text.includes('即可。⟨已否定'))
  assert.equal(r.stats.tagsVerified, 1); assert.equal(r.stats.tagsRefuted, 1); assert.equal(r.stats.tagsDowngraded, 2)
})
await test('§3b2 极短工具输出允许整段引用；短引用不是整段 ⇒ 不算', () => {
  const ev = { tools: [{ seq: 5, text: '1' }, { seq: 6, text: 'rows: 1' }], asks: [] }
  const r = I.assembleExtractive(RAW, S, { ...SEL, tags: [{ i: 7, s: 'refuted', seq: 5, quote: '1' }, { i: 6, s: 'verified', seq: 6, quote: '1' }] }, { evidence: ev, tailChars: 40 })
  assert.ok(r.text.includes('所以不是这个原因。⟨已否定·seq5⟩'), r.text)
  assert.ok(r.text.includes('可能也是数据库本身没有数据。⟨未验证⟩'))
})
await test('§3c 没有证据 ⇒ 任何「证实/否定」都拿不到（只允许降级）', () => {
  const r = I.assembleExtractive(RAW, S, SEL, { evidence: null, tailChars: 40 })
  assert.ok(!/证实·|已否定·/.test(r.text), r.text)
  assert.equal(r.stats.tagsVerified + r.stats.tagsRefuted, 0)
})
await test('§3d 状态：值须逐字出现在原文/用户输入；用户约束加引号；编造的丢弃', () => {
  const r = I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40 })
  assert.ok(r.text.includes('[状态] 出错点=src/routes/user.js 的第 42 行 · 约束="不要改测试文件"'), r.text)
  assert.ok(!r.text.includes('原文里没有的值'))
  assert.equal(r.stats.stateDropped, 1)
})
await test('§3e 转折句强制保留（explore）；exec 只留状态 + 尾巴', () => {
  const r = I.assembleExtractive(RAW, S, { ...SEL, keep: [], tags: [], plan: [] }, { evidence: EV, tailChars: 40 })
  assert.ok(r.text.includes('等等，db.find 真的是异步的吗？'))
  assert.ok(r.text.includes('不过刚才的查询结果显示有 3 条记录'))
  assert.ok(r.stats.forced >= 2)
  const e = I.assembleExtractive(RAW, S, { ...SEL, kind: 'exec', tags: [] }, { evidence: EV, tailChars: 40, repairMax: 0 })
  assert.ok(!e.text.includes('等等'), e.text)
  assert.ok(e.text.includes('[状态]') && e.text.endsWith('npm test 验证。'))
})
await test('§3f 逐字标识符缺失 ⇒ 补回含它的句子（受 repairMax 限制）', () => {
  const sel = { kind: 'closed', plan: [], keep: [], tags: [], state: [], dropped: 0 }
  const r = I.assembleExtractive(RAW, S, sel, { evidence: EV, tailChars: 40, repairMax: 6 })
  assert.ok(r.text.includes('/api/users'), '路径必须补回')
  assert.ok(r.text.includes('src/routes/user.js'))
  assert.ok(r.stats.repaired >= 2)
  const r0 = I.assembleExtractive(RAW, S, sel, { evidence: EV, tailChars: 40, repairMax: 0 })
  assert.equal(r0.stats.repaired, 0)
})
await test('§3g 断开处以「… 」起行；尾巴与正文空一行', () => {
  const r = I.assembleExtractive(RAW, S, { kind: 'closed', plan: [], keep: [1, 10], tags: [], state: [], dropped: 0 }, { tailChars: 40, repairMax: 0 })
  assert.equal(r.text, '… 我先看 src/routes/user.js 的第 42 行。\n… 结论：在 db.find 前加 await 即可。\n\n下一步修改 user.js 第 42 行，然后跑 npm test 验证。')
})
await test('§3h 英文原文 ⇒ 英文标签与 [state]；句柄行跟随语言', () => {
  const raw = 'Plan: read src/app.js first. The crash might be a null config. But the log shows config loaded fine. So the bug is in parseArgs. Next I will edit src/app.js line 10.'
  const s = I.segmentSentences(raw)
  const ev = { tools: [{ seq: 7, name: 'bash', text: 'config loaded: ok' }], asks: [] }
  const r = I.assembleExtractive(raw, s, { kind: 'explore', plan: [0], keep: [1, 3], tags: [{ i: 1, s: 'refuted', seq: 7, quote: 'config loaded: ok' }], state: [{ k: 'file', v: 'src/app.js' }], dropped: 0 }, { evidence: ev, tailChars: 40 })
  assert.ok(r.text.includes('⟨refuted·seq7⟩'), r.text)
  assert.ok(r.text.includes('[state] file=src/app.js'))
  assert.match(I.extractiveHandleLine('art://h', raw), /^\[full text art:\/\/h/)
  assert.match(I.extractiveHandleLine('art://h', RAW), /^〔原文 art:\/\/h/)
})
await test('§3i finalize：不可解析 / 空 / 超比例 ⇒ 带 code 抛错（调用方原文放行）', () => {
  const prep = I.prepareExtractive(RAW, { extractiveTailChars: 40 }, EV)
  assert.throws(() => I.finalizeExtractive(RAW, prep, 'garbage', {}, EV), (e) => e.code === 'extractive-unparseable')
  const all = JSON.stringify({ kind: 'explore', keep: S.map((x) => x.i), tags: [], state: [] })
  assert.throws(() => I.finalizeExtractive(RAW, prep, all, { extractiveTailChars: 40, extractiveMaxKeepRatio: 0.7 }, EV), (e) => e.code === 'extractive-too-long')
  const ok = I.finalizeExtractive(RAW, prep, JSON.stringify(SEL), { extractiveTailChars: 40, extractiveMaxKeepRatio: 0.95 }, EV)
  assert.ok(ok.text.length < RAW.length)
})
await test('§3j 提示词：编号句子、证据索引（每条 ≤160 字符）、准则追加、尾巴起点', () => {
  const long = { tools: [{ seq: 5, name: 'bash', text: 'y'.repeat(5000), exitCode: 1 }], asks: [{ seq: 2, text: '只改 src' }] }
  const p = I.prepareExtractive(RAW, { extractiveTailChars: 40, extractiveGuideline: '否定理由必须留。' }, long)
  assert.ok(p.prompt.includes('[0] 用户说 /api/users 返回 500。'))
  assert.ok(p.prompt.includes('seq5 bash exit=1：' + 'y'.repeat(160) + '\n'))
  assert.ok(!p.prompt.includes('y'.repeat(161)), '证据正文不得整段进提示词（7.5x 放大教训）')
  assert.ok(p.prompt.includes('补充准则') && p.prompt.includes('否定理由必须留。'))
  assert.ok(p.prompt.includes('第 ' + p.tailFrom + ' 句及之后会被逐字保留'))
})
await test('§3k extractiveEvidence：按 toolCallId 关联工具名；只取 human 用户输入；限条数', () => {
  const events = [
    { type: 'assistant/message', seq: 1, toolCalls: [{ id: 'a', name: 'bash' }] },
    { type: 'tool/result', seq: 2, toolCallId: 'a', text: 'ok', exitCode: 0 },
    { type: 'user/message', seq: 3, text: '<cot-ledger>x', source: 'generated-memory' },
    { type: 'user/message', seq: 4, text: '不要动配置', source: 'human' },
    { type: 'tool/result', seq: 5, toolCallId: 'zz', text: 'late', isError: true },
  ]
  const ev = I.extractiveEvidence(events, { limit: 1 })
  assert.deepEqual(ev.tools, [{ seq: 5, name: null, text: 'late', isError: true, exitCode: null }])
  assert.deepEqual(ev.asks, [{ seq: 4, text: '不要动配置' }])
  assert.equal(I.extractiveEvidence(events).tools[0].name, 'bash')
})

// ═══ §4 配置与版本号 ════════════════════════════════════════════════════════════
await test('§4a 缺省 compressPrompt 仍是 v2（x1 默认关）；新键已登记、不进 unknownOptions', () => {
  assert.equal(DEFAULTS.compressPrompt, 'v2')
  const want = { extractiveTailChars: 400, extractiveMaxKeepRatio: 0.7, extractiveRepairMax: 6, extractiveEvidence: true, extractiveEvidenceLimit: 12, extractiveHandleLine: true, extractiveGuideline: '' }
  for (const [k, v] of Object.entries(want)) assert.equal(DEFAULTS[k], v, k)
  const c = normalizeConfig({ compressPrompt: 'x1', extractiveTailChars: 300, extractiveGuideline: 'g' })
  assert.deepEqual(c.unknownOptions, [])
})
await test('§4b promptVersion：x1 ⇒ compress-x1；准则非空带 8 位指纹；不追加 :sys', () => {
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1' }), 'compress-x1')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1', compressSystemPrompt: true }), 'compress-x1')
  const a = I.compressPromptVersion({ compressPrompt: 'x1', extractiveGuideline: '规则 A' })
  const b = I.compressPromptVersion({ compressPrompt: 'x1', extractiveGuideline: '规则 B' })
  assert.match(a, /^compress-x1:g[0-9a-f]{8}$/)
  assert.notEqual(a, b)
  assert.equal(I.compressPromptVersion({}), 'compress-v2', '其它版本号不受影响')
})

// ═══ §5 makeBirthCompiler x1（真实本机 HTTP）════════════════════════════════════
let reply = JSON.stringify(SEL)
let lastBody = null
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c })
  req.on('end', () => {
    lastBody = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const keyFile = path.join(tmp, 'keys'); fs.writeFileSync(keyFile, 'LOCAL: unused')
const base = normalizeConfig({ model: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port, credentialsPath: keyFile, credentialRef: 'LOCAL',
  followHostModel: false, followHostProvider: false, keepAlive: false, disableThinking: false, dryRun: false,
  stateCompress: true, compressPrompt: 'x1', extractiveTailChars: 40, extractiveMaxKeepRatio: 0.95 })
await test('§5a x1：提示词是编号句子；返回本地拼装稿；meta 带 extractive 统计与 promptVersion', async () => {
  reply = JSON.stringify(SEL)
  const traces = []
  let headers = 0
  const r = await makeBirthCompiler(base)(RAW, undefined, { extractiveEvidence: EV, onHeaders: () => headers++, trace: (t, d) => traces.push([t, d]) })
  assert.ok(lastBody.messages[0].content.includes('【编号思维链】'))
  assert.ok(r.text.includes('⟨证实·seq41⟩'))
  assert.equal(r.meta.promptVersion, 'compress-x1')
  assert.equal(r.meta.extractive.tagsVerified, 1)
  assert.equal(r.meta.selectionChars, reply.length)
  assert.equal(headers, 1)
  assert.ok(traces.some(([t]) => t === 'extractive-assembled'))
})
await test('§5b x1：选择不可解析 ⇒ 抛错（带传输 meta）+ extractive-rejected trace', async () => {
  reply = '我觉得第 3 句很重要'
  const traces = []
  await assert.rejects(makeBirthCompiler(base)(RAW, undefined, { trace: (t, d) => traces.push([t, d]) }),
    (e) => e.code === 'extractive-unparseable' && e.meta && e.meta.promptVersion === 'compress-x1')
  assert.ok(traces.some(([t, d]) => t === 'extractive-rejected' && d.code === 'extractive-unparseable'))
})

// ═══ §6 birth 端到端 ═══════════════════════════════════════════════════════════
function birthDeps(extra = {}) {
  const seen = { budget: null, collected: 0, traces: [] }
  const cfg = { ...base, birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 3000, birthMinSavedChars: 20, birthDeferredClaim: false, birthTokenGate: false, ...extra.cfg }
  const compile = makeBirthCompiler(cfg)
  const deps = {
    cfg, trace: (t, d) => seen.traces.push([t, d]), archive: async () => 'art://x1-handle', sessionId: () => 's-x1',
    collectEvidence: () => { seen.collected++; return { events: [
      { type: 'assistant/message', seq: 40, toolCalls: [{ id: 'g', name: 'bash' }] },
      { type: 'tool/result', seq: 41, toolCallId: 'g', text: EV.tools[0].text, exitCode: 0 },
      { type: 'tool/result', seq: 38, toolCallId: 'q', text: 'count = 3 rows', exitCode: 0 },
    ] } },
    distill: async (input, sig, budget) => { seen.budget = budget; return compile(input, sig, budget) },
    ...extra.deps,
  }
  return { deps, seen }
}
const end = (raw) => ({ index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } })
await test('§6a 证据在 block-end 冻结并传给编译器；成品首行是已验证句柄；证实标签成立', async () => {
  reply = JSON.stringify(SEL)
  const { deps, seen } = birthDeps()
  const r = await I.birthFinish(I.birthStart(end(RAW), deps), deps)
  assert.equal(r.why, 'condensed', r.why)
  assert.equal(seen.collected, 1)
  assert.equal(seen.budget.extractiveEvidence.tools.length, 2)
  assert.ok(r.text.startsWith('〔原文 art://x1-handle · 删去的句子可按句柄取回〕\n'), r.text)
  assert.ok(r.text.includes('⟨证实·seq41⟩'))
  assert.equal(r.outChars, r.text.length, '句柄行计入净省核算')
})
await test('§6b 流归属不可证 ⇒ 不采集证据、标签全部降级；extractiveHandleLine:false ⇒ 无句柄行', async () => {
  reply = JSON.stringify(SEL)
  const { deps, seen } = birthDeps({ deps: { sessionAmbiguous: true }, cfg: { extractiveHandleLine: false } })
  const r = await I.birthFinish(I.birthStart(end(RAW), deps), deps)
  assert.equal(r.why, 'condensed', r.why)
  assert.equal(seen.collected, 0)
  assert.equal(seen.budget.extractiveEvidence, null)
  assert.ok(!r.text.includes('art://'))
  assert.ok(!/证实·|已否定·/.test(r.text))
})
await test('§6c 拼装失败 ⇒ 原文放行（distill-failed），绝不写半成品', async () => {
  reply = 'not json'
  const { deps } = birthDeps()
  const r = await I.birthFinish(I.birthStart(end(RAW), deps), deps)
  assert.equal(r.text, RAW)
  assert.match(r.why, /distill-failed/)
})
await test('§6d 非 x1 的 compress 不采集证据（v11.9 纪律不变）', async () => {
  reply = '摘要'
  const { deps, seen } = birthDeps({ cfg: { compressPrompt: 'v3' } })
  await I.birthFinish(I.birthStart(end(RAW), deps), deps)
  assert.equal(seen.collected, 0)
  assert.equal(seen.budget.extractiveEvidence, null)
})
server.closeAllConnections(); await new Promise((r) => server.close(r))

// ═══ §7 cf-eval ════════════════════════════════════════════════════════════════
const FX = JSON.parse(fs.readFileSync(new URL('../tools/cf-fixtures/example-await.json', import.meta.url), 'utf8'))
const call = (name, args) => ({ tool_calls: [{ id: 't', type: 'function', function: { name, arguments: JSON.stringify(args) } }], content: '' })
// 假主模型：历史推理里还能看到「改签名的风险太大」（放弃另一方案的理由）⇒ 直接修；看不到 ⇒ 回头重查（重走旧路）
const mockChat = async (body) => {
  const hist = body.messages.map((m) => String(m.reasoning_content || '') + String(m.content || '')).join('\n')
  const m = hist.includes('改签名的风险太大') ? call('edit_file', { path: 'src/routes/user.js', old_text: 'db.find(id)', new_text: 'await db.find(id)' })
    : call('bash', { command: "sqlite3 app.db 'SELECT count(*) FROM users WHERE id=42'" })
  return { message: { ...m, reasoning_content: 'r'.repeat(hist.length % 50) }, usage: { prompt_tokens: Math.round(hist.length / 2), completion_tokens: 30 } }
}
// 假压缩器：v3 写一句丢了否定理由的摘要；x1 按准则决定留不留第 9 句（放弃方案的理由；它不含转折词，不会被强制保留）
const mockCompressor = async (body) => {
  const p = body.messages[0].content
  if (p.includes('【上一轮思维链】')) return { message: { content: '已定位：db.find 缺少 await，需修改 src/routes/user.js。' } }
  const keep = [0, 5, 6, 8]
  if (p.includes('否定理由必须留')) keep.push(9)
  return { message: { content: JSON.stringify({ kind: 'explore', plan: [0], keep, tags: [], state: [] }) } }
}
await test('§7a scoreSample：next/avoid/violate 与 text 正则', () => {
  const e = FX.expect
  assert.deepEqual(CF.scoreSample(e, call('edit_file', { path: 'src/routes/user.js', new_text: 'await x' })).success, true)
  const s = CF.scoreSample(e, call('bash', { command: 'SELECT count(*)' }))
  assert.equal(s.avoid, true); assert.equal(s.success, false)
  assert.equal(CF.scoreSample(e, call('edit_file', { path: 'test/user.test.js', new_text: 'await' })).violate, true)
  assert.equal(CF.scoreSample({ next: [{ text: 'await' }] }, { content: '加 AWAIT 即可' }).success, true)
  assert.equal(CF.scoreSample({}, { content: '' }).success, true, '没有期望 ⇒ 只看 avoid/violate')
})
await test('§7b runEval：raw 成功、v3/x1 丢否定理由 ⇒ 重走旧路；汇总与对比对正确', async () => {
  const opts = { ...CF.parseArgs(['--samples', '2', '--tail-chars', '120', '--max-keep-ratio', '0.95']), model: 'm', guideline: '' }
  const cache = new Map()
  const rep = await CF.runEval(opts, { chat: mockChat, compressor: mockCompressor, fixtures: [FX], cache })
  assert.equal(rep.summary.raw.successRate, 1)
  assert.equal(rep.summary.v3.successRate, 0)
  assert.equal(rep.summary.x1.successRate, 0)
  assert.equal(rep.summary.x1.avoidRate, 1)
  assert.ok(rep.summary.x1.promptTokens < rep.summary.raw.promptTokens, '压缩后上下文更小')
  assert.equal(rep.summary.x1.compressedBlocks, 1)
  const pairs = CF.contrastivePairs(rep, 'x1', [FX], cache, opts)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].gap, 1)
  assert.ok(pairs[0].blocks[0].raw.includes('改签名的风险太大') && !pairs[0].blocks[0].text.includes('改签名的风险太大'))
})
await test('§7c x1 在 cf-eval 里拼装失败 ⇒ 与线上一致回落原文并计 fallback', async () => {
  const opts = { ...CF.parseArgs(['--samples', '1', '--variants', 'x1']), model: 'm' }
  const rep = await CF.runEval(opts, { chat: mockChat, compressor: async () => ({ message: { content: 'nope' } }), fixtures: [FX] })
  assert.equal(rep.summary.x1.compressFallbacks, 1)
  assert.equal(rep.summary.x1.successRate, 1, '回落原文 ⇒ 续写与 raw 同')
})
await test('§7d evidenceFromMessages 只取时间截面之前；think-tag 回传形状', () => {
  const ev = CF.evidenceFromMessages(FX.messages, 8)
  assert.deepEqual(ev.tools.map((t) => t.name), ['read_file', 'bash', 'bash'])
  assert.equal(ev.tools[2].text, '17:export async function find(id) {')
  assert.equal(CF.evidenceFromMessages(FX.messages, 4).tools.length, 1)
  const shaped = CF.shapeReasoning(FX.messages, 'think-tag')
  assert.ok(shaped[8].content.startsWith('<think>\n') && !('reasoning_content' in shaped[8]))
  assert.equal(CF.shapeReasoning(FX.messages), FX.messages)
  assert.throws(() => CF.shapeReasoning(FX.messages, 'bogus'))
})
await test('§7e 未知参数直接报错（不静默吞掉拼错的旗标）', () => {
  assert.throws(() => CF.parseArgs(['--sample', '3']), /unknown argument/)
})

// ═══ §8 acon-optimize ══════════════════════════════════════════════════════════
await test('§8a UT 步：对比失败喂给优化器 ⇒ 新准则修复失败 ⇒ 换代；history/front 可用', async () => {
  const prompts = []
  const optimizer = async (body) => { prompts.push(body.messages[0].content); return { message: { content: '```\n否定理由必须留：被工具结果否定的假设连同否定理由一起保留。\n```' } } }
  const opts = { ...AO.parseArgs(['--samples', '1', '--iterations', '2', '--candidates', '1', '--tail-chars', '120', '--max-keep-ratio', '0.95']), model: 'm' }
  const logs = []
  const r = await AO.optimize(opts, { chat: mockChat, compressor: mockCompressor, optimizer, fixtures: [FX] }, (x) => logs.push(x))
  assert.ok(prompts[0].includes('失败案例') && prompts[0].includes('改签名的风险太大'), '第一代是 UT 步：优化器必须看到原文与压缩稿')
  assert.ok(prompts[1].includes('不损失成功率'), '修好之后第二代转入 CO 步（求更短）')
  assert.equal(r.best.successRate, 1)
  assert.equal(r.best.gen, 1)
  assert.match(r.best.guideline, /^否定理由必须留/)
  assert.ok(r.history.length >= 2)
  assert.ok(r.front.length >= 1)
  assert.ok(logs.some((l) => /换代/.test(l)))
})
await test('§8b 无失败 ⇒ CO 步（求更短）；候选更差 ⇒ 保持现任', async () => {
  const chatAlwaysOk = async () => ({ message: call('edit_file', { path: 'src/routes/user.js', new_text: 'await' }), usage: null })
  let step = ''
  const optimizer = async (body) => { step = body.messages[0].content.includes('不损失成功率') ? 'co' : 'ut'; return { message: { content: '什么都保留。' } } }
  const comp = async (body) => {
    const p = body.messages[0].content
    const n = (p.match(/\n\[\d+\] /g) || []).length
    const keep = p.includes('什么都保留') ? Array.from({ length: n }, (_, i) => i) : [0]
    return { message: { content: JSON.stringify({ kind: 'explore', keep, tags: [], state: [] }) } }
  }
  const opts = { ...AO.parseArgs(['--samples', '1', '--iterations', '1', '--candidates', '1']), model: 'm' }
  const r = await AO.optimize(opts, { chat: chatAlwaysOk, compressor: comp, optimizer, fixtures: [FX] }, () => {})
  assert.equal(step, 'co')
  assert.equal(r.best.gen, 0, '更长且不更准的候选不得换代')
})
await test('§8c paretoFront / cleanGuideline / scoreOf', () => {
  const a = { successRate: 0.9, keptRatio: 0.5 }, b = { successRate: 0.8, keptRatio: 0.6 }, c = { successRate: 1, keptRatio: 0.7 }
  assert.deepEqual(AO.paretoFront([a, b, c]), [a, c])
  assert.equal(AO.cleanGuideline('```text\n a \n\n b \n```', 100), 'a\nb')
  assert.equal(AO.cleanGuideline('第一条\n第二条很长很长', 5), '第一条')
  assert.equal(AO.scoreOf(a, 0.3), 0.9 - 0.15)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
