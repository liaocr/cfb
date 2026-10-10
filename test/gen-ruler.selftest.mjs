#!/usr/bin/env node
// test/gen-ruler.selftest.mjs —— 生成式尺子 v1 + 机械负例生成器 的回归测试
//
// 守住四件被证明会退化的事（每一条都对应开发过程中真实踩过的坑）：
//   1. 尺子必须是**确定性**的 —— 旧版 ACTION_RX 带 /g 却用 .test()，lastIndex 有状态，
//      同一个输入隔次返回不同结论。这种 bug 不会让测试变红，只会让结论变成噪声。
//   2. PATH_RX 不得匹配出 ".selftest.mjs" 这种断尾（首字符是裸点）。
//   3. camelCase / snake_case 标识符必须进锚点集合 —— 否则 hedgeStartedAt 这类
//      真正的承重件永远看不见，sse-truncated 那条真回归就量不出来。
//   4. 硬门只抓「凭空」，不抓「引用保真」；照抄稿必须被 G6 拦死。
import assert from 'node:assert/strict'
import { judge, anchorsOf, causePairs, copyCoverage, locusOf, quotedFragments } from '../tools/gen-ruler.mjs'
import { makeNegatives, auditRuler } from '../tools/gen-negatives.mjs'

let checks = 0
const ok = (label, fn) => { fn(); checks++ }

const RAW = [
  'Now the analysis.',
  'The failure is the assertion in test/hedge.selftest.mjs: expected hedgeStartedAt=null, got 1712.',
  'The timer callback checks primarySettled, but the response has not been processed yet, so the hedge fires.',
  'The minimal correct fix: in test/hedge.selftest.mjs, use settledAt instead of primarySettled.',
  'Wait, but should we also harden src/distill.js?',
  'The acceptance command is node verify.mjs and we can not change CI cores without sudo.',
].join(' ')
const CTX = 'CI 里 test/hedge.selftest.mjs 报 FAIL §4 expected hedgeStartedAt=null, got 1712。请找出原因并修好，修好后说明依据。'
const GOOD = [
  '已落定的决定（原文逐字）：「The minimal correct fix: in test/hedge.selftest.mjs, use settledAt instead of primarySettled.」',
  '',
  '落点：test/hedge.selftest.mjs（只动这一处；其余路径不动）',
  '',
  '原文还悬着这句，但它不阻塞落 edit：「Wait, but should we also harden src/distill.js?」',
  '',
  // 注意这里必须把「原先报什么」放进引号里 —— 真稿就是这么写的
  // （tools/gold-forge2.mjs 第 57 行：bad ? '「' + bad + '」' : '原判定失败'）。
  // 我第一版把它写成裸文本，于是 38 字的逐字串被算成正文照抄，好稿被 G6 误判。
  '验收：跑 node verify.mjs。若不再报 「expected hedgeStartedAt=null, got 1712」 ⇒ 判这条修好。',
].join('\n')
const J = (draft, raw = RAW, ctx = CTX) => judge({ raw, ctx, draft })

// ── 1. 确定性
ok('judging is deterministic (guards the stateful /g regex regression)', () => {
  const a = J(GOOD)
  const b = J(GOOD)
  const c = J(GOOD)
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same input must give identical verdict')
  assert.equal(JSON.stringify(b), JSON.stringify(c))
  const bad = J(RAW)
  for (let i = 0; i < 5; i++) assert.deepEqual(J(RAW).failed, bad.failed, 'repeat judging must not drift')
})

// ── 2. 好稿过门
ok('a grounded generative draft passes every hard gate', () => {
  const r = J(GOOD)
  assert.equal(r.pass, true, 'expected pass, got ' + JSON.stringify(r.failed))
  assert.equal(r.failed.length, 0)
  assert.ok(r.score > 0.5, 'score should be well above 0.5, got ' + r.score)
})

// ── 3. 照抄稿必须死
ok('verbatim extraction is rejected by the copy gate', () => {
  const r = J(RAW)
  assert.ok(r.failed.includes('G6 not-copy'), 'copy must be caught, got ' + JSON.stringify(r.failed))
  assert.ok(copyCoverage(RAW, RAW) > 0.95)
})

// ── 4. 合法引用不算照抄（引用是必须的，不该被罚成硬失败）
ok('legitimate verbatim quotations do not trip the copy gate', () => {
  const onlyQuote = '已落定的决定（原文逐字）：「' + 'The minimal correct fix: in test/hedge.selftest.mjs, use settledAt instead of primarySettled.' + '」'
  assert.equal(copyCoverage(onlyQuote, RAW), 0, 'a pure quotation carries no unquoted copy')
  assert.ok(quotedFragments(onlyQuote).length >= 1)
})

