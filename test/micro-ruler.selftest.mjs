#!/usr/bin/env node
// test/micro-ruler.selftest.mjs —— v14.20 微模型「尺子与数据」回归测试
//
// 守住三件被证明会退化的事：
//   1. 评测尺子必须给出长度分层 / 长度匹配子集 / Wilson 下界 / 去 token 惩罚四组读数，且彼此自洽；
//   2. 落库的飞轮偏好对不得退化成常数占位（旧版 122 条全是 0.92/0.45，等于假 margin）；
//   3. 数据集构建器必须声明 hardened 负例策略与端点上限，且实际端点度数不超过声明值。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
let checks = 0
const ok = (label, fn) => { fn(); checks++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-micro-ruler-'))

// ── 1. 尺子读数自洽（合成小数据集，固定权重，不依赖训练产物）
const weights = readJson(path.join(ROOT, 'transfer/models/v5-micro-weights.json'))
const feat = (seed) => ({
  features: Array.from({ length: 19 }, (_, i) => +(0.05 * ((seed * 7 + i * 3) % 11)).toFixed(4)),
  tokenCount: 8 + ((seed * 5) % 9),
  temptationT: +(((seed * 13) % 10) / 10).toFixed(4),
})
const mkUnit = (id, fam, seed) => ({
  sourceId: id,
  family: fam,
  split: 'dev',
  text: `unit-${id}`,
  trainingEligible: true,
  slot: 'DECIDED',
  labelAudit: { labelRule: 'synthetic-for-ruler-selftest', source: 'selftest' },
  ...feat(seed),
})
const family = 'ruler-synthetic-family'
const unitSamples = [0, 1, 2, 3, 4, 5].map((i) => mkUnit(`${family}-u${i}`, family, i))
// 三条 pair：一条长度匹配（|Δtok| 小）、一条中等、一条明显长度差；均同 family，cap=3 内
const unitStepPairs = [
  { sourceId: `${family}-u0`, family, winIdx: 0, loseIdx: 3, gammaStep: 0.4, trainingEligible: true },
  { sourceId: `${family}-u1`, family, winIdx: 1, loseIdx: 4, gammaStep: 0.4, trainingEligible: true },
  { sourceId: `${family}-u2`, family, winIdx: 2, loseIdx: 5, gammaStep: 0.4, trainingEligible: true },
]
const dataset = {
  schema: 'cfb.micro-dev-dataset/3',
  finalBlind: false,
  holdoutTouched: false,
  holdoutFamiliesExcluded: ['eacces-config', 'wrong-model'],
  stats: {
    devFamilyAllowlist: ['flaky-timeout', 'perf-regression', 'sse-truncated'],
    unitPairEndpointReuse: { cap: 3 },
    pairConstruction: { nearLengthTokens: 3 },
  },
  unitSamples,
  unitStepPairs,
  stepSimpoPairs: [],
}
const dsPath = path.join(tmp, 'mini-dataset.json')
const reportPath = path.join(tmp, 'mini-report.json')
fs.writeFileSync(dsPath, JSON.stringify(dataset))
execFileSync(NODE, [
  path.join(ROOT, 'tools/eval-micro-js-pairs.mjs'),
  '--dataset', dsPath,
  '--weights', path.join(ROOT, 'transfer/models/v5-micro-weights.json'),
  '--validation-family', family,
  '--report', reportPath,
], { cwd: ROOT, stdio: 'pipe' })
const report = readJson(reportPath)
const unit = report.candidate.unitPairs.validation

ok('ruler report carries the v14.20 metrics policy', () => {
  assert.equal(report.schema, 'cfb.micro-js-pair-eval/4')
  assert.ok(report.metricsPolicy && report.metricsPolicy.ties && report.metricsPolicy.lengthStratification)
})
ok('every pair lands in exactly one length stratum', () => {
  const buckets = ['matched', 'near', 'far'].map((k) => unit.lengthStratified[k]?.total || 0)
  assert.equal(buckets.reduce((a, b) => a + b, 0), unit.total)
})
ok('length-matched subset is a real subset of the scored pairs', () => {
  const matched = unit.lengthMatchedSubset
  assert.ok(matched.total <= unit.total)
  if (matched.total > 0) {
    assert.ok(matched.accuracy >= 0 && matched.accuracy <= 1)
    assert.ok(matched.wilsonLower95 <= matched.accuracy)
  }
})
ok('wilson interval brackets the strict point estimate', () => {
  assert.ok(unit.wilson95.lower <= unit.accuracy && unit.accuracy <= unit.wilson95.upper)
  assert.ok(unit.wilsonLower95 <= unit.accuracy)
  if (unit.ties > 0) assert.ok(unit.accuracyWithTiesHalfCredit > unit.accuracy)
  else assert.equal(unit.accuracyWithTiesHalfCredit, unit.accuracy)
})
ok('length shortcut audit and token-penalty-free score are reported', () => {
  assert.ok(unit.lengthShortcutAudit.winnerLonger && unit.lengthShortcutAudit.winnerShorter)
  const decoupled = unit.scoreWithoutTokenPenalty
  assert.ok(Number.isFinite(decoupled.accuracy))
  assert.ok(decoupled.agreementWithFullScore >= 0 && decoupled.agreementWithFullScore <= 1)
})

// ── 2. 飞轮偏好对不得是常数占位
const flywheelPath = path.join(ROOT, 'transfer/models/dev-flywheel-pairs.json')
ok('promoted flywheel pairs are real (non-degenerate) supervision', () => {
  const doc = readJson(flywheelPath)
  const rows = Array.isArray(doc) ? doc : doc.pairs
  assert.ok(Array.isArray(rows) && rows.length > 0, 'flywheel pairs must exist')
  const scorePairs = new Set(rows.map((r) => `${r.chosenScore}|${r.rejectedScore}`))
  assert.ok(scorePairs.size >= 3, `constant placeholder scores are forbidden (found ${scorePairs.size} distinct score pairs)`)
  assert.ok(rows.every((r) => !['eacces-config', 'wrong-model'].includes(String(r.task || r.family || ''))), 'holdout families must not appear')
})

// ── 3. 构建器声明与端点上限
ok('dataset builder declares the hardened pair-construction strategy and honours its cap', () => {
  const out = execFileSync(NODE, [path.join(ROOT, 'tools/build-micro-dataset.mjs')], { cwd: ROOT, stdio: 'pipe' })
  assert.ok(out.length > 0)
  const built = readJson(path.join(ROOT, 'transfer/models/micro-dev-dataset.json'))
  assert.equal(built.stats.pairConstruction.strategy, 'hardened')
  assert.ok(Number.isInteger(built.stats.unitPairEndpointReuse.cap) && built.stats.unitPairEndpointReuse.cap >= 1)
  assert.ok(built.stats.unitPairEndpointReuse.maxDegree <= built.stats.unitPairEndpointReuse.cap)
  const eligibleDraft = built.stepSimpoPairs.filter((p) => p.trainingEligible).length
  assert.ok(eligibleDraft > 0, 'real draft supervision must survive the degenerate-score guard')
  assert.equal(built.stats.flywheelScoresDegenerate, false)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('micro-ruler: length-stratified units, Wilson bounds, decoupled token-penalty metric, real flywheel margins and hardened pair construction all verified')
console.log(`PASS=${checks} FAIL=0`)
