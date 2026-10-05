// tools/helpers/three-mode.mjs — 三模式（v14.11 / 闭环 v4.6）的零 API 库：
//   模式 1 天花板（ceilingFrom）：hand（助手手写稿）vs raw 的 L2 结局比较 —— 量的是 f(主模型 | 稿) 的上界与「稿该写什么」，hand 永远不能当 champion；
//   金标注册表（goldItemsFromTraj / loadGold / saveGold）：过了闸、主模型读后真修好的手写稿 = 模式 2 的标准（按家族 dev / holdout 切分，摘要冻结）；
//   模式 2 基准（buildBenchPlan / benchReport）：压缩器在同一原文上出的稿与金标按 draftDistance 比对，dev 项配对 e 值选策略、holdout 项只报告；
//   基准分**只决定哪条策略值得进 plan-traj（模式 3）**，不采纳 champion —— 指标没对过真实结局之前，按它搜索就是过拟合（v12.6：评委分 ≠ 结局）。
// 付费只发生在 tools/bench-run.mjs（压缩调用）与 traj-run（主调用）；本文件不发任何网络请求。
import fs from 'node:fs'
import path from 'node:path'
import { evidenceDigest } from '../../src/evidence-program.js'
import { outcomeComparison, episodeOutcome, eValueWins, DEFAULT_DESIGN_V4 } from './ruler.mjs'
import { compareKeys, handDraftGate } from './hand-draft.mjs'
import { auditMode1Gold, auditMode1Pair, isMode1GoldEligible } from './mode1-quality.mjs'

/** draftDistance 公式版本：冻结进基准计划；改公式必须改版本号，不同版本的基准分不可比（指标在设计里冻结，不随结果调）。 */
export const DRAFT_DISTANCE_VERSION = 'dd/1'
export const readResults = (file) => { const raw = fs.readFileSync(file, 'utf8').trim(); if (!raw) return []; return raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }
/** 完成行：有 task、无 error、不是 hand 臂的「等待手写稿」暂停行。 */
export const liveRows = (rows) => (rows || []).filter((r) => r && r.task && !r.error && r.status !== 'awaiting-draft')
export const safeId = (id) => String(id).replace(/[^\w.-]/g, '_')
const readJsonMaybe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const mean = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null }

// ── 模式 1：天花板 ──────────────────────────────────────────────────────────
/** hand vs raw 的分层成对结局比较（与 confirmFrom 同一把 GPC 尺子），外加手写稿闸门统计。不读不写 champion。 */
export function ceilingFrom({ rows, map = { hand: 'hand', raw: 'raw' }, alpha = DEFAULT_DESIGN_V4.alphaHoldout, now = new Date().toISOString() }) {
  const live = liveRows(rows)
  const typed = live.map((r) => ({ ...r, arm: r.variant === map.hand ? 'champion' : r.variant === map.raw ? 'previous' : null })).filter((r) => r.arm)
  if (!typed.some((r) => r.arm === 'champion') || !typed.some((r) => r.arm === 'previous')) throw new Error(`ceiling-no-rows（需要 ${map.hand} 与 ${map.raw} 两臂都有完成行；暂停中的 hand 行不算；--map hand=<variant>,raw=<variant>）`)
  const cmp = outcomeComparison(typed)
  const handRows = typed.filter((r) => r.arm === 'champion')
  const compiles = handRows.flatMap((r) => (r.compile || []).map((c, i) => ({ task: r.task, sample: r.sample ?? 0, round: i + 1, ...c })))
  const acc = compiles.filter((c) => c.path === 'hand')
  const attempts = handRows.reduce((a, r) => a + (r.resumed || 0), 0)
  const noContrast = handRows.filter((r) => r.shadow && !r.extended && r.shadow.divergedAt == null).length, shadowRounds = handRows.reduce((a, r) => a + (r.shadow?.rounds || 0), 0)
  const gate = { attempts, accepted: acc.length, rejected: Math.max(0, attempts - acc.length), belowFloor: compiles.filter((c) => c.belowFloor).length, noContrast, shadowRounds,
    meanRawChars: mean(acc.map((c) => c.rawChars)), meanDraftChars: mean(acc.map((c) => c.draftChars)), meanStoredChars: mean(acc.map((c) => c.outChars)),
    compression: acc.length ? +(acc.reduce((a, c) => a + c.outChars, 0) / Math.max(1, acc.reduce((a, c) => a + c.rawChars, 0))).toFixed(3) : null }
  const perGroup = cmp.pairs.map((p) => ({ task: p.task, sample: p.sample, outcome: p.outcome, hand: p.champion, raw: p.previous }))
  // v4.7.2：未分歧的影子跟随臂与 leader 逐字节同一条轨迹、复用的 raw 已在原计划入账 ⇒ 都不是新的效度观测（否则同一条轨迹记两次）
  const validity = typed.filter((r) => Number.isFinite(r.proxyScore ?? r.structural) && !(r.shadow && r.shadow.divergedAt == null) && !r.reusedFrom && !r.extended).map((r) => { const o = episodeOutcome(r); return { schema: 'cfb.validity-pair/1', at: now, source: 'ceiling', task: r.task, arm: r.arm, sample: r.sample ?? 0, proxy: r.proxyScore ?? r.structural, outcome: o.solved ? 1 : 0, roundsToFix: o.roundsToFix } })
  const families = new Set(cmp.pairs.map((p) => String(p.task).split(':')[0])).size
  const verdict = cmp.pairs.length < 4 || families < 2 ? 'insufficient' : cmp.e >= 1 / alpha ? 'hand-better' : cmp.eReject >= 1 / alpha ? 'hand-worse' : 'undetermined'
  const headroom = cmp.champion.solved != null && cmp.previous.solved != null ? +(cmp.champion.solved - cmp.previous.solved).toFixed(3) : null
  return { schema: 'cfb.ceiling/1', at: now, map, cmp, perGroup, gate, validity, verdict, headroom, families,
    note: 'hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出' }
}

