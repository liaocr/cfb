// test/closed-loop-v4.selftest.mjs —— 闭环 v4（v14.4）自测：e 值采纳（任意停时有效）/ 尺子效度账本（L1 代理 ↔ L2 结局）/
// provisional → confirm / rolled-back / 留出曝光 / CPU 排序器 / 现有 29 条真实轨迹上的 L2 基线。全程零 API。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { eValueWins, winsNeeded, decideV4, DEFAULT_DESIGN_V4, episodeOutcome, auc, rulerValidity, adoptionPolicy, outcomeComparison } from '../tools/helpers/ruler.mjs'
import { decideV3 } from '../tools/helpers/experiment.mjs'
import { trainRanker, rankCandidates, features, FEATURE_NAMES, MIN_PAIRS } from '../tools/helpers/ranker.mjs'
import { stepFlags, proxyPairs, retroValidity } from '../tools/helpers/traj-proxy.mjs'
import { runOne, loadPolicyFor, policyCompressBody, checkTrajPlan } from '../tools/traj-run.mjs'
import { l1Discrimination, rulerEconomics } from '../tools/helpers/ruler.mjs'
import { applyPolicyToPrompt, validatePatches, basePrompt } from '../tools/helpers/generation.mjs'
import { TRAJ_TASKS } from '../tools/traj-fixtures.mjs'
import { concordanceIndex, rulerValidityTTF, iccOneWay, fitFlagWeights, generalizationGap } from '../tools/helpers/ruler.mjs'
import { childStates, familyCensus, valueTable } from '../tools/helpers/child-states.mjs'
import { scoreMatrix, paretoFront, pickParent } from '../tools/helpers/pareto.mjs'
import { perturbTask, loadStates } from '../tools/traj-run.mjs'
import * as tr from '../tools/traj-run.mjs'
import * as cyc from '../tools/cfb-cycle.mjs'
import { materialize } from '../tools/traj-fixtures.mjs'
import { perturbExposure } from '../tools/helpers/perturb-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name); console.log(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : String(e)) } }
const W = (task, outcome = 'win') => ({ task, outcome })
const split = { h1: 'holdout', h2: 'holdout' }
const devWins = ['a', 'b', 'c', 'd', 'e'].map((t) => W(t))

