#!/usr/bin/env node
// tools/cfb-cycle.mjs —— 闭环 v3（v14.3；v2 命令全部保留）：按比特买证据的训练环 + 生成层。
//
// v3 新增（见 docs/design/CLOSED-LOOP-V3.md）：
//   任务池   冻结 5 题 ∪ .cfb-offline/tasks/*.task.json（铸造 / 挖掘 / 人写）；确定性 dev/holdout 切分；每轮轮换 ≤5 题
//   A/A      第一笔钱先校准仪器：两臂同文，估平局率 / 胜率偏置（history.calibration），不采纳任何东西
//   策略     提示词级策略空间（对 v4d9 的受限补丁）：propose-policy（LLM 提议器，只看 dev 题证据）→ compile --policy（按策略重压 side）
//            → plan 自动把「已编译策略」当假设（lever=policy）→ 留出题闸门采纳（decideV3）
//   飞轮     每个非平局配对追加到 .cfb-offline/train/pairs.jsonl（偏好对；GPU 到位时才谈权重训练）
//   mint     付费铸造新任务（u1 → a1；人补 u2 → a2），compile --mint 压 r1 / side，进池前过 validateTaskFile
//
// 一轮 = 一个假设（单杠杆：lever=value vs 当前 champion）：
//   plan     零 API：生产重编译出 control / candidate（candidates.mjs）→ 过生产闸门 → 真值维度安全过滤（truth-dims.mjs）
//            → 冻结 v9 配对回放计划（每题 1 对、≤5 对 + 3 探针，USD 1 上限/轮）→ 打印预占 / 预计实付 / 期望信息量 → **停下等批准**
//   (live)   由用户在有网络许可的环境显式执行：node tools/effect-ready.mjs run --live --v9 --round N   （本文件绝不发请求）
//   ingest   零 API：读账本（或 report 文件）→ 配对结构分 → 序贯 Beta 后验（跨轮累计同一假设）→ adopt / reject / continue
//            → adopt 时更新 champion.json（下一轮的 control 就是它）
//   propose  零 API：把 champion 与 BASELINE 的差翻成生产配置 diff（kind:config）或需要改 src 的说明（program / transform）；不写 src/
//   status / doctor / simulate   只读 / 自检 / 纯算术演练
//
// 纪律：收据不追溯重评；每轮一个 scope、逐轮批准；真值维度与付费判据同源（next / avoid / falseDone 正则）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { evidenceDigest } from '../src/evidence-program.js'
import * as I from '../index.js'
import { KNOBS, BASELINE_KNOBS, LEVER_ORDER, loadFrozenTasks, generateCandidates, armSummary, renderCandidate, productionGate, productionContext } from './helpers/candidates.mjs'
import { buildPool, loadExtraTasks, rotateTasks, validateTaskFile, taskDigest, TASK_ID_RE } from './helpers/tasks.mjs'
import { BASE_POLICY, makePolicy, parseProposal, validatePatches, leakCheck, promptHead, failureEvidence, GEN_ROLES } from './helpers/generation.mjs'
import { truthDimensions, truthComposite, truthDelta, TRUTH_DIMENSIONS } from './helpers/truth-dims.mjs'
import { sequentialPaired, pairResults, expectedBitsNextPair, bitsBought, pairsToDecide, costEstimate, usdPerBit, DEFAULT_DESIGN, DEFAULT_DESIGN_V3, decideV3, betaCdf } from './helpers/experiment.mjs'
import { prepareEvaluation, reportEvaluation, loadPrepared, DEFAULT_HOME_V9, PUBLIC_RECEIPT_V9, DEFAULT_HOME_GEN, PUBLIC_RECEIPT_GEN, PROFILE_EXAMPLE, ROOT } from './helpers/eval-workflow.mjs'
import { auditApiPlan, planScope, APPROVED_API_LIMITS_V9, APPROVED_API_LIMITS_GEN } from './helpers/api-budget.mjs'
import { readWatermark } from './helpers/api-watermark.mjs'
import { decideV4, rulerValidity, adoptionPolicy, outcomeComparison, episodeOutcome, eValueWins, winsNeeded, DEFAULT_DESIGN_V4 } from './helpers/ruler.mjs'
import { trainRanker, scoreText } from './helpers/ranker.mjs'
import { retroValidity } from './helpers/traj-proxy.mjs'

// 目录：默认仓库里的 .cfb-offline / .cfb-runtime/bounded-ab-v9/rN / transfer 收据；自测用 CFB_CYCLE_DIR 整体改道（不碰真实轮次）。
const BASE = process.env.CFB_CYCLE_DIR ? path.resolve(process.env.CFB_CYCLE_DIR) : null
export const OFFLINE = BASE ? path.join(BASE, 'offline') : path.join(ROOT, '.cfb-offline')
export const HISTORY = path.join(OFFLINE, 'history.json')
export const CHAMPION = path.join(OFFLINE, 'champion.json')
export const homeFor = (round) => (BASE ? path.join(BASE, 'runtime', 'r' + Number(round)) : DEFAULT_HOME_V9(round))
export const receiptFor = (round) => (BASE ? path.join(BASE, 'receipts', 'v9-r' + Number(round) + '.watermark.json') : PUBLIC_RECEIPT_V9(round))
export const POLICIES = path.join(OFFLINE, 'policies')
export const TASKS_DIR = path.join(OFFLINE, 'tasks')
export const TRAIN_PAIRS = path.join(OFFLINE, 'train', 'pairs.jsonl')
// v4 尺子账本：效度配对（L1 代理分 ↔ L2 结局）、留出题曝光（每参与一次采纳 / 否决判定 +1，≥3 应退役轮换）、L2 确认结果
export const RULER_DIR = path.join(OFFLINE, 'ruler')
export const VALIDITY = path.join(RULER_DIR, 'validity.jsonl')
export const EXPOSURE = path.join(RULER_DIR, 'exposure.json')
export const HOLDOUT_MAX_EXPOSURE = 3
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
export const loadFlywheel = () => readJsonl(TRAIN_PAIRS)
export const loadValidity = () => readJsonl(VALIDITY)
export const loadExposure = () => readJson(EXPOSURE) || { schema: 'cfb.exposure/1', tasks: {} }
function bumpExposure(tasks, split, round, decision) {
  const ex = loadExposure()
  for (const t of new Set(tasks)) { if ((split[t] || 'dev') !== 'holdout') continue; const e = ex.tasks[t] || { n: 0, rounds: [] }; e.n += 1; e.rounds.push({ round, decision }); ex.tasks[t] = e }
  ensure(RULER_DIR); writeJson(EXPOSURE, ex); return ex
}
export const exposureWarnings = (ex = loadExposure()) => Object.entries(ex.tasks).filter(([, e]) => e.n >= HOLDOUT_MAX_EXPOSURE).map(([t, e]) => `留出题 ${t} 已参与 ${e.n} 次判定（≥${HOLDOUT_MAX_EXPOSURE}）：应退役为 dev，换新题进留出（mint / 自铸）`)
export const genHomeFor = (g) => (BASE ? path.join(BASE, 'runtime', 'g' + Number(g)) : DEFAULT_HOME_GEN(g))
export const genReceiptFor = (g) => (BASE ? path.join(BASE, 'receipts', 'gen-g' + Number(g) + '.watermark.json') : PUBLIC_RECEIPT_GEN(g))
// 低风险在前：先改收尾 / 死胡同的呈现，再动选择与版式，kItems（结构性）最后；bind 在冻结语料上惰性，放末位只为可见。
/** 任务池：冻结 5 题 ∪ 本目录下 tasks/*.task.json（CFB_CYCLE_DIR 改道时跟着走）。 */
export function loadPool() { return buildPool({ extra: loadExtraTasks(TASKS_DIR) }) }
export const LEVER_ORDER_V3 = Object.freeze(['closing', 'deadEnd', 'selection', 'layout', 'kItems', 'bind'].filter((l) => KNOBS[l]))
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)
const ensure = (d) => { fs.mkdirSync(d, { recursive: true }); return d }
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p, o) => { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }
const short = (o) => evidenceDigest(o).slice(0, 8)

export function loadHistory() { return readJson(HISTORY, { schema: 'cfb.closed-loop/2', hypotheses: {}, rounds: [] }) }
export function loadChampion() { const c = readJson(CHAMPION); return c && c.knobs ? c.knobs : { ...BASELINE_KNOBS } }
export function loadPolicy(id) { if (!id || id === 'base') return BASE_POLICY; const p = readJson(path.join(POLICIES, id + '.json')); if (!p || p.id !== id) throw new Error('policy-missing:' + id); return p }
export function loadChampionPolicy() { return loadPolicy(readJson(CHAMPION)?.policy || 'base') }
export function listPolicies() { if (!fs.existsSync(POLICIES)) return []; return fs.readdirSync(POLICIES).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(POLICIES, f))).filter((p) => p && p.id) }
/** 本轮任务：池 → 轮换 ≤5 题 → 若 champion 策略 ≠ base，side 换成该策略编译出的 side（缺的题不进本轮）。 */
export function tasksForRound(round, { pool = loadPool(), policy = loadChampionPolicy() } = {}) {
  const ids = new Set(rotateTasks(pool, round))
  const tasks = pool.tasks.filter((t) => ids.has(t.id)).map((t) => (policy.id === 'base' ? t : policy.sides?.[t.id]?.text ? { ...t, side: policy.sides[t.id].text, sidePolicy: policy.id } : null)).filter(Boolean)
  return { pool, tasks, dropped: [...ids].filter((id) => !tasks.some((t) => t.id === id)) }
}
/** 已编译策略 → 候选臂：同一 champion 旋钮，side 换成策略稿；逐题标 degenerate / feasible（与 generateCandidates 同形）。 */
export function policyCandidates(tasks, cands, { champion = loadChampion(), policies = listPolicies() } = {}) {
  const out = []
  for (const p of policies) {
    if (!['compiled', 'adopted'].includes(p.status) || p.id === (readJson(CHAMPION)?.policy || 'base')) continue
    for (const task of tasks) {
      const rec = p.sides?.[task.id]; if (!rec?.text) continue
      const control = cands.find((c) => c.task === task.id && c.isControl)
      const c = renderCandidate({ ...task, side: rec.text }, champion)
      // side 本身不过生产闸门（发明标识符 / 超长）的题：臂记为不过闸，不进打分
      out.push({ id: `policy=${p.id}@${task.id}`, task: task.id, arm: 'policy=' + p.id, lever: 'policy', value: p.id, isControl: false, ...c, ...(rec.gate === false ? { feasible: false, notes: [...(c.notes || []), 'side-gate-failed'] } : {}), degenerate: !!(c.ok && control?.ok && c.text === control.text) })
    }
  }
  return out
}
const AA = Object.freeze({ lever: 'A/A', value: 'control', theory: '仪器校准：两臂同文，评委应给 ≈0.5 胜率、高平局率；估计噪声与偏置，不采纳任何东西', kind: 'calibration' })
export const hypothesisKey = (lever, value, champion) => `${lever}=${value}@${short(champion)}`

