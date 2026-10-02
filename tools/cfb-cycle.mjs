#!/usr/bin/env node
// tools/cfb-cycle.mjs —— 闭环 v2（v14.2）：按比特买证据的训练环。
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
import { KNOBS, BASELINE_KNOBS, LEVER_ORDER, loadFrozenTasks, generateCandidates, armSummary } from './helpers/candidates.mjs'
import { truthDimensions, truthComposite, truthDelta, TRUTH_DIMENSIONS } from './helpers/truth-dims.mjs'
import { sequentialPaired, pairResults, expectedBitsNextPair, bitsBought, pairsToDecide, costEstimate, usdPerBit, DEFAULT_DESIGN, betaCdf } from './helpers/experiment.mjs'
import { prepareEvaluation, reportEvaluation, loadPrepared, DEFAULT_HOME_V9, PUBLIC_RECEIPT_V9, PROFILE_EXAMPLE, ROOT } from './helpers/eval-workflow.mjs'
import { auditApiPlan, planScope, APPROVED_API_LIMITS_V9 } from './helpers/api-budget.mjs'
import { readWatermark } from './helpers/api-watermark.mjs'

// 目录：默认仓库里的 .cfb-offline / .cfb-runtime/bounded-ab-v9/rN / transfer 收据；自测用 CFB_CYCLE_DIR 整体改道（不碰真实轮次）。
const BASE = process.env.CFB_CYCLE_DIR ? path.resolve(process.env.CFB_CYCLE_DIR) : null
export const OFFLINE = BASE ? path.join(BASE, 'offline') : path.join(ROOT, '.cfb-offline')
export const HISTORY = path.join(OFFLINE, 'history.json')
export const CHAMPION = path.join(OFFLINE, 'champion.json')
export const homeFor = (round) => (BASE ? path.join(BASE, 'runtime', 'r' + Number(round)) : DEFAULT_HOME_V9(round))
export const receiptFor = (round) => (BASE ? path.join(BASE, 'receipts', 'v9-r' + Number(round) + '.watermark.json') : PUBLIC_RECEIPT_V9(round))
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)
const ensure = (d) => { fs.mkdirSync(d, { recursive: true }); return d }
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p, o) => { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }
const short = (o) => evidenceDigest(o).slice(0, 8)

