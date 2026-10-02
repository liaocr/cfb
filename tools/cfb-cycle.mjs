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
import { BASE_POLICY, PATCH_LIMITS, makePolicy, parseProposal, validatePatches, leakCheck, promptHead, failureEvidence, GEN_ROLES, applyPolicyToPrompt } from './helpers/generation.mjs'
import { truthDimensions, truthComposite, truthDelta, TRUTH_DIMENSIONS } from './helpers/truth-dims.mjs'
import { sequentialPaired, pairResults, expectedBitsNextPair, bitsBought, pairsToDecide, costEstimate, usdPerBit, DEFAULT_DESIGN, DEFAULT_DESIGN_V3, decideV3, betaCdf } from './helpers/experiment.mjs'
import { prepareEvaluation, reportEvaluation, loadPrepared, DEFAULT_HOME_V9, PUBLIC_RECEIPT_V9, DEFAULT_HOME_GEN, PUBLIC_RECEIPT_GEN, PROFILE_EXAMPLE, ROOT } from './helpers/eval-workflow.mjs'
import { auditApiPlan, planScope, APPROVED_API_LIMITS_V9, APPROVED_API_LIMITS_GEN } from './helpers/api-budget.mjs'
import { readWatermark } from './helpers/api-watermark.mjs'
import { decideV4, rulerValidity, adoptionPolicy, outcomeComparison, episodeOutcome, eValueWins, winsNeeded, DEFAULT_DESIGN_V4, l1Discrimination, rulerEconomics, iccOneWay, generalizationGap } from './helpers/ruler.mjs'
import { childStates, familyCensus, valueTable } from './helpers/child-states.mjs'
import { scoreMatrix, paretoFront, pickParent } from './helpers/pareto.mjs'
import { perturbExposure } from './helpers/perturb-check.mjs'
import { RULE, assertPaidRole } from './helpers/llm-roles.mjs'
import { TRAJ_TASKS } from './traj-fixtures.mjs'
import { trainRanker, scoreText } from './helpers/ranker.mjs'
import { retroValidity } from './helpers/traj-proxy.mjs'
import { ceilingFrom, goldItemsFromTraj, loadGold, saveGold, buildBenchPlan, benchReport, benchReportMd, readResults, derivePolicies, maskBits } from './helpers/three-mode.mjs'

// 目录：默认仓库里的 .cfb-offline / .cfb-runtime/bounded-ab-v9/rN / transfer 收据；自测用 CFB_CYCLE_DIR 整体改道（不碰真实轮次）。
// v14.10：路径是**活绑定**（let + setCycleDir）：自测与脚本可以在进程内改道，不必为每条命令起一个子进程（verify 从 50 s 回到个位数秒的主因之一）。
let BASE = process.env.CFB_CYCLE_DIR ? path.resolve(process.env.CFB_CYCLE_DIR) : null
export let OFFLINE, HISTORY, CHAMPION, POLICIES, TASKS_DIR, TRAIN_PAIRS, RULER_DIR, STATES_DIR, DESIGN_FILE, VALIDITY, EXPOSURE, PARITY
export const HOLDOUT_MAX_EXPOSURE = 3
export const homeFor = (round) => (BASE ? path.join(BASE, 'runtime', 'r' + Number(round)) : DEFAULT_HOME_V9(round))
export const receiptFor = (round) => (BASE ? path.join(BASE, 'receipts', 'v9-r' + Number(round) + '.watermark.json') : PUBLIC_RECEIPT_V9(round))
export const trajHomeFor = (n) => (BASE ? path.join(BASE, 'runtime', 't' + Number(n)) : path.join(ROOT, '.cfb-runtime', 'traj', 't' + Number(n)))
// v4.6（v14.11）三模式：金标注册表进仓库（transfer/gold/<family>/<id>.json，自测改道到 <dir>/gold）；模式 2 基准单元 .cfb-runtime/bench/b<n>
export const GOLD_DIR = () => (BASE ? path.join(BASE, 'gold') : path.join(ROOT, 'transfer', 'gold'))
export const benchHomeFor = (n) => (BASE ? path.join(BASE, 'runtime', 'b' + Number(n)) : path.join(ROOT, '.cfb-runtime', 'bench', 'b' + Number(n)))
export function cycleDir() { return BASE }
/** 把整个闭环目录改道（null = 仓库缺省 .cfb-offline / .cfb-runtime）。只改路径，不碰任何缓存（本模块没有跨调用缓存）。 */
export function setCycleDir(dir) {
  BASE = dir ? path.resolve(dir) : null
  OFFLINE = BASE ? path.join(BASE, 'offline') : path.join(ROOT, '.cfb-offline')
  HISTORY = path.join(OFFLINE, 'history.json'); CHAMPION = path.join(OFFLINE, 'champion.json')
  POLICIES = path.join(OFFLINE, 'policies'); TASKS_DIR = path.join(OFFLINE, 'tasks'); TRAIN_PAIRS = path.join(OFFLINE, 'train', 'pairs.jsonl')
  // v4 尺子账本：效度配对（L1 代理分 ↔ L2 结局）、留出题曝光（每参与一次采纳 / 否决判定 +1，≥3 应退役轮换）、L2 确认结果
  RULER_DIR = path.join(OFFLINE, 'ruler'); STATES_DIR = path.join(OFFLINE, 'states')
  DESIGN_FILE = path.join(RULER_DIR, 'design.json'); VALIDITY = path.join(RULER_DIR, 'validity.jsonl'); EXPOSURE = path.join(RULER_DIR, 'exposure.json'); PARITY = path.join(RULER_DIR, 'parity.json')
  return BASE
}
setCycleDir(BASE)
// 分叉轨迹的单价常数（§7 算术；首张真实回执后应更新）：主调用期望 / 上界（max_tokens 8000），压缩调用期望 / 上界
export const TRAJ_UNIT = Object.freeze({ mainUsd: 0.0125, mainCapUsd: 0.003 + 8000 * 4e-6, compressUsd: 0.0075, compressCapUsd: 0.005 + 1600 * 4e-6,
  // v4.7 影子分叉的期望参数（来自 29 条真实轨迹审计，首张回执后按 receipt.shadowRounds / noContrastGroups 重算）：跟随臂到第 divergeRound 轮才第一次与 raw 分歧（之前零主调用）；
  //   原文 ≥ 生产地板 3100 字的轮占比 floorShare（审计实测 13%，新家族更难、取 0.4 偏保守）⇒ 压缩调用期望 = 轮数 × floorShare；上界仍按「每轮都压、第 1 轮就分歧」算
  divergeRound: 3, floorShare: 0.4 })   // v14.10：压缩器 = 生产 makeBirthCompiler（关思考、max_tokens = max(850, compressV4MaxOutputTokens 1600)）⇒ 上界按 1600 算
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
/** v4.3：判定设计 = 默认 + design.json 里实测的 ICC（没有就用默认 0.3，并标明来源）。 */
export function loadDesign() { const d = readJson(DESIGN_FILE); return d && Number.isFinite(d.icc) ? { ...DEFAULT_DESIGN_V4, icc: d.icc, iccSource: d.source || 'design.json' } : { ...DEFAULT_DESIGN_V4, iccSource: 'default' } }
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
  const championPolicy = readJson(CHAMPION)?.policy || 'base'
  const hypothesis = isAA ? { ...AA, champion, championPolicy, split } : pick.lever === 'policy'
    ? { lever: 'policy', value: pick.value, champion, championPolicy, theory: (loadPolicy(pick.value).rationale || '').slice(0, 300), kind: 'prompt', split, policy: pick.value }
    : { lever: pick.lever, value: pick.value, champion, championPolicy, theory: KNOBS[pick.lever].theory, kind: KNOBS[pick.lever].kind, split }
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
  if (r.ok) { const ec = rulerEconomics({ validity: rulerValidity(loadValidity().map((x) => ({ proxy: x.proxy, outcome: x.outcome }))) }); rankerLine += `\nL1 角色：${ec.role}${ec.role === 'diagnostic' ? '（效度未证：这一轮 ≈$' + ec.l1.usd + ' 只买到 ≈' + ec.l1.informativePairs + ' 个非平局对、不计入采纳；推荐先 `plan-traj`）' : ''}` }
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
  const design = loadDesign()
  const d3 = decideV4({ pairs: hyp.outcomes, split: allSplit, aa: isAA, design })
  d3.gap = generalizationGap({ dev: d3.dev, holdout: d3.holdout }); d3.iccSource = design.iccSource; d3.icc = design.icc
  const seq = d3.all
  hyp.decision = d3.decision
  hyp.e = d3.e
  hyp.posterior = { n: seq.n, wins: seq.wins, losses: seq.losses, ties: seq.ties, pWin: seq.pWin, mean: seq.mean, ci95: seq.ci95, bitsBought: bitsBought(seq.alpha, seq.beta), nextPairBits: expectedBitsNextPair(seq.alpha, seq.beta) }
  hyp.v3 = { dev: d3.dev, holdout: d3.holdout, holdoutRecord: d3.holdoutRecord, nEff: d3.nEff, replicatesPerTask: d3.replicatesPerTask, why: d3.why, e: d3.e, thresholds: d3.thresholds, gap: d3.gap, icc: d3.icc, iccSource: d3.iccSource }
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
  if (r.v3?.gap && r.v3.gap.gap != null) L.push(`泛化差距（v4.3，Ladder 视角）：dev 净胜率 ${r.v3.gap.devNet} − 留出 ${r.v3.gap.holdoutNet} = ${r.v3.gap.gap} ⇒ ${r.v3.gap.flag}${r.v3.gap.flag === 'suspected-overfit' ? '（dev 上的提升没有带到留出：候选可能只学会了 dev 题）' : ''}；ICC=${r.v3.icc}（${r.v3.iccSource === 'default' ? '默认值，`ruler --write-design` 可换成实测' : '实测 ' + r.v3.iccSource}）`)
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
  // v4.7.2：未分歧的影子跟随臂与 leader 逐字节同一条轨迹、复用的 raw 已在原计划入账 ⇒ 都不是新的效度观测（否则同一条轨迹记两次）
  const validity = typed.filter((r) => Number.isFinite(r.proxyScore ?? r.structural) && !(r.shadow && r.shadow.divergedAt == null) && !r.reusedFrom && !r.extended).map((r) => ({ schema: 'cfb.validity-pair/1', at: now, task: r.task, arm: r.arm, sample: r.sample ?? 0, proxy: r.proxyScore ?? r.structural, outcome: episodeOutcome(r).solved ? 1 : 0, roundsToFix: episodeOutcome(r).roundsToFix }))
  const cf = readJson(CHAMPION)
  let verdict = 'report-only', championAfter = cf
  if (cf?.adoption === 'provisional') {
    if (cmp.pairs.length < 4 || new Set(cmp.pairs.map((p) => p.task)).size < 2) verdict = 'pending'
    else if (cmp.e >= 1 / alpha) {
      // v4.2 路径等价闸：策略 champion 的 L2 证据来自 policy: 直连路径，进生产前必须有「auto（生产路径）vs policy:base（直连路径）」的等价校准，否则被测对象 ≠ 目标对象
      // v14.10（v4.5）：结局行若来自生产 birth 同构体（compile[].path === 'birth-offline'，traj-run 缺省路径），路径等价由构造保证，不再需要付费校准；旧收据（直连路径）仍要 parity.json
      const byConstruction = typed.filter((r) => r.arm === cmp.champion || r.variant === cmp.champion).some((r) => Array.isArray(r.compile) && r.compile.length && r.compile.every((c) => c.path === 'birth-offline'))
      const parity = !(cf.policy && cf.policy !== 'base') ? { ok: true, note: 'knob-only champion：无提示词改动，不需路径等价' } : byConstruction ? { ok: true, note: 'by-construction：结局行来自生产 birth 同构体（birthOffline），policy:<id> 与生产同一路径' } : readJson(PARITY)
      if (!parity?.ok) verdict = 'pending-parity'
      else { verdict = 'confirmed'; championAfter = { ...cf, adoption: 'confirmed', confirmation: { at: now, pairs: cmp.pairs.length, e: cmp.e, champion: cmp.champion, previous: cmp.previous, parity: parity.note || parity.at || null } } }
    }
    else if (cmp.eReject >= 1 / alpha) { verdict = 'rolled-back'; championAfter = { schema: 'cfb.champion/3', knobs: cf.previous.knobs, policy: cf.previous.policy, adoption: 'confirmed', previous: null, confirmation: null, adopted: (cf.adopted || []).slice(0, -1), rolledBack: [...(cf.rolledBack || []), { at: now, from: { knobs: cf.knobs, policy: cf.policy }, e: cmp.e, eReject: cmp.eReject, pairs: cmp.pairs.length }], at: now } }
    else verdict = 'pending'
  }
  return { cmp, validity, verdict, championBefore: cf, championAfter }
}
/** 路径等价校准：rows 里 auto（生产路径）vs policy:base（直连路径）；两者在 L2 上分不出（e 与「更差」e 都 < 阈、≥4 对）且闸通过率相近 ⇒ ok。 */
export function parityFrom(rows, { a = 'auto', b = 'policy:base', alpha = DEFAULT_DESIGN_V4.alphaHoldout, now = new Date().toISOString() } = {}) {
  const typed = rows.map((r) => ({ ...r, arm: r.variant === b ? 'champion' : r.variant === a ? 'previous' : null })).filter((r) => r.arm)
  const cmp = outcomeComparison(typed)
  const gateRate = (v) => { const cs = rows.filter((r) => r.variant === v).flatMap((r) => (r.compile || []).filter((c) => !c.belowFloor)); return cs.length ? +(cs.filter((c) => c.ok).length / cs.length).toFixed(3) : null }
  const g = { [a]: gateRate(a), [b]: gateRate(b) }
  const gateClose = g[a] == null || g[b] == null || Math.abs(g[a] - g[b]) <= 0.2
  const ok = cmp.pairs.length >= 4 && cmp.e < 1 / alpha && cmp.eReject < 1 / alpha && gateClose
  return { schema: 'cfb.path-parity/1', at: now, a, b, pairs: cmp.pairs.length, e: cmp.e, eReject: cmp.eReject, gatePass: g, ok, note: ok ? `${a} 与 ${b} 在 L2 上等价（${cmp.pairs.length} 对，e=${cmp.e}/${cmp.eReject}，闸通过率 ${g[a]}/${g[b]}）` : cmp.pairs.length < 4 ? '配对 < 4' : !gateClose ? '闸通过率差 > 0.2：直连路径与生产路径不同口径' : '两条路径在 L2 上分得出：直连路径不是生产路径的忠实代理' }
}
/** v4.5 `review`：把一次付费单元的结局行压成**一屏一家族**的评审稿（零 API）—— 给代工提议器看的，不是统计表。
 *  每个分叉组：各臂的动作序列（轮 → 调用 / 编辑 / 声明）、修好轮次、分歧轮（两臂第一次动作不同的那一轮）、
 *  分歧前那一轮压缩臂读到的稿（stored）与原文的长度 / 头部、压缩闸结果、逐轮代理旗标。 */
