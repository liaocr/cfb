// test/closed-loop.selftest.mjs —— 闭环 v2（v14.2；v14.3 起 F1/F2 按 v3 语义：留出闸门、首轮 A/A）自测：候选生成器 / 真值维度 / 实验经济学 / v9 计划与预算 / 编排器端到端（零 API）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as I from '../index.js'
import { KNOBS, BASELINE_KNOBS, LEVER_ORDER, loadFrozenTasks, generateCandidates, armSummary, renderCandidate, splitSentences, stripHints, stripClosing, deadEndTransform, selectionTransform, layoutTransform, lengthEnvelope, productionGate } from '../tools/helpers/candidates.mjs'
import { TRUTH_DIMENSIONS, truthDimensions, truthComposite, truthDelta, locusHit, nextDerivable, deadEndsCarried, keyFactsCarried, avoidLeak, claimRisk, negatedAt, strongTokens } from '../tools/helpers/truth-dims.mjs'
import { DIMENSIONS, DIMS_BY_RATER, LOWER_IS_BETTER, normalizeDims, judgeCapacity, CODE_WEIGHTS } from '../tools/helpers/judge-layer.mjs'
import { betaCdf, betaTail, sequentialPaired, expectedBitsNextPair, bitsBought, pairsToDecide, structuralScore, pairOutcome, pairResults, costEstimate, usdPerBit, roughTokens, DEFAULT_DESIGN } from '../tools/helpers/experiment.mjs'
import { buildCandidateReplayPlanV9, summarizeMinimal, resultOf } from '../tools/helpers/eval-plan.mjs'
import { auditApiPlan, planVersion, planScope, APPROVED_API_LIMITS_V9, V9_TASK_IDS } from '../tools/helpers/api-budget.mjs'
import { API_APPROVAL_SCOPES_V9, KNOWN_API_SCOPES } from '../tools/helpers/api-watermark.mjs'
import { prepareEvaluation, reportEvaluation, DEFAULT_HOME_V9, PUBLIC_RECEIPT_V9 } from '../tools/helpers/eval-workflow.mjs'
import { readyMain } from '../tools/effect-ready.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name); console.log(e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e) } }
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 4, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-10-02' }
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
const THREE_Q_RE = /能说修好要三件事|收工三问|三件事都在手/

const tasks = loadFrozenTasks()
const cands = generateCandidates(tasks)
const byArm = (arm) => cands.filter((c) => c.arm === arm)