export function loadHistory() { return readJson(HISTORY, { schema: 'cfb.closed-loop/2', hypotheses: {}, rounds: [] }) }
export function loadChampion() { const c = readJson(CHAMPION); return c && c.knobs ? c.knobs : { ...BASELINE_KNOBS } }
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
export function pickHypothesis({ rows, champion, history, override = null }) {
  const verdicts = {}
  for (const lever of LEVER_ORDER) for (const value of KNOBS[lever].values) {
    if (champion[lever] === value) continue
    verdicts[lever + '=' + value] = armVerdict(rows, lever + '=' + value)
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
  for (const lever of LEVER_ORDER) for (const value of KNOBS[lever].values) {
    const k = lever + '=' + value
    if (champion[lever] === value || decided.has(k) || displaced.has(k)) continue
    const v = verdicts[k]
    if (v.safe) return { lever, value, verdict: v, why: `理论顺序第一个「可用 ≥3 题、离线无可预见伤害」的新假设（${KNOBS[lever].theory}）`, verdicts }
  }
  return { lever: null, value: null, verdict: null, why: '没有可测的新假设：全部已判定 / 退化 / 离线裁决不安全。需要新的杠杆（见 CLOSED-LOOP-V2.md「怎么加杠杆」）', verdicts }
}

// ── 3. plan ─────────────────────────────────────────────────────────────────
export function buildRound({ round, override = null, profile, pricing, force = false, champion = loadChampion(), history = loadHistory() }) {
  const tasks = loadFrozenTasks()
  const cands = generateCandidates(tasks, { champion })
  const rows = offlineTable(tasks, cands)
  const pick = pickHypothesis({ rows, champion, history, override })
  if (!pick.lever) return { ok: false, reason: 'no-hypothesis', pick, arms: armSummary(cands), rows }
  if (!pick.verdict.safe && !force) return { ok: false, reason: 'offline-unsafe', pick, arms: armSummary(cands), rows }
  const arm = pick.lever + '=' + pick.value
  const pairs = pick.verdict.usableTasks.map((task) => {
    const ctrl = cands.find((c) => c.task === task && c.isControl), cand = cands.find((c) => c.task === task && c.arm === arm)
    return { task, control: ctrl.text, candidate: cand.text, knobs: cand.knobs }
  })
  const hypothesis = { lever: pick.lever, value: pick.value, champion, theory: KNOBS[pick.lever].theory, kind: KNOBS[pick.lever].kind }
  // immutableJson 拒绝 undefined：只放有值的键
  const offline = { table: rows.filter((r) => r.arm === arm || r.arm === 'control').map((r) => ({ task: r.task, arm: r.arm, composite: r.composite, chars: r.chars, ...(r.rawComposite != null ? { rawComposite: r.rawComposite } : {}), ...(r.delta ? { delta: r.delta } : {}), ...(r.dims ? { dims: r.dims } : {}) })), verdict: pick.verdict, why: pick.why }
  const home = homeFor(round), receiptPath = receiptFor(round)
  if (readWatermark(receiptPath)) throw new Error('round-already-has-receipt:' + round)
  const prepared = prepareEvaluation({ home, receiptPath, profile, ...(pricing !== undefined ? { pricing } : {}), version: 9, candidates: pairs, round, hypothesis, offline, env: process.env })
  const plan = loadPrepared(home)
  let audit = null; try { audit = auditApiPlan(plan, { allowUnpriced: true }) } catch { audit = null }
  const cost = costEstimate({ plan, audit, pricing: plan.pricing })
  const key = hypothesisKey(pick.lever, pick.value, champion)
  const prior = history.hypotheses?.[key]?.outcomes?.map((o) => o.outcome) || []
  const seq = sequentialPaired(prior)
  const info = usdPerBit({ alpha: seq.alpha, beta: seq.beta, pairs: pairs.length, expectedUsd: cost.expectedUsd })
  return { ok: true, round, key, hypothesis, pairs: pairs.map((p) => ({ task: p.task, controlChars: p.control.length, candidateChars: p.candidate.length })), offline, arms: armSummary(cands), rows, plan: { digest: evidenceDigest(plan), scope: planScope(plan), jobs: plan.jobs.length, home: path.relative(ROOT, home), receipt: path.relative(ROOT, receiptPath), sourceDigest: plan.sourceDigest }, preflight: prepared.status, checks: prepared.checks, cost, info, posteriorBefore: seq, horizon: { p07: pairsToDecide({ pTrue: 0.7 }), p08: pairsToDecide({ pTrue: 0.8 }) } }
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
  L.push('## 配对（每题 1 对，两臂只有第 2 轮 reasoning 不同）', '', '| 任务 | control 字数 | candidate 字数 |', '| --- | --- | --- |')
  for (const p of r.pairs) L.push(`| ${p.task} | ${p.controlChars} | ${p.candidateChars} |`)
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
  L.push(`- 判定规则：Beta(1,1)，P(p>0.5) ≥ ${DEFAULT_DESIGN.adoptAt} 采纳 / ≤ ${DEFAULT_DESIGN.rejectAt} 否决 / 累计 ${DEFAULT_DESIGN.maxPairs} 对未判即停；若真实胜率 0.7，中位 ${r.horizon.p07.medianPairs} 对判定；0.8 ⇒ ${r.horizon.p08.medianPairs} 对`)
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
  const r = buildRound({ round, override: f(args, '--lever'), profile, pricing, force: args.includes('--force') })
  const md = renderPlanMd(r)
  if (r.ok) {
    writeJson(path.join(OFFLINE, 'round-' + round + '.plan.json'), { schema: 'cfb.cycle-plan/2', at: new Date().toISOString(), ...r, rows: undefined, checks: undefined })
    const h = loadHistory()
    h.rounds = h.rounds.filter((x) => x.round !== round)
    h.rounds.push({ round, at: new Date().toISOString(), status: 'planned', key: r.key, lever: r.hypothesis.lever, value: r.hypothesis.value, champion: r.hypothesis.champion, tasks: r.pairs.map((p) => p.task), planDigest: r.plan.digest, scope: r.plan.scope, reservedUsd: r.cost.reservedUsd, expectedUsd: r.cost.expectedUsd })
    h.rounds.sort((a, b) => a.round - b.round)
    writeJson(HISTORY, h)
  }
  fs.writeFileSync(path.join(OFFLINE, 'round-' + round + '.plan.md'), md + '\n')
  console.log(md)
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
  const pairs = pairResults(results, { arms: plan.arms })
  if (!pairs.length) throw new Error('no-paired-results（账本里还没有两臂齐全的样本；先 run --live 或用 --report 导入）')
  const key = hypothesisKey(plan.hypothesis.lever, plan.hypothesis.value, plan.hypothesis.champion)
  const hyp = history.hypotheses[key] || { key, lever: plan.hypothesis.lever, value: plan.hypothesis.value, champion: plan.hypothesis.champion, kind: plan.hypothesis.kind, outcomes: [], decision: 'continue', rounds: [] }
  if (hyp.decision !== 'continue') throw new Error('hypothesis-already-decided:' + key)
  for (const p of pairs) hyp.outcomes.push({ round, task: p.task, sample: p.sample, outcome: p.outcome, candidate: p.candidate, control: p.control, candidateAction: p.candidateAction, controlAction: p.controlAction })
  hyp.rounds.push(round)
  const seq = sequentialPaired(hyp.outcomes.map((o) => o.outcome))
  hyp.decision = seq.decision
  hyp.posterior = { n: seq.n, wins: seq.wins, losses: seq.losses, ties: seq.ties, pWin: seq.pWin, mean: seq.mean, ci95: seq.ci95, bitsBought: bitsBought(seq.alpha, seq.beta), nextPairBits: expectedBitsNextPair(seq.alpha, seq.beta) }
  if (seq.decision !== 'continue') hyp.decidedAtRound = round
  history.hypotheses[key] = hyp
  const watermark = readWatermark(receiptPath)
  const roundEntry = { round, at: now, status: 'ingested', key, lever: hyp.lever, value: hyp.value, champion: hyp.champion, tasks: plan.tasks, planDigest: evidenceDigest(plan), scope: planScope(plan),
    pairs: pairs.length, outcomes: pairs.map((p) => ({ task: p.task, outcome: p.outcome, candidate: p.candidate, control: p.control })), decision: seq.decision, pWin: seq.pWin,
    reservedUsd: watermark ? +(watermark.reservedNano / 1e9).toFixed(4) : (rep.reservedUsd ?? null), requestsReserved: watermark?.requests ?? rep.requestsReserved ?? null, rejected: rep.requestsRejected || [], ingestedFrom: report ? 'report-file' : 'ledger', complete: !!rep.complete }
  history.rounds = history.rounds.filter((r) => r.round !== round).concat([roundEntry]).sort((a, b) => a.round - b.round)
  let championChange = null
  if (seq.decision === 'adopt') {
    const next = { ...hyp.champion, [hyp.lever]: hyp.value }
    const prev = readJson(CHAMPION) || { schema: 'cfb.champion/1', knobs: { ...BASELINE_KNOBS }, adopted: [] }
    championChange = { from: hyp.champion, to: next }
    writeJson(CHAMPION, { schema: 'cfb.champion/1', knobs: next, adopted: [...(prev.adopted || []), { round, lever: hyp.lever, value: hyp.value, pWin: seq.pWin, n: seq.n, kind: hyp.kind }], at: now })
    history.champion = next
  }
  writeJson(HISTORY, history)
  const out = { round, key, pairs, posterior: hyp.posterior, decision: seq.decision, championChange, reservedUsd: roundEntry.reservedUsd, ingestedFrom: roundEntry.ingestedFrom, complete: roundEntry.complete }
  writeJson(path.join(OFFLINE, 'round-' + round + '.result.json'), { schema: 'cfb.cycle-result/2', at: now, ...out })
  return out
}
export function renderIngestMd(r) {
  const L = [`# 第 ${r.round} 轮回灌：${r.key}`, '', `来源：${r.ingestedFrom}；账本完整：${r.complete ? '是' : '否（有样本缺失 / 被拒，按已有配对计）'}；本轮预占 USD ${r.reservedUsd ?? '—'}`, '']
  L.push('| 任务 | candidate 结构分 | control 结构分 | 结果 |', '| --- | --- | --- | --- |')
  for (const p of r.pairs) L.push(`| ${p.task} | ${p.candidate} | ${p.control} | ${p.outcome} |`)
  const po = r.posterior
  L.push('', `累计 ${po.n} 对：胜 ${po.wins} / 负 ${po.losses} / 平 ${po.ties}；p 后验均值 ${po.mean}，95% ${po.ci95.join('–')}，P(p>0.5)=${po.pWin}；已买到 ${po.bitsBought} bit，再买一对期望 ${po.nextPairBits} bit`)
  L.push('', `**判定：${r.decision}**` + (r.decision === 'adopt' ? `  ⇒ champion 更新：${JSON.stringify(r.championChange.to)}（下一轮 control 就是它；\`propose\` 给出生产 diff）` : r.decision === 'reject' ? '  ⇒ 这个旋钮不进生产；下一轮换下一个假设' : r.decision === 'continue' ? '  ⇒ 证据不够：下一轮 `plan` 会继续同一假设' : '  ⇒ 25 对仍分不出：效应量 < 可判定下限，不再为它花钱'))
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
  return { schema: 'cfb.proposal/2', at: new Date().toISOString(), champion, baseline: BASELINE_KNOBS, configDiff, needsSrcChange, unchanged, adopted: championFile?.adopted || [], rule: '只有 ingest 判 adopt 的旋钮才出现在这里；配置 diff 可直接落 deploy / 本机 config，src 改动按 needsSrcChange 由人实施并走 verify + audit-noninferiority' }
}
function cmdPropose() {
  const p = proposeFrom()
  writeJson(path.join(OFFLINE, 'proposal.json'), p)
  const L = ['# 生产提案（只含已采纳的旋钮）', '', 'champion: `' + JSON.stringify(p.champion) + '`', '']
  if (!Object.keys(p.configDiff).length && !p.needsSrcChange.length) L.push('还没有任何旋钮通过序贯判定；生产配置保持现状。')
  if (Object.keys(p.configDiff).length) L.push('## 配置 diff（可直接落）', '', '```json', JSON.stringify(p.configDiff, null, 2), '```', '')
  for (const n of p.needsSrcChange) L.push(`## 需要改 src：${n.knob}=${n.value}（${n.kind}）`, '', `- 落点：${n.where}`, `- 做法：${n.note}`, `- 证据：${n.evidence.map((e) => `第 ${e.round} 轮 P(p>0.5)=${e.pWin}，n=${e.n}`).join('；') || '—'}`, '')
  console.log(L.join('\n'))
  console.log('已写入 .cfb-offline/proposal.json')
}

// ── 6. status / doctor / simulate ───────────────────────────────────────────
function cmdStatus() {
  const h = loadHistory(), champion = loadChampion()
  console.log('champion: ' + JSON.stringify(champion) + (short(champion) === short(BASELINE_KNOBS) ? '（= 生产基线）' : ''))
  console.log('轮次: ' + h.rounds.length + '；累计预占 USD ' + h.rounds.reduce((a, r) => a + (r.status === 'ingested' ? r.reservedUsd || 0 : 0), 0).toFixed(4) + '（只算已回灌的轮）')
  for (const r of h.rounds) console.log(`  r${r.round} ${r.status.padEnd(8)} ${r.lever}=${r.value} tasks=${(r.tasks || []).length}` + (r.status === 'ingested' ? ` pairs=${r.pairs} decision=${r.decision} P=${r.pWin} USD=${r.reservedUsd ?? '—'}` : ` reserved≈${r.reservedUsd ?? '未定价'}`))
  const hs = Object.values(h.hypotheses || {})
  console.log('假设: ' + hs.length)
  for (const x of hs) console.log(`  ${x.key} ${x.decision} n=${x.outcomes.length} P(p>0.5)=${x.posterior?.pWin ?? '—'} bits=${x.posterior?.bitsBought ?? '—'}`)
}
export function doctorChecks() {
  const checks = []
  let tasks = [], cands = [], rows = []
  try { tasks = loadFrozenTasks(); checks.push(['冻结任务可加载（chains / d1 / d2 / specs）', tasks.length === 5, tasks.length + '/5']) } catch (e) { checks.push(['冻结任务可加载', false, e.message]) }
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

const HELP = `cfb-cycle（闭环 v2）：
  plan     [--round N] [--lever k=v] [--profile FILE] [--pricing FILE] [--force]   零 API 成稿 + 冻结 v9 计划，停下等批准
  ingest   --round N [--report FILE]                                              回灌：配对 → 后验 → adopt/reject/continue
  propose                                                                        把已采纳旋钮翻成生产配置 diff / src 改动说明
  status | doctor | simulate [--p 0.7] [--rounds 5]
杠杆：${LEVER_ORDER.map((l) => l + '{' + KNOBS[l].values.join('|') + '}').join(' ')}
本文件不发任何网络请求；live 只能由 tools/effect-ready.mjs run --live --v9 --round N 显式执行。`
function main() {
  const [cmd = 'status', ...args] = process.argv.slice(2)
  if (cmd === 'plan' || cmd === 'run') cmdPlan(args)
  else if (cmd === 'ingest') cmdIngest(args)
  else if (cmd === 'propose') cmdPropose()
  else if (cmd === 'status') cmdStatus()
  else if (cmd === 'doctor') cmdDoctor()
  else if (cmd === 'simulate') cmdSimulate(args)
  else if (['help', '--help', '-h'].includes(cmd)) console.log(HELP)
  else { console.log(HELP); throw new Error('未知子命令 ' + cmd) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