// ── 金标注册表 ──────────────────────────────────────────────────────────────
export const goldDigest = (g) => evidenceDigest({ raw: g.raw, ctx: g.ctx, draft: g.draft }).slice(0, 16)
/** 从一个轨迹单元提取金标候选：
 *  - 默认：hand 臂过闸的手写稿 + 原文 / ctx（pending/done）+ L2 结局；
 *  - fromWinners=true：同时提取非 raw/hand 的胜出压缩臂（轨迹修好、且比同组 raw 更快修好或 raw 未修好）在分歧轮过生产闸 + G2 闸的真实压缩稿，解决金标饥饿。 */
export function goldItemsFromTraj({ home, rows, planId = null, split = {}, fromWinners = false }) {
  const live = liveRows(rows)
  const groups = {}
  for (const r of live) (groups[`${r.task}#${r.sample ?? 0}`] = groups[`${r.task}#${r.sample ?? 0}`] || {})[r.variant] = r
  const items = []
  const vsRawOf = (o, ro) => !ro ? null : o.solved && !ro.solved ? 'win' : !o.solved && ro.solved ? 'loss' : o.solved && ro.solved ? ((o.roundsToFix || 0) < (ro.roundsToFix || 0) ? 'win' : (o.roundsToFix || 0) > (ro.roundsToFix || 0) ? 'loss' : o.verifiedAfterFix !== ro.verifiedAfterFix ? (o.verifiedAfterFix ? 'win' : 'loss') : o.cleanFinish !== ro.cleanFinish ? (o.cleanFinish ? 'win' : 'loss') : 'tie') : 'tie'
  for (const r of live.filter((x) => x.variant === 'hand')) {
    const rawRow = (groups[`${r.task}#${r.sample ?? 0}`] || {}).raw || null
    const o = episodeOutcome(r), ro = rawRow ? episodeOutcome(rawRow) : null
    const vsRaw = vsRawOf(o, ro)
    ;(r.compile || []).forEach((c, i) => {
      if (c.path !== 'hand') return
      const round = i + 1, id = `${safeId(r.task)}-s${r.sample ?? 0}-r${round}`
      const pend = home ? readJsonMaybe(path.join(home, 'pending', 'done', id + '.json')) : null, draftFile = home ? path.join(home, 'drafts', id + '.md') : null
      if (!pend || !draftFile || !fs.existsSync(draftFile)) { items.push({ id, missing: true, why: !pend ? 'pending/done 缺' : 'drafts 缺' }); return }
      const family = String(r.task).split(':')[0]
      const draft = fs.readFileSync(draftFile, 'utf8').trim()
      const stored = ((r.transcript || [])[round - 1] || {}).stored || null
      const item = { schema: 'cfb.gold/1', id, family, task: r.task, sample: r.sample ?? 0, round, plan: planId, split: split[family] || 'unassigned', at: pend.at || null,
        raw: pend.raw, ctx: pend.ctx, calls: pend.calls || [], draft, stored,
        gates: { v4: c.gate || null, accept: c.accept || null, draftChars: c.draftChars, outChars: c.outChars, rawChars: c.rawChars },
        outcome: { solved: !!o.solved, roundsToFix: o.roundsToFix || null, falseClaim: !!o.falseClaim, rawSolved: ro ? !!ro.solved : null, rawRoundsToFix: ro ? ro.roundsToFix || null : null, vsRaw },
        validated: !!o.solved }
      item.qualityAudit = auditMode1Gold(item, { reviewer: 'mode1-output-lint/1' })
      items.push(item)
    })
  }
  if (fromWinners) {
    for (const r of live.filter((x) => x.variant !== 'raw' && x.variant !== 'hand')) {
      const rawRow = (groups[`${r.task}#${r.sample ?? 0}`] || {}).raw || null
      const o = episodeOutcome(r), ro = rawRow ? episodeOutcome(rawRow) : null
      const vsRaw = vsRawOf(o, ro)
      if (!o.solved || (ro && vsRaw !== 'win')) continue
      ;(r.compile || []).forEach((c, i) => {
        if (!c || !c.ok || c.belowFloor) return
        const round = i + 1
        if (o.roundsToFix && round >= o.roundsToFix) return
        const t = ((r.transcript || [])[i]) || {}
        const rawT = ((rawRow?.transcript || [])[i]) || {}
        const rawText = t.reasoning || rawT.reasoning || ''
        const storedText = t.stored || ''
        const ctxText = t.ctx || rawT.ctx || ''
        if (!rawText || !storedText || storedText === rawText) return
        const cont = (ctxText.match(/^【延续段】[^\n]*\n([^\n]+)/m) || [])[1]?.trim() || ''
        const draftText = cont && storedText.startsWith(cont) ? storedText.slice(cont.length).trim() : storedText.trim()
        const g2 = handDraftGate(rawText, draftText, ctxText)
        const id = `${safeId(r.task)}-s${r.sample ?? 0}-r${round}-${safeId(r.policy || r.variant)}`
        if (!g2.ok) { items.push({ id, missing: true, why: 'G2:' + g2.violations.map((v) => v.kind).join(',') }); return }
        const family = String(r.task).split(':')[0]
        const item = { schema: 'cfb.gold/1', id, family, task: r.task, sample: r.sample ?? 0, round, plan: planId, source: 'winner-traj', policy: r.policy || r.variant, split: split[family] || 'unassigned', at: r.at || new Date().toISOString(),
          raw: rawText, ctx: ctxText, calls: t.calls || [], draft: draftText, stored: storedText,
          gates: { v4: c.gate || null, accept: c.accept || null, draftChars: draftText.length, outChars: storedText.length, rawChars: rawText.length },
          outcome: { solved: true, roundsToFix: o.roundsToFix || null, falseClaim: !!o.falseClaim, rawSolved: ro ? !!ro.solved : null, rawRoundsToFix: ro ? ro.roundsToFix || null : null, vsRaw: vsRaw || 'win' },
          validated: true }
        item.qualityAudit = auditMode1Gold(item, { reviewer: 'mode1-output-lint/1' })
        items.push(item)
      })
    }
  }
  return items
}
export function loadGold(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const fam of fs.readdirSync(dir)) {
    const fd = path.join(dir, fam)
    if (!fs.statSync(fd).isDirectory()) continue
    for (const f of fs.readdirSync(fd)) if (f.endsWith('.json')) {
      const g = readJsonMaybe(path.join(fd, f))
      if (!g || g.schema !== 'cfb.gold/1') continue
      const computed = auditMode1Gold(g)
      const recorded = g.qualityAudit
      const recordMatches = recorded?.schema === computed.schema && recorded?.textSha256 === computed.textSha256
      const qualityAudit = recordMatches
        ? { ...computed, ...recorded, issues: computed.issues }
        : { ...computed, ...(recorded ? { recordedAuditStatus: recorded.status, recordedAuditMismatch: true } : {}) }
      out.push({ ...g, qualityAudit, file: path.join(fd, f), digest: goldDigest(g) })
    }
  }
  return out.sort((a, b) => (a.family + a.id).localeCompare(b.family + b.id))
}
/** 落盘：<dir>/<family>/<id>.json；不覆盖已存在金标。疑似装置话术永不入 active registry，可选归档到 rejectedDir。 */
export function saveGold(dir, items, { includeUnsolved = false, rejectedDir = null, auditReviewer = 'mode1-output-lint/1' } = {}) {
  const added = [], skipped = [], quarantined = []
  for (const g of items) {
    if (g.missing) { skipped.push({ id: g.id, why: g.why }); continue }
    if (!g.validated && !includeUnsolved) { skipped.push({ id: g.id, why: '主模型读后未修好（--include-unsolved 才收）' }); continue }
    const qualityAudit = auditMode1Gold(g, { reviewer: auditReviewer })
    if (qualityAudit.status !== 'clean') {
      const archived = { ...g, qualityAudit, quarantine: { reason: 'mode1-apparatus-language', at: new Date().toISOString(), source: 'tools/helpers/three-mode.mjs::saveGold' }, digest: goldDigest(g) }
      let archiveFile = null
      if (rejectedDir) {
        fs.mkdirSync(rejectedDir, { recursive: true })
        const base = path.join(rejectedDir, g.id + '.json')
        archiveFile = fs.existsSync(base) ? path.join(rejectedDir, `${g.id}-${safeId(g.plan || Date.now())}.json`) : base
        fs.writeFileSync(archiveFile, JSON.stringify({ ...archived, archiveFile: path.relative(path.dirname(rejectedDir), archiveFile) }, null, 2) + '\n')
      }
      quarantined.push({ id: g.id, categories: [...new Set(qualityAudit.issues.map((x) => x.category))], file: archiveFile })
      skipped.push({ id: g.id, why: '装置话术检查未通过；已隔离，不进入金标注册表' })
      continue
    }
    const file = path.join(dir, g.family, g.id + '.json')
    if (fs.existsSync(file)) { skipped.push({ id: g.id, why: '已存在' }); continue }
    const saved = { ...g, qualityAudit, digest: goldDigest(g) }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
    added.push(g.id)
  }
  return { added, skipped, quarantined }
}

