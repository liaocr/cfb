#!/usr/bin/env node
// tools/train-v5-micro.mjs —— 严格在 dev 集（7 条 dev Gold + 3 条 dev Pool + dev 飞轮偏好对）上训练
//   v5 本地认知微模型参数（Head 1 槽位分类 + Head 2 条目价值 + Head 3 偏好排序），
//   全程 0 接触 holdout（eacces-config / wrong-model）进行拟合；完整尺子（dd + G1 + G2）随后也检查既有 holdout，但它并非全新盲测。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  V5_MICRO_WEIGHTS, SLOT_NAMES, extractAnchorsV5, splitDiscourseUnits,
  extractUnitFeatures, scoreUnitWithWeights, extractDraftPrefFeatures, compileV5Local,
} from '../src/compile-v5-local.js'
import { birthOffline, offlineBirthConfig } from '../src/offline-birth.js'
import { normalizeConfig } from '../src/config.js'
import { slotsOf, draftDistance, handDraftGate } from './helpers/hand-draft.mjs'
import { loadGold, goldUse } from './helpers/three-mode.mjs'
import { loadTrajTrainingSamples, rulerIdSet } from './helpers/traj-corpus.mjs'
import { auditMode1Output, isMode1GoldEligible, isMode1PairEligible } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOLDOUT_FAMS = new Set(['eacces-config', 'wrong-model'])
const DEV_FAMS = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
const familyKey = (value) => String(value || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')
const isHoldout = (fam) => HOLDOUT_FAMS.has(familyKey(fam))

function loadAllGold(root = ROOT) {
  return loadGold(path.join(root, 'transfer', 'gold')).filter((g) => isMode1GoldEligible(g) && g.qualityAudit?.status === 'clean').map((g) => ({
    ...g,
    hand: g.draft || g.gold || g.hand || '',
    split: g.split || (isHoldout(g.family) ? 'holdout' : 'unassigned'),
  }))
}

const dot = (w, x) => { let s = 0; for (let i = 0; i < Math.min(w.length, x.length); i++) s += w[i] * x[i]; return s }
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))))

function labelUnitByGoldSlots(unit, goldSlots) {
  const uIds = extractAnchorsV5(unit)
  const overlapWith = (lines) => {
    const gIds = extractAnchorsV5((lines || []).join('\n'))
    if (!gIds.size || !uIds.size) return 0
    let hit = 0
    for (const id of uIds) if (gIds.has(id)) hit++
    return hit / Math.max(1, Math.min(uIds.size, gIds.size))
  }
  const sDec = overlapWith([...goldSlots.decided, ...goldSlots.triples.map((t) => t.oldText + ' ' + t.newText)])
  const sEx = overlapWith(goldSlots.excluded)
  const sAcc = overlapWith(goldSlots.accept)
  const sOp = overlapWith(goldSlots.open)

  if (/(?:改法只落|改法分|old_text|new_text|edit_file|改成|改为|改回)/.test(unit) && sDec >= 0.25) return { slot: 'DECIDED', yVal: 1.0 }
  if (/(?:已排除|排除|诱饵|legacy|compat|不用改|不改|不是.*原因|repro\.tmp)/.test(unit) && sEx >= 0.2) return { slot: 'EXCLUDED', yVal: 0.88 }
  if (/(?:验收|预期|不算证据|若.*仍|如果输出跟这两种都不像)/.test(unit) && sAcc >= 0.2) return { slot: 'ACCEPT', yVal: 0.85 }
  if (/(?:未解|回放过了之后|汇总.*收工|确认.*通过)/.test(unit) && sOp >= 0.2) return { slot: 'OPEN', yVal: 0.80 }
  if (sDec >= 0.45) return { slot: 'DECIDED', yVal: 0.92 }
  if (sEx >= 0.40) return { slot: 'EXCLUDED', yVal: 0.82 }
  if (sAcc >= 0.40) return { slot: 'ACCEPT', yVal: 0.80 }
  if (sOp >= 0.40) return { slot: 'OPEN', yVal: 0.75 }
  if (uIds.size >= 2 && unit.length >= 18 && !/^\s*(?:Let me|Hmm|Wait,\s*$)/i.test(unit)) return { slot: 'MECHANISM', yVal: 0.55 }
  return { slot: 'NOISE', yVal: 0.05 }
}

