import { judge, anchorsOf } from '../tools/gen-ruler.mjs'
import { makeNegatives, loadAnchors } from '../tools/gen-negatives.mjs'
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
  '验收：跑 node verify.mjs。若不再报 「expected hedgeStartedAt=null, got 1712」 ⇒ 判这条修好。',
].join('\n')
console.log('loadAnchors =', JSON.stringify(loadAnchors(RAW, CTX)))
console.log('anchorsOf(CTX failure) =', JSON.stringify(anchorsOf('CI 里 test/hedge.selftest.mjs 报 FAIL §4 expected hedgeStartedAt=null, got 1712。')))
for (const n of makeNegatives({ id: 'x', raw: RAW, ctx: CTX, draft: GOOD })) {
  const r = judge({ raw: RAW, ctx: CTX, draft: n.draft })
  console.log('---', n.axis, '| failed =', JSON.stringify(r.failed))
  console.log('    mutation:', n.mutation)
  console.log('    draft   :', JSON.stringify(n.draft).slice(0, 220))
}