// ── 模式 2：压缩器基准 ──────────────────────────────────────────────────────
/** v4.7 因子设计（DOE）：一个候选策略的 k ≤ 3 条补丁各当一个二水平因子。
 *  掩码 m 的第 j 位 = 第 j 条补丁开/关；half（k=3）取「偶宇称」那一半 2^(3−1)：000 011 101 110 —— 含 base、不含全开，主效应与另两条补丁的交互混叠（分辨率 III，靠稀疏效应假设）；
 *  full = 2^k 全部。为什么不是一次改一条（OFAT）：同样 4 次运行，OFAT 每个效应只有 1 对（on vs base），因子设计每个效应用全部 4 次运行估计 ⇒ 同成本精度翻倍、且 base 行可与别的基准复用。 */
export function factorialMasks(k, kind = 'half') {
  if (!(Number.isInteger(k) && k >= 1 && k <= 3)) throw new Error('factorial-k:' + k + '（补丁数需 1–3）')
  if (!['half', 'full'].includes(kind)) throw new Error('factorial-kind:' + kind)
  const full = Array.from({ length: 1 << k }, (_, m) => m)
  if (kind === 'full' || k < 3) return full
  return full.filter((m) => (m.toString(2).split('1').length - 1) % 2 === 0)
}
export const maskBits = (m, k) => m.toString(2).padStart(k, '0')
/** 由候选策略派生因子臂（不含 base=全关；全开就是候选自己）。 */
export function derivePolicies(policy, kind = 'half') {
  const patches = policy.patches || []; const k = patches.length
  const masks = factorialMasks(k, kind)
  return { k, kind, masks, arms: masks.map((m) => {
    if (m === 0) return { id: 'base', mask: m }
    if (m === (1 << k) - 1) return { id: policy.id, mask: m }
    const sub = patches.filter((_, j) => m & (1 << j))
    return { id: `${policy.id}.f${maskBits(m, k)}`, mask: m, policy: { schema: policy.schema || 'cfb.policy/1', id: `${policy.id}.f${maskBits(m, k)}`, parent: policy.id, base: policy.base, patches: sub, status: 'derived', derivedFrom: { policy: policy.id, mask: maskBits(m, k), kind, k }, rationale: `因子设计臂：${policy.id} 的补丁 ${[...patches.keys()].filter((j) => m & (1 << j)).map((j) => j + 1).join('+')}（归因用，可独立成候选）` } }
  }) }
}
/** 主效应：对每个金标，开着第 j 条补丁的运行均分 − 关着的均分 ⇒ 按金标配对（符号 ⇒ 胜负 ⇒ e 值）。只用 dev 项。 */
export function factorialEffects(rows, factorial, { alpha = DEFAULT_DESIGN_V4.alphaHoldout } = {}) {
  const maskOf = Object.fromEntries(factorial.arms.map((a) => [a.id, a.mask]))
  const live = rows.filter((r) => r && r.distance && r.split === 'dev' && maskOf[r.policy] != null)
  const golds = [...new Set(live.map((r) => r.gold))]
  const effects = []
  for (let j = 0; j < factorial.k; j++) {
    const per = []
    for (const g of golds) {
      const on = live.filter((r) => r.gold === g && (maskOf[r.policy] & (1 << j))), off = live.filter((r) => r.gold === g && !(maskOf[r.policy] & (1 << j)))
      if (!on.length || !off.length) continue
      const m = (xs, f) => xs.reduce((a, r) => a + f(r), 0) / xs.length
      per.push({ gold: g, family: on[0].family, dScore: +(m(on, (r) => r.distance.score) - m(off, (r) => r.distance.score)).toFixed(3), dDecision: +(m(on, (r) => r.distance.decision ?? 0) - m(off, (r) => r.distance.decision ?? 0)).toFixed(3) })
    }
    const w = per.filter((x) => x.dScore > 0).length, l = per.filter((x) => x.dScore < 0).length
    const fams = new Set(per.filter((x) => x.dScore !== 0).map((x) => x.family)).size
    const e = +eValueWins(w, l).toFixed(3), eReject = +eValueWins(l, w).toFixed(3)
    effects.push({ patch: j + 1, n: per.length, meanDScore: per.length ? +(per.reduce((a, x) => a + x.dScore, 0) / per.length).toFixed(3) : null, meanDDecision: per.length ? +(per.reduce((a, x) => a + x.dDecision, 0) / per.length).toFixed(3) : null, wins: w, losses: l, ties: per.length - w - l, families: fams, e, eReject,
      verdict: e >= 1 / alpha && fams >= 2 ? 'keep' : eReject >= 1 / alpha ? 'drop' : 'undetermined', aliased: factorial.kind === 'half' && factorial.k === 3 ? '与另两条补丁的交互混叠（分辨率 III）' : null })
  }
  const keep = effects.filter((x) => x.verdict === 'keep').map((x) => x.patch), drop = effects.filter((x) => x.verdict === 'drop').map((x) => x.patch)
  return { of: factorial.of, kind: factorial.kind, k: factorial.k, runs: factorial.arms.length, golds: golds.length, effects, keep, drop,
    keepId: keep.length && keep.length < factorial.k ? `${factorial.of}.f${Array.from({ length: factorial.k }, (_, j) => keep.includes(j + 1) ? '1' : '0').reverse().join('')}` : null,
    next: keep.length && keep.length < factorial.k ? `只保留补丁 ${keep.join('+')}（派生策略 ${factorial.of}.f${Array.from({ length: factorial.k }, (_, j) => keep.includes(j + 1) ? '1' : '0').reverse().join('')}，bench-report 已落盘）进模式 3；补丁 ${effects.filter((x) => x.verdict !== 'keep').map((x) => x.patch).join('、')} 不带` : keep.length === factorial.k ? `三条补丁都有效 ⇒ 候选 ${factorial.of} 整体进模式 3` : drop.length ? `补丁 ${drop.join('、')} 有害 ⇒ 去掉后重提` : '主效应都未判定 ⇒ 多加 dev 金标再跑同一设计（不要换补丁）' }
}

