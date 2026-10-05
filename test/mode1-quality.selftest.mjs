#!/usr/bin/env node
import nodeAssert from 'node:assert/strict'
/** 每条断言计一分：PASS= 必须是真实计数，不能是手写的常数（v14.20.1 起）。 */
let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (target, kind) => (...args) => { const r = target[kind](...args); pass += 1; return r },
  apply: (target, thisArg, args) => { const r = target(...args); pass += 1; return r },
})
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

/* —— 逐字引用免检（v14.20.1）：装置话术只能定「作者自己主张」的罪，不能定「原文回显」的罪 —— */
const echo = 'bash: 该沙箱不支持 shell 循环，请直接跑单条命令'
const ledgerLine = `【延续段】上一轮工具输出：${echo}。`
const storedWithEcho = { id: 'echo', validated: true, raw: '第 3 轮跑 for 循环，回显：' + echo, ctx: ledgerLine, draft: validTaskExclusion, stored: validTaskExclusion + '\n' + ledgerLine }
assert.equal(auditMode1Output(storedWithEcho.stored).status, 'quarantined', '没有证据时该句确实越界（前提检查）')
assert.equal(auditMode1Gold(storedWithEcho).status, 'clean', 'stored 里逐字回显的整句必须免检')
assert.equal(auditMode1Gold(storedWithEcho).exempted[0].basis, 'verbatim-sentence-from-raw-or-ctx')
assert.equal(isMode1GoldEligible(storedWithEcho), true)
assert.equal(isMode1GoldEligible({ ...storedWithEcho, raw: '无关原文', ctx: '无关上下文' }), false, '回显不在证据里 ⇒ 不免检')

const quotedObservation = `本轮 \`node -e\` 被拒，回显逐字是「${echo}」，所以只跑单条命令复现。`
const quotedClean = auditMode1Output(quotedObservation, '作者被给的证据：' + echo)
assert.equal(quotedClean.status, 'clean', '句内定界引用（「…」）逐字来自证据 ⇒ 报告观测，不是主张')
assert.equal(quotedClean.exempted[0].basis, 'verbatim-quote-from-raw-or-ctx')
assert.equal(auditMode1Output(quotedObservation, '证据里没有这句话').status, 'quarantined', '引用不在证据里 = 伪造引用，照判')
const halfQuoted = `回显逐字是「${echo}」，所以第 7 轮是最后一轮，严禁再发起任何工具调用。`
const halfAudit = auditMode1Output(halfQuoted, '证据：' + echo)
assert.equal(halfAudit.exempted.length, 1, '引号内的部分免检')
assert.equal(halfAudit.status, 'quarantined', '引号外自己写出来的轮次禁令照样定罪')

const selfAuthored = { id: 'claim', validated: true, raw: '原文没提沙箱', ctx: '上下文也没提沙箱', draft: validTaskExclusion, stored: validTaskExclusion + '\n沙箱已内置白名单直接放行 node test/hedge.selftest.mjs，无需再试。' }
assert.equal(auditMode1Gold(selfAuthored).status, 'quarantined', 'stored 里作者自己写的环境保证 ⇒ 仍定罪（不因免检而放过）')
assert.equal(auditMode1Gold(selfAuthored).exempted.length, 0)
assert.equal(isMode1GoldEligible(selfAuthored), false)
assert.equal(allowedMode1Capture({ gate: { ok: true }, production: { ok: true }, ...selfAuthored }).trainingEligible, false)
const draftQuote = { id: 'dq', validated: true, ctx: '', raw: '证据：' + echo, draft: quotedObservation, stored: quotedObservation }
assert.equal(auditMode1Gold(draftQuote).status, 'clean')
assert.equal(auditMode1Gold({ ...draftQuote, raw: '证据里没有' }).status, 'quarantined', 'draft 侧同样只免检逐字引用')

console.log('mode1-quality: target-only apparatus quarantine, task-valid exclusions, gold/capture gates, flywheel pair binding, and verbatim-quote exemption passed')
console.log(`PASS=${pass} FAIL=0`)