export function reviewRows(rows, { maxDraft = 700 } = {}) {
  const typed = rows.filter((r) => r && r.task && !r.error)
  const armOf = (r) => (r.policy ? 'policy:' + r.policy : r.variant)
  const sig = (t) => (t.calls || []).map((c) => { let a = c.args; try { a = JSON.parse(a) } catch { /* 原样 */ } const s = typeof a === 'object' && a ? (a.path || a.command || a.old_text || JSON.stringify(a)) : String(a); return `${c.name}(${String(s).replace(/\s+/g, ' ').slice(0, 60)})` }).join(' ; ') || (/(修好|已修复|fixed|完成|收工)/.test(t.text || '') ? '«声明修好»' : '«无调用»')
  const groups = {}
  for (const r of typed) { const k = `${r.task}#${r.sample ?? 0}`; (groups[k] = groups[k] || { task: r.task, sample: r.sample ?? 0, arms: {} }).arms[armOf(r)] = r }
  const out = []
  for (const g of Object.values(groups)) {
    const arms = Object.keys(g.arms); const rounds = Math.max(...arms.map((a) => (g.arms[a].transcript || []).length))
    const seq = Object.fromEntries(arms.map((a) => [a, (g.arms[a].transcript || []).map(sig)]))
    let diverge = null; for (let i = 0; i < rounds && diverge == null; i++) { const vals = new Set(arms.map((a) => seq[a][i] ?? '«结束»')); if (vals.size > 1) diverge = i + 1 }
    const sh = arms.filter((a) => g.arms[a].shadow).map((a) => `${a}:${g.arms[a].shadow.divergedAt ? '稿第 ' + g.arms[a].shadow.divergedAt + ' 轮生效' : '稿未生效'}`).join(' ')
    const lines = [`## ${g.task} #${g.sample}  臂：${arms.join(' / ')}  分歧轮：${diverge ?? '无（动作全同）'}${sh ? '  影子：' + sh : ''}`]
    for (const a of arms) {
      const r = g.arms[a]; const o = episodeOutcome(r)
      lines.push(`- **${a}**：${o.solved ? `修好@r${o.roundsToFix}` : '未修好'}；声明 ${r.claim || '—'}${r.claim === 'fixed' && !o.solved ? '（假）' : ''}；轮 ${r.rounds}；编辑 ${(r.edits || []).map((e) => e.path).join(',') || '—'}；压缩 ${(r.compile || []).map((c) => (c.ok ? 'o' : c.belowFloor ? '_' : 'x')).join('') || '—'}；代理分 ${r.proxyScore ?? '—'}`)
      lines.push('  ' + seq[a].map((x, i) => `r${i + 1} ${x}`).join(' → '))
    }
    if (diverge != null) {
      for (const a of arms) {
        const t = (g.arms[a].transcript || [])[diverge - 2]   // 分歧那一轮读到的是上一轮的 stored
        if (!t) continue
        const drafted = typeof t.stored === 'string' && t.stored
        if (drafted) lines.push(`- ${a} 在 r${diverge} 读到的稿（r${diverge - 1} 压缩，${t.storedChars}/${t.reasoningChars} 字）：\n  > ${drafted.replace(/\n+/g, ' ⏎ ').slice(0, maxDraft)}${drafted.length > maxDraft ? '…' : ''}`)
        else if (t.reasoning) lines.push(`- ${a} 在 r${diverge} 读到的是原文（${t.reasoningChars} 字）：\n  > ${t.reasoning.replace(/\n+/g, ' ⏎ ').slice(0, 300)}…`)
        else lines.push(`- ${a}：transcript 没有存稿文本（跑的时候没开 --store-text）`)
      }
      const compressed = arms.filter((a) => a !== 'raw')
      for (const a of compressed) { const c = (g.arms[a].compile || [])[diverge - 2]; if (c) lines.push(`- ${a} r${diverge - 1} 压缩闸：${JSON.stringify({ ok: c.ok, why: c.why || c.reason || null, path: c.path || 'legacy', promptVersion: c.promptVersion || null, spliced: c.spliced || null }).slice(0, 240)}`) }
    }
    const flags = arms.map((a) => `${a}: ${(g.arms[a].proxySteps || []).map((s) => `r${s.round}=${s.score}`).join(' ')}`)
    lines.push(`- 逐轮代理旗标：${flags.join(' | ')}`)
    out.push({ task: g.task, sample: g.sample, arms, diverge, md: lines.join('\n') })
  }
  return out
}
/** v4.5：闭环状态快照 —— .cfb-offline 被 gitignore（可再生语料），但策略 / 代际 / 轨迹计划 / champion 是**不可再生的操作状态**。
 *  snapshot 把它们写进 transfer/cycle-state.json（进仓库、进 manifest）；restore 在新克隆里把缺的文件补回来（已有的不覆盖，防止回滚收据后的状态）。 */