function trainMicroModelOnDev() {
  const allGold = loadAllGold(ROOT)
  // 用途隔离（v14.21.0）：use=ruler 的条目只做标尺，不进拟合；训练料改由 traj 手稿通道（loadTrajTrainingSamples）供
  const devGold = allGold.filter((g) => g.split === 'dev' && DEV_FAMS.has(familyKey(g.family)) && !isHoldout(g.family) && goldUse(g) !== 'ruler')
  const oracleD2c = JSON.parse(fs.readFileSync(path.join(ROOT, 'transfer/mr/oracle-d2c.json'), 'utf8'))
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/gen-2.pack.json'), 'utf8'))
  const devPool = (pack.pool?.tasks || []).filter((t) => t.split === 'dev' && DEV_FAMS.has(familyKey(t.id)) && !isHoldout(t.id))
  if (pack.pool === undefined) console.log('  ⚠ gen-2.pack.json 无 pool 键（顶层是 devTasks/trajEvidence）⇒ devPool 恒为 0：结构错配，不是数据为空（见 docs/GOLD-EXPANSION-PROGRAM.md §1）')

  // v14.21.0 训练料通道：注册表默认全是标尺料（use=ruler），拟合料改从模式 1 手稿轨迹取（trainingEligible + audit clean）。
  //   命中任一标尺 id ⇒ loadTrajTrainingSamples 直接抛 ruler-leakage-into-train，不做「悄悄跳过」。
  const registryGold = loadGold(path.join(ROOT, 'transfer', 'gold'))
  const rulerIds = rulerIdSet(registryGold)
  const traj = loadTrajTrainingSamples({ root: ROOT, rulerIds })
  const trainDocs = [...devGold, ...traj.samples]
  // 结果级 fail-closed：拟合集里只要混进标尺侧 id 就是泄漏（剔除逻辑若被改坏，这里兜住）
  const leaked = trainDocs.map((g) => g.id).filter((id) => rulerIds.has(id))
  if (leaked.length) throw new Error('ruler-leakage-into-train:' + leaked.join(','))

  // 1. 构造 dev 句子级训练样本（严格只用 devGold + traj 训练料 + devPool）
  const unitSamples = []
  for (const g of trainDocs) {
    const goldSlots = slotsOf(g.hand)
    const units = splitDiscourseUnits(g.raw)
    const targetAnchors = extractAnchorsV5(g.raw.slice(Math.floor(g.raw.length * 0.65)))
    const ctxInfo = { raw: g.raw, toolText: g.ctx, targetAnchors, offsets: [] }
    units.forEach((u, i) => {
      const feat = extractUnitFeatures(u, i, units.length, ctxInfo)
      const lbl = labelUnitByGoldSlots(u, goldSlots)
      unitSamples.push({ x: feat.vec, slot: lbl.slot, yVal: lbl.yVal })
    })
  }
  for (const t of devPool) {
    const o = oracleD2c.tasks?.[t.id]?.rounds?.[2]
    if (!o?.oracle || auditMode1Output(o.oracle).status !== 'clean') continue
    const goldSlots = slotsOf(o.oracle)
    const units = splitDiscourseUnits(t.raw)
    const targetAnchors = extractAnchorsV5(t.raw.slice(Math.floor(t.raw.length * 0.65)))
    const ctxInfo = { raw: t.raw, toolText: t.ctx, targetAnchors, offsets: [] }
    units.forEach((u, i) => {
      const feat = extractUnitFeatures(u, i, units.length, ctxInfo)
      const lbl = labelUnitByGoldSlots(u, goldSlots)
      unitSamples.push({ x: feat.vec, slot: lbl.slot, yVal: lbl.yVal })
    })
  }

  // 2. 在 dev 样本上以理论先验为锚点做 L2 正则化梯度下降（MAP 估计）
  const priorVal = [...V5_MICRO_WEIGHTS.valueWeights]
  const valW = [...priorVal]
  const slotW = {}
  for (const s of SLOT_NAMES) slotW[s] = [...V5_MICRO_WEIGHTS.slotWeights[s]]

  const lr = 0.015, l2Prior = 0.25, epochs = 120
  for (let ep = 0; ep < epochs; ep++) {
    for (const smp of unitSamples) {
      // Head 2: value regression
      const predV = sigmoid(dot(valW, smp.x))
      const errV = predV - smp.yVal
      for (let j = 0; j < valW.length; j++) {
        valW[j] -= lr * (errV * smp.x[j] + l2Prior * (valW[j] - priorVal[j])) / unitSamples.length
      }
      // Head 1: 6-class softmax
      let maxL = -Infinity
      const logits = {}
      for (const s of SLOT_NAMES) {
        logits[s] = dot(slotW[s], smp.x)
        if (logits[s] > maxL) maxL = logits[s]
      }
      let sumE = 0
      const probs = {}
      for (const s of SLOT_NAMES) { probs[s] = Math.exp(logits[s] - maxL); sumE += probs[s] }
      for (const s of SLOT_NAMES) {
        const p = probs[s] / sumE
        const y = s === smp.slot ? 1 : 0
        const g = p - y
        for (let j = 0; j < slotW[s].length; j++) {
          slotW[s][j] -= lr * (g * smp.x[j] + l2Prior * (slotW[s][j] - V5_MICRO_WEIGHTS.slotWeights[s][j])) / unitSamples.length
        }
      }
    }
  }

  // 3. 在 dev 飞轮偏好对（过滤掉 holdout 家族）上训练 Head 3 偏好排序权重
  const fwPath = path.join(ROOT, '.cfb-offline/train/pairs.jsonl')
  const fwLines = fs.existsSync(fwPath) ? fs.readFileSync(fwPath, 'utf8').trim().split('\n').filter(Boolean) : []
  const flywheelText = (p, side) => p[`${side}Text`] || (typeof p[side] === 'string' ? p[side] : p[side]?.draft) || ''
  const devPairs = fwLines.map((l) => JSON.parse(l)).filter((p) => {
    const fam = familyKey(p.task || p.taskId || p.family || '')
    const chosen = flywheelText(p, 'chosen'), rejected = flywheelText(p, 'rejected')
    return p.split === 'dev' && !isHoldout(fam) && DEV_FAMS.has(fam)
      && chosen && rejected && isMode1PairEligible({ ...p, chosenText: chosen, rejectedText: rejected }, { requireRecorded: true })
  })

  const prefKeys = Object.keys(V5_MICRO_WEIGHTS.prefWeights)
  const priorPref = prefKeys.map((k) => V5_MICRO_WEIGHTS.prefWeights[k])
  const prefVec = [...priorPref]

  for (let ep = 0; ep < 80; ep++) {
    for (const pair of devPairs) {
      const cText = pair.chosenText || (typeof pair.chosen === 'string' ? pair.chosen : pair.chosen.draft)
      const rText = pair.rejectedText || (typeof pair.rejected === 'string' ? pair.rejected : pair.rejected.draft)
      const fc = extractDraftPrefFeatures(cText, '', '')
      const fr = extractDraftPrefFeatures(rText, '', '')
      const diff = prefKeys.map((k) => (fc[k] || 0) - (fr[k] || 0))
      const margin = dot(prefVec, diff)
      const pWin = sigmoid(margin)
      const grad = pWin - 1.0
      for (let j = 0; j < prefVec.length; j++) {
        prefVec[j] -= 0.02 * (grad * diff[j] + 0.2 * (prefVec[j] - priorPref[j])) / Math.max(1, devPairs.length)
      }
    }
  }

  let pairCorrect = 0
  for (const pair of devPairs) {
    const cText = pair.chosenText || (typeof pair.chosen === 'string' ? pair.chosen : pair.chosen.draft)
    const rText = pair.rejectedText || (typeof pair.rejected === 'string' ? pair.rejected : pair.rejected.draft)
    const fc = extractDraftPrefFeatures(cText, '', '')
    const fr = extractDraftPrefFeatures(rText, '', '')
    const diff = prefKeys.map((k) => (fc[k] || 0) - (fr[k] || 0))
    if (dot(prefVec, diff) >= 0) pairCorrect++
  }

  const trained = {
    ...V5_MICRO_WEIGHTS,
    trainedOn: `dev-only (${devGold.length} gold:dev + ${traj.samples.length} traj:train + ${devPool.length} pool:dev + ${devPairs.length} flywheel:dev)`,
    // 用途隔离回执（v14.21.0）：标尺侧条目数 / 进训练的 traj 料数 / 泄漏检查结果（rulerLeakage 必须为 0）
    trainCorpus: {
      goldTrainDocs: devGold.length,
      trajTrainDocs: traj.samples.length,
      trajRevisionPairs: traj.pairs.length,
      rulerIdsInRegistry: rulerIds.size,
      skippedAsRuler: traj.stats.asRuler,
      skippedRulerIds: traj.stats.rulerIds,
      trajFiles: traj.stats.files,
      trajRows: traj.stats.rows,
      dropped: { notTrainingEligible: traj.stats.droppedIneligible, auditNotClean: traj.stats.droppedAudit, supersededRevisions: traj.stats.revised },
      rulerLeakage: 0,
    },
    holdoutTouched: false,
    trainingStats: {
      devGoldCount: devGold.length,
      devPoolCount: devPool.length,
      devUnitSamples: unitSamples.length,
      devPreferencePairs: devPairs.length,
      devPairwiseAccuracy: devPairs.length ? +(pairCorrect / devPairs.length).toFixed(4) : 1.0,
    },
    valueWeights: valW.map((v) => +v.toFixed(4)),
    slotWeights: Object.fromEntries(SLOT_NAMES.map((s) => [s, slotW[s].map((v) => +v.toFixed(4))])),
    prefWeights: Object.fromEntries(prefKeys.map((k, i) => [k, +prefVec[i].toFixed(4)])),
  }

  const outDir = path.join(ROOT, 'transfer/models')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'v5-micro-weights.json'), JSON.stringify(trained, null, 2) + '\n')
  return trained
}

