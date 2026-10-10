import { judge, loadAnchors, failureText, splitSentences, isRetired } from '../tools/gen-ruler.mjs'
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
console.log('sentences:', JSON.stringify(splitSentences(CTX)))
console.log('failureText:', JSON.stringify(failureText(CTX)))
console.log('isRetired(hedgeStartedAt):', isRetired(RAW, 'hedgeStartedAt'))
console.log('loadAnchors:', JSON.stringify(loadAnchors(RAW, CTX)))
console.log('judge(GOOD).failed:', JSON.stringify(judge({ raw: RAW, ctx: CTX, draft: GOOD }).failed))
const dropped = GOOD.split('hedgeStartedAt').join('[略]')
console.log('dropped still has it?', dropped.includes('hedgeStartedAt'))
console.log('judge(dropped).failed:', JSON.stringify(judge({ raw: RAW, ctx: CTX, draft: dropped }).failed))
console.log('judge(dropped).anchors:', JSON.stringify(judge({ raw: RAW, ctx: CTX, draft: dropped }).detail.anchors))
