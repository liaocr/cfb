#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  allowedMode1Capture,
  auditMode1Output,
  auditMode1Pair,
  isMode1CaptureAuditEligible,
  isMode1PairEligible,
} from '../tools/helpers/mode1-quality.mjs'

const cases = [
  '沙箱白名单已内置，直接放行，不要再试探。',
  '不要再写临时脚本、压测脚本或任何探针去试探沙箱。',
  '沙箱不支持新建脚本文件或循环，无需再试。',
  '下一轮是第 7 轮（最后一轮），不要再跑任何其它探针或找文件，必须收尾。',
  '第 4 轮是预算上限，禁止再发起工具调用。',
  '严禁再用 read_file 或 sed 确认文件上下文。',
  '禁止工具调用；不要先读文件。',
  '不要先读文件。',
  'Do not call any tools before reading the file.',
  'This sandbox has an allowlist enabled; no need to test it.',
  '不要改 src/transport.js；下一步用 bash grep 查看这条任务相关的实现。',
  '不要再把 3000 调成 5000；先 grep hedgeAfterMs 核验当前值。',
  '不要改 settle 的 ok 判定，下一条是 read_file 该调用处上下文，看清剥壳在哪一层再说。',
  '不需要再复现：两核 taskset 的 50 次记录已经给出 9 次失败。',
  '下一步工具调用是 edit_file test/hedge.selftest.mjs。',
  '不改 legacy.js：它不在本次请求范围内；验收只检查 src/compiler.js。',
  '已排除清除 timer；如果输出仍失败，先 grep -n hedgeAfterMs 再决定。',
  '已改未验证；同等条件 50/50 通过之前不能说修好了。',
]

const pairRows = [
  { chosenText: '核对“src/transport.js”中的 finish_reason；随后运行 npm test。', rejectedText: '只有 [DONE] 不能证明内容完整。' },
  { chosenText: '保持任务范围：不要改 legacy.js。', rejectedText: '先检查 src/compiler.js，再验证调用链。\n' },
  { chosenText: '引号 "、反斜杠 \\、制表符\t与换行\n都必须按原字节绑定。', rejectedText: '中文、emoji 🧪 与标点；不能归一化空白。' },
]
const auditedPairs = pairRows.map((pair) => ({ ...pair, contentAudit: auditMode1Pair(pair) }))
const pairCases = [
  auditedPairs[0],
  { ...auditedPairs[0], chosenText: auditedPairs[0].chosenText + ' ' },
  { ...auditedPairs[1], contentAudit: { ...auditedPairs[1].contentAudit, issues: [{ category: 'stale' }] } },
  { ...auditedPairs[2], contentAudit: { ...auditedPairs[2].contentAudit, checkedFields: ['chosenText'] } },
  { ...auditedPairs[0], chosenText: '禁止工具调用；不要先读文件。' },
]
const captureBase = {
  gate: { ok: true }, production: { ok: true }, gateEligible: true,
  trainableTargetsAdded: 1, raw: '完整的原始任务输入与证据。', ctx: '完整的工具上下文。',
  draft: '任务范围内，先读 src/transport.js 并核验结果。', stored: '保持旧接口；仅有 [DONE] 不算正常完成。',
}
const captureAudit = allowedMode1Capture(captureBase)
assert.equal(captureAudit.trainingEligible, true)
const captureRows = [
  { ...captureBase, trainingEligible: true, qualityAudit: captureAudit.qualityAudit },
  { ...captureBase, stored: captureBase.stored + ' ' , trainingEligible: true, qualityAudit: captureAudit.qualityAudit },
]

const pySource = `import json, sys\nsys.path.insert(0, 'tools')\nfrom helpers.mode1_quality import mode1_apparatus_categories, mode1_pair_text_sha256, mode1_pair_content_audit_valid, mode1_capture_quality_audit_valid\ndata = json.load(sys.stdin)\nprint(json.dumps({\n  'categories': [mode1_apparatus_categories(x) for x in data['texts']],\n  'pairHashes': [mode1_pair_text_sha256(p['chosenText'], p['rejectedText']) for p in data['pairs']],\n  'pairValid': [mode1_pair_content_audit_valid(p) for p in data['pairCases']],\n  'captureValid': [mode1_capture_quality_audit_valid(s) for s in data['captures']],\n}, ensure_ascii=False))\n`
const proc = spawnSync('python3', ['-c', pySource], {
  cwd: process.cwd(),
  input: JSON.stringify({ texts: cases, pairs: auditedPairs, pairCases, captures: captureRows }),
  encoding: 'utf8',
})
assert.equal(proc.status, 0, proc.stderr || 'Python parity helper failed')
const python = JSON.parse(proc.stdout)
assert.equal(python.categories.length, cases.length)
for (let i = 0; i < cases.length; i++) {
  const jsCategories = [...new Set(auditMode1Output(cases[i]).issues.map((issue) => issue.category))]
  assert.deepEqual(python.categories[i], jsCategories, `JS/Python category parity case ${i}: ${cases[i]}`)
}
for (let i = 0; i < auditedPairs.length; i++) {
  assert.equal(python.pairHashes[i], auditedPairs[i].contentAudit.textSha256, `exact-text digest parity case ${i}`)
}
assert.deepEqual(pairCases.map((pair) => isMode1PairEligible(pair)), python.pairValid, 'JS/Python exact-pair audit-gate parity')
assert.deepEqual(captureRows.map((sample) => isMode1CaptureAuditEligible(sample)), python.captureValid, 'JS/Python exact capture-audit parity')
console.log(`mode1-quality JS/Python parity: ${cases.length} curated category cases, ${auditedPairs.length} exact-pair digests, ${pairCases.length} pair gates, and ${captureRows.length} capture gates passed`)