async function evaluateWithRuler(trained) {
  const allGold = loadAllGold(ROOT)
  const localPolicy = {
    id: 'p-v5-local-micro',
    patches: [],
    config: { compressLocalModel: true, continuationPath: 'bounded', programParts: 'compact' },
  }
  const cfg = { ...offlineBirthConfig({ model: 'v5-micro-local', baseUrl: 'local://v5-micro', policy: localPolicy, normalizeConfig }), captureSideOutput: true, microWeights: trained }

  console.log('══ 1. 训练回执（严格 dev-only，holdout 零接触） ══')
  console.log(JSON.stringify(trained.trainingStats, null, 2))

  console.log('\n══ 2. 全量 Gold 标尺检验（dev + 此前已评测的 holdout） ══')
  const rows = []
  const latencies = []
  const memBefore = process.memoryUsage().heapUsed

  for (const g of allGold) {
    const cfgItem = g.raw.length < 3100 ? { ...cfg, birthMinSavedChars: Math.min(cfg.birthMinSavedChars || 50, Math.max(20, Math.floor(g.raw.length * 0.05))), ...(g.raw.length < 2600 ? { birthTokenGate: false } : {}) } : cfg
    const t0 = performance.now()
    const bGated = await birthOffline({ raw: g.raw, ctx: g.ctx, calls: g.calls || [], cfg: cfgItem, gate: true })
    const ms = +(performance.now() - t0).toFixed(2)
    const b = bGated.ok ? bGated : await birthOffline({ raw: g.raw, ctx: g.ctx, calls: g.calls || [], cfg: cfgItem, gate: false })
    latencies.push(ms)
    const dd = draftDistance(b.text, g.hand, { raw: g.raw, ctx: g.ctx, calls: g.calls || [] })
    const gate = handDraftGate(g.raw, b.text, g.ctx)
    rows.push({
      id: g.id,
      family: g.family,
      split: g.split,
      ms,
      rawChars: g.raw.length,
      draftChars: (b.meta?.sideOutput || '').length,
      splicedChars: b.text.length,
      g1Accept: bGated.ok,
      g1Why: bGated.why || bGated.reason || null,
      g1Info: bGated.info || null,
      g2Ok: gate.ok,
      score: dd.score,
      verdict: dd.verdict,
      slots: {
        decision: dd.decision,
        excludedRecall: dd.excludedRecall,
        acceptOk: dd.acceptOk,
        openRecall: dd.openRecall,
        anchorPrecision: dd.anchorPrecision,
        lengthOk: dd.lengthOk,
        lengthRatio: dd.lengthRatio,
      },
      resurrected: dd.resurrectedAnchors || [],
      gateReasons: gate.errors || [],
    })
  }
  const memAfter = process.memoryUsage().heapUsed
  const memDeltaKB = +((memAfter - memBefore) / 1024).toFixed(1)

  for (const r of rows) {
    console.log(
      `  [${r.split.padEnd(7)}] ${r.id.padEnd(36)} | score=${r.score.toFixed(3)} (${r.verdict}) | G1=${r.g1Accept ? '✓' : '✗'} G2=${r.g2Ok ? '✓' : '✗'} | ` +
      `dec=${r.slots.decision} ex=${r.slots.excludedRecall} acc=${r.slots.acceptOk} open=${r.slots.openRecall} prec=${r.slots.anchorPrecision} len=${r.slots.lengthOk} | ` +
      `${r.rawChars}→${r.draftChars}/${r.splicedChars} chars | ${r.ms}ms` +
      (r.g1Why ? ` | g1Why=${r.g1Why}${r.g1Info ? ':' + JSON.stringify(r.g1Info) : ''}` : '') +
      (r.gateReasons.length ? ` | gateReasons=${JSON.stringify(r.gateReasons)}` : '') +
      (r.resurrected?.length ? ` | resurrected=${JSON.stringify(r.resurrected)}` : '') +
      (r.missingEx?.length ? ` | missEx=${JSON.stringify(r.missingEx)}` : '') +
      (r.missingAcc?.length ? ` | missAcc=${JSON.stringify(r.missingAcc)}` : '') +
      (r.missingOpen?.length ? ` | missOpen=${JSON.stringify(r.missingOpen)}` : '')
    )
  }

  const devRows = rows.filter((r) => r.split === 'dev')
  const holdoutRows = rows.filter((r) => r.split === 'holdout')
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length)
  const summary = {
    totalItems: rows.length,
    devItems: devRows.length,
    holdoutItems: holdoutRows.length,
    devMeanScore: +mean(devRows.map((r) => r.score)).toFixed(4),
    holdoutMeanScore: +mean(holdoutRows.map((r) => r.score)).toFixed(4),
    overallMeanScore: +mean(rows.map((r) => r.score)).toFixed(4),
    generalizationGap: +Math.abs(mean(devRows.map((r) => r.score)) - mean(holdoutRows.map((r) => r.score))).toFixed(4),
    g1PassCount: rows.filter((r) => r.g1Accept).length,
    g2PassCount: rows.filter((r) => r.g2Ok).length,
    closeCount: rows.filter((r) => r.verdict === 'close').length,
    meanRawChars: +mean(rows.map((r) => r.rawChars)).toFixed(1),
    meanSplicedChars: +mean(rows.map((r) => r.splicedChars)).toFixed(1),
    meanSplicedToRawRatio: +mean(rows.map((r) => r.splicedChars / Math.max(1, r.rawChars))).toFixed(4),
    meanCharReductionPct: +((1 - mean(rows.map((r) => r.splicedChars / Math.max(1, r.rawChars)))) * 100).toFixed(2),
    meanMs: +mean(latencies).toFixed(2),
    maxMs: Math.max(...latencies),
    heapDeltaKB: memDeltaKB,
  }
  console.log('\n══ 3. 汇总指标（dev vs holdout 泛化检验 + 延迟/内存） ══')
  console.log({
    ...summary,
    g1PassCount: `${summary.g1PassCount}/${summary.totalItems}`,
    g2PassCount: `${summary.g2PassCount}/${summary.totalItems}`,
    closeCount: `${summary.closeCount}/${summary.totalItems}`,
  })
  return { schema: 'cfb.micro-mode2-eval/1', trainingStats: trained.trainingStats || null, summary, rows }
}

const args = process.argv.slice(2)
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const evalOnly = args.includes('--eval-only')
const weightsPath = path.resolve(ROOT, argValue('--weights-path', 'transfer/models/v5-micro-weights.json'))
const evalJsonPath = argValue('--eval-json')
if (evalOnly && !fs.existsSync(weightsPath)) {
  throw new Error(`--eval-only weights file not found: ${weightsPath}`)
}
const trained = evalOnly
  ? JSON.parse(fs.readFileSync(weightsPath, 'utf8'))
  : trainMicroModelOnDev()
const evalReport = await evaluateWithRuler(trained)
if (evalJsonPath) {
  const target = path.resolve(evalJsonPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(evalReport, null, 2) + '\n')
  console.log(`\n   ✓ 机器可读 Mode 2 报告: ${target}`)
}