export const CYCLE_STATE_FILE = () => path.join(ROOT, 'transfer', 'cycle-state.json')
export function cycleSnapshot() {
  const h = loadHistory()
  const plans = (h.trajPlans || []).map((t) => ({ n: t.n, plan: readJson(path.join(trajHomeFor(t.n), 'plan.json')) })).filter((x) => x.plan)
  const packs = (h.generations || []).map((g) => g.gen).filter((g, i, a) => a.indexOf(g) === i).map((g) => ({ gen: g, pack: readJson(path.join(OFFLINE, `gen-${g}.pack.json`)) })).filter((x) => x.pack)
  const benchPlans = (h.benchPlans || []).map((t) => ({ n: t.n, plan: readJson(path.join(benchHomeFor(t.n), 'plan.json')) })).filter((x) => x.plan)
  const snap = { schema: 'cfb.cycle-state/1', at: new Date().toISOString(), history: h, champion: readJson(CHAMPION), policies: listPolicies(), trajPlans: plans, packs, ...(benchPlans.length ? { benchPlans } : {}) }
  snap.digest = evidenceDigest(JSON.parse(JSON.stringify({ ...snap, at: null }))).slice(0, 16)   // 内容摘要（不含时间；null 也可能来自 readJson，先 JSON 归一）
  return snap
}
function cmdSnapshot() {
  const snap = cycleSnapshot(); const file = CYCLE_STATE_FILE(); const prev = readJson(file)
  if (prev && prev.digest === snap.digest) { console.log(`状态未变（digest ${snap.digest}），不改写 ${path.relative(ROOT, file)}`); return snap }
  ensure(path.dirname(file)); writeJson(file, snap)
  console.log(`已快照 → ${path.relative(ROOT, file)}（digest ${snap.digest}）：轮 ${snap.history.rounds.length}、代 ${(snap.history.generations || []).length}、策略 ${snap.policies.length}、轨迹计划 ${snap.trajPlans.length}、证据包 ${snap.packs.length}`)
  return snap
}
function cmdRestore(args) {
  const snap = readJson(f(args, '--from') || CYCLE_STATE_FILE()); if (!snap || snap.schema !== 'cfb.cycle-state/1') throw new Error('no-cycle-state')
  const did = []
  const put = (file, obj, label) => { if (fs.existsSync(file) && !args.includes('--force')) return; ensure(path.dirname(file)); writeJson(file, obj); did.push(label) }
  if (!fs.existsSync(HISTORY) || args.includes('--force')) put(HISTORY, snap.history, 'history')
  if (snap.champion) put(CHAMPION, snap.champion, 'champion')
  for (const p of snap.policies || []) put(path.join(POLICIES, p.id + '.json'), p, 'policy:' + p.id)
  for (const t of snap.trajPlans || []) put(path.join(trajHomeFor(t.n), 'plan.json'), t.plan, 't' + t.n)
  for (const g of snap.packs || []) put(path.join(OFFLINE, `gen-${g.gen}.pack.json`), g.pack, 'g' + g.gen)
  for (const b of snap.benchPlans || []) put(path.join(benchHomeFor(b.n), 'plan.json'), b.plan, 'b' + b.n)
  console.log(`已从快照（digest ${snap.digest}，${snap.at}）补回 ${did.length} 项` + (did.length ? '：' + did.join(' ') : '（本地都在，什么都没动；--force 覆盖）'))
  return did
}
function cmdReview(args) {
  const planN = f(args, '--plan'); const file = f(args, '--results') || (planN ? path.join(trajHomeFor(planN), 'results.jsonl') : null)
  if (!file || !fs.existsSync(file)) throw new Error('review 需要 --plan N（有 results.jsonl）或 --results FILE')
  const rows = readJsonl(file); const rv = reviewRows(rows, { maxDraft: Number(f(args, '--draft-chars') || 700) })
  const head = [`# 评审稿 ${planN ? 't' + planN : path.basename(file)}（${rows.length} 行，${rv.length} 组；零 API）`, '', '读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。', '']
  const md = head.concat(rv.map((x) => x.md + '\n')).join('\n')
  const outFile = planN ? path.join(trajHomeFor(planN), 'review.md') : file.replace(/\.jsonl$/, '') + '.review.md'
  fs.writeFileSync(outFile, md); console.log(md); console.log(`评审稿 → ${path.relative(ROOT, outFile)}`)
  return rv
}
function cmdConfirm(args) {
  const planN = f(args, '--plan')
  const file = f(args, '--results') || (planN ? path.join(trajHomeFor(planN), 'results.jsonl') : null); if (!file || !fs.existsSync(file)) throw new Error('--results FILE 或 --plan N 必填（traj-run 的 results.jsonl 或 JSON 数组）')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const rows = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  if (args.includes('--parity')) {
    const pr = parityFrom(rows); ensure(RULER_DIR); writeJson(PARITY, pr)
    console.log(`# 路径等价校准（${pr.ok ? 'ok' : '未通过'}）\n\n${pr.note}\n已写入 ${path.relative(ROOT, PARITY)}`); return
  }
  const map = Object.fromEntries((f(args, '--map') || 'champion=champion,previous=previous').split(',').map((kv) => kv.split('=')))
  const r = confirmFrom({ rows, map })
  if (r.verdict === 'confirmed' || r.verdict === 'rolled-back') writeJson(CHAMPION, r.championAfter)
  if (r.validity.length) { ensure(RULER_DIR); fs.appendFileSync(VALIDITY, r.validity.map((x) => JSON.stringify(x)).join('\n') + '\n') }
  ensure(RULER_DIR); const n = fs.readdirSync(RULER_DIR).filter((x) => x.startsWith('confirm-')).length + 1
  writeJson(path.join(RULER_DIR, 'confirm-' + n + '.json'), { schema: 'cfb.confirm/1', at: new Date().toISOString(), source: path.relative(ROOT, path.resolve(file)), map, ...r })
  const L = ['# L2 端到端结局确认（' + r.verdict + '）', '', '| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const [k, v] of [['previous', r.cmp.previous], ['champion', r.cmp.champion]]) L.push(`| ${k} | ${v.n} | ${v.solved ?? '—'} | ${v.meanRoundsToFix ?? '—'} | ${v.falseClaims} | ${v.verified} | ${v.repeats} |`)
  L.push('', `配对 ${r.cmp.pairs.length}（${r.cmp.pairs.map((p) => p.task + ':' + p.outcome).join(' ')}）；e=${r.cmp.e}，「更差」e=${r.cmp.eReject}，阈 ${+(1 / DEFAULT_DESIGN_V4.alphaHoldout).toFixed(1)}`)
  const nc = rows.filter((x) => x && !x.error && x.shadow && !x.extended && x.shadow.divergedAt == null && x.status !== 'awaiting-draft').length
  if (nc) L.push(`其中未分歧组 ${nc}（压缩器整条没触发 ⇒ 与 raw 结局相同、计平手、不是候选优劣的证据）`)
  L.push('', r.verdict === 'confirmed' ? '**champion 确认**：L2 结局证实 L1 采纳；`propose` 现在可出生产 diff' : r.verdict === 'pending-parity' ? '**L2 过了、但缺路径等价校准**：策略 champion 的证据来自 policy: 直连路径；先跑一次 auto vs policy:base 并 `confirm --parity --results …`，等价才能 confirmed' : r.verdict === 'rolled-back' ? '**回滚**：L2 结局证伪 L1 采纳，champion 恢复为 previous（L1 尺子对这个方向可能失效，看 `ruler`）' : r.verdict === 'pending' ? '**待定**：L2 配对不够（需 ≥4 对、≥2 题、e ≥ 阈），继续续跑' : '**只报告**：当前 champion 不是 provisional；本次结果只进效度账本')
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
  const mrRows = ['run1', 'run2', 'run3', 'run4'].flatMap((d) => readJsonl(path.join(ROOT, 'transfer', 'mr', d, 'results.jsonl')).map((r) => ({ ...r, run: d })))
  const l1 = mrRows.length ? l1Discrimination(mrRows) : null
  const l2Ties = baseline ? baseline.pairs.filter((p) => p.outcome === 'tie').length / Math.max(1, baseline.pairs.length) : 0.3
  // 信息产出 / 美元（估）：v9 L1 轮 vs 预注册的默认分叉轨迹计划（buildTrajPlan 同一套常数）
  const tp = buildTrajPlan({ n: 0 })
  const infoYield = [
    { unit: 'v9 L1 轮（13 请求，冻结两轮状态）', usd: +(10 * TRAJ_UNIT.mainUsd + 3 * 0.0003).toFixed(3), l1Pairs: 5, l2Pairs: 0, validityPairs: 0, flywheelPairs: 5, childStates: 0 },
    { unit: `分叉全轨迹（${tp.variants.join(' vs ')}，${tp.scenarios.length} 场景 × ${tp.samples} 样本 × ≤${tp.maxRounds} 轮，第 1 轮共用）`, usd: tp.cost.expectedUsd, l1Pairs: tp.yield.l1Pairs, l2Pairs: tp.yield.l2Pairs, validityPairs: tp.yield.validityPairsApprox, flywheelPairs: tp.yield.flywheelPairsApprox, childStates: tp.yield.childStatesApprox }
  ].map((r) => ({ ...r, perUsd: { l1: +(r.l1Pairs / r.usd).toFixed(1), l2: +(r.l2Pairs / r.usd).toFixed(1), validity: +(r.validityPairs / r.usd).toFixed(1) } }))
  const economics = rulerEconomics({ validity: v, l1: { tieRate: l1?.tieRate ?? 0.6 }, l2: { usd: tp.cost.expectedUsd, pairs: tp.yield.l2Pairs, tieRate: +l2Ties.toFixed(3), validityPairs: tp.yield.validityPairsApprox } })
  // v4.3：ICC 从已有数据估（同题同臂的重复样本）：mr 用结构分，traj 用「修好=1 / 到修好轮数折算」的结局分
  const l1Score = (r) => { const v = (k) => (r[k] === 1 ? 1 : 0); return v('next') + v('avoid') - v('falseDone') - v('bump') - v('reEdit') - v('repeat') }
  const grp = (rows, key, val) => { const by = {}; for (const r of rows) { const x = val(r); if (x == null) continue; (by[key(r)] = by[key(r)] || []).push(x) } return Object.values(by) }
  const iccMr = iccOneWay(grp(mrRows.filter((r) => r.rule && !r.error), (r) => `${r.run}|${r.task}|${r.variant}`, (r) => l1Score(r.rule)))
  const iccTraj = iccOneWay(grp(trajRows.filter((r) => !r.error), (r) => `${r.task}|${r.variant}`, (r) => (Number.isInteger(r.fixedAtRound) ? Math.max(0, 1 - (r.fixedAtRound - 1) / Math.max(1, r.rounds || 6)) : 0)))
  const states = trajRows.flatMap((r) => childStates(r, { split: loadPool().split }))
  const census = familyCensus(states, { holdoutFamilies: Object.entries(loadPool().split).filter(([, s]) => s === 'holdout').map(([t]) => t) })
  census.scenarioFamilies = TRAJ_TASKS.length; census.scenarioHoldout = TRAJ_TASKS.filter((t) => loadPool().split[t.id] === 'holdout').length   // v4.3：可用场景家族（含还没有轨迹数据的新家族）
  const matrix = scoreMatrix(loadHistory()); const front = paretoFront(matrix)
  return { retro, infoYield, l1, economics, validity: v, policy: pol, icc: { mr: iccMr, traj: iccTraj, design: readJson(DESIGN_FILE) }, states: census, pareto: { matrix, front }, exposure: Object.entries(exposure.tasks).map(([task, e]) => ({ task, n: e.n, retire: e.n >= HOLDOUT_MAX_EXPOSURE })), ranker: { status: rk.status, pairs: rk.pairs, cvAcc: rk.cvAcc, top: rk.top || null, note: rk.note }, baseline: baseline ? { trajectories: trajRows.length, raw: baseline.previous, auto: baseline.champion, pairs: baseline.pairs.length, e: baseline.e, eReject: baseline.eReject } : null, alphaTable: [0.1, 0.05].map((a) => ({ alpha: a, threshold: +(1 / a).toFixed(0), straightWins: winsNeeded(a), pStraightUnderNull: +Math.pow(0.5, winsNeeded(a)).toFixed(4), falseAdoptPerHypothesis: a, over6Hypotheses: +(1 - Math.pow(1 - a, 6)).toFixed(3) })) }
}
function cmdRuler(args = []) {
  const r = rulerReport()
  if (args.includes('--write-design')) { const pick = r.icc.mr.icc != null ? { icc: r.icc.mr.icc, source: `transfer/mr 结构分同题同臂重复（${r.icc.mr.groups} 组 / ${r.icc.mr.samples} 样本）` } : r.icc.traj.icc != null ? { icc: r.icc.traj.icc, source: 'transfer/traj 结局分' } : null; if (pick) { writeJson(DESIGN_FILE, { schema: 'cfb.ruler-design/1', at: new Date().toISOString(), ...pick, alt: { traj: r.icc.traj } }); console.log(`已写 ${path.relative(ROOT, DESIGN_FILE)}：ICC=${pick.icc}（${pick.source}）`) } else console.log('没有可估 ICC 的重复样本，未写 design.json') }
  console.log(`尺子效度（L1 代理分 ↔ L2 修好）：${r.validity.status}  n=${r.validity.n} AUC=${r.validity.auc ?? '—'} CI95=${r.validity.ci95 ? r.validity.ci95.join('–') : '—'}  — ${r.validity.why}`)
  console.log(`采纳规则：${r.policy.note}`)
  console.log('e 值预算：' + r.alphaTable.map((a) => `α=${a.alpha} ⇒ 阈 ${a.threshold}、留出连胜 ${a.straightWins} 场（零效应下走到这条路的概率 ${(a.pStraightUnderNull * 100).toFixed(1)}%；含任意偷看的误采纳上界 ${a.alpha * 100}%/假设，6 个假设 ≤ ${(a.over6Hypotheses * 100).toFixed(0)}%）`).join('；'))
  console.log('留出题曝光：' + (r.exposure.length ? r.exposure.map((e) => `${e.task}×${e.n}${e.retire ? '（应退役）' : ''}`).join(' ') : '尚无判定'))
  console.log(`排序器（CPU，飞轮偏好对）：${r.ranker.status} pairs=${r.ranker.pairs} cvAcc=${r.ranker.cvAcc ?? '—'}${r.ranker.top ? ' top=' + r.ranker.top.map((t) => t.name + ':' + t.w).join(',') : ''}  — ${r.ranker.note}`)
  if (r.retro) {
    console.log(`回溯效度（执行器代理 ↔ 修好，零 API，${r.retro.steps} 步；主口径 = 步级簇自助）：**步级 n=${r.retro.step.n}/${r.retro.step.clusters} 簇 AUC=${r.retro.step.auc ?? '—'} CI=${r.retro.step.ci95 ? r.retro.step.ci95.join('–') : '—'} ⇒ ${r.retro.step.status}**；第 2 轮 n=${r.retro.round2.n} AUC=${r.retro.round2.auc ?? '—'} ⇒ ${r.retro.round2.status}`)
    console.log(`  脚注：轨迹级 n=${r.retro.trajectory.n} 的 AUC 点估计 ${r.retro.trajectory.auc ?? '—'} 建立在仅 ${r.retro.trajectory.neg} 条负例上，不足以下任何结论（status ${r.retro.trajectory.status}）；旗标命中率 ${Object.entries(r.retro.flagRates).map(([k, v]) => k + ' ' + v).join(' ')}`)
  }
  if (r.retro?.timeToFix) console.log(`主结局改口径（v4.3，到修好的轮数、未修好右删失）：Harrell C=${r.retro.timeToFix.c ?? '—'} CI=${r.retro.timeToFix.ci95 ? r.retro.timeToFix.ci95.join('–') : '—'}（n=${r.retro.timeToFix.n}，事件 ${r.retro.timeToFix.events} / 删失 ${r.retro.timeToFix.censored}，只算跨轨迹对）⇒ **${r.retro.timeToFix.status}** — ${r.retro.timeToFix.why}`)
  if (r.retro?.flagWeights) console.log(`六旗标权重（逻辑回归，簇留一，诊断用不进采纳）：${r.retro.flagWeights.status}${r.retro.flagWeights.weights ? ' ' + JSON.stringify(r.retro.flagWeights.weights) + ` cvAUC=${r.retro.flagWeights.aucLearnedCv} vs 手工±1 AUC=${r.retro.flagWeights.aucHand}` : ''} — ${r.retro.flagWeights.why}`)
  console.log(`ICC（同题同臂重复，实测）：mr 结构分 ${r.icc.mr.icc ?? '—'}（${r.icc.mr.groups ?? 0} 组）；traj 结局分 ${r.icc.traj.icc ?? '—'}（${r.icc.traj.groups ?? 0} 组）；判定当前用 ${r.icc.design?.icc ?? DEFAULT_DESIGN_V4.icc + '（默认，`ruler --write-design` 写入实测）'}`)
  console.log(`子状态（零 API，从 transfer/traj 派生的可续跑起点）：${r.states.states} 个 / 有数据的家族 ${r.states.families}（留出 ${r.states.holdoutFamilies}）；可用场景家族 ${r.states.scenarioFamilies}（留出 ${r.states.scenarioHoldout}，新家族 wrong-model / sse-truncated 还没有轨迹）— ${r.states.note}`)
  if (r.pareto.front.tasks.length) console.log(`Pareto 池（按题前沿）：${r.pareto.front.front.join(', ') || '—'}；上榜次数 ${JSON.stringify(r.pareto.front.frontCount)}；被支配 ${r.pareto.front.dominated.join(', ') || '无'}`)
  if (r.l1) console.log(`L1（规格代理，transfer/mr 162 样本）区分度：天花板率（结构分=2）${r.l1.ceilingRate}；raw vs 压缩稿同题同样本 ${r.l1.pairs.win}胜/${r.l1.pairs.loss}负/${r.l1.pairs.tie}平 ⇒ 平局率 ${r.l1.tieRate}；旗标 ${Object.entries(r.l1.flags).map(([k, v]) => k + ' ' + v).join(' ')}`)
  console.log(`L1 角色判定：**${r.economics.role}** — ${r.economics.why}`)
  console.log('信息产出/美元（估）：' + r.infoYield.map((x) => `${x.unit} ≈ $${x.usd} ⇒ L1 对 ${x.l1Pairs}、L2 对 ${x.l2Pairs}、效度对 ${x.validityPairs}、飞轮对 ${x.flywheelPairs}、子状态 ${x.childStates}（每美元 L1 ${x.perUsd.l1} / L2 ${x.perUsd.l2} / 效度 ${x.perUsd.validity}）`).join('；'))
  if (r.baseline) console.log(`L2 基线（transfer/traj1–3，${r.baseline.trajectories} 条轨迹）：raw 修好率 ${r.baseline.raw.solved} / 到修好 ${r.baseline.raw.meanRoundsToFix} 轮 / 假宣称 ${r.baseline.raw.falseClaims}；auto 修好率 ${r.baseline.auto.solved} / ${r.baseline.auto.meanRoundsToFix} 轮 / 假宣称 ${r.baseline.auto.falseClaims}；同题同样本配对 ${r.baseline.pairs}，e=${r.baseline.e}（auto 更好）/ ${r.baseline.eReject}（auto 更差）⇒ ${r.baseline.e >= 1 / DEFAULT_DESIGN_V4.alphaHoldout ? 'auto 过 α=' + DEFAULT_DESIGN_V4.alphaHoldout + ' 阈' : r.baseline.eReject >= 1 / DEFAULT_DESIGN_V4.alphaHoldout ? 'auto 更差过阈' : '方向支持 auto，但未过 α=' + DEFAULT_DESIGN_V4.alphaHoldout + ' 的任意时刻阈（' + (1 / DEFAULT_DESIGN_V4.alphaHoldout).toFixed(0) + '）'}`)
  console.log('下一步（v4.1 已接通）：`node tools/traj-run.mjs --variants raw --policy base,<champion> --fork --samples 1 --max-rounds 4 --require-fp … --out trajN` ⇒ `confirm --results trajN/results.jsonl --map champion=policy:<id>,previous=policy:base`；每行自带 proxyScore，L2 结局与效度配对同一次付费产出。')
}

// ── 5c. v4.2：预注册的分叉轨迹计划（付费单位）与零 API 的样例槽策略 ──────────
export function buildTrajPlan({ n, arms = ['raw', 'policy:base'], scenarios = TRAJ_TASKS.map((t) => t.id), samples = 2, maxRounds = 4, fork = true, purpose = null, pricing = TRAJ_UNIT, fromStates = null, stop = null, storeText = true, reuseRaw = null }) {
  const units = fromStates ? fromStates.count : scenarios.length
  const groups = units * samples, policyArms = arms.filter((a) => a.startsWith('policy:') || a === 'auto').length
  const roundsLeft = fromStates ? Math.max(1, maxRounds - (fromStates.meanStartRound || 2) + 1) : maxRounds
  // 上界（mains / compresses）：每轮都压、第 1 轮就分歧 —— 与 v4.5 同；期望（v4.7 影子分叉）：raw 整条 + 跟随臂只付分歧后的轮；--reuse-raw 时 raw 也不付
  const shadow = fork && !fromStates && arms.includes('raw')
  const followers = fork ? arms.length - 1 : arms.length
  const mains = fork ? groups * (1 + arms.length * (roundsLeft - 1)) : groups * arms.length * roundsLeft
  const compresses = groups * policyArms * roundsLeft
  const dr = pricing.divergeRound ?? 3, fs_ = pricing.floorShare ?? 1
  // 延长（reuseRaw.extend）：raw 付 R − from；跟随臂最早在旧轨迹第一次过地板那轮 k* 分歧（没过过地板 ⇒ 最早 from+1）⇒ 付 R − max(k*, …)；上界同理（k* 之前影子是构造保证，不是假设）
  const ext = reuseRaw?.extend || null
  const kStar = ext ? (ext.firstFloor || ext.from + 1) : null
  const rawPays = ext ? Math.max(0, roundsLeft - ext.from) : (reuseRaw ? 0 : roundsLeft)
  const followerExpected = ext ? Math.max(0, roundsLeft - kStar) : Math.max(0, roundsLeft - dr), followerCap = ext ? Math.max(0, roundsLeft - kStar) : roundsLeft - 1
  const expectedMains = shadow ? groups * (rawPays + followers * followerExpected) : mains
  const expectedCompresses = shadow ? Math.round(groups * policyArms * (ext ? Math.max(1, roundsLeft - kStar + 1) : roundsLeft) * fs_) : compresses
  const capMains = shadow ? groups * (rawPays + followers * followerCap) : mains
  const expectedUsd = +(expectedMains * pricing.mainUsd + expectedCompresses * pricing.compressUsd).toFixed(3), capUsd = +(capMains * pricing.mainCapUsd + compresses * pricing.compressCapUsd).toFixed(3)
  const plan = { schema: 'cfb.traj-plan/1', id: 't' + n, at: new Date().toISOString(), variants: arms, scenarios: fromStates ? [] : scenarios, samples, maxRounds, fork, maxTokens: 8000, storeText,
    ...(fromStates ? { fromStates } : {}),
    // v4.3 有界续跑：一次批准内按 e 值任意停时规则提前停（判定达成或预算上界），不再每组回来要一次批准
    ...(stop ? { stop: { alpha: DEFAULT_DESIGN_V4.alphaHoldout, minPairs: 4, capUsd, compare: arms.length >= 2 ? { champion: arms.find((a) => a !== 'raw') || arms[1], previous: arms.includes('raw') ? 'raw' : arms[0] } : null, ...stop } } : {}),
    purpose: purpose || '第一次用真实数据检验尺子有效性：在线效度配对（执行器代理 ↔ 修好）+ raw vs 压缩稿的 L2 对 + 用真实回执校准单价常数。若效度仍 suspect / unvalidated，接受本机目前只能当记录仪，不开始按分搜索。',
    yield: { l1Pairs: groups, l2Pairs: groups, validityPairsApprox: arms.length * groups * (maxRounds - 1), flywheelPairsApprox: policyArms ? groups * (maxRounds - 1) : 0, childStatesApprox: arms.length * groups * Math.max(0, maxRounds - 2) },
    ...(reuseRaw ? { reuseRaw } : {}),
    cost: { mains: capMains, compresses, expectedMains, expectedCompresses, expectedUsd, capUsd, pricing, shadow }, holdoutNote: '场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索' }
  plan.digest = evidenceDigest(plan).slice(0, 16)
  plan.command = `node tools/traj-run.mjs --plan ${path.relative(ROOT, path.join(trajHomeFor(n), 'plan.json'))}${storeText ? ' --store-text' : ''}${fromStates ? ' --from-state ' + fromStates.file : ''}${reuseRaw ? ' --fork-from ' + reuseRaw.file : ''} --variants ${arms.filter((a) => !a.startsWith('policy:')).join(',') || 'raw'}${arms.some((a) => a.startsWith('policy:')) ? ' --policy ' + arms.filter((a) => a.startsWith('policy:')).map((a) => a.slice(7)).join(',') : ''}${fromStates ? '' : ' --only ' + scenarios.join(',')} --samples ${samples} --max-rounds ${maxRounds}${fork ? ' --fork' : ''} --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out ${path.relative(ROOT, trajHomeFor(n))}`
  return plan
}
/** v4.3：把 transfer/traj1–3 与 runtime 轨迹的每个修好前轮次导出为可续跑的子状态（零 API）。 */
function cmdStates(args) {
  const pool = loadPool(); const dirs = ['traj1', 'traj2', 'traj3'].map((d) => path.join(ROOT, 'transfer', d, 'results.jsonl'))
  const extra = (f(args, '--results') || '').split(',').filter(Boolean).map((x) => path.resolve(ROOT, x))
  const rows = [...dirs, ...extra].flatMap((file) => readJsonl(file).map((r) => ({ ...r, dir: path.basename(path.dirname(file)) })))
  const fam = f(args, '--family'); const maxPerRow = Number(f(args, '--max-per-row') || 4); const startRound = Number(f(args, '--start-round') || 0); const limit = Number(f(args, '--limit') || 0); const parentVariant = f(args, '--parent-variant')
  let states = rows.flatMap((r) => childStates(r, { split: pool.split, maxPerRow })).filter((st) => (!fam || st.family === fam) && (!startRound || st.startRound === startRound) && (!parentVariant || st.parentVariant === parentVariant))
  if (limit > 0) states = states.slice(0, limit)   // 探针：按文件顺序取前 N 个（确定性）
  const census = familyCensus(states, { holdoutFamilies: Object.entries(pool.split).filter(([, s]) => s === 'holdout').map(([t]) => t) })
  ensure(STATES_DIR); const out = path.resolve(ROOT, f(args, '--out') || path.join(STATES_DIR, (fam || 'all') + (limit ? `-probe${limit}` : '') + '.json'))
  writeJson(out, states)
  console.log(`子状态 ${states.length} 个 → ${path.relative(ROOT, out)}；家族 ${census.families}（留出家族 ${census.holdoutFamilies}）：${Object.entries(census.byFamily).map(([k, v]) => `${k}×${v.states}[${v.split || '—'}]`).join(' ')}；可用场景家族 ${TRAJ_TASKS.length}（留出 ${TRAJ_TASKS.filter((t) => pool.split[t.id] === 'holdout').length}）`)
  console.log('边界：' + census.note + '；历史 transcript 无思维链 ⇒ 这些状态只能做 L2 续跑起点（续跑时各臂重新压缩），`--store-text` 之后的新轨迹才同时是 L1 题。')
  const vt = valueTable(rows); if (vt.states) console.log(`已有续跑结果的状态 ${vt.states} 个：两臂价值配对 ${vt.pairs.win}胜/${vt.pairs.loss}负，e=${vt.e} / 更差 e=${vt.eReject}`)
  return { states, census, out }
}
/** v4.3：扰动惰性检查（零 API）—— 把真实轨迹的调用重放到扰动仓库，看模型修好前会不会看到扰动物。 */
function cmdPerturbCheck(args) {
  const kind = f(args, '--kind') || 'decoy'
  const dirs = ['traj1', 'traj2', 'traj3'].map((d) => path.join(ROOT, 'transfer', d, 'results.jsonl'))
  const extra = (f(args, '--results') || '').split(',').filter(Boolean).map((x) => path.resolve(ROOT, x))
  const rows = [...dirs, ...extra].flatMap((file) => readJsonl(file).map((r) => ({ ...r, dir: path.basename(path.dirname(file)) })))
  const r = perturbExposure(rows, { kind, full: args.includes('--full') })   // v4.5：缺省首见 + 首次排查命中即停；--full 全量重放（searchHits 计满）
  console.log(`扰动 ${kind} 惰性检查（${r.n} 条真实轨迹反事实重放）：修好前看到不同输出 ${r.exposedBeforeFix}/${r.n}；排查类调用（grep/cat/find/README）命中扰动物 ${r.searchHit}/${r.n} ⇒ **${r.verdict}**`)
  for (const [fam, x] of Object.entries(r.byFamily)) console.log(`  ${fam}: n=${x.n} 可见 ${x.exposedBeforeFix}（首见轮次 ${Object.entries(x.rounds).map(([k, v]) => `r${k}×${v}`).join(' ') || '—'}）排查命中 ${x.searchHit} ⇒ ${x.verdict}${x.truncated ? `（${x.truncated} 条旧行参数截断、只重放到截断处）` : ''}`)
  console.log('边界：' + r.note)
  ensure(RULER_DIR); writeJson(path.join(RULER_DIR, `perturb-${kind}.json`), { schema: 'cfb.perturb-check/1', at: new Date().toISOString(), ...r, rows: r.rows.map(({ id, divergedAt, beforeFix, mentionsPerturb, searchHits, searchHitAt, call, truncated }) => ({ id, divergedAt, beforeFix, mentionsPerturb, searchHits, searchHitAt, call, truncated })) })
  return r
}
/** v4.5：下一个该跑的家族 = 现有轨迹最少的家族（transfer/traj1–3 + runtime 收据），平手按 TRAJ_TASKS 顺序；一次只跑一个家族，读完再决定下一个。 */
export function familyCoverage({ extraDirs = [] } = {}) {
  const files = ['traj1', 'traj2', 'traj3'].map((d) => path.join(ROOT, 'transfer', d, 'results.jsonl'))
  const trajRoot = path.dirname(trajHomeFor(1))
  try { for (const d of fs.readdirSync(trajRoot)) files.push(path.join(trajRoot, d, 'results.jsonl')) } catch { /* 还没有收据 */ }
  files.push(...extraDirs)
  const rows = files.flatMap((fp) => readJsonl(fp)).filter((r) => r && r.task && !r.error && r.status !== 'awaiting-draft')   // v4.6：hand 臂暂停行不算轨迹
  const cov = Object.fromEntries(TRAJ_TASKS.map((t) => [t.id, { total: 0, byArm: {}, rawN: 0, rawSolved: null, floorShare: null, info: null }]))
  const acc = Object.fromEntries(TRAJ_TASKS.map((t) => [t.id, { solved: 0, rounds: 0, over: 0 }]))
  for (const r of rows) {
    const fam = String(r.task).split(':')[0]; const c = cov[fam]; if (!c) continue; c.total++; const arm = r.policy ? 'policy:' + r.policy : r.variant; c.byArm[arm] = (c.byArm[arm] || 0) + 1
    // v4.7 信息量：只看 raw 轨迹 —— 原文过生产地板（3100 字）的轮占比（压缩器会不会触发）与 raw 修好率（天花板效应）
    if (r.variant === 'raw') { c.rawN++; if (r.fixed || (Number.isInteger(r.fixedAtRound) && r.fixedAtRound > 0)) acc[fam].solved++; for (const t of r.transcript || []) { acc[fam].rounds++; if ((t.reasoningChars || 0) >= 3100) acc[fam].over++ } }
  }
  for (const [fam, c] of Object.entries(cov)) if (c.rawN) { c.rawSolved = +(acc[fam].solved / c.rawN).toFixed(2); c.floorShare = acc[fam].rounds ? +(acc[fam].over / acc[fam].rounds).toFixed(2) : null; c.info = c.floorShare == null ? null : +(c.floorShare * (1 - 0.5 * c.rawSolved)).toFixed(3) }   // 触发概率 × (1 − 天花板折扣)：raw 全修好的家族只剩「轮数」一层可分
  return cov
}
/** 轨迹最少者优先；平手时 dev 家族先于留出家族（第一单元是给提议器取证，留出家族的失败不能进证据包）；再平手按 TRAJ_TASKS 顺序。 */
/** 下一个家族：先探索（没有 raw 轨迹的家族，dev 优先），再按信息量 —— 原文过地板的轮占比 × (1 − ½·raw 修好率)（IRT/自适应测验的思路：挑最能分出两臂的题，而不是轮流摊）。
 *  v4.7 之前只按轨迹数轮转：会把钱花在 raw 全修好、压缩器从不触发的家族上（审计：旧家族 raw 修好 7/8，过地板的轮 13%）。 */
export function nextFamily(cov = familyCoverage(), split = null) {
  const sp = split || (() => { try { return loadPool().split } catch { return {} } })()
  const ids = TRAJ_TASKS.map((t) => t.id)
  const unexplored = ids.filter((id) => !(cov[id]?.rawN || 0) && !(cov[id]?.total || 0))
  if (unexplored.length) return [...unexplored].sort((a, b) => ((sp[a] === 'holdout' ? 1 : 0) - (sp[b] === 'holdout' ? 1 : 0)) || (ids.indexOf(a) - ids.indexOf(b)))[0]
  return [...ids].sort((a, b) => ((cov[b]?.info ?? 0) - (cov[a]?.info ?? 0)) || ((cov[a]?.total || 0) - (cov[b]?.total || 0)) || ((sp[a] === 'holdout' ? 1 : 0) - (sp[b] === 'holdout' ? 1 : 0)) || (ids.indexOf(a) - ids.indexOf(b)))[0]
}
export const familyLine = (cov, split = {}) => Object.entries(cov).map(([k, v]) => `${k}${split[k] === 'holdout' ? '[h]' : ''}=${v.total}${v.rawN ? `(raw修好${v.rawSolved}·过地板${v.floorShare ?? '?'}·信息${v.info ?? '?'})` : ''}`).join(' ')
const designDigest = (plan) => evidenceDigest({ variants: plan.variants, scenarios: plan.scenarios, samples: plan.samples, maxRounds: plan.maxRounds, fork: plan.fork, fromStates: plan.fromStates || null, stop: plan.stop || null, maxTokens: plan.maxTokens }).slice(0, 16)
function cmdPlanTraj(args) {
  const h = loadHistory()
  if (f(args, '--drop')) { const dn = Number(f(args, '--drop')); const t = (h.trajPlans || []).find((x) => x.n === dn); if (!t) throw new Error('no-such-plan:t' + dn); if (t.status !== 'planned') throw new Error('plan-not-droppable:' + t.status); h.trajPlans = h.trajPlans.filter((x) => x.n !== dn); writeJson(HISTORY, h); fs.rmSync(trajHomeFor(dn), { recursive: true, force: true }); console.log(`已撤销未执行的计划 t${dn}`); return }
  if (f(args, '--supersede')) { const n = Number(f(args, '--supersede')); const t = (h.trajPlans || []).find((x) => x.n === n); if (!t) throw new Error('no-such-plan:t' + n); if (t.status !== 'planned') throw new Error('only-planned-can-be-superseded:' + t.status); t.status = 'superseded'; t.note = f(args, '--note') || 'v4.5：被单家族单元取代'; writeJson(HISTORY, h); console.log(`t${n} 标记为 superseded（plan.json 保留以备查，status 不再把它当待执行）`); return }
  const n = Number(f(args, '--n') || Math.max(0, ...(h.trajPlans || []).map((t) => t.n)) + 1)
  // v4.3：--from-states FILE（子状态续跑，单位 = 状态而非场景）、--perturb decoy（零 API 场景加难，两臂同扰动）、--stop（一次批准内 e 值有界续跑）、--max-rounds 可到 12
  let fromStates = null
  if (f(args, '--from-states')) { const file = f(args, '--from-states'); const arr = readJson(path.resolve(ROOT, file)); if (!Array.isArray(arr) || !arr.length) throw new Error('from-states-empty:' + file); fromStates = { file: path.relative(ROOT, path.resolve(ROOT, file)), count: arr.length, families: [...new Set(arr.map((x) => x.family))], meanStartRound: +(arr.reduce((a, x) => a + (x.startRound || 2), 0) / arr.length).toFixed(2), digest: evidenceDigest(arr.map((x) => x.id)).slice(0, 16) } }
  const perturb = f(args, '--perturb')
  // v4.5 缺省单位 = **一个家族**（轨迹最少的那个）× 2 臂 × 1 样本 × ≤5 轮 ≈ $0.15：跑完先 review 再决定下一个；--all 才是 5 家族批量
  const cov = familyCoverage()
  const scenarios = f(args, '--scenarios') ? f(args, '--scenarios').split(',') : args.includes('--all') ? TRAJ_TASKS.map((t) => t.id) : [nextFamily(cov)]
  const arms = (f(args, '--arms') || 'raw,policy:base').split(',').map((a) => (a === 'auto' ? 'policy:base' : a))   // v4.5：auto ≡ policy:base（生产 birth 同构体），不再是独立的臂
  if (new Set(arms).size !== arms.length) throw new Error('duplicate-arms:' + arms.join(','))
  const hasHand = arms.includes('hand')
  if (hasHand && (arms.length > 2 || !arms.includes('raw'))) throw new Error('hand-arm-design：模式 1 单元固定为 raw vs hand（两臂）；hand 稿由助手手写，不与策略臂混跑')
  // v4.7 --reuse-raw FILE：复用已有 results.jsonl 里带 roundMessages 的 raw 轨迹当 leader（非同期对照）—— 本单元不再付 raw 臂
  let reuseRaw = null
  if (f(args, '--reuse-raw')) {
    const file = f(args, '--reuse-raw'); const abs = path.resolve(ROOT, file); if (!fs.existsSync(abs)) throw new Error('reuse-raw-missing:' + file)
    const rows = readJsonl(abs).filter((r) => r.variant === 'raw' && !r.error && Array.isArray(r.roundMessages) && r.roundMessages.length)
    const byTask = {}; for (const r of rows) byTask[r.task] = (byTask[r.task] || 0) + 1
    const missing = scenarios.filter((sc) => !byTask[sc.split(':')[0] === sc ? sc : sc]); if (missing.length) throw new Error('reuse-raw-no-rows:' + missing.join(',') + '（该文件里没有这些场景的 raw 轨迹，或缺 roundMessages：要 --store-text 跑出来的）')
    // v4.7.2 延长：旧 raw 被轮数上限截断（最后一轮还在发调用）且本计划轮数更多 ⇒ raw 只付 (R − 旧轮数)，跟随臂最早在旧轨迹第一次过地板那一轮分歧（之前影子，零成本）
    const R = Number(f(args, '--max-rounds') || 5)
    const capped = rows.filter((r) => r.rounds < R && (r.transcript?.[r.transcript.length - 1]?.calls?.length > 0))
    const firstFloor = rows.map((r) => (r.transcript || []).findIndex((t) => (t.reasoningChars || 0) >= 3100) + 1).filter((k) => k > 0)
    const extend = capped.length ? { rows: capped.length, from: Math.round(capped.reduce((a, r) => a + r.rounds, 0) / capped.length), firstFloor: firstFloor.length ? Math.min(...firstFloor) : null } : null
    reuseRaw = { file: path.relative(ROOT, abs), rows: rows.length, byTask, at: rows.map((r) => r.at).filter(Boolean).sort()[0] || null, digest: evidenceDigest(rows.map((r) => [r.task, r.sample, r.rounds, r.fixedAtRound])).slice(0, 16), ...(extend ? { extend } : {}) }
  }
  const calHist = costCalibration(h)   // v4.7.3：有回执就按实测 divergeRound / floorShare 再算一遍期望（常数那份照旧写进计划，校准那份并排给操作者看）
  const plan = buildTrajPlan({ n, arms, reuseRaw, scenarios: perturb ? scenarios.map((x) => x + ':' + perturb) : scenarios, samples: Number(f(args, '--samples') || 1), maxRounds: Number(f(args, '--max-rounds') || 5), fork: !args.includes('--no-fork'), purpose: f(args, '--purpose') || (hasHand ? '模式 1 天花板：hand 臂 = 助手代替副模型手写稿（同一提示词、同一闸链 + G2 决策不变闸）vs raw；量 f(主模型 | 稿) 的上界与「稿该写什么」；hand 永远不采纳为 champion，过闸且修好的稿进金标注册表（gold add）作模式 2 标准' : fromStates ? `子状态续跑（Math-Shepherd 式蒙特卡洛状态价值）：同一分叉点两臂续跑的修好率 / 到修好轮数之差 = 该轮压缩稿价值的原则性定义；${fromStates.count} 个状态来自家族 ${fromStates.families.join('、')}，扩的是家族内配对数，不计入留出家族数` : perturb ? `加难场景（${perturb}：诱饵同名文件 + README 误导，两臂同扰动）：正确下一步不再唯一，考压缩稿能否保住排除项与证据而不是只保住「下一步」` : null), fromStates, stop: args.includes('--stop') ? (Number(f(args, '--cap-usd')) > 0 ? { capUsd: Number(f(args, '--cap-usd')) } : {}) : null })
  for (const sc of plan.scenarios) { const [id, kind] = sc.split(':'); if (!TRAJ_TASKS.some((t) => t.id === id)) throw new Error('unknown-scenario:' + sc); if (kind && kind !== 'decoy') throw new Error('unknown-perturb:' + kind) }
  plan.design = designDigest(plan)
  if (calHist.receipts.length && plan.cost.shadow) {
    // 校准份：同一设计、常数换成回执实测（divergeRound 取中位数、floorShare 取均值）；只做展示与记录，不改上界
    const pr = { ...TRAJ_UNIT, ...(calHist.suggest.divergeRound != null ? { divergeRound: calHist.suggest.divergeRound } : {}), ...(calHist.suggest.floorShare != null ? { floorShare: calHist.suggest.floorShare } : {}) }
    const alt = buildTrajPlan({ n, arms, reuseRaw, scenarios: plan.scenarios, samples: plan.samples, maxRounds: plan.maxRounds, fork: plan.fork, pricing: pr, fromStates: plan.fromStates || null, stop: null })
    plan.cost.calibrated = { receipts: calHist.receipts.length, divergeRound: pr.divergeRound, floorShare: pr.floorShare, expectedMains: alt.cost.expectedMains, expectedCompresses: alt.cost.expectedCompresses, expectedUsd: alt.cost.expectedUsd }
  }
  const dup = (h.trajPlans || []).find((t) => t.design === plan.design && t.status === 'planned' && t.n !== n)
  if (args.includes('--dry')) { console.log(`[dry] 不落盘。设计 ${plan.design}：臂 ${plan.variants.join(' vs ')}；场景 ${plan.scenarios.join(', ')} × ${plan.samples}；≤${plan.maxRounds} 轮；主 ≤${plan.cost.mains} + 压缩 ≤${plan.cost.compresses}，期望主 ${plan.cost.expectedMains} + 压缩 ${plan.cost.expectedCompresses} ≈ $${plan.cost.expectedUsd}（上界 $${plan.cost.capUsd}）` + (dup ? `；同设计已有未执行计划 t${dup.n}` : '')); return plan }
  if (dup && !args.includes('--force')) { console.log(`同一设计的计划已存在：t${dup.n}（design ${dup.design}，未执行）—— 不重复建；要重建加 --force，要撤销用 --drop ${dup.n}`); return readJson(path.join(trajHomeFor(dup.n), 'plan.json')) }
  const home = trajHomeFor(n); ensure(home); writeJson(path.join(home, 'plan.json'), plan)
  h.trajPlans = (h.trajPlans || []).filter((t) => t.n !== n).concat([{ n, at: plan.at, status: 'planned', digest: plan.digest, design: plan.design, expectedUsd: plan.cost.expectedUsd, capUsd: plan.cost.capUsd }]); writeJson(HISTORY, h)
  const L = [`# 分叉轨迹计划 t${n}（digest ${plan.digest}，未发请求）`, '', `目的：${plan.purpose}`, '', `臂：${plan.variants.join(' vs ')}；${plan.fromStates ? `子状态 ${plan.fromStates.count} 个（家族 ${plan.fromStates.families.join(', ')}，平均起始轮 ${plan.fromStates.meanStartRound}，${plan.fromStates.file}）` : '场景：' + plan.scenarios.join(', ')} × ${plan.samples} 样本；≤${plan.maxRounds} 轮；${plan.fork ? '起始轮共用、各臂分叉' : '不分叉'}${plan.stop ? `；**有界续跑**：${plan.stop.compare ? `每组后算 e 值，${plan.stop.compare.champion} vs ${plan.stop.compare.previous} 任一方向 e ≥ ${(1 / plan.stop.alpha).toFixed(0)}（≥${plan.stop.minPairs} 对）或` : '单臂无配对，只按'}估算花费 ≥ $${plan.stop.capUsd} 即停` : ''}`,
    `请求：主调用 ≤${plan.cost.mains} + 压缩 ≤${plan.cost.compresses}（上界：每轮都压、第 1 轮就分歧）；期望主 ${plan.cost.expectedMains} + 压缩 ${plan.cost.expectedCompresses}${plan.cost.shadow ? `（影子分叉：跟随臂到第 ${plan.cost.pricing.divergeRound} 轮才分歧、原文过地板的轮占 ${plan.cost.pricing.floorShare}${plan.reuseRaw ? (plan.reuseRaw.extend ? `；raw 复用 ${plan.reuseRaw.file} 的前 ${plan.reuseRaw.extend.from} 轮、只付续跑的 ${Math.max(0, plan.maxRounds - plan.reuseRaw.extend.from)} 轮；跟随臂第 ${plan.reuseRaw.extend.firstFloor || plan.reuseRaw.extend.from + 1} 轮分歧、付之后的 ${Math.max(0, plan.maxRounds - (plan.reuseRaw.extend.firstFloor || plan.reuseRaw.extend.from + 1))} 轮` : '；raw 复用自 ' + plan.reuseRaw.file + '，不付') : ''}）` : ''}；**期望实付 ≈ $${plan.cost.expectedUsd}，上界 ≈ $${plan.cost.capUsd}**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）`,
    `产出（估）：L1 对 ${plan.yield.l1Pairs}、L2 对 ${plan.yield.l2Pairs}、效度对 ≈${plan.yield.validityPairsApprox}、飞轮对 ≈${plan.yield.flywheelPairsApprox}、子状态 ≈${plan.yield.childStatesApprox}`, '', plan.holdoutNote, '', '批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：', '```', plan.command, '```', '', hasHand ? `回灌：node tools/cfb-cycle.mjs ceiling --plan ${n}   # 模式 1 不走 confirm：hand 不是候选，只量天花板 + 进金标` : `回灌：node tools/cfb-cycle.mjs confirm --plan ${n} --map champion=policy:base,previous=raw   # 或 --parity（auto vs policy:base）`]
  L.push('', `家族覆盖（轨迹数）：${TRAJ_TASKS.map((t) => `${t.id}=${cov[t.id].total}`).join(' ')}；本计划 ${plan.scenarios.length === 1 ? '只跑 ' + plan.scenarios[0] + '，跑完先 `review --plan ' + n + '` 再决定下一个家族' : '批量 ' + plan.scenarios.length + ' 个家族'}`)
  if (plan.cost.calibrated) L.push('', `**按回执校准**（${plan.cost.calibrated.receipts} 张：divergeRound ${plan.cost.calibrated.divergeRound} / floorShare ${plan.cost.calibrated.floorShare}）：期望主 ${plan.cost.calibrated.expectedMains} + 压缩 ${plan.cost.calibrated.expectedCompresses} ≈ $${plan.cost.calibrated.expectedUsd}；上界不变。`)
  if (plan.reuseRaw?.extend) L.push('', `**延长**：${plan.reuseRaw.file} 里的 raw 被 ${plan.reuseRaw.extend.from} 轮上限截断（最后一轮还在发调用）⇒ raw 从第 ${plan.reuseRaw.extend.from + 1} 轮续跑（前 ${plan.reuseRaw.extend.from} 轮零主调用、仓库由重放恢复）；跟随臂最早在第 ${plan.reuseRaw.extend.firstFloor || plan.reuseRaw.extend.from + 1} 轮${plan.reuseRaw.extend.firstFloor ? '（旧轨迹第一次过地板）' : ''}分歧，之前影子。`)
  if (plan.reuseRaw) L.push('', `**非同期对照**：raw 臂复用 ${plan.reuseRaw.file}（${plan.reuseRaw.rows} 条，最早 ${plan.reuseRaw.at || '?'}）。平台试验里的 non-concurrent control：主模型若有时间漂移会偏；只在同一模型 id、短窗口内用，review 时把两次的日期并排看；多个候选共用同一 raw ⇒ 候选之间的比较相关，别把 k 个候选里挑最好的那个当独立证据。`)
  if (hasHand) L.push('', `**模式 1 步进**：hand 臂每到要压缩的那一轮会暂停（results.jsonl 记 awaiting-draft），把副模型本该拿到的 prompt / 原文 / ctx / 协议写进 \`${path.relative(ROOT, trajHomeFor(n))}/pending/<id>.json\`；助手写 \`drafts/<id>.md\` 后**再跑同一条命令**自动续（G2 + 生产闸不过 ⇒ 继续暂停并把违规写回 pending）。压缩调用 0 次（hand 不花钱）。跑完：\`ceiling --plan ${n}\`（不是 confirm）→ \`gold add --plan ${n}\`。`)
  fs.writeFileSync(path.join(home, 'plan.md'), L.join('\n') + '\n'); console.log(L.join('\n'))
  return plan
}
/** 零 API 生成候选：从飞轮里挑一条赢稿做【风格样例】槽（GEPA/DSPy 式 bootstrapped demo）；过补丁预算 + 泄漏闸才落为策略。 */
export function exemplarPolicyFromFlywheel({ flywheel = loadFlywheel(), parent = null, pool = loadPool() } = {}) {
  if (!parent) { try { parent = loadChampionPolicy() } catch { parent = BASE_POLICY } }
  const dev = pool.tasks.filter((t) => t.split === 'dev')
  const cands = flywheel.filter((p) => p.split !== 'holdout' && typeof p.chosenText === 'string' && p.chosenText.length >= 200 && p.chosenText.length <= PATCH_LIMITS.maxExemplarChars)
    .map((p) => ({ ...p, margin: (p.scores?.candidate ?? 0) - (p.scores?.control ?? 0) })).sort((a, b) => Math.abs(b.margin) - Math.abs(a.margin))
  if (!cands.length) return { ok: false, why: '飞轮里没有 200–' + PATCH_LIMITS.maxExemplarChars + ' 字、非留出题的赢稿' }
  const tried = []
  for (const c of cands.slice(0, 5)) {
    const patches = [{ op: 'exemplar', text: c.chosenText.trim() }]
    try { validatePatches(patches) } catch (e) { tried.push({ task: c.task, why: e.message }); continue }
    const leaks = dev.length ? leakCheck(patches, dev, promptHead(dev[0])) : []
    if (leaks.length) { tried.push({ task: c.task, why: 'leak:' + leaks.slice(0, 3).join(',') }); continue }
    const pol = makePolicy({ parent, patches, rationale: `样例槽：用第 ${c.round} 轮 ${c.task} 的赢稿（结构分差 ${c.margin}）替换【风格样例】正文；零 API 生成`, prediction: '赢稿示范的形态（路径 / old_text / 下一步动词）比手写样例更贴近真模型读稿后的好动作', origin: { source: 'flywheel-exemplar', round: c.round, task: c.task, margin: c.margin } })
    return { ok: true, policy: pol, tried }
  }
  return { ok: false, why: '前 5 条赢稿都没过补丁预算 / 泄漏闸', tried }
}
function cmdPolicyFromFlywheel() {
  const r = exemplarPolicyFromFlywheel()
  if (!r.ok) { console.log('未生成：' + r.why + (r.tried?.length ? '\n' + r.tried.map((t) => `  ${t.task}: ${t.why}`).join('\n') : '')); process.exitCode = 2; return }
  ensure(POLICIES); const pf = path.join(POLICIES, r.policy.id + '.json')
  if (fs.existsSync(pf)) { console.log('已存在：' + r.policy.id); return }
  writeJson(pf, r.policy); console.log(`策略 ${r.policy.id}（parent ${r.policy.parent}，op exemplar，零 API）已落 ${path.relative(ROOT, pf)}；下一步 compile --policy ${r.policy.id} 或直接作为 traj 臂 policy:${r.policy.id}` + (r.tried.length ? '\n跳过：' + r.tried.map((t) => `${t.task}(${t.why})`).join(' ') : ''))
}

// ── 5c. v4.6 三模式：ceiling（模式 1 天花板）/ gold（金标注册表）/ plan-bench + bench-report（模式 2） ──────────
function resultsArg(args, kind = 'traj') {
  const planN = f(args, '--plan'); const home = planN ? (kind === 'bench' ? benchHomeFor(planN) : trajHomeFor(planN)) : null
  const file = f(args, '--results') || (home ? path.join(home, 'results.jsonl') : null)
  if (!file || !fs.existsSync(file)) throw new Error(`需要 --plan N（有 results.jsonl）或 --results FILE`)
  return { planN, home: home || path.dirname(path.resolve(file)), file, rows: readResults(file) }
}
/** 模式 1 回灌：hand vs raw 的 L2 结局 → offline/ruler/ceiling-<k>.json + 效度账本；**不碰 champion**（hand 不是候选）。 */
function cmdCeiling(args) {
  const { planN, home, file, rows } = resultsArg(args)
  const map = Object.fromEntries((f(args, '--map') || 'hand=hand,raw=raw').split(',').map((kv) => kv.split('=')))
  // 只算仍在等的：同一 task|variant|sample 后面已有完成行（续跑写的）的暂停行是历史，不再报
  const doneKeys = new Set(rows.filter((r) => r.status !== 'awaiting-draft' && !r.error).map((r) => `${r.fromState || r.task}|${r.variant}|${r.sample}`))
  const waiting = rows.filter((r) => r.status === 'awaiting-draft' && !doneKeys.has(`${r.fromState || r.task}|${r.variant}|${r.sample}`))
  const r = ceilingFrom({ rows, map })
  ensure(RULER_DIR); const k = fs.readdirSync(RULER_DIR).filter((x) => x.startsWith('ceiling-')).length + 1
  writeJson(path.join(RULER_DIR, 'ceiling-' + k + '.json'), { ...r, plan: planN ? 't' + planN : null, source: path.relative(ROOT, path.resolve(file)) })
  if (r.validity.length) fs.appendFileSync(VALIDITY, r.validity.map((x) => JSON.stringify(x)).join('\n') + '\n')
  if (planN) { const h = loadHistory(); const t = (h.trajPlans || []).find((x) => x.n === Number(planN)); if (t && t.status !== 'superseded') { t.status = 'ceiling'; t.ceiling = { k, verdict: r.verdict, pairs: r.cmp.pairs.length, e: r.cmp.e, headroom: r.headroom }; writeJson(HISTORY, h) } }
  const L = [`# 模式 1 天花板（${r.verdict}）`, '', '| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const [k2, v] of [['raw', r.cmp.previous], ['hand', r.cmp.champion]]) L.push(`| ${k2} | ${v.n} | ${v.solved ?? '—'} | ${v.meanRoundsToFix ?? '—'} | ${v.falseClaims} | ${v.verified} | ${v.repeats} |`)
  L.push('', `配对 ${r.cmp.pairs.length}（${r.cmp.pairs.map((p) => p.task + ':' + p.outcome).join(' ')}）；e=${r.cmp.e}，「更差」e=${r.cmp.eReject}，阈 ${+(1 / DEFAULT_DESIGN_V4.alphaHoldout).toFixed(1)}；修好率差（余量点估计）${r.headroom ?? '—'}`)
  L.push(`手写稿闸：尝试 ${r.gate.attempts}、过闸 ${r.gate.accepted}、被拒 ${r.gate.rejected}、低于地板不压 ${r.gate.belowFloor}；影子省下主调用 ${r.gate.shadowRounds}、**未分歧组 ${r.gate.noContrast}**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 ${r.gate.meanRawChars ?? '—'} 字 → 稿 ${r.gate.meanDraftChars ?? '—'} 字 → 拼接后 ${r.gate.meanStoredChars ?? '—'} 字（压缩比 ${r.gate.compression ?? '—'}）`)
  if (waiting.length) L.push(`⚠ 还有 ${waiting.length} 条 hand 轨迹在等手写稿（未计入）：` + waiting.map((w) => `${w.task}#${w.sample} r${w.awaiting?.round}`).join(' '))
  L.push('', r.verdict === 'hand-better' ? '**手写稿分得出比原文好**：f(主模型 | 好稿) 有余量 —— 这些稿是模式 2 的标准（`gold add`），下一步在另一个家族重复，规格要能跨家族' : r.verdict === 'hand-worse' ? '**手写稿比原文差**：主模型读稿不如读原文 —— 别训练压缩器了，先回头看稿（review）：是漏了决定还是漏了排除' : r.verdict === 'insufficient' ? '**配对不够**（<4 对或 <2 家族）：不下结论；再跑一个家族（plan-traj --arms raw,hand）' : '**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定')
  L.push('', `写入 ${path.relative(ROOT, path.join(RULER_DIR, 'ceiling-' + k + '.json'))}` + (r.validity.length ? `；效度账本 +${r.validity.length}` : '') + `；${r.note}`)
  if (r.gate.accepted) L.push(`下一步: node tools/cfb-cycle.mjs gold add --plan ${planN ?? '<N>'}   # 过闸且修好的稿进金标注册表（${path.relative(ROOT, GOLD_DIR())}）`)
  fs.writeFileSync(path.join(home, 'ceiling.md'), L.join('\n') + '\n'); console.log(L.join('\n'))
  return r
}
/** 金标注册表：add --plan N [--include-unsolved] / list。金标 = 过闸的手写稿 + 原文 + ctx + 结局；按家族切分（池的 dev / holdout），落盘后不改。 */
function cmdGold(args) {
  const sub = args[0]
  if (sub === 'add') {
    const { planN, home, rows } = resultsArg(args.slice(1))
    const pool = loadPool()
    const items = goldItemsFromTraj({ home, rows, planId: planN ? 't' + planN : null, split: pool.split })
    const r = saveGold(GOLD_DIR(), items, { includeUnsolved: args.includes('--include-unsolved') })
    console.log(`金标 +${r.added.length}（${path.relative(ROOT, GOLD_DIR())}）` + (r.added.length ? '：' + r.added.join(' ') : '') + (r.skipped.length ? '\n跳过：' + r.skipped.map((x) => `${x.id}(${x.why})`).join(' ') : ''))
    if (r.added.length) console.log(`下一步: node tools/cfb-cycle.mjs plan-bench --policies base,<候选>   # 模式 2：压缩器对金标的召回基准（每项 1 次压缩调用 ≈ $${TRAJ_UNIT.compressUsd}）`)
    return r
  }
  const gold = loadGold(GOLD_DIR())
  console.log(`金标注册表 ${path.relative(ROOT, GOLD_DIR())}：${gold.length} 项` + (gold.length ? '' : '（空：先跑模式 1 —— plan-traj --arms raw,hand → traj-run → ceiling → gold add）'))
  const fams = [...new Set(gold.map((g) => g.family))]
  for (const fam of fams) { const gs = gold.filter((g) => g.family === fam); console.log(`  ${fam} [${gs[0].split}] ${gs.length} 项（修好 ${gs.filter((g) => g.validated).length}）：` + gs.map((g) => `${g.id} r${g.round} ${g.draft.length}字 ${g.outcome.vsRaw ? 'vs raw ' + g.outcome.vsRaw : ''}`).join('；')) }
  return gold
}
/** 模式 2 计划：策略 × 金标项，每项一次压缩调用；设计摘要含金标摘要（金标改了 ⇒ 计划作废）。 */
function cmdPlanBench(args) {
  const h = loadHistory()
  if (f(args, '--drop')) { const dn = Number(f(args, '--drop')); const t = (h.benchPlans || []).find((x) => x.n === dn); if (!t) throw new Error('no-such-plan:b' + dn); if (t.status !== 'planned') throw new Error('plan-not-droppable:' + t.status); h.benchPlans = h.benchPlans.filter((x) => x.n !== dn); writeJson(HISTORY, h); fs.rmSync(benchHomeFor(dn), { recursive: true, force: true }); console.log(`已撤销未执行的基准计划 b${dn}`); return }
  const n = Number(f(args, '--n') || Math.max(0, ...(h.benchPlans || []).map((t) => t.n)) + 1)
  let policies = (f(args, '--policies') || 'base').split(',')
  const known = new Set(listPolicies().map((p) => p.id)); for (const p of policies) if (p !== 'base' && !known.has(p)) throw new Error('policy-not-found:' + p)
  if (new Set(policies).size !== policies.length) throw new Error('duplicate-policies')
  const split = f(args, '--split') || 'dev'; if (!['dev', 'holdout', 'all'].includes(split)) throw new Error('bad-split:' + split)
  // v4.7 --factors half|full：把唯一候选的 k ≤ 3 条补丁当因子，派生 2^(k−1) / 2^k 个臂（派生策略落 policies/，可独立成候选）；报告出每条补丁的主效应
  let factorial = null
  if (f(args, '--factors')) {
    const cands = policies.filter((p) => p !== 'base'); if (cands.length !== 1) throw new Error('factors-needs-one-candidate（--policies base,<候选> 只能一个候选）')
    const d = derivePolicies(loadPolicy(cands[0]), f(args, '--factors'))
    if (!args.includes('--dry')) { ensure(POLICIES); for (const a of d.arms) if (a.policy) { const pf = path.join(POLICIES, a.id + '.json'); const old = readJson(pf); if (old && JSON.stringify(old.patches) !== JSON.stringify(a.policy.patches)) throw new Error('derived-policy-conflict:' + a.id); if (!old) writeJson(pf, a.policy) } }
    policies = d.arms.map((a) => a.id); factorial = { of: cands[0], kind: d.kind, k: d.k, arms: d.arms.map((a) => ({ id: a.id, mask: a.mask })) }
  }
  const home = benchHomeFor(n)
  const plan = buildBenchPlan({ n, policies, factorial, gold: loadGold(GOLD_DIR()), split, pricing: TRAJ_UNIT, purpose: f(args, '--purpose'), planRel: path.relative(ROOT, path.join(home, 'plan.json')), homeRel: path.relative(ROOT, home) })
  const dup = (h.benchPlans || []).find((t) => t.design === plan.design && t.status === 'planned' && t.n !== n)
  if (args.includes('--dry')) { console.log(`[dry] 不落盘。基准设计 ${plan.design}：策略 ${plan.policies.join(' vs ')} × 金标 ${plan.gold.length}（${split}）= ${plan.cost.calls} 次压缩 ≈ $${plan.cost.expectedUsd}（上界 $${plan.cost.capUsd}）` + (dup ? `；同设计已有未执行计划 b${dup.n}` : '')); return plan }
  if (dup && !args.includes('--force')) { console.log(`同一设计的基准计划已存在：b${dup.n}（design ${dup.design}，未执行）—— 不重复建；--force 重建 / --drop ${dup.n} 撤销`); return readJson(path.join(benchHomeFor(dup.n), 'plan.json')) }
  ensure(home); writeJson(path.join(home, 'plan.json'), plan)
  h.benchPlans = (h.benchPlans || []).filter((t) => t.n !== n).concat([{ n, at: plan.at, status: 'planned', digest: plan.digest, design: plan.design, policies, gold: plan.gold.length, split, expectedUsd: plan.cost.expectedUsd, capUsd: plan.cost.capUsd }]); writeJson(HISTORY, h)
  const L = [`# 压缩器基准计划 b${n}（digest ${plan.digest}，未发请求）`, '', `目的：${plan.purpose}`, '', `策略：${plan.policies.join(' vs ')}；金标 ${plan.gold.length} 项（${split}；${[...new Set(plan.gold.map((g) => g.family))].join(', ')}）；指标 ${plan.metric}（冻结）`,
    `请求：压缩调用 ${plan.cost.calls}（主模型 0 次）；**期望实付 ≈ $${plan.cost.expectedUsd}，上界 ≈ $${plan.cost.capUsd}**`, ...(plan.factorial ? ['', `因子设计：候选 ${plan.factorial.of} 的 ${plan.factorial.k} 条补丁各为因子，${plan.factorial.kind} ⇒ ${plan.factorial.arms.length} 个臂（${plan.factorial.arms.map((a) => a.id + '=' + maskBits(a.mask, plan.factorial.k)).join('，')}）；bench-report 出每条补丁的主效应（按金标配对的 e 值），不是只报「候选 vs base」`] : []), '', `选择规则：${plan.selection}`, '', '先零 API 核对（金标摘要 / 两条基线）：', '```', plan.command + ' --dry-run', '```', '批准后执行：', '```', plan.command, '```', '', `回看：node tools/cfb-cycle.mjs bench-report --plan ${n}`]
  fs.writeFileSync(path.join(home, 'plan.md'), L.join('\n') + '\n'); console.log(L.join('\n'))
  return plan
}
function cmdBenchReport(args) {
  const { planN, home, rows } = resultsArg(args, 'bench')
  const bplan = readJson(path.join(home, 'plan.json'))
  const rep = benchReport(rows.filter((r) => !r.dry), { baseline: f(args, '--baseline') || 'base', factorial: bplan?.factorial || null })
  // 因子设计归因出「只留部分补丁」时，把那个子集落成现成策略（幂等；与 plan-bench --factors 派生的同名同内容），好直接进 plan-traj --arms raw,policy:<id>
  if (rep.factorial?.keepId) { const d = derivePolicies(loadPolicy(rep.factorial.of), 'full'); const a = d.arms.find((x) => x.id === rep.factorial.keepId); if (a?.policy) { ensure(POLICIES); const pf = path.join(POLICIES, a.id + '.json'); if (!readJson(pf)) writeJson(pf, a.policy) } }
  const md = benchReportMd(rep, { title: `基准 ${planN ? 'b' + planN : path.basename(home)}` })
  fs.writeFileSync(path.join(home, 'report.md'), md + '\n'); writeJson(path.join(home, 'report.json'), rep)
  if (planN) { const h = loadHistory(); const t = (h.benchPlans || []).find((x) => x.n === Number(planN)); if (t) { t.status = 'reported'; t.best = rep.best; t.paired = Object.fromEntries(Object.entries(rep.paired).map(([k, v]) => [k, { e: v.e, n: v.n, decision: v.decision }])); writeJson(HISTORY, h) } }
  console.log(md)
  return rep
}
/** 等手写稿的 hand 轨迹（扫所有轨迹计划目录的 pending/*.json，不含 done）。 */
export function pendingDrafts() {
  const h = loadHistory(), out = []
  for (const t of h.trajPlans || []) { const dir = path.join(trajHomeFor(t.n), 'pending'); if (!fs.existsSync(dir)) continue; for (const fn of fs.readdirSync(dir)) if (fn.endsWith('.json')) { const p = readJson(path.join(dir, fn)); if (p) out.push({ n: t.n, id: p.id, task: p.task, round: p.round, violations: p.violations, pending: path.relative(ROOT, path.join(dir, fn)), draftFile: p.draftFile, command: readJson(path.join(trajHomeFor(t.n), 'plan.json'))?.command || null }) } }
  return out
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
  // v4.5：操作员一屏 —— 策略 / 轨迹计划（带设计与状态）/ 家族覆盖 / 下一步命令
  const pols = listPolicies()
  console.log('策略: ' + (pols.length ? pols.map((p) => `${p.id}[${p.status || '?'}]←${p.parent || 'base'}(g${p.origin?.gen ?? '?'}, ${p.patches?.length ?? 0} 补丁)`).join('  ') : '无（只有 base = 生产 v4d9）'))
  const tp = h.trajPlans || []
  console.log('轨迹计划: ' + (tp.length ? '' : '无'))
  for (const t of tp) { const pj = readJson(path.join(trajHomeFor(t.n), 'plan.json')); console.log(`  t${t.n} ${String(t.status).padEnd(10)} ${pj ? `${pj.variants.join(' vs ')} × ${pj.scenarios.join(',')} × ${pj.samples} ≤${pj.maxRounds}轮` : '(plan.json 缺)'} ≈$${t.expectedUsd}（上界 $${t.capUsd}）${t.design ? ' design ' + t.design : ''}${t.note ? ' —— ' + t.note : ''}`) }
  let cov = null; try { cov = familyCoverage() } catch { /* 无语料也不碍事 */ }
  if (cov) { const pool = loadPool(); const nf = nextFamily(cov, pool.split); console.log('家族覆盖（已有轨迹数，[h]=留出；raw修好率·原文过地板轮占比·信息量）: ' + familyLine(cov, pool.split) + ` ⇒ 下一个 ${nf}`) }
  // v4.6 三模式：等手写稿 / 金标 / 基准计划
  const pend = pendingDrafts()
  if (pend.length) console.log('等待手写稿: ' + pend.map((p) => `t${p.n} ${p.task} 第 ${p.round} 轮 → 读 ${p.pending}，写 ${p.draftFile}` + (p.violations ? `（上一稿被拒：${p.violations.map((v) => v.kind).join(',')}）` : '')).join('；') + '；写完再跑同一条 traj-run 命令')
  const gold = loadGold(GOLD_DIR()); const bp = h.benchPlans || []
  console.log(`金标: ${gold.length} 项` + (gold.length ? `（${[...new Set(gold.map((g) => g.family))].map((fam) => fam + '=' + gold.filter((g) => g.family === fam).length).join(' ')}）` : '（模式 1 之后才有）') + '；基准计划: ' + (bp.length ? bp.map((b) => `b${b.n} ${b.status} ${b.policies.join(' vs ')} × ${b.gold} ≈$${b.expectedUsd}` + (b.best ? ` best=${b.best}` : '')).join('；') : '无'))
  const planned = tp.find((t) => t.status === 'planned')
  const plannedCmd = planned ? (readJson(path.join(trajHomeFor(planned.n), 'plan.json'))?.command || `node tools/traj-run.mjs --plan ${path.relative(ROOT, path.join(trajHomeFor(planned.n), 'plan.json'))} …（见 plan.md）`) : null
  const plannedPlan = planned ? readJson(path.join(trajHomeFor(planned.n), 'plan.json')) : null
  const plannedHand = !!plannedPlan?.variants?.includes('hand')
  console.log('下一步: ' + (pend.length ? `先写手写稿（${pend.length} 份在等），再跑：\n  ${pend[0].command || '（见 plan.md）'}` : planned ? `已有未执行计划 t${planned.n}（≈$${planned.expectedUsd}，上界 $${planned.capUsd}）—— 用户批准后：\n  ${plannedCmd}\n  跑完：node tools/cfb-cycle.mjs review --plan ${planned.n}` + (plannedHand ? ` && node tools/cfb-cycle.mjs ceiling --plan ${planned.n} && node tools/cfb-cycle.mjs gold add --plan ${planned.n}` : '') : 'node tools/cfb-cycle.mjs plan-traj（一个家族 × raw vs policy:base ≈ $0.15）；模式 1 用 plan-traj --arms raw,hand（≈$0.11，压缩 0 次）'))
  const cal = costCalibration(h)
  if (cal.receipts.length) console.log('成本校准（回执 vs 计划）: ' + cal.receipts.map((x) => `${x.plan} 主 ${x.mainCalls}/${x.expectedMains} 压缩 ${x.compressCalls}/${x.expectedCompresses} $${x.estimatedUsd}/${x.expectedUsd} 影子省 ${x.shadowRounds} 未分歧 ${x.noContrast} 分歧轮 [${x.divergeRounds.join(',')}] 过地板 ${x.floorShareObs ?? '—'}`).join('；') + ` ⇒ TRAJ_UNIT 现 divergeRound ${cal.current.divergeRound} / floorShare ${cal.current.floorShare}，实测建议 ${cal.suggest.divergeRound ?? '—'} / ${cal.suggest.floorShare ?? '—'}`)
  const cf = readJson(CHAMPION); const rv = rulerValidity(loadValidity().map((x) => ({ proxy: x.proxy, outcome: x.outcome })))
  console.log(`尺子: 效度 ${rv.status}（n=${rv.n}）；champion 采纳状态 ${cf?.adoption || (cf ? 'legacy' : 'baseline')}` + (cf?.adoption === 'provisional' ? '（待 L2 确认：confirm --results）' : '') + (exposureWarnings().length ? '；⚠ ' + exposureWarnings().join('；') : ''))
}
/** v4.7 成本校准：每张回执（receipt.json）对照计划的期望 ⇒ 实付主调用 / 压缩调用、实测分歧轮、原文过地板轮占比、未分歧组。
 *  这是 TRAJ_UNIT.divergeRound / floorShare 的唯一更新来源（常数在代码里冻结，证据在这里；回执以前只写不读 —— 产出了没人用的信息）。 */
export function costCalibration(h = loadHistory()) {
  const out = []
  for (const t of h.trajPlans || []) {
    const home = trajHomeFor(t.n); const rc = readJson(path.join(home, 'receipt.json')); if (!rc) continue
    const plan = readJson(path.join(home, 'plan.json')) || {}; const rows = fs.existsSync(path.join(home, 'results.jsonl')) ? readJsonl(path.join(home, 'results.jsonl')).filter((r) => r && !r.error && r.status !== 'awaiting-draft') : []
    const div = rows.filter((r) => r.shadow && !r.extended && r.shadow.divergedAt != null).map((r) => r.shadow.divergedAt)
    let over = 0, n = 0; for (const r of rows.filter((r) => r.variant === 'raw')) for (const x of r.transcript || []) { n++; if ((x.reasoningChars || 0) >= 3100) over++ }
    out.push({ plan: 't' + t.n, expectedMains: plan.cost?.expectedMains ?? plan.cost?.mains ?? null, mainCalls: rc.mainCalls ?? null, expectedCompresses: plan.cost?.expectedCompresses ?? plan.cost?.compresses ?? null, compressCalls: rc.compressCalls ?? null,
      expectedUsd: plan.cost?.expectedUsd ?? null, estimatedUsd: rc.estimatedUsd ?? null, shadowRounds: rc.shadowRounds ?? 0, noContrast: rc.noContrastGroups ?? 0, divergeRounds: div, floorShareObs: n ? +(over / n).toFixed(2) : null, promptTokens: rc.promptTokens ?? null })
  }
  const divAll = out.flatMap((x) => x.divergeRounds).sort((a, b) => a - b), fsAll = out.map((x) => x.floorShareObs).filter((x) => x != null)
  const suggest = { divergeRound: divAll.length ? divAll[Math.floor(divAll.length / 2)] : null, floorShare: fsAll.length ? +(fsAll.reduce((a, b) => a + b, 0) / fsAll.length).toFixed(2) : null }
  return { receipts: out, suggest, current: { divergeRound: TRAJ_UNIT.divergeRound, floorShare: TRAJ_UNIT.floorShare } }
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
  assertPaidRole(generation.role)   // v14.9 规则：propose 等助手角色不得冻结成 API 计划
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
  if (args.includes('--api')) throw new Error('rule:assistant-role:propose（' + RULE.note + '）')
  const { history, g } = genArgs(args)
  let parentId = f(args, '--parent') || readJson(CHAMPION)?.policy || 'base', parentWhy = null
  if (parentId === 'auto') { const pk = pickParent(scoreMatrix(loadHistory()), { seed: Number(f(args, '--seed') || 1), fallback: readJson(CHAMPION)?.policy || 'base' }); parentId = pk.parent; parentWhy = pk.why; console.log(`父代（Pareto 池抽样）：${parentId} — ${pk.why}`) }
  const pool = loadPool(), parent = loadPolicy(parentId)
  const dev = pool.tasks.filter((t) => t.split === 'dev')
  if (!dev.length) throw new Error('no-dev-tasks')
  const plans = {}; for (const r of history.rounds) { try { plans[r.round] = loadPrepared(homeFor(r.round)) } catch { /* 无计划 */ } }
  const evidence = failureEvidence({ history, plans, split: pool.split })
  const extra = f(args, '--note')
  // v14.9：提议器由助手代工 —— 这里只产出「证据包」（与以前喂给 API 的内容同源，只含 dev 题），助手读完写 proposal JSON，再走 policy-from-proposal 的三道闸
  const trajEv = trajFailureEvidence({ holdout: pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id) })
  const pack = { schema: 'cfb.proposal-pack/1', gen: g, at: new Date().toISOString(), parent: { id: parent.id, patches: parent.patches, rationale: parent.rationale }, devTasks: dev.map((t) => ({ id: t.id, u1: String(t.chain?.u1 || '').slice(0, 600), keyFacts: t.spec?.obs?.green?.reference?.keyFacts || null })), holdoutExcluded: pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id), evidence: extra ? evidence.concat([{ note: String(extra).slice(0, 600) }]) : evidence, trajEvidence: trajEv, limits: PATCH_LIMITS, promptHeadChars: promptHead(pool.tasks[0]).length }
  pack.digest = evidenceDigest(pack).slice(0, 16)
  const printOnly = args.includes('--print')   // v4.5：只看证据包，不落盘、不占 gen 号（反复阅读 / 对比父策略时用）
  const file = path.join(OFFLINE, `gen-${g}.pack.json`); if (!printOnly) writeJson(file, pack)
  const md = [`# 提议证据包 g${g}（digest ${pack.digest}）—— 提议器由助手代工，零 API`, '', `父策略：${parent.id}${parentWhy ? '（' + parentWhy + '）' : ''}；补丁预算：≤${PATCH_LIMITS.maxPatches} 条、新增 ≤${PATCH_LIMITS.maxAddedChars} 字、replace 每段 ≤${PATCH_LIMITS.maxReplaceChars} 字、样例槽 ≤${PATCH_LIMITS.maxExemplarChars} 字`, `dev 题：${dev.map((t) => t.id).join(', ')}；留出题已排除：${pack.holdoutExcluded.join(', ')}（证据里不会出现它们的任何内容）`, '',
    '## v9 轮失败证据（history）', ...(evidence.length ? evidence.map((e) => '- ' + JSON.stringify(e).slice(0, 400)) : ['- 无（还没有付费 v9 轮）']), '',
    `## 真实轨迹 / L1 规格样本里的失败证据（transfer，只含 dev 家族）`, `版本提醒：base = ${parent.base || 'compress-v4d9'}；下面 ${trajEv.length} 条证据来自 ${[...new Set(trajEv.map((e) => e.version))].join(' / ') || '—'}；来自 base 本身的结局数据 ${trajEv.filter((e) => e.version === (parent.base || 'compress-v4d9')).length} 条${trajEv.some((e) => e.version === (parent.base || 'compress-v4d9')) ? '' : ' ⇒ 没有 base 自己的失败可修：先跑 raw/auto/policy:base 拿证据，候选只能是机理假设并如实标注'}`, ...trajEv.map((e) => '- ' + JSON.stringify(e).slice(0, 500)), '',
    '## 助手要交回的 JSON（写到任意文件，然后 `policy-from-proposal FILE --gen ' + g + '`）', '```json', JSON.stringify({ patches: [{ op: 'append', section: 'rules', text: '…' }], rationale: '…（引用上面的证据编号）', prediction: '…（哪个旗标会变、不会变）' }, null, 2), '```',
    '闸：补丁预算 → 泄漏闸（补丁里只在 dev 题出现、不在基础提示词里的强记号 ⇒ 拒）→ 可应用（replace 的 from 必须在提示词里恰出现一次）。']
  if (printOnly) { console.log(md.join('\n')); console.log(`\n[print] 未落盘、未登记 g${g}（去掉 --print 才写 gen-${g}.pack.*）`); return { g, pack, file: null } }
  fs.writeFileSync(path.join(OFFLINE, `gen-${g}.pack.md`), md.join('\n') + '\n')
  recordGen(history, { gen: g, at: pack.at, role: 'propose', status: 'pack', label: 'propose(assistant) ← ' + parent.id, planDigest: pack.digest, by: 'assistant' })
  console.log(md.join('\n')); console.log('\n证据包：' + path.relative(ROOT, file))
  return { g, pack, file }
}
/** v14.9：助手代工的提议 → 与 API 提议完全相同的三道闸 → 策略文件。 */
export function policyFromProposal({ file, g = null, parentId = null, now = new Date().toISOString() }) {
  const raw = fs.readFileSync(file, 'utf8')
  const pool = loadPool()
  const packFile = g != null ? path.join(OFFLINE, `gen-${g}.pack.json`) : null, pack = packFile ? readJson(packFile) : null
  const parent = loadPolicy(parentId || pack?.parent?.id || readJson(CHAMPION)?.policy || 'base')
  let proposal
  try { proposal = parseProposal(raw); validatePatches(proposal.patches, { allowEmpty: !!proposal.config }) }   // 闸 1：JSON + 补丁预算（与 ingestGen 的 propose 路径同一函数）；v14.12.3：只带 config 的提议允许空补丁
  catch (e) { throw new Error('proposal-invalid:' + String(e && e.message || e)) }
  const leaks = leakCheck(proposal.patches, pool.tasks, promptHead(pool.tasks[0]))   // 闸 2：泄漏
  if (leaks.length) throw new Error('leak:' + leaks.join(','))
  try { applyPolicyToPrompt(promptHead(pool.tasks[0]), { patches: proposal.patches }) }   // 闸 3：可应用（replace 的 from 必须在提示词里恰出现一次）
  catch (e) { throw new Error('unapplicable:' + String(e && e.message || e)) }
  const pol = makePolicy({ parent, patches: proposal.patches, config: proposal.config || null, rationale: proposal.rationale, prediction: proposal.prediction, origin: { by: 'assistant', gen: g, pack: pack?.digest || null, file: path.relative(ROOT, path.resolve(file)) } })
  const pf = path.join(POLICIES, pol.id + '.json'); ensure(POLICIES)
  if (!fs.existsSync(pf)) writeJson(pf, { ...pol, at: now })
  if (g != null) { const h = loadHistory(); const e = (h.generations || []).find((x) => x.gen === g); if (e) { e.status = 'ingested'; e.policy = pol.id; writeJson(HISTORY, h) } }
  return { policy: pol.id, file: path.relative(ROOT, pf), patches: pol.patches, parent: parent.id }
}
function cmdPolicyFromProposal(args) {
  const file = args.find((a) => !a.startsWith('--') && fs.existsSync(a)); if (!file) throw new Error('需要 proposal JSON 文件路径')
  const r = policyFromProposal({ file, g: f(args, '--gen') != null ? Number(f(args, '--gen')) : null, parentId: f(args, '--parent') })
  console.log(`策略 ${r.policy} 已落盘（status=proposed，parent=${r.parent}，by=assistant）→ ${r.file}\n下一步：plan-traj --arms raw,policy:base,policy:${r.policy}（分叉轨迹里直接当第三臂）；v9 L1 路径才需要 compile --policy ${r.policy}`)
  return r
}
/** 历史证据各变体对应的压缩器版本（CHANGELOG v12.9.1 / v12.9 §2b：run1–4 的 auto = v4d7，auto8/auto8b = v4d8，oracle* = 手写稿；traj1–3 与 run 同期）。
 *  提议器必须知道证据来自哪一版：base 是 v4d9（v4d8 + 程序部件），v4d9 自身至今 0 条结局数据 —— 别去修 v4d8/v4d9 已经专门针对过的失败。 */