// ── 1. 离线表：每个候选臂相对 control 的真值维度差（安全过滤 + 方向校验）────────
export function offlineTable(tasks, cands) {
  const rows = []
  for (const t of tasks) {
    const ctrl = cands.find((c) => c.task === t.id && c.isControl)
    if (!ctrl?.ok) continue
    const dc = truthDimensions(ctrl.text, t.chain, t.spec)
    const draw = truthDimensions(t.chain.a2.raw, t.chain, t.spec)
    rows.push({ task: t.id, arm: 'control', dims: dc, composite: truthComposite(dc).score, rawComposite: truthComposite(draw).score, chars: ctrl.chars })
    for (const c of cands.filter((x) => x.task === t.id && !x.isControl && x.ok)) {
      const d = truthDimensions(c.text, t.chain, t.spec)
      rows.push({ task: t.id, arm: c.arm, lever: c.lever, value: c.value, dims: d, composite: truthComposite(d).score, delta: truthDelta(d, dc), feasible: c.feasible, degenerate: c.degenerate, chars: c.chars })
    }
  }
  return rows
}
/** 一个臂的离线裁决：可用题数、平均 Δ、是否出现可预见的伤害（任一题泄漏 / 宣称风险上升）。 */
export function armVerdict(rows, arm) {
  const xs = rows.filter((r) => r.arm === arm)
  const usable = xs.filter((r) => r.feasible && !r.degenerate)
  const deltas = usable.map((r) => r.delta.composite).filter((v) => v != null)
  const meanDelta = deltas.length ? +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(4) : null
  const harm = usable.filter((r) => (r.delta.avoidLeak != null && r.delta.avoidLeak < 0) || (r.delta.claimRisk != null && r.delta.claimRisk < 0) || (r.delta.locusHit != null && r.delta.locusHit < 0)).map((r) => r.task)
  return { arm, tasks: xs.length, usable: usable.length, usableTasks: usable.map((r) => r.task), degenerate: xs.filter((r) => r.degenerate).length, infeasible: xs.filter((r) => !r.feasible).length, meanDelta, harm, safe: usable.length >= 3 && harm.length === 0 && (meanDelta == null || meanDelta >= -0.05) }
}

// ── 2. 选假设：先把开着的假设做完（序贯设计），否则按理论顺序取第一个「可用且安全」的新假设 ──
export function pickHypothesis({ rows, champion, history, override = null, aa = false, policyArms = [], leverOrder = LEVER_ORDER_V3 }) {
  const verdicts = {}
  for (const arm of policyArms) verdicts[arm] = armVerdict(rows, arm)
  for (const lever of leverOrder) for (const value of KNOBS[lever].values) {
    if (champion[lever] === value) continue
    verdicts[lever + '=' + value] = armVerdict(rows, lever + '=' + value)
  }
  // A/A：第一笔钱先校准仪器（无 history.calibration 时默认；--skip-aa 跳过；--lever A/A 强制）
  if (aa || override === 'A/A') {
    const usableTasks = [...new Set(rows.filter((r) => r.arm === 'control').map((r) => r.task))]
    return { ...AA, verdict: { arm: 'A/A', tasks: usableTasks.length, usable: usableTasks.length, usableTasks, degenerate: 0, infeasible: 0, meanDelta: 0, harm: [], safe: usableTasks.length >= 3 }, why: override === 'A/A' ? 'override（--lever A/A）' : '还没有仪器校准（history.calibration 为空）：先花一轮 A/A 估评委噪声，再花钱测假设；--skip-aa 可跳过', verdicts }
  }
  if (override && override.startsWith('policy=')) {
    const value = override.slice(7), v = verdicts[override]
    if (!v) throw new Error('policy-not-compiled-for-these-tasks:' + value)
    return { lever: 'policy', value, verdict: v, why: 'override（--lever policy=…）' + (v.safe ? '' : '；⚠ 离线裁决不安全：' + JSON.stringify({ usable: v.usable, harm: v.harm, meanDelta: v.meanDelta })), verdicts }
  }
  if (override) {
    const [lever, value] = override.split('=')
    if (!KNOBS[lever] || !KNOBS[lever].values.includes(value)) throw new Error('unknown-lever:' + override)
    if (champion[lever] === value) throw new Error('lever-equals-champion:' + override)
    const v = verdicts[override]
    return { lever, value, verdict: v, why: 'override（--lever）' + (v.safe ? '' : '；⚠ 离线裁决不安全：' + JSON.stringify({ usable: v.usable, harm: v.harm, meanDelta: v.meanDelta })), verdicts }
  }
  const open = Object.values(history.hypotheses || {}).find((h) => h.decision === 'continue' && short(h.champion) === short(champion))
  if (open) {
    const v = verdicts[open.lever + '=' + open.value]
    if (v && v.usable >= 3) return { lever: open.lever, value: open.value, verdict: v, why: `继续未判定的假设（已 ${open.outcomes.length} 对，P(p>0.5)=${sequentialPaired(open.outcomes.map((o) => o.outcome)).pWin}）`, verdicts }
  }
  // 不自动重测：已判定过的 lever=value（任何 champion 下；--lever 可强制），以及被采纳所取代的旧值（刚采纳 off 就不再测 on）
  const hs = Object.values(history.hypotheses || {})
  const decided = new Set(hs.filter((h) => h.decision !== 'continue').map((h) => h.lever + '=' + h.value))
  const displaced = new Set(hs.filter((h) => h.decision === 'adopt').map((h) => h.lever + '=' + h.champion[h.lever]))
  // 策略假设优先于旋钮：策略是生成层的产出，每个只测一次（判定过就不再自动测）
  for (const arm of policyArms) {
    if (decided.has(arm)) continue
    const v = verdicts[arm]
    if (v.safe) return { lever: 'policy', value: arm.slice(7), verdict: v, why: '已编译、未判定的提示词策略（生成层产出；留出题闸门采纳）', verdicts }
  }
  for (const lever of leverOrder) for (const value of KNOBS[lever].values) {
    const k = lever + '=' + value
    if (champion[lever] === value || decided.has(k) || displaced.has(k)) continue
    const v = verdicts[k]
    if (v.safe) return { lever, value, verdict: v, why: `理论顺序第一个「可用 ≥3 题、离线无可预见伤害」的新假设（${KNOBS[lever].theory}）`, verdicts }
  }
  return { lever: null, value: null, verdict: null, why: '没有可测的新假设：全部已判定 / 退化 / 离线裁决不安全。需要新的杠杆（见 CLOSED-LOOP-V2.md「怎么加杠杆」）', verdicts }
}

// ── 3. plan ─────────────────────────────────────────────────────────────────
export function buildRound({ round, override = null, profile, pricing, force = false, skipAa = false, champion = loadChampion(), history = loadHistory(), pool = loadPool() }) {
  const policy = loadChampionPolicy()
  const { tasks, dropped } = tasksForRound(round, { pool, policy })
  if (tasks.length < 3) throw new Error('round-too-few-tasks（champion 策略 ' + policy.id + ' 缺 side：' + dropped.join(',') + '；先 compile --policy）')
  const cands = generateCandidates(tasks, { champion }).concat(policyCandidates(tasks, generateCandidates(tasks, { champion }), { champion }))
  const rows = offlineTable(tasks, cands)
  const policyArms = [...new Set(cands.filter((c) => c.lever === 'policy').map((c) => c.arm))]
  const aa = !override && !skipAa && !history.calibration
  const pick = pickHypothesis({ rows, champion, history, override, aa, policyArms })
  if (!pick.lever) return { ok: false, reason: 'no-hypothesis', pick, arms: armSummary(cands), rows }
  if (!pick.verdict.safe && !force) return { ok: false, reason: 'offline-unsafe', pick, arms: armSummary(cands), rows }
  const arm = pick.lever + '=' + pick.value, isAA = pick.lever === 'A/A'
  const pairs = pick.verdict.usableTasks.map((task) => {
    const t = tasks.find((x) => x.id === task), ctrl = cands.find((c) => c.task === task && c.isControl), cand = isAA ? ctrl : cands.find((c) => c.task === task && c.arm === arm)
    return { task, control: ctrl.text, candidate: cand.text, knobs: cand.knobs, chain: t.chain, spec: t.spec, r1: t.r1 }
  })
  const split = Object.fromEntries(pairs.map((p) => [p.task, pool.split[p.task]]))
  const hypothesis = isAA ? { ...AA, champion, split } : pick.lever === 'policy'
    ? { lever: 'policy', value: pick.value, champion, theory: (loadPolicy(pick.value).rationale || '').slice(0, 300), kind: 'prompt', split, policy: pick.value }
    : { lever: pick.lever, value: pick.value, champion, theory: KNOBS[pick.lever].theory, kind: KNOBS[pick.lever].kind, split }
  // immutableJson 拒绝 undefined：只放有值的键
  const offline = { table: rows.filter((r) => r.arm === arm || r.arm === 'control').map((r) => ({ task: r.task, arm: r.arm, composite: r.composite, chars: r.chars, ...(r.rawComposite != null ? { rawComposite: r.rawComposite } : {}), ...(r.delta ? { delta: r.delta } : {}), ...(r.dims ? { dims: r.dims } : {}) })), verdict: pick.verdict, why: pick.why }
  const home = homeFor(round), receiptPath = receiptFor(round)
  if (readWatermark(receiptPath)) throw new Error('round-already-has-receipt:' + round)
  const prepared = prepareEvaluation({ home, receiptPath, profile, ...(pricing !== undefined ? { pricing } : {}), version: 9, candidates: pairs, round, hypothesis, offline, pool: pool.registry, env: process.env })
  const plan = loadPrepared(home)
  let audit = null; try { audit = auditApiPlan(plan, { allowUnpriced: true }) } catch { audit = null }
  const cost = costEstimate({ plan, audit, pricing: plan.pricing })
  const key = hypothesisKey(pick.lever, pick.value, champion)
  const prior = history.hypotheses?.[key]?.outcomes?.map((o) => o.outcome) || []
  const seq = sequentialPaired(prior)
  const info = usdPerBit({ alpha: seq.alpha, beta: seq.beta, pairs: pairs.length, expectedUsd: cost.expectedUsd })
  return { ok: true, round, key, hypothesis, pool: { digest: pool.digest, size: pool.tasks.length, holdout: pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id), rotation: tasks.map((t) => t.id), dropped, warnings: pool.warnings, policy: policy.id }, pairs: pairs.map((p) => ({ task: p.task, split: split[p.task], controlChars: p.control.length, candidateChars: p.candidate.length })), offline, arms: armSummary(cands), rows, plan: { digest: evidenceDigest(plan), scope: planScope(plan), jobs: plan.jobs.length, home: path.relative(ROOT, home), receipt: path.relative(ROOT, receiptPath), sourceDigest: plan.sourceDigest }, preflight: prepared.status, checks: prepared.checks, cost, info, posteriorBefore: seq, horizon: { p07: pairsToDecide({ pTrue: 0.7 }), p08: pairsToDecide({ pTrue: 0.8 }) } }
}

