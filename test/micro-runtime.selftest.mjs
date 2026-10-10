#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  V5_MICRO_WEIGHTS,
  V5_MICRO_WEIGHTS_DIGEST,
  V5_LOCAL_VERSION,
  fingerprintV5MicroWeights,
  V5_FEATURE_NAMES,
  V5_PREF_FEATURE_NAMES,
  loadV5MicroWeights,
  validateV5MicroWeights,
  extractUnitFeatures,
  extractDraftPrefFeatures,
  scoreUnitWithWeights,
  scoreDraftPreference,
  scoreDraftPreferenceFeatures,
  compileV5Local,
} from '../src/compile-v5-local.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const weightsPath = path.join(ROOT, 'transfer/models/v5-micro-weights.json')
const onDisk = JSON.parse(fs.readFileSync(weightsPath, 'utf8'))
const reloaded = loadV5MicroWeights(weightsPath)

assert.deepEqual(V5_MICRO_WEIGHTS, onDisk, 'the production JS runtime must consume the checked-in production weights')
assert.deepEqual(reloaded, onDisk)
assert.equal(V5_MICRO_WEIGHTS.schema, onDisk.schema)
assert.equal(Object.isFrozen(V5_MICRO_WEIGHTS), true)
assert.equal(Object.isFrozen(V5_MICRO_WEIGHTS.valueWeights), true)
const metadataOnly = { ...onDisk, trainingStats: { runId: 'must-not-change-scoring-fingerprint' } }
assert.equal(fingerprintV5MicroWeights(metadataOnly), V5_MICRO_WEIGHTS_DIGEST, 'artifact metadata must not alter the scoring fingerprint')
assert.equal(V5_FEATURE_NAMES.length, 19)
assert.equal(V5_PREF_FEATURE_NAMES.length, 12)
assert.deepEqual(V5_MICRO_WEIGHTS.featureNames, V5_FEATURE_NAMES)

// v14.25.5：自评 `architecture` 块已退役（历史上声称 60,854,837 参数 / 8 层 Transformer，
// 而文件里真实权重数字只有 1,042 个，且全仓无人读取）——出现即拒收，防止被重新写回。
assert.equal('architecture' in onDisk, false, 'fictional self-reported architecture block must stay removed')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-micro-weights-'))
const tmpWeights = path.join(tmpDir, 'v5-micro-weights.json')   // ★ 必须叫这个名字：防线按 basename 生效
fs.writeFileSync(tmpWeights, JSON.stringify({ ...onDisk, architecture: { name: 'CFB-Micro-65M', totalParameters: 60854837 } }))
try {
  assert.throws(
    () => loadV5MicroWeights(tmpWeights),
    /invalid-v5-micro-architecture-self-report-retired/,
    'declaring a self-reported parameter count in the production weights must be rejected',
  )
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
// ★ 防线**只限生产权重文件名**：冻结裁判同样带 architecture，但被 preregistration 钉住，
//   动它会破坏历史实验的可复现性 ⇒ 必须仍然可加载（这条断言防止有人把防线扩大到冻结裁判）。
const judgePath = path.join(ROOT, 'transfer/models/v5-micro-weights.judge-4764fd2.json')
assert.ok(fs.existsSync(judgePath), '冻结裁判文件必须还在')
assert.ok(loadV5MicroWeights(judgePath).architecture, '冻结裁判的历史 architecture 块必须仍可加载')

const raw = [
  '我们需要确认 src/compiler.js 的 Unit pair 路径。',
  '已排除：继续重复读取同一份日志，因为输出没有变化。',
  '改法只落一个：改 src/compiler.js 的 `scoreUnitWithWeights`，验收使用 `npm test`。',
].join('\n')
const units = raw.split('\n')
const ctx = { raw, toolText: 'src/compiler.js scoreUnitWithWeights npm test', targetAnchors: new Set(['compiler', 'scoreUnitWithWeights']), offsets: [0, raw.indexOf(units[1]), raw.indexOf(units[2])] }
const feat = extractUnitFeatures(units[2], 2, units.length, ctx)
assert.equal(feat.vec.length, V5_FEATURE_NAMES.length)
const defaultUnitScore = scoreUnitWithWeights(feat)
const explicitUnitScore = scoreUnitWithWeights(feat, reloaded)
assert.deepEqual(defaultUnitScore, explicitUnitScore, 'default Unit score must use the loaded production artifact')

const changed = structuredClone(onDisk)
changed.lambda += 0.02
const changedScore = scoreUnitWithWeights(feat, validateV5MicroWeights(changed))
assert.notEqual(changedScore.v, defaultUnitScore.v, 'explicit candidate weights must affect JS Unit scoring')
const longerUnitScore = scoreUnitWithWeights({ ...feat, tok: feat.tok + 10 }, reloaded)
assert.ok(longerUnitScore.v < explicitUnitScore.v, 'the production JS Unit score must include its token-length penalty')

const gateFeature = {
  ...feat,
  vec: feat.vec.map((value, index) => index === 9 ? 0 : index === 15 ? 0.1 : value),
  temptationT: 0,
  cueExcluded: 0.1,
}
const gateWeights = structuredClone(onDisk)
gateWeights.mlpHead.WTempt = gateWeights.mlpHead.WTempt.map(() => 0)
gateWeights.temptationMin = 0.18
const noGateWeights = { ...gateWeights, temptationMin: 0 }
const gated = scoreUnitWithWeights(gateFeature, gateWeights)
const ungated = scoreUnitWithWeights(gateFeature, noGateWeights)
assert.ok(gated.probs.EXCLUDED < ungated.probs.EXCLUDED, 'EXCLUDED suppression must affect the actual JS slot probabilities')

const draft = '我们需要根据这条观察改 src/compiler.js 的 `scoreUnitWithWeights`；验收是 `npm test`。'
const prefFeatures = extractDraftPrefFeatures(draft, raw, ctx.toolText)
assert.deepEqual(Object.keys(prefFeatures).sort(), [...V5_PREF_FEATURE_NAMES].sort())
assert.equal(
  scoreDraftPreference(draft, raw, ctx.toolText, reloaded),
  scoreDraftPreferenceFeatures(prefFeatures, reloaded),
  'draft text scoring and serialized-feature scoring must share the same JS head',
)

assert.throws(() => validateV5MicroWeights({ ...onDisk, featureNames: ['stale-feature-order'] }), /feature-order/)
assert.throws(() => validateV5MicroWeights({ ...onDisk, valueWeights: [1, 2] }), /valueWeights/)

const compiledDefault = compileV5Local(raw, { compressCtx: ctx.toolText })
const compiledExplicit = compileV5Local(raw, { compressCtx: ctx.toolText, microWeights: reloaded })
assert.equal(compiledDefault.meta.promptVersion, 'compress-v5-local:' + V5_LOCAL_VERSION)
assert.equal(compiledDefault.meta.weightsDigest, V5_MICRO_WEIGHTS_DIGEST)
assert.equal(compiledDefault.meta.weightsSchema, V5_MICRO_WEIGHTS.schema)
assert.equal(compiledExplicit.meta.weightsDigest, fingerprintV5MicroWeights(reloaded))
assert.equal(compiledDefault.text, compiledExplicit.text, 'compileV5Local must default to the production JSON weights')
assert.deepEqual(
  { ...compiledDefault.meta, localMs: null },
  { ...compiledExplicit.meta, localMs: null },
  'runtime metadata must match apart from measured wall-clock latency',
)

console.log('micro-runtime: production JSON loading, schema validation, JS Unit/Draft scoring, and compileV5Local default path passed')
console.log('PASS=29 FAIL=0')