// ── 5. camelCase 锚点必须可见
ok('camelCase and snake_case identifiers are first-class anchors', () => {
  const a = anchorsOf('we check hedgeStartedAt and finish_reason here')
  assert.ok(a.includes('hedgeStartedAt'), 'camelCase anchor missing: ' + JSON.stringify(a))
  assert.ok(a.includes('finish_reason'), 'snake_case anchor missing: ' + JSON.stringify(a))
  // 丢掉承重标识符 => G3
  const dropped = GOOD.split('hedgeStartedAt').join('[略]')
  assert.ok(J(dropped).failed.includes('G3 anchors-kept'), 'dropping a load-bearing identifier must fail G3')
})

// ── 6. 症状路径不得当选落点（复刻 gold-forge2 第 48 行的真实缺陷）
ok('a symptom path is rejected as the fix locus', () => {
  const raw = RAW + ' The error is written to /home/u/.logs/stale-diagnostic.log which is root-owned, so EACCES.'
  const draft = GOOD.split('test/hedge.selftest.mjs').join('/home/u/.logs/stale-diagnostic.log')
  const r = judge({ raw, ctx: CTX, draft })
  assert.ok(r.failed.includes('G2 locus-grounded'), 'symptom locus must fail G2, got ' + JSON.stringify(r.failed))
})

// ── 7. 凭空（引用里塞不存在的锚点）必须死
ok('an invented anchor inside a quotation is rejected', () => {
  const draft = GOOD.split('primarySettled.').join('primarySettled_v2.')
  const r = J(draft)
  assert.ok(r.failed.includes('G1 quote-grounded'), 'fabrication must fail G1, got ' + JSON.stringify(r.failed))
})

// ── 8. 反因果必须被抓住，且因果对的抽取是按位置取最近锚点
ok('cause pairs use the nearest anchor by position, and inversion is rejected', () => {
  const ps = causePairs(RAW)
  assert.ok(ps.length > 0, 'raw should yield at least one cause pair')
  const [a, b] = ps[0].split('>')
  const inv = GOOD + '\n\n并非因为 ' + b + '，而是因为 ' + a + '。'
  if (causePairs(inv).includes(b + '>' + a)) {
    assert.ok(J(inv).failed.includes('G5 no-cause-inversion'), 'inversion must fail G5')
  }
})

// ── 9. 过压必须死
ok('over-compression loses the actionable interface and is rejected', () => {
  const r = J('已落定的决定：「The minimal correct fix: in test/hedge.selftest.mjs, use settledAt instead of primarySettled.」')
  assert.ok(r.failed.length > 0, 'a lone quotation with no locus/acceptance must not pass')
})

// ── 10. 落点识别
ok('the declared locus is read off the draft, not guessed from length', () => {
  assert.equal(locusOf(GOOD).path, 'test/hedge.selftest.mjs')
  assert.equal(locusOf(GOOD).declared, true)
  assert.equal(locusOf('no locus here').path, null)
})

// ── 11. 负例生成器：六条轴全部造得出、全部拦得住、零洞
ok('the six mechanical negative axes are all rejected with zero ruler holes', () => {
  const n = makeNegatives({ id: 'selftest', raw: RAW, ctx: CTX, draft: GOOD })
  assert.ok(n.length >= 5, 'expected the full axis battery, got ' + n.map((x) => x.axis).join(','))
  for (const neg of n) {
    const r = J(neg.draft)
    assert.ok(r.failed.length > 0, 'negative ' + neg.axis + ' passed the ruler entirely (ruler hole)')
  }
  const rep = auditRuler([{ id: 'selftest', raw: RAW, ctx: CTX, draft: GOOD }])
  assert.equal(rep.holes.filter((h) => h.why === '整条负例过了尺子').length, 0)
  assert.equal(rep.nNeg, n.length)
  assert.equal(rep.nRejected, n.length, 'every derived negative must be rejected')
})

// ── 12. PATH_RX 不得产生裸点开头的断尾
ok('path extraction never yields a truncated dot-leading fragment', () => {
  const ps = anchorsOf('see .selftest.mjs and test/hedge.selftest.mjs and /a/b/c.log')
  assert.ok(!ps.some((p) => p.startsWith('.')), 'truncated dot-leading path leaked: ' + JSON.stringify(ps))
  assert.ok(ps.includes('test/hedge.selftest.mjs'))
  assert.ok(ps.includes('/a/b/c.log'))
})

console.log('gen-ruler: determinism, fabrication-vs-fidelity split, camelCase anchor coverage, symptom-locus rejection, position-ordered causality and the six-axis negative battery all verified')
console.log('PASS=' + checks + ' FAIL=0')
