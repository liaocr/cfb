#!/usr/bin/env node
// test/universal-select.selftest.mjs —— src/universal-select.js 的独立自测。
//
// 背景：该模块自 v14.26 起以「原型」身份躺在 src/ 里，但**零 import、零测试、不在 verify.mjs**
//   ⇒ 长期是死代码：没人知道它到底能不能用，也没人敢用。
// 本套件把它从「死代码」转成「可信资源」：只验证它**自己的契约**——
//   抽取式（输出必须是原文子串，可审计）、原序输出、确定性、锚点优先、预算约束、边界。
// ⚠ 明确边界：**它未被生产接线**。compileV5Local 不调用它；本套件通过 ≠ 生产在用。
//   要接线必须另走「替换 selectOpsV5」的独立评审。
import assert from 'node:assert/strict'
import { splitDiscourseUnits } from '../src/compile-v5-local.js'
import { compressUniversal, selectUniversalUnits, renderUniversalUnits } from '../src/universal-select.js'

let pass = 0
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + name) }

const RAW = [
  '先看 src/birth.js 的 birthStart，它在 block-end 时同步起火。',
  '等等，不对，我需要重新看一遍 archive 的调用路径。',
  "检查 deps.archive 是否为函数：typeof archive !== 'function' 时直接 dropSeg('no-store')。",
  '我试过把 birthMinChars 改成 100，结果 archive-failed 变成了 52 次。',
  '再看 config.js 的 dryRun，默认 true，意味着合闸前零调用。',
  '刚才那条路走不通，因为 fidelity.js 的 inventedIdentifiers 会拦下发明标识符。',
  '结论：根因是 DSH_HOME 路径错配，不是 compressTargetMax 太小。',
  '验证：node verify.mjs 应该报 42/42 套件通过。',
].join('\n')
// ★ 切分口径必须与模块内部一致：compressUniversal 用的是 splitDiscourseUnits，不是按 \n。
const UNITS = splitDiscourseUnits(RAW)

ok('压缩非空且不超预算', () => {
  const r = compressUniversal(RAW, { charBudget: 200 })
  assert.ok(r.text.length > 0)
  assert.ok(r.chars <= 200, 'charBudget 是硬上限')
  assert.ok(r.chars < RAW.length, '必须真的压小了')
})

ok('关键锚点在预算内被优先保留', () => {
  const r = compressUniversal(RAW, { charBudget: 200 })
  for (const k of ['birthStart', 'dryRun', 'DSH_HOME']) {
    assert.ok(r.text.includes(k), '锚点 ' + k + ' 必须被选中')
  }
})

ok('抽取式：输出逐字来自原文（可审计，无改写）', () => {
  const r = compressUniversal(RAW, { charBudget: 200 })
  for (const i of r.indices) {
    assert.ok(UNITS[i] !== undefined, 'indices 必须落在切分单元范围内')
    assert.ok(RAW.includes(UNITS[i].trim()), '单元 ' + i + ' 必须逐字在原文中')
  }
  for (const line of r.text.split('\n')) assert.ok(RAW.includes(line), '输出行必须逐字在原文中：' + line.slice(0, 40))
})

ok('原序输出（indices 升序 ⇒ 可读性，不重排原文）', () => {
  const r = compressUniversal(RAW, { charBudget: 200 })
  assert.deepEqual(r.indices, [...r.indices].sort((a, b) => a - b))
})

ok('确定性：同输入同参数 ⇒ 逐字节相同输出', () => {
  const a = compressUniversal(RAW, { charBudget: 200 })
  const b = compressUniversal(RAW, { charBudget: 200 })
  assert.equal(a.text, b.text)
  assert.deepEqual(a.indices, b.indices)
})

ok('预算放大 ⇒ 选中规模单调不减（集合级贪心的基本性质）', () => {
  const small = compressUniversal(RAW, { charBudget: 150 })
  const big = compressUniversal(RAW, { charBudget: 400 })
  assert.ok(big.indices.length >= small.indices.length)
  assert.ok(big.chars >= small.chars)
})

ok('边界：空文本 / 纯空白 / 单行', () => {
  assert.equal(compressUniversal('').text, '')
  assert.equal(compressUniversal('   \n\n  ').text, '')
  assert.equal(compressUniversal('只有一句话。').text, '只有一句话。')
})

ok('render + select 组合等价于 compressUniversal（同一切分口径）', () => {
  const sel = selectUniversalUnits(UNITS, { charBudget: 200 })
  assert.equal(renderUniversalUnits(UNITS, sel.indices), compressUniversal(RAW, { charBudget: 200 }).text)
})

ok('纯函数：不修改入参数组', () => {
  const units = [...UNITS]
  const before = JSON.stringify(units)
  selectUniversalUnits(units, { charBudget: 200 })
  assert.equal(JSON.stringify(units), before)
})

console.log('universal-select: 抽取式通用选择器的契约（原序/确定性/锚点优先/预算/边界）全部通过')
console.log('PASS=' + pass + ' FAIL=0')
