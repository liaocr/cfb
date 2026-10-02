// test/closed-loop-v3.selftest.mjs —— 闭环 v3（v14.3）自测：留出闸门判定 / A/A 校准 / 任务池切分轮换 / 提示词策略三闸 /
// 生成计划审计 / 编排器端到端（A/A → 旋钮 → 提议器 → 编译 → 策略假设 → 留出采纳 → 铸造进池）。全程零 API。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decideV3, effectiveN, taskTally, distinctRecord, DEFAULT_DESIGN_V3, sequentialPaired } from '../tools/helpers/experiment.mjs'
import { buildPool, splitTasks, rotateTasks, validateTaskFile, taskDigest, loadExtraTasks, DEFAULT_SPLIT_SEED, TASK_ID_RE } from '../tools/helpers/tasks.mjs'
import { BASE_POLICY, PATCH_LIMITS, makePolicy, policyId, applyPolicyToPrompt, validatePatches, leakCheck, parseProposal, basePrompt, promptHead, proposerMessages, buildGenerationPlan, genOutputs, GEN_ROLES } from '../tools/helpers/generation.mjs'
import { buildCandidateReplayPlanV9 } from '../tools/helpers/eval-plan.mjs'
import { auditApiPlan, planVersion, planScope, APPROVED_API_LIMITS_GEN, GEN_ROLES_APPROVED } from '../tools/helpers/api-budget.mjs'
import { API_APPROVAL_SCOPES_GEN, KNOWN_API_SCOPES, SCOPE_MAX_REQUESTS } from '../tools/helpers/api-watermark.mjs'
import { prepareEvaluation, reportEvaluation, loadPrepared } from '../tools/helpers/eval-workflow.mjs'
import { generateCandidates, BASELINE_KNOBS } from '../tools/helpers/candidates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name); console.log(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : String(e)) } }
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 4, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-10-02' }
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
const W = (task, outcome = 'win') => ({ task, outcome })
const pool = buildPool()
const dev = pool.tasks.filter((t) => t.split === 'dev'), holdout = pool.tasks.filter((t) => t.split === 'holdout')

// 合成报告：按给定 outcome 给两臂判据旗标（candidate win ⇒ candidate 的 next=1、control 的 next=0）
const fakeAb = (plan, spec) => {
  const want = Object.fromEntries(Object.entries(spec))
  const results = plan.jobs.filter((j) => j.kind === 'main').map((j) => {
    const o = want[j.task] || 'tie', hi = o === 'win' ? 'candidate' : o === 'loss' ? 'control' : null, good = hi == null ? true : j.variant === hi
    return { task: j.task, variant: j.variant, sample: j.sample, rule: { next: good ? 1 : 0, avoid: 1, falseDone: 0, bump: 0, reEdit: 0, repeat: 0 }, action: good ? 'read' : 'none' }
  })
  return { schema: 'cfb.bounded-ab-report/9', round: plan.round, complete: true, results, reservedUsd: 0.5, requestsReserved: 13, requestsRejected: [] }
}
const fakeGen = (plan, mode = 'good') => {
  const outputs = plan.jobs.filter((j) => j.kind === 'main').map((j) => {
    let content = '', toolCalls = []
    if (j.gen.role === 'propose') content = mode === 'leak' ? '```json\n' + JSON.stringify({ patches: [{ op: 'append', section: 'rules', text: '遇到 test/hedge.selftest.mjs 先核对' }], rationale: 'x', prediction: 'y' }) + '\n```'
      : mode === 'bad-json' ? '我觉得应该这样改：把规则加长。' : '```json\n' + JSON.stringify({ patches: [{ op: 'append', section: 'rules', text: '若上一轮已发出编辑而观察仍报错，稿首句先逐字写出被改文件路径与改动前后文，再给下一步；不得把已修复写成事实。' }], rationale: '失败证据里 candidate 在编辑后仍宣称完成。', prediction: 'falseDone 下降' }) + '\n```'
    else if (j.gen.role === 'compile') { const t = pool.tasks.find((x) => x.id === j.gen.task); content = t ? t.side.replace(/\n/, '；上一轮已发出编辑，先逐字核对被改文件再动手。\n') : '【状态】配置写入在 EACCES 处失败，定位在 src/config.js 的写路径；上一轮 grep 已确认只有一处写入。【下一步】先 read_file src/config.js 核对写路径，再决定是否改成用户目录。' }
    else { content = '我先看一下相关文件。'; toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'grep -n "writeFileSync" src/config.js' }) } }] }
    return { key: j.key, role: j.gen.role, task: j.gen.task || null, policy: j.gen.policy || null, content, reasoning: j.gen.role.startsWith('mint') ? '用户说配置保存报 EACCES。我需要先找到写配置的位置，再看路径权限。先 grep 一下 writeFileSync。'.repeat(3) : '', toolCalls }
  })
  return { schema: 'cfb.generation-report/1', role: plan.role, round: plan.round, complete: true, outputs, mode: 'simulation', reservedUsd: 0.05, requestsReserved: outputs.length + 3, requestsRejected: [] }
}