await (async () => {
try {
  await test('A1 e 值：闭式解与手算一致；5 连胜过 α=0.1、7 连胜过 α=0.05；0 场 =1；输多赢少 <1', () => {
    assert.ok(Math.abs(eValueWins(5, 0) - 64 / 6 * (1 - 2 ** -6)) < 1e-6, '2^(n+1)·B(w+1,1)·(1−0.5^(w+1))')
    assert.ok(eValueWins(4, 0) < 10 && eValueWins(5, 0) >= 10 && eValueWins(6, 0) < 20 && eValueWins(7, 0) >= 20)
    assert.equal(winsNeeded(0.1), 5); assert.equal(winsNeeded(0.05), 7); assert.equal(eValueWins(0, 0), 1); assert.ok(eValueWins(1, 5) < 1)
  })
  await test('A2 decideV4：4 对留出全胜 ⇒ continue（v3 这里 adopt）；5 对 ⇒ adopt-provisional；留出 1 负 ⇒ continue；全负 ⇒ reject；30 对交替 ⇒ stop-undecided；A/A 永不采纳', () => {
    const four = devWins.concat([W('h1'), W('h2'), W('h1'), W('h2')])
    assert.equal(decideV3({ pairs: four, split }).decision, 'adopt'); const r4 = decideV4({ pairs: four, split }); assert.equal(r4.decision, 'continue'); assert.match(r4.why, /连胜 ≈ 1 场/)
    const r5 = decideV4({ pairs: four.concat([W('h1')]), split }); assert.equal(r5.decision, 'adopt-provisional'); assert.ok(r5.e.holdout >= 10 && r5.e.all >= 10); assert.equal(r5.thresholds.adopt, 10)
    assert.equal(decideV4({ pairs: four.concat([W('h2', 'loss')]), split }).decision, 'continue')
    assert.equal(decideV4({ pairs: four.concat([W('h1'), W('h1'), W('h1')]).filter((p) => p.task !== 'h2'), split }).decision, 'continue', '单一留出题不算')
    assert.equal(decideV4({ pairs: ['a', 'b', 'h1', 'h2', 'c'].map((t) => W(t, 'loss')), split }).decision, 'reject')
    assert.equal(decideV4({ pairs: Array.from({ length: 30 }, (_, i) => W(i % 2 ? 'h1' : 'h2', i % 2 ? 'win' : 'loss')), split }).decision, 'stop-undecided')
    const aa = decideV4({ pairs: [W('a', 'tie'), W('b', 'tie'), W('h1'), W('h2'), W('c')], split, aa: true }); assert.equal(aa.decision, 'calibrated'); assert.equal(aa.instrument, 'ok')
    const bad = decideV4({ pairs: ['a', 'b', 'h1', 'h2', 'c', 'd'].map((t) => W(t)), split, aa: true }); assert.equal(bad.decision, 'calibrated'); assert.equal(bad.instrument, 'instrument-suspect')
    assert.equal(DEFAULT_DESIGN_V4.icc, 0.3); assert.equal(DEFAULT_DESIGN_V4.maxPairs, 30)
  })
  await test('A3 效度账本：<12 对 unvalidated；分离好 ⇒ valid；随机 ⇒ invalid/suspect；adoptionPolicy 随状态变', () => {
    assert.equal(rulerValidity([{ proxy: 1, outcome: 1 }, { proxy: 0, outcome: 0 }]).status, 'unvalidated')
    const good = Array.from({ length: 24 }, (_, i) => ({ proxy: (i % 2 ? 3 : -1) + (i % 5) * 0.1, outcome: i % 2 }))
    const g = rulerValidity(good); assert.equal(g.status, 'valid'); assert.equal(g.auc, 1); assert.ok(g.ci95[0] >= 0.6)
    const rnd = Array.from({ length: 40 }, (_, i) => ({ proxy: (i * 7) % 11, outcome: (i * 3) % 2 })); const r = rulerValidity(rnd); assert.ok(['invalid', 'suspect'].includes(r.status), r.status); assert.ok(r.auc < 0.7)
    assert.equal(auc([{ proxy: 1, outcome: 1 }, { proxy: 1, outcome: 0 }]), 0.5)
    assert.equal(adoptionPolicy(g).l1Adopts, true); assert.equal(adoptionPolicy({ status: 'invalid' }).confirmEvery, 1); assert.equal(adoptionPolicy(null).l1Adopts, false)
  })
  await test('A4 L2 结局：episodeOutcome / outcomeComparison 配对（修得更快赢、假宣称罚、未修平）；e 值随配对数走', () => {
    const o = episodeOutcome({ fixed: true, fixedAtRound: 2, rounds: 3, claim: 'fixed', verifiedAfterFix: true }); assert.equal(o.solved, true); assert.equal(o.roundsToFix, 2); assert.equal(o.falseClaim, false)
    const fc = episodeOutcome({ fixed: false, fixedAtRound: null, rounds: 5, claim: 'fixed' }); assert.equal(fc.solved, false); assert.equal(fc.falseClaim, true)
    const rows = []
    for (const t of ['t1', 't2', 't3']) for (const s of [0, 1]) { rows.push({ task: t, arm: 'champion', sample: s, fixed: true, fixedAtRound: 2, claim: 'fixed' }); rows.push({ task: t, arm: 'previous', sample: s, fixed: s === 0, fixedAtRound: s === 0 ? 3 : null, claim: s === 0 ? 'fixed' : 'none' }) }
    const c = outcomeComparison(rows); assert.equal(c.pairs.length, 6); assert.ok(c.pairs.every((p) => p.outcome === 'win')); assert.equal(c.champion.solved, 1); assert.equal(c.previous.solved, 0.5); assert.ok(c.e >= 10 && c.eReject < 1)
    const tie = outcomeComparison([{ task: 'x', arm: 'champion', fixed: false }, { task: 'x', arm: 'previous', fixed: false }]); assert.equal(tie.pairs[0].outcome, 'tie'); assert.equal(tie.e, 1)
  })
  await test('A5 排序器：<20 对 untrained；可分 ⇒ ready 且排序正确；噪声 ⇒ weak；20 维特征有名字', () => {
    assert.equal(features('x').length, FEATURE_NAMES.length); assert.equal(MIN_PAIRS, 20)
    const pairs = Array.from({ length: 24 }, (_, i) => ({ chosenText: `先核对 src/config.js 第 ${i} 行；old_text 逐字见下。下一步 读 test/x.mjs 再改。`, rejectedText: '可能已修复，大概没问题了，也许 done。' + 'x'.repeat(i) }))
    assert.equal(trainRanker(pairs.slice(0, 10)).status, 'untrained')
    const m = trainRanker(pairs); assert.equal(m.status, 'ready'); assert.ok(m.cvAcc >= 0.9); assert.ok(m.top.some((t) => t.name === 'hedges' && t.w < 0))
    const rk = rankCandidates(m, [{ id: 'bad', text: '也许修好了' }, { id: 'good', text: '先读 src/a.js，old_text 逐字对齐' }]); assert.equal(rk.used, true); assert.equal(rk.ranked[0].id, 'good')
    const noisy = pairs.map((p, i) => (i % 2 ? p : { chosenText: p.rejectedText, rejectedText: p.chosenText })); assert.equal(trainRanker(noisy).status, 'weak'); assert.equal(rankCandidates(trainRanker(noisy), [{ id: 'a', text: 'x' }]).used, false)
  })
  await test('A6 真实数据：transfer/traj1–3 的 29 条轨迹能算出 L2 基线（raw vs auto），且 rulerReport 零 API 可用', () => {
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    assert.equal(rows.length, 29)
    const c = outcomeComparison(rows.map((r) => ({ ...r, arm: r.variant === 'auto' ? 'champion' : r.variant === 'raw' ? 'previous' : null, sample: `${r.dir}#${r.sample ?? 0}` })).filter((r) => r.arm))
    assert.equal(c.previous.n, 11); assert.equal(c.champion.n, 10); assert.equal(c.pairs.length, 10); assert.ok(c.champion.solved > c.previous.solved); assert.ok(c.e > 1 && c.e < 10, 'auto 方向更好但未过阈：' + c.e)
  })
  await test('A7 执行器代理（v4.1）：29 条真实轨迹 ⇒ 111 步旗标；轨迹级 21 对（负例 3 ⇒ unvalidated 而非 valid）；步级簇自助；falseDone / repeat / reEdit 可被机械识别', () => {
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    const r = retroValidity(rows); assert.equal(r.steps, 111); assert.equal(r.trajectory.n, 21); assert.equal(r.trajectory.neg, 3); assert.equal(r.trajectory.status, 'unvalidated'); assert.match(r.trajectory.why, /少数类/)
    assert.ok(r.trajectory.auc > 0.9 && r.step.clusters === 21 && r.step.ci95 && ['suspect', 'valid'].includes(r.step.status), JSON.stringify(r.step))
    assert.ok(r.flagRates.next > 0.8 && r.flagRates.avoid > 0.9, '这些题上 next/avoid 接近天花板')
    const fake = { task: 't', variant: 'raw', sample: 0, fixedAtRound: null, fixed: false, transcript: [
      { round: 1, text: '先看', calls: [{ name: 'bash', args: '{"command":"cat a.js"}' }], results: ['ok'] },
      { round: 2, text: '再看', calls: [{ name: 'bash', args: '{"command":"cat a.js"}' }, { name: 'edit_file', args: '{"path":"a.js"}' }], results: ['ok', 'ok（a.js 已写入，1 处替换）'] },
      { round: 3, text: '改第二次', calls: [{ name: 'edit_file', args: '{"path":"a.js"}' }], results: ['edit_file 失败: old_text 在 a.js 里没有找到'] },
      { round: 4, text: '问题已修复。', calls: [], results: [] }] }
    const st = stepFlags(fake); assert.deepEqual(st.map((x) => x.score), [2, 1, -1, 0])
    assert.equal(st[1].flags.repeat, 1); assert.equal(st[2].flags.reEdit, 1); assert.equal(st[2].flags.avoid, 0); assert.equal(st[3].flags.falseDone, 1)
    assert.equal(proxyPairs([fake], { level: 'trajectory' })[0].proxy, 0.5); assert.equal(proxyPairs([fake], { level: 'step' }).length, 4)
  })
  await test('A8 traj-run v4.1（假 chat，零 API）：policy:<id> 变体走「v4 提示词 + 补丁」压缩；--fork 让第二臂复用第 1 轮回复（省 1 次主调用）；每行带 proxySteps / proxyScore / proxyRound2', async () => {
    const I = await import('../index.js'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-trj-'))
    fs.writeFileSync(path.join(tmp, 'p-test.json'), JSON.stringify({ schema: 'cfb.policy/1', id: 'p-test', parent: 'base', patches: [{ op: 'append', section: 'rules', text: '测试规则：先逐字核对再编辑。' }] }))
    assert.equal(loadPolicyFor('policy:base').id, 'base'); assert.equal(loadPolicyFor('raw'), null); assert.equal(loadPolicyFor('policy:p-test', tmp).id, 'p-test'); assert.throws(() => loadPolicyFor('policy:nope', tmp), /policy-not-found/)
    const body = policyCompressBody({ I, model: 'm', reasoning: '我需要先看配置。'.repeat(40), ctx: '【当前任务】x', policy: loadPolicyFor('policy:p-test', tmp) }); assert.ok(body.messages[0].content.includes('测试规则：先逐字核对再编辑') && body.temperature === 0)
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config'); let mains = 0, compresses = 0, sawPatch = false
    const tc = (name, args) => ({ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } })
    const chat = async (b) => {
      if (b.messages.length === 1) { compresses++; if (b.messages[0].content.includes('测试规则')) sawPatch = true; return { message: { content: '【压缩稿】先核对 src/trace.js 的 home 路径；下一步读 verify.mjs。' + 'x'.repeat(60) }, usage: {} } }
      mains++; const round = b.messages.filter((x) => x.role === 'assistant').length + 1
      if (round === 1) return { message: { content: '先看。', reasoning_content: 'r'.repeat(40), tool_calls: [tc('read_file', { path: 'src/trace.js' })] }, usage: { prompt_tokens: 500 }, fp: 'x' }
      if (round === 2) return { message: { content: '再看。', reasoning_content: 'r'.repeat(40), tool_calls: [tc('bash', { command: 'cat README.md' })] }, usage: { prompt_tokens: 600 }, fp: 'x' }
      return { message: { content: '问题已修复。', reasoning_content: 'r'.repeat(40) }, usage: { prompt_tokens: 700 }, fp: 'x' }
    }
    const o = { maxRounds: 4, minChars: 10, model: 'm', maxTokens: 1000, maxProbes: 1, textTools: false, requireFp: false, policyDir: tmp }
    const a = await runOne({ o, task, variant: 'policy:p-test', sample: 0, chat, I, cred: null }); assert.equal(a.error, undefined, a.error); assert.equal(a.policy, 'p-test'); assert.equal(a.compile.filter((c) => c.ok).length, 3); assert.ok(sawPatch)
    assert.deepEqual(a.proxySteps.map((s) => s.score), [2, 2, 0]); assert.equal(a.proxyScore, 1.333); assert.equal(a.proxyRound2, 2); assert.equal(a.claim, 'fixed'); assert.equal(a.fixed, false); assert.ok(a.firstMessage)
    const b = await runOne({ o, task, variant: 'policy:base', sample: 0, chat, I, cred: null, forkMessage: a.firstMessage }); assert.equal(b.forked, true); assert.equal(b.transcript[0].calls[0].name, 'read_file'); assert.equal(mains, 5, '2 臂 × 3 轮 − 1 次分叉复用'); assert.equal(compresses, 6)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await test('A9 L1 值不值得存在（v4.2）：transfer/mr 162 样本天花板率 0.83、raw vs 压缩稿平局率 0.6；尺子未验 ⇒ role=diagnostic；valid 且更便宜 ⇒ prescreen；不更便宜 ⇒ redundant', () => {
    const rows = ['run1', 'run2', 'run3', 'run4'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', 'mr', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), run: d })))
    const d = l1Discrimination(rows); assert.equal(d.n, 162); assert.equal(d.ceilingRate, 0.827); assert.deepEqual(d.pairs, { win: 8, loss: 4, tie: 18 }); assert.equal(d.tieRate, 0.6)
    const e0 = rulerEconomics({ validity: { status: 'unvalidated' }, l1: { tieRate: d.tieRate } }); assert.equal(e0.role, 'diagnostic'); assert.equal(e0.l1.adoptionGradePerUsd, 0); assert.equal(e0.l1.informativePairs, 2)
    assert.equal(rulerEconomics({ validity: { status: 'valid' }, l1: { tieRate: d.tieRate } }).role, 'prescreen'); assert.equal(rulerEconomics({ validity: { status: 'valid' }, l1: { tieRate: 0.97 } }).role, 'redundant')
  })
  await test('A10 样例槽（v4.2，零 API 生成器）：op exemplar 替换【风格样例】正文；预算 / 长度闸；traj 计划参数核对拒绝不一致运行', async () => {
    const I = await import('../index.js'); const task = { chain: { a2: { raw: '我需要先看配置。'.repeat(30) } }, ctx: '【当前任务】x' }
    const ex = '先核对 lib/store.js 的 save：它直接 writeFileSync 到用户目录，EACCES 来自目录权限而非文件；old_text 逐字取第 12 行；下一步 ls -ld 确认 owner，再决定 chown 还是改路径。'
    const p0 = basePrompt(task), p1 = applyPolicyToPrompt(p0, { patches: [{ op: 'exemplar', text: ex }] })
    assert.ok(p1.includes(ex) && p1.includes('【风格样例】') && p1.length < p0.length && p1.includes('【当前任务与观察】'))
    assert.equal(validatePatches([{ op: 'exemplar', text: ex }]), true); assert.throws(() => validatePatches([{ op: 'exemplar', text: '短' }]), /exemplar-text/); assert.throws(() => validatePatches([{ op: 'exemplar', text: 'x'.repeat(1300) }]), /exemplar-size/)
    const plan = { schema: 'cfb.traj-plan/1', id: 't1', digest: 'd', variants: ['raw', 'policy:base'], scenarios: ['eacces-config', 'flaky-timeout'], samples: 2, maxRounds: 4, fork: true }
    assert.ok(checkTrajPlan(plan, { variants: ['raw', 'policy:base'], only: ['flaky-timeout', 'eacces-config'], samples: 2, maxRounds: 4, fork: true }).ok)
    assert.throws(() => checkTrajPlan(plan, { variants: ['raw', 'policy:base'], only: ['eacces-config'], samples: 2, maxRounds: 4, fork: true }), /traj-plan-mismatch:only/)
    assert.throws(() => checkTrajPlan(plan, { variants: ['raw', 'auto'], only: plan.scenarios, samples: 2, maxRounds: 6, fork: true }), /variants.*maxRounds|maxRounds.*variants|traj-plan-mismatch/)
  })
  await test('A11 端到端（v4.2）：plan-traj 冻结计划（期望 / 上界成本、目的）→ 策略 champion 的 L2 确认被路径等价闸挡下（pending-parity）→ confirm --parity 通过后 confirmed；policy-from-flywheel 零 API 落策略', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v42-')); const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    try {
      // v4.3：默认场景从 3 个家族变成 5 个（traj-fixtures-v2 加了 wrong-model / sse-truncated）⇒ 默认单位 70 + 40 请求、≈$1.175；限定旧 3 题仍是 42 + 24、≈$0.705
      const pt = cli('plan-traj'); assert.equal(pt.status, 0, pt.stdout + pt.stderr); assert.ok(/期望实付 ≈ \$1\.175，上界 ≈ \$2\.978/.test(pt.stdout) && /检验尺子有效性/.test(pt.stdout) && /traj-run\.mjs --plan/.test(pt.stdout), pt.stdout)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t1/plan.json'), 'utf8')); assert.equal(plan.schema, 'cfb.traj-plan/1'); assert.equal(plan.cost.mains, 70); assert.equal(plan.cost.compresses, 40); assert.equal(plan.scenarios.length, 5); assert.ok(!fs.existsSync(path.join(tmp, 'receipts')))
      const pt3 = cli('plan-traj', '--n', '9', '--scenarios', 'eacces-config,flaky-timeout,perf-regression'); assert.ok(/期望实付 ≈ \$0\.705，上界 ≈ \$1\.787/.test(pt3.stdout), pt3.stdout)
      assert.notEqual(cli('plan-traj', '--scenarios', 'nope').status, 0)
      // 策略 champion（provisional）+ L2 champion 更好 ⇒ 没有路径等价校准时只能 pending-parity
      fs.mkdirSync(path.join(tmp, 'offline'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'offline/champion.json'), JSON.stringify({ schema: 'cfb.champion/3', knobs: {}, policy: 'p-abc', adoption: 'provisional', previous: { knobs: {}, policy: 'base' }, adopted: [{ round: 1, lever: 'policy', value: 'p-abc' }] }))
      const l2 = []; for (const t of ['eacces-config', 'flaky-timeout', 'perf-regression']) for (const smp of [0, 1]) { l2.push({ task: t, variant: 'policy:p-abc', sample: smp, fixed: true, fixedAtRound: 2, rounds: 3, claim: 'fixed', verifiedAfterFix: true, proxyScore: 2 }); l2.push({ task: t, variant: 'policy:base', sample: smp, fixed: smp === 0, fixedAtRound: smp === 0 ? 4 : null, rounds: 4, claim: 'none', proxyScore: 1 }) }
      fs.writeFileSync(path.join(tmp, 'l2.json'), JSON.stringify(l2))
      const c1 = cli('confirm', '--results', path.join(tmp, 'l2.json'), '--map', 'champion=policy:p-abc,previous=policy:base'); assert.equal(c1.status, 0, c1.stdout + c1.stderr); assert.ok(/pending-parity/.test(c1.stdout) && /路径等价/.test(c1.stdout), c1.stdout)
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')).adoption, 'provisional')
      // 等价校准：auto vs policy:base 全平 ⇒ ok
      const par = []; for (const t of ['eacces-config', 'flaky-timeout']) for (const smp of [0, 1]) for (const v of ['auto', 'policy:base']) par.push({ task: t, variant: v, sample: smp, fixed: true, fixedAtRound: 3, rounds: 3, claim: 'fixed', verifiedAfterFix: true, compile: [{ ok: true }, { ok: true }] })
      fs.writeFileSync(path.join(tmp, 'par.json'), JSON.stringify(par))
      const c2 = cli('confirm', '--parity', '--results', path.join(tmp, 'par.json')); assert.equal(c2.status, 0, c2.stdout + c2.stderr); assert.ok(/路径等价校准（ok）/.test(c2.stdout), c2.stdout)
      const c3 = cli('confirm', '--results', path.join(tmp, 'l2.json'), '--map', 'champion=policy:p-abc,previous=policy:base'); assert.ok(/（confirmed）/.test(c3.stdout), c3.stdout)
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')).adoption, 'confirmed')
      // 飞轮样例槽：无飞轮 ⇒ 退出码 2；有一条通用赢稿 ⇒ 落策略（op exemplar）
      assert.equal(cli('policy-from-flywheel').status, 2)
      fs.mkdirSync(path.join(tmp, 'offline/train'), { recursive: true })
      const generic = '上一轮已把保存路径改到用户可写目录；先逐字核对被改文件的 old_text 是否仍存在，再跑一次验收命令确认报错消失；若仍 EACCES，下一步查目录 owner 而不是再改代码。'.repeat(3)
      fs.writeFileSync(path.join(tmp, 'offline/train/pairs.jsonl'), JSON.stringify({ schema: 'cfb.pref-pair/1', round: 2, task: 'flaky-timeout', split: 'dev', chosenText: generic, rejectedText: '也许修好了。', scores: { candidate: 2, control: 0 } }) + '\n')
      const pf = cli('policy-from-flywheel'); assert.equal(pf.status, 0, pf.stdout + pf.stderr); assert.match(pf.stdout, /op exemplar/)
      const pols = fs.readdirSync(path.join(tmp, 'offline/policies')); assert.equal(pols.length, 1); const pol = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/policies', pols[0]), 'utf8')); assert.equal(pol.patches[0].op, 'exemplar'); assert.equal(pol.origin.source, 'flywheel-exemplar'); assert.equal(pol.status, 'proposed')
      const ru = cli('ruler'); assert.ok(/效度.*valid  n=24/.test(ru.stdout) && /L1 角色判定：\*\*prescreen\*\*/.test(ru.stdout) && /脚注：轨迹级/.test(ru.stdout) && /天花板率（结构分=2）0\.827/.test(ru.stdout), ru.stdout)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('E1 端到端：adopt-provisional → propose 被拒 → confirm（L2 更差）⇒ rolled-back 恢复 previous → 曝光记账 → ruler/status 可读', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v4-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    const plan = (n) => JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/r' + n + '/plan.json'), 'utf8'))
    const fake = (p) => ({ schema: 'cfb.eval-report/1', complete: true, reservedUsd: 0.5, requestsReserved: 13, requestsRejected: [], results: p.jobs.filter((j) => j.kind === 'main').map((j) => ({ task: j.task, variant: j.variant, sample: j.sample, rule: { next: j.variant === 'candidate' ? 1 : 0, avoid: 1, falseDone: 0, bump: 0, reEdit: 0, repeat: 0 }, action: 'read' })) })
    const rep = (n) => { const f = path.join(tmp, 'rep' + n + '.json'); fs.writeFileSync(f, JSON.stringify(fake(plan(n)))); return f }
    try {
      let out = null
      for (let n = 1; n <= 3; n++) { const p = cli('plan', '--skip-aa', '--lever', 'closing=off'); assert.equal(p.status, 0, p.stdout + p.stderr); out = cli('ingest', '--round', String(n), '--report', rep(n)); assert.equal(out.status, 0, out.stdout + out.stderr) }
      assert.ok(/判定：adopt-provisional/.test(out.stdout) && /e 值（任意停时有效，v4）/.test(out.stdout), out.stdout)
      const champ = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')); assert.equal(champ.adoption, 'provisional'); assert.equal(champ.knobs.closing, 'off')
      const pr = cli('propose'); assert.notEqual(pr.status, 0); assert.match(pr.stderr + pr.stdout, /champion-provisional/)
      // L2：champion 反而更差（修不好 / 假宣称）⇒ 回滚
      const l2 = []; for (const t of ['eacces-config', 'wrong-model', 'flaky-timeout']) for (const s of [0, 1]) { l2.push({ task: t, variant: 'auto', sample: s, fixed: false, fixedAtRound: null, rounds: 5, claim: 'fixed', proxyScore: 2 }); l2.push({ task: t, variant: 'raw', sample: s, fixed: true, fixedAtRound: 3, rounds: 4, claim: 'fixed', verifiedAfterFix: true, proxyScore: 1 }) }
      fs.writeFileSync(path.join(tmp, 'l2.json'), JSON.stringify(l2))
      const cf = cli('confirm', '--results', path.join(tmp, 'l2.json'), '--map', 'champion=auto,previous=raw'); assert.equal(cf.status, 0, cf.stdout + cf.stderr); assert.ok(/rolled-back/.test(cf.stdout) && /回滚/.test(cf.stdout), cf.stdout)
      const after = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')); assert.equal(after.adoption, 'confirmed'); assert.equal(after.knobs.closing, champ.previous.knobs.closing); assert.equal(after.rolledBack.length, 1); assert.equal(after.adopted.length, 0)
      assert.ok(fs.existsSync(path.join(tmp, 'offline/ruler/confirm-1.json')) && fs.existsSync(path.join(tmp, 'offline/ruler/validity.jsonl')))
      const pr2 = cli('propose'); assert.equal(pr2.status, 0, pr2.stdout + pr2.stderr)
      const ru = cli('ruler'); assert.equal(ru.status, 0, ru.stdout + ru.stderr); assert.ok(/n=12/.test(ru.stdout) && /留出题曝光：.*×1/.test(ru.stdout) && /L2 基线/.test(ru.stdout), ru.stdout)
      const st = cli('status'); assert.ok(/采纳状态 confirmed/.test(st.stdout), st.stdout)
      const pending = cli('confirm', '--results', path.join(tmp, 'l2.json'), '--map', 'champion=auto,previous=raw'); assert.ok(/report-only/.test(pending.stdout), pending.stdout)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  // ── v4.3（v14.7）：子状态 / 到修好轮数 C 指数 / ICC / 六旗标回归 / Pareto 池 / 有界续跑 / 加难场景 ──
  await test('A12 子状态：29 条真实轨迹派生 ≥50 个可重放状态、家族仍是 3（不是新留出家族）；修好后的轮不成题；参数截断的轮不可重放', () => {
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    const states = rows.flatMap((r) => childStates(r))
    assert.ok(states.length >= 50, 'states ' + states.length); assert.ok(states.every((s) => s.replayable && s.replay.length && s.messages.length === (s.startRound - 1) * 2))
    const census = familyCensus(states, { holdoutFamilies: ['eacces-config'] }); assert.equal(census.families, 3); assert.equal(census.holdoutFamilies, 1); assert.match(census.note, /不是家族数/)
    for (const s of states) { const row = rows.find((r) => r.task === s.family && r.variant === s.parentVariant && (r.sample ?? 0) === s.parentSample && r.dir === s.id.split('#').pop()); assert.ok(row); if (Number.isInteger(row.fixedAtRound)) assert.ok(s.startRound <= row.fixedAtRound, '修好后的轮不成题') }
    const all = rows.flatMap((r) => childStates(r, { onlyReplayable: false })); assert.ok(all.length > states.length && all.some((s) => !s.replayable), '旧行 400 字截断的 edit 参数 ⇒ 不可重放')
    // 续跑结果按状态配对 + 相对起始轮的到修好轮数
    const vt = valueTable([{ fromState: 'x@r2', startRound: 2, variant: 'raw', fixedAtRound: 4 }, { fromState: 'x@r2', startRound: 2, variant: 'policy:base', fixedAtRound: 3 }, { fromState: 'y@r3', startRound: 3, variant: 'raw', fixedAtRound: null }, { fromState: 'y@r3', startRound: 3, variant: 'policy:base', fixedAtRound: 3 }])
    assert.equal(vt.states, 2); assert.deepEqual(vt.pairs, { win: 2, loss: 0 }); assert.equal(vt.table[0].arms.raw.meanRoundsToFix, 3)
    const cmp = outcomeComparison([{ arm: 'champion', task: 'x', fromState: 'x@r2', startRound: 2, fixedAtRound: 3 }, { arm: 'previous', task: 'x', fromState: 'x@r2', startRound: 2, fixedAtRound: 4 }, { arm: 'champion', task: 'x', fromState: 'x@r3', startRound: 3, fixedAtRound: 3 }, { arm: 'previous', task: 'x', fromState: 'x@r3', startRound: 3, fixedAtRound: null }])
    assert.equal(cmp.pairs.length, 2, '同家族不同状态按状态配对，不串'); assert.equal(cmp.pairs[0].champion.roundsToFix, 2); assert.equal(cmp.winRatio, Infinity); assert.equal(cmp.netBenefit, 1); assert.match(cmp.method, /GPC/)
  })
  await test('A13 到修好轮数口径：C 指数手算一致、删失只能当「更久」方、同轨迹对不计；真实 29 条轨迹上 C≈0.52 ⇒ invalid（六旗标对「还要几轮」没有信号）', () => {
    const c = concordanceIndex([{ proxy: 2, time: 2, event: 1 }, { proxy: 1, time: 4, event: 1 }, { proxy: 0, time: 6, event: 0 }, { proxy: 2, time: 3, event: 1 }])
    assert.equal(c.comparable, 6); assert.ok(Math.abs(c.c - 11 / 12) < 1e-9, '一致 5 对 + 平分 1 对 ⇒ 5.5/6')
    const same = concordanceIndex([{ proxy: 2, time: 1, event: 1, cluster: 'k' }, { proxy: 0, time: 3, event: 1, cluster: 'k' }], { crossClusterOnly: true }); assert.equal(same.comparable, 0)
    assert.equal(rulerValidityTTF([{ proxy: 1, time: 1, event: 1 }]).status, 'unvalidated')
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    const rv = retroValidity(rows); assert.ok(rv.timeToFix.c > 0.45 && rv.timeToFix.c < 0.6 && rv.timeToFix.status === 'invalid', JSON.stringify(rv.timeToFix)); assert.ok(rv.timeToFix.censored >= 10 && rv.timeToFix.crossClusterOnly)
    assert.equal(rv.flagWeights.status, 'diagnostic'); assert.ok(rv.flagWeights.aucLearnedCv < rv.flagWeights.aucHand, '簇留一下学到的权重不如手工 ±1 ⇒ 保留 ±1'); assert.match(rv.flagWeights.why, /保留 ±1/)
  })
  await test('A14 ICC 从已有数据估：手算一致、全同组内 ⇒ 1、全噪 ⇒ 0；mr 162 样本 ICC≈0.37（替代拍脑袋 0.3）；loadDesign 读 design.json', () => {
    const r = iccOneWay([[2, 2, 1], [1, 0, 1], [2, 2, 2], [0, 1, 0]]); assert.equal(r.groups, 4); assert.ok(Math.abs(r.icc - 0.686) < 0.01, JSON.stringify(r))
    assert.equal(iccOneWay([[1, 1], [3, 3], [5, 5]]).icc, 1); assert.equal(iccOneWay([[1, 3], [3, 1], [1, 3]]).icc, 0); assert.equal(iccOneWay([[1]]).icc, null)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl43-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }; delete env.DEEPSEEK_API_KEY
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    try {
      const ru = cli('ruler', '--write-design'); assert.equal(ru.status, 0, ru.stdout + ru.stderr)
      assert.match(ru.stdout, /ICC（同题同臂重复，实测）：mr 结构分 0\.3\d/); assert.match(ru.stdout, /Harrell C=0\.5\d.*invalid/); assert.match(ru.stdout, /子状态.*5\d 个 \/ 有数据的家族 3（留出 1）；可用场景家族 5（留出 2/)
      const d = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/ruler/design.json'), 'utf8')); assert.ok(d.icc > 0.3 && d.icc < 0.45 && /transfer\/mr/.test(d.source))
      const st = cli('states'); assert.equal(st.status, 0, st.stdout + st.stderr); assert.match(st.stdout, /子状态 5\d 个/); assert.match(st.stdout, /eacces-config×\d+\[holdout\]/)
      const arr = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/states/all.json'), 'utf8')); assert.ok(Array.isArray(arr) && arr.length >= 50 && arr[0].schema === 'cfb.child-state/1')
      const fam = cli('states', '--family', 'eacces-config', '--max-per-row', '2'); assert.match(fam.stdout, /家族 1（留出家族 1）/)
      // plan-traj --from-states --stop：单位 = 状态、命令带 --from-state/--store-text、stop 块有 α / 比较臂 / 上界；traj-run --dry-run 重放全部状态且零请求
      const pt = cli('plan-traj', '--from-states', path.join(tmp, 'offline/states/eacces-config.json'), '--samples', '1', '--max-rounds', '6', '--stop'); assert.equal(pt.status, 0, pt.stdout + pt.stderr)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t1/plan.json'), 'utf8')); assert.equal(plan.fromStates.count, 14); assert.deepEqual(plan.scenarios, []); assert.equal(plan.stop.alpha, 0.1); assert.equal(plan.stop.compare.champion, 'policy:base'); assert.equal(plan.stop.capUsd, plan.cost.capUsd); assert.ok(plan.storeText)
      assert.match(plan.command, /--store-text --from-state .*eacces-config\.json/); assert.match(pt.stdout, /有界续跑/)
      const dry = spawnSync(process.execPath, [path.join(ROOT, 'tools/traj-run.mjs'), '--plan', path.join(tmp, 'runtime/t1/plan.json'), '--store-text', '--from-state', path.join(tmp, 'offline/states/eacces-config.json'), '--variants', 'raw', '--policy', 'base', '--samples', '1', '--max-rounds', '6', '--fork', '--max-tokens', '8000', '--require-fp', '--base-url', 'http://127.0.0.1:9', '--model', 'm', '--out', path.join(tmp, 'runtime/t1'), '--dry-run'], { cwd: ROOT, env, encoding: 'utf8' })
      assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /dry-run：任务 28（14 个起点 × 2 臂 × 1 样本）、组 14；子状态重放成功 28/); assert.match(dry.stdout, /未发任何请求/)
      assert.ok(!fs.existsSync(path.join(tmp, 'runtime/t1/results.jsonl')))
      // 加难场景计划：scenarios 带 :decoy，traj-run 认得；参数不一致被拒
      const p2 = cli('plan-traj', '--perturb', 'decoy', '--samples', '1', '--max-rounds', '6', '--stop', '--cap-usd', '1.2'); assert.equal(p2.status, 0, p2.stdout + p2.stderr)
      const plan2 = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t2/plan.json'), 'utf8')); assert.deepEqual(plan2.scenarios, TRAJ_TASKS.map((t) => t.id + ':decoy')); assert.equal(plan2.stop.capUsd, 1.2); assert.match(plan2.purpose, /诱饵/)
      const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools/traj-run.mjs'), '--plan', path.join(tmp, 'runtime/t2/plan.json'), '--variants', 'raw', '--policy', 'base', '--only', 'eacces-config', '--samples', '1', '--max-rounds', '6', '--fork', '--out', path.join(tmp, 'runtime/t2'), '--dry-run'], { cwd: ROOT, env, encoding: 'utf8' })
      assert.notEqual(bad.status, 0); assert.match(bad.stderr, /traj-plan-mismatch:only/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A15 加难场景（零 API）：decoy 加一个诱饵源文件 + README 误导；fixed/canned 不变、原任务不被改；未知扰动被拒', () => {
    for (const t of TRAJ_TASKS) {
      const d = perturbTask(t, 'decoy'); assert.equal(d.id, t.id + ':decoy'); assert.equal(d.perturb, 'decoy')
      const added = Object.keys(d.files).filter((f) => !(f in t.files) && f !== 'README.md'); assert.equal(added.length, 1); assert.match(added[0], /\.legacy\.m?js$/); assert.match(d.files['README.md'], /排查时先看/)
      assert.ok(!t.files[added[0]] && !/排查时先看/.test(t.files['README.md'] || ''), '原任务对象未被改')
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'decoy-')); try { for (const [f, c] of Object.entries(d.files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c) } assert.equal(d.fixed(repo), false, '加了诱饵不算修好') } finally { fs.rmSync(repo, { recursive: true, force: true }) }
    }
    assert.equal(perturbTask(TRAJ_TASKS[0], 'none'), TRAJ_TASKS[0]); assert.throws(() => perturbTask(TRAJ_TASKS[0], 'swap'), /unknown-perturb/)
  })
  await test('A16 Pareto 池（GEPA 式）：按题前沿、被支配者出局、父代抽样概率 ∝ 上榜次数、无数据回退 champion；泛化差距旗标', () => {
    const mx = { base: { a: 1, b: 2, c: 1 }, p1: { a: 2, b: 1, c: 1 }, p2: { a: 1, b: 1, c: 0 } }
    const pf = paretoFront(mx); assert.deepEqual(pf.front.sort(), ['base', 'p1']); assert.deepEqual(pf.dominated, ['p2']); assert.deepEqual(pf.byTask.c.sort(), ['base', 'p1']); assert.equal(pf.frontCount.p2, 0)
    const picks = {}; for (let s = 1; s <= 200; s++) { const p = pickParent(mx, { seed: s }).parent; picks[p] = (picks[p] || 0) + 1 }; assert.ok(picks.base > 50 && picks.p1 > 50 && !picks.p2, JSON.stringify(picks))
    assert.equal(pickParent({}, { fallback: 'champ' }).parent, 'champ')
    const h = { hypotheses: { k1: { lever: 'policy', value: 'p1', championPolicy: 'base', outcomes: [{ task: 'a', candidate: 2, control: 1 }, { task: 'b', candidate: 1, control: 2 }, { task: 'a', candidate: 2, control: 1 }] }, k2: { lever: 'closing', value: 'off', championPolicy: 'base', outcomes: [{ task: 'c', candidate: 1, control: 1 }] } } }
    const m = scoreMatrix(h); assert.deepEqual(m.p1, { a: 2, b: 1 }); assert.deepEqual(m.base, { a: 1, b: 2, c: 1 }, 'knob 假设的 control 也算 champion 策略的分，candidate 不算策略')
    const g = generalizationGap({ dev: { n: 6, wins: 6, losses: 0 }, holdout: { n: 4, wins: 1, losses: 1 } }); assert.equal(g.flag, 'suspected-overfit'); assert.equal(g.gap, 1)
    assert.equal(generalizationGap({ dev: { n: 6, wins: 6, losses: 0 }, holdout: { n: 4, wins: 4, losses: 0 } }).flag, 'ok'); assert.equal(generalizationGap({ dev: { n: 6, wins: 6, losses: 0 }, holdout: { n: 2, wins: 0, losses: 2 } }).flag, 'ok', '留出 < 4 对不打旗')
  })
  await test('A17 六旗标回归：类别单一 / 样本不足 ⇒ unvalidated；可分数据学到正负号正确且簇留一 AUC 报出', () => {
    assert.equal(fitFlagWeights(Array.from({ length: 20 }, (_, i) => ({ flags: { next: 1 }, outcome: 1, cluster: i }))).status, 'unvalidated')
    const pairs = []; for (let i = 0; i < 40; i++) { const good = i % 2 === 0; pairs.push({ flags: { next: good ? 1 : 0, avoid: 1, falseDone: good ? 0 : 1, bump: 0, reEdit: 0, repeat: 0 }, outcome: good ? 1 : 0, cluster: 'c' + (i % 8) }) }
    const r = fitFlagWeights(pairs); assert.equal(r.status, 'diagnostic'); assert.ok(r.weights.next > 0 && r.weights.falseDone < 0, JSON.stringify(r.weights)); assert.ok(r.aucLearnedCv > 0.9 && r.aucHand > 0.9)
  })
  await test('A18 新家族（零 API）：wrong-model / sse-truncated 落成可执行场景 —— 起始未修好、可见测试是绿的、复现脚本真跑出症状；隐藏 oracle：改脚本不算、两种真修法都算、sse 只改一处不算、改坏不算；decoy 也能加', () => {
    const { execTool } = tr
    assert.deepEqual(TRAJ_TASKS.map((t) => t.id), ['eacces-config', 'flaky-timeout', 'perf-regression', 'wrong-model', 'sse-truncated'])
    const mk = (id) => { const t = TRAJ_TASKS.find((x) => x.id === id); const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-')); materialize(t, repo); return { t, repo } }
    const tmps = []
    try {
      // wrong-model
      let { t, repo } = mk('wrong-model'); tmps.push(repo)
      assert.equal(t.fixed(repo), false); assert.match(execTool(t, repo, 'bash', { command: 'npm test' }), /PASS test\/host-follow\.selftest\.mjs[\s\S]*1 通过 \/ 0 失败/)
      assert.match(execTool(t, repo, 'bash', { command: 'node scripts/smoke-session.mjs' }), /\[compiler-transport-started\] \{"model":"deepseek-v3\.1"\}/)
      assert.match(execTool(t, repo, 'bash', { command: 'grep -c started trace/trace.log' }), /^3/); assert.match(execTool(t, repo, 'bash', { command: 'node -e "1"' }), /只允许运行题目里的测试/)
      assert.ok(!fs.existsSync(path.join(repo, '.oracle')), 'oracle 跑完即删')
      execTool(t, repo, 'edit_file', { path: 'scripts/smoke-session.mjs', old_text: "{ seq: 12, model: 'deepseek-v3.2' }", new_text: "{ seq: 12, model: 'deepseek-v3.1' }" }); assert.equal(t.fixed(repo), false, '改复现脚本不算修好')
      execTool(t, repo, 'edit_file', { path: 'src/host-follow.js', old_text: 'observe(options) { if (options && options.model) lastModel = options.model }', new_text: 'observe(options, n) { const m = (n && n.model) || (options && options.model); if (m) lastModel = m }' }); assert.equal(t.fixed(repo), true, '修法 A：observe 读第二个参数')
      ;({ t, repo } = mk('wrong-model')); tmps.push(repo)
      execTool(t, repo, 'edit_file', { path: 'src/plugin.js', old_text: 'host.observe(options, n)', new_text: 'host.observe({ ...options, model: n && n.model }, n)' }); assert.equal(t.fixed(repo), true, '修法 B：调用方合并 model')
      assert.match(execTool(t, repo, 'bash', { command: 'node scripts/smoke-session.mjs' }), /\[compiler-transport-started\] \{"model":"deepseek-v3\.2"\}/)
      // sse-truncated
      ;({ t, repo } = mk('sse-truncated')); tmps.push(repo)
      assert.equal(t.fixed(repo), false); assert.match(execTool(t, repo, 'bash', { command: 'npm test' }), /1 通过 \/ 0 失败/)
      assert.match(execTool(t, repo, 'bash', { command: 'node scripts/replay-truncated.mjs' }), /"ok":true,"finish":"stop"[\s\S]*birth-condensed/)
      execTool(t, repo, 'edit_file', { path: 'src/transport.js', old_text: "finish: finish || (done ? 'stop' : null)", new_text: 'finish' }); assert.equal(t.fixed(repo), false, '只修 [DONE] 推断不够：ok 仍因有内容为 true')
      execTool(t, repo, 'edit_file', { path: 'src/transport.js', old_text: 'const ok = r.finish != null || r.out.length > 0', new_text: 'const ok = r.finish != null' }); assert.equal(t.fixed(repo), true, '两处都改才算')
      assert.match(execTool(t, repo, 'bash', { command: 'node scripts/replay-truncated.mjs' }), /"ok":false,"finish":null[\s\S]*birth-passthrough/)
      ;({ t, repo } = mk('sse-truncated')); tmps.push(repo)
      execTool(t, repo, 'edit_file', { path: 'src/transport.js', old_text: 'let out = ', new_text: 'let out = = ' }); assert.equal(t.fixed(repo), false); assert.match(execTool(t, repo, 'bash', { command: 'npm test' }), /^FAIL test\/transport/)
      for (const id of ['wrong-model', 'sse-truncated']) { const d = perturbTask(TRAJ_TASKS.find((x) => x.id === id), 'decoy'); assert.equal(Object.keys(d.files).filter((f) => /legacy/.test(f)).length, 1) }
      // 池里的 split：wrong-model 留出、sse-truncated dev ⇒ 场景家族 5、留出家族 2
      const pool = cyc.loadPool(); assert.equal(pool.split['wrong-model'], 'holdout'); assert.equal(pool.split['sse-truncated'], 'dev')
    } finally { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }) }
  })
  await test('A19 扰动惰性检查 + 续跑探针 + 单状态探针计划：decoy 在 21 条真实轨迹上 active（排查类调用命中 ≥ 80%）；raw 单臂计划 3 次主调用 ≈$0.038、stop 无配对只看上界；续跑探针字段', () => {
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    const r = perturbExposure(rows, { kind: 'decoy' }); assert.equal(r.n, 21); assert.equal(r.exposedBeforeFix, 21); assert.ok(r.searchRate >= 0.8, JSON.stringify(r)); assert.equal(r.verdict, 'active'); assert.match(r.note, /可见 ≠ 更难/)
    assert.ok(Object.values(r.byFamily).every((f) => f.verdict === 'active'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl43b-'))
    const env = { ...process.env, CFB_CYCLE_DIR: tmp }; delete env.DEEPSEEK_API_KEY
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/cfb-cycle.mjs'), ...a], { cwd: ROOT, env, encoding: 'utf8' })
    try {
      const pc = cli('perturb-check'); assert.equal(pc.status, 0, pc.stdout + pc.stderr); assert.match(pc.stdout, /21\/21[\s\S]*\*\*active\*\*/); assert.ok(fs.existsSync(path.join(tmp, 'offline/ruler/perturb-decoy.json')))
      const st = cli('states', '--family', 'eacces-config', '--start-round', '3', '--parent-variant', 'raw', '--limit', '1'); assert.match(st.stdout, /子状态 1 个/)
      const file = path.join(tmp, 'offline/states/eacces-config-probe1.json'); const arr = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(arr.length, 1); assert.equal(arr[0].startRound, 3); assert.equal(arr[0].parentVariant, 'raw')
      const p1 = cli('plan-traj', '--from-states', file, '--arms', 'raw', '--samples', '1', '--max-rounds', '5', '--stop'); assert.equal(p1.status, 0, p1.stdout + p1.stderr)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t1/plan.json'), 'utf8')); assert.equal(plan.cost.mains, 3); assert.equal(plan.cost.compresses, 0); assert.equal(plan.cost.expectedUsd, 0.038); assert.equal(plan.stop.compare, null); assert.match(p1.stdout, /单臂无配对，只按估算花费/)
      const p2 = cli('plan-traj', '--from-states', file, '--arms', 'raw,policy:base', '--samples', '1', '--max-rounds', '5', '--stop'); const plan2 = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t2/plan.json'), 'utf8')); assert.equal(plan2.cost.mains, 5); assert.equal(plan2.cost.compresses, 3); assert.equal(plan2.cost.expectedUsd, 0.085)
      const dry = spawnSync(process.execPath, [path.join(ROOT, 'tools/traj-run.mjs'), '--plan', path.join(tmp, 'runtime/t1/plan.json'), '--store-text', '--from-state', file, '--variants', 'raw', '--samples', '1', '--max-rounds', '5', '--fork', '--max-tokens', '8000', '--require-fp', '--base-url', 'http://127.0.0.1:9', '--model', 'm', '--out', path.join(tmp, 'runtime/t1'), '--dry-run'], { cwd: ROOT, env, encoding: 'utf8' })
      assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /子状态重放成功 1/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
} finally {
  console.log(`\n=== closed-loop-v4 selftest: ${pass} pass / ${fail} fail ===`)
  process.exit(fail ? 1 : 0)
}
})()
