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
  const r = I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40, stateDedupe: false })
  assert.ok(r.text.includes('[状态] 出错点=src/routes/user.js 的第 42 行 · 约束="不要改测试文件"'), r.text)
  assert.ok(!r.text.includes('原文里没有的值'))
  assert.equal(r.stats.stateDropped, 1)
  // v11.13 去重（缺省开）：出错点的值已在保留的计划句里逐字出现 ⇒ 不再重复；用户原话约束永不去重
  const d = I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40 })
  assert.ok(d.text.includes('[状态] 约束="不要改测试文件"'), d.text)
  assert.ok(!d.text.includes('出错点='))
  assert.equal(d.stats.stateDeduped, 1)
  assert.equal(d.stats.stateKept, 1)
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
  const r = I.assembleExtractive(raw, s, { kind: 'explore', plan: [0], keep: [1, 3], tags: [{ i: 1, s: 'refuted', seq: 7, quote: 'config loaded: ok' }], state: [{ k: 'file', v: 'src/app.js' }], dropped: 0 }, { evidence: ev, tailChars: 40, stateDedupe: false })
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

// ═══ §3r v11.13 r2：死分支折叠 / 失败信号 / 目标长度 / 状态去重 ═════════════════════
const R2 = 'Plan: fix the build. Maybe the cache is stale. Actually I cleared the cache dir. Rebuilt and checked timestamps. Hmm, that is not it, the cache was fine. Wait, the error says missing module foo_bar. I ran npm test and it failed with exit code 1 in test/a.spec.js. Some filler thought about lunch here. Final: add foo_bar to deps and rerun.'
const R2S = I.segmentSentences(R2)
const R2EV = { tools: [{ seq: 5, name: 'bash', text: 'cache ok: 0 stale entries' }], asks: [] }
const r2sel = (branches, extra = {}) => ({ kind: 'explore', plan: [0], keep: [2, 3], tags: [], branches, state: [], dropped: 0, ...extra })
await test('§3r-a 解析 branches：from/to 反了会交换；head 越界取 from；why 早于 head ⇒ null；重叠/未知状态丢弃；最多 6 条', () => {
  const p = I.parseExtractiveOutput(JSON.stringify({ kind: 'explore', keep: [], branches: [
    { from: 4, to: 1, head: 9, why: 0, s: 'abandoned' },
    { from: 3, to: 5, head: 3, s: 'parked' },           // 与上一条重叠 ⇒ 丢
    { from: 6, to: 6, head: 6, s: 'bogus' },             // 未知状态 ⇒ 丢
    { from: '7', to: '7', head: '7', why: '8', s: 'REFUTED', seq: 'seq5', quote: 'x' },
  ] }), 12)
  assert.deepEqual(p.branches.map((b) => [b.from, b.to, b.head, b.why, b.s]), [[1, 4, 1, null, 'abandoned'], [7, 7, 7, 8, 'refuted']])
  assert.equal(p.branches[1].seq, 5)
  assert.equal(p.dropped, 2)
  const many = I.parseExtractiveOutput(JSON.stringify({ kind: 'explore', keep: [], branches: Array.from({ length: 9 }, (_, k) => ({ from: k, to: k, head: k, s: 'parked' })) }), 12)
  assert.equal(many.branches.length, 6)
  assert.deepEqual(I.parseExtractiveOutput('{"kind":"closed","keep":[]}', 3).branches, [])
})
await test('§3r-b abandoned：why 含自我否定 ⇒ head 标 ⟨abandoned⟩，内部删掉（其中的转折句也不强制保留），why 留', () => {
  const r = I.assembleExtractive(R2, R2S, r2sel([{ from: 1, to: 4, head: 1, why: 4, s: 'abandoned', seq: null, quote: '' }]), { evidence: R2EV, tailChars: 40 })
  assert.ok(r.text.includes('Maybe the cache is stale.⟨abandoned⟩'), r.text)
  assert.ok(r.text.includes('that is not it'))
  assert.ok(!r.text.includes('Actually I cleared'), '折叠区里的转折句不再被强制保留')
  assert.ok(!r.text.includes('Rebuilt and checked'))
  assert.equal(r.stats.branchesFolded, 1)
  assert.equal(r.stats.foldedSentences, 2)
  assert.ok(r.text.includes('Wait, the error says'), '支线外的转折句照常强制保留')
})
await test('§3r-c refuted：证据逐字命中 ⇒ ⟨refuted·seqN⟩；证据对不上但 why 合格 ⇒ 降为 abandoned；都不合格 ⇒ 不折叠', () => {
  const ok = I.assembleExtractive(R2, R2S, r2sel([{ from: 1, to: 4, head: 1, why: 4, s: 'refuted', seq: 5, quote: '0 stale entries' }]), { evidence: R2EV, tailChars: 40 })
  assert.ok(ok.text.includes('Maybe the cache is stale.⟨refuted·seq5⟩'), ok.text)
  const down = I.assembleExtractive(R2, R2S, r2sel([{ from: 1, to: 4, head: 1, why: 4, s: 'refuted', seq: 5, quote: '编造的证据' }]), { evidence: R2EV, tailChars: 40 })
  assert.ok(down.text.includes('⟨abandoned⟩') && !down.text.includes('⟨refuted'), down.text)
  const bad = I.assembleExtractive(R2, R2S, r2sel([{ from: 1, to: 3, head: 1, why: 3, s: 'abandoned', seq: null, quote: '' }]), { evidence: R2EV, tailChars: 40 })
  assert.equal(bad.stats.branchesRejected, 1)
  assert.equal(bad.stats.branchesFolded, 0)
  assert.ok(bad.text.includes('Actually I cleared'), '不折叠 = r1 行为')
  assert.ok(!bad.text.includes('⟨abandoned⟩'))
})
await test('§3r-d parked 只加 ⟨parked⟩ 不删；fold:false / exec / 尾巴里的支线一律不折叠；支线内被证实的句子与计划句不折叠', () => {
  const pk = I.assembleExtractive(R2, R2S, r2sel([{ from: 1, to: 3, head: 1, why: null, s: 'parked', seq: null, quote: '' }]), { evidence: R2EV, tailChars: 40 })
  assert.ok(pk.text.includes('stale.⟨parked⟩') && pk.text.includes('Actually I cleared'), pk.text)
  assert.equal(pk.stats.branchesParked, 1)
  const br = [{ from: 0, to: 4, head: 1, why: 4, s: 'abandoned', seq: null, quote: '' }]
  const off = I.assembleExtractive(R2, R2S, r2sel(br), { evidence: R2EV, tailChars: 40, fold: false })
  assert.ok(!off.text.includes('⟨abandoned⟩') && off.text.includes('Actually I cleared'))
  const ex = I.assembleExtractive(R2, R2S, r2sel(br, { kind: 'exec' }), { evidence: R2EV, tailChars: 40 })
  assert.equal(ex.stats.branchesFolded, 0)
  const tail = I.assembleExtractive(R2, R2S, r2sel([{ from: 8, to: 8, head: 8, why: null, s: 'parked', seq: null, quote: '' }]), { evidence: R2EV, tailChars: 40 })
  assert.equal(tail.stats.branchesRejected, 1)
  const v = I.assembleExtractive(R2, R2S, r2sel(br, { tags: [{ i: 3, s: 'verified', seq: 5, quote: 'cache ok' }] }), { evidence: R2EV, tailChars: 40 })
  assert.ok(v.text.startsWith('Plan: fix the build.'), '计划句在支线范围内也不折叠：' + v.text)
  assert.ok(v.text.includes('Rebuilt and checked timestamps.⟨verified·seq5⟩'), '被证实的正知识不折叠')
  assert.ok(!v.text.includes('Actually I cleared'))
})
await test('§3r-e 标识符只出现在折叠区 ⇒ 仍补回（foldRepaired 计数）；why 落在后一条支线里也不会被删', () => {
  const raw = R2.replace('Rebuilt and checked timestamps.', 'Rebuilt with scripts/build.sh and checked timestamps.')
  const s = I.segmentSentences(raw)
  const r = I.assembleExtractive(raw, s, r2sel([{ from: 1, to: 4, head: 1, why: 4, s: 'abandoned', seq: null, quote: '' }]), { evidence: R2EV, tailChars: 40 })
  assert.ok(r.text.includes('scripts/build.sh'), r.text)
  assert.equal(r.stats.foldRepaired, 1)
  const two = I.assembleExtractive(R2, R2S, r2sel([
    { from: 1, to: 2, head: 1, why: 4, s: 'abandoned', seq: null, quote: '' },
    { from: 3, to: 5, head: 5, why: 5, s: 'refuted', seq: 5, quote: 'cache ok' },
  ]), { evidence: R2EV, tailChars: 40 })
  assert.ok(two.text.includes('that is not it'), two.text)
})
await test('§3r-f 失败信号：含报错且指向具体对象的句子补回（keepFailures:false 不补）；空泛的「错误」不算；RAW 的「返回 500」不算', () => {
  const sel = { kind: 'closed', plan: [], keep: [], tags: [], state: [], dropped: 0 }
  const r = I.assembleExtractive(R2, R2S, sel, { evidence: R2EV, tailChars: 40, repairMax: 0 })
  assert.ok(r.text.includes('failed with exit code 1'), r.text)
  assert.equal(r.stats.failuresKept, 1)
  const off = I.assembleExtractive(R2, R2S, sel, { evidence: R2EV, tailChars: 40, repairMax: 0, keepFailures: false })
  assert.ok(!off.text.includes('failed with exit code 1'))
  const vague = '先想一下。这个思路是错误的。' + '后面是很长的正常推理'.repeat(8) + '。最后改好了。'
  assert.equal(I.assembleExtractive(vague, I.segmentSentences(vague), sel, { tailChars: 10, repairMax: 0 }).stats.failuresKept, 0)
  assert.equal(I.assembleExtractive(RAW, S, SEL, { evidence: EV, tailChars: 40 }).stats.failuresKept, 0)
})
await test('§3r-g 目标长度：提示词按 kind 给上限（可关）；branches 字段随 fold 开关；stats 带 target / overTarget', () => {
  const on = I.buildExtractivePrompt(R2S, { tailFrom: 8 })
  assert.ok(on.includes('closed ≈25%') && on.includes('exec ≈30%') && on.includes('explore ≈50%'))
  assert.ok(on.includes('"branches"') && on.includes('abandoned'))
  const off = I.buildExtractivePrompt(R2S, { tailFrom: 8, fold: false, kindTargets: false })
  assert.ok(!off.includes('"branches"') && !off.includes('closed ≈25%'))
  assert.deepEqual({ ...I.EXTRACTIVE_KIND_TARGETS }, { closed: 0.25, exec: 0.3, explore: 0.5 })
  const r = I.assembleExtractive(R2, R2S, { kind: 'closed', plan: [], keep: [], tags: [], state: [], dropped: 0 }, { evidence: R2EV, tailChars: 40 })
  assert.equal(r.stats.target, 0.25)
  assert.equal(typeof r.stats.overTarget, 'boolean')
  const prep = I.prepareExtractive(R2, { extractiveTailChars: 40, extractiveFoldBranches: false, extractiveKindTargets: false }, R2EV)
  assert.ok(!prep.prompt.includes('"branches"') && !prep.prompt.includes('长度上限'))
})
await test('§3r-h finalize 把 r2 开关传到拼装；DEFAULTS 四个开关缺省为 true 且是已知键', () => {
  const prep = I.prepareExtractive(R2, { extractiveTailChars: 40 }, R2EV)
  const out = JSON.stringify(r2sel([{ from: 1, to: 4, head: 1, why: 4, s: 'abandoned' }]))
  const a = I.finalizeExtractive(R2, prep, out, { extractiveTailChars: 40, extractiveMaxKeepRatio: 1 }, R2EV)
  assert.equal(a.stats.branchesFolded, 1)
  const b = I.finalizeExtractive(R2, prep, out, { extractiveTailChars: 40, extractiveMaxKeepRatio: 1, extractiveFoldBranches: false }, R2EV)
  assert.equal(b.stats.branchesFolded, 0)
  for (const k of ['extractiveFoldBranches', 'extractiveKeepFailures', 'extractiveKindTargets', 'extractiveStateDedupe']) assert.equal(DEFAULTS[k], true, k)
  const c = normalizeConfig({ extractiveFoldBranches: false })
  assert.equal(c.extractiveFoldBranches, false)
})

