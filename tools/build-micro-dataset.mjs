#!/usr/bin/env node
// tools/build-micro-dataset.mjs —— 严格零泄漏（dev-only）构建 <0.1B (CFB-Micro) 专用出生压缩微模型数据集
//
// 产物：transfer/models/micro-65m-dev-dataset.json
// 包含三层监督信号（holdout 家族 eacces-config / wrong-model 全程物理隔离，零接触）：
//   1. unitSamples: 话语单元级多任务监督（19维符号特征 + 原始文本 + Head A 6类槽位 + Head B 价值V/诱惑度T + Head C 跨度起止下标）
//   2. stepSimpoPairs: Step-DPO × SimPO 步级反事实偏好对（5类困难负例 + 飞轮真实偏好对 + 动态奖励间隔 γ_dd）
//   3. spanSamples: GLiNER 式并行跨度指针样本（target_file / old_text / new_text / verify_cmd 原文精确切片区间 [start, end]）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SLOT_NAMES, extractAnchorsV5, splitDiscourseUnits,
  extractUnitFeatures, extractDraftPrefFeatures, buildGroundedHay,
} from '../src/compile-v5-local.js'
import { slotsOf, draftDistance, handDraftGate } from './helpers/hand-draft.mjs'
import { loadGold } from './helpers/three-mode.mjs'
import { buildPool } from './helpers/tasks.mjs'
import { productionContext } from './helpers/candidates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOLDOUT_FAMS = new Set(['eacces-config', 'wrong-model'])
const isHoldout = (fam) => HOLDOUT_FAMS.has(String(fam || '').split(':')[0].replace(/_(?:decoy|long-horizon).*$/, ''))

function loadAllGold(root = ROOT) {
  return loadGold(path.join(root, 'transfer', 'gold')).map((g) => ({
    ...g,
    hand: g.draft || g.gold || g.hand || '',
    split: g.split || (isHoldout(g.family) ? 'holdout' : 'dev'),
  }))
}

