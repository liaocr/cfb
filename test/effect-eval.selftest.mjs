// test/effect-eval.selftest.mjs —— tools/effect-eval.mjs 的纯函数自测（不联网）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as E from '../tools/effect-eval.mjs'
import { TASKS } from '../tools/v4-live.mjs'

let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)) } }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const specs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/effect-specs.json'), 'utf8'))

;(async () => {
  await test('§1 specs：每条都对应 v4-live 的内置任务；正则可编译；参考答案本身命中 next、不触 avoid', () => {
    assert.ok(specs.length >= 5)
    for (const s of specs) {
      assert.ok(TASKS.some((t) => t.id === s.id), s.id)
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
    assert.equal(E.sawReasoning({ prompt_tokens: 900 }, 'v4', 500, undefined), true, '还没有基线 ⇒ 只看通道')
  })
  await test('§5 responseText 合并正文与 tool_calls；parseJudge 容忍前后杂字、坏 JSON 返回 null', () => {
    const t = E.responseText({ content: '判断', tool_calls: [{ function: { name: 'edit_file', arguments: '{"path":"a"}' } }] })
    assert.equal(t, '判断\n[tool_call edit_file] {"path":"a"}')
    assert.deepEqual(E.parseJudge('好的 {"overall":7,"deadEnd":false} 完'), { overall: 7, deadEnd: false })
    assert.equal(E.parseJudge('{"overall":7,'), null)
  })
  await test('§6 summarize：按变体汇总、与 raw 同任务配对差；错误行单列', () => {
    const r = (task, variant, overall) => ({ task, variant, sample: 0, judge: { overall, correct: overall, facts: 5, focus: 5, deadEnd: false }, rule: { next: 1, avoid: 1 }, reasoningChars: 100, ctxReasoningChars: 10, usage: { prompt_tokens: 1000 } })
    const { markdown, byVar } = E.summarize([r('a', 'raw', 4), r('a', 'v4', 7), r('b', 'raw', 6), r('b', 'v4', 5), { task: 'b', variant: 'v4', sample: 1, error: 'x' }], ['raw', 'empty', 'v4'])
    assert.equal(byVar.raw.overall, 5); assert.equal(byVar.v4.overall, 6)
    assert.ok(markdown.includes('v4：Δ均值 1.0（2 个任务：+3.0 -1.0）'), markdown)
    assert.ok(markdown.includes('错误 1 条'))
  })
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exit(fail ? 1 : 0)
})()