try {
  // ── A. 判定 ───────────────────────────────────────────────────────────────
  test('A1 decideV3：5 个 dev 胜 ⇒ continue（v2 会 adopt）；2 个留出题各 2 胜 ⇒ adopt；留出 3 胜 1 负 ⇒ continue', () => {
    const split = { d0: 'dev', d1: 'dev', d2: 'dev', d3: 'dev', d4: 'dev', h1: 'holdout', h2: 'holdout' }
    const devWins = ['d0', 'd1', 'd2', 'd3', 'd4'].map((t) => W(t))
    assert.equal(sequentialPaired(devWins.map((p) => p.outcome)).decision, 'adopt', 'v2 口径会直接采纳')
    const r = decideV3({ pairs: devWins, split }); assert.equal(r.decision, 'continue'); assert.match(r.why, /留出/)
    const r2 = decideV3({ pairs: devWins.concat([W('h1'), W('h2'), W('h1'), W('h2')]), split }); assert.equal(r2.decision, 'adopt'); assert.equal(r2.holdoutRecord.tasks, 2)
    const r3 = decideV3({ pairs: devWins.concat([W('h1'), W('h2'), W('h1'), W('h2', 'loss')]), split }); assert.equal(r3.decision, 'continue')
    assert.equal(decideV3({ pairs: devWins.concat([W('h1'), W('h1'), W('h1'), W('h1')]), split }).decision, 'continue', '同一道留出题重复 4 次不算 2 个不同留出题')
  })
  test('A2 decideV3：否决仍由全部配对驱动（dev 大败即 reject）；到上限未判 ⇒ stop-undecided', () => {
    const split = { a: 'dev', b: 'dev', c: 'dev', h1: 'holdout', h2: 'holdout' }
    assert.equal(decideV3({ pairs: ['a', 'b', 'c', 'a', 'b'].map((t) => W(t, 'loss')), split }).decision, 'reject')
    const alt = Array.from({ length: DEFAULT_DESIGN_V3.maxPairs }, (_, i) => W(['a', 'b', 'c', 'h1', 'h2'][i % 5], i % 2 ? 'win' : 'loss'))
    assert.equal(decideV3({ pairs: alt, split }).decision, 'stop-undecided')
  })
  test('A3 A/A 校准：噪声带内 ⇒ calibrated/ok；两臂同文却一边倒 ⇒ instrument-suspect；A/A 永不 adopt', () => {
    const r = decideV3({ pairs: [W('a', 'tie'), W('b', 'tie'), W('c', 'win'), W('d', 'loss'), W('e', 'tie')], split: {}, aa: true })
    assert.equal(r.decision, 'calibrated'); assert.equal(r.instrument, 'ok'); assert.equal(r.tieRate, 0.6)
    const bad = decideV3({ pairs: ['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e'].map((t) => W(t)), split: {}, aa: true })
    assert.equal(bad.decision, 'calibrated'); assert.equal(bad.instrument, 'instrument-suspect')
  })
  test('A4 有效 n：同题重复按 ICC 折算；不同题不折', () => {
    assert.equal(effectiveN([W('a'), W('b'), W('c')], 0.3), 3)
    const e = effectiveN([W('a'), W('a'), W('b'), W('b')], 0.3); assert.ok(e > 3 && e < 3.2, String(e))
    assert.ok(effectiveN([W('a'), W('a'), W('a'), W('a')], 0.3) < 2.3)
    assert.deepEqual(taskTally([W('a'), W('a', 'loss'), W('b')]).a, { wins: 1, losses: 1, ties: 0, n: 2 })
    assert.deepEqual(distinctRecord([W('a'), W('b'), W('b', 'loss'), W('b', 'loss')]), { tasks: 2, won: 1, lost: 1, even: 0 })
  })

  // ── B. 任务池 ─────────────────────────────────────────────────────────────
  test('B1 切分确定、留出 ≥ 2、与种子绑定；5 题池摘要稳定', () => {
    const s1 = splitTasks(['eacces-config', 'flaky-timeout', 'wrong-model', 'perf-regression', 'sse-truncated'])
    assert.deepEqual(s1, pool.split)
    assert.equal(Object.values(s1).filter((v) => v === 'holdout').length, 2)
    assert.notDeepEqual(splitTasks(Object.keys(s1), { seed: 'other' }), s1)
    assert.equal(DEFAULT_SPLIT_SEED, 'cfb-holdout-2026-10-02'); assert.equal(pool.digest.length, 12)
    assert.equal(pool.tasks.length, 5); assert.equal(holdout.length, 2); assert.equal(dev.length, 3)
  })
  test('B2 轮换：6 题池每轮 5 题，各题在 6 轮内都轮到，留出题每轮至少 2 个', () => {
    const t6 = pool.tasks.concat([{ ...pool.tasks[0], id: 'minted-x', split: 'holdout', source: 'minted' }])
    const p6 = { ...pool, tasks: t6, split: { ...pool.split, 'minted-x': 'holdout' } }
    const seen = new Set()
    for (let r = 1; r <= 6; r++) { const ids = rotateTasks(p6, r); assert.equal(ids.length, 5); assert.ok(ids.filter((id) => p6.split[id] === 'holdout').length >= 2); ids.forEach((id) => seen.add(id)) }
    assert.equal(seen.size, 6)
    assert.deepEqual(rotateTasks(pool, 1), rotateTasks(pool, 7), '≤5 题时轮换恒等')
  })
  test('B3 validateTaskFile：缺 a1Call / r1 太短 / 非法 id 被拒；合法铸造题进池为 holdout 或 dev 且带摘要', () => {
    const base = pool.tasks[0]
    const good = { schema: 'cfb.task/1', id: 'minted-good', source: 'minted', chain: { ...base.chain, id: 'minted-good' }, spec: { ...base.spec, id: 'minted-good' }, r1: base.r1, side: base.side }
    assert.equal(validateTaskFile(good), true); assert.equal(taskDigest(good).length, 16)
    assert.throws(() => validateTaskFile({ ...good, id: 'Bad Id' }), /task-file:id/)
    assert.throws(() => validateTaskFile({ ...good, chain: { ...good.chain, a1Call: undefined } }), /task-file:chain/)
    assert.throws(() => validateTaskFile({ ...good, r1: 'short' }), /task-file:r1/)
    assert.throws(() => validateTaskFile({ ...good, source: 'scraped' }), /task-file:source/)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-pool-'))
    try {
      fs.writeFileSync(path.join(tmp, 'minted-good.task.json'), JSON.stringify(good)); fs.writeFileSync(path.join(tmp, 'broken.task.json'), '{"schema":"cfb.task/1","id":"broken"}')
      const extra = loadExtraTasks(tmp); assert.equal(extra.tasks.length, 1); assert.equal(extra.warnings.length, 1)
      const p = buildPool({ extra }); assert.equal(p.tasks.length, 6); assert.ok(['dev', 'holdout'].includes(p.split['minted-good'])); assert.equal(p.registry['minted-good'].source, 'minted')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  // ── C. 策略空间 ───────────────────────────────────────────────────────────
  test('C1 补丁应用：append:rules 插在【风格样例】前、tail 追加末尾、replace 必须唯一命中；id 由内容决定', () => {
    const prompt = basePrompt(dev[0])
    const p1 = makePolicy({ parent: BASE_POLICY, patches: [{ op: 'append', section: 'rules', text: '规则甲。' }], rationale: 'r', prediction: 'p', origin: {} })
    const out = applyPolicyToPrompt(prompt, p1)
    assert.ok(out.includes('【补充规则】') && out.indexOf('【补充规则】') < out.indexOf('【风格样例】'), '补充规则在样例前')
    assert.ok(out.includes('规则甲。')); assert.equal(out.length, prompt.length + out.length - prompt.length)
    const p2 = makePolicy({ parent: BASE_POLICY, patches: [{ op: 'append', section: 'tail', text: '尾注乙' }], rationale: 'r', prediction: 'p', origin: {} })
    assert.ok(applyPolicyToPrompt(prompt, p2).trimEnd().endsWith('尾注乙'))
    assert.throws(() => applyPolicyToPrompt(prompt, makePolicy({ parent: BASE_POLICY, patches: [{ op: 'replace', from: '不存在的片段XYZ', to: 'x' }], rationale: 'r', prediction: 'p', origin: {} })), /from-occurs-0/)
    assert.equal(p1.id, policyId(p1)); assert.equal(p1.id, makePolicy({ parent: BASE_POLICY, patches: p1.patches, rationale: 'other', prediction: 'q', origin: { gen: 9 } }).id, 'id 只看补丁与父策略')
    assert.ok(applyPolicyToPrompt(prompt, BASE_POLICY) === prompt, 'base 策略 = 原提示词')
  })
  test('C2 预算闸：补丁数 / 新增字数 / replace 长度超限被拒；泄漏闸：题目特有路径被拒、领域通用词放行', () => {
    assert.throws(() => validatePatches(Array.from({ length: PATCH_LIMITS.maxPatches + 1 }, () => ({ op: 'append', section: 'rules', text: 'a' }))), /patch/)
    assert.throws(() => validatePatches([{ op: 'append', section: 'rules', text: 'x'.repeat(PATCH_LIMITS.maxAddedChars + 1) }]), /patch/)
    assert.throws(() => validatePatches([{ op: 'delete', section: 'rules', text: 'x' }]), /patch/)
    assert.ok(validatePatches([{ op: 'append', section: 'rules', text: '正常规则' }]))
    const head = promptHead(dev[0])
    // 提示词头 = 指令 + 规则 + 样例；不含当前任务上下文与思维链正文（提议器只看这部分，泄漏白名单也只用这部分）
    assert.ok(!head.includes('【当前任务与观察】') && !head.includes(dev[0].chain.a2.raw.slice(0, 80)) && !head.includes(dev[0].chain.u2.slice(0, 60)), 'head 不含 ctx / CoT')
    assert.ok(head.length < basePrompt(dev[0]).length / 2)
    assert.ok(leakCheck([{ op: 'append', section: 'rules', text: '先看 test/hedge.selftest.mjs' }], pool.tasks, head).length > 0)
    assert.deepEqual(leakCheck([{ op: 'append', section: 'rules', text: '遇到 FAIL 行先核对 error 来源' }], pool.tasks, head), [])
    assert.deepEqual(leakCheck([{ op: 'append', section: 'rules', text: '用 read_file 核对' }], pool.tasks, head), [], '提示词里已有的工具名不算泄漏')
  })
  test('C3 提议器合同：围栏 JSON / 裸 JSON 可解析，自然语言拒绝；消息里不含留出题 id，含 dev 题 id 与证据', () => {
    assert.equal(parseProposal('说明```json\n{"patches":[{"op":"append","section":"tail","text":"abc"}],"rationale":"x"}\n```').patches.length, 1)
    assert.throws(() => parseProposal('{"patches":[],"rationale":"x"}'), /policy-patches-count/, '空补丁 = 没有提案')
    assert.throws(() => parseProposal('我建议把规则写长一点。'), /proposal/)
    const msgs = proposerMessages({ prompt: promptHead(dev[0]), policy: BASE_POLICY, evidence: [{ task: dev[0].id, outcome: 'loss', candidateHead: 'xx' }], devTaskIds: dev.map((t) => t.id) })
    const text = JSON.stringify(msgs)
    for (const h of holdout) assert.ok(!text.includes(h.id), '留出题 id 不进提议器：' + h.id)
    assert.ok(text.includes(dev[0].id) && text.includes('patches'))
  })

  // ── D. 生成计划与预算 ─────────────────────────────────────────────────────
  test('D1 生成计划：compile ≤5 题 / propose 1 / mint 1；scope g<N>；审计通过；超题数 / 轮次 / 角色 / 金丝雀泄漏被拒', () => {
    const comp = buildGenerationPlan({ role: 'compile', round: 1, tasks: pool.tasks, pricing: PRICING })
    assert.equal(planVersion(comp), 10); assert.equal(planScope(comp), 'cfb.generation.2026-10-02.g1')
    const a = auditApiPlan(comp); assert.equal(a.main, 5); assert.equal(a.probe, 3); assert.ok(a.totalReservedUsd < APPROVED_API_LIMITS_GEN.maxUsd)
    assert.equal(comp.jobs.find((j) => j.kind === 'main').body.max_tokens, 2048); assert.equal(comp.jobs.find((j) => j.kind === 'main').body.temperature, 0)
    const prop = buildGenerationPlan({ role: 'propose', round: 40, tasks: dev, evidence: [], devTaskIds: dev.map((t) => t.id), pricing: PRICING })
    assert.equal(auditApiPlan(prop).main, 1); assert.equal(planScope(prop), 'cfb.generation.2026-10-02.g40')
    const mint = buildGenerationPlan({ role: 'mint-a', round: 2, scenario: { id: 'minted-x', u1: '修一下保存配置时的 EACCES' }, pricing: PRICING })
    assert.equal(auditApiPlan(mint).main, 1); assert.ok(Array.isArray(mint.jobs[3].body.tools))
    assert.throws(() => buildGenerationPlan({ role: 'compile', round: 1, tasks: pool.tasks.concat(pool.tasks) }), /gen-compile-tasks/)
    assert.throws(() => buildGenerationPlan({ role: 'compile', round: 41, tasks: pool.tasks }), /gen-round/)
    assert.throws(() => buildGenerationPlan({ role: 'train', round: 1, tasks: pool.tasks }), /gen-role/)
    assert.throws(() => auditApiPlan({ ...comp, role: 'judge' }), /api-plan-schema/)
    assert.throws(() => auditApiPlan({ ...comp, round: 41 }), /api-plan-schema|api-scope/)
    const leaked = { ...comp, jobs: comp.jobs.map((j) => (j.kind === 'main' ? { ...j, body: { ...j.body, messages: [{ role: 'user', content: j.body.messages[0].content + comp.canary }] } } : j)) }
    assert.throws(() => auditApiPlan(leaked), /api-probe-leak/)
    assert.deepEqual([...GEN_ROLES], [...GEN_ROLES_APPROVED])
    assert.equal(API_APPROVAL_SCOPES_GEN.length, 40); for (const s of API_APPROVAL_SCOPES_GEN) { assert.ok(KNOWN_API_SCOPES.includes(s)); assert.equal(SCOPE_MAX_REQUESTS[s], 8) }
  })
  test('D2 v9 计划：A/A 允许两臂同文（仅 lever=A/A）；池登记的新题可进计划，未登记被拒；split / pool 随计划冻结', () => {
    const cands = generateCandidates(pool.tasks)
    const same = pool.tasks.map((t) => { const c = cands.find((x) => x.task === t.id && x.isControl); return { task: t.id, control: c.text, candidate: c.text, chain: t.chain, spec: t.spec, r1: t.r1 } })
    const aa = buildCandidateReplayPlanV9({ candidates: same, round: 1, hypothesis: { lever: 'A/A', value: 'control', champion: BASELINE_KNOBS, split: pool.split }, pool: pool.registry, pricing: PRICING })
    assert.equal(auditApiPlan(aa).main, 10); assert.equal(aa.hypothesis.split['eacces-config'], 'holdout'); assert.equal(Object.keys(aa.pool).length, 5)
    assert.throws(() => buildCandidateReplayPlanV9({ candidates: same, round: 1, hypothesis: { lever: 'closing', value: 'off', champion: BASELINE_KNOBS }, pricing: PRICING }), /v9-candidate-text/)
    const minted = { ...same[0], task: 'minted-x' }
    assert.throws(() => buildCandidateReplayPlanV9({ candidates: [minted, same[1], same[2]], round: 1, hypothesis: { lever: 'A/A', value: 'control', champion: BASELINE_KNOBS }, pricing: PRICING }), /v9-task:minted-x/)
    const reg = { ...pool.registry, 'minted-x': { digest: 'a'.repeat(16), source: 'minted', split: 'holdout' } }
    const ok = buildCandidateReplayPlanV9({ candidates: [minted, same[1], same[2]], round: 1, hypothesis: { lever: 'A/A', value: 'control', champion: BASELINE_KNOBS }, pool: reg, pricing: PRICING })
    assert.ok(ok.tasks.includes('minted-x')); assert.equal(auditApiPlan(ok).main, 6)
    assert.throws(() => auditApiPlan({ ...ok, pool: null }), /api-plan-schema/, '审计也要求池登记')
  })
  test('D3 prepare/report v10：冻结 → 重 prepare 不换对象 → 空报告 schema 正确；report 归约 genOutputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-gen-'))
    try {
      const home = path.join(tmp, 'h'), receiptPath = path.join(tmp, 'r.json')
      assert.throws(() => prepareEvaluation({ home, receiptPath, profile: PROFILE, version: 10 }), /gen-plan-requires-generation/)
      const r = prepareEvaluation({ home, receiptPath, profile: PROFILE, version: 10, generation: { role: 'compile', round: 3, tasks: dev } })
      assert.equal(r.prepared, true); const plan = loadPrepared(home); assert.equal(plan.schema, 'cfb.generation/1'); assert.equal(plan.round, 3)
      const r2 = prepareEvaluation({ home, receiptPath, profile: PROFILE, version: 10 }); assert.equal(r2.prepared, true); assert.equal(loadPrepared(home).round, 3)
      const rep = reportEvaluation({ home, receiptPath }); assert.equal(rep.schema, 'cfb.generation-report/1'); assert.equal(rep.complete, false); assert.deepEqual(rep.outputs, [])
      const outs = genOutputs(plan, (k) => (k === 'compile|' + dev[0].id ? { message: { content: '稿', reasoning_content: 'r' } } : null))
      assert.equal(outs.length, 1); assert.equal(outs[0].task, dev[0].id); assert.equal(outs[0].content, '稿')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  // ── E. 编排器端到端（子进程 + CFB_CYCLE_DIR 改道；零 API）──────────────────
  test('E1 A/A → calibrated；旋钮 continue → 留出 4 对后 adopt；飞轮追加；status/doctor 显示校准', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v3-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    const plan = (n) => JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r' + n + '/plan.json'), 'utf8'))
    const rep = (n, p, spec) => { const f = path.join(tmp, 'rep' + n + '.json'); fs.writeFileSync(f, JSON.stringify(fakeAb(p, spec))); return f }
    try {
      const p1 = cli('plan'); assert.equal(p1.status, 0, p1.stdout + p1.stderr); assert.ok(/A\/A=control/.test(p1.stdout) && /两臂同文/.test(p1.stdout))
      const pl1 = plan(1); assert.equal(pl1.hypothesis.lever, 'A/A'); for (const t of pl1.tasks) assert.equal(pl1.variants[t].control, pl1.variants[t].candidate)
      assert.equal(pl1.hypothesis.split['wrong-model'], 'holdout'); assert.equal(Object.keys(pl1.pool).length, 5)
      const i1 = cli('ingest', '--round', '1', '--report', rep(1, pl1, { 'flaky-timeout': 'win' })); assert.equal(i1.status, 0, i1.stdout + i1.stderr)
      assert.ok(/判定：calibrated/.test(i1.stdout) && /A\/A 校准/.test(i1.stdout), i1.stdout)
      const h1 = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/history.json'), 'utf8')); assert.equal(h1.calibration.round, 1); assert.equal(h1.calibration.instrument, 'ok')
      assert.ok(!fs.existsSync(path.join(tmp, 'offline/train/pairs.jsonl')), 'A/A 不进飞轮')
      const p2 = cli('plan'); assert.equal(p2.status, 0, p2.stdout + p2.stderr); assert.ok(/closing=off/.test(p2.stdout), p2.stdout.slice(0, 300))
      const all = Object.fromEntries(plan(2).tasks.map((t) => [t, 'win']))
      const i2 = cli('ingest', '--round', '2', '--report', rep(2, plan(2), all)); assert.ok(/判定：continue/.test(i2.stdout) && /留出题：2 对/.test(i2.stdout), i2.stdout)
      const p3 = cli('plan'); assert.ok(/继续未判定的假设/.test(p3.stdout))
      // v4：4 对留出全胜 e=6.2 < 10（v3 的 P=0.969 ≥ 0.95 会在这里采纳 —— 那正是 6% 误采纳的来源）⇒ continue；第 4 轮 6 对 e=18.1 ⇒ adopt-provisional
      const i3 = cli('ingest', '--round', '3', '--report', rep(3, plan(3), all)); assert.ok(/判定：continue/.test(i3.stdout) && /留出题：4 对/.test(i3.stdout) && /e 值.*留出 6\.2/.test(i3.stdout), i3.stdout)
      cli('plan'); const i4 = cli('ingest', '--round', '4', '--report', rep(4, plan(4), all)); assert.ok(/判定：adopt-provisional/.test(i4.stdout) && /留出题：6 对/.test(i4.stdout) && /临时/.test(i4.stdout), i4.stdout)
      const champ = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')); assert.equal(champ.knobs.closing, 'off'); assert.equal(champ.policy, 'base'); assert.equal(champ.adopted[0].holdoutPWin, 0.9922); assert.equal(champ.adoption, 'provisional'); assert.equal(champ.previous.knobs.closing, BASELINE_KNOBS.closing)
      assert.equal(fs.readFileSync(path.join(tmp, 'offline/train/pairs.jsonl'), 'utf8').trim().split('\n').length, 15)
      const ex = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/ruler/exposure.json'), 'utf8')); assert.deepEqual(Object.values(ex.tasks).map((e) => e.n), [1, 1], '采纳判定让 2 道留出题各曝光 1 次')
      const pr0 = cli('propose'); assert.notEqual(pr0.status, 0); assert.ok(/champion-provisional/.test(pr0.stderr + pr0.stdout), 'provisional 不出生产 diff')
      const pr1 = cli('propose', '--allow-provisional'); assert.equal(pr1.status, 0, pr1.stdout + pr1.stderr)
      const st = cli('status'); assert.ok(/仪器校准: r1/.test(st.stdout) && /calibrated/.test(st.stdout) && /采纳状态 provisional/.test(st.stdout), st.stdout)
      const dr = cli('doctor'); assert.ok(/PASS 任务池可构建/.test(dr.stdout) && /PASS v3 判定/.test(dr.stdout), dr.stdout)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  test('E2 生成层：泄漏提案被拒 → 合法提案落策略 → compile 全覆盖 → plan 自动把策略当假设 → 留出采纳 → control 换成策略稿 → propose 给提示词补丁', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v3g-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    const gplan = (n) => JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/g' + n + '/plan.json'), 'utf8'))
    const plan = (n) => JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r' + n + '/plan.json'), 'utf8'))
    const grep = (n, mode) => { const f = path.join(tmp, 'g' + n + '.json'); fs.writeFileSync(f, JSON.stringify(fakeGen(gplan(n), mode))); return f }
    const rep = (n, p, spec) => { const f = path.join(tmp, 'rep' + n + '.json'); fs.writeFileSync(f, JSON.stringify(fakeAb(p, spec))); return f }
    try {
      fs.mkdirSync(path.join(tmp, 'offline'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'offline/history.json'), JSON.stringify({ schema: 'cfb.closed-loop/2', hypotheses: {}, rounds: [], calibration: { round: 0, instrument: 'ok', tieRate: 0.6, winRate: 0.2 } }))
      const pp = cli('propose-policy'); assert.equal(pp.status, 0, pp.stdout + pp.stderr); assert.ok(/留出题 .* 已排除/.test(pp.stdout) && /cfb\.generation\.2026-10-02\.g1/.test(pp.stdout))
      const g1 = gplan(1); assert.equal(g1.role, 'propose'); assert.equal(g1.jobs.filter((j) => j.kind === 'main').length, 1)
      for (const h of holdout) assert.ok(!JSON.stringify(g1.jobs).includes(h.id), '提议器请求体不含留出题 id')
      assert.ok(!fs.existsSync(path.join(tmp, 'receipts')), 'propose-policy 不花钱')
      const bad = cli('ingest-gen', '--gen', '1', '--report', grep(1, 'leak')); assert.equal(bad.status, 0, bad.stdout + bad.stderr); assert.ok(/leak:/.test(bad.stdout)); assert.ok(!fs.existsSync(path.join(tmp, 'offline/policies')))
      cli('propose-policy'); const bj = cli('ingest-gen', '--gen', '2', '--report', grep(2, 'bad-json')); assert.ok(/proposal-invalid/.test(bj.stdout))
      cli('propose-policy'); const ok = cli('ingest-gen', '--gen', '3', '--report', grep(3)); assert.equal(ok.status, 0, ok.stdout + ok.stderr)
      const pid = JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{'), ok.stdout.lastIndexOf('}') + 1)).policy; assert.match(pid, /^p-[0-9a-f]{10}$/)
      const pol = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/policies', pid + '.json'), 'utf8')); assert.equal(pol.status, 'proposed'); assert.equal(pol.parent, 'base')
      const pl = cli('plan'); assert.ok(!/policy=/.test(pl.stdout.split('选它的理由')[0]), '未编译的策略不能成为假设')
      const c = cli('compile', '--policy', pid); assert.equal(c.status, 0, c.stdout + c.stderr); assert.ok(/主 5 \+ 探针 3/.test(c.stdout))
      const ci = cli('ingest-gen', '--gen', '4', '--report', grep(4)); assert.ok(/"status": "compiled"/.test(ci.stdout), ci.stdout)
      const pol2 = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/policies', pid + '.json'), 'utf8')); assert.equal(Object.keys(pol2.sides).length, 5); assert.ok(Object.values(pol2.sides).every((s) => s.gate === true))
      const again = cli('compile', '--policy', pid); assert.ok(/无需花钱/.test(again.stdout))
      const p1 = cli('plan'); assert.equal(p1.status, 0, p1.stdout + p1.stderr); assert.ok(p1.stdout.includes('policy=' + pid) && /留出题闸门采纳/.test(p1.stdout), p1.stdout.slice(0, 400))
      const pl1 = plan(1); assert.equal(pl1.hypothesis.lever, 'policy'); assert.equal(pl1.hypothesis.policy, pid); assert.equal(pl1.hypothesis.kind, 'prompt')
      for (const t of pl1.tasks) assert.notEqual(pl1.variants[t].control, pl1.variants[t].candidate)
      const all = Object.fromEntries(pl1.tasks.map((t) => [t, 'win']))
      cli('ingest', '--round', '1', '--report', rep(1, pl1, all)); cli('plan')
      const i2 = cli('ingest', '--round', '2', '--report', rep(2, plan(2), all)); assert.ok(/判定：continue/.test(i2.stdout), i2.stdout)
      cli('plan'); const i3 = cli('ingest', '--round', '3', '--report', rep(3, plan(3), all)); assert.ok(/判定：adopt-provisional/.test(i3.stdout), i3.stdout)
      const champ = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')); assert.equal(champ.policy, pid); assert.deepEqual(champ.knobs, BASELINE_KNOBS); assert.equal(champ.adoption, 'provisional')
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/policies', pid + '.json'), 'utf8')).status, 'adopted')
      // L2 确认：traj-run 风格的结局行（champion 修得更快）⇒ confirmed；带 proxyScore 的行进效度账本
      const l2 = []; for (const t of ['eacces-config', 'wrong-model', 'flaky-timeout']) for (const smp of [0, 1]) { l2.push({ task: t, variant: 'champ', sample: smp, fixed: true, fixedAtRound: 2, rounds: 3, claim: 'fixed', verifiedAfterFix: true, proxyScore: 3 }); l2.push({ task: t, variant: 'prev', sample: smp, fixed: smp === 0, fixedAtRound: smp === 0 ? 4 : null, rounds: 5, claim: 'fixed', verifiedAfterFix: false, proxyScore: smp === 0 ? 1 : 0 }) }
      fs.writeFileSync(path.join(tmp, 'l2.jsonl'), l2.map((x) => JSON.stringify(x)).join('\n') + '\n')
      // v4.2：策略 champion 没有路径等价校准 ⇒ pending-parity；补一次 auto vs policy:base（全平）后才 confirmed
      const cf0 = cli('confirm', '--results', path.join(tmp, 'l2.jsonl'), '--map', 'champion=champ,previous=prev'); assert.ok(/pending-parity/.test(cf0.stdout), cf0.stdout)
      const par = []; for (const t of ['eacces-config', 'wrong-model']) for (const smp of [0, 1]) for (const v of ['auto', 'policy:base']) par.push({ task: t, variant: v, sample: smp, fixed: true, fixedAtRound: 3, rounds: 3, claim: 'fixed', verifiedAfterFix: true, compile: [{ ok: true }] })
      fs.writeFileSync(path.join(tmp, 'par.json'), JSON.stringify(par)); assert.ok(/（ok）/.test(cli('confirm', '--parity', '--results', path.join(tmp, 'par.json')).stdout))
      const cf = cli('confirm', '--results', path.join(tmp, 'l2.jsonl'), '--map', 'champion=champ,previous=prev'); assert.equal(cf.status, 0, cf.stdout + cf.stderr); assert.ok(/（confirmed）/.test(cf.stdout) && /效度账本 \+12/.test(cf.stdout), cf.stdout)
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')).adoption, 'confirmed')
      const ru = cli('ruler'); assert.ok(/效度.*valid|效度.*suspect/.test(ru.stdout) && /n=24/.test(ru.stdout), ru.stdout)   // 两次 confirm 各追加 12 对
      const p3 = cli('plan'); assert.equal(p3.status, 0, p3.stdout + p3.stderr); assert.ok(p3.stdout.includes('champion 策略 `' + pid + '`'))
      const pl3 = plan(4); assert.notEqual(pl3.hypothesis.lever, 'policy'); for (const t of pl3.tasks) assert.equal(pl3.variants[t].control, pl1.variants[t].candidate, '采纳后 control = 策略稿')
      const pr = cli('propose'); assert.equal(pr.status, 0, pr.stdout + pr.stderr); const proposal = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/proposal.json'), 'utf8'))
      assert.equal(proposal.promptPatch.policy, pid); assert.equal(proposal.promptPatch.patches.length, 1); assert.match(proposal.promptPatch.where, /src\/prompts\.js/)
      const pp2 = cli('propose-policy'); assert.ok(pp2.stdout.includes('父策略 ' + pid), '下一次提议从采纳的策略出发')
      const ls = cli('policies'); assert.ok(ls.stdout.includes(pid) && /adopted/.test(ls.stdout) && /飞轮偏好对：15/.test(ls.stdout))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  test('E3 铸造：mint a → 人补 u2 → mint b → compile --mint r1 → side → task.json 进池（6 题、留出 ≥2、轮换跳过缺 side 的题）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v3m-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    const gplan = (n) => JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/g' + n + '/plan.json'), 'utf8'))
    const grep = (n) => { const f = path.join(tmp, 'g' + n + '.json'); fs.writeFileSync(f, JSON.stringify(fakeGen(gplan(n)))); return f }
    try {
      const sc = path.join(tmp, 'scenario.json')
      fs.writeFileSync(sc, JSON.stringify({ id: 'config-eacces-home', u1: "保存配置时报 EACCES: permission denied, open '/etc/dsh/config.json'。帮我修。", followup: '[tool: bash 结果]\nError: EACCES: permission denied', next: ['read_file src/config.js'], avoid: ['sudo'] }))
      const a = cli('mint', '--step', 'a', '--scenario', sc); assert.equal(a.status, 0, a.stdout + a.stderr); assert.ok(/cfb\.generation\.2026-10-02\.g1/.test(a.stdout))
      assert.ok(gplan(1).jobs[3].body.tools.length > 0)
      const ia = cli('ingest-gen', '--gen', '1', '--report', grep(1)); assert.ok(/chain\.u2/.test(ia.stdout), ia.stdout)
      const b0 = cli('mint', '--step', 'b', '--id', 'config-eacces-home'); assert.notEqual(b0.status, 0, '没有 u2 不能 step b')
      const pf = path.join(tmp, 'offline/tasks/config-eacces-home.partial.json'), part = JSON.parse(fs.readFileSync(pf, 'utf8'))
      assert.equal(part.chain.a1Call, 'grep -n "writeFileSync" src/config.js'); part.chain.u2 = '[tool: bash 结果]\nsrc/config.js:41 writeFileSync(CONFIG_PATH)\n还是报错，下一步？'; fs.writeFileSync(pf, JSON.stringify(part))
      const b = cli('mint', '--step', 'b', '--id', 'config-eacces-home'); assert.equal(b.status, 0, b.stdout + b.stderr)
      assert.ok(gplan(2).jobs[3].body.messages.some((m) => m.reasoning_content), 'mint-b 回放 a1 的 reasoning')
      cli('ingest-gen', '--gen', '2', '--report', grep(2))
      const c1 = cli('compile', '--mint', 'config-eacces-home'); assert.ok(/先压 r1/.test(c1.stdout)); cli('ingest-gen', '--gen', '3', '--report', grep(3))
      const c2 = cli('compile', '--mint', 'config-eacces-home'); assert.equal(c2.status, 0, c2.stdout + c2.stderr); const ic = cli('ingest-gen', '--gen', '4', '--report', grep(4)); assert.ok(/config-eacces-home\.task\.json/.test(ic.stdout), ic.stdout)
      const task = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/tasks/config-eacces-home.task.json'), 'utf8')); assert.equal(validateTaskFile(task), true); assert.equal(task.source, 'minted'); assert.equal(task.origin.steps.length, 4)
      const ls = cli('policies'); assert.ok(/config-eacces-home\[(holdout|dev)\/minted\]/.test(ls.stdout), ls.stdout)
      const p = cli('plan', '--skip-aa'); assert.equal(p.status, 0, p.stdout + p.stderr); assert.ok(/6 题/.test(p.stdout))
      const pl = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r1/plan.json'), 'utf8')); assert.ok(pl.tasks.length >= 4 && pl.tasks.length <= 5, '轮换 5 题；合成 side 过不了闸的题不进配对'); assert.equal(Object.keys(pl.pool).length, 6)
      assert.equal(auditApiPlan(pl, { allowUnpriced: true }).main, pl.tasks.length * 2)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
} finally {
  console.log('\n=== closed-loop-v3 selftest: ' + pass + ' pass / ' + fail + ' fail ===')
  process.exitCode = fail ? 1 : 0
}
