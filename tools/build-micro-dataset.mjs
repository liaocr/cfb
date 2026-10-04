#!/usr/bin/env node
// tools/build-micro-dataset.mjs —— 严格零泄漏（dev-only）构建 <0.1B (CFB-Micro) 专用出生压缩微模型数据集
//
// 产物：transfer/models/micro-dev-dataset.json
// 包含三层监督信号（holdout 家族 eacces-config / wrong-model 全程物理隔离，零接触）：
//   1. unitSamples: 话语单元级多任务监督（19维符号特征 + 原始文本 + Head A 6类槽位 + Head B 价值V/诱惑度T + Head C 跨度起止下标）
//   2. stepSimpoPairs: Step-DPO × SimPO 步级反事实偏好对（5类困难负例 + 飞轮真实偏好对 + 动态奖励间隔 γ_dd）
//   3. spanSamples: GLiNER 式并行跨度指针样本（target_file / old_text / new_text / verify_cmd 原文精确切片区间 [start, end]）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SLOT_NAMES, extractAnchorsV5, splitDiscourseUnits,
  extractUnitFeatures, extractDraftPrefFeatures, buildGroundedHay, scoreUnitWithWeights,
} from '../src/compile-v5-local.js'
import { slotsOf, draftDistance, handDraftGate } from './helpers/hand-draft.mjs'
import { loadGold } from './helpers/three-mode.mjs'
import { buildPool } from './helpers/tasks.mjs'
import { productionContext } from './helpers/candidates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOLDOUT_FAMS = new Set(['eacces-config', 'wrong-model'])
const familyKey = (value) => String(value || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')
const isHoldout = (family) => HOLDOUT_FAMS.has(familyKey(family))
// v14.20 数据集构造策略（可用环境变量覆盖；默认 = hardened 困难负例，见 docs/TRAINING-AND-BENCHMARK.md §6.2）
//   hardened：负例优先「与正例长度接近」+「当前生产打分最高（模型最难）」；legacy：仅按旧 hardness 排序。
const NEG_STRATEGY = process.env.CFB_MICRO_NEG_STRATEGY || 'hardened'
const UNIT_PAIR_MAX_ENDPOINT_DEGREE = Number(process.env.CFB_MICRO_PAIR_DEGREE_CAP || 3)
const UNIT_PAIR_MAX_PER_POSITIVE = Number(process.env.CFB_MICRO_PAIR_PER_POSITIVE || 3)
const NEAR_LENGTH_TOKENS = Number(process.env.CFB_MICRO_NEAR_LENGTH_TOKENS || 3)
const countBy = (rows, keyOf) => {
  const counts = new Map()
  for (const row of rows) {
    const key = keyOf(row) || 'unknown'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
}

function loadAllGold(root = ROOT) {
  return loadGold(path.join(root, 'transfer', 'gold')).map((g) => ({
    ...g,
    hand: g.draft || g.gold || g.hand || '',
    split: g.split || (isHoldout(g.family) ? 'holdout' : 'dev'),
  }))
}

function labelUnitMultiTask(unit, feat, goldSlots) {
  const uIds = extractAnchorsV5(unit)
  const overlapWith = (lines) => {
    const gIds = extractAnchorsV5((lines || []).join('\n'))
    const matched = [...uIds].filter((id) => gIds.has(id)).sort()
    return {
      score: !gIds.size || !uIds.size ? 0 : matched.length / Math.max(1, Math.min(uIds.size, gIds.size)),
      matchedAnchors: matched,
      unitCoverage: uIds.size ? matched.length / uIds.size : 0,
      goldCoverage: gIds.size ? matched.length / gIds.size : 0,
      goldAnchorCount: gIds.size,
    }
  }
  const overlap = {
    DECIDED: overlapWith([...goldSlots.decided, ...goldSlots.triples.map((t) => t.oldText + ' ' + t.newText)]),
    EXCLUDED: overlapWith(goldSlots.excluded),
    ACCEPT: overlapWith(goldSlots.accept),
    OPEN: overlapWith(goldSlots.open),
  }
  const sDec = overlap.DECIDED.score
  const sEx = overlap.EXCLUDED.score
  const sAcc = overlap.ACCEPT.score
  const sOp = overlap.OPEN.score
  const cue = {
    DECIDED: /(?:改法只落|改法分|old_text|new_text|edit_file|改成|改为|改回)/.test(unit),
    EXCLUDED: /(?:已排除|排除|诱饵|legacy|compat|不用改|不改|不是.*原因|repro\.tmp)/.test(unit),
    ACCEPT: /(?:验收|预期|不算证据|若.*仍|如果输出跟这两种都不像)/.test(unit),
    OPEN: /(?:未解|回放过了之后|汇总.*收工|确认.*通过)/.test(unit),
  }

  let slot = 'NOISE'
  let yVal = 0.05
  let yTempt = feat.temptationT || 0.05
  let labelRule = 'no-slot-cue-or-gold-anchor'

  if (cue.DECIDED && sDec >= 0.25) {
    slot = 'DECIDED'; yVal = 1.0; yTempt = 0.10; labelRule = 'decision-cue-plus-gold-overlap'
  } else if (cue.EXCLUDED && sEx >= 0.2) {
    slot = 'EXCLUDED'; yVal = 0.90; yTempt = Math.max(0.75, feat.temptationT); labelRule = 'excluded-cue-plus-gold-overlap'
  } else if (cue.ACCEPT && sAcc >= 0.2) {
    slot = 'ACCEPT'; yVal = 0.86; yTempt = 0.12; labelRule = 'acceptance-cue-plus-gold-overlap'
  } else if (cue.OPEN && sOp >= 0.2) {
    slot = 'OPEN'; yVal = 0.80; yTempt = 0.10; labelRule = 'open-cue-plus-gold-overlap'
  } else if (sDec >= 0.45) {
    slot = 'DECIDED'; yVal = 0.92; yTempt = 0.12; labelRule = 'gold-overlap-decided'
  } else if (sEx >= 0.40) {
    slot = 'EXCLUDED'; yVal = 0.84; yTempt = Math.max(0.72, feat.temptationT); labelRule = 'gold-overlap-excluded'
  } else if (sAcc >= 0.40) {
    slot = 'ACCEPT'; yVal = 0.80; yTempt = 0.10; labelRule = 'gold-overlap-acceptance'
  } else if (sOp >= 0.40) {
    slot = 'OPEN'; yVal = 0.75; yTempt = 0.10; labelRule = 'gold-overlap-open'
  } else if (uIds.size >= 2 && unit.length >= 18 && !/^\s*(?:Let me|Hmm|Wait,\s*$)/i.test(unit)) {
    slot = 'MECHANISM'; yVal = 0.58; yTempt = Math.min(0.35, feat.temptationT); labelRule = 'mechanism-heuristic-only'
  }

  // 反激活（Negative Priming）硬监督：仅保留原规则，不把上下文里未被 hand 标为排除的文件误标为疫苗。
  if (slot !== 'EXCLUDED' && /(?:verify\.mjs|package\.json|README\.md)/.test(unit) && sEx < 0.15) yTempt = 0.02

  const ranked = Object.entries(overlap).sort((a, b) => b[1].score - a[1].score)
  const supported = overlap[slot]
  const otherSupported = ranked.filter(([name, v]) => name !== slot && v.score >= 0.2)
  const flags = []
  if (slot === 'MECHANISM') flags.push('mechanism-heuristic-no-direct-gold-slot')
  if (slot === 'NOISE' && Object.values(overlap).some((v) => v.score >= 0.2)) flags.push('noise-label-has-gold-overlap')
  if (slot === 'NOISE' && Object.values(cue).some(Boolean)) flags.push('noise-label-has-actionable-cue')
  if (['DECIDED', 'EXCLUDED', 'ACCEPT', 'OPEN'].includes(slot) && (!supported || supported.score < 0.2 || supported.matchedAnchors.length === 0)) flags.push('weak-gold-anchor-support')
  if (otherSupported.some(([, v]) => !supported || Math.abs(v.score - supported.score) <= 0.10)) flags.push('competing-slot-overlap')
  const labelConfidence = flags.length ? 'review' : 'rule-supported'

  return {
    slot,
    slotIdx: SLOT_NAMES.indexOf(slot),
    yVal: +yVal.toFixed(4),
    yTempt: +yTempt.toFixed(4),
    trainingEligible: labelConfidence === 'rule-supported',
    labelAudit: {
      source: 'deterministic-gold-slot-anchor-rules',
      labelRule,
      status: labelConfidence,
      flags,
      cue,
      overlap,
      unitAnchorCount: uIds.size,
    },
  }
}

function extractSpanPointers(raw, ctx, hand) {
  const combined = String(raw || '') + '\n' + String(ctx || '')
  const slots = slotsOf(hand)
  const spans = []

  // 1. target_file spans
  const fileMatches = [...hand.matchAll(/\b(?:src|test|scripts|docs|logs|ci)\/[\w./-]+\.(?:m?js|json|md|log)\b/g)]
  const seenFiles = new Set()
  for (const m of fileMatches) {
    const f = m[0]
    if (seenFiles.has(f)) continue
    seenFiles.add(f)
    const idx = combined.indexOf(f)
    if (idx >= 0) {
      const isTarget = slots.decided.some((d) => d.includes(f))
      spans.push({
        type: isTarget ? 'target_file' : 'excluded_or_context_file',
        text: f,
        startChar: idx,
        endChar: idx + f.length,
        label: isTarget ? 1 : 0,
      })
    }
  }

  // 2. old_text & new_text triples
  for (const t of slots.triples) {
    if (t.oldText) {
      const idx = combined.indexOf(t.oldText)
      if (idx >= 0) {
        spans.push({ type: 'old_text', text: t.oldText, startChar: idx, endChar: idx + t.oldText.length, label: 1 })
      }
    }
    if (t.newText) {
      const idx = combined.indexOf(t.newText)
      if (idx >= 0) {
        spans.push({ type: 'new_text', text: t.newText, startChar: idx, endChar: idx + t.newText.length, label: 1 })
      }
    }
  }

  // 3. verify_cmd spans
  for (const accLine of slots.accept) {
    for (const m of accLine.matchAll(/`([^`\n]{6,120})`/g)) {
      const cmd = m[1]
      const idx = combined.indexOf(cmd)
      if (idx >= 0 && /(?:node|npm|taskset|analyze-trace|grep|bash)/.test(cmd)) {
        spans.push({ type: 'verify_cmd', text: cmd, startChar: idx, endChar: idx + cmd.length, label: 1 })
      }
    }
  }
  return spans
}

/**
 * 为每条合格金标自动构造 5 类 Step-DPO × SimPO 步级反事实困难负例（Hard Negatives）
 */
function buildStepSimpoCounterfactuals(item) {
  const { id, family, raw, ctx, hand, calls = [] } = item
  const pairs = []
  const hay = buildGroundedHay(raw, ctx)
  const baseDd = draftDistance(hand, hand, { raw, ctx, calls })
  const basePref = extractDraftPrefFeatures(hand, raw, ctx, hay.anchors)

  const addPair = (negType, rejectedText, description) => {
    if (!rejectedText || rejectedText === hand) return
    const dd = draftDistance(rejectedText, hand, { raw, ctx, calls })
    const gate = handDraftGate(raw, rejectedText, ctx)
    const rejPref = extractDraftPrefFeatures(rejectedText, raw, ctx, hay.anchors)
    // 动态奖励间隔 γ_dd ∈ [0.35, 1.25]
    const rawMargin = Math.max(0.35, (baseDd.score - dd.score) + (gate.ok ? 0 : 0.35))
    const gammaDd = +Math.min(1.25, rawMargin).toFixed(4)
    const scoreMargin = baseDd.score - dd.score
    const trainingEligible = !gate.ok && scoreMargin > 1e-6
    pairs.push({
      id: `${id}::${negType}`,
      sourceId: id,
      family,
      negType,
      description,
      chosenText: hand,
      rejectedText,
      chosenScore: +baseDd.score.toFixed(4),
      rejectedScore: +dd.score.toFixed(4),
      rejectedGateOk: gate.ok,
      trainingEligible,
      labelAudit: {
        status: trainingEligible ? 'rule-supported' : 'needs-review',
        source: 'gold-vs-deterministic-counterfactual',
        scoreMargin: +scoreMargin.toFixed(4),
        gateRejected: !gate.ok,
        reason: trainingEligible ? null : (gate.ok ? 'rejected-draft-passes-hard-gate' : 'no-positive-distance-margin'),
      },
      gammaDd,
      chosenPref: basePref,
      rejectedPref: rejPref,
    })
  }

  // 类型 1：反激活负例（Negative Priming —— 塞入低诱惑休眠文件或诱发打转的命令）
  const negPrimingDraft = hand.replace(
    /已排除：/,
    '已排除：先运行 `node verify.mjs` 全面排查所有测试套件或反复执行 `taskset -c 0 node test/hedge.selftest.mjs` 观察 50 次循环日志；已排除：'
  )
  addPair('neg_priming_injection', negPrimingDraft, '注入低诱惑休眠命令触发主模型反激活（Negative Priming）')

  // 类型 2：漏排除高诱惑死路负例（Missing Excluded Dead-End）
  const noExcludedDraft = hand
    .split('\n')
    .filter((line) => !/^\s*已排除[：:]/.test(line))
    .join('\n')
  addPair('missing_high_tempt_excluded', noExcludedDraft, '删除已证伪的高诱惑死路导致下一轮死路复活')

  // 类型 3：跨度指针边界偏移与无出处标识符负例（Span Boundary Shift & Hallucinated Identifier）
  const corruptedSpanDraft = hand
    .replace(/old_text\s*(?:是|为)\s*`([^`]+)`/, (_, s) => `old_text 是 \`${s.slice(0, Math.max(3, Math.floor(s.length * 0.6)))}_ungrounded_var\``)
    .replace(/改法只落一个[：:]/, '改法只落一个：先检查 `ungrounded_helper_module.js` 的导出接口，')
  addPair('span_boundary_corruption', corruptedSpanDraft, '破坏 old_text 跨度指针边界并引入无出处标识符')

  // 类型 4：机械伪验收提示污染负例（Mechanical Hint Pollution before Fix）
  const mechHintDraft = hand + '\n\n注意：验证前先触发一次运行产生新记录，若读到旧行先清空日志再测，不要立即修改代码。'
  addPair('mechanical_hint_pollution', mechHintDraft, '在未改代码前混入机械伪验收提示导致延迟修改')

  // 类型 5：拆轮与丢失逃生条件负例（Split-Turn & Missing Escape Clause）
  const splitTurnDraft = hand
    .replace(/如果输出跟这两种都不像，先别改，把不一样的地方看清再说。?/g, '')
    .replace(/直接发两条调用|本轮一起发出的/g, '本轮只看文件暂不修改，留到后续轮次再考虑')
  addPair('split_turn_and_no_escape', splitTurnDraft, '拆散同轮 edit_file+bash 闭合动作并丢弃反事实逃生分支')

  return pairs
}

export function buildMicroDataset() {
  const allGold = loadAllGold(ROOT)
  const devGold = allGold.filter((g) => g.split === 'dev' && !isHoldout(g.family))
  const holdoutGold = allGold.filter((g) => g.split === 'holdout' || isHoldout(g.family))
  const oracleD2c = JSON.parse(fs.readFileSync(path.join(ROOT, 'transfer/mr/oracle-d2c.json'), 'utf8'))
  const oracleM = JSON.parse(fs.readFileSync(path.join(ROOT, 'transfer/oracle/M.json'), 'utf8'))
  const oracleMap = new Map()
  for (const r of oracleD2c.rows || []) if (r.id && r.text) oracleMap.set(r.id, r.text)
  for (const r of oracleM.rows || []) if (r.id && r.text && !oracleMap.has(r.id)) oracleMap.set(r.id, r.text)
  const pool = buildPool()
  const devPool = (pool.tasks || []).filter((t) => t.split === 'dev' && !isHoldout(t.id))

  const unitSamples = []
  const spanSamples = []
  const stepSimpoPairs = []
  const unitStepPairs = []

  const anchorJaccard = (a, b) => {
    const aa = extractAnchorsV5(a)
    const bb = extractAnchorsV5(b)
    if (!aa.size || !bb.size) return 0
    let intersection = 0
    for (const id of aa) if (bb.has(id)) intersection++
    return intersection / (aa.size + bb.size - intersection)
  }
  const pairDegree = new Map()
  const buildDocUnitPairs = (docId, fam, docUnits) => {
    const positives = docUnits.filter((u) => u.trainingEligible && ((u.slot !== 'NOISE' && u.yVal >= 0.75) || (u.slot === 'MECHANISM' && u.features[1] >= 0.7)))
    const negatives = docUnits.filter((u) => u.trainingEligible && u.slot === 'NOISE' && u.yVal <= 0.10)
    const localDegree = new Map()
    const degree = (idx) => localDegree.get(idx) || 0
    // 困难负例策略：长度接近（|Δtoken| 小）优先 → 生产打分最高的负例（模型最难）→ 旧 hardness。
    const negScoreCache = new Map()
    const modelScoreOf = (neg) => {
      if (negScoreCache.has(neg.globalIdx)) return negScoreCache.get(neg.globalIdx)
      let score = 0
      try {
        score = scoreUnitWithWeights({
          vec: neg.features,
          tok: Number.isFinite(neg.tokenCount) ? neg.tokenCount : 0,
          temptationT: neg.temptationT ?? neg.features[9],
          cueExcluded: neg.features[15],
        }).v
      } catch { score = 0 }
      negScoreCache.set(neg.globalIdx, score)
      return score
    }
    const candidatesFor = (pos) => negatives
      .filter((neg) => degree(neg.globalIdx) < UNIT_PAIR_MAX_ENDPOINT_DEGREE)
      .map((neg) => {
        const semanticOverlap = anchorJaccard(pos.text, neg.text)
        const lengthSimilarity = Math.exp(-Math.abs(Math.log((pos.text.length + 1) / (neg.text.length + 1))))
        const lengthGap = Math.abs((pos.tokenCount || 0) - (neg.tokenCount || 0))
        return {
          neg,
          hardness: 0.75 * semanticOverlap + 0.25 * lengthSimilarity,
          lengthGap,
          lengthMatch: lengthGap <= NEAR_LENGTH_TOKENS ? 1 : 0,
          modelScore: modelScoreOf(neg),
        }
      })
      .sort((a, b) => {
        if (NEG_STRATEGY === 'legacy') {
          return degree(a.neg.globalIdx) - degree(b.neg.globalIdx)
            || b.hardness - a.hardness
            || a.neg.globalIdx - b.neg.globalIdx
        }
        return degree(a.neg.globalIdx) - degree(b.neg.globalIdx)
          || b.lengthMatch - a.lengthMatch
          || b.modelScore - a.modelScore
          || b.hardness - a.hardness
          || a.neg.globalIdx - b.neg.globalIdx
      })
    let pairCount = 0
    for (let round = 0; round < UNIT_PAIR_MAX_PER_POSITIVE; round++) {
      const ordered = [...positives].sort((a, b) => degree(a.globalIdx) - degree(b.globalIdx) || a.globalIdx - b.globalIdx)
      for (const pos of ordered) {
        if (degree(pos.globalIdx) >= UNIT_PAIR_MAX_ENDPOINT_DEGREE) continue
        const candidate = candidatesFor(pos)[0]
        if (!candidate) continue
        const { neg, hardness, lengthGap, lengthMatch, modelScore } = candidate
        const gammaStep = +Math.max(0.35, Math.min(1.0, pos.yVal - neg.yVal)).toFixed(4)
        unitStepPairs.push({
          sourceId: docId,
          family: fam,
          winIdx: pos.globalIdx,
          loseIdx: neg.globalIdx,
          winSlot: pos.slot,
          loseSlot: neg.slot,
          gammaStep,
          hardness: +hardness.toFixed(4),
          hardnessMode: NEG_STRATEGY,
          lengthGap,
          lengthMatch: lengthMatch === 1,
          modelScore: +Number(modelScore).toFixed(4),
          trainingEligible: true,
          labelAudit: {
            status: 'rule-supported',
            source: 'audited-unit-endpoints',
            winRule: pos.labelAudit.labelRule,
            loseRule: neg.labelAudit.labelRule,
          },
        })
        localDegree.set(pos.globalIdx, degree(pos.globalIdx) + 1)
        localDegree.set(neg.globalIdx, degree(neg.globalIdx) + 1)
        pairDegree.set(pos.globalIdx, (pairDegree.get(pos.globalIdx) || 0) + 1)
        pairDegree.set(neg.globalIdx, (pairDegree.get(neg.globalIdx) || 0) + 1)
        pairCount++
      }
    }
    return { positiveCandidates: positives.length, negativeCandidates: negatives.length, pairs: pairCount }
  }

  // 1. 从 devGold 提取多任务单元样本、跨度指针样本与 5 类反事实偏好对
  for (const g of devGold) {
    const goldSlots = slotsOf(g.hand)
    const units = splitDiscourseUnits(g.raw)
    const targetAnchors = extractAnchorsV5(g.raw.slice(Math.floor(g.raw.length * 0.65)))
    const ctxInfo = { raw: g.raw, toolText: g.ctx, targetAnchors, offsets: [] }
    const docUnits = []
    units.forEach((u, i) => {
      const feat = extractUnitFeatures(u, i, units.length, ctxInfo)
      const lbl = labelUnitMultiTask(u, feat, goldSlots)
      const item = {
        globalIdx: unitSamples.length,
        sourceId: g.id,
        family: g.family,
        unitIdx: i,
        totalUnits: units.length,
        text: u.slice(0, 360),
        features: feat.vec,
        tokenCount: feat.tok,
        temptationT: feat.temptationT,
        slot: lbl.slot,
        slotIdx: lbl.slotIdx,
        yVal: lbl.yVal,
        yTempt: lbl.yTempt,
        trainingEligible: lbl.trainingEligible,
        labelAudit: lbl.labelAudit,
      }
      unitSamples.push(item)
      docUnits.push(item)
    })
    buildDocUnitPairs(g.id, g.family, docUnits)
    spanSamples.push({
      sourceId: g.id,
      family: g.family,
      spans: extractSpanPointers(g.raw, g.ctx, g.hand),
    })
    stepSimpoPairs.push(...buildStepSimpoCounterfactuals(g))
  }

  // 2. 从 devPool (oracle-d2c / M.json) 提取补充多任务样本与反事实对
  for (const t of devPool) {
    const oracleText = oracleMap.get(t.id)
    const rawText = t.chain?.a2?.raw || t.raw || ''
    const ctxText = (t.chain ? productionContext(t.chain) : '') || t.ctx || ''
    if (!oracleText || !rawText) continue
    const goldSlots = slotsOf(oracleText)
    const units = splitDiscourseUnits(rawText)
    const targetAnchors = extractAnchorsV5(rawText.slice(Math.floor(rawText.length * 0.65)))
    const ctxInfo = { raw: rawText, toolText: ctxText, targetAnchors, offsets: [] }
    const docUnits = []
    units.forEach((u, i) => {
      const feat = extractUnitFeatures(u, i, units.length, ctxInfo)
      const lbl = labelUnitMultiTask(u, feat, goldSlots)
      const item = {
        globalIdx: unitSamples.length,
        sourceId: `pool:${t.id}`,
        family: t.id,
        unitIdx: i,
        totalUnits: units.length,
        text: u.slice(0, 360),
        features: feat.vec,
        tokenCount: feat.tok,
        temptationT: feat.temptationT,
        slot: lbl.slot,
        slotIdx: lbl.slotIdx,
        yVal: lbl.yVal,
        yTempt: lbl.yTempt,
        trainingEligible: lbl.trainingEligible,
        labelAudit: lbl.labelAudit,
      }
      unitSamples.push(item)
      docUnits.push(item)
    })
    buildDocUnitPairs(`pool:${t.id}`, t.id, docUnits)
    spanSamples.push({
      sourceId: `pool:${t.id}`,
      family: t.id,
      spans: extractSpanPointers(rawText, ctxText, oracleText),
    })
    stepSimpoPairs.push(...buildStepSimpoCounterfactuals({
      id: `pool:${t.id}`,
      family: t.id,
      raw: rawText,
      ctx: ctxText,
      hand: oracleText,
      calls: [],
    }))
  }

  // 3. 合并飞轮真实偏好对（严格仅取 dev 家族；优先读 .cfb-offline/train/pairs.jsonl，回退读 transfer/models/dev-flywheel-pairs.json）
  const fwPath = path.join(ROOT, '.cfb-offline/train/pairs.jsonl')
  const fwFallbackPath = path.join(ROOT, 'transfer/models/dev-flywheel-pairs.json')
  const flywheelSourcePath = fs.existsSync(fwPath) ? path.relative(ROOT, fwPath) : (fs.existsSync(fwFallbackPath) ? path.relative(ROOT, fwFallbackPath) : null)
  // 兼容两种回退形状：旧版裸数组，或 tools/promote-flywheel-pairs.mjs 生成的 {schema, pairs[]} 文档
  const fallbackDoc = fs.existsSync(fwFallbackPath) ? JSON.parse(fs.readFileSync(fwFallbackPath, 'utf8')) : null
  const flywheelSourceSchema = fs.existsSync(fwPath) ? 'jsonl' : (Array.isArray(fallbackDoc) ? 'array/legacy' : (fallbackDoc?.schema || null))
  const rawFwItems = fs.existsSync(fwPath)
    ? fs.readFileSync(fwPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : (Array.isArray(fallbackDoc) ? fallbackDoc : (fallbackDoc?.pairs || []))
  // v14.20：占位式常数分数（如全部 0.92/0.45）不构成偏好监督 ⇒ 整批降级为 needs-review，绝不当成真实 margin 训练。
  const distinctScorePairs = new Set(rawFwItems.map((item) => {
    const c = Number.isFinite(item.chosenScore) ? item.chosenScore : item.scores?.candidate
    const r = Number.isFinite(item.rejectedScore) ? item.rejectedScore : item.scores?.control
    return `${c}|${r}`
  }))
  const flywheelScoresDegenerate = rawFwItems.length >= 20 && distinctScorePairs.size <= 2
  for (const p of rawFwItems) {
    const fam = String(p.task || p.taskId || p.family || '').split(':')[0].replace(/_(?:decoy|long-horizon).*$/, '')
    if (p.split === 'holdout' || isHoldout(fam)) continue
    const cText = p.chosenText || (typeof p.chosen === 'string' ? p.chosen : p.chosen?.draft)
    const rText = p.rejectedText || (typeof p.rejected === 'string' ? p.rejected : p.rejected?.draft)
    if (!cText || !rText) continue
    const chosenPref = extractDraftPrefFeatures(cText, '', '')
    const rejectedPref = extractDraftPrefFeatures(rText, '', '')
    const pairedScores = p.scores || {}
    let chosenScore = Number.isFinite(p.chosenScore) ? p.chosenScore : null
    let rejectedScore = Number.isFinite(p.rejectedScore) ? p.rejectedScore : null
    if (chosenScore == null || rejectedScore == null) {
      const candidateScore = Number(pairedScores.candidate)
      const controlScore = Number(pairedScores.control)
      if (Number.isFinite(candidateScore) && Number.isFinite(controlScore)) {
        if (p.chosen === 'candidate') { chosenScore = candidateScore; rejectedScore = controlScore }
        else if (p.chosen === 'control') { chosenScore = controlScore; rejectedScore = candidateScore }
        else { chosenScore = Math.max(candidateScore, controlScore); rejectedScore = Math.min(candidateScore, controlScore) }
      }
    }
    const scoreMargin = chosenScore == null || rejectedScore == null ? null : chosenScore - rejectedScore
    const trainingEligible = !flywheelScoresDegenerate && scoreMargin != null && scoreMargin >= 0.05
    stepSimpoPairs.push({
      id: `flywheel::${stepSimpoPairs.length}`,
      sourceId: p.task || fam || 'dev-flywheel',
      family: fam || 'dev',
      negType: 'flywheel_real_pair',
      description: '飞轮真实胜负偏好对',
      chosenText: cText,
      rejectedText: rText,
      chosenScore,
      rejectedScore,
      rejectedGateOk: false,
      trainingEligible,
      labelAudit: {
        status: trainingEligible ? 'reviewed-pair-with-margin' : 'needs-review',
        source: 'persisted-flywheel-pair-scores',
        scoreMargin: scoreMargin == null ? null : +scoreMargin.toFixed(4),
        reason: trainingEligible ? null
          : (flywheelScoresDegenerate ? 'paired-scores-degenerate-placeholder-set'
          : (scoreMargin == null ? 'missing-paired-scores' : 'paired-score-margin-below-0.05')),
        degenerateScoreSet: flywheelScoresDegenerate ? true : undefined,
      },
      gammaDd: +Math.max(0.35, Math.min(1.2, (scoreMargin ?? 0.35))).toFixed(4),
      chosenPref,
      rejectedPref,
    })
  }

  const devFamilies = [...new Set(unitSamples.map((u) => familyKey(u.family)))].sort()
  const eligibleFamilyCounts = Object.fromEntries(
    devFamilies.map((family) => [family, unitSamples.filter((u) => u.trainingEligible && familyKey(u.family) === family).length]),
  )
  const dataset = {
    schema: 'cfb.micro-dev-dataset/3',
    createdAt: process.env.CFB_DATASET_FIXED_TIME || new Date().toISOString(),
    holdoutFamiliesExcluded: [...HOLDOUT_FAMS],
    holdoutTouched: false,
    stats: {
      devGoldItems: devGold.length,
      holdoutGoldItemsExcludedFromTraining: holdoutGold.length,
      devPoolItems: devPool.length,
      unitSamplesCount: unitSamples.length,
      spanDocumentsCount: spanSamples.length,
      totalSpanPointers: spanSamples.reduce((s, x) => s + x.spans.length, 0),
      unitStepPairsCount: unitStepPairs.length,
      stepSimpoPairsCount: stepSimpoPairs.length,
      trainEligibleUnitSamples: unitSamples.filter((u) => u.trainingEligible).length,
      unitLabelNeedsReview: unitSamples.filter((u) => !u.trainingEligible).length,
      unitLabelRuleCounts: countBy(unitSamples, (unit) => unit.labelAudit?.labelRule || 'missing-rule'),
      eligibleUnitLabelRuleCounts: countBy(
        unitSamples.filter((unit) => unit.trainingEligible),
        (unit) => unit.labelAudit?.labelRule || 'missing-rule',
      ),
      trainEligibleStepSimpoPairs: stepSimpoPairs.filter((pair) => pair.trainingEligible).length,
      stepSimpoLabelsNeedsReview: stepSimpoPairs.filter((pair) => !pair.trainingEligible).length,
      draftPairNegTypeCounts: countBy(stepSimpoPairs, (pair) => pair.negType || 'unknown'),
      eligibleDraftPairSourceCounts: countBy(
        stepSimpoPairs.filter((pair) => pair.trainingEligible),
        (pair) => pair.labelAudit?.source || 'missing-source',
      ),
      needsReviewDraftReasons: countBy(
        stepSimpoPairs.filter((pair) => !pair.trainingEligible),
        (pair) => pair.labelAudit?.reason || 'missing-score-or-margin',
      ),
      draftPairReviewStatusCounts: countBy(
        stepSimpoPairs,
        (pair) => pair.labelAudit?.status || 'missing-status',
      ),
      devFamilyCount: devFamilies.length,
      devFamilyNames: devFamilies,
      devFamilyUnitCounts: countBy(unitSamples, (unit) => familyKey(unit.family)),
      eligibleDevFamilyUnitCounts: eligibleFamilyCounts,
      pairConstruction: {
        strategy: NEG_STRATEGY,
        endpointDegreeCap: UNIT_PAIR_MAX_ENDPOINT_DEGREE,
        maxPairsPerPositive: UNIT_PAIR_MAX_PER_POSITIVE,
        nearLengthTokens: NEAR_LENGTH_TOKENS,
        note: 'hardened = length-matched + model-hard negatives first; legacy = hardness only',
      },
      flywheelSourcePath,
      flywheelSourceSchema,
      flywheelScoresDegenerate,
      flywheelDistinctScorePairs: distinctScorePairs.size,
      unitPairEndpointReuse: (() => {
        const refs = [...pairDegree.values()]
        const histogram = Object.fromEntries([1, 2, 3, 4].map((d) => [String(d), refs.filter((n) => n === d).length]))
        return {
          maxDegree: refs.length ? Math.max(...refs) : 0,
          uniqueEndpoints: refs.length,
          endpointReferences: unitStepPairs.length * 2,
          endpointsReused: refs.filter((n) => n > 1).length,
          reuseFraction: refs.length ? +(refs.filter((n) => n > 1).length / refs.length).toFixed(4) : 0,
          degreeHistogram: histogram,
          cap: UNIT_PAIR_MAX_ENDPOINT_DEGREE,
        }
      })(),
      labelAudit: {
        unitSamples: unitSamples.length,
        trainEligibleUnitSamples: unitSamples.filter((u) => u.trainingEligible).length,
        needsSemanticReviewUnitSamples: unitSamples.filter((u) => !u.trainingEligible).length,
        unitFlags: countBy(
          unitSamples.flatMap((unit) => unit.labelAudit?.flags || []),
          (flag) => flag,
        ),
        preferencePairs: stepSimpoPairs.length,
        trainEligiblePreferencePairs: stepSimpoPairs.filter((p) => p.trainingEligible).length,
        needsReviewPreferencePairs: stepSimpoPairs.filter((p) => !p.trainingEligible).length,
        reviewStatus: 'deterministic-screen-only; LLM/human semantic review not run',
      },
    },
    slotNames: SLOT_NAMES,
    unitSamples,
    unitStepPairs,
    spanSamples,
    stepSimpoPairs,
  }

  const outPath = path.join(ROOT, 'transfer/models/micro-dev-dataset.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2) + '\n')
  console.log('[build-micro-dataset] Written:', outPath)
  console.log(JSON.stringify(dataset.stats, null, 2))
  return dataset
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildMicroDataset()
}