function labelUnitMultiTask(unit, idx, total, feat, goldSlots, raw, ctx) {
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

  let slot = 'NOISE'
  let yVal = 0.05
  let yTempt = feat.temptationT || 0.05

  if (/(?:改法只落|改法分|old_text|new_text|edit_file|改成|改为|改回)/.test(unit) && sDec >= 0.25) {
    slot = 'DECIDED'; yVal = 1.0; yTempt = 0.10
  } else if (/(?:已排除|排除|诱饵|legacy|compat|不用改|不改|不是.*原因|repro\.tmp)/.test(unit) && sEx >= 0.2) {
    slot = 'EXCLUDED'; yVal = 0.90; yTempt = Math.max(0.75, feat.temptationT)
  } else if (/(?:验收|预期|不算证据|若.*仍|如果输出跟这两种都不像)/.test(unit) && sAcc >= 0.2) {
    slot = 'ACCEPT'; yVal = 0.86; yTempt = 0.12
  } else if (/(?:未解|回放过了之后|汇总.*收工|确认.*通过)/.test(unit) && sOp >= 0.2) {
    slot = 'OPEN'; yVal = 0.80; yTempt = 0.10
  } else if (sDec >= 0.45) {
    slot = 'DECIDED'; yVal = 0.92; yTempt = 0.12
  } else if (sEx >= 0.40) {
    slot = 'EXCLUDED'; yVal = 0.84; yTempt = Math.max(0.72, feat.temptationT)
  } else if (sAcc >= 0.40) {
    slot = 'ACCEPT'; yVal = 0.80; yTempt = 0.10
  } else if (sOp >= 0.40) {
    slot = 'OPEN'; yVal = 0.75; yTempt = 0.10
  } else if (uIds.size >= 2 && unit.length >= 18 && !/^\s*(?:Let me|Hmm|Wait,\s*$)/i.test(unit)) {
    slot = 'MECHANISM'; yVal = 0.58; yTempt = Math.min(0.35, feat.temptationT)
  }

  // 反激活（Negative Priming）硬监督：若提到 ctx 中的休眠文件但未在 goldSlots.excluded 中出现，压低 yTempt
  if (slot !== 'EXCLUDED' && /(?:verify\.mjs|package\.json|README\.md)/.test(unit) && sEx < 0.15) {
    yTempt = 0.02
  }

  return { slot, slotIdx: SLOT_NAMES.indexOf(slot), yVal: +yVal.toFixed(4), yTempt: +yTempt.toFixed(4) }
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

  const buildDocUnitPairs = (docId, fam, docUnits) => {
    const positives = docUnits.filter((u) => u.slot !== 'NOISE' && u.yVal >= 0.55)
    const negatives = docUnits.filter((u) => u.slot === 'NOISE' || u.yVal <= 0.15)
    for (const pos of positives) {
      // 每个正例匹配最多 4 个同文档困难负例（优先挑长噪音或低诱惑休眠句）
      const sortedNegs = [...negatives].sort((a, b) => b.text.length - a.text.length).slice(0, 4)
      for (const neg of sortedNegs) {
        const gammaStep = +Math.max(0.35, Math.min(1.2, pos.yVal - neg.yVal)).toFixed(4)
        unitStepPairs.push({
          sourceId: docId,
          family: fam,
          winIdx: pos.globalIdx,
          loseIdx: neg.globalIdx,
          winSlot: pos.slot,
          loseSlot: neg.slot,
          gammaStep,
        })
      }
    }
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
      const lbl = labelUnitMultiTask(u, i, units.length, feat, goldSlots, g.raw, g.ctx)
      const item = {
        globalIdx: unitSamples.length,
        sourceId: g.id,
        family: g.family,
        unitIdx: i,
        totalUnits: units.length,
        text: u.slice(0, 360),
        features: feat.vec,
        slot: lbl.slot,
        slotIdx: lbl.slotIdx,
        yVal: lbl.yVal,
        yTempt: lbl.yTempt,
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
      const lbl = labelUnitMultiTask(u, i, units.length, feat, goldSlots, rawText, ctxText)
      const item = {
        globalIdx: unitSamples.length,
        sourceId: `pool:${t.id}`,
        family: t.id,
        unitIdx: i,
        totalUnits: units.length,
        text: u.slice(0, 360),
        features: feat.vec,
        slot: lbl.slot,
        slotIdx: lbl.slotIdx,
        yVal: lbl.yVal,
        yTempt: lbl.yTempt,
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

  // 3. 合并飞轮真实偏好对（严格仅取 dev 家族）
  const fwPath = path.join(ROOT, '.cfb-offline/train/pairs.jsonl')
  const fwLines = fs.existsSync(fwPath) ? fs.readFileSync(fwPath, 'utf8').trim().split('\n').filter(Boolean) : []
  for (const l of fwLines) {
    const p = JSON.parse(l)
    const fam = String(p.task || p.taskId || p.family || '').split(':')[0].replace(/_(?:decoy|long-horizon).*$/, '')
    if (p.split === 'holdout' || isHoldout(fam)) continue
    const cText = p.chosenText || (typeof p.chosen === 'string' ? p.chosen : p.chosen?.draft)
    const rText = p.rejectedText || (typeof p.rejected === 'string' ? p.rejected : p.rejected?.draft)
    if (!cText || !rText) continue
    const chosenPref = extractDraftPrefFeatures(cText, '', '')
    const rejectedPref = extractDraftPrefFeatures(rText, '', '')
    stepSimpoPairs.push({
      id: `flywheel::${stepSimpoPairs.length}`,
      sourceId: p.task || fam || 'dev-flywheel',
      family: fam || 'dev',
      negType: 'flywheel_real_pair',
      description: '飞轮真实胜负偏好对',
      chosenText: cText,
      rejectedText: rText,
      chosenScore: p.chosenScore ?? 0.92,
      rejectedScore: p.rejectedScore ?? 0.45,
      rejectedGateOk: false,
      gammaDd: +Math.max(0.35, Math.min(1.2, (p.chosenScore ?? 0.92) - (p.rejectedScore ?? 0.45))).toFixed(4),
      chosenPref,
      rejectedPref,
    })
  }

  const dataset = {
    schema: 'cfb.micro-65m-dataset/1',
    createdAt: new Date().toISOString(),
    holdoutFamiliesExcluded: [...HOLDOUT_FAMS],
    holdoutTouched: false,
    stats: {
      devGoldItems: devGold.length,
      holdoutGoldItemsReservedForBlindEval: holdoutGold.length,
      devPoolItems: devPool.length,
      unitSamplesCount: unitSamples.length,
      spanDocumentsCount: spanSamples.length,
      totalSpanPointers: spanSamples.reduce((s, x) => s + x.spans.length, 0),
      unitStepPairsCount: unitStepPairs.length,
      stepSimpoPairsCount: stepSimpoPairs.length,
    },
    slotNames: SLOT_NAMES,
    unitSamples,
    unitStepPairs,
    spanSamples,
    stepSimpoPairs,
  }

  const outPath = path.join(ROOT, 'transfer/models/micro-65m-dev-dataset.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2) + '\n')
  console.log('[build-micro-dataset] Written:', outPath)
  console.log(JSON.stringify(dataset.stats, null, 2))
  return dataset
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildMicroDataset()
}