export function buildBenchPlan({ n, policies = ['base'], gold, split = 'dev', pricing, purpose = null, planRel, homeRel, now = new Date().toISOString(), factorial = null }) {
  const items = gold.filter((g) => !g.missing && g.validated && g.qualityAudit?.status === 'clean' && isMode1GoldEligible(g) && (split === 'all' || g.split === split))
  if (!items.length) throw new Error(`no-gold:${split}（注册表里没有可用金标；先跑模式 1：plan-traj --arms raw,hand → traj-run → ceiling → gold add）`)
  if (!policies.includes('base')) throw new Error('bench-needs-base（基准必须含 base：候选只按「对 base 的配对胜负」选，不看绝对分）')
  const calls = policies.length * items.length
  const plan = { schema: 'cfb.bench-plan/1', id: 'b' + n, at: now, policies, split, metric: DRAFT_DISTANCE_VERSION,
    gold: items.map((g) => ({ id: g.id, family: g.family, split: g.split, digest: g.digest || goldDigest(g) })),
    cost: { calls, expectedUsd: +(calls * pricing.compressUsd).toFixed(3), capUsd: +(calls * pricing.compressCapUsd).toFixed(3), pricing: { compressUsd: pricing.compressUsd, compressCapUsd: pricing.compressCapUsd } },
    ...(factorial ? { factorial } : {}),
    purpose: purpose || `模式 2：压缩器（生产 birthOffline 同构体，关思考、temperature 0）在金标原文上出稿，与手写金标按 ${DRAFT_DISTANCE_VERSION} 比对；量的是 g(稿 | 策略, 原文) 到手写标准的召回，不量结局`,
    selection: 'dev 项：每个金标上候选 vs base 按层级键配对 → e 值（≥2 家族、e ≥ 阈 ⇒ promote）；holdout 项只报告，不参与选择；promote 的策略进 plan-traj（模式 3）验收，基准分本身不采纳 champion' }
  plan.design = evidenceDigest({ policies, metric: plan.metric, split, gold: plan.gold.map((g) => g.id + ':' + g.digest) }).slice(0, 16)
  plan.digest = evidenceDigest(plan).slice(0, 16)
  plan.command = `node tools/bench-run.mjs --plan ${planRel} --base-url <url> --model deepseek-v4.1-flash --out ${homeRel}`
  return plan
}
const KEYS = ['decision', 'excludedRecall', 'acceptOk', 'openRecall', 'anchorPrecision', 'lengthOk']
/** 基准报告：每策略 × 切分的均值与判词分布；dev 项候选 vs base 的配对 e 值；holdout 只报告。best = promote 里 e 最大者。 */
export function benchReport(rows, { baseline = 'base', alpha = DEFAULT_DESIGN_V4.alphaHoldout, factorial = null } = {}) {
  const live = (rows || []).filter((r) => r && r.policy && r.distance && r.gold)
  const policies = [...new Set(live.map((r) => r.policy))]
  const table = []
  for (const p of policies) for (const s of ['dev', 'holdout']) {
    const rs = live.filter((r) => r.policy === p && r.split === s); if (!rs.length) continue
    const row = { policy: p, split: s, n: rs.length, score: mean(rs.map((r) => r.distance.score)), gateFail: rs.filter((r) => !r.ok).length, verdicts: {} }
    for (const k of KEYS) row[k] = mean(rs.map((r) => r.distance[k]).filter((x) => x != null))
    for (const r of rs) row.verdicts[r.distance.verdict] = (row.verdicts[r.distance.verdict] || 0) + 1
    table.push(row)
  }
  const paired = {}
  for (const p of policies.filter((x) => x !== baseline)) {
    const outcomes = []
    for (const r of live.filter((x) => x.policy === p && x.split === 'dev')) { const b = live.find((x) => x.policy === baseline && x.gold === r.gold); if (!b) continue; const c = compareKeys(r.distance.key, b.distance.key); outcomes.push({ gold: r.gold, family: r.family, outcome: c > 0 ? 'win' : c < 0 ? 'loss' : 'tie' }) }
    const w = outcomes.filter((o) => o.outcome === 'win').length, l = outcomes.filter((o) => o.outcome === 'loss').length
    const e = +eValueWins(w, l).toFixed(3), eReject = +eValueWins(l, w).toFixed(3), families = new Set(outcomes.filter((o) => o.outcome !== 'tie').map((o) => o.family)).size
    const dev = table.find((t) => t.policy === p && t.split === 'dev'), ho = table.find((t) => t.policy === p && t.split === 'holdout'), bdev = table.find((t) => t.policy === baseline && t.split === 'dev'), bho = table.find((t) => t.policy === baseline && t.split === 'holdout')
    const gap = dev && ho && bdev && bho && dev.score != null && ho.score != null ? +((dev.score - bdev.score) - (ho.score - bho.score)).toFixed(3) : null   // dev 上的提升 − holdout 上的提升：> 0.15 ⇒ 像是在背 dev
    paired[p] = { n: outcomes.length, wins: w, losses: l, ties: outcomes.length - w - l, e, eReject, families, generalizationGap: gap, outcomes,
      decision: e >= 1 / alpha && families >= 2 ? (gap != null && gap > 0.15 ? 'promote-but-overfit?' : 'promote') : eReject >= 1 / alpha ? 'drop' : 'undetermined' }
  }
  const promoted = Object.entries(paired).filter(([, v]) => v.decision.startsWith('promote')).sort((a, b) => b[1].e - a[1].e)
  const best = promoted.length ? promoted[0][0] : null
  const fx = factorial ? factorialEffects(rows, factorial, { alpha }) : null
  return { schema: 'cfb.bench-report/1', baseline, metric: DRAFT_DISTANCE_VERSION, policies, table, paired, best, threshold: +(1 / alpha).toFixed(1), ...(fx ? { factorial: fx } : {}),
    next: best ? `plan-traj --arms raw,policy:${best}（模式 3 验收：基准分不采纳，只决定谁进轨迹）` : '没有策略在 dev 金标上显著优于 base：改策略（propose-policy）或先补金标（模式 1）' }
}
export function benchReportMd(rep, { title = '基准报告' } = {}) {
  const L = [`# ${title}（${rep.metric}；基线 ${rep.baseline}；零 API）`, '', '| 策略 | 切分 | n | 分 | 决定 | 排除召回 | 验收 | 未解召回 | 锚点精度 | 长度 | 闸失败 | 判词 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const t of rep.table) L.push(`| ${t.policy} | ${t.split} | ${t.n} | ${t.score ?? '—'} | ${t.decision ?? '—'} | ${t.excludedRecall ?? '—'} | ${t.acceptOk ?? '—'} | ${t.openRecall ?? '—'} | ${t.anchorPrecision ?? '—'} | ${t.lengthOk ?? '—'} | ${t.gateFail} | ${Object.entries(t.verdicts).map(([k, v]) => `${k}×${v}`).join(' ')} |`)
  L.push('', '配对（dev 金标上候选 vs base，层级键：决定 → 排除召回 → 验收 → 未解召回 → 锚点精度 → 长度）：')
  for (const [p, v] of Object.entries(rep.paired)) L.push(`- ${p}: ${v.wins}胜 ${v.losses}负 ${v.ties}平（${v.families} 家族）e=${v.e} 「更差」e=${v.eReject} 阈 ${rep.threshold}；泛化差 ${v.generalizationGap ?? '—'} ⇒ **${v.decision}**`)
  if (!Object.keys(rep.paired).length) L.push('- （只有 base：没有候选可配对）')
  if (rep.factorial) {
    const fx = rep.factorial
    L.push('', `主效应（因子设计 ${fx.kind} 2^${fx.k}${fx.kind === 'half' && fx.k === 3 ? '−1' : ''}，候选 ${fx.of} 的 ${fx.k} 条补丁各为一个因子；${fx.runs} 个臂 × dev 金标 ${fx.golds}；每个效应用全部臂估计、按金标配对）：`)
    for (const e of fx.effects) L.push(`- 补丁 ${e.patch}: Δ分 ${e.meanDScore ?? '—'}（Δ决定 ${e.meanDDecision ?? '—'}）${e.wins}胜 ${e.losses}负 ${e.ties}平（${e.families} 家族）e=${e.e} 「有害」e=${e.eReject} ⇒ **${e.verdict}**${e.aliased ? '；' + e.aliased : ''}`)
    L.push(`- 归因结论: ${fx.next}`)
  }
  L.push('', `下一步: ${rep.next}`, '', '读法：锚点精度 < 1 = 稿里有原文 / ctx 没有的标识符（发明或照抄样例）—— 这一项先于一切；分（score）只给人看，选稿看键。holdout 行只报告，不进选择。')
  return L.join('\n')
}

// ── 飞轮偏好对自动提取（Mode 2 基准 & Mode 3 轨迹 → pairs.jsonl） ──────────────
/** 从 Mode 3 轨迹结果提取压缩稿偏好对：同组两臂结局分出胜负（修好 vs 未修好，或到修好轮数更少），且在修好前同一轮次两臂有不同压缩稿（或胜出压缩稿 vs 失败压缩稿）。 */
export function flywheelPairsFromTraj(rows, { split = {}, source = 'traj', roundNum = 0, now = new Date().toISOString() } = {}) {
  const live = liveRows(rows)
  const groups = {}
  for (const r of live) {
    const k = `${r.task}#${r.sample ?? 0}`
    const arm = r.policy ? 'policy:' + r.policy : r.variant
    ;(groups[k] = groups[k] || {})[arm] = r
  }
  const out = []
  const rankArm = (o) => (o.solved ? 100 - (o.roundsToFix || 10) : (o.falseClaim ? -10 : 0))
  for (const g of Object.values(groups)) {
    const arms = Object.keys(g)
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const a = g[arms[i]], b = g[arms[j]]
      const oa = episodeOutcome(a), ob = episodeOutcome(b)
      const sa = rankArm(oa), sb = rankArm(ob)
      if (sa === sb) continue
      const win = sa > sb ? a : b, lose = sa > sb ? b : a
      const winArm = sa > sb ? arms[i] : arms[j], loseArm = sa > sb ? arms[j] : arms[i]
      const maxR = Math.min((win.transcript || []).length, (lose.transcript || []).length)
      for (let rIdx = 0; rIdx < maxR; rIdx++) {
        const tw = win.transcript[rIdx], tl = lose.transcript[rIdx]
        if (!tw || !tl) continue
        const cw = (win.compile || [])[rIdx], cl = (lose.compile || [])[rIdx]
        const wCompressed = !!(cw?.ok || cw?.path === 'hand')
        const lCompressed = !!(cl?.ok || cl?.path === 'hand')
        if (!wCompressed && !lCompressed) continue
        const wDraft = tw.stored || tw.reasoning || null
        const lDraft = tl.stored || tl.reasoning || null
        if (!wDraft || !lDraft || wDraft === lDraft) continue
        if (auditMode1Gold({ draft: wDraft }).status !== 'clean' || auditMode1Gold({ draft: lDraft }).status !== 'clean') continue
        const fam = String(win.task).split(':')[0]
        out.push({
          schema: 'cfb.flywheel-pair/1',
          at: now,
          round: roundNum || rIdx + 1,
          task: fam,
          split: split[fam] || null,
          source,
          chosenArm: winArm,
          rejectedArm: loseArm,
          chosenText: wDraft,
          rejectedText: lDraft,
          contentAudit: auditMode1Pair({ chosenText: wDraft, rejectedText: lDraft }, { reviewer: 'mode1-flywheel-lint/1' }),
          scores: { candidate: Math.max(sa, sb), control: Math.min(sa, sb) },
        })
      }
    }
  }
  return out
}

