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
import { runOne, loadPolicyFor, policyCompressBody } from '../tools/traj-run.mjs'
import { TRAJ_TASKS } from '../tools/traj-fixtures.mjs'

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
} finally {
  console.log(`\n=== closed-loop-v4 selftest: ${pass} pass / ${fail} fail ===`)
  process.exit(fail ? 1 : 0)
}
})()
