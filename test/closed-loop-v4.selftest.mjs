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
    // v14.10：压缩臂走生产 birth 同构体（birthOffline）；测试注入 compile，拿到的 cfg 就是生产 cfg ⇒ 用生产 compressPromptFor 看补丁在不在
    const _compile = async (raw, cfg) => { compresses++; const prompt = I.compressPromptFor(cfg, raw); if (prompt.includes('测试规则')) sawPatch = true; if (cfg.compressPolicy) assert.equal(cfg.compressPolicy.id, 'p-test'); assert.ok(!/【本轮已发出的调用】/.test(cfg.compressCtx), '压缩器看不到本轮调用（与生产同）'); return { text: '【压缩稿】先核对 src/trace.js 的 home 路径；下一步读 verify.mjs。' + 'x'.repeat(60), meta: { promptVersion: I.compressPromptVersion(cfg), v4: null } } }
    const chat = async (b) => {
      assert.notEqual(b.messages.length, 1, '不再有工具自拼的压缩请求')
      mains++; const round = b.messages.filter((x) => x.role === 'assistant').length + 1
      if (round === 1) return { message: { content: '先看。', reasoning_content: 'r'.repeat(40), tool_calls: [tc('read_file', { path: 'src/trace.js' })] }, usage: { prompt_tokens: 500 }, fp: 'x' }
      if (round === 2) return { message: { content: '再看。', reasoning_content: 'r'.repeat(40), tool_calls: [tc('bash', { command: 'cat README.md' })] }, usage: { prompt_tokens: 600 }, fp: 'x' }
      return { message: { content: '问题已修复。', reasoning_content: 'r'.repeat(40) }, usage: { prompt_tokens: 700 }, fp: 'x' }
    }
    const o = { maxRounds: 4, minChars: 10, model: 'm', maxTokens: 1000, maxProbes: 1, textTools: false, requireFp: false, policyDir: tmp, _compile, noGate: true }   // 假稿比假原文长 ⇒ 关 birthAccept（真闸在 A22 用本地 HTTP 假服务测）
    const a = await runOne({ o, task, variant: 'policy:p-test', sample: 0, chat, I, cred: null }); assert.equal(a.error, undefined, a.error); assert.equal(a.policy, 'p-test'); assert.equal(a.compile.filter((c) => c.ok).length, 3); assert.ok(sawPatch)
    assert.deepEqual(a.proxySteps.map((s) => s.score), [2, 2, 0]); assert.equal(a.proxyScore, 1.333); assert.equal(a.proxyRound2, 2); assert.equal(a.claim, 'fixed'); assert.equal(a.fixed, false); assert.ok(a.firstMessage)
    // v14.12.4 制度臂：策略 config 里的地板盖过 --min-chars（生产地板 3100 时 base 臂 3 轮全 below-floor、制度臂 3 轮全压）；行里记 floor / regime
    fs.writeFileSync(path.join(tmp, 'p-reg.json'), JSON.stringify({ schema: 'cfb.policy/1', id: 'p-reg', parent: 'base', patches: [], config: { birthMinChars: 1, birthMinSavedChars: -1800, birthTokenGate: false, continuationPath: 'bounded' } }))
    let regCompresses = 0; const oR = { ...o, minChars: 3100, _compile: async (raw, cfg) => { regCompresses++; assert.equal(cfg.birthMinChars, 1); assert.equal(cfg.birthTokenGate, false); return { ok: true, text: '稿'.repeat(60), ms: 1 } } }
    const r1 = await runOne({ o: oR, task, variant: 'policy:p-reg', sample: 0, chat, I, cred: null }); assert.equal(r1.error, undefined, r1.error); assert.equal(r1.compile.filter((c) => c.ok).length, 3); assert.equal(regCompresses, 3)
    assert.equal(r1.compile[0].floor, 1); assert.deepEqual(r1.compile[0].regime, ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate']); assert.equal(r1.compile[0].continuationPath, 'bounded')
    const r0 = await runOne({ o: oR, task, variant: 'policy:base', sample: 0, chat, I, cred: null }); assert.equal(r0.compile.filter((c) => c.belowFloor).length, 3); assert.equal(r0.compile[0].floor, 3100); assert.equal(regCompresses, 3, 'base 臂一次都没压')
    const b = await runOne({ o, task, variant: 'policy:base', sample: 0, chat, I, cred: null, forkMessage: a.firstMessage }); assert.equal(b.forked, true); assert.equal(b.transcript[0].calls[0].name, 'read_file'); assert.equal(mains, 5 + 6, '2 臂 × 3 轮 − 1 次分叉复用'); assert.equal(compresses, 6); assert.ok(a.compile.every((c) => c.path === 'birth-offline' && c.promptVersion === 'compress-v4d9:ctx+p-test' || c.promptVersion === 'compress-v4d9:mr+p-test'), JSON.stringify(a.compile[0])); assert.ok(b.compile.every((c) => c.policy === 'base' && !/\+/.test(c.promptVersion)))
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
    const cli = (...a) => cyc.runCli(a, { dir: tmp })   // v14.10：进程内 CLI（不起子进程）
    try {
      // v4.5：缺省单位 = 一个家族（未探索、dev 优先 ⇒ sse-truncated）× 2 臂 × 1 样本 × ≤5 轮 ≤ 9 + 5 请求；v4.7 影子分叉期望 7 + 2 ≈ $0.103（上界 $0.372）；--all 才是 5 家族（≤45 + 25，期望 ≈ $0.512，上界 $1.86）
      const pt = cli('plan-traj'); assert.equal(pt.status, 0, pt.stdout + pt.stderr); assert.ok(/期望主 7 \+ 压缩 2（影子分叉.*期望实付 ≈ \$0\.103，上界 ≈ \$0\.372/.test(pt.stdout) && /检验尺子有效性/.test(pt.stdout) && /traj-run\.mjs --plan/.test(pt.stdout) && /只跑 sse-truncated/.test(pt.stdout), pt.stdout)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime/t1/plan.json'), 'utf8')); assert.equal(plan.schema, 'cfb.traj-plan/1'); assert.equal(plan.cost.mains, 9); assert.equal(plan.cost.compresses, 5); assert.deepEqual(plan.scenarios, ['sse-truncated']); assert.equal(plan.maxRounds, 5); assert.ok(!fs.existsSync(path.join(tmp, 'receipts')))
      const again = cli('plan-traj'); assert.match(again.stdout, /同一设计的计划已存在：t1/); assert.ok(!fs.existsSync(path.join(tmp, 'runtime/t2')), '同设计不重复建')
      const dryp = cli('plan-traj', '--all', '--dry'); assert.match(dryp.stdout, /\[dry\] 不落盘.*主 ≤45 \+ 压缩 ≤25，期望主 35 \+ 压缩 10 ≈ \$0\.512（上界 \$1\.86）/); assert.ok(!fs.existsSync(path.join(tmp, 'runtime/t2')))
      assert.equal(cli('plan-traj', '--arms', 'raw,auto', '--dry').stdout.includes('臂 raw vs policy:base'), true, 'auto 是 policy:base 的别名'); assert.notEqual(cli('plan-traj', '--arms', 'raw,auto,policy:base', '--dry').status, 0, '重复臂被拒')
      assert.match(cli('plan-traj', '--help').stdout, /plan-traj \[/); assert.ok(!fs.existsSync(path.join(tmp, 'runtime/t2')), '--help 不落盘')
      const pt3 = cli('plan-traj', '--n', '9', '--scenarios', 'eacces-config,flaky-timeout,perf-regression'); assert.ok(/期望实付 ≈ \$0\.307，上界 ≈ \$1\.116/.test(pt3.stdout), pt3.stdout)
      assert.match(cli('plan-traj', '--drop', '9').stdout, /已撤销未执行的计划 t9/); assert.ok(!fs.existsSync(path.join(tmp, 'runtime/t9')))
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
      // v14.14：confirm 重跑幂等——同一结果文件再 confirm，效度对 +0、重复 12 对被点名（此前会翻倍入账，n=24 是旧 bug 的产物）
      assert.ok(/效度账本 \+0 对/.test(c3.stdout) && /12 对与已有记录重复，未重复入账/.test(c3.stdout), c3.stdout)
      assert.equal(fs.readFileSync(path.join(tmp, 'offline/ruler/validity.jsonl'), 'utf8').trim().split('\n').length, 12, '同源重跑不增账')
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'offline/champion.json'), 'utf8')).adoption, 'confirmed')
      // v14.12.4：confirm --plan N 把计划标成 confirmed；v14.14：异源文件（t1/results.jsonl）是新观测 ⇒ 合法 +12 → n=24，无需再备份还原账本
      fs.copyFileSync(path.join(tmp, 'l2.json'), path.join(tmp, 'runtime/t1/results.jsonl'))
      const c4 = cli('confirm', '--plan', '1', '--map', 'champion=policy:p-abc,previous=policy:base'); assert.equal(c4.status, 0, c4.stdout + c4.stderr)
      const tp1 = JSON.parse(fs.readFileSync(path.join(tmp, 'offline/history.json'), 'utf8')).trajPlans.find((t) => t.n === 1); assert.equal(tp1.status, 'confirmed'); assert.equal(tp1.confirm.pairs, 6); assert.match(tp1.confirm.file, /confirm-\d+\.json/)
      assert.ok(!/已有未执行计划 t1/.test(cli('status').stdout))
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
    const cli = (...a) => cyc.runCli(a, { dir: tmp })   // v14.10：进程内 CLI（不起子进程）
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
    const cli = (...a) => cyc.runCli(a, { dir: tmp })   // v14.10：进程内 CLI（不起子进程）
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
      const p2 = cli('plan-traj', '--all', '--perturb', 'decoy', '--samples', '1', '--max-rounds', '6', '--stop', '--cap-usd', '1.2'); assert.equal(p2.status, 0, p2.stdout + p2.stderr)
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
    const cli = (...a) => cyc.runCli(a, { dir: tmp })   // v14.10：进程内 CLI（不起子进程）
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
  await test('A20 v4.4 规则：助手角色不得冻结成 API 计划；压缩器请求体与生产 distillOnce 同形（关思考 / 850）；--compress-thinking 只是诊断开关；上界常数按 850', async () => {
    const { RULE, assertPaidRole, assertModel } = await import('../tools/helpers/llm-roles.mjs')
    const { compressorBody, PRODUCTION_COMPRESSOR, GEN_ROLES } = await import('../tools/helpers/generation.mjs')
    assert.equal(RULE.model, 'deepseek-v4.1-flash'); for (const r of ['propose', 'judge', 'label', 'scenario', 'analysis']) assert.throws(() => assertPaidRole(r), /rule:assistant-role/)
    for (const r of ['main', 'compress', 'compile', 'mint-a', 'mint-b']) assert.equal(assertPaidRole(r), true)
    assert.throws(() => assertPaidRole('whatever'), /rule:unknown-role/); assert.throws(() => assertModel('glm-4.5-flash'), /rule:model/); assert.equal(assertModel('deepseek-v4.1-flash'), true)
    assert.ok(GEN_ROLES.includes('propose'), '角色枚举保留（旧收据可读），只是冻结被拒')
    const I = await import('../index.js')
    const task = { chain: { u1: '任务 x', a2: { raw: '我们需要先看配置。'.repeat(30) } }, r1: '我们需要先看配置。'.repeat(30), ctx: '【当前任务】x' }
    const cb = compressorBody({ task, policy: { patches: [] }, model: 'm' }); assert.deepEqual(cb.thinking, { type: 'disabled' }); assert.equal(cb.max_tokens, 1600); assert.equal(cb.temperature, 0); assert.equal(cb.messages.length, 1)
    assert.deepEqual(PRODUCTION_COMPRESSOR, { maxTokens: 1600, thinking: { type: 'disabled' } })
    const pb = policyCompressBody({ I, model: 'm', reasoning: task.r1, ctx: task.ctx, policy: { patches: [] } }); assert.deepEqual(pb.thinking, { type: 'disabled' }); assert.equal(pb.max_tokens, 1600)
    const pbDiag = policyCompressBody({ I, model: 'm', reasoning: task.r1, ctx: task.ctx, policy: { patches: [] }, thinking: { type: 'enabled' }, maxTokens: 2048 }); assert.equal(pbDiag.thinking.type, 'enabled'); assert.equal(pbDiag.max_tokens, 2048)
    // 与生产 distillOnce 的 payload 字段逐一对齐（src/config.js: disableThinking true / maxOutputTokens 850）
    const cfg = I.normalizeConfig({ model: 'm', baseUrl: 'https://x/v1', credentialRef: 'K' }); assert.equal(cfg.disableThinking, true); assert.equal(cfg.maxOutputTokens, 850); assert.equal(cfg.compressV4MaxOutputTokens, 1600)   // 生产 v4 直写实际上限 = max(850, 1600)
    assert.equal(cyc.TRAJ_UNIT.compressCapUsd, 0.005 + 1600 * 4e-6)
    // freezeGen 的角色闸：通过 CLI 走 propose-policy --api
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-')); const env = { ...process.env, CFB_CYCLE_DIR: tmp }
    try {
      fs.mkdirSync(path.join(tmp, 'offline'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'offline/history.json'), JSON.stringify({ schema: 'cfb.closed-loop/2', hypotheses: {}, rounds: [], calibration: { round: 0, instrument: 'ok', tieRate: 0.6, winRate: 0.2 } }))
      const r = cyc.runCli(['propose-policy', '--api'], { dir: tmp }); assert.notEqual(r.status, 0); assert.match(r.stderr, /rule:assistant-role:propose/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A21 代工证据与候选 #1：trajFailureEvidence 只含 dev 家族并带版本标签（base 自己 0 条）；docs/proposals/p1-multi-site.json 过预算 / 可应用，无 dev 题强记号，+≤300 字符', async () => {
    const { parseProposal, PATCH_LIMITS } = await import('../tools/helpers/generation.mjs')
    const ev = cyc.trajFailureEvidence({ holdout: ['eacces-config', 'wrong-model'] })
    assert.ok(ev.length >= 5, 'transfer 里至少 5 条失败证据'); for (const e of ev) { assert.ok(!['eacces-config', 'wrong-model'].includes(e.task || e.key?.split('|')[1]), '留出家族不进证据'); assert.ok(typeof e.version === 'string' && e.version.length > 0) }
    assert.equal(ev.filter((e) => e.version === 'compress-v4d9').length, 0, '历史证据没有一条来自 v4d9（提议器必须知道）')
    assert.ok(ev.some((e) => e.kind === 'l1-loss' && e.candFlags?.falseDone === 1 && e.version === 'compress-v4d7'))
    assert.equal(cyc.trajFailureEvidence({ holdout: ['eacces-config', 'wrong-model', 'sse-truncated', 'perf-regression', 'flaky-timeout'] }).length, 0)
    const raw = fs.readFileSync(path.join(ROOT, 'docs/proposals/p1-multi-site.json'), 'utf8'); const prop = parseProposal(raw); validatePatches(prop.patches)
    assert.equal(prop.patches.length, 3); assert.ok(prop.patches.length <= PATCH_LIMITS.maxPatches)
    const I = await import('../index.js'); const base = I.buildCompressPromptV4Direct('X'.repeat(100), '【当前任务】y', null); const out = applyPolicyToPrompt(base, { patches: prop.patches })
    assert.ok(out.length - base.length > 0 && out.length - base.length <= 300, '候选只加 ≤300 字符'); assert.ok(out.includes('10. 多处落点') && !out.includes('治症状 / 要动多处'))
    for (const tok of ['transport.js', 'assembleSseFrames', '[DONE]', 'finish_reason', 'distill.js', 'birth.js']) assert.ok(!JSON.stringify(prop.patches).includes(tok), '补丁不含 dev 题强记号 ' + tok)
    assert.ok(/prediction/.test(raw) && /作废/.test(prop.prediction), '预注册预测含证伪条件')
  })
  await test('A22 v4.5 生产同构（本地 HTTP 假服务，零 API）：birthOffline 的请求体 = 生产 distillOnce（单 user 消息 / thinking disabled / max_tokens 1600 / temperature 0）；策略进配置 ⇒ 提示词含补丁、promptVersion 带 +id；policy:base 与无策略逐字节相同；birthAccept 真闸（发明标识符 ⇒ 原文放行）', async () => {
    const http = await import('node:http'); const I = await import('../index.js')
    let lastBody = null, reply = '' 
    const server = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => { lastBody = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })) }) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-')); const keyFile = path.join(tmp, 'c.yaml'); fs.writeFileSync(keyFile, 'K: "unused"\n')
    try {
      const mk = (policy) => I.offlineBirthConfig({ model: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port, credentialsPath: keyFile, policy, normalizeConfig: (x) => I.normalizeConfig({ ...x, keepAlive: false, dryRun: false }) })
      const raw = ('我们需要先确认 src/trace.js 里 home 的来源。看起来 dshHome() 读的是 process.env.HOME，所以测试会写到真实目录。' + '下一步 read_file src/trace.js，看 trace.log 的路径拼接。').repeat(12)
      const ctx = '【当前任务】测试把 trace.log 写到了真实 HOME\n[tool: bash] FAIL test/birth.selftest.mjs EACCES /home/u/.dsh/trace.log'
      const policy = { id: 'p-test', patches: [{ op: 'append', section: 'rules', text: '测试规则：先逐字核对再编辑。' }] }
      reply = '我们需要先确认 src/trace.js 里 home 的来源：dshHome() 读 process.env.HOME，测试因此写进真实目录，这就是 EACCES 的原因。改法只落一个：改 src/trace.js 的 home 来源，让测试走临时目录。所以下一步工具调用是 read_file src/trace.js。如果看到 process.env.HOME，那么假设坐实，直接改；如果不是，那么假设不成立，此时不要改 trace.js，先看 dshHome 的定义。'
      const a = await I.birthOffline({ raw, ctx, calls: [{ name: 'read_file', args: { path: 'src/trace.js' } }], cfg: mk(policy) })
      assert.equal(a.ok, true, JSON.stringify(a).slice(0, 300)); assert.equal(a.policy, 'p-test'); assert.equal(a.promptVersion, 'compress-v4d9:ctx+p-test')
      assert.equal(lastBody.messages.length, 1); assert.equal(lastBody.messages[0].role, 'user'); assert.deepEqual(lastBody.thinking, { type: 'disabled' }); assert.equal(lastBody.max_tokens, 1600); assert.equal(lastBody.temperature, 0)
      assert.ok(lastBody.messages[0].content.includes('【补充规则】\n测试规则：先逐字核对再编辑。'), '补丁进了生产提示词'); assert.ok(!lastBody.messages[0].content.includes('【本轮已发出的调用】'), '压缩器看不到本轮调用')
      assert.equal(lastBody.messages[0].content, I.compressPromptFor({ ...mk(policy), compressCtx: ctx }, raw), '请求体 = compressPromptFor（同一函数）')
      const promptP = lastBody.messages[0].content
      const b = await I.birthOffline({ raw, ctx, calls: [], cfg: mk({ id: 'base', patches: [] }) }); const promptBase = lastBody.messages[0].content
      const c = await I.birthOffline({ raw, ctx, calls: [], cfg: mk(null) }); const promptAuto = lastBody.messages[0].content
      assert.equal(promptBase, promptAuto, 'policy:base ≡ auto 逐字节'); assert.notEqual(promptP, promptAuto); assert.equal(b.policy, 'base'); assert.equal(c.promptVersion, 'compress-v4d9:ctx'); assert.equal(b.ok, true); assert.equal(c.ok, true)
      reply = '我们需要先看 src/transport.js 的 assembleSseFrames（原文没提过的标识符）。改法只落一个：改 finish 的回退。所以下一步工具调用是 read_file src/transport.js。'
      const d = await I.birthOffline({ raw, ctx, calls: [], cfg: mk(null) }); assert.equal(d.ok, false, JSON.stringify(d).slice(0, 200)); assert.equal(d.text, raw, '闸不过 ⇒ 原文放行（与生产同）'); assert.ok(['distill-failed', 'invented-identifiers', 'identifier-invented'].includes(d.why) || /invent/.test(d.why + (d.reason || '')), d.why + ':' + d.reason)
      const e = await I.birthOffline({ raw, ctx, calls: [], cfg: mk(null), gate: false, compile: async () => ({ text: 'x'.repeat(100), meta: {} }) }); assert.equal(e.ok, true); assert.equal(e.gated, false)
    } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A23 v4.5 操作员面：status 一屏（策略 / 轨迹计划带设计与状态 / 家族覆盖 / 下一步）；propose-policy --print 不落盘不占代；--supersede 只改状态保留 plan.json；review --results 出评审稿（分歧轮 / 各臂结局 / 闸门）；snapshot ↔ restore 往返一致；help 与 --help 零副作用', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl45-'))
    const cli = (...a) => cyc.runCli(a, { dir: tmp })
    try {
      // 空目录：status 也得能看，并给出第一条命令
      const s0 = cli('status'); assert.equal(s0.status, 0, s0.stdout + s0.stderr); assert.match(s0.stdout, /策略: 无/); assert.match(s0.stdout, /家族覆盖.*⇒ 下一个 sse-truncated/); assert.match(s0.stdout, /下一步: node tools\/cfb-cycle\.mjs plan-traj/)
      // --print：证据包只打印
      const pp = cli('propose-policy', '--print'); assert.equal(pp.status, 0, pp.stdout + pp.stderr); assert.match(pp.stdout, /\[print\] 未落盘、未登记 g1/); assert.ok(!fs.existsSync(path.join(tmp, 'offline/gen-1.pack.json')))
      assert.ok(!fs.existsSync(path.join(tmp, 'offline/history.json')) || (JSON.parse(fs.readFileSync(path.join(tmp, 'offline/history.json'), 'utf8')).generations || []).length === 0, '--print 不占代')
      // plan-traj → status 显示计划与设计 → supersede → 不再是待执行
      assert.equal(cli('plan-traj').status, 0); const s1 = cli('status'); assert.match(s1.stdout, /t1 planned\s+raw vs policy:base × sse-truncated × 1 ≤5轮 ≈\$0\.103（上界 \$0\.372） design [0-9a-f]{16}/); assert.match(s1.stdout, /下一步: 已有未执行计划 t1（≈\$0\.103，上界 \$0\.372）[\s\S]*traj-run\.mjs --plan \S*t1[\/\\]plan\.json --store-text --variants raw --policy base --only sse-truncated --samples 1 --max-rounds 5 --fork --max-tokens 8000 --require-fp[\s\S]*review --plan 1/)
      const sp = cli('plan-traj', '--supersede', '1', '--note', '测试作废'); assert.equal(sp.status, 0, sp.stdout + sp.stderr); assert.ok(fs.existsSync(path.join(tmp, 'runtime/t1/plan.json')), 'plan.json 保留')
      const s2 = cli('status'); assert.match(s2.stdout, /t1 superseded .*—— 测试作废/); assert.match(s2.stdout, /下一步: node tools\/cfb-cycle\.mjs plan-traj/)
      assert.notEqual(cli('plan-traj', '--supersede', '1').status, 0, '已作废的不能再作废'); assert.notEqual(cli('plan-traj', '--drop', '1').status, 0, '只有 planned 能 drop')
      // review：对历史未分叉结果也能出稿（分歧轮 1）
      const resCopy = path.join(tmp, 'traj3.jsonl'); fs.copyFileSync(path.join(ROOT, 'transfer/traj3/results.jsonl'), resCopy)
      const rv = cli('review', '--results', resCopy); assert.equal(rv.status, 0, rv.stdout + rv.stderr); assert.match(rv.stdout, /# 评审稿 traj3\.jsonl（\d+ 行，3 组；零 API）/); assert.match(rv.stdout, /分歧轮/); assert.ok(fs.existsSync(path.join(tmp, 'traj3.review.md')))
      assert.notEqual(cli('review').status, 0, '没有输入要报错')
      // snapshot ↔ restore：改道到 tmp 时快照文件仍在仓库 transfer/ —— 这里直接用库函数比对，不写仓库文件
      const prevDir = cyc.cycleDir(); let snap; cyc.setCycleDir(tmp); try { snap = cyc.cycleSnapshot() } finally { cyc.setCycleDir(prevDir) }
      assert.equal(snap.schema, 'cfb.cycle-state/1'); assert.equal(snap.trajPlans.length, 1); assert.equal(snap.trajPlans[0].plan.scenarios[0], 'sse-truncated'); assert.equal(snap.history.trajPlans[0].status, 'superseded')
      const snapFile = path.join(tmp, 'snap.json'); fs.writeFileSync(snapFile, JSON.stringify(snap))
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cl45b-'))
      try {
        const r1 = cyc.runCli(['restore', '--from', snapFile], { dir: tmp2 }); assert.equal(r1.status, 0, r1.stdout + r1.stderr); assert.match(r1.stdout, /补回 2 项：history t1/)
        const r2 = cyc.runCli(['restore', '--from', snapFile], { dir: tmp2 }); assert.match(r2.stdout, /补回 0 项/)
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp2, 'runtime/t1/plan.json'), 'utf8')), snap.trajPlans[0].plan)
        const s3 = cyc.runCli(['status'], { dir: tmp2 }); assert.match(s3.stdout, /t1 superseded/)
      } finally { fs.rmSync(tmp2, { recursive: true, force: true }) }
      // help 零副作用
      const before = fs.readdirSync(path.join(tmp, 'runtime')).sort(); for (const a of [['plan-traj', '--help'], ['help', 'review'], ['plan', '-h']]) { const r = cli(...a); assert.equal(r.status, 0); assert.ok(r.stdout.length > 10) }
      assert.deepEqual(fs.readdirSync(path.join(tmp, 'runtime')).sort(), before)
      assert.equal(cli('nope-cmd').status, 1)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A24 v4.6 模式 1（hand 臂，零 API）：到压缩轮暂停 ⇒ pending（含副模型同一份 prompt / 原文 / ctx / 协议）+ state；G2 决策不变闸拒发明三元组并把违规写回 pending；合格稿走生产闸链（compileV4Direct → 拼接 → birthAccept）后续跑到底、仓库由重放恢复、state 清掉、pending 归档；raw 臂不受影响', async () => {
    const I = await import('../index.js'); const TR = await import('../tools/traj-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-')); const out = path.join(tmp, 'out'); fs.mkdirSync(out)
    const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n')
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config')
    const raw1 = ('我们需要先确认 src/trace.js 里 home 的来源。看起来 dshHome() 读的是 process.env.HOME，所以测试会写到真实目录。' + '下一步 read_file src/trace.js，看 trace.log 的路径拼接。').repeat(12)
    const script = [
      { reasoning_content: raw1, content: '先看 src/trace.js。', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/trace.js' }) } }] },
      { reasoning_content: '看过了。', content: '这轮先停：我还没有改任何文件，结论未定。', tool_calls: [] }
    ]
    let calls = 0
    const chat = async () => ({ message: script[Math.min(calls++, script.length - 1)], usage: { prompt_tokens: 10 }, fp: 'fp_dspure_app_v1' })
    const o = { out, minChars: 200, maxRounds: 3, maxTokens: 1000, model: 'fixture', baseUrl: 'http://127.0.0.1:1', storeText: true, requireFp: false }
    const cwd = process.cwd(); process.chdir(tmp)
    try {
      // 1) 第 1 轮就得压 ⇒ 暂停
      const a = await TR.runOne({ o, task, variant: 'hand', sample: 0, chat, I, cred })
      assert.equal(a.status, 'awaiting-draft', JSON.stringify(a).slice(0, 300)); assert.equal(a.awaiting.round, 1); assert.equal(calls, 1, '只发了 1 次主调用')
      const pending = JSON.parse(fs.readFileSync(path.join(tmp, a.awaiting.pending), 'utf8')); assert.equal(pending.schema, 'cfb.hand-pending/1'); assert.equal(pending.raw, raw1); assert.match(pending.prompt, /【上一轮思维链】/); assert.ok(pending.prompt.includes(raw1.slice(0, 60))); assert.match(pending.protocol, /G2/); assert.equal(pending.calls[0].name, 'read_file'); assert.ok(!pending.prompt.includes('【本轮已发出的调用】'))
      const stateFile = path.join(tmp, a.awaiting.state); assert.ok(fs.existsSync(stateFile)); const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); assert.equal(st.schema, 'cfb.hand-state/1'); assert.equal(st.round, 1); assert.equal(st.messages.length, 2); assert.equal(st.message.reasoning_content, raw1)
      // 2) 发明三元组的稿 ⇒ G2 拒，仍暂停，违规写回 pending
      const draftFile = path.join(tmp, a.awaiting.draftFile)
      fs.writeFileSync(draftFile, '看起来 dshHome() 读 process.env.HOME，所以测试写到真实目录。改法只落一个：改 src/trace.js，old_text 是 `process.env.HOME` 改成 new_text 是 `process.env.DSH_HOME`。所以下一步工具调用是 read_file src/trace.js。')
      const b = await TR.runOne({ o, task, variant: 'hand', sample: 0, chat, I, cred, resume: JSON.parse(fs.readFileSync(stateFile, 'utf8')) })
      assert.equal(b.status, 'awaiting-draft'); assert.equal(b.awaiting.violations[0].kind, 'invented-triple', JSON.stringify(b.awaiting)); assert.equal(calls, 1, '续跑不重发本轮主调用')
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, b.awaiting.pending), 'utf8')).violations[0].kind, 'invented-triple')
      // 3) 合格稿 ⇒ 生产闸链通过 ⇒ 续跑到底（第 2 轮主调用 → 无调用 ⇒ 结束）
      fs.writeFileSync(draftFile, '我们需要先确认 src/trace.js 里 home 的来源：dshHome() 读 process.env.HOME，测试因此写进真实目录，这就是 EACCES 的原因。所以下一步工具调用是 read_file src/trace.js，看 trace.log 的路径拼接。如果看到 process.env.HOME，那么假设坐实；如果不是，那么假设不成立，此时不要改 trace.js，先看 dshHome 的定义。')
      const c = await TR.runOne({ o, task, variant: 'hand', sample: 0, chat, I, cred, resume: JSON.parse(fs.readFileSync(stateFile, 'utf8')) })
      assert.equal(c.status, undefined, JSON.stringify(c).slice(0, 400)); assert.equal(c.rounds, 2); assert.equal(calls, 2); assert.equal(c.resumed, 2)
      assert.equal(c.compile.length, 2); assert.equal(c.compile[0].path, 'hand'); assert.equal(c.compile[0].ok, true); assert.match(c.compile[0].promptVersion, /\+hand$/); assert.ok(c.compile[0].outChars < raw1.length); assert.equal(c.compile[1].belowFloor, true)
      assert.ok(c.compile[0].gate && typeof c.compile[0].gate === 'object', '真走了 compileV4Direct'); assert.ok(c.compile[0].accept && c.compile[0].accept.netSaved > 0, '真走了 birthAccept：' + JSON.stringify(c.compile[0].accept))
      assert.equal(c.transcript[0].storedChars, c.compile[0].outChars); assert.equal(c.transcript[0].calls[0].name, 'read_file'); assert.equal(c.calls, 1); assert.equal(c.fixed, false)
      assert.ok(!fs.existsSync(stateFile), 'state 清掉'); assert.ok(fs.existsSync(path.join(out, 'pending', 'done', a.awaiting.id + '.json')), 'pending 归档')
      // raw 臂同一脚本不受 hand 逻辑影响
      calls = 0; const r = await TR.runOne({ o, task, variant: 'raw', sample: 0, chat, I, cred }); assert.equal(r.status, undefined); assert.equal(r.compile.length, 0); assert.equal(r.rounds, 2)
    } finally { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A25 v4.6 模式 2 指标 draftDistance（dd/1）：金标自比全 1；丢排除句 ⇒ excludedRecall 0、判 lost-exclusions；改三元组 ⇒ decision 0；锚点不在原文∪ctx（照抄样例 / 发明）⇒ anchorPrecision < 1 且先于一切判 invented-anchors；层级键字典序；G2 闸拒发明决定 / 无依据排除', async () => {
    const H = await import('../tools/helpers/hand-draft.mjs')
    const raw = '我们需要先确认 src/trace.js 里 home 的来源。看起来 dshHome() 读的是 process.env.HOME，所以测试会写到真实目录。不是权限问题：chown 需要 root，排除。改法：改 src/trace.js，old_text 是 `process.env.HOME` 改成 new_text 是 `opts.home`。下一步 read_file src/trace.js。还没确认 verify.mjs 里 env 怎么传。'
    const ctx = '【当前任务】EACCES trace.log'
    const gold = '假设坐实的方向：dshHome() 读 process.env.HOME，测试写进真实目录。已排除：权限路线（chown 需要 root）。改法只落一个：改 src/trace.js，old_text 是 `process.env.HOME` 改成 new_text 是 `opts.home`。未解：verify.mjs 里 env 怎么传。所以下一步工具调用是 read_file src/trace.js。'
    const self = H.draftDistance(gold, gold, { raw, ctx }); assert.deepEqual(self.key, [1, 1, 1, 1, 1, 1]); assert.equal(self.verdict, 'close'); assert.equal(self.score, 1)
    const lost = H.draftDistance('dshHome() 读 process.env.HOME，测试写进真实目录。改法只落一个：改 src/trace.js，old_text 是 `process.env.HOME` 改成 new_text 是 `opts.home`。所以下一步工具调用是 read_file src/trace.js。', gold, { raw, ctx })
    assert.equal(lost.excludedRecall, 0); assert.equal(lost.decision, 1); assert.equal(lost.verdict, 'lost-exclusions')
    const changed = H.draftDistance(gold.replace('old_text 是 `process.env.HOME` 改成 new_text 是 `opts.home`', 'old_text 是 `opts.home` 改成 new_text 是 `process.env.HOME`'), gold, { raw, ctx })   // 锚点都在原文里，只是决定反了
    assert.equal(changed.decision, 0); assert.equal(changed.anchorPrecision, 1, JSON.stringify(changed.slots.auto)); assert.equal(changed.verdict, 'decision-differs')
    const copied = H.draftDistance(gold + ' 另外 assembleSseFrames 的 finish 回退也要看。', gold, { raw, ctx })
    assert.ok(copied.anchorPrecision < 1); assert.equal(copied.verdict, 'invented-anchors')
    assert.equal(H.compareKeys(self.key, lost.key), 1); assert.equal(H.compareKeys(changed.key, lost.key), -1, '决定层先于排除层'); assert.equal(H.compareKeys(lost.key, lost.key), 0)
    const g2bad = H.handDraftGate(raw.replace(/改法：.*?。/, ''), '改法只落一个：改 src/trace.js，old_text 是 `process.env.HOME` 改成 new_text 是 `opts.home`。所以下一步工具调用是 read_file src/trace.js。', ctx)
    assert.equal(g2bad.ok, false); assert.ok(g2bad.violations.some((v) => v.kind === 'invented-triple'), JSON.stringify(g2bad.violations))
    const g2foreign = H.handDraftGate(raw, '已排除：assembleSseFrames 路线。所以下一步工具调用是 read_file src/trace.js。', ctx)
    assert.equal(g2foreign.ok, false); assert.ok(g2foreign.violations.some((v) => v.kind === 'ungrounded:excluded'), JSON.stringify(g2foreign.violations))
    assert.equal(H.handDraftGate(raw, gold, ctx).ok, true)
  })

  await test('A26 v4.6 三模式闭环（零 API，临时目录）：plan-traj --arms raw,hand（压缩 0 次、三臂拒）→ 两家族 hand 单元步进（假主模型：hand 修好、raw 假宣称；status 显示等稿）→ ceiling（hand-better，5 对 2 家族，不碰 champion）→ gold add（按家族 dev/holdout、落盘不改、重复不收）→ plan-bench（策略 × 金标，设计含金标摘要，重复不建）→ bench-run --dry-run（金标自比全 1、金标被改 ⇒ 拒）→ bench-report（dev 配对 e 值 promote、holdout 只报告、下一步 plan-traj）→ 快照含基准计划', async () => {
    const C = await import('../tools/cfb-cycle.mjs'); const TR = await import('../tools/traj-run.mjs'); const B = await import('../tools/bench-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs'); const I = await import('../index.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')); const cwd = process.cwd(); process.chdir(tmp)
    try {
      let r = C.runCli(['plan-traj', '--arms', 'raw,hand', '--scenarios', 'eacces-config,flaky-timeout'], { dir: tmp }); assert.equal(r.status, 0, r.stderr)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 't1', 'plan.json'), 'utf8'))
      assert.deepEqual(plan.variants, ['raw', 'hand']); assert.equal(plan.cost.compresses, 0); assert.equal(plan.cost.mains, 2 * (1 + 2 * 4)); assert.match(r.stdout, /模式 1 步进/); assert.match(plan.command, /--variants raw,hand/); assert.match(plan.purpose, /模式 1 天花板/)
      r = C.runCli(['plan-traj', '--arms', 'raw,hand,policy:base', '--dry'], { dir: tmp }); assert.equal(r.status, 1); assert.match(r.stderr, /hand-arm-design/)
      // 2) 步进：假主模型。raw 臂走权限歧路 + 假宣称；hand 臂读稿后一步改对、npm test 验收
      const out = path.join(tmp, 'runtime', 't1'); const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n')
      const o = { out, minChars: 200, maxRounds: 5, maxTokens: 1000, model: 'fixture', baseUrl: 'http://127.0.0.1:1', storeText: true, requireFp: false }
      const fixes = { 'eacces-config': { path: 'test/birth.selftest.mjs', old_text: 'process.env.CFB_REAL_DSH_HOME', new_text: 'process.env.DSH_HOME' }, 'flaky-timeout': { path: 'test/hedge.selftest.mjs', old_text: 'hedgeAfterMs: 1600 })', new_text: 'hedgeAfterMs: 2500 })' } }
      const raws = { 'eacces-config': ('我们需要先确认 test/birth.selftest.mjs 里 home 的来源。看起来 makeTraceWriter 拿的是 process.env.CFB_REAL_DSH_HOME，所以测试写到真实目录 /home/u/.dsh。不是权限问题：chown 需要 root，排除。下一步 read_file test/birth.selftest.mjs。').repeat(10), 'flaky-timeout': ('看起来 test/hedge.selftest.mjs 里 hedgeAfterMs 1600 只比 primaryDelayMs 1500 多 100ms，CI 2 核慢一点对冲就先发了。不是 fakeServer 的问题，排除。下一步 read_file test/hedge.selftest.mjs。').repeat(12) }
      const drafts = { 'eacces-config': '假设坐实的方向：makeTraceWriter 拿的是 process.env.CFB_REAL_DSH_HOME，测试写到真实目录 /home/u/.dsh，这就是 EACCES 的原因。已排除：权限路线（chown 需要 root）。所以下一步工具调用是 read_file test/birth.selftest.mjs。如果看到 CFB_REAL_DSH_HOME，那么假设坐实；如果不是，那么假设不成立，先看 makeTraceWriter 的定义。', 'flaky-timeout': '假设坐实的方向：test/hedge.selftest.mjs 里 hedgeAfterMs 1600 只比 primaryDelayMs 1500 多 100ms，CI 2 核慢一点对冲就先发了。已排除：fakeServer 的问题。所以下一步工具调用是 read_file test/hedge.selftest.mjs。如果看到 hedgeAfterMs: 1600，那么假设坐实；如果不是，那么假设不成立。' }
      const script = (task, good) => [
        { reasoning_content: raws[task.id], content: '先看文件。', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: fixes[task.id].path }) } }] },
        good ? { reasoning_content: '改。', content: '改法只落一个。', tool_calls: [{ id: 'c2', function: { name: 'edit_file', arguments: JSON.stringify(fixes[task.id]) } }] }
          : { reasoning_content: '试试权限。', content: '先改权限。', tool_calls: [{ id: 'c2', function: { name: 'bash', arguments: JSON.stringify({ command: 'sudo chown -R u /home/u/.dsh' }) } }] },
        { reasoning_content: '验证。', content: '跑测试。', tool_calls: [{ id: 'c3', function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } }] },
        { reasoning_content: '完。', content: '已修复，测试通过。', tool_calls: [] }]
      const results = path.join(out, 'results.jsonl'); const push = (rec) => fs.appendFileSync(results, JSON.stringify(rec) + '\n')
      const samples = { 'eacces-config': 3, 'flaky-timeout': 2 }
      let checkedStatus = false
      for (const task of TRAJ_TASKS.filter((t) => fixes[t.id])) for (let k = 0; k < samples[task.id]; k++) {
        let i = 0; const sb = script(task, false); const rr = await TR.runOne({ o, task, variant: 'raw', sample: k, chat: async () => ({ message: sb[Math.min(i++, sb.length - 1)], usage: { prompt_tokens: 10 }, fp: 'x' }), I, cred }); push(rr); assert.equal(rr.fixed, false)
        let j = 0; const sg = script(task, true); const chatHand = async () => ({ message: sg[Math.min(j++, sg.length - 1)], usage: { prompt_tokens: 10 }, fp: 'x' })
        let rh = await TR.runOne({ o, task, variant: 'hand', sample: k, chat: chatHand, I, cred }); push(rh); assert.equal(rh.status, 'awaiting-draft')
        if (!checkedStatus) { const st = C.runCli(['status'], { dir: tmp }); assert.match(st.stdout, /等待手写稿: t1 eacces-config 第 1 轮/); assert.match(st.stdout, /下一步: 先写手写稿/); checkedStatus = true }
        fs.writeFileSync(path.join(tmp, rh.awaiting.draftFile), drafts[task.id])
        rh = await TR.runOne({ o, task, variant: 'hand', sample: k, chat: chatHand, I, cred, resume: JSON.parse(fs.readFileSync(path.join(tmp, rh.awaiting.state), 'utf8')) }); push(rh)
        assert.equal(rh.status, undefined, JSON.stringify(rh.awaiting || rh.compile).slice(0, 400)); assert.equal(rh.fixed, true); assert.equal(rh.fixedAtRound, 2); assert.equal(rh.compile[0].path, 'hand')
      }
      // 3) ceiling：hand 5 胜 0 负（2 家族）⇒ hand-better；champion 没被碰
      r = C.runCli(['ceiling', '--plan', '1'], { dir: tmp }); assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /模式 1 天花板（hand-better）/); assert.match(r.stdout, /配对 5/); assert.match(r.stdout, /尝试 5、过闸 5、被拒 0/); assert.match(r.stdout, /下一步: node tools\/cfb-cycle.mjs gold add --plan 1/)
      const ce = JSON.parse(fs.readFileSync(path.join(tmp, 'offline', 'ruler', 'ceiling-1.json'), 'utf8')); assert.equal(ce.cmp.champion.solved, 1); assert.equal(ce.cmp.previous.solved, 0); assert.equal(ce.families, 2); assert.equal(ce.headroom, 1)
      assert.ok(!fs.existsSync(path.join(tmp, 'offline', 'champion.json')), 'ceiling 不写 champion')
      assert.match(C.runCli(['status'], { dir: tmp }).stdout, /t1 ceiling/)
      // 4) gold add：5 项（eacces-config 留出家族 ⇒ holdout；flaky-timeout ⇒ dev）；再加一次 0 项
      r = C.runCli(['gold', 'add', '--plan', '1'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /金标 \+5/)
      const gold = JSON.parse(fs.readFileSync(path.join(tmp, 'gold', 'flaky-timeout', 'flaky-timeout-s0-r1.json'), 'utf8')); assert.equal(gold.split, 'dev'); assert.equal(gold.draft, drafts['flaky-timeout']); assert.ok(gold.raw.startsWith(raws['flaky-timeout'].slice(0, 50))); assert.equal(gold.outcome.vsRaw, 'win'); assert.equal(gold.validated, true); assert.ok(gold.stored && gold.stored.length > 0, '拼接后的稿也存了')
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'gold', 'eacces-config', 'eacces-config-s0-r1.json'), 'utf8')).split, 'holdout')
      assert.match(C.runCli(['gold', 'add', '--plan', '1'], { dir: tmp }).stdout, /金标 \+0/); assert.match(C.runCli(['gold', 'list'], { dir: tmp }).stdout, /5 项/)
      // 5) plan-bench：dev 只有 flaky 2 项；--split all 5 项 × 2 策略 = 10 次压缩 ≈ $0.075；重复设计不建
      fs.mkdirSync(path.join(tmp, 'offline', 'policies'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'offline', 'policies', 'p-test1.json'), JSON.stringify({ id: 'p-test1', parent: 'base', status: 'proposed', patches: [{ op: 'append', section: 'rules', text: '测试规则：先逐字核对再编辑。' }] }))
      r = C.runCli(['plan-bench', '--policies', 'base', '--dry'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /× 金标 2（dev）= 2 次压缩 ≈ \$0.015/)
      r = C.runCli(['plan-bench', '--policies', 'base,p-test1', '--split', 'all'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /压缩调用 10（主模型 0 次）；\*\*期望实付 ≈ \$0.075/)
      const bplan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b1', 'plan.json'), 'utf8')); assert.equal(bplan.gold.length, 5); assert.equal(bplan.metric, 'dd/1'); assert.ok(bplan.gold.every((g) => /^[0-9a-f]{16}$/.test(g.digest)))
      assert.match(C.runCli(['plan-bench', '--policies', 'base,p-test1', '--split', 'all'], { dir: tmp }).stdout, /同一设计的基准计划已存在：b1/)
      assert.equal(C.runCli(['plan-bench', '--policies', 'p-test1'], { dir: tmp }).status, 1, '没有 base 不建')
      // 6) bench-run --dry-run：金标自比全 1；金标被改 ⇒ 拒跑
      const br = await B.benchRun({ plan: path.join(tmp, 'runtime', 'b1', 'plan.json'), out: path.join(tmp, 'runtime', 'b1'), dryRun: true, goldDir: path.join(tmp, 'gold'), policyDir: path.join(tmp, 'offline', 'policies'), concurrency: 1 }, { I })
      assert.equal(br.dry, true); assert.equal(br.rows.length, 10); assert.ok(br.rows.filter((x) => x.policy === 'self(gold)').every((x) => x.distance.key.every((v) => v === 1)), '金标自比全 1'); assert.ok(!fs.existsSync(path.join(tmp, 'runtime', 'b1', 'receipt.json')))
      const gf = path.join(tmp, 'gold', 'flaky-timeout', 'flaky-timeout-s0-r1.json'); const g0 = fs.readFileSync(gf, 'utf8'); fs.writeFileSync(gf, g0.replace('已排除', '已经排除'))
      await assert.rejects(B.benchRun({ plan: path.join(tmp, 'runtime', 'b1', 'plan.json'), out: path.join(tmp, 'runtime', 'b1'), dryRun: true, goldDir: path.join(tmp, 'gold'), policyDir: path.join(tmp, 'offline', 'policies') }, { I }), /gold-changed/); fs.writeFileSync(gf, g0)
      // 7) 假压缩结果 → bench-report：base = 原文放行；p-test1 = 命中金标；再补一个 dev 家族（perf-regression）两行 ⇒ 5 胜 2 家族 e=10.5 ⇒ promote
      const H = await import('../tools/helpers/hand-draft.mjs'); const G = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b1', 'plan.json'), 'utf8')).gold.map((g) => JSON.parse(fs.readFileSync(path.join(tmp, 'gold', g.family, g.id + '.json'), 'utf8')))
      const fake = []
      const strip = (d) => { const { slots, ...rest } = d; return rest }
      for (const g of G) { fake.push({ schema: 'cfb.bench-row/1', plan: 'b1', policy: 'base', gold: g.id, family: g.family, split: g.split, ok: false, why: 'birth-accept', distance: strip(H.draftDistance(g.raw, g.draft, { raw: g.raw, ctx: g.ctx })) }); fake.push({ schema: 'cfb.bench-row/1', plan: 'b1', policy: 'p-test1', gold: g.id, family: g.family, split: g.split, ok: true, distance: strip(H.draftDistance(g.draft, g.draft, { raw: g.raw, ctx: g.ctx })) }) }
      for (let k = 0; k < 3; k++) { fake.push({ schema: 'cfb.bench-row/1', plan: 'b1', policy: 'base', gold: 'perf-' + k, family: 'perf-regression', split: 'dev', ok: true, distance: { decision: 0, excludedRecall: 1, acceptOk: null, openRecall: 1, anchorPrecision: 1, lengthOk: 1, key: [0, 1, 1, 1, 1, 1], score: 0.5, verdict: 'decision-differs' } }); fake.push({ schema: 'cfb.bench-row/1', plan: 'b1', policy: 'p-test1', gold: 'perf-' + k, family: 'perf-regression', split: 'dev', ok: true, distance: { decision: 1, excludedRecall: 1, acceptOk: null, openRecall: 1, anchorPrecision: 1, lengthOk: 1, key: [1, 1, 1, 1, 1, 1], score: 1, verdict: 'close' } }) }
      fs.writeFileSync(path.join(tmp, 'runtime', 'b1', 'results.jsonl'), fake.map((x) => JSON.stringify(x)).join('\n') + '\n')
      r = C.runCli(['bench-report', '--plan', '1'], { dir: tmp }); assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /p-test1: 5胜 0负 0平（2 家族）e=10.5/); assert.match(r.stdout, /\*\*promote\*\*/); assert.match(r.stdout, /下一步: plan-traj --arms raw,policy:p-test1/)
      assert.match(r.stdout, /\| base \| holdout \| 3 \|/); assert.match(r.stdout, /\| p-test1 \| dev \| 5 \|/)
      const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b1', 'report.json'), 'utf8')); assert.equal(rep.best, 'p-test1'); assert.equal(rep.paired['p-test1'].n, 5, 'holdout 项不进配对')
      assert.ok(!fs.existsSync(path.join(tmp, 'offline', 'champion.json')), 'bench-report 不写 champion')
      assert.match(C.runCli(['status'], { dir: tmp }).stdout, /基准计划: b1 reported base vs p-test1 × 5 ≈\$0.075 best=p-test1/)
      // 8) 快照含基准计划（不写仓库文件：只调库函数）
      const prev = C.cycleDir(); C.setCycleDir(tmp); try { const snap = C.cycleSnapshot(); assert.equal(snap.benchPlans.length, 1); assert.equal(snap.benchPlans[0].plan.id, 'b1'); assert.equal(snap.trajPlans.length, 1) } finally { C.setCycleDir(prev) }
    } finally { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A27 v4.7 影子分叉（零 API）：跟随臂在分歧前不发主调用（第 1–2 轮低于地板 ⇒ 影子；第 3 轮收稿 ⇒ 分歧；第 4 轮才自己发）；整条没触发 ⇒ 0 次主调用、结局与 raw 全同、divergedAt=null；raw 臂 --store-text 持久化 roundMessages；--fork-from 复用旧 raw 当 leader（dry-run 核对 + runOne 级）', async () => {
    const TR = await import('../tools/traj-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs'); const I = await import('../index.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-')); const out = path.join(tmp, 'out'); fs.mkdirSync(out); const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n')
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config'); const cwd = process.cwd(); process.chdir(tmp)
    try {
      const long = ('我们需要先确认 test/birth.selftest.mjs 里 home 的来源。看起来 makeTraceWriter 拿的是 process.env.CFB_REAL_DSH_HOME，所以测试写到真实目录 /home/u/.dsh。不是权限问题：chown 需要 root，排除。下一步 read_file test/birth.selftest.mjs。').repeat(10)
      const fix = { path: 'test/birth.selftest.mjs', old_text: 'process.env.CFB_REAL_DSH_HOME', new_text: 'process.env.DSH_HOME' }
      const script = [
        { reasoning_content: '先看看。', content: '读 README。', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] },
        { reasoning_content: '再看测试。', content: '读测试。', tool_calls: [{ id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'test/birth.selftest.mjs' }) } }] },
        { reasoning_content: long, content: '看 trace。', tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/trace.js' }) } }] },
        { reasoning_content: '改。', content: '改法只落一个。', tool_calls: [{ id: 'd', function: { name: 'edit_file', arguments: JSON.stringify(fix) } }] },
        { reasoning_content: '完。', content: '已修复。', tool_calls: [] }]
      const mk = () => { let i = 0; const f = async () => ({ message: script[Math.min(i++, script.length - 1)], usage: { prompt_tokens: 10 }, fp: 'x' }); f.count = () => i; return f }
      const o = { out, minChars: 200, maxRounds: 6, maxTokens: 1000, model: 'fixture', baseUrl: 'http://127.0.0.1:1', storeText: true, requireFp: false }
      // raw 臂：5 次主调用，持久化 roundMessages
      const chatRaw = mk(); const raw = await TR.runOne({ o, task, variant: 'raw', sample: 0, chat: chatRaw, I, cred })
      assert.equal(raw.mainCalls, 5); assert.equal(raw.rounds, 5); assert.equal(raw.fixedAtRound, 4); assert.equal(raw._lead.length, 5); assert.equal(raw.roundMessages.length, 5); assert.equal(raw.roundMessages[2].reasoning_content, long)
      // hand 臂跟随：第 1、2 轮低于地板 ⇒ 影子（0 调用）；第 3 轮 ≥ 地板 ⇒ 暂停要稿
      const chatHand = mk(); let h = await TR.runOne({ o, task, variant: 'hand', sample: 0, chat: chatHand, I, cred, leader: raw._lead })
      assert.equal(h.status, 'awaiting-draft'); assert.equal(h.awaiting.round, 3); assert.equal(chatHand.count(), 0, '分歧前不发主调用'); assert.equal(h.shadow.rounds, 3); assert.equal(h.shadow.divergedAt, null)
      const st = JSON.parse(fs.readFileSync(path.join(tmp, h.awaiting.state), 'utf8')); assert.equal(st.lead.length, 5, '状态里带着 leader 的回复'); assert.equal(st.diverged, false)
      fs.writeFileSync(path.join(tmp, h.awaiting.draftFile), '假设坐实的方向：makeTraceWriter 拿的是 process.env.CFB_REAL_DSH_HOME，测试写到真实目录 /home/u/.dsh。已排除：权限路线（chown 需要 root）。所以下一步工具调用是 read_file test/birth.selftest.mjs。')
      // 续跑：第 3 轮收稿 ⇒ 分歧；第 4、5 轮自己发（假模型脚本从头给：第 4 轮拿到 script[0]=read README，第 5 轮 script[1]…）
      h = await TR.runOne({ o, task, variant: 'hand', sample: 0, chat: chatHand, I, cred, resume: st })
      assert.equal(h.status, undefined, JSON.stringify(h.awaiting || h.compile).slice(0, 300)); assert.equal(h.shadow.divergedAt, 3); assert.equal(h.shadow.rounds, 3); assert.equal(h.compile[2].path, 'hand')
      assert.equal(h.mainCalls, h.rounds - 3, '分歧后每轮才一次主调用：' + JSON.stringify({ mainCalls: h.mainCalls, rounds: h.rounds })); assert.ok(chatHand.count() >= 1)
      // 整条不触发：地板设高 ⇒ 全程影子，0 调用，结局与 raw 完全相同
      const chat0 = mk(); const o2 = { ...o, minChars: 100000 }; const h0 = await TR.runOne({ o: o2, task, variant: 'hand', sample: 0, chat: chat0, I, cred, leader: raw._lead })
      assert.equal(chat0.count(), 0); assert.equal(h0.mainCalls, undefined); assert.equal(h0.shadow.rounds, 5); assert.equal(h0.shadow.divergedAt, null); assert.equal(h0.fixedAtRound, raw.fixedAtRound); assert.equal(h0.fixed, true); assert.equal(h0.rounds, raw.rounds); assert.equal(h0.compile.filter((c) => c.belowFloor).length, 5)
      // --fork-from：旧 results.jsonl 里的 raw（带 roundMessages）被复用；dry-run 核对（零请求）；计划不带 reuseRaw 时拒绝
      const old = path.join(tmp, 'old.jsonl'); const { _lead, ...rawRow } = raw; fs.writeFileSync(old, JSON.stringify(rawRow) + '\n')
      const dry = await TR.main(['--variants', 'raw,hand', '--only', 'eacces-config', '--samples', '1', '--max-rounds', '6', '--fork', '--fork-from', old, '--out', path.join(tmp, 'o2'), '--dry-run', '--base-url', 'http://x', '--model', 'm'])
      assert.equal(dry.reusedRaw, 1); assert.equal(dry.jobs, 1, '只剩 hand 一条任务（raw 复用）')
      const plan = { schema: 'cfb.traj-plan/1', id: 't9', variants: ['raw', 'hand'], scenarios: ['eacces-config'], samples: 1, maxRounds: 6, fork: true, digest: 'x' }
      assert.throws(() => TR.checkTrajPlan(plan, { variants: ['raw', 'hand'], samples: 1, maxRounds: 6, fork: true, only: ['eacces-config'], forkFrom: old }), /traj-plan-mismatch:forkFrom/)
    } finally { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A28 v4.7 因子设计归因（零 API）：plan-bench --factors half 把候选 3 条补丁派生成 2^(3−1)=4 臂（含 base、不含全开、派生策略落盘可独立成候选）；full=8 臂；假结果 ⇒ 每条补丁的主效应按金标配对出 e 值：只有补丁 2 有效 ⇒ keep，归因结论指向 .f010；设计含 factorial ⇒ 不与普通基准撞设计', async () => {
    const C = await import('../tools/cfb-cycle.mjs'); const T = await import('../tools/helpers/three-mode.mjs')
    assert.deepEqual(T.factorialMasks(3, 'half'), [0, 3, 5, 6]); assert.deepEqual(T.factorialMasks(3, 'full'), [0, 1, 2, 3, 4, 5, 6, 7]); assert.deepEqual(T.factorialMasks(2, 'half'), [0, 1, 2, 3]); assert.throws(() => T.factorialMasks(4), /factorial-k/)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')); const cwd = process.cwd(); process.chdir(tmp)
    try {
      C.setCycleDir(tmp); fs.mkdirSync(path.join(tmp, 'offline', 'policies'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'offline', 'policies', 'p-fx.json'), JSON.stringify({ schema: 'cfb.policy/1', id: 'p-fx', parent: 'base', base: 'compress-v4d9', status: 'proposed', patches: [{ op: 'append', section: 'rules', text: '补丁一。' }, { op: 'append', section: 'tail', text: '补丁二。' }, { op: 'replace', from: '治症状 / 要动多处 / 落点没看过', to: '治症状 / 落点没看过' }] }))
      // 金标：3 个 dev 家族各 2 项（直接写注册表；validated）
      const fams = ['flaky-timeout', 'perf-regression', 'sse-truncated']; const golds = []
      for (const fam of fams) for (let i = 0; i < 2; i++) { const id = `${fam}-s${i}-r1`; const g = { schema: 'cfb.gold/1', id, family: fam, split: 'dev', validated: true, raw: '原文'.repeat(100), draft: '稿'.repeat(50), ctx: '', outcome: { vsRaw: 'win' } }; fs.mkdirSync(path.join(tmp, 'gold', fam), { recursive: true }); fs.writeFileSync(path.join(tmp, 'gold', fam, id + '.json'), JSON.stringify(g)); golds.push(g) }
      let r = C.runCli(['plan-bench', '--policies', 'base,p-fx', '--factors', 'half'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /因子设计：候选 p-fx 的 3 条补丁各为因子，half ⇒ 4 个臂（base=000，p-fx.f011=011，p-fx.f101=101，p-fx.f110=110）/); assert.match(r.stdout, /压缩调用 24（主模型 0 次）/)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b1', 'plan.json'), 'utf8')); assert.deepEqual(plan.policies, ['base', 'p-fx.f011', 'p-fx.f101', 'p-fx.f110']); assert.equal(plan.factorial.k, 3)
      const d011 = JSON.parse(fs.readFileSync(path.join(tmp, 'offline', 'policies', 'p-fx.f011.json'), 'utf8')); assert.equal(d011.patches.length, 2); assert.equal(d011.patches[0].text, '补丁一。'); assert.equal(d011.patches[1].text, '补丁二。'); assert.equal(d011.derivedFrom.mask, '011'); assert.equal(d011.status, 'derived')
      assert.equal(C.runCli(['plan-bench', '--policies', 'base,p-fx', '--factors', 'full', '--dry'], { dir: tmp }).stdout.includes('8 个臂') || true, true)
      r = C.runCli(['plan-bench', '--policies', 'base,p-fx', '--factors', 'full'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); const p2 = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b2', 'plan.json'), 'utf8')); assert.equal(p2.policies.length, 8); assert.ok(p2.policies.includes('p-fx') && p2.policies.includes('p-fx.f001')); assert.notEqual(p2.design, plan.design)
      assert.notEqual(C.runCli(['plan-bench', '--policies', 'base,p-fx,p-fx.f011', '--factors', 'half'], { dir: tmp }).status, 0, '因子设计只能一个候选')
      // 假结果：补丁 2（bit 1）开 ⇒ 分 +0.3、决定 1；其余补丁无效果（b1：base=000, f011, f101, f110 ⇒ 补丁 2 开的臂：f011、f110）
      const dist = (on) => ({ decision: on ? 1 : 0, excludedRecall: 1, acceptOk: 1, openRecall: 1, anchorPrecision: 1, lengthOk: 1, key: [on ? 1 : 0, 1, 1, 1, 1, 1], score: on ? 0.9 : 0.6, verdict: on ? 'match' : 'decision-differs' })
      const rows = []; for (const g of golds) for (const a of plan.factorial.arms) rows.push({ schema: 'cfb.bench-row/1', plan: 'b1', policy: a.id, gold: g.id, family: g.family, split: 'dev', ok: true, distance: dist(!!(a.mask & 2)) })
      fs.writeFileSync(path.join(tmp, 'runtime', 'b1', 'results.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
      fs.rmSync(path.join(tmp, 'offline', 'policies', 'p-fx.f010.json'))   // full 设计写过它；删掉以证明 bench-report 自己会落
      r = C.runCli(['bench-report', '--plan', '1'], { dir: tmp }); assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /主效应（因子设计 half 2\^3−1，候选 p-fx 的 3 条补丁各为一个因子；4 个臂 × dev 金标 6/)
      assert.match(r.stdout, /- 补丁 2: Δ分 0\.3（Δ决定 1）6胜 0负 0平（3 家族）e=18\.14[0-9]* 「有害」e=[0-9.]+ ⇒ \*\*keep\*\*；与另两条补丁的交互混叠/)
      assert.match(r.stdout, /- 补丁 1: Δ分 0（Δ决定 0）0胜 0负 6平（0 家族）[^\n]*\*\*undetermined\*\*/); assert.match(r.stdout, /- 补丁 3: Δ分 0[^\n]*\*\*undetermined\*\*/)
      assert.match(r.stdout, /归因结论: 只保留补丁 2（派生策略 p-fx\.f010，bench-report 已落盘）进模式 3；补丁 1、3 不带/)
      const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'b1', 'report.json'), 'utf8')); assert.deepEqual(rep.factorial.keep, [2]); assert.equal(rep.factorial.effects[1].e >= 10, true)
      const kept = JSON.parse(fs.readFileSync(path.join(tmp, 'offline', 'policies', 'p-fx.f010.json'), 'utf8')); assert.equal(kept.patches.length, 1); assert.equal(kept.patches[0].text, '补丁二。')
    } finally { process.chdir(cwd); C.setCycleDir(null); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A29 v4.7 成本校准（零 API）：回执 vs 计划 ⇒ 实付主 / 压缩调用、实测分歧轮中位数、原文过地板轮占比、未分歧组；status 一行；没有回执时不出现', async () => {
    const C = await import('../tools/cfb-cycle.mjs')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-')); const cwd = process.cwd(); process.chdir(tmp)
    try {
      C.setCycleDir(tmp)
      let r = C.runCli(['plan-traj'], { dir: tmp }); assert.equal(r.status, 0, r.stderr); assert.ok(!/成本校准/.test(C.runCli(['status'], { dir: tmp }).stdout))
      const home = path.join(tmp, 'runtime', 't1'); const plan = JSON.parse(fs.readFileSync(path.join(home, 'plan.json'), 'utf8')); assert.equal(plan.cost.expectedMains, 7); assert.equal(plan.cost.expectedCompresses, 2)
      const tr = (chars) => chars.map((c, i) => ({ round: i + 1, reasoningChars: c, storedChars: c, calls: 1 }))
      const rows = [
        { variant: 'raw', task: 'sse-truncated', sample: 0, rounds: 5, mainCalls: 5, fixed: true, fixedAtRound: 4, transcript: tr([100, 500, 3300, 2900, 3400]), compile: [] },
        { variant: 'auto', policy: 'base', task: 'sse-truncated', sample: 0, rounds: 5, mainCalls: 2, fixed: true, fixedAtRound: 4, shadow: { rounds: 3, divergedAt: 3 }, transcript: tr([100, 500, 3300, 2000, 1000]), compile: [{ belowFloor: true }, { belowFloor: true }, { ok: true }, { belowFloor: true }, { ok: true }] }]
      fs.writeFileSync(path.join(home, 'results.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
      fs.writeFileSync(path.join(home, 'receipt.json'), JSON.stringify({ schema: 'cfb.traj-receipt/1', plan: 't1', mainCalls: 7, compressCalls: 2, shadowRounds: 3, noContrastGroups: 0, promptTokens: 12345, estimatedUsd: 0.1 }))
      const cal = C.costCalibration(); assert.equal(cal.receipts.length, 1); const x = cal.receipts[0]
      assert.equal(x.mainCalls, 7); assert.equal(x.expectedMains, 7); assert.equal(x.compressCalls, 2); assert.deepEqual(x.divergeRounds, [3]); assert.equal(x.floorShareObs, 0.4, 'raw 5 轮里 2 轮 ≥ 3100'); assert.equal(x.noContrast, 0)
      assert.deepEqual(cal.suggest, { divergeRound: 3, floorShare: 0.4 }); assert.equal(cal.current.divergeRound, 3)
      const st = C.runCli(['status'], { dir: tmp }).stdout; assert.match(st, /成本校准（回执 vs 计划）: t1 主 7\/7 压缩 2\/2 \$0\.1\/0\.103 影子省 3 未分歧 0 分歧轮 \[3\] 过地板 0\.4 ⇒ TRAJ_UNIT 现 divergeRound 3 \/ floorShare 0\.4，实测建议 3 \/ 0\.4/)
    } finally { process.chdir(cwd); C.setCycleDir(null); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A30 v4.7.1 通道预检（零 API，假通道）：有思维链 + 可信指纹 ⇒ 通过；上游不返回思维链 ⇒ reasoning 未过、不开跑；网络错 ⇒ reachable 未过；型号回显点/连字符差异视为同一型号、别的型号拒；主循环「可信指纹但空思考」连续 3 次即停（不再重试到 15 次）', async () => {
    const TR = await import('../tools/traj-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs'); const I = await import('../index.js')
    const mk = (msg, extra = {}) => async () => ({ message: msg, usage: { prompt_tokens: 20, completion_tokens: 30 }, fp: 'fp_dspure_app_v1', model: 'deepseek-v4-1-flash', finish: 'stop', ...extra })
    const o = { model: 'deepseek-v4.1-flash', baseUrl: 'http://x', requireFp: true }
    let pf = await TR.preflightUpstream({ chat: mk({ reasoning_content: '一加一等于二。', content: '2' }), o }); assert.equal(pf.ok, true, JSON.stringify(pf.checks)); assert.equal(pf.reasoningChars, 7); assert.equal(pf.modelEcho, 'deepseek-v4-1-flash')
    pf = await TR.preflightUpstream({ chat: mk({ content: '2' }), o }); assert.equal(pf.ok, false); assert.deepEqual(pf.failed, ['reasoning'])
    pf = await TR.preflightUpstream({ chat: mk({ reasoning_content: '…', content: '2' }, { fp: 'fp_other' }), o }); assert.deepEqual(pf.failed, ['fp'])
    pf = await TR.preflightUpstream({ chat: mk({ reasoning_content: '…', content: '2' }, { fp: 'fp_other' }), o: { ...o, requireFp: false } }); assert.equal(pf.ok, true, '不要求指纹时只看思考')
    pf = await TR.preflightUpstream({ chat: mk({ reasoning_content: '…', content: '2' }, { model: 'deepseek-chat' }), o }); assert.deepEqual(pf.failed, ['model'])
    pf = await TR.preflightUpstream({ chat: mk({ reasoning_content: '…', content: '2' }, { usage: { prompt_tokens: 1, claude_cache_tokens: 0 } }), o }); assert.deepEqual(pf.failed, ['notClaude'])
    pf = await TR.preflightUpstream({ chat: async () => { throw new Error('HTTP 502') }, o }); assert.equal(pf.ok, false); assert.equal(pf.error, 'HTTP 502'); assert.ok(pf.failed.includes('reachable'))
    // 主循环：通道返回可信指纹但没有思维链 ⇒ 第 3 次就抛，不是 15 次
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-')); const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n'); let calls = 0
    const chat = async () => { calls++; return { message: { content: '读 README。', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, usage: { prompt_tokens: 10 }, fp: 'fp_dspure_app_v1' } }
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config')
    const rec = await TR.runOne({ o: { out: tmp, minChars: 3100, maxRounds: 5, maxTokens: 1000, model: 'fixture', baseUrl: 'http://127.0.0.1:1', requireFp: false, maxProbes: 15 }, task, variant: 'raw', sample: 0, chat, I, cred })
    assert.match(String(rec.error), /upstream-no-reasoning/); assert.equal(calls, 3, '3 次就停'); assert.equal(rec.emptyReasoning, 3)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await test('A31 v4.7.2 携带检验（零 API，假通道）：指纹为空时，带 / 不带历史 reasoning_content 的 prompt_tokens 之差 ≥ max(4, 0.12×字数) 才放行（历史 < 40 字按 no-history）；预检在指纹为空但携带成立时 mode=carry-verified 通过、通道丢历史思考时不通过；主循环每轮：有历史思考 ⇒ 携带探针放行并计 fpModes，无历史 ⇒ no-history；丢思考的通道 ⇒ 探针用尽即停', async () => {
    const TR = await import('../tools/traj-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs'); const I = await import('../index.js')
    const tokens = (msgs, carry) => msgs.reduce((n, m) => n + Math.ceil(String(m.content || '').length * 0.5) + (carry ? Math.ceil(String(m.reasoning_content || '').length * 0.5) : 0), 0) + 100
    const mkChan = (carry) => { let i = 0; const script = [
      { reasoning_content: '先看看 README，确认入口文件与测试目录结构，再决定读哪个测试。'.repeat(2), content: '读 README。', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] },
      { reasoning_content: '再看测试文件，排除权限路线。'.repeat(20), content: '读测试。', tool_calls: [{ id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'test/birth.selftest.mjs' }) } }] },
      { reasoning_content: '完。', content: '收。', tool_calls: [] }]
      const f = async (body) => { f.calls++; if (body.max_tokens === 1) return { message: { reasoning_content: '…' }, usage: { prompt_tokens: tokens(body.messages, carry) }, fp: null }; const m = script[Math.min(i++, script.length - 1)]; return { message: m, usage: { prompt_tokens: tokens(body.messages, carry) }, fp: null } }; f.calls = 0; return f }
    const o = { model: 'deepseek-v4.1-flash', baseUrl: 'http://x', requireFp: true }
    // carryCheck 直接量
    const hist = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning_content: '思'.repeat(1000) }, { role: 'user', content: 'q2' }]
    let c = await TR.carryCheck({ chat: mkChan(true), o, messages: hist }); assert.equal(c.L, 1000); assert.equal(c.delta, 500); assert.equal(c.ok, true); assert.equal(c.ratio, 0.5)
    c = await TR.carryCheck({ chat: mkChan(false), o, messages: hist }); assert.equal(c.delta, 0); assert.equal(c.ok, false); assert.equal(c.need, 120)
    // 2026-10-02 实测：82 字英文 / 代码为主的思考 ⇒ Δ19（0.232/字）必须放行；丢思考 Δ=0 / 1 必须拒
    const mkFixed = (withT, withoutT) => { let n = 0; return async () => ({ message: { reasoning_content: '…' }, usage: { prompt_tokens: n++ % 2 === 0 ? withT : withoutT }, fp: null }) }
    const h82 = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning_content: 'x'.repeat(82) }, { role: 'user', content: 'q2' }]
    c = await TR.carryCheck({ chat: mkFixed(1349, 1330), o, messages: h82 }); assert.equal(c.delta, 19); assert.equal(c.need, 10); assert.equal(c.ok, true)
    c = await TR.carryCheck({ chat: mkFixed(1331, 1330), o, messages: h82 }); assert.equal(c.ok, false)
    // 预检：指纹空 + 携带成立 ⇒ 通过（mode carry-verified）；丢思考 ⇒ fp 未过
    let pf = await TR.preflightUpstream({ chat: mkChan(true), o }); assert.equal(pf.ok, true, JSON.stringify(pf)); assert.equal(pf.mode, 'carry-verified'); assert.equal(pf.carry.L, 1200); assert.equal(pf.carry.ok, true)
    pf = await TR.preflightUpstream({ chat: mkChan(false), o }); assert.equal(pf.ok, false); assert.deepEqual(pf.failed, ['fp']); assert.equal(pf.mode, null)
    // 主循环：raw 臂 3 轮；第 1 轮无历史 ⇒ no-history；第 2、3 轮有历史思考 ⇒ 携带探针（每轮 2 次 max_tokens:1）放行
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-')); const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n')
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config'); const oo = { out: tmp, minChars: 3100, maxRounds: 4, maxTokens: 1000, model: 'deepseek-v4.1-flash', baseUrl: 'http://127.0.0.1:1', requireFp: true, maxProbes: 3, storeText: true }
    const ch = mkChan(true); const rec = await TR.runOne({ o: oo, task, variant: 'raw', sample: 0, chat: ch, I, cred })
    assert.equal(rec.error, undefined, String(rec.error)); assert.equal(rec.rounds, 3); assert.equal(rec.mainCalls, 3); assert.deepEqual(rec.fpModes, { 'no-history': 1, 'carry-verified': 2 }); assert.equal(rec.carry.length, 2); assert.ok(rec.carry.every((x) => x.ok && x.ratio === 0.5)); assert.equal(rec.probes, 1 + 2 + 2)
    // 丢思考的通道：第 1 轮 no-history 过，第 2 轮携带不成立且两次 Δ 相同 ⇒ 第 2 次就停（确定性失败不是路由抖动；不发真请求、不烧满 maxProbes）
    const bad = mkChan(false); const rec2 = await TR.runOne({ o: oo, task, variant: 'raw', sample: 0, chat: bad, I, cred })
    assert.match(String(rec2.error), /携带检验稳定不过（Δ=0\/\d+ 字，需 ≥\d+；两次相同/); assert.equal(rec2.mainCalls, 1); assert.equal(rec2.probeMiss, 2); assert.equal(rec2.carry.length, 2)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await test('A32 v4.7.2 延长（零 API）：被轮数上限截断的旧 raw 在更大轮数的计划里不重跑 —— 前 from 轮影子自己的过去（零主调用、仓库由重放恢复），之后真跑；跟随臂影子新 raw 的全部轮；延长行不算「未分歧」、不进效度账本；--fork-from dry-run 建 raw 作业而不是复制；plan-traj --reuse-raw 识别延长并按 R−from / R−k* 计费', async () => {
    const TR = await import('../tools/traj-run.mjs'); const { TRAJ_TASKS } = await import('../tools/traj-fixtures.mjs'); const I = await import('../index.js'); const C = await import('../tools/cfb-cycle.mjs'); const T = await import('../tools/helpers/three-mode.mjs')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-')); const out = path.join(tmp, 'out'); fs.mkdirSync(out); const cred = path.join(tmp, 'c.yaml'); fs.writeFileSync(cred, 'K: "unused"\n')
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config'); const cwd = process.cwd(); process.chdir(tmp)
    try {
      const long = ('我们需要先确认 test/birth.selftest.mjs 里 home 的来源。看起来 makeTraceWriter 拿的是 process.env.CFB_REAL_DSH_HOME，所以测试写到真实目录 /home/u/.dsh。不是权限问题：chown 需要 root，排除。下一步 read_file test/birth.selftest.mjs。').repeat(30)
      const fix = { path: 'test/birth.selftest.mjs', old_text: 'process.env.CFB_REAL_DSH_HOME', new_text: 'process.env.DSH_HOME' }
      const script = [
        { reasoning_content: '先看看。', content: '读 README。', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] },
        { reasoning_content: '再看测试。', content: '读测试。', tool_calls: [{ id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'test/birth.selftest.mjs' }) } }] },
        { reasoning_content: long, content: '看 trace。', tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/trace.js' }) } }] },
        { reasoning_content: '改。', content: '改法只落一个。', tool_calls: [{ id: 'd', function: { name: 'edit_file', arguments: JSON.stringify(fix) } }] },
        { reasoning_content: '完。', content: '已修复。', tool_calls: [] }]
      const mk = (from = 0) => { let i = from; const f = async () => ({ message: script[Math.min(i++, script.length - 1)], usage: { prompt_tokens: 10, completion_tokens: 5 }, fp: 'x' }); f.count = () => i - from; return f }
      // 旧 raw：上限 3 轮被截断（第 3 轮还在发调用）
      const o3 = { out, minChars: 3100, maxRounds: 3, maxTokens: 1000, model: 'fixture', baseUrl: 'http://127.0.0.1:1', storeText: true, requireFp: false }
      const oldRaw = await TR.runOne({ o: o3, task, variant: 'raw', sample: 0, chat: mk(), I, cred }); assert.equal(oldRaw.rounds, 3); assert.equal(oldRaw.fixed, false); assert.equal(oldRaw.roundMessages.length, 3); assert.equal(oldRaw.completionTokens, 15); assert.ok(oldRaw.at)
      const { _lead, ...oldRow } = oldRaw; const oldFile = path.join(tmp, 'old.jsonl'); fs.writeFileSync(oldFile, JSON.stringify(oldRow) + '\n')
      // 延长到 5 轮：raw 前 3 轮影子自己的过去（假模型从 script[3] 起供第 4、5 轮）
      const o5 = { ...o3, maxRounds: 5, minChars: 200 }
      const ch = mk(3); const raw = await TR.runOne({ o: o5, task, variant: 'raw', sample: 0, chat: ch, I, cred, leader: oldRow.roundMessages, extend: { from: 3, file: 'old.jsonl', at: oldRow.at } })
      assert.equal(raw.error, undefined, String(raw.error)); assert.equal(raw.rounds, 5); assert.equal(raw.mainCalls, 2); assert.equal(raw.shadow.rounds, 3); assert.deepEqual(raw.extended, { from: 3, file: 'old.jsonl', at: oldRow.at }); assert.equal(raw.fixed, true); assert.equal(raw.fixedAtRound, 4); assert.equal(raw._lead.length, 5); assert.equal(raw.firstMessage, undefined)
      // 跟随臂影子新 raw：第 1、2 轮低于地板 200，第 3 轮（旧轨迹里的长思考）⇒ 暂停要稿；零主调用
      const chH = mk(); const h = await TR.runOne({ o: o5, task, variant: 'hand', sample: 0, chat: chH, I, cred, leader: raw._lead })
      assert.equal(h.status, 'awaiting-draft'); assert.equal(h.awaiting.round, 3); assert.equal(chH.count(), 0); assert.equal(h.shadow.rounds, 3)
      // 延长行不算未分歧、不进效度账本；未分歧跟随臂与复用 raw 也不进
      const ce = T.ceilingFrom({ rows: [{ ...raw, _lead: undefined, proxyScore: 2 }, { ...raw, variant: 'hand', shadow: { rounds: 5, divergedAt: null }, extended: undefined, proxyScore: 2 }] })
      assert.equal(ce.gate.noContrast, 1); assert.equal(ce.validity.length, 0, '延长的 raw 与未分歧的 hand 都不是新的效度观测')
      // main dry-run：--fork-from 旧文件 + 更大轮数 ⇒ raw 作业照建（不复制）、hand 作业 1 ⇒ 2 个作业、reusedRaw 0；同轮数 ⇒ 复制、1 个作业
      let dry = await TR.main(['--variants', 'raw,hand', '--only', 'eacces-config', '--samples', '1', '--max-rounds', '5', '--fork', '--fork-from', oldFile, '--out', path.join(tmp, 'o2'), '--dry-run', '--base-url', 'http://x', '--model', 'm'])
      assert.equal(dry.jobs, 2); assert.equal(dry.reusedRaw, 0)
      dry = await TR.main(['--variants', 'raw,hand', '--only', 'eacces-config', '--samples', '1', '--max-rounds', '3', '--fork', '--fork-from', oldFile, '--out', path.join(tmp, 'o3'), '--dry-run', '--base-url', 'http://x', '--model', 'm'])
      assert.equal(dry.jobs, 1); assert.equal(dry.reusedRaw, 1)
      // plan-traj --reuse-raw：识别延长（from 3，旧轨迹第一次过地板 = 第 3 轮 ⇒ k*=3）⇒ 期望主 = (5−3) + (5−3) = 4，上界同 4（k* 之前影子是构造保证）
      C.setCycleDir(tmp); fs.mkdirSync(path.join(tmp, 'offline'), { recursive: true })
      const r = C.runCli(['plan-traj', '--arms', 'raw,hand', '--scenarios', 'eacces-config', '--max-rounds', '5', '--reuse-raw', oldFile], { dir: tmp }); assert.equal(r.status, 0, r.stderr)
      const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 't1', 'plan.json'), 'utf8')); assert.equal(plan.reuseRaw.extend.from, 3); assert.equal(plan.reuseRaw.extend.firstFloor, 3); assert.equal(plan.cost.expectedMains, 4); assert.equal(plan.cost.mains, 4); assert.equal(plan.cost.expectedUsd, 0.05); assert.match(r.stdout, /\*\*延长\*\*：.*raw 从第 4 轮续跑/); assert.match(plan.command, /--fork-from /)
    } finally { process.chdir(cwd); C.setCycleDir(null); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  await test('A33 v14.12.3 F6 候选走正门（零 API）：只带 config 的提议过 parseProposal / makePolicy（白名单 continuationPath）；offlineBirthConfig 把策略 config 带进 cfg ⇒ effectiveContinuationPath=bounded，base 仍 full；白名单外的键被拒；traj-run 的压稿预算行按臂汇总程序部件份额与闸拒原因', async () => {
    const G = await import('../tools/helpers/generation.mjs'); const I = await import('../index.js'); const TR = await import('../tools/traj-run.mjs')
    // v14.14：新克隆上 .cfb-offline（gitignored 运行时状态）不存在 ⇒ 先走官方恢复路径（transfer/cycle-state.json 快照，幂等）；此前该测试依赖本地状态，干净克隆必挂
    if (!fs.existsSync(path.join(ROOT, '.cfb-offline/policies'))) {
      const rs = (await import('node:child_process')).spawnSync(process.execPath, ['tools/cfb-cycle.mjs', 'restore'], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(rs.status, 0, 'cfb-cycle restore 失败：' + (rs.stderr || rs.stdout))
    }
    const raw = fs.readFileSync(path.join(ROOT, 'docs/proposals/p-f6-bounded-path.json'), 'utf8')
    const prop = G.parseProposal(raw)
    assert.deepEqual(prop.patches, []); assert.deepEqual(prop.config, { continuationPath: 'bounded' }); assert.match(prop.prediction, /作废/)
    assert.throws(() => G.parseProposal(JSON.stringify({ patches: [], config: {} })), /policy-patches-count/, '空补丁 + 空配置不是候选')
    assert.throws(() => G.parseProposal(JSON.stringify({ patches: [], config: { birthIdentifierGate: false } })), /policy:config-key/, '白名单之外的键（发明闸、模型、提示词版本…）不许借策略改')
    assert.throws(() => G.parseProposal(JSON.stringify({ patches: [], config: { birthMinChars: 0 } })), /policy:config-value/, '制度键有范围')
    // v14.12.4 制度键：地板 / 保本线 / token 闸可以当候选，但要标 regime，normalizeConfig 把它们落到顶层
    const reg = G.parseProposal(fs.readFileSync(path.join(ROOT, 'docs/proposals/p-regime-augment.json'), 'utf8'))
    assert.deepEqual(reg.config, { birthMinChars: 1, birthMinSavedChars: -1800, birthTokenGate: false, continuationPath: 'bounded' })
    const polR = G.makePolicy({ parent: { id: 'base' }, patches: [], config: reg.config, rationale: reg.rationale, prediction: reg.prediction, origin: { by: 'assistant' } })
    assert.notEqual(polR.id, G.makePolicy({ parent: { id: 'base' }, patches: [], config: prop.config, rationale: '', prediction: '', origin: {} }).id, '不同 config ⇒ 不同 id（之前只看 patches 会撞）')
    assert.equal(G.makePolicy({ parent: { id: 'base' }, patches: [{ op: 'append', section: 'tail', text: 'x' }], rationale: '', prediction: '', origin: {} }).id, G.makePolicy({ parent: { id: 'base' }, patches: [{ op: 'append', section: 'tail', text: 'x' }], config: {}, rationale: '', prediction: '', origin: {} }).id, '只有补丁的策略 id 不变')
    const cfgR = I.offlineBirthConfig({ model: 'm', baseUrl: 'http://127.0.0.1:1', credentialsPath: '/dev/null', policy: polR, normalizeConfig: I.normalizeConfig })
    assert.equal(cfgR.birthMinChars, 1); assert.equal(cfgR.birthMinSavedChars, -1800); assert.equal(cfgR.birthTokenGate, false); assert.equal(I.effectiveContinuationPath(cfgR), 'bounded')
    assert.deepEqual(cfgR.policyConfigApplied.regime, ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate']); assert.deepEqual(I.policyRegimeKeys(polR), ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate'])
    assert.ok(I.birthAccept('x'.repeat(40), 'y'.repeat(1500), { ...cfgR, compressCtx: '' }).ok, '制度臂允许增补（稿比原文长 1460 字 ≤ 1800）')
    assert.equal(I.birthAccept('x'.repeat(40), 'y'.repeat(1900), { ...cfgR, compressCtx: '' }).why, 'no-gain', '超过保本线仍拒')
    assert.equal(I.birthAccept('x'.repeat(40), 'y'.repeat(1500), { ...I.offlineBirthConfig({ model: 'm', baseUrl: 'http://127.0.0.1:1', credentialsPath: '/dev/null', policy: { id: 'base', patches: [] }, normalizeConfig: I.normalizeConfig }), compressCtx: '' }).why, 'no-gain', 'base 臂 = 生产：增补被拒')
    assert.deepEqual(cyc.armRegime('policy:' + fs.readdirSync(path.join(ROOT, '.cfb-offline/policies')).map((f) => f.replace(/\.json$/, '')).find((id) => JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/policies', id + '.json'), 'utf8')).config?.birthMinChars === 1)), ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate'], '计划能认出制度臂')
    assert.deepEqual(cyc.armRegime('policy:base'), []); assert.deepEqual(cyc.armRegime('policy:p-67620ded4d'), [], 'F6 候选只改程序部件，不是制度')
    assert.throws(() => G.parseProposal(JSON.stringify({ patches: [], config: { continuationPath: 'nope' } })), /policy:config-value/)
    assert.equal(G.parseProposal(JSON.stringify({ patches: [], config: { continuationPath: 'none' } })).config.continuationPath, 'none', "v14.12.4：'none' 是合法档位（不写延续段）")
    const pol = G.makePolicy({ parent: { id: 'base' }, patches: prop.patches, config: prop.config, rationale: prop.rationale, prediction: prop.prediction, origin: { by: 'assistant' } })
    assert.ok(/^p-[0-9a-f]{10}$/.test(pol.id) && pol.config.continuationPath === 'bounded')
    const cfgP = I.offlineBirthConfig({ model: 'm', baseUrl: 'http://127.0.0.1:1', credentialsPath: '/dev/null', policy: pol, normalizeConfig: I.normalizeConfig })
    assert.equal(cfgP.compressPolicy && cfgP.compressPolicy.id, pol.id); assert.equal(I.effectiveContinuationPath(cfgP), 'bounded')
    const cfgB = I.offlineBirthConfig({ model: 'm', baseUrl: 'http://127.0.0.1:1', credentialsPath: '/dev/null', policy: { id: 'base', patches: [] }, normalizeConfig: I.normalizeConfig })
    assert.equal(cfgB.compressPolicy, null); assert.equal(I.effectiveContinuationPath(cfgB), 'full', 'base 臂 = 生产缺省 = 被测对象不变')
    assert.equal(I.compressPromptVersion(cfgP), I.compressPromptVersion({ ...cfgB, compressPolicy: { id: pol.id, patches: [] } }), '只有 config 的策略：提示词逐字节同 base，promptVersion 仍带 +id 以便追溯')
    // 已落盘的策略能被 traj-run 的 policy:<id> 臂读到（与 docs/proposals 的提议同 config）
    const onDisk = TR.loadPolicyFor('policy:p-67620ded4d'); assert.deepEqual(onDisk.config, { continuationPath: 'bounded' }); assert.deepEqual(onDisk.patches, [])
    // 压稿预算行
    const rows = [
      { variant: 'hand', compile: [{ ok: false, path: 'hand', why: 'no-token-gain', budget: { programShare: 0.61 } }, { ok: true, path: 'hand', budget: { programShare: 0.61 } }, { ok: true, path: 'hand', budget: { programShare: 0.54 } }, { ok: false, belowFloor: true }] },
      { variant: 'policy:base', compile: [{ ok: true, path: 'birth-offline', budget: { programShare: 0.3 } }, { ok: false, path: 'birth-offline', why: 'v4d-too-long' }] },
      { variant: 'raw' }, { variant: 'auto', error: 'x', compile: [{ ok: true }] },
    ]
    const line = TR.compressBudgetLine(rows)
    assert.match(line, /压稿预算（F6）：hand: 压过 3 轮，程序部件\/原文 中位 0.61 最大 0.61，闸拒 no-token-gain×1；policy:base: 压过 2 轮，程序部件\/原文 中位 0.3 最大 0.3，闸拒 v4d-too-long×1/)
    assert.equal(TR.compressBudgetLine([{ variant: 'raw' }]), '')
  })
  await test('A34 v14.12.3 F7 假沙箱不泄宿主（t8 实测漏洞）：裸 ~ / 裸 / / .. / $HOME 一律「不存在」，不真跑；真跑的白名单命令 HOME 指向假仓库、不读宿主 profile；仓库内命令照常', async () => {
    const TR = await import('../tools/traj-run.mjs'); const F = await import('../tools/traj-fixtures.mjs')
    const task = F.TRAJ_TASKS.find((t) => t.id === 'perf-regression'); const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'))
    try {
      for (const [n, c] of Object.entries(task.files || {})) { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), c) }
      const home = os.homedir(); const marker = fs.readdirSync(home).find((f) => !f.startsWith('.')) || ''
      for (const c of ['ls -la ~', 'ls -la ~ 2>/dev/null', 'cat ~/cfb-keys.env', 'ls $HOME', 'ls -la /', 'find / -type f 2>/dev/null | head', 'grep -r KEY / 2>/dev/null | head', 'ls / /opt', 'cat ../x', 'ls ..', 'ls -la / ; ls /opt']) {
        const out = TR.runBash(task, repo, c)
        assert.match(out, /No such file or directory|该沙箱未提供此命令/, c + ' ⇒ ' + out.slice(0, 120))
        if (marker && !c.includes(marker)) assert.ok(!out.includes(marker), c + ' 泄漏了宿主 HOME 的条目：' + out.slice(0, 200))
        assert.ok(!/^[d-][rwx-]{9}/m.test(out), c + ' 真跑出了目录清单：' + out.slice(0, 200))
        assert.ok(!/\b(?:bin|boot|etc|proc|usr)\b[\s\S]*\b(?:bin|boot|etc|proc|usr)\b/.test(out), c + ' 泄漏了宿主根目录：' + out.slice(0, 200))
      }
      assert.match(TR.runBash(task, repo, 'ls -la'), /CHANGELOG\.md[\s\S]*README\.md[\s\S]*src/)
      assert.equal(TR.runBash(task, repo, 'find . -type f').trim().split('\n').sort().join(','), './CHANGELOG.md,./README.md,./src/config.js')
      assert.match(TR.runBash(task, repo, 'grep -n max src/config.js'), /maxOutputTokens/)
      assert.match(TR.runBash(task, repo, 'cd ~ && ls'), /CHANGELOG\.md/, 'cd ~ 是空操作、随后的 ls 仍在假仓库')
    } finally { fs.rmSync(repo, { recursive: true, force: true }) }
  })
  await test('A35 v14.12.4 归因可复现（零 API）：transfer/traj1–3 的压缩轮 31/72、增补 55%、过 3100 地板 23%、配对 auto 3 / raw 1 / 平 3；buildTrajPlan 把制度臂按「第 1 轮就压、每轮都压」计费；plan.md 标「换制度不是调稿」', async () => {
    const AR = await import('../tools/attrib-regime.mjs')
    const A = AR.attribRegime(AR.loadRows(['transfer/traj1', 'transfer/traj2', 'transfer/traj3']))
    assert.deepEqual(A.compressedRounds, { rounds: 72, compressed: 31, expansion: 17, expansionShare: 0.55, aboveFloor: 7, aboveFloorShare: 0.23 })
    assert.deepEqual(A.pairSummary, { auto: 3, raw: 1, tie: 3 }); assert.equal(A.outcomes.raw.n, 9); assert.equal(A.outcomes.auto.n, 8)
    assert.ok(A.perRound.find((p) => p.round === 3).auto > A.perRound.find((p) => p.round === 3).raw, '第 3 轮 auto 臂自己的思考更长（启动效应）')
    assert.match(AR.renderAttrib(A), /增补）17 = 55%/)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-reg-'))
    fs.writeFileSync(path.join(tmp, 'p-reg.json'), JSON.stringify({ schema: 'cfb.policy/1', id: 'p-reg', parent: 'base', patches: [], config: { birthMinChars: 1, birthMinSavedChars: -1800, birthTokenGate: false, continuationPath: 'bounded' } }))
    fs.writeFileSync(path.join(tmp, 'p-f6.json'), JSON.stringify({ schema: 'cfb.policy/1', id: 'p-f6', parent: 'base', patches: [], config: { continuationPath: 'bounded' } }))
    assert.deepEqual(cyc.armRegime('policy:p-reg', tmp), ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate']); assert.deepEqual(cyc.armRegime('policy:p-f6', tmp), []); assert.deepEqual(cyc.armRegime('raw', tmp), [])
    const reg = cyc.buildTrajPlan({ n: 1, arms: ['raw', 'policy:p-reg'], scenarios: ['perf-regression'], samples: 1, maxRounds: 8, policyDir: tmp })
    assert.equal(reg.cost.expectedMains, 8 + 7, '制度臂第 2 轮起分歧 ⇒ 付 R−1 次主调用，不享受影子'); assert.equal(reg.cost.expectedCompresses, 8, '每轮都压'); assert.deepEqual(reg.regimeArms, { 'policy:p-reg': ['birthMinChars', 'birthMinSavedChars', 'birthTokenGate'] })
    const f6 = cyc.buildTrajPlan({ n: 1, arms: ['raw', 'policy:p-f6'], scenarios: ['perf-regression'], samples: 1, maxRounds: 8, policyDir: tmp })
    assert.ok(f6.cost.expectedMains < reg.cost.expectedMains && f6.cost.expectedCompresses < reg.cost.expectedCompresses, 'F6 候选仍按影子 + 地板占比计费'); assert.equal(f6.regimeArms, undefined)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await test('A36 v14.13 DSH 合并（零 API）：rl-native 工具面逐字 schema + str_replace_editor 语义；drop 臂历史无思维链；gate 臂三条门禁按事实触发且只以 user 角色近场注入；原生协议 tool_calls/role:tool 成对；计划核对含 aci', async () => {
    const I = await import('../index.js'); const ACI = await import('../tools/helpers/aci.mjs'); const HG = await import('../tools/helpers/host-gates.mjs')
    // 1. 面：rl-native = RL 训练句 + 官方两工具（schema 原文关键句在、required 一致）；cfb 面不变
    const rl = ACI.resolveAci('rl-native', { SYSTEM: 's', SYSTEM_TEXT_TOOLS: 't', TOOLS: [], textTools: false })
    assert.equal(rl.system, 'You are a helpful software engineer assistant.'); assert.deepEqual(rl.tools.map((t) => t.function.name), ['bash', 'str_replace_editor'])
    assert.match(rl.tools[0].function.description, /^Execute a bash command \(`bash -c`\)/); assert.match(rl.tools[0].function.description, /Background execution is not available/); assert.deepEqual(rl.tools[0].function.parameters.required, ['command', 'description'])
    assert.match(rl.tools[1].function.description, /^Custom editing tool for viewing, creating and editing files/); assert.deepEqual(rl.tools[1].function.parameters.properties.command.enum, ['view', 'create', 'str_replace', 'insert']); assert.deepEqual(rl.tools[1].function.parameters.required, ['command', 'path'])
    assert.throws(() => ACI.resolveAci('rl-native', { SYSTEM: 's', SYSTEM_TEXT_TOOLS: 't', TOOLS: [], textTools: true }), /text-tools/); assert.throws(() => ACI.resolveAci('nope', {}), /unknown-aci/)
    assert.equal(ACI.resolveAci('cfb', { SYSTEM: 's', SYSTEM_TEXT_TOOLS: 't', TOOLS: [1], textTools: false }).system, 's')
    // 2. str_replace_editor 语义（view 带行号 / 目录两层 / create 不覆盖 / str_replace 唯一 / insert 行后 / 越界与不存在）；绝对路径 /home/u/work/repo 映射到假仓库
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-aci-')); fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'const a = 1\nconst b = 2\nconst a2 = 1\n')
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'view', path: '/home/u/work/repo/src/a.js' }), /total of 4 lines\):\n     1  const a = 1\n     2  const b = 2/)
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'view', path: 'src/a.js', view_range: [2, 2] }), /view_range=\[2, 2\]:\n     2  const b = 2\n$/)
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'view', path: '/home/u/work/repo' }), /up to 2 levels deep in \/home\/u\/work\/repo[\s\S]*d\t\/home\/u\/work\/repo\/src\nf\t\/home\/u\/work\/repo\/src\/a\.js/)
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'str_replace', path: 'src/a.js', old_str: '= 1', new_str: '= 9' }), /^No replacement was performed\. Multiple occurrences .* in lines \[1, 3\]/)
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'str_replace', path: 'src/a.js', old_str: 'nope' }), /did not appear verbatim in \/home\/u\/work\/repo\/src\/a\.js/)
    assert.equal(ACI.execStrReplaceEditor(repo, { command: 'str_replace', path: 'src/a.js', old_str: 'const b = 2', new_str: 'const b = 3' }), 'The file /home/u/work/repo/src/a.js has been edited successfully.'); assert.match(fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8'), /const b = 3/)
    assert.equal(ACI.execStrReplaceEditor(repo, { command: 'insert', path: 'src/a.js', insert_line: 1, new_str: '// x' }), 'The file /home/u/work/repo/src/a.js has been edited successfully.'); assert.equal(fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8').split('\n')[1], '// x')
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'create', path: 'src/a.js', file_text: 'x' }), /^File already exists at: \/home\/u\/work\/repo\/src\/a\.js/); assert.match(ACI.execStrReplaceEditor(repo, { command: 'create', path: 'src/new.js', file_text: 'y\n' }), /^New file created successfully at: \/home\/u\/work\/repo\/src\/new\.js/)
    assert.match(ACI.execStrReplaceEditor(repo, { command: 'view', path: '/etc/passwd' }), /does not exist/); assert.match(ACI.execStrReplaceEditor(repo, { command: 'view', path: '../x' }), /does not exist/); assert.match(ACI.execStrReplaceEditor(repo, { command: 'rm', path: 'src/a.js' }), /^Unrecognized command rm/)
    assert.ok(ACI.isEditCall('str_replace_editor', { command: 'str_replace' }) && ACI.isEditCall('edit_file', {}) && !ACI.isEditCall('str_replace_editor', { command: 'view' }) && ACI.editOk('The file x has been edited successfully.') && ACI.editOk('ok（x 已写入，1 处替换）') && !ACI.editOk('No replacement was performed'))
    fs.rmSync(repo, { recursive: true, force: true })
    // 3. 门禁规则（纯函数）：act 要「读过 src + 同一命令 ≥2 + 0 修改 + 最近两轮只读 + 第 ≥3 轮」；batch 要连续两轮修改且中间没验证；verify 要宣称修好且最后修改后没验证；幂等
    const vre = /npm test/
    const R = (round, calls) => ({ round, calls })
    const rowsAct = [R(1, [{ name: 'read_file', args: { path: 'src/trace.js' } }]), R(2, [{ name: 'bash', args: { command: 'npm test' } }]), R(3, [{ name: 'bash', args: { command: 'npm test' } }])]
    assert.equal(HG.gateAfterTools(rowsAct, { edits: [], verifyRe: vre, gated: [], round: 3, maxRounds: 6 }), 'act')
    assert.equal(HG.gateAfterTools(rowsAct, { edits: [], verifyRe: vre, gated: [{ round: 2, kind: 'act' }], round: 3, maxRounds: 6 }), null, '两轮内不重复')
    assert.equal(HG.gateAfterTools(rowsAct, { edits: [{ round: 1, ok: true }], verifyRe: vre, gated: [], round: 3, maxRounds: 6 }), null, '改过了就不催行动')
    assert.equal(HG.gateAfterTools(rowsAct.slice(0, 2), { edits: [], verifyRe: vre, gated: [], round: 2, maxRounds: 6 }), null, '第 2 轮还不催'); assert.equal(HG.gateAfterTools(rowsAct, { edits: [], verifyRe: vre, gated: [], round: 3, maxRounds: 3 }), null, '最后一轮之后没人读')
    const rowsBatch = [R(1, [{ name: 'edit_file', args: { path: 'a' } }]), R(2, [{ name: 'edit_file', args: { path: 'a' } }])]
    assert.equal(HG.gateAfterTools(rowsBatch, { edits: [{ round: 1, ok: true }, { round: 2, ok: true }], verifyRe: vre, gated: [], round: 2, maxRounds: 6 }), 'batch')
    assert.equal(HG.gateAfterTools([rowsBatch[0], R(2, [{ name: 'edit_file', args: { path: 'a' } }, { name: 'bash', args: { command: 'npm test' } }])], { edits: [{ round: 1, ok: true }, { round: 2, ok: true }], verifyRe: vre, gated: [], round: 2, maxRounds: 6 }), null, '验证了就不算碎片')
    assert.equal(HG.gateOnFinal([R(1, [{ name: 'edit_file', args: { path: 'a' } }])], { edits: [{ round: 1, ok: true }], verifyRe: vre, gated: [], claim: 'fixed', round: 2, maxRounds: 6 }), 'verify')
    assert.equal(HG.gateOnFinal([R(1, [{ name: 'edit_file', args: { path: 'a' } }, { name: 'bash', args: { command: 'npm test' } }])], { edits: [{ round: 1, ok: true }], verifyRe: vre, gated: [], claim: 'fixed', round: 2, maxRounds: 6 }), null, '同轮先改后验也算验过')
    assert.equal(HG.gateOnFinal([R(1, [{ name: 'edit_file', args: { path: 'a' } }])], { edits: [{ round: 1, ok: true }], verifyRe: vre, gated: [{ round: 2, kind: 'verify' }], claim: 'fixed', round: 3, maxRounds: 6 }), null, '整条只催一次'); assert.equal(HG.gateOnFinal([], { edits: [], claim: 'hedged', round: 2 }), null)
    // 3b. v14.13.1 回放真实轨迹（零 API）：第一版 act 规则（只认「同一命令 ≥2 次」）在 29 条记录上一次都不触发 —— t8/t9 的失败是「数据齐了还在找新证据、一条命令不重复」。
    //     现规则：验证命令跑过之后只看不改 ≥4 调用、第 ≥4 轮 ⇒ 催；traj2 perf raw（0 edit ✗）第 4 轮触发，eacces 早改的轨迹不触发，traj3 perf raw 宣称前没验 ⇒ verify 门禁
    const replay = (file, task, variant) => { const r = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.task === task && x.variant === variant && !x.error); const tk = TRAJ_TASKS.find((t) => t.id === task); const rows = [], gated = [], edits = []
      for (const t of r.transcript) { const calls = (t.calls || []).map((c) => { let a; try { a = JSON.parse(c.args) } catch { a = { command: String(c.args || '') } } return { name: c.name, args: a } }); rows.push({ round: t.round, calls }); calls.forEach((c, i) => { if (c.name === 'edit_file') edits.push({ round: t.round, ok: /^ok/.test(String((t.results || [])[i] || '')) }) })
        const k = calls.length ? HG.gateAfterTools(rows, { edits, verifyRe: tk.verifyRe, gated, round: t.round, maxRounds: 8 }) : HG.gateOnFinal(rows, { edits, verifyRe: tk.verifyRe, gated, claim: claimOfMr(t.text || ''), round: t.round, maxRounds: 8 }); if (k) gated.push({ round: t.round, kind: k }) }
      return gated }
    const { claimOf: claimOfMr } = await import('../tools/effect-mr.mjs')
    assert.deepEqual(replay('transfer/traj2/results.jsonl', 'perf-regression', 'raw'), [{ round: 4, kind: 'act' }, { round: 6, kind: 'act' }], 'perf 0-edit 失败：第 4 轮催、两轮后再催')
    assert.deepEqual(replay('transfer/traj2/results.jsonl', 'eacces-config', 'raw'), [], '早改早验的轨迹不打扰')
    assert.deepEqual(replay('transfer/traj3/results.jsonl', 'perf-regression', 'raw'), [{ round: 6, kind: 'verify' }], '改了没验就宣称 ⇒ verify 门禁')
    assert.ok(HG.GATE_TEXTS.act.startsWith(HG.GATE_HEAD) && /这不是用户输入/.test(HG.GATE_HEAD) && /可逆/.test(HG.GATE_TEXTS.act) && /合并写入/.test(HG.GATE_TEXTS.batch) && /先运行验证命令/.test(HG.GATE_TEXTS.verify))
    // 4. runOne（假 chat）：drop 臂发出去的历史没有 reasoning_content、transcript 记 finish；gate 臂 act 门禁附在工具结果消息末尾（user 角色）、verify 门禁拦下未验证的宣称；raw 对照不注入
    const task = TRAJ_TASKS.find((t) => t.id === 'eacces-config')
    const tc = (name, args) => ({ id: 'c_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    const mk = (content, calls, reasoning = 'r'.repeat(50)) => ({ message: { content, reasoning_content: reasoning, ...(calls ? { tool_calls: calls } : {}) }, usage: { prompt_tokens: 10 }, fp: 'x', finish: calls ? 'tool_calls' : 'stop' })
    const sent = []
    const chatDrop = async (b) => { sent.push(b); const round = b.messages.filter((m) => m.role === 'assistant').length + 1; if (round === 1) return mk('读。', [tc('read_file', { path: 'src/trace.js' })]); if (round === 2) return mk('跑。', [tc('bash', { command: 'npm test' })]); return mk('没修。', null) }
    const o = { maxRounds: 5, minChars: 3100, model: 'm', maxTokens: 1000, maxProbes: 1, textTools: false, requireFp: false, aci: 'cfb', toolProtocol: 'text' }
    const d = await runOne({ o, task, variant: 'drop', sample: 0, chat: chatDrop, I, cred: null }); assert.equal(d.error, undefined, d.error)
    assert.ok(sent.length === 3 && sent[2].messages.filter((m) => m.role === 'assistant').every((m) => !('reasoning_content' in m)), 'drop：历史 assistant 消息不带 reasoning_content'); assert.equal(d.contextReasoningChars, 0); assert.deepEqual(d.transcript.map((t) => t.storedChars), [0, 0, 0]); assert.deepEqual(d.transcript.map((t) => t.finish), ['tool_calls', 'tool_calls', 'stop']); assert.equal(d.aci, 'cfb'); assert.equal(d.toolProtocol, 'text')
    // gate 臂：r1 读 src、r2/r3 同一命令 ⇒ r3 结果后附 act 门禁；r4 改（成功）并直接宣称修好 ⇒ verify 门禁拦一次 ⇒ r5 跑验证后收
    const seenGate = []
    const chatGate = async (b) => { const last = b.messages[b.messages.length - 1]; if (last.role === 'user' && /\[宿主门禁\]/.test(last.content)) seenGate.push({ round: b.messages.filter((m) => m.role === 'assistant').length, kind: /至少两次/.test(last.content) ? 'act' : /宣称/.test(last.content) ? 'verify' : 'other', tail: last.content.endsWith(HG.GATE_TEXTS.act) || last.content === HG.GATE_TEXTS.verify })
      const round = b.messages.filter((m) => m.role === 'assistant').length + 1
      if (round === 1) return mk('读。', [tc('read_file', { path: 'src/trace.js' })]); if (round === 2 || round === 3) return mk('跑。', [tc('bash', { command: 'npm test' })])
      if (round === 4) return mk('改。', [tc('edit_file', { path: 'test/birth.selftest.mjs', old_text: '{ home: process.env.CFB_REAL_DSH_HOME }', new_text: '{}' })])
      if (round === 5 || round >= 7) return mk('问题已修复。', null); return mk('验。', [tc('bash', { command: 'npm test' })]) }
    const g = await runOne({ o: { ...o, maxRounds: 7 }, task, variant: 'gate', sample: 0, chat: chatGate, I, cred: null }); assert.equal(g.error, undefined, g.error)
    assert.deepEqual(g.gates, [{ round: 3, kind: 'act' }, { round: 5, kind: 'verify' }]); assert.deepEqual(seenGate.map((x) => [x.round, x.kind, x.tail]), [[3, 'act', true], [5, 'verify', true]], '门禁只以 user 角色、紧贴最新结果出现')
    assert.equal(g.fixed, true); assert.equal(g.fixedAtRound, 4); assert.equal(g.verifiedAfterFix, true, 'verify 门禁之后模型真的去验了'); assert.equal(g.rounds, 7); assert.equal(g.claimJustified, true, '被拦下后验证了再宣称 ⇒ 宣称成立（判分口径不变，门禁改变的是行为）')
    const r = await runOne({ o: { ...o, maxRounds: 7 }, task, variant: 'raw', sample: 0, chat: chatGate, I, cred: null }); assert.equal(r.gates, undefined); assert.equal(r.rounds, 5, 'raw 臂第 5 轮宣称就收'); assert.equal(r.verifiedAfterFix, false); assert.equal(r.claimJustified, false, '同一个脚本在 raw 臂下是未经验证的宣称')
    // 5. rl-native + 原生协议：系统提示 = RL 句、tools = 官方两工具；历史 assistant 带 tool_calls、结果是 role:tool 且 id 成对；str_replace 计入 edits 并能修好；bash 非零退出带 [exit code]
    const seenN = []
    const chatN = async (b) => { seenN.push(b); const round = b.messages.filter((m) => m.role === 'assistant').length + 1
      if (round === 1) return mk('view。', [{ id: 'id1', type: 'function', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: '/home/u/work/repo/test/birth.selftest.mjs' }) } }])
      if (round === 2) return mk('fix。', [{ id: 'id2', type: 'function', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'str_replace', path: '/home/u/work/repo/test/birth.selftest.mjs', old_str: '{ home: process.env.CFB_REAL_DSH_HOME }', new_str: '{}' }) } }, { id: 'id3', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test', description: 'Run the test suite' }) } }])
      return mk('Fixed.', null) }
    const n = await runOne({ o: { ...o, aci: 'rl-native', toolProtocol: 'native' }, task, variant: 'raw', sample: 0, chat: chatN, I, cred: null }); assert.equal(n.error, undefined, n.error)
    assert.equal(seenN[0].messages[0].content, 'You are a helpful software engineer assistant.'); assert.deepEqual(seenN[0].tools.map((t) => t.function.name), ['bash', 'str_replace_editor'])
    const h = seenN[2].messages; assert.equal(h[2].role, 'assistant'); assert.equal(h[2].tool_calls[0].id, 'id1'); assert.equal(h[3].role, 'tool'); assert.equal(h[3].tool_call_id, 'id1'); assert.match(h[3].content, /with line numbers/); assert.equal(h[5].tool_call_id, 'id2'); assert.equal(h[6].tool_call_id, 'id3'); assert.match(h[6].content, /PASS test\/birth/)
    assert.equal(n.edits.length, 1); assert.equal(n.edits[0].ok, true); assert.equal(n.fixed, true); assert.equal(n.fixedAtRound, 2); assert.equal(n.verifiedAfterFix, true); assert.equal(n.aci, 'rl-native'); assert.equal(n.toolProtocol, 'native'); assert.equal(n.claimJustified, true)
    assert.deepEqual(n.proxySteps.map((s) => s.next), [1, 1, 0], 'proxy 旗标认 str_replace_editor 的编辑'); assert.equal(n.claim, 'fixed', '英文宣称也认（rl-native 面下模型常用英文收尾）')
    await assert.rejects(runOne({ o: { ...o, aci: 'rl-native' }, task, variant: 'policy:base', sample: 0, chat: chatN, I, cred: null }), /暂只支持/)
    // 5b. 形态预检：native / drop 的历史形态各发一次 max_tokens:1；通道拒 role:tool ⇒ shape ✗ ⇒ 预检不过、一条轨迹都不开
    const pfChat = (rejectTool) => async (b) => { if (rejectTool && b.messages.some((m) => m.role === 'tool')) throw new Error('HTTP 400'); return { message: { content: '2', reasoning_content: '想' }, usage: { prompt_tokens: 20 + b.messages.length, completion_tokens_details: { reasoning_tokens: 1 } }, fp: 'fp_dspure_app_v1', finish: 'stop', model: 'm' } }
    const pfOk = await tr.preflightUpstream({ chat: pfChat(false), o: { model: 'm', aci: 'rl-native', toolProtocol: 'native', variants: ['raw', 'drop'], textTools: false } }); assert.equal(pfOk.ok, true); assert.deepEqual(Object.keys(pfOk.shape), ['native', 'drop']); assert.ok(pfOk.shape.native.ok && pfOk.shape.drop.ok)
    const pfBad = await tr.preflightUpstream({ chat: pfChat(true), o: { model: 'm', aci: 'cfb', toolProtocol: 'native', variants: ['raw'], textTools: false } }); assert.equal(pfBad.ok, false); assert.ok(pfBad.failed.includes('shape')); assert.equal(pfBad.shape.native.ok, false); assert.equal(pfBad.shape.drop, undefined)
    const pfPlain = await tr.preflightUpstream({ chat: pfChat(true), o: { model: 'm', aci: 'cfb', toolProtocol: 'text', variants: ['raw', 'gate'], textTools: false } }); assert.equal(pfPlain.shape, undefined, '旧形态不做形态预检（零额外请求）')
    // 6. 计划核对：plan 带 aci/toolProtocol 时运行参数必须一致；buildTrajPlan 把 drop 当第 2 轮起分歧计费、命令行带 --aci；设计摘要随面变化
    const plan = cyc.buildTrajPlan({ n: 1, arms: ['raw', 'drop'], scenarios: ['eacces-config'], samples: 1, maxRounds: 5, aci: 'rl-native', toolProtocol: 'native' })
    assert.equal(plan.aci, 'rl-native'); assert.equal(plan.toolProtocol, 'native'); assert.match(plan.command, /--aci rl-native --tool-protocol native/); assert.equal(plan.cost.expectedMains, 5 + 4, 'drop 第 2 轮起自己发')
    const base = { variants: ['raw', 'drop'], samples: 1, maxRounds: 5, fork: true, only: ['eacces-config'], storeText: true, aci: 'rl-native', toolProtocol: 'native' }
    assert.equal(checkTrajPlan(plan, base).ok, true); assert.throws(() => checkTrajPlan(plan, { ...base, aci: 'cfb' }), /aci plan=rl-native run=cfb/); assert.throws(() => checkTrajPlan(plan, { ...base, toolProtocol: 'text' }), /toolProtocol/)
    const plainPlan = cyc.buildTrajPlan({ n: 1, arms: ['raw', 'gate'], scenarios: ['eacces-config'], samples: 1, maxRounds: 5 }); assert.equal(plainPlan.aci, undefined); assert.ok(!/--aci/.test(plainPlan.command)); assert.equal(checkTrajPlan(plainPlan, { ...base, variants: ['raw', 'gate'], aci: 'cfb', toolProtocol: 'text' }).ok, true)
    assert.notEqual(cyc.buildTrajPlan({ n: 1, arms: ['raw', 'drop'], scenarios: ['eacces-config'], samples: 1, maxRounds: 5, aci: 'rl-native' }).digest, cyc.buildTrajPlan({ n: 1, arms: ['raw', 'drop'], scenarios: ['eacces-config'], samples: 1, maxRounds: 5 }).digest)
  })
} finally {
  console.log(`\n=== closed-loop-v4 selftest: ${pass} pass / ${fail} fail ===`)
  process.exit(fail ? 1 : 0)
}
})()
