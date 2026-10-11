// test/effect-eval.selftest.mjs —— tools/effect-eval.mjs 的纯函数自测（不联网）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as E from '../tools/effect-eval.mjs'
import { TASKS } from '../tools/v4-live.mjs'
import { recompile } from '../tools/compile-direct.mjs'
import { DEFAULTS as DEFAULTS_ } from '../index.js'
// 本套件的渲染断言针对行式层（S5 层 A 旧体裁，compressV4Prose:false 仍支持）；散文体见 §5n
DEFAULTS_.compressV4Prose = false

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)) } }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const specs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/effect-specs.json'), 'utf8'))

;(async () => {
  await test('§1 specs：每条都对应 v4-live 的内置任务；正则可编译；参考答案本身命中 next、不触 avoid', () => {
    assert.ok(specs.length >= 5)
    for (const s of specs) {
      assert.ok(TASKS.some((t) => t.id === (s.base || s.id)), s.id)   // v12.8.1：反驳题用 base 指向内置任务
      if (s.base) assert.ok(/~refute$/.test(s.id) && s.why, '反驳题命名 ~refute 且写明为什么：' + s.id)
      for (const p of [...s.next, ...s.avoid]) new RegExp(p, 'i')
      assert.deepEqual(E.ruleScore(s, s.reference.correct), { next: 1, avoid: 1 }, s.id)
      assert.ok(s.followup && s.reference.keyFacts.length && s.reference.deadEnds.length)
    }
  })
  await test('§2 buildVariants：raw/empty 恒有；报告行只取 condensed*；name:mode 形态改名', () => {
    const rec = [{ id: 'eacces-config', events: [{ k: 'r', s: '思考A' }, { k: 'r', s: '思考B' }, { k: 'c', s: '回答' }] }]
    const rows = [{ id: 'eacces-config', mode: 'v4', why: 'condensed', text: '压缩后' }, { id: 'eacces-config', mode: 'v3', why: 'distill-timeout', text: '思考A思考B' }]
    const t = E.buildVariants(rec, [{ name: 'v4r:v4', rows }, { name: 'v3', rows }], specs)
    assert.equal(t['eacces-config'].content, '回答')
    assert.deepEqual(t['eacces-config'].variants, { raw: '思考A思考B', empty: '', v4r: '压缩后' })
  })
  await test('§3 buildMessages：assistant 带 reasoning_content、无 tool_calls；最后一条 user = followup + 追问', () => {
    const m = E.buildMessages({ user: 'U' }, 'C', 'R', 'F')
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(m[2].reasoning_content, 'R'); assert.ok(!('tool_calls' in m[2]))
    assert.equal(m[3].content, 'F' + E.ASK)
  })
  await test('§4 sawReasoning：claude 形 usage 一律作废；prompt_tokens 不足「无思考基线 + 0.3×字数」作废；empty 只看通道', () => {
    const ok = { prompt_tokens: 5430 }, claude = { prompt_tokens: 5430, claude_cache_creation_5_m_tokens: 0 }
    assert.equal(E.sawReasoning(ok, 'raw', 10074, 1310), true)
    assert.equal(E.sawReasoning({ prompt_tokens: 812 }, 'raw', 10074, 1310), false)
    assert.equal(E.sawReasoning(claude, 'raw', 10074, 1310), false)
    assert.equal(E.sawReasoning({ prompt_tokens: 1310 }, 'empty', 0, undefined), true)
    assert.equal(E.sawReasoning(claude, 'empty', 0, undefined), false)
    assert.equal(E.sawReasoning({ prompt_tokens: 900 }, 'v4', 500, undefined), false, '缺基线和可信指纹 ⇒ unknown，不冒充有效')
    assert.equal(E.sawReasoning({ prompt_tokens: 900 }, 'v4', 500, undefined, 'fp_dspure_app_v1'), true)
  })
  await test('§5 responseText 合并正文与 tool_calls；parseJudge 容忍前后杂字、坏 JSON 返回 null', () => {
    const t = E.responseText({ content: '判断', tool_calls: [{ function: { name: 'edit_file', arguments: '{"path":"a"}' } }] })
    assert.equal(t, '判断\n[tool_call edit_file] {"path":"a"}')
    assert.deepEqual(E.parseJudge('好的 {"overall":7,"deadEnd":false} 完'), { overall: 7, deadEnd: false })
    assert.equal(E.parseJudge('{"overall":7,'), null)
  })
  await test('§5b 截断的盲评 JSON 逐字段捞回；actScore：edit_file ⇒ 直接改，再命中 next ⇒ 改对', () => {
    assert.deepEqual(E.parseJudge('{"correct":9,"deadEnd":false,"facts":9,"focus":9,"overall":9,"note":"正确定位到'), { correct: 9, facts: 9, focus: 9, overall: 9, deadEnd: false, note: '(截断)' })
    const s = specs.find((x) => x.id === 'perf-regression')
    assert.deepEqual(E.actScore(s, '[tool_call edit_file] {"old_text":"compressTargetMax: 1800","new_text":"compressTargetMax: 450"}'), { edit: 1, editRight: 1 })
    assert.deepEqual(E.actScore(s, '[tool_call edit_file] {"old_text":"maxOutputTokens: 4096"}'), { edit: 1, editRight: 0 })
    assert.deepEqual(E.actScore(s, '[tool_call read_file] {"path":"src/config.js"}'), { edit: 0, editRight: 0 })
  })
  await test('§6 summarize：按变体汇总、与 raw 同任务配对差；错误行单列', () => {
    const r = (task, variant, overall) => ({ task, variant, sample: 0, judge: { overall, correct: overall, facts: 5, focus: 5, deadEnd: false }, rule: { next: 1, avoid: 1 }, reasoningChars: 100, ctxReasoningChars: 10, usage: { prompt_tokens: 1000 } })
    const { markdown, byVar } = E.summarize([r('a', 'raw', 4), r('a', 'v4', 7), r('b', 'raw', 6), r('b', 'v4', 5), { task: 'b', variant: 'v4', sample: 1, error: 'x' }], ['raw', 'empty', 'v4'])
    assert.equal(byVar.raw.overall, 5); assert.equal(byVar.v4.overall, 6)
    assert.ok(markdown.includes('v4：Δ均值 1.0（2 个任务：+3.0 -1.0）'), markdown)
    assert.ok(markdown.includes('错误 1 条'))
  })
  await test('§7 compile-direct --recompile：用捕获的副模型输出零调用重编译；无 side 的行原样保留', async () => {
    const raw = '先看日志，测试用的 DSH_HOME 不对。\n若 grep 显示 verify.mjs 没有设置，则根因明确。\n' + '填充句子。'.repeat(300)
    const recs = [{ id: 't1', events: [{ k: 'r', s: raw }] }]
    const side = JSON.stringify({ ops: [{ id: 'o1', k: 'COMPUTED', ev: 'derived', text: '测试绕过了临时 DSH_HOME', anchor: '先看日志' }] })
    const rows = await recompile({ rows: [{ id: 't1', mode: 'v4', side, text: '旧' }, { id: 't1', mode: 'v3', text: 'v3 稿' }] }, recs)
    assert.equal(rows[0].why, 'condensed'); assert.ok(rows[0].recompiled && rows[0].text.includes('我目前判断：测试绕过了临时 DSH_HOME'))
    assert.ok(rows[0].text.includes('若 grep 显示 verify.mjs 没有设置，则根因明确'), '保底判读句')
    assert.deepEqual(rows[1], { id: 't1', mode: 'v3', text: 'v3 稿' })
  })
  await test('§8 effect-pairs：动作类别（edit / reread-known / probe / none）与成对归因报告（零调用）', async () => {
    const P = await import('../tools/effect-pairs.mjs')
    const task = TASKS.find((t) => t.id === 'flaky-timeout').user
    assert.ok(P.seenFiles(task).has('test/hedge.selftest.mjs') && P.seenFiles(task).has('src/distill.js'), [...P.seenFiles(task)].join(','))
    assert.equal(P.classifyAction(task, '[tool_call edit_file] {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}'), 'edit')
    assert.equal(P.classifyAction(task, '[tool_call read_file] {"path":"test/hedge.selftest.mjs"}'), 'reread-known', '再读任务里已给过内容的文件 = 回头 read')
    assert.equal(P.classifyAction(task, '[tool_call bash] {"command":"sed -n \'200,245p\' src/distill.js"}'), 'reread-known')
    assert.equal(P.classifyAction(task, '[tool_call bash] {"command":"taskset -c 0,1 node test/hedge.selftest.mjs"}'), 'probe', '跑测试是新取证，不是回头 read')
    assert.equal(P.classifyAction(task, '[tool_call read_file] {"path":"src/other.js"}'), 'probe')
    assert.equal(P.classifyAction(task, '只有判断没有调用'), 'none')
    const rows = [
      { task: 'flaky-timeout', variant: 'raw', sample: 0, judge: { overall: 9, note: 'ok' }, response: '[tool_call edit_file] {"path":"test/hedge.selftest.mjs"}' },
      { task: 'flaky-timeout', variant: 'raw', sample: 1, judge: { overall: 2, note: 'x' }, response: '[tool_call read_file] {"path":"src/distill.js"}' },
      { task: 'flaky-timeout', variant: 'oX', sample: 0, judge: { overall: 2, note: '回头' }, response: '[tool_call read_file] {"path":"test/hedge.selftest.mjs"}' },
    ]
    const md = P.pairsReport(rows, { drafts: { oX: { 'flaky-timeout': '前文。所以下一步工具调用是 bash 复现。如果失败复现，那么再修。' } } })
    assert.ok(md.includes('- **oX** Δ=-3.5') && md.includes('压坏 1 例') && md.includes('oX 稿收尾：所以下一步工具调用是 bash 复现'), md)
    assert.ok(md.includes('| oX | 1 | 0% | 100% | 0% | 0% |'), '动作类别分布表')
  })
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exit(fail ? 1 : 0)
})()