export function renderPlanMd(r) {
  const L = []
  if (!r.ok) {
    L.push('# 本轮无法成稿：' + r.reason, '', r.pick.why, '', '## 各臂离线裁决', '', '| 臂 | 可用题 | 退化 | 不过闸 | 平均 Δ真值 | 可预见伤害 | 安全 |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const v of Object.values(r.pick.verdicts)) L.push(`| ${v.arm} | ${v.usable}/${v.tasks} | ${v.degenerate} | ${v.infeasible} | ${v.meanDelta ?? '—'} | ${v.harm.join(',') || '—'} | ${v.safe ? '是' : '否'} |`)
    return L.join('\n')
  }
  const h = r.hypothesis
  L.push(`# 第 ${r.round} 轮计划（已冻结，未发任何请求）`, '')
  L.push(`**假设**：\`${h.lever}=${h.value}\` vs champion \`${JSON.stringify(h.champion)}\`（${h.kind}；${h.theory}）`, '')
  L.push('选它的理由：' + r.offline.why, '')
  if (r.pool) L.push(`任务池 \`${r.pool.digest}\`（${r.pool.size} 题；留出 ${r.pool.holdout.join(',')}）；本轮轮换 ${r.pool.rotation.join(',')}${r.pool.dropped.length ? '；缺 side 跳过 ' + r.pool.dropped.join(',') : ''}；champion 策略 \`${r.pool.policy}\``, '')
  L.push('## 配对（每题 1 对，两臂只有第 2 轮 reasoning 不同）', '', '| 任务 | 切分 | control 字数 | candidate 字数 |', '| --- | --- | --- | --- |')
  for (const p of r.pairs) L.push(`| ${p.task} | ${p.split || '—'} | ${p.controlChars} | ${p.candidateChars} |`)
  if (h.lever === 'A/A') L.push('', '> A/A：两臂同文。期望胜率 ≈ 0.5、平局率高；若评委系统性偏向某一臂或平局率 < 0.1，仪器可疑（history.calibration.instrument），后续判定要加倍保守。')
  L.push('', '## 离线真值维度（零 API；只做安全过滤与方向校验，不做排序）', '', '| 任务 | raw 综合 | control 综合 | candidate 综合 | Δ（candidate−control） |', '| --- | --- | --- | --- | --- |')
  for (const t of r.pairs.map((p) => p.task)) {
    const c = r.offline.table.find((x) => x.task === t && x.arm === 'control'), k = r.offline.table.find((x) => x.task === t && x.arm !== 'control')
    L.push(`| ${t} | ${c?.rawComposite ?? '—'} | ${c?.composite ?? '—'} | ${k?.composite ?? '—'} | ${k?.delta?.composite ?? '—'} |`)
  }
  L.push('', `离线裁决：可用 ${r.offline.verdict.usable}/${r.offline.verdict.tasks} 题，平均 Δ ${r.offline.verdict.meanDelta}，可预见伤害 ${r.offline.verdict.harm.length ? r.offline.verdict.harm.join(',') : '无'} ⇒ ${r.offline.verdict.safe ? '安全，值得花钱' : '⚠ 不安全（--force 才会成稿）'}`)
  L.push('', '## 钱与信息', '')
  L.push(`- 请求：${r.cost.requests}（主 ${r.cost.main} + 探针 3）；scope \`${r.plan.scope}\`；每轮上限 USD ${APPROVED_API_LIMITS_V9.maxUsd} / ${APPROVED_API_LIMITS_V9.maxRequests} 请求`)
  L.push(`- 预占（账本锁定上限）：${r.cost.reservedUsd == null ? '未定价（prepare 时传 --pricing 才有）' : 'USD ' + r.cost.reservedUsd}；预计实付：${r.cost.expectedUsd == null ? '—' : 'USD ' + r.cost.expectedUsd}`)
  L.push(`- 这个假设到目前：${r.posteriorBefore.n} 对（胜 ${r.posteriorBefore.wins} / 负 ${r.posteriorBefore.losses} / 平 ${r.posteriorBefore.ties}），P(p>0.5)=${r.posteriorBefore.pWin}`)
  L.push(`- 本轮 ${r.pairs.length} 对期望买到 ${r.info.expectedBits} bit${r.info.usdPerBit == null ? '' : '，≈ USD ' + r.info.usdPerBit + '/bit'}`)
  L.push(`- 判定规则（v3）：全部对 Beta(1,1) 序贯 + **留出题闸门**（≥${DEFAULT_DESIGN_V3.minHoldoutTasks} 个不同留出题、≥${DEFAULT_DESIGN_V3.minHoldoutPairs} 对留出、留出 P(p>0.5) ≥ ${DEFAULT_DESIGN_V3.adoptAt} 才采纳）；同题重复按 ICC=${DEFAULT_DESIGN_V3.icc} 折算有效 n；dev 题只用来否决 / 提议，不用来采纳`)
  L.push(`- 若真实胜率 0.7，中位 ${r.horizon.p07.medianPairs} 对判定；0.8 ⇒ ${r.horizon.p08.medianPairs} 对（不含留出闸门的额外要求）`)
  L.push('', '## 预检', '', `状态：${r.preflight}`)
  for (const c of r.checks.filter((c) => c.status !== 'pass')) L.push(`- ✗ ${c.id}：${c.remedy || ''}`)
  L.push('', '## 需要你批准后才会花钱', '', '```')
  L.push(`# 批准范围：scope ${r.plan.scope}，≤ ${r.cost.requests} 请求，预占 ≤ USD ${r.cost.reservedUsd ?? '(定价后显示)'}，计划摘要 ${r.plan.digest.slice(0, 16)}`)
  L.push(`node tools/effect-ready.mjs doctor --v9 --round ${r.round}`)
  L.push(`node tools/effect-ready.mjs run --live --v9 --round ${r.round}      # 在有网络许可、设了 DEEPSEEK_API_KEY 的环境`)
  L.push(`node tools/cfb-cycle.mjs ingest --round ${r.round}                   # 跑完回来：配对 → 后验 → adopt/reject/continue`)
  L.push('```')
  return L.join('\n')
}

function cmdPlan(args) {
  ensure(OFFLINE)
  const history = loadHistory()
  // 默认轮次：有「已计划、未花钱（无收据）、未回灌」的轮就重做它（计划可改，钱没花）；否则开新轮
  const pending = history.rounds.find((r) => r.status === 'planned' && !readWatermark(receiptFor(r.round)))
  const round = Number(f(args, '--round') || (pending ? pending.round : Math.max(0, ...history.rounds.map((r) => r.round)) + 1))
  if (!Number.isInteger(round) || round < 1 || round > 20) throw new Error('round-out-of-range')
  const profile = readJson(f(args, '--profile') || PROFILE_EXAMPLE)
  if (!profile) throw new Error('profile-unreadable')
  const pricingFile = f(args, '--pricing')
  const pricing = pricingFile ? readJson(pricingFile) : undefined
  const r = buildRound({ round, override: f(args, '--lever'), profile, pricing, force: args.includes('--force'), skipAa: args.includes('--skip-aa') })
  const md = renderPlanMd(r)
  if (r.ok) {
    writeJson(path.join(OFFLINE, 'round-' + round + '.plan.json'), { schema: 'cfb.cycle-plan/3', at: new Date().toISOString(), ...r, rows: undefined, checks: undefined })
    const h = loadHistory()
    h.rounds = h.rounds.filter((x) => x.round !== round)
    h.rounds.push({ round, at: new Date().toISOString(), status: 'planned', key: r.key, lever: r.hypothesis.lever, value: r.hypothesis.value, champion: r.hypothesis.champion, tasks: r.pairs.map((p) => p.task), planDigest: r.plan.digest, scope: r.plan.scope, reservedUsd: r.cost.reservedUsd, expectedUsd: r.cost.expectedUsd })
    h.rounds.sort((a, b) => a.round - b.round)
    writeJson(HISTORY, h)
  }
  let rankerLine = ''
  if (r.ok && r.hypothesis.lever !== 'A/A') {
    const rk = trainRanker(loadFlywheel())
    if (rk.status === 'ready') { const m = r.pairs.map((p) => { const v = r.plan.variants[p.task]; return v ? scoreText(rk, v.candidate) - scoreText(rk, v.control) : 0 }); rankerLine = `\n排序器预判（CPU，${rk.pairs} 对飞轮，留一 CV ${rk.cvAcc}）：candidate − control 平均 ${(m.reduce((a, b) => a + b, 0) / Math.max(1, m.length)).toFixed(3)}（只是预判，不替代评委；为负时考虑换假设省这一轮）` } else rankerLine = `\n排序器：${rk.status}（${rk.note}）`
  }
  fs.writeFileSync(path.join(OFFLINE, 'round-' + round + '.plan.md'), md + rankerLine + '\n')
  console.log(md + rankerLine)
  console.log('\n已写入 ' + path.relative(ROOT, path.join(OFFLINE, 'round-' + round + '.plan.md')) + (r.ok ? '；计划冻结在 ' + r.plan.home + '/plan.json（未发请求）' : ''))
  process.exitCode = r.ok ? 0 : 2
}

// ── 4. ingest ───────────────────────────────────────────────────────────────
export function ingestRound({ round, report = null, history = loadHistory(), now = new Date().toISOString() }) {
  const home = homeFor(round), receiptPath = receiptFor(round)
  const plan = loadPrepared(home)
  if (plan.schema !== 'cfb.bounded-ab/9' || plan.round !== round) throw new Error('plan-round-mismatch')
  const entry = history.rounds.find((r) => r.round === round)
  if (entry?.status === 'ingested') throw new Error('round-already-ingested:' + round + '（收据不追溯重评）')
  const rep = report || reportEvaluation({ home, receiptPath })
  const mainKeys = new Set(plan.jobs.filter((j) => j.kind === 'main').map((j) => j.key))
  const results = (rep.results || []).filter((r) => mainKeys.has(`${r.task}|${r.variant}|${r.sample}`))
  const pairs = pairResults(results, { arms: plan.arms }).filter((p) => p.outcome === 'win' || p.outcome === 'loss' || p.outcome === 'tie')
  if (!pairs.length) throw new Error('no-paired-results（账本里还没有两臂齐全、判据完整的样本；先 run --live 或用 --report 导入）')
  const isAA = plan.hypothesis.lever === 'A/A'
  const split = plan.hypothesis.split || Object.fromEntries(plan.tasks.map((t) => [t, loadPool().split[t] || 'dev']))
  const key = hypothesisKey(plan.hypothesis.lever, plan.hypothesis.value, plan.hypothesis.champion)
  const hyp = history.hypotheses[key] || { key, lever: plan.hypothesis.lever, value: plan.hypothesis.value, champion: plan.hypothesis.champion, kind: plan.hypothesis.kind, ...(plan.hypothesis.policy ? { policy: plan.hypothesis.policy } : {}), outcomes: [], decision: 'continue', rounds: [] }
  if (hyp.decision !== 'continue') throw new Error('hypothesis-already-decided:' + key)
  for (const p of pairs) hyp.outcomes.push({ round, task: p.task, split: split[p.task] || 'dev', sample: p.sample, outcome: p.outcome, candidate: p.candidate, control: p.control, candidateAction: p.candidateAction, controlAction: p.controlAction })
  hyp.rounds.push(round)
  const allSplit = Object.fromEntries(hyp.outcomes.map((o) => [o.task, o.split || 'dev']))
  const d3 = decideV4({ pairs: hyp.outcomes, split: allSplit, aa: isAA })
  const seq = d3.all
  hyp.decision = d3.decision
  hyp.e = d3.e
  hyp.posterior = { n: seq.n, wins: seq.wins, losses: seq.losses, ties: seq.ties, pWin: seq.pWin, mean: seq.mean, ci95: seq.ci95, bitsBought: bitsBought(seq.alpha, seq.beta), nextPairBits: expectedBitsNextPair(seq.alpha, seq.beta) }
  hyp.v3 = { dev: d3.dev, holdout: d3.holdout, holdoutRecord: d3.holdoutRecord, nEff: d3.nEff, replicatesPerTask: d3.replicatesPerTask, why: d3.why, e: d3.e, thresholds: d3.thresholds }
  if (d3.decision !== 'continue') hyp.decidedAtRound = round
  history.hypotheses[key] = hyp
  if (isAA) history.calibration = { round, at: now, n: seq.n, tieRate: d3.tieRate, winRate: d3.winRate, instrument: d3.instrument, why: d3.why }
  // 训练数据飞轮：非平局配对 → 偏好对（谁赢谁是 chosen）；只追加、不改写；GPU 到位时才谈权重训练
  const flywheel = []
  for (const p of pairs) {
    if (p.outcome === 'tie' || isAA) continue
    const v = plan.variants?.[p.task]; if (!v) continue
    const win = p.outcome === 'win'
    flywheel.push({ schema: 'cfb.pref-pair/1', at: now, round, task: p.task, split: split[p.task] || 'dev', lever: hyp.lever, value: hyp.value, policy: plan.hypothesis.policy || null, chosen: win ? 'candidate' : 'control', chosenText: win ? v.candidate : v.control, rejectedText: win ? v.control : v.candidate, scores: { candidate: p.candidate, control: p.control }, planDigest: evidenceDigest(plan) })
  }
  if (flywheel.length) { ensure(path.dirname(TRAIN_PAIRS)); fs.appendFileSync(TRAIN_PAIRS, flywheel.map((x) => JSON.stringify(x)).join('\n') + '\n') }
  const watermark = readWatermark(receiptPath)
  const roundEntry = { round, at: now, status: 'ingested', key, lever: hyp.lever, value: hyp.value, champion: hyp.champion, tasks: plan.tasks, planDigest: evidenceDigest(plan), scope: planScope(plan),
    pairs: pairs.length, outcomes: pairs.map((p) => ({ task: p.task, split: split[p.task] || 'dev', outcome: p.outcome, candidate: p.candidate, control: p.control })), decision: d3.decision, pWin: seq.pWin, holdoutPWin: d3.holdout?.pWin ?? null, flywheelPairs: flywheel.length,
    reservedUsd: watermark ? +(watermark.reservedNano / 1e9).toFixed(4) : (rep.reservedUsd ?? null), requestsReserved: watermark?.requests ?? rep.requestsReserved ?? null, rejected: rep.requestsRejected || [], ingestedFrom: report ? 'report-file' : 'ledger', complete: !!rep.complete }
  history.rounds = history.rounds.filter((r) => r.round !== round).concat([roundEntry]).sort((a, b) => a.round - b.round)
  let championChange = null
  if (!isAA && d3.decision !== 'continue') bumpExposure(plan.tasks, split, round, d3.decision)
  if (d3.decision === 'adopt-provisional') {
    const prev = readJson(CHAMPION) || { schema: 'cfb.champion/1', knobs: { ...BASELINE_KNOBS }, policy: 'base', adopted: [] }
    const isPolicy = hyp.lever === 'policy'
    const next = isPolicy ? { ...hyp.champion } : { ...hyp.champion, [hyp.lever]: hyp.value }
    const nextPolicy = isPolicy ? hyp.value : (prev.policy || 'base')
    championChange = { from: { knobs: hyp.champion, policy: prev.policy || 'base' }, to: { knobs: next, policy: nextPolicy } }
    writeJson(CHAMPION, { schema: 'cfb.champion/3', knobs: next, policy: nextPolicy, adoption: 'provisional', previous: { knobs: hyp.champion, policy: prev.policy || 'base' }, confirmation: null, adopted: [...(prev.adopted || []), { round, lever: hyp.lever, value: hyp.value, pWin: seq.pWin, holdoutPWin: d3.holdout?.pWin ?? null, e: d3.e, n: seq.n, nEff: d3.nEff, kind: hyp.kind, adoption: 'provisional' }], at: now })
    if (isPolicy) { const pf = path.join(POLICIES, hyp.value + '.json'), pol = readJson(pf); if (pol) writeJson(pf, { ...pol, status: 'adopted', adoptedAt: now, adoptedRound: round }) }
    history.champion = next
  } else if (d3.decision === 'reject' && hyp.lever === 'policy') { const pf = path.join(POLICIES, hyp.value + '.json'), pol = readJson(pf); if (pol) writeJson(pf, { ...pol, status: 'rejected', rejectedRound: round }) }
  writeJson(HISTORY, history)
  const out = { round, key, pairs: pairs.map((p) => ({ ...p, split: split[p.task] || 'dev' })), posterior: hyp.posterior, v3: hyp.v3, decision: d3.decision, calibration: isAA ? history.calibration : null, championChange, flywheelPairs: flywheel.length, reservedUsd: roundEntry.reservedUsd, ingestedFrom: roundEntry.ingestedFrom, complete: roundEntry.complete }
  writeJson(path.join(OFFLINE, 'round-' + round + '.result.json'), { schema: 'cfb.cycle-result/3', at: now, ...out })
  return out
}
export function renderIngestMd(r) {
  const L = [`# 第 ${r.round} 轮回灌：${r.key}`, '', `来源：${r.ingestedFrom}；账本完整：${r.complete ? '是' : '否（有样本缺失 / 被拒，按已有配对计）'}；本轮预占 USD ${r.reservedUsd ?? '—'}`, '']
  L.push('| 任务 | 切分 | candidate 结构分 | control 结构分 | 结果 |', '| --- | --- | --- | --- | --- |')
  for (const p of r.pairs) L.push(`| ${p.task} | ${p.split} | ${p.candidate} | ${p.control} | ${p.outcome} |`)
  if (r.v3) L.push('', `留出题：${r.v3.holdout ? `${r.v3.holdout.n} 对（胜 ${r.v3.holdout.wins} / 负 ${r.v3.holdout.losses} / 平 ${r.v3.holdout.ties}，P(p>0.5)=${r.v3.holdout.pWin}）` : '0 对'}，不同留出题 ${r.v3.holdoutRecord?.tasks ?? 0}；dev：${r.v3.dev ? `${r.v3.dev.n} 对，P=${r.v3.dev.pWin}` : '0 对'}；有效 n（ICC 折算）${r.v3.nEff}；判据：${r.v3.why}`)
  if (r.v3?.e) L.push('', `e 值（任意停时有效，v4）：留出 ${r.v3.e.holdout} / 全部 ${r.v3.e.all} / 「更差」${r.v3.e.reject}；采纳阈 ≥ ${r.v3.thresholds?.adopt}（α=${DEFAULT_DESIGN_V4.alphaHoldout}），否决阈 ≥ ${r.v3.thresholds?.reject}`)
  if (r.calibration) L.push('', `**A/A 校准**：平局率 ${r.calibration.tieRate}，candidate 胜率 ${r.calibration.winRate} ⇒ 仪器 ${r.calibration.instrument}（${r.calibration.why}）`)
  if (r.flywheelPairs) L.push('', `飞轮：追加 ${r.flywheelPairs} 个偏好对到 .cfb-offline/train/pairs.jsonl`)
  const po = r.posterior
  L.push('', `累计 ${po.n} 对：胜 ${po.wins} / 负 ${po.losses} / 平 ${po.ties}；p 后验均值 ${po.mean}，95% ${po.ci95.join('–')}，P(p>0.5)=${po.pWin}；已买到 ${po.bitsBought} bit，再买一对期望 ${po.nextPairBits} bit`)
  L.push('', `**判定：${r.decision}**` + (r.decision === 'calibrated' ? '  ⇒ 仪器已校准，下一轮开始测假设' : r.decision === 'stop-undecided' ? '  ⇒ 到上限仍未判，不采纳；换假设' : r.decision === 'adopt-provisional' ? `  ⇒ champion **临时**更新：${JSON.stringify(r.championChange.to)}（下一轮 control 就是它；进生产前须 \`confirm --results\` 用 L2 端到端结局确认，或 \`propose --allow-provisional\`）` : r.decision === 'reject' ? '  ⇒ 这个旋钮不进生产；下一轮换下一个假设' : r.decision === 'continue' ? '  ⇒ 证据不够：下一轮 `plan` 会继续同一假设' : '  ⇒ 到上限仍分不出：效应量 < 可判定下限，不再为它花钱'))
  const exw = exposureWarnings(); if (exw.length) L.push('', ...exw.map((w) => '⚠ ' + w))
  return L.join('\n')
}
function cmdIngest(args) {
  const round = Number(f(args, '--round'))
  if (!Number.isInteger(round) || round < 1) throw new Error('--round 必填')
  const reportFile = f(args, '--report')
  const report = reportFile ? readJson(reportFile) : null
  if (reportFile && !report) throw new Error('report-unreadable')
  const r = ingestRound({ round, report })
  const md = renderIngestMd(r)
  fs.writeFileSync(path.join(OFFLINE, 'round-' + round + '.result.md'), md + '\n')
  console.log(md)
}

// ── 5. propose ──────────────────────────────────────────────────────────────
export function proposeFrom(champion = loadChampion(), championFile = readJson(CHAMPION)) {
  const configDiff = {}, needsSrcChange = [], unchanged = []
  for (const [k, v] of Object.entries(champion)) {
    if (BASELINE_KNOBS[k] === v) { unchanged.push(k); continue }
    const spec = KNOBS[k]
    const ev = (championFile?.adopted || []).filter((a) => a.lever === k && a.value === v)
    if (spec.kind === 'config') {
      if (k === 'bind') configDiff[spec.production] = v !== 'off'
      else configDiff[spec.production] = v
    } else needsSrcChange.push({ knob: k, value: v, kind: spec.kind, where: spec.production || 'src/compile-v4.js compileV4Direct', note: spec.kind === 'program' ? `为程序部件加配置开关（默认保持现状），开关=off 时跳过该 spliceProgramParts 分支；候选生成器的 strip 变换就是它的离线等价物` : `把 candidates.mjs 的 ${k}Transform 原样搬进 compileV4Direct，置于 bindFixBranches 之后、长度熔断之前，受新配置键控制（默认关闭）`, evidence: ev })
  }
  // 已采纳的提示词策略 → src/prompts.js 的补丁说明（补丁文本 + 落点）；base 时为 null
  let promptPatch = null
  const pid = championFile?.policy || 'base'
  if (pid !== 'base') {
    const chain = []; let cur = loadPolicy(pid)
    while (cur && cur.id !== 'base') { chain.unshift(cur); cur = cur.parent && cur.parent !== 'base' ? loadPolicy(cur.parent) : null }
    promptPatch = { policy: pid, lineage: chain.map((c) => c.id), where: 'src/prompts.js buildCompressPromptV4Direct：在【风格样例】之前插入「【补充规则】」段（append:rules）/ 末尾追加（append:tail）/ 原文替换（replace，须唯一命中）', patches: chain.flatMap((c) => c.patches.map((x) => ({ ...x, from: c.id }))), evidence: (championFile?.adopted || []).filter((a) => a.lever === 'policy').map((a) => ({ round: a.round, value: a.value, pWin: a.pWin, holdoutPWin: a.holdoutPWin, n: a.n })), note: '生产提示词版本号要随之升（v4d9 → v4d10），并把这些题的 side 重新编译；旧提示词路径保留可回滚。' }
  }
  return { schema: 'cfb.proposal/3', at: new Date().toISOString(), champion, policy: pid, promptPatch, baseline: BASELINE_KNOBS, configDiff, needsSrcChange, unchanged, adopted: championFile?.adopted || [], rule: '只有 ingest 判 adopt 的旋钮才出现在这里；配置 diff 可直接落 deploy / 本机 config，src 改动按 needsSrcChange 由人实施并走 verify + audit-noninferiority' }
}
function cmdPropose(args = []) {
  const cf = readJson(CHAMPION)
  if (cf?.adoption === 'provisional' && !args.includes('--allow-provisional')) throw new Error('champion-provisional：最近一次采纳只过了 L1 代理尺，尚未经 L2 端到端结局确认；先 `confirm --results FILE`（traj-run 续跑 champion vs previous），或明知风险用 --allow-provisional')
  const p = proposeFrom()
  writeJson(path.join(OFFLINE, 'proposal.json'), p)
  const L = ['# 生产提案（只含已采纳的旋钮）', '', 'champion: `' + JSON.stringify(p.champion) + '`', '']
  if (!Object.keys(p.configDiff).length && !p.needsSrcChange.length) L.push('还没有任何旋钮通过序贯判定；生产配置保持现状。')
  if (Object.keys(p.configDiff).length) L.push('## 配置 diff（可直接落）', '', '```json', JSON.stringify(p.configDiff, null, 2), '```', '')
  for (const n of p.needsSrcChange) L.push(`## 需要改 src：${n.knob}=${n.value}（${n.kind}）`, '', `- 落点：${n.where}`, `- 做法：${n.note}`, `- 证据：${n.evidence.map((e) => `第 ${e.round} 轮 P(p>0.5)=${e.pWin}，n=${e.n}`).join('；') || '—'}`, '')
  if (p.promptPatch) { L.push(`## 需要改提示词：策略 ${p.promptPatch.policy}（谱系 ${p.promptPatch.lineage.join(' → ')}）`, '', `- 落点：${p.promptPatch.where}`, `- 证据：${p.promptPatch.evidence.map((e) => `第 ${e.round} 轮 P=${e.pWin}（留出 ${e.holdoutPWin}），n=${e.n}`).join('；') || '—'}`, `- ${p.promptPatch.note}`, '', '```json', JSON.stringify(p.promptPatch.patches, null, 2), '```', '') }
  if (!Object.keys(p.configDiff).length && !p.needsSrcChange.length && !p.promptPatch) L.push('')
  console.log(L.join('\n'))
  console.log('已写入 .cfb-offline/proposal.json')
}

// ── 5b. v4 尺子：confirm（L2 端到端结局确认 / 回滚）与 ruler（效度账本 / 曝光 / 排序器 / L2 基线）────────
/** rows 来自 tools/traj-run.mjs 的 results.jsonl（或同构 JSON 数组）；--map champion=auto,previous=raw 把 variant 映射成臂。 */
export function confirmFrom({ rows, map = { champion: 'champion', previous: 'previous' }, alpha = DEFAULT_DESIGN_V4.alphaHoldout, now = new Date().toISOString() }) {
  const arm = (r) => r.arm || (r.variant === map.champion ? 'champion' : r.variant === map.previous ? 'previous' : null)
  const typed = rows.map((r) => ({ ...r, arm: arm(r) })).filter((r) => r.arm)
  if (!typed.length) throw new Error('confirm-no-rows（没有能映射成 champion / previous 的行；用 --map champion=<variant>,previous=<variant>）')
  const cmp = outcomeComparison(typed)
  // 效度配对：同一样本既有 L1 代理分（proxyScore / structural）又有 L2 结局 → 追加账本
  const validity = typed.filter((r) => Number.isFinite(r.proxyScore ?? r.structural)).map((r) => ({ schema: 'cfb.validity-pair/1', at: now, task: r.task, arm: r.arm, sample: r.sample ?? 0, proxy: r.proxyScore ?? r.structural, outcome: episodeOutcome(r).solved ? 1 : 0, roundsToFix: episodeOutcome(r).roundsToFix }))
  const cf = readJson(CHAMPION)
  let verdict = 'report-only', championAfter = cf
  if (cf?.adoption === 'provisional') {
    if (cmp.pairs.length < 4 || new Set(cmp.pairs.map((p) => p.task)).size < 2) verdict = 'pending'
    else if (cmp.e >= 1 / alpha) { verdict = 'confirmed'; championAfter = { ...cf, adoption: 'confirmed', confirmation: { at: now, pairs: cmp.pairs.length, e: cmp.e, champion: cmp.champion, previous: cmp.previous } } }
    else if (cmp.eReject >= 1 / alpha) { verdict = 'rolled-back'; championAfter = { schema: 'cfb.champion/3', knobs: cf.previous.knobs, policy: cf.previous.policy, adoption: 'confirmed', previous: null, confirmation: null, adopted: (cf.adopted || []).slice(0, -1), rolledBack: [...(cf.rolledBack || []), { at: now, from: { knobs: cf.knobs, policy: cf.policy }, e: cmp.e, eReject: cmp.eReject, pairs: cmp.pairs.length }], at: now } }
    else verdict = 'pending'
  }
  return { cmp, validity, verdict, championBefore: cf, championAfter }
}
function cmdConfirm(args) {
  const file = f(args, '--results'); if (!file || !fs.existsSync(file)) throw new Error('--results FILE 必填（traj-run 的 results.jsonl 或 JSON 数组）')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const rows = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const map = Object.fromEntries((f(args, '--map') || 'champion=champion,previous=previous').split(',').map((kv) => kv.split('=')))
  const r = confirmFrom({ rows, map })
  if (r.verdict === 'confirmed' || r.verdict === 'rolled-back') writeJson(CHAMPION, r.championAfter)
  if (r.validity.length) { ensure(RULER_DIR); fs.appendFileSync(VALIDITY, r.validity.map((x) => JSON.stringify(x)).join('\n') + '\n') }
  ensure(RULER_DIR); const n = fs.readdirSync(RULER_DIR).filter((x) => x.startsWith('confirm-')).length + 1
  writeJson(path.join(RULER_DIR, 'confirm-' + n + '.json'), { schema: 'cfb.confirm/1', at: new Date().toISOString(), source: path.relative(ROOT, path.resolve(file)), map, ...r })
  const L = ['# L2 端到端结局确认（' + r.verdict + '）', '', '| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const [k, v] of [['previous', r.cmp.previous], ['champion', r.cmp.champion]]) L.push(`| ${k} | ${v.n} | ${v.solved ?? '—'} | ${v.meanRoundsToFix ?? '—'} | ${v.falseClaims} | ${v.verified} | ${v.repeats} |`)
  L.push('', `配对 ${r.cmp.pairs.length}（${r.cmp.pairs.map((p) => p.task + ':' + p.outcome).join(' ')}）；e=${r.cmp.e}，「更差」e=${r.cmp.eReject}，阈 ${+(1 / DEFAULT_DESIGN_V4.alphaHoldout).toFixed(1)}`)
  L.push('', r.verdict === 'confirmed' ? '**champion 确认**：L2 结局证实 L1 采纳；`propose` 现在可出生产 diff' : r.verdict === 'rolled-back' ? '**回滚**：L2 结局证伪 L1 采纳，champion 恢复为 previous（L1 尺子对这个方向可能失效，看 `ruler`）' : r.verdict === 'pending' ? '**待定**：L2 配对不够（需 ≥4 对、≥2 题、e ≥ 阈），继续续跑' : '**只报告**：当前 champion 不是 provisional；本次结果只进效度账本')
  if (r.validity.length) L.push('', `效度账本 +${r.validity.length} 对（L1 代理分 ↔ L2 修好）`)
  console.log(L.join('\n'))
}
/** 零 API：尺子状态总览。transfer/trajN/results.jsonl 若存在，则给出 L2 基线（raw vs auto）。 */
export function rulerReport({ validity = loadValidity(), exposure = loadExposure(), flywheel = loadFlywheel(), trajDirs = ['traj1', 'traj2', 'traj3'] } = {}) {
  const v = rulerValidity(validity.map((x) => ({ proxy: x.proxy, outcome: x.outcome })))
  const pol = adoptionPolicy(v)
  const rk = trainRanker(flywheel)
  const trajRows = trajDirs.flatMap((d) => readJsonl(path.join(ROOT, 'transfer', d, 'results.jsonl')).map((r) => ({ ...r, dir: d })))
  const baseline = trajRows.length ? outcomeComparison(trajRows.map((r) => ({ ...r, arm: r.variant === 'auto' ? 'champion' : r.variant === 'raw' ? 'previous' : null, sample: `${r.dir}#${r.sample ?? 0}` })).filter((r) => r.arm)) : null
  const retro = trajRows.length ? retroValidity(trajRows) : null
  // 信息产出 / 美元（估：主调用 ≈ $0.0125、压缩调用 ≈ $0.0075，按 §7 的 token 算术；分叉轨迹 2 臂 × 5 题 × ≤4 轮）
  const main = 0.0125, comp = 0.0075, tasks = 6, rounds = 4   // 6 = 3 个假仓库场景 × 2 样本（traj-fixtures；与 v9 冻结 5 题是不同分布——对 champion 是更严的泛化测试）
  const infoYield = [
    { unit: 'v9 L1 轮（13 请求，冻结两轮状态）', usd: +(10 * main + 3 * 0.0003).toFixed(3), l1Pairs: tasks, l2Pairs: 0, validityPairs: 0, flywheelPairs: tasks, childStates: 0 },
    { unit: `分叉全轨迹（2 臂 × 3 场景 × 2 样本 × ≤${rounds} 轮，第 1 轮共用）`, usd: +((tasks * (1 + 2 * (rounds - 1))) * main + (2 * tasks * (rounds - 1)) * comp).toFixed(3), l1Pairs: tasks, l2Pairs: tasks, validityPairs: 2 * tasks * (rounds - 1), flywheelPairs: 2 * tasks * (rounds - 1), childStates: 2 * tasks * (rounds - 2) }
  ].map((r) => ({ ...r, perUsd: { l1: +(r.l1Pairs / r.usd).toFixed(1), l2: +(r.l2Pairs / r.usd).toFixed(1), validity: +(r.validityPairs / r.usd).toFixed(1) } }))
  return { retro, infoYield, validity: v, policy: pol, exposure: Object.entries(exposure.tasks).map(([task, e]) => ({ task, n: e.n, retire: e.n >= HOLDOUT_MAX_EXPOSURE })), ranker: { status: rk.status, pairs: rk.pairs, cvAcc: rk.cvAcc, top: rk.top || null, note: rk.note }, baseline: baseline ? { trajectories: trajRows.length, raw: baseline.previous, auto: baseline.champion, pairs: baseline.pairs.length, e: baseline.e, eReject: baseline.eReject } : null, alphaTable: [0.1, 0.05].map((a) => ({ alpha: a, threshold: +(1 / a).toFixed(0), straightWins: winsNeeded(a), pStraightUnderNull: +Math.pow(0.5, winsNeeded(a)).toFixed(4), falseAdoptPerHypothesis: a, over6Hypotheses: +(1 - Math.pow(1 - a, 6)).toFixed(3) })) }
}
function cmdRuler() {
  const r = rulerReport()
  console.log(`尺子效度（L1 代理分 ↔ L2 修好）：${r.validity.status}  n=${r.validity.n} AUC=${r.validity.auc ?? '—'} CI95=${r.validity.ci95 ? r.validity.ci95.join('–') : '—'}  — ${r.validity.why}`)
  console.log(`采纳规则：${r.policy.note}`)
  console.log('e 值预算：' + r.alphaTable.map((a) => `α=${a.alpha} ⇒ 阈 ${a.threshold}、留出连胜 ${a.straightWins} 场（零效应下走到这条路的概率 ${(a.pStraightUnderNull * 100).toFixed(1)}%；含任意偷看的误采纳上界 ${a.alpha * 100}%/假设，6 个假设 ≤ ${(a.over6Hypotheses * 100).toFixed(0)}%）`).join('；'))
  console.log('留出题曝光：' + (r.exposure.length ? r.exposure.map((e) => `${e.task}×${e.n}${e.retire ? '（应退役）' : ''}`).join(' ') : '尚无判定'))
  console.log(`排序器（CPU，飞轮偏好对）：${r.ranker.status} pairs=${r.ranker.pairs} cvAcc=${r.ranker.cvAcc ?? '—'}${r.ranker.top ? ' top=' + r.ranker.top.map((t) => t.name + ':' + t.w).join(',') : ''}  — ${r.ranker.note}`)
  if (r.retro) console.log(`回溯效度（执行器代理 ↔ 修好，零 API，${r.retro.steps} 步）：轨迹级 n=${r.retro.trajectory.n}（负例 ${r.retro.trajectory.neg}）AUC=${r.retro.trajectory.auc ?? '—'} ⇒ ${r.retro.trajectory.status}；步级 n=${r.retro.step.n}/${r.retro.step.clusters} 簇 AUC=${r.retro.step.auc ?? '—'} CI=${r.retro.step.ci95 ? r.retro.step.ci95.join('–') : '—'} ⇒ ${r.retro.step.status}；第 2 轮 n=${r.retro.round2.n} AUC=${r.retro.round2.auc ?? '—'} ⇒ ${r.retro.round2.status}；旗标命中率 ${Object.entries(r.retro.flagRates).map(([k, v]) => k + ' ' + v).join(' ')}（next/avoid 接近天花板：这些题上 L1 几乎不区分，区分的是到修好的轮数）`)
  console.log('信息产出/美元（估）：' + r.infoYield.map((x) => `${x.unit} ≈ $${x.usd} ⇒ L1 对 ${x.l1Pairs}、L2 对 ${x.l2Pairs}、效度对 ${x.validityPairs}、飞轮对 ${x.flywheelPairs}、子状态 ${x.childStates}（每美元 L1 ${x.perUsd.l1} / L2 ${x.perUsd.l2} / 效度 ${x.perUsd.validity}）`).join('；'))
  if (r.baseline) console.log(`L2 基线（transfer/traj1–3，${r.baseline.trajectories} 条轨迹）：raw 修好率 ${r.baseline.raw.solved} / 到修好 ${r.baseline.raw.meanRoundsToFix} 轮 / 假宣称 ${r.baseline.raw.falseClaims}；auto 修好率 ${r.baseline.auto.solved} / ${r.baseline.auto.meanRoundsToFix} 轮 / 假宣称 ${r.baseline.auto.falseClaims}；同题同样本配对 ${r.baseline.pairs}，e=${r.baseline.e}（auto 更好）/ ${r.baseline.eReject}（auto 更差）⇒ ${r.baseline.e >= 1 / DEFAULT_DESIGN_V4.alphaHoldout ? 'auto 过 α=' + DEFAULT_DESIGN_V4.alphaHoldout + ' 阈' : r.baseline.eReject >= 1 / DEFAULT_DESIGN_V4.alphaHoldout ? 'auto 更差过阈' : '方向支持 auto，但未过 α=' + DEFAULT_DESIGN_V4.alphaHoldout + ' 的任意时刻阈（' + (1 / DEFAULT_DESIGN_V4.alphaHoldout).toFixed(0) + '）'}`)
  console.log('下一步（v4.1 已接通）：`node tools/traj-run.mjs --variants raw --policy base,<champion> --fork --samples 1 --max-rounds 4 --require-fp … --out trajN` ⇒ `confirm --results trajN/results.jsonl --map champion=policy:<id>,previous=policy:base`；每行自带 proxyScore，L2 结局与效度配对同一次付费产出。')
}

// ── 6. status / doctor / simulate ───────────────────────────────────────────
function cmdStatus() {
  const h = loadHistory(), champion = loadChampion()
  console.log('champion: ' + JSON.stringify(champion) + (short(champion) === short(BASELINE_KNOBS) ? '（= 生产基线）' : ''))
  console.log('轮次: ' + h.rounds.length + '；累计预占 USD ' + h.rounds.reduce((a, r) => a + (r.status === 'ingested' ? r.reservedUsd || 0 : 0), 0).toFixed(4) + '（只算已回灌的轮）')
  for (const r of h.rounds) console.log(`  r${r.round} ${r.status.padEnd(8)} ${r.lever}=${r.value} tasks=${(r.tasks || []).length}` + (r.status === 'ingested' ? ` pairs=${r.pairs} decision=${r.decision} P=${r.pWin} USD=${r.reservedUsd ?? '—'}` : ` reserved≈${r.reservedUsd ?? '未定价'}`))
  console.log('仪器校准: ' + (h.calibration ? `r${h.calibration.round} 平局率 ${h.calibration.tieRate} 胜率 ${h.calibration.winRate} ⇒ ${h.calibration.instrument}` : '尚无（首轮 plan 默认 A/A）') + '；champion 策略: ' + (readJson(CHAMPION)?.policy || 'base'))
  for (const g of h.generations || []) console.log(`  g${g.gen} ${String(g.status).padEnd(8)} ${g.role} ${g.label || ''} reserved≈${g.reservedUsd ?? '未定价'}${g.policy ? ' → ' + g.policy : ''}`)
  const hs = Object.values(h.hypotheses || {})
  console.log('假设: ' + hs.length)
  for (const x of hs) console.log(`  ${x.key} ${x.decision} n=${x.outcomes.length} P(p>0.5)=${x.posterior?.pWin ?? '—'} e=${x.e?.holdout ?? '—'}/${x.e?.all ?? '—'} bits=${x.posterior?.bitsBought ?? '—'}`)
  const cf = readJson(CHAMPION); const rv = rulerValidity(loadValidity().map((x) => ({ proxy: x.proxy, outcome: x.outcome })))
  console.log(`尺子: 效度 ${rv.status}（n=${rv.n}）；champion 采纳状态 ${cf?.adoption || (cf ? 'legacy' : 'baseline')}` + (cf?.adoption === 'provisional' ? '（待 L2 确认：confirm --results）' : '') + (exposureWarnings().length ? '；⚠ ' + exposureWarnings().join('；') : ''))
}
export function doctorChecks() {
  const checks = []
  let tasks = [], cands = [], rows = []
  try { tasks = loadFrozenTasks(); checks.push(['冻结任务可加载（chains / d1 / d2 / specs）', tasks.length === 5, tasks.length + '/5']) } catch (e) { checks.push(['冻结任务可加载', false, e.message]) }
  try { const pool = loadPool(); checks.push(['任务池可构建、切分确定（holdout ≥ 2）', pool.tasks.filter((t) => t.split === 'holdout').length >= 2 && !pool.warnings.length, `${pool.tasks.length} 题 ${pool.digest}；留出 ${pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id).join(',')}${pool.warnings.length ? '；⚠ ' + pool.warnings.join(';') : ''}`]) } catch (e) { checks.push(['任务池可构建', false, e.message]) }
  try { const cp = loadChampionPolicy(); checks.push(['champion 策略可加载', !!cp.id, cp.id + (cp.id === 'base' ? '（= 生产 v4d9 提示词）' : '')]) } catch (e) { checks.push(['champion 策略可加载', false, e.message]) }
  checks.push(['v3 判定：留出闸门 / A/A 校准', decideV3({ pairs: [{ task: 'h1', outcome: 'win' }, { task: 'h2', outcome: 'win' }, { task: 'h1', outcome: 'win' }, { task: 'h2', outcome: 'win' }], split: { h1: 'holdout', h2: 'holdout' } }).decision === 'adopt' && decideV3({ pairs: Array.from({ length: 5 }, (_, i) => ({ task: 'd' + i, outcome: 'win' })), split: {} }).decision === 'continue' && decideV3({ pairs: [{ task: 'a', outcome: 'tie' }, { task: 'b', outcome: 'tie' }, { task: 'c', outcome: 'win' }], split: {}, aa: true }).decision === 'calibrated', ''])
  if (tasks.length) {
    const champion = loadChampion()
    cands = generateCandidates(tasks, { champion }); rows = offlineTable(tasks, cands)
    const ctrl = armSummary(cands).find((a) => a.arm === 'control')
    checks.push(['control（当前 champion 生产重编译）全部过生产闸门', ctrl.feasible === tasks.length, `${ctrl.feasible}/${tasks.length}`])
    const dir = rows.filter((r) => r.arm === 'control').filter((r) => r.composite > r.rawComposite).length
    checks.push(['真值维度方向校验：生产稿 > 原文（与 v8 live 效应同向）', dir >= 4, `${dir}/${tasks.length} 题`])
    const testable = LEVER_ORDER.flatMap((l) => KNOBS[l].values.filter((v) => champion[l] !== v).map((v) => armVerdict(rows, l + '=' + v))).filter((v) => v.usable >= 3)
    checks.push(['至少一个杠杆可测（可用 ≥3 题）', testable.length > 0, testable.map((v) => `${v.arm}:${v.usable}${v.safe ? '' : '⚠'}`).join(' ')])
    const deg = armSummary(cands).filter((a) => a.lever && a.degenerate === a.tasks).map((a) => a.arm)
    checks.push(['退化臂已标出（不会混进打分）', true, deg.length ? '全退化：' + deg.join(',') : '无全退化臂'])
  }
  checks.push(['实验算术：Beta 尾概率 / 序贯判定', Math.abs(betaCdf(0.5, 1, 1) - 0.5) < 1e-9 && sequentialPaired(['win', 'win', 'win', 'win', 'win']).decision === 'adopt' && sequentialPaired(['loss', 'loss', 'loss', 'loss', 'loss']).decision === 'reject', ''])
  checks.push(['评测 profile 样例存在', fs.existsSync(PROFILE_EXAMPLE), path.relative(ROOT, PROFILE_EXAMPLE)])
  checks.push(['live 运行时（Node ≥ 22；本机只影响 run --live，不影响 plan/ingest）', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node])
  const h = loadHistory()
  checks.push(['历史 / champion 可读', !!h && !!loadChampion(), `${h.rounds.length} 轮，${Object.keys(h.hypotheses || {}).length} 个假设`])
  return checks
}
function cmdDoctor() {
  let ok = true
  for (const [n, v, note] of doctorChecks()) { console.log((v ? 'PASS ' : 'FAIL ') + n + (note ? '  — ' + note : '')); if (!v && !/Node/.test(n)) ok = false }
  process.exitCode = ok ? 0 : 1
}
function cmdSimulate(args) {
  const p = Number(f(args, '--p') || 0.7), rounds = Number(f(args, '--rounds') || 5), per = Number(f(args, '--pairs') || 5)
  let s = 12345; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const out = []
  console.log(`纯算术演练（不写文件、不花钱）：真实胜率 ${p}，每轮 ${per} 对，最多 ${rounds} 轮；每轮预计实付 ≈ USD 0.13（5 对 + 3 探针，按 v8 收据口径）`)
  for (let r = 1; r <= rounds; r++) {
    for (let i = 0; i < per; i++) out.push(rnd() < 0.1 ? 'tie' : rnd() < p ? 'win' : 'loss')
    const seq = sequentialPaired(out)
    console.log(`  r${r}: n=${seq.n} W/L/T=${seq.wins}/${seq.losses}/${seq.ties} P(p>0.5)=${seq.pWin} bits=${bitsBought(seq.alpha, seq.beta)} ⇒ ${seq.decision}`)
    if (seq.decision !== 'continue') break
  }
  console.log('运行特性（2000 次模拟，上限 ' + DEFAULT_DESIGN.maxPairs + ' 对）：' + JSON.stringify(pairsToDecide({ pTrue: p, sims: 2000, cap: DEFAULT_DESIGN.maxPairs })))
}


// ── 7. 生成层（v3）：propose-policy / compile / mint / ingest-gen ───────────
function nextGen(history) { const used = (history.generations || []).map((g) => g.gen); return Math.max(0, ...used) + 1 }
function recordGen(history, entry) { history.generations = (history.generations || []).filter((g) => g.gen !== entry.gen).concat([entry]).sort((a, b) => a.gen - b.gen); writeJson(HISTORY, history) }
function genCostLines(g, plan, audit) {
  const cost = costEstimate({ plan, audit, pricing: plan.pricing })
  return { cost, lines: [`- 请求：${plan.jobs.length}（主 ${plan.jobs.filter((j) => j.kind === 'main').length} + 探针 3）；scope \`${planScope(plan)}\`；上限 USD ${APPROVED_API_LIMITS_GEN.maxUsd} / ${APPROVED_API_LIMITS_GEN.maxRequests} 请求`,
    `- 预占：${cost.reservedUsd == null ? '未定价（--pricing 才有）' : 'USD ' + cost.reservedUsd}；预计实付：${cost.expectedUsd == null ? '—' : 'USD ' + cost.expectedUsd}`, '', '```',
    `# 批准范围：scope ${planScope(plan)}，≤ ${plan.jobs.length} 请求，预占 ≤ USD ${cost.reservedUsd ?? '(定价后显示)'}，计划摘要 ${evidenceDigest(plan).slice(0, 16)}`,
    `node tools/effect-ready.mjs doctor --gen --round ${g}`, `node tools/effect-ready.mjs run --live --gen --round ${g}`, `node tools/cfb-cycle.mjs ingest-gen --gen ${g}`, '```'] }
}
/** 生成计划的公共尾巴：prepare（冻结）→ 审计 → 记 history.generations → 打印批准块。 */
function freezeGen({ g, generation, profile, pricing, history, label }) {
  const home = genHomeFor(g), receiptPath = genReceiptFor(g)
  if (readWatermark(receiptPath)) throw new Error('gen-already-has-receipt:' + g)
  prepareEvaluation({ home, receiptPath, profile, ...(pricing !== undefined ? { pricing } : {}), version: 10, generation, round: g, env: process.env })
  const plan = loadPrepared(home)
  let audit = null; try { audit = auditApiPlan(plan, { allowUnpriced: true }) } catch (e) { throw new Error('gen-plan-audit:' + e.message) }
  const { cost, lines } = genCostLines(g, plan, audit)
  recordGen(history, { gen: g, at: new Date().toISOString(), role: generation.role, status: 'planned', label, planDigest: evidenceDigest(plan), scope: planScope(plan), reservedUsd: cost.reservedUsd, expectedUsd: cost.expectedUsd, subject: plan.subject })
  const md = [`# 生成计划 g${g}：${label}（已冻结，未发任何请求）`, '', ...lines].join('\n')
  fs.writeFileSync(path.join(OFFLINE, 'gen-' + g + '.plan.md'), md + '\n')
  console.log(md); console.log('\n计划冻结在 ' + path.relative(ROOT, home) + '/plan.json')
  return { g, plan, cost }
}
function genArgs(args) {
  const history = loadHistory()
  const g = Number(f(args, '--gen') || nextGen(history))
  if (!Number.isInteger(g) || g < 1 || g > 40) throw new Error('gen-out-of-range')
  const profile = readJson(f(args, '--profile') || PROFILE_EXAMPLE); if (!profile) throw new Error('profile-unreadable')
  const pricingFile = f(args, '--pricing')
  return { history, g, profile, pricing: pricingFile ? readJson(pricingFile) : undefined }
}
/** propose-policy：提议器只看 dev 题的失败证据（留出题永不进提议器），输出受限补丁 → ingest-gen 过三闸后落成策略文件。 */
export function cmdProposePolicy(args) {
  ensure(OFFLINE)
  const { history, g, profile, pricing } = genArgs(args)
  const pool = loadPool(), parent = loadPolicy(f(args, '--parent') || readJson(CHAMPION)?.policy || 'base')
  const dev = pool.tasks.filter((t) => t.split === 'dev')
  if (!dev.length) throw new Error('no-dev-tasks')
  const plans = {}; for (const r of history.rounds) { try { plans[r.round] = loadPrepared(homeFor(r.round)) } catch { /* 无计划 */ } }
  const evidence = failureEvidence({ history, plans, split: pool.split })
  const extra = f(args, '--note')
  const generation = { role: 'propose', round: g, policy: parent, tasks: dev, evidence: extra ? evidence.concat([{ note: String(extra).slice(0, 600) }]) : evidence, devTaskIds: dev.map((t) => t.id) }
  console.log(`提议器输入：父策略 ${parent.id}；dev 题 ${dev.map((t) => t.id).join(',')}；失败证据 ${evidence.length} 条（留出题 ${pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id).join(',')} 已排除）`)
  freezeGen({ g, generation, profile, pricing, history, label: 'propose ← ' + parent.id })
}
/** compile：按策略重压 side（≤5 题 / 计划；缺哪些题就压哪些），或为铸造中的任务压 r1 / side（--mint ID）。 */
export function cmdCompile(args) {
  ensure(OFFLINE)
  const { history, g, profile, pricing } = genArgs(args)
  const mint = f(args, '--mint')
  if (mint) {
    const pf = path.join(TASKS_DIR, mint + '.partial.json'), part = readJson(pf)
    if (!part?.chain?.a1?.raw || !part.chain?.a2?.raw) throw new Error('mint-partial-incomplete（需先 mint --step a、补 u2、mint --step b）')
    // r1 的 ctx = 第 1 轮生产口径：system + u1（+ a1 的工具调用块）；side 的 ctx = 两轮生产口径（需要 r1）
    const t1 = { id: mint + '#r1', chain: { a2: { raw: part.chain.a1.raw } }, ctx: I.buildCompressCtx([{ role: 'system', content: '你是在代码仓库里干活的编码 Agent。' }, { role: 'user', content: part.chain.u1 }]) + (part.chain.a1Call ? '\n\n' + I.turnCallsBlock([{ name: 'bash', args: { command: part.chain.a1Call } }]) : '') }
    const t2 = { id: mint + '#side', chain: { a2: { raw: part.chain.a2.raw } }, ctx: productionContext(part.chain, part.r1 || '') }
    if (!part.r1) { console.log('先压 r1（第 1 轮稿）；拿到后再 compile --mint 压 side'); return freezeGen({ g, generation: { role: 'compile', round: g, policy: BASE_POLICY, tasks: [t1] }, profile, pricing, history, label: 'compile mint ' + mint + ' r1' }) }
    return freezeGen({ g, generation: { role: 'compile', round: g, policy: BASE_POLICY, tasks: [t2] }, profile, pricing, history, label: 'compile mint ' + mint + ' side' })
  }
  const id = f(args, '--policy'); if (!id || id === 'base') throw new Error('--policy ID 必填（base 不需要编译）')
  const policy = loadPolicy(id)
  const pool = loadPool()
  const want = f(args, '--tasks') ? f(args, '--tasks').split(',') : pool.tasks.map((t) => t.id)
  const missing = pool.tasks.filter((t) => want.includes(t.id) && !policy.sides?.[t.id]).slice(0, 5)
  if (!missing.length) { console.log('策略 ' + id + ' 对这些题已全部编译；无需花钱'); return }
  console.log(`按策略 ${id} 重压 side：${missing.map((t) => t.id).join(',')}（${pool.tasks.length - missing.length} 题已有）`)
  freezeGen({ g, generation: { role: 'compile', round: g, policy, tasks: missing }, profile, pricing, history, label: 'compile ' + id })
}
/** mint：付费铸造新任务。--step a：u1 → a1；--step b：需人工在 .partial.json 里补 u2 后，a1 + u2 → a2。 */
export function cmdMint(args) {
  ensure(TASKS_DIR)
  const { history, g, profile, pricing } = genArgs(args)
  const step = f(args, '--step') || 'a', scenarioFile = f(args, '--scenario')
  if (step === 'a') {
    const sc = readJson(scenarioFile); if (!sc || !TASK_ID_RE.test(sc.id || '') || typeof sc.u1 !== 'string' || typeof sc.followup !== 'string') throw new Error('scenario 需含 id / u1 / followup（可选 next / avoid / u2）')
    if (fs.existsSync(path.join(TASKS_DIR, sc.id + '.task.json'))) throw new Error('task-exists:' + sc.id)
    writeJson(path.join(TASKS_DIR, sc.id + '.partial.json'), { schema: 'cfb.task-partial/1', id: sc.id, source: 'minted', scenario: sc, chain: { id: sc.id, u1: sc.u1, ...(sc.u2 ? { u2: sc.u2 } : {}) }, spec: { id: sc.id, obs: { red: { followup: sc.followup, ...(Array.isArray(sc.next) ? { next: sc.next } : {}), ...(Array.isArray(sc.avoid) ? { avoid: sc.avoid } : {}) } } }, steps: [] })
    return freezeGen({ g, generation: { role: 'mint-a', round: g, scenario: { id: sc.id, u1: sc.u1 } }, profile, pricing, history, label: 'mint-a ' + sc.id })
  }
  const id = f(args, '--id'); const pf = path.join(TASKS_DIR, id + '.partial.json'), part = readJson(pf)
  if (!part?.chain?.a1?.raw) throw new Error('mint-step-a-first')
  const u2 = part.chain.u2 || part.scenario?.u2; if (typeof u2 !== 'string' || !u2) throw new Error('需先在 ' + path.relative(ROOT, pf) + ' 的 chain.u2 写第 2 轮用户话（人写：观察 + 追问）')
  return freezeGen({ g, generation: { role: 'mint-b', round: g, scenario: { id, u1: part.chain.u1, a1: part.chain.a1, u2 } }, profile, pricing, history, label: 'mint-b ' + id })
}
/** ingest-gen：读生成计划的账本（或 --report），按角色落盘：策略文件 / side / 铸造部件。全程零 API。 */
export function ingestGen({ g, report = null, history = loadHistory(), now = new Date().toISOString() }) {
  const home = genHomeFor(g), receiptPath = genReceiptFor(g)
  const plan = loadPrepared(home)
  if (plan.schema !== 'cfb.generation/1' || plan.round !== g) throw new Error('gen-plan-mismatch')
  const entry = (history.generations || []).find((x) => x.gen === g)
  if (entry?.status === 'ingested') throw new Error('gen-already-ingested:' + g)
  const rep = report || reportEvaluation({ home, receiptPath })
  if (rep.schema !== 'cfb.generation-report/1' || rep.round !== g) throw new Error('gen-report-mismatch')
  const outputs = rep.outputs || []
  if (!outputs.length) throw new Error('no-gen-outputs（账本里还没有主请求结果；先 run --live 或 --report 导入）')
  const pool = loadPool()
  const result = { gen: g, role: plan.role, outputs: outputs.length, written: [], rejected: [] }
  if (plan.role === 'propose') {
    const o = outputs[0], parent = loadPolicy(plan.subject.policy.id)
    let proposal = null
    try { proposal = parseProposal(o.content); validatePatches(proposal.patches) } catch (e) { result.rejected.push({ key: o.key, reason: 'proposal-invalid:' + (e.message || e) }) }
    if (proposal) {
      const leaks = leakCheck(proposal.patches, pool.tasks, promptHead(pool.tasks[0]))
      if (leaks.length) result.rejected.push({ key: o.key, reason: 'leak:' + leaks.join(',') })
      else {
        const pol = makePolicy({ parent, patches: proposal.patches, rationale: String(proposal.rationale || '').slice(0, 1200), prediction: String(proposal.prediction || '').slice(0, 600), origin: { gen: g, planDigest: evidenceDigest(plan), evidence: plan.subject.evidence?.length || 0, devTaskIds: plan.subject.devTaskIds || [] } })
        const pf = path.join(POLICIES, pol.id + '.json')
        if (!fs.existsSync(pf)) writeJson(pf, { ...pol, at: now })
        result.written.push(path.relative(ROOT, pf)); result.policy = pol.id; result.patches = pol.patches
      }
    }
  } else if (plan.role === 'compile') {
    const pid = plan.subject.policy.id
    const mintOut = outputs.filter((o) => o.task?.includes('#'))
    if (mintOut.length) {
      for (const o of mintOut) {
        const [id, part] = o.task.split('#'), pf = path.join(TASKS_DIR, id + '.partial.json'), partial = readJson(pf)
        if (!partial) { result.rejected.push({ key: o.key, reason: 'partial-missing' }); continue }
        const text = (o.content || '').trim(); if (!text) { result.rejected.push({ key: o.key, reason: 'empty' }); continue }
        partial[part] = text; partial.steps.push({ gen: g, part, at: now })
        if (partial.r1 && partial.side) {
          const task = { schema: 'cfb.task/1', id, source: 'minted', chain: partial.chain, spec: partial.spec, r1: partial.r1, side: partial.side, origin: { steps: partial.steps, scenario: partial.scenario } }
          try { validateTaskFile(task); const c = renderCandidate({ ...task, ctx: productionContext(task.chain, task.r1) }, loadChampion()); task.sideGate = !!c.feasible; writeJson(path.join(TASKS_DIR, id + '.task.json'), { ...task, digest: taskDigest(task) }); fs.unlinkSync(pf); result.written.push(path.relative(ROOT, path.join(TASKS_DIR, id + '.task.json'))) } catch (e) { writeJson(pf, partial); result.rejected.push({ key: o.key, reason: 'task-invalid:' + (e.message || e) }) }
        } else { writeJson(pf, partial); result.written.push(path.relative(ROOT, pf)) }
      }
    } else {
      const pf = path.join(POLICIES, pid + '.json'), pol = readJson(pf); if (!pol) throw new Error('policy-missing:' + pid)
      pol.sides = pol.sides || {}
      for (const o of outputs) {
        const task = pool.tasks.find((t) => t.id === o.task); const text = (o.content || '').trim()
        if (!task || !text) { result.rejected.push({ key: o.key, reason: !task ? 'task-not-in-pool' : 'empty' }); continue }
        // 闸门打在「用这份 side 走生产编译后的候选稿」上（side 是中间件，生产闸门只认成稿）
        const c = renderCandidate({ ...task, side: text }, loadChampion())
        pol.sides[o.task] = { text, chars: text.length, gate: !!c.feasible, gateReason: c.feasible ? null : (c.gate?.invented?.length ? 'invented:' + c.gate.invented.slice(0, 3).join('|') : 'length-or-compile'), compiledChars: c.chars ?? null, gen: g }
      }
      const covered = pool.tasks.filter((t) => pol.sides[t.id]).length
      pol.status = covered === pool.tasks.length ? 'compiled' : 'partial'
      pol.compiled = { covered, of: pool.tasks.length, poolDigest: pool.digest, at: now }
      writeJson(pf, pol); result.written.push(path.relative(ROOT, pf)); result.policy = pid; result.sides = Object.fromEntries(Object.entries(pol.sides).map(([k, v]) => [k, { chars: v.chars, gate: v.gate }])); result.status = pol.status
    }
  } else {
    const o = outputs[0], id = plan.subject.scenario.id, pf = path.join(TASKS_DIR, id + '.partial.json'), partial = readJson(pf)
    if (!partial) throw new Error('partial-missing:' + id)
    const calls = o.toolCalls || [], firstCall = calls[0] ? (() => { try { const a = JSON.parse(calls[0].function?.arguments || '{}'); return a.command || a.cmd || JSON.stringify(a) } catch { return String(calls[0].function?.arguments || '') } })() : null
    const turn = { raw: o.reasoning || '', content: o.content || '' }
    if (!turn.raw) result.rejected.push({ key: o.key, reason: 'no-reasoning（模型没给 reasoning_content；这题铸不成）' })
    else if (plan.role === 'mint-a' && !firstCall) result.rejected.push({ key: o.key, reason: 'no-tool-call（第 1 轮没发工具调用：没有 a1Call 就没有「上一轮做了什么」，这题铸不成）' })
    else { partial.chain[plan.role === 'mint-a' ? 'a1' : 'a2'] = turn; if (plan.role === 'mint-a') partial.chain.a1Call = firstCall; else partial.chain.a2Edit = firstCall; partial.steps.push({ gen: g, part: plan.role, at: now }); writeJson(pf, partial); result.written.push(path.relative(ROOT, pf)); result.next = plan.role === 'mint-a' ? (partial.chain.u2 ? 'mint --step b --id ' + id : '人工在 ' + path.relative(ROOT, pf) + ' 的 chain.u2 写第 2 轮用户话（观察 + 追问），再 mint --step b --id ' + id) : 'compile --mint ' + id + '（先 r1 再 side）' }
  }
  const watermark = readWatermark(receiptPath)
  recordGen(history, { ...(entry || { gen: g, role: plan.role }), at: now, status: 'ingested', planDigest: evidenceDigest(plan), scope: planScope(plan), reservedUsd: watermark ? +(watermark.reservedNano / 1e9).toFixed(4) : (rep.reservedUsd ?? null), written: result.written, rejected: result.rejected, ...(result.policy ? { policy: result.policy } : {}), ingestedFrom: report ? 'report-file' : 'ledger' })
  writeJson(path.join(OFFLINE, 'gen-' + g + '.result.json'), { schema: 'cfb.gen-result/1', at: now, ...result })
  return result
}
function cmdIngestGen(args) {
  const g = Number(f(args, '--gen')); if (!Number.isInteger(g) || g < 1) throw new Error('--gen 必填')
  const reportFile = f(args, '--report'), report = reportFile ? readJson(reportFile) : null
  if (reportFile && !report) throw new Error('report-unreadable')
  const r = ingestGen({ g, report })
  console.log(JSON.stringify(r, null, 2))
  if (r.policy && r.role === 'propose') console.log(`\n策略 ${r.policy} 已落盘（status=proposed）。下一步：node tools/cfb-cycle.mjs compile --policy ${r.policy}（按策略重压 side，≤5 请求），然后 plan 会自动把它当假设。`)
  if (r.role === 'compile' && r.status) console.log(`\n策略 ${r.policy} ${r.status === 'compiled' ? '已覆盖全部池题，下一次 plan 自动纳入' : '还缺题：再跑一次 compile --policy ' + r.policy}`)
  if (r.next) console.log('\n下一步：' + r.next)
}
function cmdPolicies() {
  const ps = listPolicies(), champ = readJson(CHAMPION)?.policy || 'base'
  console.log(`champion 策略：${champ}；策略文件 ${ps.length} 个（${path.relative(ROOT, POLICIES)}）`)
  for (const p of ps) console.log(`  ${p.id} ${String(p.status).padEnd(9)} parent=${p.parent} patches=${p.patches.length} sides=${Object.keys(p.sides || {}).length}${p.origin?.gen ? ' gen=' + p.origin.gen : ''}  ${(p.rationale || '').slice(0, 60)}`)
  const pool = loadPool()
  console.log(`任务池 ${pool.digest}：${pool.tasks.map((t) => `${t.id}[${t.split}/${t.source}]`).join(' ')}${pool.warnings.length ? '\n  ⚠ ' + pool.warnings.join('\n  ⚠ ') : ''}`)
  const partials = fs.existsSync(TASKS_DIR) ? fs.readdirSync(TASKS_DIR).filter((x) => x.endsWith('.partial.json')) : []
  if (partials.length) console.log('铸造中：' + partials.join(' '))
  if (fs.existsSync(TRAIN_PAIRS)) console.log('飞轮偏好对：' + fs.readFileSync(TRAIN_PAIRS, 'utf8').trim().split('\n').filter(Boolean).length)
}

const HELP = `cfb-cycle（闭环 v4：e 值采纳 + L2 结局确认；v2/v3 命令全部保留）：
  plan     [--round N] [--lever k=v|A/A|policy=ID] [--skip-aa] [--profile FILE] [--pricing FILE] [--force]
                                                                                 零 API：池轮换 → 成稿 → 冻结 v9 计划，停下等批准（首轮默认 A/A 校准）
  ingest   --round N [--report FILE]                                              回灌：配对 → decideV4（留出闸门 + e 值）→ adopt-provisional/reject/continue/calibrated；追加飞轮偏好对；记留出曝光
  propose                                                                        把已采纳旋钮 / 策略翻成生产配置 diff / src 改动说明
  propose-policy [--gen N] [--parent ID] [--note 文字]                             冻结提议器计划（只喂 dev 题证据；≤4 请求）
  compile  --policy ID [--tasks a,b] | --mint ID   [--gen N]                      冻结按策略重压 side / 铸造件压稿的计划（≤8 请求）
  mint     --step a --scenario FILE | --step b --id ID   [--gen N]                冻结铸造新题的计划（u1→a1；人补 u2 后 a1+u2→a2）
  ingest-gen --gen N [--report FILE]                                             回灌生成计划：策略文件 / side / 铸造件（三闸：预算、泄漏、可应用）
  confirm  --results FILE [--map champion=<variant>,previous=<variant>]            v4：L2 端到端结局（traj-run 行）确认 / 回滚 provisional champion；带 proxyScore 的行进效度账本
  ruler                                                                          v4：尺子效度（AUC+CI）/ 采纳规则 / e 值预算 / 留出曝光 / CPU 排序器 / L2 基线
  policies | status | doctor | simulate [--p 0.7] [--rounds 5]
杠杆（v3 顺序，低风险在前）：${LEVER_ORDER_V3.map((l) => l + '{' + KNOBS[l].values.join('|') + '}').join(' ')}  + policy=<已编译策略>
本文件不发任何网络请求；live 只能由 tools/effect-ready.mjs run --live --v9 --round N 显式执行。`
function main() {
  const [cmd = 'status', ...args] = process.argv.slice(2)
  if (cmd === 'plan' || cmd === 'run') cmdPlan(args)
  else if (cmd === 'ingest') cmdIngest(args)
  else if (cmd === 'propose') cmdPropose(args)
  else if (cmd === 'confirm') cmdConfirm(args)
  else if (cmd === 'ruler') cmdRuler()
  else if (cmd === 'propose-policy') cmdProposePolicy(args)
  else if (cmd === 'compile') cmdCompile(args)
  else if (cmd === 'mint') cmdMint(args)
  else if (cmd === 'ingest-gen') cmdIngestGen(args)
  else if (cmd === 'policies') cmdPolicies()
  else if (cmd === 'status') cmdStatus()
  else if (cmd === 'doctor') cmdDoctor()
  else if (cmd === 'simulate') cmdSimulate(args)
  else if (['help', '--help', '-h'].includes(cmd)) console.log(HELP)
  else { console.log(HELP); throw new Error('未知子命令 ' + cmd) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