export const EVIDENCE_VERSIONS = Object.freeze({ auto: 'compress-v4d7', auto8: 'compress-v4d8', auto8b: 'compress-v4d8', oracle: 'handwritten', oracle2: 'handwritten', oracle3: 'handwritten', ledger: 'ledger(v4d7-era)' })
/** 真实轨迹 + L1 规格样本里的失败证据（只含 dev 家族；留出家族的一切内容都不进提议器）。 */
export function trajFailureEvidence({ holdout = [], trajDirs = ['traj1', 'traj2', 'traj3'], mrDirs = ['run1', 'run2', 'run3', 'run4'] } = {}) {
  const out = []
  const ver = (v) => EVIDENCE_VERSIONS[v] || v
  const tj = trajDirs.flatMap((d) => readJsonl(path.join(ROOT, 'transfer', d, 'results.jsonl')).map((r) => ({ ...r, dir: d }))).filter((r) => !r.error && !holdout.includes(r.task))
  for (const r of tj) {
    const solved = !!(r.fixed || Number.isInteger(r.fixedAtRound))
    if (r.variant !== 'raw' && (!solved || (r.claim === 'fixed' && !solved))) out.push({ kind: 'traj', task: r.task, variant: r.variant, version: ver(r.variant), rounds: r.rounds, solved, claim: r.claim, compressOk: (r.compile || []).map((c) => (c.ok ? 1 : 0)).join(''), edits: (r.edits || []).map((e) => e.path) })
  }
  const mr = mrDirs.flatMap((d) => readJsonl(path.join(ROOT, 'transfer', 'mr', d, 'results.jsonl')).map((r) => ({ ...r, run: d }))).filter((r) => r.rule && !r.error && !holdout.includes(r.task))
  const score = (x) => { const v = (k) => (x[k] === 1 ? 1 : 0); return v('next') + v('avoid') - v('falseDone') - v('bump') - v('reEdit') - v('repeat') }
  const by = {}; for (const r of mr) { const k = `${r.run}|${r.task}|${r.sample}`; (by[k] = by[k] || {})[r.variant] = r }
  for (const [k, b] of Object.entries(by)) {
    const cv = ['auto', 'auto8', 'oracle3', 'oracle2', 'oracle'].find((v) => b[v]); if (!b.raw || !cv) continue
    const c = b[cv], r = b.raw; if (score(c.rule) >= score(r.rule)) continue
    out.push({ kind: 'l1-loss', key: k, variant: cv, version: ver(cv), obs: c.obs, candFlags: c.rule, rawFlags: r.rule, candResponseHead: String(c.response || '').replace(/\s+/g, ' ').slice(0, 220) })
  }
  return out
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
  propose-policy [--gen N] [--parent ID|auto] [--note 文字] [--print]              v14.9：写提议证据包（零 API；提议器由助手代工）；auto = Pareto 池抽父代；--print 只看不落盘
  policy-from-proposal FILE [--gen N] [--parent ID]                                v14.9：助手写的 proposal JSON → 三道闸（预算 / 泄漏 / 可应用）→ 策略文件
  states [--results F,…] [--family ID] [--start-round K] [--limit N] [--out FILE]   v4.3：从轨迹派生可续跑的子状态（零 API），打印家族 / 状态盘点；--limit 1 做探针
  perturb-check [--kind decoy]                                                      v4.3：扰动惰性检查（真实轨迹反事实重放，零 API）：可见 ≠ 更难
  ruler [--write-design]                                                          尺子效度 + v4.3 到修好轮数 C 指数 / ICC / 六旗标回归 / Pareto 池；--write-design 写实测 ICC
  compile  --policy ID [--tasks a,b] | --mint ID   [--gen N]                      冻结按策略重压 side / 铸造件压稿的计划（≤8 请求）
  mint     --step a --scenario FILE | --step b --id ID   [--gen N]                冻结铸造新题的计划（u1→a1；人补 u2 后 a1+u2→a2）
  ingest-gen --gen N [--report FILE]                                             回灌生成计划：策略文件 / side / 铸造件（三闸：预算、泄漏、可应用）
  confirm  --results FILE | --plan N [--map champion=<v>,previous=<v>] [--parity]  v4：L2 结局确认 / 回滚 provisional champion；--parity = auto vs policy:base 路径等价校准
  plan-traj [--all] [--dry] [--drop N] [--supersede N] [--force] [--arms raw,policy:base] [--scenarios a,b] [--samples 1] [--max-rounds 5] [--perturb decoy] [--stop [--cap-usd X]] [--reuse-raw FILE]
                                                                                 v4.5：冻结付费单位。缺省 = 下一个家族（未探索优先，其次信息量最高）× raw vs policy:base × 1 样本 × ≤5 轮；
                                                                                 v4.7 影子分叉：跟随臂分歧前不发主调用 ⇒ 期望 7 主 + 2 压缩 ≈ $0.103（上界 $0.372 不变）；--reuse-raw 复用旧 raw 轨迹当 leader（≈$0.025/对，非同期对照）
                                                                                 --all 五家族；--dry 只算不落盘；同设计未执行的计划不重复建（--force 重建 / --drop 撤销 / --supersede 作废）
  review --plan N | --results FILE [--draft-chars 700]                           v4.5：读一个单元的结果 → review.md（分歧轮、各臂结局、分歧处压缩稿原文、闸门、代理旗标）
  ceiling --plan N | --results FILE [--map hand=hand,raw=raw]                      v4.6 模式 1：hand（助手手写稿）vs raw 的 L2 天花板 → ruler/ceiling-k.json + 效度账本；不碰 champion
  gold add --plan N [--include-unsolved] | gold list                               v4.6：过闸且修好的手写稿 → 金标注册表 transfer/gold/<family>/（按家族 dev/holdout，落盘不改）
  plan-bench [--policies base,p-x] [--split dev|holdout|all] [--dry] [--drop N] [--factors half|full]
                                                                                 v4.6 模式 2：策略 × 金标 各一次压缩调用（≈$0.0075/次）；指标 dd/1 冻结；dev 配对选策略、holdout 只报告
                                                                                 v4.7 --factors：候选的 k≤3 条补丁各为因子（half=2^(k−1) 含 base 不含全开 / full=2^k），bench-report 出每条补丁的主效应 ⇒ 知道该留哪条
  bench-report --plan N | --results FILE [--baseline base]                         v4.6：基准报告 → report.md；promote 的策略进 plan-traj（模式 3）验收，基准分不采纳 champion
  snapshot / restore [--from FILE] [--force]                                     v4.5：闭环状态（history / champion / 策略 / 轨迹计划 / 证据包）↔ transfer/cycle-state.json（进仓库；新克隆先 restore）
  policy-from-flywheel                                                           v4.2：零 API 从飞轮赢稿生成【风格样例】槽策略（过预算 + 泄漏闸）
  ruler                                                                          v4：尺子效度（AUC+CI）/ 采纳规则 / e 值预算 / 留出曝光 / CPU 排序器 / L2 基线
  policies | status | doctor | simulate [--p 0.7] [--rounds 5]
杠杆（v3 顺序，低风险在前）：${LEVER_ORDER_V3.map((l) => l + '{' + KNOBS[l].values.join('|') + '}').join(' ')}  + policy=<已编译策略>
本文件不发任何网络请求；live 只能由 tools/effect-ready.mjs run --live --v9 --round N 显式执行。`
export function dispatch(cmd = 'status', args = []) {
  // v14.10：--help / -h 在任何子命令后都只打印帮助，不执行、不落盘（之前 `plan-traj --help` 会真的建一个计划）
  if (args.includes('--help') || args.includes('-h')) { console.log(helpFor(cmd)); return }
  if (cmd === 'plan' || cmd === 'run') cmdPlan(args)
  else if (cmd === 'ingest') cmdIngest(args)
  else if (cmd === 'propose') cmdPropose(args)
  else if (cmd === 'confirm') cmdConfirm(args)
  else if (cmd === 'ruler') cmdRuler(args)
  else if (cmd === 'states') cmdStates(args)
  else if (cmd === 'perturb-check') cmdPerturbCheck(args)
  else if (cmd === 'plan-traj') cmdPlanTraj(args)
  else if (cmd === 'policy-from-flywheel') cmdPolicyFromFlywheel()
  else if (cmd === 'propose-policy') cmdProposePolicy(args)
  else if (cmd === 'policy-from-proposal') cmdPolicyFromProposal(args)
  else if (cmd === 'review') cmdReview(args)
  else if (cmd === 'ceiling') cmdCeiling(args)
  else if (cmd === 'gold') cmdGold(args)
  else if (cmd === 'plan-bench') cmdPlanBench(args)
  else if (cmd === 'bench-report') cmdBenchReport(args)
  else if (cmd === 'snapshot') cmdSnapshot()
  else if (cmd === 'restore') cmdRestore(args)
  else if (cmd === 'compile') cmdCompile(args)
  else if (cmd === 'mint') cmdMint(args)
  else if (cmd === 'ingest-gen') cmdIngestGen(args)
  else if (cmd === 'policies') cmdPolicies()
  else if (cmd === 'status') cmdStatus()
  else if (cmd === 'doctor') cmdDoctor()
  else if (cmd === 'simulate') cmdSimulate(args)
  else if (['help', '--help', '-h'].includes(cmd)) console.log(args[0] ? helpFor(args[0]) : HELP)
  else { console.log(HELP); throw new Error('未知子命令 ' + cmd) }
}
/** 只给一条子命令的帮助行（找不到就整份）。 */
export function helpFor(cmd) { const lines = HELP.split('\n').filter((l) => l.trim().startsWith(cmd + ' ') || l.trim() === cmd); return lines.length ? lines.join('\n') : HELP }
/** 进程内 CLI：与 `node tools/cfb-cycle.mjs <cmd> …` 等价，但不起子进程；可选 dir 改道（跑完恢复）。返回 {status, stdout, stderr}。
 *  自测用它替代 spawnSync（每次子进程 ≈ 150 ms × 上百次 = 这三套自测的大头）；脚本 / 助手也能用它驱动闭环。 */
export function runCli(argv, { dir = undefined } = {}) {
  const [cmd = 'status', ...args] = argv
  const prevDir = BASE, out = [], err = []
  const log = console.log, error = console.error
  console.log = (...a) => { out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  console.error = (...a) => { err.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  const prevExit = process.exitCode; process.exitCode = undefined
  let status = 0
  try { if (dir !== undefined) setCycleDir(dir); dispatch(cmd, args); status = Number(process.exitCode) || 0 }   // 命令用 process.exitCode 表达非零退出（如 plan 的 offline-unsafe ⇒ 2）
  catch (e) { status = 1; err.push(e && e.stack ? e.stack : String(e)) }
  finally { console.log = log; console.error = error; process.exitCode = prevExit; if (dir !== undefined) setCycleDir(prevDir) }
  return { status, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: err.join('\n') + (err.length ? '\n' : '') }
}
function main() { const [cmd = 'status', ...args] = process.argv.slice(2); dispatch(cmd, args) }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
