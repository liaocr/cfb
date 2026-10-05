#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  auditMode1Gold,
  auditMode1Output,
  auditMode1Pair,
  allowedMode1Capture,
  isMode1GoldEligible,
  isMode1PairEligible,
} from '../tools/helpers/mode1-quality.mjs'

const validTaskExclusion = '不改 legacy.js：它不在本次请求范围内；验收只检查 src/compiler.js。'
assert.equal(auditMode1Output(validTaskExclusion).status, 'clean', 'task-valid exclusions must not be confused with experiment controls')
assert.equal(auditMode1Output('不要改 src/transport.legacy.js；它不在 birth.js 的调用链中。').status, 'clean', 'task-scoped code exclusions remain valid target content')
assert.equal(auditMode1Output('不要改 src/distill.js；下一步用 bash grep 查看这条任务相关的实现。').status, 'clean', 'a code-change constraint followed by an allowed tool step is not a tool ban')
assert.equal(auditMode1Output('不要再把 3000 调成 5000；先 grep hedgeAfterMs 核验当前值。').status, 'clean', 'task-specific parameter advice is not an apparatus prohibition')

const contaminated = [
  ['environment-permission-assertion', '沙箱白名单已内置，直接放行，不要再试探。'],
  ['experiment-round-or-budget-control', '下一轮是第4轮，已经是最后一轮，不再发起工具调用。'],
  ['executor-tool-or-check-prohibition', '严禁再发起任何工具调用；不要先读文件。'],
  ['executor-tool-or-check-prohibition', '严禁再用 read_file 或 sed 确认文件上下文。'],
  ['executor-tool-or-check-prohibition', '禁止工具调用；不要先读文件。'],
]
for (const [category, text] of contaminated) {
  const result = auditMode1Output(text)
  assert.equal(result.status, 'quarantined', `expected quarantine for ${category}`)
  assert.ok(result.issues.some((issue) => issue.category === category), `expected category ${category}`)
}

const cleanGold = { id: 'clean', validated: true, draft: validTaskExclusion }
assert.equal(isMode1GoldEligible(cleanGold), true)
assert.equal(isMode1GoldEligible({ ...cleanGold, validated: false }), false)
assert.equal(isMode1GoldEligible({ ...cleanGold, draft: contaminated[0][1] }), false)
assert.equal(isMode1GoldEligible({ ...cleanGold, stored: contaminated[2][1] }), false)
assert.equal(auditMode1Gold({ ...cleanGold, stored: contaminated[2][1] }).status, 'quarantined')

const gatePass = { gate: { ok: true }, production: { ok: true } }
assert.equal(allowedMode1Capture({ ...gatePass, draft: validTaskExclusion, stored: validTaskExclusion }).trainingEligible, true)
assert.equal(allowedMode1Capture({ ...gatePass, draft: validTaskExclusion, stored: contaminated[1][1] }).trainingEligible, false)
assert.equal(allowedMode1Capture({ ...gatePass, draft: contaminated[0][1], stored: validTaskExclusion }).trainingEligible, false)
assert.equal(allowedMode1Capture({ gate: { ok: true }, production: { ok: false }, draft: validTaskExclusion, stored: validTaskExclusion }).trainingEligible, false)

const cleanPair = { chosenText: validTaskExclusion, rejectedText: '只重复背景，没有保留最终决定。' }
const pairAudit = auditMode1Pair(cleanPair)
assert.equal(pairAudit.status, 'clean')
assert.equal(isMode1PairEligible(cleanPair), false, 'unannotated legacy pairs are not accepted as audited')
const annotatedPair = { ...cleanPair, contentAudit: pairAudit }
assert.equal(isMode1PairEligible(annotatedPair), true)
assert.equal(isMode1PairEligible({ ...annotatedPair, contentAudit: { ...pairAudit, checkedFields: ['chosenText'] } }), false, 'record must declare both exact text fields')
assert.equal(isMode1PairEligible({ ...annotatedPair, contentAudit: { ...pairAudit, issues: [{ category: 'stale' }] } }), false, 'recorded clean audit must have no issues')
assert.equal(isMode1PairEligible({ ...annotatedPair, contentAudit: { ...pairAudit, textSha256: 'stale' } }), false, 'recorded audit must bind the exact text hash')
assert.equal(isMode1PairEligible(annotatedPair, { requireManualReview: true }), false, 'legacy pairs need an explicit semantic review to pass the legacy gate')
const manuallyReviewedPair = { ...annotatedPair, manualReview: { schema: 'cfb.mode1-manual-review/1', status: 'clear-of-apparatus', pairTextSha256: pairAudit.textSha256 } }
assert.equal(isMode1PairEligible(manuallyReviewedPair, { requireManualReview: true }), true)
assert.equal(isMode1PairEligible({ ...manuallyReviewedPair, manualReview: { ...manuallyReviewedPair.manualReview, pairTextSha256: 'stale' } }, { requireManualReview: true }), false)
assert.equal(isMode1PairEligible({ ...annotatedPair, chosenText: contaminated[4][1] }), false, 'text changes invalidate a clean pair audit')
assert.equal(isMode1PairEligible({ ...cleanPair, rejectedText: contaminated[4][1] }, { requireRecorded: false }), false)

console.log('mode1-quality: target-only apparatus quarantine, task-valid exclusions, gold/capture gates, and flywheel pair binding passed')
console.log('PASS=34 FAIL=0')
