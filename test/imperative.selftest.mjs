/**
 * imperative.js 单测。纯函数，零依赖，零网络。
 * 运行：node test/imperative.selftest.mjs
 */
import { findImperatives, verdictOf, IMPERATIVE_RULES, REWRITE_WITHHELD } from '../src/imperative.js'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }
const eq = (name, a, b) => ok(name + '  [' + JSON.stringify(a) + ']', JSON.stringify(a) === JSON.stringify(b))

console.log('— 1. 真机现场样本（session seq 4722，退化轮前那条 ledger 的原文骨架）—')
const REAL = [
  '【已定决策】',
  '1. 责任认定：两次崩溃属实。',
  '【❌已否决·禁止采纳】',
  '1. 禁止 re-add summary。',
  '2. 禁止跑 rescue-clean。',
  '3. 禁止再动代码。',
  '【已证伪·勿重试】',
  '不再做任何修复动作。',
].join('\n')
const r1 = findImperatives(REAL)
ok('★ 真机样本被判为 imperative', verdictOf(REAL).verdict === 'imperative')
ok('★ 命中数 > 0（实测 ' + r1.count + ' 处，ids=' + JSON.stringify(r1.ids) + '）', r1.count > 0)
ok('★ 命中含 prohibit（禁止）', r1.ids.includes('prohibit'))
ok('★ 命中含 negimp（不再做）', r1.ids.includes('negimp'))

console.log('— 2. 栏头本身就是祈使句（这是最容易漏的一处）—')
const r2 = findImperatives('【❌已否决·禁止采纳】')
ok('★ 仅栏头 "【❌已否决·禁止采纳】" 即被判 imperative', verdictOf('【❌已否决·禁止采纳】').verdict === 'imperative')
eq('  栏头命中 ids', r2.ids, ['prohibit'])
ok('★ "【已证伪·勿重试】" 亦是祈使（勿重试）', verdictOf('【已证伪·勿重试】').verdict === 'imperative')
ok('  "【已定决策】" 本身是陈述式（不触发）', verdictOf('【已定决策】').verdict === 'clean')

console.log('— 3. 消毒后的陈述式应当 clean —')
const CLEAN = [
  '[state_snapshot] 归档决策：',
  '1. 已归档：两次崩溃属实，责任经 2026-09-17 复盘确认。',
  '[historical_falsified] 分支：',
  '1. re-add summary —— 2026-09-17 评估：投影引擎在 assertCurrentSurfaceSpan 抛错，会话锁死。',
  '2. rescue-clean —— 2026-09-17 评估：会话仍存活，该动作被判定为破坏性。',
  '[state_snapshot] 代码修改阶段已于 2026-09-17T07:36:59Z 结束。',
].join('\n')
eq('★ 陈述式样本 clean，count = 0', verdictOf(CLEAN).count, 0)
ok('★ 陈述式样本 verdict = clean', verdictOf(CLEAN).verdict === 'clean')

console.log('— 4. 红队正则反例（钉死：正则改写会发明事实 / 反转语义）—')
const RT = [
  { re: /不再做/g, rep: '已完成', input: '不再做任何修复动作。', want: '已完成任何修复动作。' },
  { re: /不要(.{0,20})/g, rep: '[historical_falsified] $1 已废弃', input: '不要删除会话文件。', want: '[historical_falsified] 删除会话文件。 已废弃' },
]
for (const t of RT) {
  const got = t.input.replace(t.re, t.rep)
  eq('  红队规则在输入 ' + JSON.stringify(t.input) + ' 上产出（如实记录）', got, t.want)
}
ok('★ 反例1 证明语义反转："不再做 X" 被写成 "已完成 X"', '不再做任何修复动作。'.replace(/不再做/g, '已完成') === '已完成任何修复动作。')
ok('★ 反例2 证明发明事实："不要删除会话文件" 变成 "删除会话文件 已废弃"',
  '不要删除会话文件。'.replace(/不要(.{0,20})/g, '[historical_falsified] $1 已废弃').indexOf('删除会话文件') > 0)

console.log('— 5. 纯裁判性质：绝不改一个字 —')
const mutated = REAL
findImperatives(REAL)
ok('★ findImperatives 不修改输入（字符串不可变 + 无副作用回写）', mutated === REAL && REAL.includes('禁止再动代码'))
ok('★ 本模块不导出任何改写函数', typeof (await import('../src/imperative.js')).sanitize === 'undefined' && typeof (await import('../src/imperative.js')).rewrite === 'undefined')
ok('★ 显式声明了"改写权不回授"', typeof REWRITE_WITHHELD === 'string' && REWRITE_WITHHELD.length > 0)

console.log('— 6. 边界与健壮性 —')
eq('  空串 → 0', verdictOf('').count, 0)
eq('  undefined → 0', verdictOf(undefined).count, 0)
eq('  null → 0', verdictOf(null).count, 0)
eq('  非字符串数字 → 0', verdictOf(12345).count, 0)
const big = ('普通陈述。\n'.repeat(20000)) + '禁止再动代码'
ok('  大文本（' + big.length + ' 字符）不挂且命中 1', verdictOf(big).count === 1)
ok('  命中上限兜底 <= 500', findImperatives('禁止'.repeat(2000)).count <= 500)
ok('  规则表非空且每条都有 id/src/note', IMPERATIVE_RULES.length > 0 && IMPERATIVE_RULES.every(r => r.id && r.src && r.note))
let compiles = true
try { for (const r of IMPERATIVE_RULES) new RegExp(r.src, 'g') } catch { compiles = false }
ok('  全部规则可编译', compiles)

console.log('')
console.log(fail === 0 ? ('全部通过：' + pass + ' 通过 / 0 失败') : ('有失败：' + pass + ' 通过 / ' + fail + ' 失败'))
process.exit(fail === 0 ? 0 : 1)
