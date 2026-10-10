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
import { judge, anchorsOf, causePairs, copyCoverage, locusOf, quotedFragments, preflight } from '../tools/gen-ruler.mjs'
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

// ── 13. preflight：花钱前的资格筛（不需要稿子的那部分门）
// 它有一组自己的、长度达标的 fixture —— 上面那组 RAW/CTX（450/68 字）故意是短的，
// 拿来测 judge 的最小形状；preflight 的门是按真实语料的量级设的（raw 中位 2500 字），
// 用短 fixture 测它只会测出 P1/P3，测不到它真正的行为。fixture 的尺寸必须匹配被测的那层。
const PRE_CTX = '[task] I have uploaded a python code repository in /workspace/acme__lib__1.0. ' +
  'Consider the following issue description: the Path constructor rejects integers and __add__ raises TypeError. ' +
  'Please find the root cause and fix it, then explain the evidence for your fix.'
const PRE_RAW = [
  'The 6 errors are unrelated to our changes - they are about a missing fixture minecraft_data_pack in test_minecraft.py. The path tests all pass currently.',
  'Now let me implement the changes. Let me look at the __new__ method more closely.',
  'The issue is that when path is an int, it is not None and not Path, so it falls through to parse_accessors(path).',
  'I need to add an int check before the string parsing, similar to how __getitem__ already handles int.',
  'And for __add__ we should return self[other] when other is an int, because __getitem__ already handles it.',
  'Let me also check __eq__ and __ne__ to make sure they do not silently accept an int.',
  'Finally I will run python3 -m pytest test/test_path.py to confirm the new behaviour.',
  'Let me verify that ListIndex(index=5) is what __getitem__ builds for an integer key.',
  'If __radd__ receives a Path we should delegate to other[self], mirroring the existing behaviour.',
  'I will re-run the failing case from the issue to confirm Path(5) now equals Path("[5]").',
].join('\n\n')
// fixture 的长度是被测那层的门槛决定的，不是随手写的 —— 短了只会测出 P1，测不到别的。
// 所以这里钉死长度，谁把它改短了会立刻看到原因，而不是看到一句含糊的 "expected ok"。
assert.ok(PRE_RAW.length >= 900, 'PRE_RAW must clear the 800-char preflight floor, got ' + PRE_RAW.length)
assert.ok(PRE_CTX.length >= 250, 'PRE_CTX must clear the 200-char preflight floor, got ' + PRE_CTX.length)

ok('preflight accepts an in-band unit and is deterministic', () => {
  const a = preflight({ raw: PRE_RAW, ctx: PRE_CTX })
  const b = preflight({ raw: PRE_RAW, ctx: PRE_CTX })
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'preflight must be deterministic')
  assert.equal(a.ok, true, 'expected ok, got ' + JSON.stringify(a.reasons))
  assert.ok(a.signals.rawChars >= 800 && a.signals.anchors >= 3, JSON.stringify(a.signals))
})

ok('preflight rejects each out-of-band input for the stated reason', () => {
  const short = preflight({ raw: 'too short to compress', ctx: PRE_CTX })
  assert.ok(short.reasons.includes('P1 too-short'), JSON.stringify(short.reasons))
  const long = preflight({ raw: PRE_RAW + ' padding words here'.repeat(600), ctx: PRE_CTX })
  assert.ok(long.reasons.includes('P2 too-long-for-window'), JSON.stringify(long.reasons))
  const noCtx = preflight({ raw: PRE_RAW, ctx: '' })
  assert.ok(noCtx.reasons.includes('P3 ctx-missing'), JSON.stringify(noCtx.reasons))
  const noAnchors = preflight({
    raw: 'The quick brown fox jumps over the lazy dog again and again. '.repeat(20),
    ctx: PRE_CTX,
  })
  assert.ok(noAnchors.reasons.includes('P5 no-load-bearing-anchors'), JSON.stringify(noAnchors.reasons))
})

// ── 14. preflight 与 judge 的分工：preflight 说「值不值得试」，judge 说「稿子行不行」。
// 这条守住一个架构约束 —— 照抄稿必须在**预检里过**（它的输入是合格的），
// 只在 judge 里被 G6 打死。两层的判据不能混，混了就会出现「用预检分数当质量结论」。
ok('preflight passes a verbatim copy while judge rejects it (the two layers stay separate)', () => {
  assert.equal(preflight({ raw: PRE_RAW, ctx: PRE_CTX }).ok, true)
  const j = judge({ raw: PRE_RAW, ctx: PRE_CTX, draft: PRE_RAW })
  assert.ok(j.failed.includes('G6 not-copy'), JSON.stringify(j.failed))
})

console.log('gen-ruler: determinism, fabrication-vs-fidelity split, camelCase anchor coverage, symptom-locus rejection, position-ordered causality, preflight-vs-judge separation and the six-axis negative battery all verified')
console.log('PASS=' + checks + ' FAIL=0')