/** 从 Mode 2 基准结果提取压缩稿偏好对：
 *  ① 同一金标项上两策略按层级键分出胜负（且文本不同）；
 *  ② 金标稿（validated）对比在同题上未达 close（score < 0.85 或死路复活 / 丢排除）的策略稿。 */
export function flywheelPairsFromBench(rows, { gold = [], split = {}, source = 'bench', roundNum = 0, now = new Date().toISOString() } = {}) {
  const live = (rows || []).filter((r) => r && !r.dry && r.policy && r.distance && r.gold && typeof r.text === 'string' && r.text.trim())
  const byGold = {}
  for (const r of live) (byGold[r.gold] = byGold[r.gold] || []).push(r)
  const goldMap = Object.fromEntries((gold || []).map((g) => [g.id, g]))
  const out = []
  for (const [gid, rs] of Object.entries(byGold)) {
    const g = goldMap[gid]
    if (g && !isMode1GoldEligible(g)) continue
    const fam = rs[0]?.family || g?.family || String(gid).split('-s')[0]
    const sp = rs[0]?.split || g?.split || split[fam] || null
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j]
      if (a.text === b.text) continue
      const c = compareKeys(a.distance.key, b.distance.key)
      if (c === 0) continue
      const win = c > 0 ? a : b, lose = c > 0 ? b : a
      if (!win.ok || auditMode1Gold({ draft: win.text }).status !== 'clean' || auditMode1Gold({ draft: lose.text }).status !== 'clean') continue
      out.push({
        schema: 'cfb.flywheel-pair/1',
        at: now,
        round: roundNum,
        task: fam,
        gold: gid,
        split: sp,
        source,
        chosenArm: 'policy:' + win.policy,
        rejectedArm: 'policy:' + lose.policy,
        chosenText: win.text,
        rejectedText: lose.text,
        contentAudit: auditMode1Pair({ chosenText: win.text, rejectedText: lose.text }, { reviewer: 'mode1-flywheel-lint/1' }),
        scores: { candidate: +(win.distance.score ?? 1), control: +(lose.distance.score ?? 0) },
      })
    }
    if (g && g.validated && g.draft) {
      for (const r of rs) {
        if (r.text === g.draft || (r.ok && r.distance.verdict === 'close' && (r.distance.score ?? 0) >= 0.95)) continue
        out.push({
          schema: 'cfb.flywheel-pair/1',
          at: now,
          round: roundNum,
          task: fam,
          gold: gid,
          split: sp,
          source: source + ':gold-vs-policy',
          chosenArm: 'gold:' + gid,
          rejectedArm: 'policy:' + r.policy,
          chosenText: g.draft,
          rejectedText: r.text,
          contentAudit: auditMode1Pair({ chosenText: g.draft, rejectedText: r.text }, { reviewer: 'mode1-flywheel-lint/1' }),
          scores: { candidate: 1, control: +(r.distance.score ?? 0) },
        })
      }
    }
  }
  return out
}

