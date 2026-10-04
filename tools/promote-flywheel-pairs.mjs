#!/usr/bin/env node
// tools/promote-flywheel-pairs.mjs —— 把本地真实采集的飞轮偏好对（.cfb-offline/train/pairs.jsonl）
// 提升为**可入库**的 dev-only 回退文件 transfer/models/dev-flywheel-pairs.json。
//
// 为什么需要它：
//   1. Kaggle checkout 里没有 .cfb-offline/train/pairs.jsonl（gitignored），构建器只能读回退文件；
//   2. 旧回退文件是 122 条常数占位（全部 chosenScore=0.92 / rejectedScore=0.45），
//      这种「所有 pair 同一个 margin」根本不是偏好监督，只会让 Draft 头学到一个假的 γ；
//   3. 于是把真实采集、含真实分数差的 dev 对落库，让本机与 Kaggle 口径一致。
//
// 只接受 dev 家族；holdout 家族即使出现在输入里也一律丢弃（零泄漏）。
// 输出确定性：按 (task, round, source, chosenText 哈希) 排序，重复运行结果一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, '.cfb-offline/train/pairs.jsonl')
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(ROOT, 'transfer/models/dev-flywheel-pairs.json')
const HOLDOUT_FAMS = new Set(['eacces-config', 'wrong-model'])
const familyKey = (value) => String(value || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)

if (!fs.existsSync(inputPath)) {
  console.error('[promote-flywheel-pairs] input not found:', inputPath)
  process.exit(1)
}
const rawRows = fs.readFileSync(inputPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const kept = []
let droppedHoldout = 0
let droppedIncomplete = 0
for (const row of rawRows) {
  const family = familyKey(row.task || row.family || '')
  if (row.split === 'holdout' || HOLDOUT_FAMS.has(family)) { droppedHoldout++; continue }
  const chosenText = row.chosenText || (typeof row.chosen === 'string' ? row.chosen : row.chosen?.draft)
  const rejectedText = row.rejectedText || (typeof row.rejected === 'string' ? row.rejected : row.rejected?.draft)
  if (!chosenText || !rejectedText) { droppedIncomplete++; continue }
  let chosenScore = Number.isFinite(row.chosenScore) ? row.chosenScore : null
  let rejectedScore = Number.isFinite(row.rejectedScore) ? row.rejectedScore : null
  if (chosenScore == null || rejectedScore == null) {
    const candidateScore = Number(row.scores?.candidate)
    const controlScore = Number(row.scores?.control)
    if (Number.isFinite(candidateScore) && Number.isFinite(controlScore)) {
      // flywheel 采集语义：scores.candidate = 较高分（即 chosen），scores.control = 较低分（即 rejected）
      chosenScore = Math.max(candidateScore, controlScore)
      rejectedScore = Math.min(candidateScore, controlScore)
    }
  }
  const scoreMargin = chosenScore == null || rejectedScore == null ? null : +(chosenScore - rejectedScore).toFixed(4)
  kept.push({
    schema: 'cfb.flywheel-pair/1',
    task: family,
    family,
    round: Number.isFinite(row.round) ? row.round : null,
    source: row.source || null,
    chosenArm: row.chosenArm ?? null,
    rejectedArm: row.rejectedArm ?? null,
    chosenScore,
    rejectedScore,
    scoreMargin,
    trainingEligibleHint: scoreMargin != null && scoreMargin >= 0.05,
    provenance: {
      inputFile: path.relative(ROOT, inputPath),
      collectedAt: row.at || null,
      chosenTextSha256_16: sha(chosenText),
      rejectedTextSha256_16: sha(rejectedText),
    },
    chosenText,
    rejectedText,
  })
}
kept.sort((a, b) => String(a.task).localeCompare(String(b.task))
  || (a.round ?? 0) - (b.round ?? 0)
  || String(a.source || '').localeCompare(String(b.source || ''))
  || a.provenance.chosenTextSha256_16.localeCompare(b.provenance.chosenTextSha256_16))
const distinctScorePairs = new Set(kept.map((row) => `${row.chosenScore}|${row.rejectedScore}`))
const byTask = {}
for (const row of kept) byTask[row.task] = (byTask[row.task] || 0) + 1
const document = {
  schema: 'cfb.dev-flywheel-pairs/2',
  note: 'dev-only 真实飞轮偏好对（提升自 .cfb-offline/train/pairs.jsonl）。此前的常数占位版本（全部 0.92/0.45）已被替换：常数 margin 不构成偏好监督。',
  generatedBy: 'tools/promote-flywheel-pairs.mjs',
  sourceFile: path.relative(ROOT, inputPath),
  holdoutExcluded: true,
  pairCount: kept.length,
  distinctScorePairs: distinctScorePairs.size,
  byTask,
  dropped: { holdoutRows: droppedHoldout, incompleteRows: droppedIncomplete },
  pairs: kept,
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n')
console.log('[promote-flywheel-pairs] written:', path.relative(ROOT, outputPath))
console.log(JSON.stringify({
  pairCount: document.pairCount,
  distinctScorePairs: document.distinctScorePairs,
  byTask,
  dropped: document.dropped,
}, null, 2))