// ═══ §4 配置与版本号 ════════════════════════════════════════════════════════════
await test('§4a 缺省 compressPrompt 仍是 v2（x1 默认关）；新键已登记、不进 unknownOptions', () => {
  assert.equal(DEFAULTS.compressPrompt, 'v2')
  const want = { extractiveTailChars: 400, extractiveMaxKeepRatio: 0.7, extractiveRepairMax: 6, extractiveEvidence: true, extractiveEvidenceLimit: 12, extractiveHandleLine: true, extractiveGuideline: '' }
  for (const [k, v] of Object.entries(want)) assert.equal(DEFAULTS[k], v, k)
  const c = normalizeConfig({ compressPrompt: 'x1', extractiveTailChars: 300, extractiveGuideline: 'g' })
  assert.deepEqual(c.unknownOptions, [])
})
await test('§4b promptVersion：x1 ⇒ compress-x1r2；关掉的 r2 特性带后缀；准则非空带 8 位指纹；不追加 :sys', () => {
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1' }), 'compress-x1r2')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1', compressSystemPrompt: true }), 'compress-x1r2')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1', extractiveFoldBranches: false, extractiveStateDedupe: false }), 'compress-x1r2:-fold:-dedupe')
  assert.equal(I.compressPromptVersion({ compressPrompt: 'x1', extractiveKeepFailures: false, extractiveKindTargets: false }), 'compress-x1r2:-fail:-tgt')
  const a = I.compressPromptVersion({ compressPrompt: 'x1', extractiveGuideline: '规则 A' })
  const b = I.compressPromptVersion({ compressPrompt: 'x1', extractiveGuideline: '规则 B' })
  assert.match(a, /^compress-x1r2:g[0-9a-f]{8}$/)
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
  assert.equal(r.meta.promptVersion, 'compress-x1r2')
  assert.equal(r.meta.extractive.tagsVerified, 1)
  assert.equal(r.meta.selectionChars, reply.length)
  assert.equal(headers, 1)
  assert.ok(traces.some(([t]) => t === 'extractive-assembled'))
})
await test('§5b x1：选择不可解析 ⇒ 抛错（带传输 meta）+ extractive-rejected trace', async () => {
  reply = '我觉得第 3 句很重要'
  const traces = []
  await assert.rejects(makeBirthCompiler(base)(RAW, undefined, { trace: (t, d) => traces.push([t, d]) }),
    (e) => e.code === 'extractive-unparseable' && e.meta && e.meta.promptVersion === 'compress-x1r2')
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

await test('§7f v11.13 loop / recheck：原样重发失败过的调用 = loop，重发成功过的 = recheck；参数键序不同也算同一调用', () => {
  const prior = CF.priorCalls(FX.messages)
  assert.equal(prior.length, 3)
  const again = call('bash', { command: "sqlite3 app.db 'SELECT count(*) FROM users WHERE id=42'" })
  const s = CF.scoreSample(FX.expect, again, prior)
  assert.equal(s.recheck, true); assert.equal(s.loop, false)
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test","cwd":"."}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'npm ERR! Test failed.\nexit code 1' },
  ]
  const p2 = CF.priorCalls(msgs)
  assert.equal(p2[0].isError, true)
  const l = CF.scoreSample({}, call('bash', { cwd: '.', command: 'npm test' }), p2)
  assert.equal(l.loop, true); assert.equal(l.recheck, false)
  assert.equal(CF.scoreSample({}, call('bash', { command: 'npm run build' }), p2).loop, false)
  assert.equal(CF.scoreSample({}, call('bash', { command: 'npm test' }), undefined).loop, false, '没有前缀 ⇒ 不判重发')
})
await test('§7g toolResultIsError：显式 is_error 优先；行首报错 / 非零退出 / ENOENT 算失败；正文里偶然出现 error 一词不算', () => {
  assert.equal(CF.toolResultIsError({ content: 'Traceback (most recent call last):\n  ...' }), true)
  assert.equal(CF.toolResultIsError({ content: 'ls: cannot access x: No such file or directory' }), true)
  assert.equal(CF.toolResultIsError({ content: 'Process exited with code 2' }), true)
  assert.equal(CF.toolResultIsError({ content: 'const error = null  // handles the error case' }), false)
  assert.equal(CF.toolResultIsError({ content: 'Error: boom', is_error: false }), false)
  assert.equal(CF.toolResultIsError({ content: 'ok', isError: true }), true)
  assert.equal(CF.evidenceFromMessages([{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'bash' } }] }, { role: 'tool', tool_call_id: 'x', content: 'fatal: not a git repository' }], 2).tools[0].isError, true)
})
await test('§7h 配对 bootstrap：固定种子可复现；区间包含均值；n<2 不给区间；runEval 汇总带 loop/recheck 与 deltaVsRaw', async () => {
  const a = [1, 1, 0, 1, 0, 1, 1, 0], b = [1, 0, 0, 1, 0, 0, 1, 0]
  const x = CF.pairedBootstrap(a, b, { B: 500, seed: 7 }), y = CF.pairedBootstrap(a, b, { B: 500, seed: 7 })
  assert.deepEqual(x, y)
  assert.equal(x.n, 8); assert.equal(x.mean, -0.25)
  assert.ok(x.lo <= x.mean && x.mean <= x.hi && x.lo < 0)
  assert.deepEqual(CF.pairedBootstrap([1], [0]), { n: 1, mean: -1, lo: null, hi: null })
  assert.equal(CF.pairedBootstrap([null], [1]), null)
  const opts = { ...CF.parseArgs(['--samples', '2', '--tail-chars', '120', '--max-keep-ratio', '0.95', '--seed', '3', '--bootstrap', '300']), model: 'm', guideline: '' }
  assert.equal(opts.seed, 3); assert.equal(opts.bootstrap, 300)
  const FX2 = { ...FX, id: 'example-await-2' }
  const rep = await CF.runEval(opts, { chat: mockChat, compressor: mockCompressor, fixtures: [FX, FX2], cache: new Map() })
  assert.equal(rep.summary.raw.recheckRate, 0)
  assert.equal(rep.summary.x1.recheckRate, 1, '丢了否定理由 ⇒ 原样重发旧查询')
  assert.equal(rep.summary.x1.loopRate, 0)
  assert.equal(rep.summary.raw.deltaVsRaw, undefined)
  assert.deepEqual(rep.summary.x1.deltaVsRaw.success, { n: 2, mean: -1, lo: -1, hi: -1 })
  assert.deepEqual(rep.summary.x1.deltaVsRaw.recheck, { n: 2, mean: 1, lo: 1, hi: 1 })
  const lines = []
  CF.printSummary(rep.summary, (l) => lines.push(l))
  assert.ok(lines[0].includes('loopRate') && lines.some((l) => l.startsWith('Δ vs raw · x1')))
})
await test('§7i 消融变体 x1:nofold+nodedupe：解析成配置开关、提示词随之变化、缓存键分开；未知修饰符报错', async () => {
  assert.deepEqual(CF.parseVariant('x1:nofold+nodedupe'), { base: 'x1', cfg: { extractiveFoldBranches: false, extractiveStateDedupe: false } })
  assert.deepEqual(CF.parseVariant('raw'), { base: 'raw', cfg: {} })
  assert.throws(() => CF.parseVariant('x1:nofoo'), /unknown variant modifier/)
  assert.throws(() => CF.parseVariant('v3:nofold'), /unknown variant modifier/)
  const prompts = []
  const comp = async (body) => { prompts.push(body.messages[0].content); return mockCompressor(body) }
  const opts = { ...CF.parseArgs(['--samples', '1', '--variants', 'x1,x1:nofold+notargets', '--tail-chars', '120', '--max-keep-ratio', '0.95']), model: 'm', guideline: '' }
  const cache = new Map()
  const rep = await CF.runEval(opts, { chat: mockChat, compressor: comp, fixtures: [FX], cache })
  assert.ok(rep.summary['x1:nofold+notargets'])
  assert.equal(prompts.length, 2)
  assert.ok(prompts[0].includes('"branches"') && prompts[0].includes('长度上限'))
  assert.ok(!prompts[1].includes('"branches"') && !prompts[1].includes('长度上限'))
  assert.notEqual(CF.cacheKey('f', 'x1', opts), CF.cacheKey('f', 'x1:nofold', opts))
  assert.equal(CF.cacheKey('f', 'x1:nofold', { ...opts, guideline: 'g' }).split('|')[2], 'g', '修饰变体同样按准则分键')
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

// ═══ §9 v11.13 句柄回取观测（P5）与 trace 汇总 ══════════════════════════════════
const H1 = 'art://' + 'A'.repeat(22), H2 = 'art://' + 'b_-'.repeat(7) + 'c'
await test('§9a artRefsOf：数 reasoning 里的句柄、含句柄的工具调用、真正被回取的句柄；只数不记内容', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '看看 ' + H2 }] },   // user 里的句柄不算
    { role: 'assistant', content: [{ type: 'reasoning', text: '〔原文 ' + H1 + '〕摘要…' }, { type: 'tool-call', toolName: 'cot_read', input: { handle: H1, from: 1 } }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '又见 ' + H1 + ' 与 ' + H2 }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'z', function: { name: 'read', arguments: JSON.stringify({ h: H2 }) } }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'x', input: { q: 'no handle' } }] },
  ]
  assert.deepEqual(I.artRefsOf(msgs), { handles: 2, handleLines: 2, toolCalls: 2, retrieved: 2 })
  assert.deepEqual(I.artRefsOf([]), { handles: 0, handleLines: 0, toolCalls: 0, retrieved: 0 })
  assert.deepEqual(I.artRefsOf(null), { handles: 0, handleLines: 0, toolCalls: 0, retrieved: 0 })
  assert.equal(I.artRefsOf([{ role: 'assistant', content: [{ type: 'reasoning', text: 'art://short' }] }]).handles, 0, '不是 22 位句柄不算')
})
await test('§9b analyze-trace：extractive 按 promptVersion 分桶（回落率 / 超目标率 / r2 计数）；handleRetrieval 取最大值', async () => {
  const { createTraceAudit } = await import('../tools/analyze-trace.mjs')
  const a = createTraceAudit()
  const ln = (tag, o) => a.add('[2026-09-26T00:00:00.000Z] [' + tag + '] ' + JSON.stringify(o))
  ln('BOOT', { selfId: 's' })
  ln('extractive-assembled', { promptVersion: 'compress-x1r2', kind: 'explore', ratio: 0.4, overTarget: false, branchesFolded: 1, foldedSentences: 3, failuresKept: 1, stateDeduped: 2 })
  ln('extractive-assembled', { promptVersion: 'compress-x1r2', kind: 'closed', ratio: 0.3, overTarget: true, branchesFolded: 0 })
  ln('extractive-rejected', { promptVersion: 'compress-x1r2', code: 'extractive-too-long' })
  ln('extractive-assembled', { promptVersion: 'compress-x1r2:-fold', kind: 'explore', ratio: 0.5 })
  ln('llm-stream', { n: 1, artRefs: { handles: 1, handleLines: 1, toolCalls: 0, retrieved: 0 } })
  ln('llm-stream', { n: 2, artRefs: { handles: 4, handleLines: 3, toolCalls: 1, retrieved: 1 } })
  ln('llm-stream', { n: 3 })
  const g = a.result().groups[0]
  const r2 = g.extractive['compress-x1r2']
  assert.equal(r2.assembled, 2); assert.equal(r2.rejected['extractive-too-long'], 1)
  assert.equal(r2.fallbackRate, 0.333); assert.equal(r2.overTargetRate, 0.5)
  assert.equal(r2.branchesFolded, 1); assert.equal(r2.foldedSentences, 3); assert.equal(r2.stateDeduped, 2)
  assert.deepEqual({ ...r2.byKind }, { explore: 1, closed: 1 })
  assert.equal(g.extractive['compress-x1r2:-fold'].assembled, 1)
  assert.equal(g.handleRetrieval.records, 2)
  assert.equal(g.handleRetrieval.handlesMax, 4); assert.equal(g.handleRetrieval.retrievalRate, 0.25)
  assert.equal(g.x1, undefined); assert.equal(g.art, undefined)
  const empty = createTraceAudit(); empty.add('[2026-09-26T00:00:00.000Z] [BOOT] {}')
  assert.equal(empty.result().groups[0].extractive, null); assert.equal(empty.result().groups[0].handleRetrieval, null)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