try {
  // ── A. 候选生成器：生产等价、过闸、退化可见 ─────────────────────────────────
  test('A1 冻结任务 5 题，control = 生产重编译且全部过生产闸门', () => {
    assert.equal(tasks.length, 5)
    const ctrl = byArm('control')
    assert.equal(ctrl.length, 5)
    for (const c of ctrl) { assert.ok(c.ok && c.feasible, c.id); assert.equal(c.gate.invented.length, 0); assert.ok(c.chars <= lengthEnvelope(tasks.find((t) => t.id === c.task).ctx)) }
    // 与 eval-plan 冻结 r2 同口径：同一 compileV4Direct 路径 ⇒ 与 auto-d2d 当年成稿字数同量级（不是原稿前缀）
    assert.ok(ctrl.every((c) => c.chars > 1500 && c.chars < 3500), ctrl.map((c) => c.chars).join(','))
  })
  test('A2 每个变体要么与 control 逐字不同、要么标 degenerate（不再有「同一前缀冒充 9 个候选」）', () => {
    for (const c of cands.filter((x) => !x.isControl)) {
      const ctrl = cands.find((x) => x.task === c.task && x.isControl)
      assert.equal(c.degenerate, c.text === ctrl.text, c.id)
      if (c.degenerate) assert.ok(typeof c.degenerateWhy === 'string' && c.degenerateWhy.length, c.id + ' 退化必须给原因')
    }
    const sum = armSummary(cands)
    const usable = sum.filter((a) => a.lever && a.usable >= 3)
    assert.ok(usable.length >= 4, '至少 4 个杠杆取值在 ≥3 题上可用：' + JSON.stringify(sum.map((a) => a.arm + ':' + a.usable)))
    const texts = new Set(cands.filter((c) => c.task === 'flaky-timeout' && c.feasible && !c.degenerate).map((c) => c.text))
    assert.ok(texts.size >= 5, 'flaky 至少 5 份互不相同的可行稿，实际 ' + texts.size)
  })
  test('A3 真实长度回归：变体永不超过生产包络、永不含发明标识符；bind 在已自闭合的 r2 稿上退化 5/5 被如实标出', () => {
    for (const c of cands.filter((x) => x.ok)) { assert.ok(c.chars <= c.gate.maxChars, c.id); if (c.feasible) assert.equal(c.gate.invented.length, 0, c.id) }
    const bind = armSummary(cands).find((a) => a.arm === 'bind=off')
    assert.equal(bind.degenerate, bind.tasks, 'bindFixBranches 在自闭合三元组稿上不动文本——必须标退化而不是当成候选')
  })
  test('A4 变换语义：kItems=off 剥光提示、closing=off 无三问、deadEnd=none 无已排除、shelved 改标签不删事实', () => {
    for (const t of tasks) {
      const ctrl = cands.find((c) => c.task === t.id && c.isControl).text
      const hints = I.verifyHints(t.ctx)
      const off = stripHints(ctrl, t.ctx)
      for (const h of hints) assert.ok(!off.includes(h.slice(0, 24)), t.id + ' 提示未剥净')
      assert.ok(!THREE_Q_RE.test(stripClosing(ctrl, t.ctx)), t.id + ' 三问未剥净')
      assert.ok(!/已排除[：:]/.test(deadEndTransform(ctrl, 'none')), t.id)
      if (/已排除[：:]/.test(ctrl)) {
        const sh = deadEndTransform(ctrl, 'shelved')
        assert.ok(sh.includes('已搁置（未取证，不作为结论）：') && !/已排除[：:]/.test(sh), t.id)
        assert.ok(sh.length >= ctrl.length, '改标签不删事实')
      }
    }
  })
  test('A5 分句不切反引号内的 ? / 。（v12.8.8 的教训），取舍永不删受保护句', () => {
    const s = splitSentences('第一句。代码 `done ? "stop" : null` 不切。第三句？')
    assert.deepEqual(s.map((x) => x.trim()), ['第一句。', '代码 `done ? "stop" : null` 不切。', '第三句？'])
    const t = tasks[0], ctrl = cands.find((c) => c.task === t.id && c.isControl).text
    const strict = selectionTransform(ctrl, t.ctx, 'strict')
    for (const d of strict.dropped) assert.ok(!d.protectedSentence && !/`|old_text|new_text/.test(d.sentence))
    assert.ok(strict.text.includes('old_text'), '三元组必须保留')
    const lay = layoutTransform(ctrl, 'conclusion-first')
    assert.ok(lay.length >= ctrl.length - 4 && lay.length <= ctrl.length + 4, '版面变换只移动不增删')
  })
  test('A6 杠杆表：每个旋钮都说清生产对应物；没有「长度」杠杆（红线：不把稿子压更短）', () => {
    for (const [k, v] of Object.entries(KNOBS)) { assert.ok(['config', 'program', 'transform'].includes(v.kind), k); assert.ok(v.theory && v.values.length >= 2, k); assert.ok(BASELINE_KNOBS[k] && v.values.includes(BASELINE_KNOBS[k]), k) }
    assert.ok(!KNOBS.length && !LEVER_ORDER.includes('length'))
    assert.equal(KNOBS.bind.production, 'compressV4DirectBind')
    const gate = productionGate(tasks[0], 'x'.repeat(lengthEnvelope(tasks[0].ctx) + 1))
    assert.equal(gate.ok, false)
  })

  // ── B. 真值维度 ──────────────────────────────────────────────────────────────
  const chain = { a2Edit: { path: 'verify.mjs', old_text: 'const env = { ...process.env, DSH_HOME: tmp }', new_text: 'const env = { ...process.env, DSH_HOME: tmp, CFB_REAL_DSH_HOME: tmp }' } }
  const spec = { obs: { red: { next: ['spawn|exec\\b|env[^\\n]{0,30}(传|子进程)', 'read_file[^\\n]*verify\\.mjs'], avoid: ['chown|sudo|rm\\s+[^\\n]*trace\\.log|已修复'], reference: { keyFacts: ['edit 已落地（1 处替换）', '上一轮已写明：若 verify.mjs 设了变量仍失败，问题在 env 没传给子进程'], deadEnds: ['再跑同样的 grep -R CFB_REAL_DSH_HOME', 'chown / sudo / rm', '回滚刚才的改动'] } } } }
  test('B1 locusHit / nextDerivable / keyFactsCarried 按定义计分', () => {
    assert.equal(locusHit('没有任何落点', chain), 0)
    assert.equal(locusHit('改 verify.mjs 的某行', chain), 0.5)
    assert.equal(locusHit('edit_file verify.mjs，old_text 是 `const env = { ...process.env, DSH_HOME: tmp }`', chain), 1)
    assert.equal(nextDerivable('若仍是 EACCES：read_file verify.mjs 看 env 是否传给子进程', spec), 1)
    assert.equal(nextDerivable('若仍失败就再试一次', spec), 0)
    assert.equal(keyFactsCarried('上一轮写明若 verify.mjs 设了变量仍失败，问题在 env 没传给子进程', spec), 0.5)
    assert.equal(nextDerivable('x', { obs: { red: {} } }), null, '缺参考给 null，不猜')
  })
  test('B2 死路带过来：否定在前 / 否定在后都算，rm 不匹配 permission，泛词 grep 不算强记号', () => {
    assert.ok(!strongTokens('再跑同样的 grep').includes('grep'))
    assert.equal(deadEndsCarried('不要再 chown；已走过的路：grep -R CFB_REAL_DSH_HOME → 空；这些不再重跑。此时不要回滚。', spec), 1)
    assert.equal(deadEndsCarried('permission denied 的错误在 trace.log。', spec), 0, 'rm 不能匹配 permission')
    assert.equal(deadEndsCarried('直接 chown 一下。', spec), 0, '肯定语境不算带过来')
    assert.ok(negatedAt('不要再 chown', 4, 5) && !negatedAt('直接 chown', 3, 5))
  })
  test('B3 泄漏与宣称：非否定语境的 avoid 命中才算泄漏；本轮自己的 edit 路径豁免；claimRisk fixed/hedged/none', () => {
    assert.equal(avoidLeak('下一步 sudo chown 一下就好。', spec, chain), 1)
    assert.equal(avoidLeak('已排除：直接 sudo chown 不选：治的是症状。', spec, chain), 0)
    const own = { obs: { red: { avoid: ['edit_file[^\\n]*verify\\.mjs'] } } }
    assert.equal(avoidLeak('所以下一步工具调用是 edit_file verify.mjs，old_text 是 `x`。', own, chain), 0, '本轮 edit 记录不是泄漏')
    assert.equal(avoidLeak('然后再 edit_file verify.mjs 改另一处。', own, { a2Edit: { path: 'other.js' } }), 1)
    assert.equal(claimRisk('问题已修复，收工。'), 1)
    assert.equal(claimRisk('改动已执行、未验证，三件都拿到之前是已改未验证。'), 0)
  })
  test('B4 综合与配对差：方向统一（越大越好），lower-is-better 取反；缺维降低 coverage', () => {
    const good = { locusHit: 1, nextDerivable: 1, deadEndsCarried: 1, keyFactsCarried: 1, avoidLeak: 0, claimRisk: 0 }
    const bad = { ...good, avoidLeak: 1, claimRisk: 1 }
    assert.equal(truthComposite(good).score, 1)
    assert.ok(truthComposite(bad).score < truthComposite(good).score)
    const d = truthDelta(bad, good)
    assert.equal(d.avoidLeak, -1); assert.equal(d.claimRisk, -1); assert.ok(d.composite < 0)
    assert.ok(truthComposite({ ...good, locusHit: null }).coverage < 1)
  })
  test('B5 方向校验：五题生产稿的真值综合都高于原文（与 v8 live 效应同向）——离线信号与付费判据同源的证据', () => {
    for (const t of tasks) {
      const ctrl = cands.find((c) => c.task === t.id && c.isControl).text
      const a = truthComposite(truthDimensions(ctrl, t.chain, t.spec)).score, b = truthComposite(truthDimensions(t.chain.a2.raw, t.chain, t.spec)).score
      assert.ok(a > b, `${t.id}: prod ${a} vs raw ${b}`)
    }
  })
  test('B6 判断层登记：真值维度进 DIMENSIONS（code）、方向表、容量单列 codeBits；评委维度不再是选择信号', () => {
    for (const d of TRUTH_DIMENSIONS) { assert.ok(DIMENSIONS.some((x) => x.id === d.id && x.rater === 'code'), d.id); assert.ok(DIMS_BY_RATER.code.includes(d.id)) }
    assert.ok(LOWER_IS_BETTER.includes('avoidLeak') && LOWER_IS_BETTER.includes('claimRisk'))
    assert.equal(normalizeDims({ avoidLeak: 1 }).avoidLeak, 0)
    const cap = judgeCapacity()
    assert.ok(cap.codeBits >= 6 && cap.selectionSignal === 'code')
    assert.ok(Object.keys(CODE_WEIGHTS).every((k) => DIMS_BY_RATER.code.includes(k)))
  })

  // ── C. 实验经济学 ────────────────────────────────────────────────────────────
  test('C1 Beta 数值：cdf / 尾概率 / 分位数', () => {
    assert.ok(Math.abs(betaCdf(0.5, 1, 1) - 0.5) < 1e-9)
    assert.ok(Math.abs(betaCdf(0.5, 3, 1) - 0.125) < 1e-9)
    assert.ok(Math.abs(betaTail(5, 1) - 0.96875) < 1e-9)
    assert.ok(Math.abs(betaTail(1, 5) - 0.03125) < 1e-9)
  })
  test('C2 序贯判定：5 胜采纳、5 负否决、3:2 继续、平局各记半、25 对未判即停；采纳门槛比否决严', () => {
    assert.equal(sequentialPaired(['win', 'win', 'win', 'win', 'win']).decision, 'adopt')
    assert.equal(sequentialPaired(['loss', 'loss', 'loss', 'loss', 'loss']).decision, 'reject')
    assert.equal(sequentialPaired(['win', 'win', 'win', 'loss', 'loss']).decision, 'continue')
    const t = sequentialPaired(['tie', 'tie']); assert.equal(t.alpha, 2); assert.equal(t.beta, 2); assert.equal(t.pWin, 0.5)
    assert.equal(sequentialPaired(Array.from({ length: 25 }, (_, i) => (i % 2 ? 'win' : 'loss'))).decision, 'stop-undecided')
    assert.ok(DEFAULT_DESIGN.adoptAt > 1 - DEFAULT_DESIGN.rejectAt)
    assert.equal(sequentialPaired([]).decision, 'continue')
  })
  test('C3 信息账：先验下一对 ≈0.19 bit，越确定越便宜；bitsBought 单调；运行特性可复现（种子固定）', () => {
    const b0 = expectedBitsNextPair(1, 1), b1 = expectedBitsNextPair(6, 1)
    assert.ok(b0 > 0.15 && b0 < 0.25 && b1 < b0)
    assert.ok(bitsBought(6, 1) > bitsBought(2, 1))
    const a = pairsToDecide({ pTrue: 0.8, sims: 100 }), b = pairsToDecide({ pTrue: 0.8, sims: 100 })
    assert.deepEqual(a, b)
    assert.ok(pairsToDecide({ pTrue: 0.9, sims: 100 }).medianPairs < pairsToDecide({ pTrue: 0.6, sims: 100 }).medianPairs)
  })
  test('C4 配对判据：结构分与 live 规则同源；胜负平；按 task|sample 配对', () => {
    const good = { next: 1, avoid: 1, falseDone: 0, bump: 0, reEdit: 0, repeat: 0 }, bad = { next: 0, avoid: 0, falseDone: 1, bump: 1, reEdit: 1, repeat: 1 }
    assert.equal(structuralScore(good), 2); assert.equal(structuralScore(bad), -4)
    assert.equal(pairOutcome(good, bad), 'win'); assert.equal(pairOutcome(bad, good), 'loss'); assert.equal(pairOutcome(good, good), 'tie')
    const pairs = pairResults([{ task: 'a', variant: 'control', sample: 0, rule: bad, action: 'x' }, { task: 'a', variant: 'candidate', sample: 0, rule: good, action: 'y' }, { task: 'b', variant: 'candidate', sample: 0, rule: good, action: 'y' }])
    assert.equal(pairs.length, 1); assert.equal(pairs[0].outcome, 'win'); assert.equal(pairs[0].task, 'a')
  })
  test('C5 成本：预占 ≥ 预计实付；每 bit 价格可算；中文 token 粗估', () => {
    const pairsIn = tasks.map((t) => ({ task: t.id, control: cands.find((c) => c.task === t.id && c.isControl).text, candidate: byArm('kItems=off').find((c) => c.task === t.id).text }))
    const plan = buildCandidateReplayPlanV9({ candidates: pairsIn, round: 1, hypothesis: { lever: 'kItems', value: 'off', champion: BASELINE_KNOBS }, pricing: PRICING })
    const audit = auditApiPlan(plan)
    const cost = costEstimate({ plan, audit, pricing: PRICING })
    assert.equal(cost.requests, 13); assert.equal(cost.main, 10)
    assert.ok(cost.reservedUsd > cost.expectedUsd && cost.reservedUsd <= 1, JSON.stringify([cost.reservedUsd, cost.expectedUsd]))
    assert.ok(usdPerBit({ alpha: 1, beta: 1, pairs: 5, expectedUsd: cost.expectedUsd }).usdPerBit > 0)
    assert.ok(roughTokens('一二三四五六七八九十') === 6)
  })

  // ── D. v9 计划、scope 与预算闸 ──────────────────────────────────────────────
  const pairsIn = tasks.map((t) => ({ task: t.id, control: cands.find((c) => c.task === t.id && c.isControl).text, candidate: byArm('kItems=off').find((c) => c.task === t.id).text, knobs: { ...BASELINE_KNOBS, kItems: 'off' } }))
  const hyp = { lever: 'kItems', value: 'off', champion: BASELINE_KNOBS, theory: 't', kind: 'program' }
  const plan9 = buildCandidateReplayPlanV9({ candidates: pairsIn, round: 3, hypothesis: hyp, pricing: PRICING })
  test('D1 v9 scope 静态表 20 个、全部在 KNOWN_API_SCOPES；planVersion / planScope 按轮次映射', () => {
    assert.equal(API_APPROVAL_SCOPES_V9.length, 20)
    for (const s of API_APPROVAL_SCOPES_V9) assert.ok(KNOWN_API_SCOPES.includes(s))
    assert.equal(planVersion(plan9), 9); assert.equal(planScope(plan9), API_APPROVAL_SCOPES_V9[2])
    assert.equal(planScope({ ...plan9, round: 21 }), undefined)
    assert.deepEqual(APPROVED_API_LIMITS_V9, { maxRequests: 13, maxUsd: 1, maxMain: 10, maxProbe: 3, retries: 0, judges: 0, networkFailureBudget: 3, sampleFailureBudget: 3 })
  })
  test('D2 v9 计划形状：3 同体探针 + 每题 1 对；两臂去掉 reasoning 后逐字节一致；先后顺序逐题交替；审计通过且 ≤ USD 1', () => {
    assert.equal(plan9.schema, 'cfb.bounded-ab/9'); assert.equal(plan9.jobs.length, 13); assert.deepEqual(plan9.arms, ['control', 'candidate']); assert.deepEqual(plan9.tasks, V9_TASK_IDS)
    const mains = plan9.jobs.filter((j) => j.kind === 'main')
    assert.equal(mains[0].variant, 'control'); assert.equal(mains[2].variant, 'candidate')
    for (const t of plan9.tasks) {
      const [a, b] = ['control', 'candidate'].map((v) => mains.find((j) => j.task === t && j.variant === v))
      const strip = (body) => JSON.stringify({ ...body, messages: body.messages.map(({ reasoning_content, ...m }) => m) })
      assert.equal(strip(a.body), strip(b.body))
      assert.notEqual(JSON.stringify(a.body), JSON.stringify(b.body))
      assert.equal(a.body.max_tokens, 8192)
    }
    const audit = auditApiPlan(plan9)
    assert.equal(audit.main, 10); assert.equal(audit.probe, 3); assert.ok(audit.totalReservedUsd <= 1)
    assert.equal(auditApiPlan(buildCandidateReplayPlanV9({ candidates: pairsIn, round: 1, hypothesis: hyp }), { allowUnpriced: true }).totalReservedUsd, null)
    assert.equal(plan9.preregistration.claimVersion, 3); assert.equal(plan9.preregistration.decisionRule.adoptAt, 0.95)
  })
  test('D3 审计拒绝：轮次越界 / 任务少于 3 / 重复任务 / 未知任务 / 缺假设 / 主请求数不符 / 限额被改 / 超过每轮 USD 1', () => {
    const mut = (o) => ({ ...plan9, ...o })
    assert.throws(() => auditApiPlan(mut({ round: 0 })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ round: 21 })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ tasks: plan9.tasks.slice(0, 2) })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ tasks: [plan9.tasks[0], plan9.tasks[0], plan9.tasks[1]] })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ tasks: [...plan9.tasks.slice(0, 4), 'not-a-task'] })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ hypothesis: null })), /api-plan-schema/)
    assert.throws(() => auditApiPlan(mut({ tasks: plan9.tasks.slice(0, 4) })), /api-matrix/)
    assert.throws(() => auditApiPlan(mut({ limits: { ...plan9.limits, maxUsd: 2 } })), /api-approval-changed/)
    assert.throws(() => auditApiPlan(buildCandidateReplayPlanV9({ candidates: pairsIn, round: 1, hypothesis: hyp, pricing: { ...PRICING, inputUsdPerMillion: 3, outputUsdPerMillion: 12 } })), /api-budget-plan-exceeds-approved-usd/)
    assert.throws(() => buildCandidateReplayPlanV9({ candidates: pairsIn.slice(0, 2), round: 1, hypothesis: hyp }), /v9-candidates-count/)
    assert.throws(() => buildCandidateReplayPlanV9({ candidates: pairsIn.map((p) => ({ ...p, candidate: p.control })), round: 1, hypothesis: hyp }), /v9-candidate-text/)
  })
  test('D4 结果归约：resultOf 用 claimVersion 3；summarizeMinimal 按计划声明的 tasks/arms 出格', () => {
    const mains = plan9.jobs.filter((j) => j.kind === 'main')
    const results = mains.map((j) => ({ task: j.task, variant: j.variant, sample: j.sample, rule: { falseDone: 0, bump: 0, reEdit: 0, repeat: 0, next: 1, avoid: 1 }, action: 'evidence' }))
    const s = summarizeMinimal(plan9, results)
    assert.equal(s.complete, true); assert.equal(s.cells.length, 5); assert.ok('control' in s.cells[0] && 'candidate' in s.cells[0]); assert.equal(s.pairedMainResponses, 10)
    const r = resultOf(plan9, mains[0], { message: { content: '改动已执行、未验证。', tool_calls: [] } })
    assert.equal(r.variant, 'control'); assert.equal(typeof r.rule.next, 'number')
  })

  // ── E. 工作流与 CLI 旗标 ────────────────────────────────────────────────────
  test('E1 prepareEvaluation version 9：写 /9 计划；重 prepare 不传候选时沿用冻结稿与 canary；report 无账本时 results 为空数组', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v9-'))
    try {
      const home = path.join(tmp, 'r1'), receiptPath = path.join(tmp, 'r1.json')
      prepareEvaluation({ home, receiptPath, profile: PROFILE, version: 9, candidates: pairsIn, round: 1, hypothesis: hyp })
      const p = JSON.parse(fs.readFileSync(path.join(home, 'plan.json'), 'utf8'))
      assert.equal(p.schema, 'cfb.bounded-ab/9'); assert.equal(p.round, 1); assert.equal(p.jobs.length, 13)
      prepareEvaluation({ home, receiptPath, profile: PROFILE })
      const q = JSON.parse(fs.readFileSync(path.join(home, 'plan.json'), 'utf8'))
      assert.equal(q.canary, p.canary); assert.deepEqual(q.variants, p.variants); assert.deepEqual(q.hypothesis, p.hypothesis)
      const rep = reportEvaluation({ home, receiptPath })
      assert.deepEqual(rep.results, []); assert.equal(rep.pairedMainResponses, 0)
      assert.ok(DEFAULT_HOME_V9(3).endsWith(path.join('bounded-ab-v9', 'r3')) && PUBLIC_RECEIPT_V9(3).endsWith('api-budget-approval-v9-r3.watermark.json'))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  test('E2 effect-ready：--v9 必须带 --round、--round 不能单独用、空 home 的 prepare --v9 被拒（计划只能来自 cfb-cycle）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v9cli-'))
    const run = (argv) => readyMain(argv, { env: { CFB_EVAL_HOME: path.join(tmp, 'h') }, output: () => {} })
    try {
      await assert.rejects(() => run(['doctor', '--v9']), /eval-option-context/)
      await assert.rejects(() => run(['doctor', '--round', '1']), /eval-option-context/)
      await assert.rejects(() => run(['doctor', '--v9', '--round', '0']), /eval-option-context/)
      await assert.rejects(() => run(['prepare', '--v9', '--round', '1', '--home', path.join(tmp, 'empty')]), /eval-v9-plan-via-cfb-cycle/)
      const src = fs.readFileSync(path.join(ROOT, 'tools/effect-ready.mjs'), 'utf8')
      assert.ok(/o\.v9 \? DEFAULT_HOME_V9\(o\.round\)/.test(src) && /version: (o\.gen \? 10 : )?o\.v9 \? 9/.test(src))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  // ── F. 编排器端到端（零 API，隔离目录）──────────────────────────────────────
  test('F1 plan → 合成报告 ingest → adopt 改 champion → 下一轮 control 换新、假设换下一个 → 否决 → propose；重复 ingest 被拒', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cycle-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    try {
      const d = cli('doctor'); assert.ok(/PASS 真值维度方向校验/.test(d.stdout), d.stdout + d.stderr)
      // v3：首轮默认 A/A 校准；这里显式 --skip-aa --lever 走 v2 的旋钮路径（A/A 与留出闸门在 closed-loop-v3.selftest 里测）
      const p1 = cli('plan', '--skip-aa', '--lever', 'kItems=off'); assert.equal(p1.status, 0, p1.stdout + p1.stderr)
      assert.ok(/kItems=off/.test(p1.stdout) && /未发任何请求/.test(p1.stdout))
      const plan1 = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r1/plan.json'), 'utf8'))
      assert.equal(plan1.schema, 'cfb.bounded-ab/9'); assert.equal(plan1.hypothesis.lever, 'kItems'); assert.equal(plan1.tasks.length, 5)
      assert.ok(!fs.existsSync(path.join(tmp, 'receipts/v9-r1.watermark.json')), 'plan 不能产生收据（没花钱）')
      const fake = (plan, winner) => ({ schema: 'cfb.eval-report/1', complete: true, reservedUsd: 0.5, requestsReserved: 13, requestsRejected: [], results: plan.jobs.filter((j) => j.kind === 'main').map((j) => ({ task: j.task, variant: j.variant, sample: j.sample, action: 'evidence', rule: { claim: 'none', falseDone: 0, overHedge: 0, repeat: 0, bump: 0, reEdit: j.variant === winner ? 0 : 1, next: j.variant === winner ? 1 : 0, avoid: 1, calls: 1 } })) })
      fs.writeFileSync(path.join(tmp, 'rep1.json'), JSON.stringify(fake(plan1, 'candidate')))
      const i1 = cli('ingest', '--round', '1', '--report', path.join(tmp, 'rep1.json')); assert.equal(i1.status, 0, i1.stdout + i1.stderr)
      // v3 留出闸门：5 胜里只有 2 对留出题（< 4 对）⇒ continue，不是 v2 的直接 adopt
      assert.ok(/判定：continue/.test(i1.stdout) && /留出题：2 对/.test(i1.stdout), i1.stdout)
      const again = cli('ingest', '--round', '1', '--report', path.join(tmp, 'rep1.json')); assert.notEqual(again.status, 0); assert.ok(/round-already-ingested/.test(again.stderr + again.stdout))
      const p1b = cli('plan', '--skip-aa'); assert.equal(p1b.status, 0, p1b.stdout + p1b.stderr); assert.ok(/继续未判定的假设/.test(p1b.stdout))
      const plan1b = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r2/plan.json'), 'utf8'))
      fs.writeFileSync(path.join(tmp, 'rep1b.json'), JSON.stringify(fake(plan1b, 'candidate')))
      const i1b = cli('ingest', '--round', '2', '--report', path.join(tmp, 'rep1b.json')); assert.equal(i1b.status, 0, i1b.stdout + i1b.stderr)
      assert.ok(/判定：continue/.test(i1b.stdout) && /留出题：4 对/.test(i1b.stdout), i1b.stdout) // v4：4 对留出 e=6.2 < 10
      cli('plan', '--skip-aa'); const plan1c = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r3/plan.json'), 'utf8'))
      fs.writeFileSync(path.join(tmp, 'rep1c.json'), JSON.stringify(fake(plan1c, 'candidate')))
      const i1c = cli('ingest', '--round', '3', '--report', path.join(tmp, 'rep1c.json')); assert.equal(i1c.status, 0, i1c.stdout + i1c.stderr)
      assert.ok(/判定：adopt-provisional/.test(i1c.stdout) && /留出题：6 对/.test(i1c.stdout), i1c.stdout)
      const champ = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8'))
      assert.equal(champ.knobs.kItems, 'off'); assert.equal(champ.policy, 'base')
      const p2 = cli('plan', '--skip-aa'); assert.equal(p2.status, 0, p2.stdout + p2.stderr)
      const plan2 = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r4/plan.json'), 'utf8'))
      assert.equal(plan2.hypothesis.champion.kItems, 'off', '第 4 轮 control 必须是新 champion')
      assert.notEqual(plan2.hypothesis.lever, 'kItems', '刚采纳的杠杆不反向重测')
      for (const t of plan2.tasks) assert.equal(plan2.variants[t].control, byArm('kItems=off').find((c) => c.task === t).text, '新 control = kItems=off 的生产重编译')
      fs.writeFileSync(path.join(tmp, 'rep2.json'), JSON.stringify(fake(plan2, 'control')))
      const i2 = cli('ingest', '--round', '4', '--report', path.join(tmp, 'rep2.json')); assert.equal(i2.status, 0, i2.stdout + i2.stderr)
      assert.ok(/判定：(reject|continue)/.test(i2.stdout), i2.stdout)
      const hist = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/history.json'), 'utf8'))
      assert.equal(hist.rounds.length, 4); assert.equal(hist.rounds[2].decision, 'adopt-provisional'); assert.equal(hist.rounds[3].status, 'ingested')
      assert.equal(fs.readFileSync(path.join(tmp, 'offline/train/pairs.jsonl'), 'utf8').trim().split('\n').length, 20, '飞轮：4 轮 × 5 个非平局配对')
      const pr = cli('propose', '--allow-provisional'); assert.equal(pr.status, 0, pr.stdout + pr.stderr)
      const proposal = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/proposal.json'), 'utf8'))
      assert.equal(proposal.needsSrcChange.length, 1); assert.equal(proposal.needsSrcChange[0].knob, 'kItems'); assert.deepEqual(proposal.configDiff, {})
      const st = cli('status'); assert.ok(/r1 ingested/.test(st.stdout) && /累计预占/.test(st.stdout))
      assert.ok(!fs.existsSync(path.join(ROOT, 'src', '.cfb-touched')), 'propose 不写 src')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  test('F2 --lever 覆盖、离线不安全拦截（bind=off 被拒）、未花钱的轮可重做而不是开新轮', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cycle2-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    try {
      const r = cli('plan', '--lever', 'bind=off'); assert.equal(r.status, 2, r.stdout); assert.ok(/offline-unsafe/.test(r.stdout))
      assert.ok(!fs.existsSync(path.join(tmp, 'runtime/r1/plan.json')))
      const bad = cli('plan', '--lever', 'nope=1'); assert.notEqual(bad.status, 0)
      const ok = cli('plan', '--lever', 'closing=off'); assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.ok(/closing=off/.test(ok.stdout))
      // 已计划、未花钱的轮：再 plan 是重做第 1 轮（计划可改），不是悄悄开第 2 轮
      // v3：没有 --lever 时首轮默认 A/A；--skip-aa 则按 v3 顺序取第一个安全杠杆（closing）
      const re = cli('plan'); assert.equal(re.status, 0); assert.ok(/第 1 轮计划/.test(re.stdout) && /A\/A=control/.test(re.stdout), re.stdout.slice(0, 200))
      const re2 = cli('plan', '--skip-aa'); assert.equal(re2.status, 0); assert.ok(/第 1 轮计划/.test(re2.stdout) && /closing=off/.test(re2.stdout), re2.stdout.slice(0, 200))
      assert.ok(!fs.existsSync(path.join(tmp, 'runtime/r2')))
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/history.json'), 'utf8')).rounds.length, 1)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
} finally {
  console.log('\n=== closed-loop selftest: ' + pass + ' pass / ' + fail + ' fail ===')
  process.exitCode = fail ? 1 : 0
}
