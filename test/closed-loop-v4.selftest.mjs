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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name); console.log(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : String(e)) } }
const W = (task, outcome = 'win') => ({ task, outcome })
const split = { h1: 'holdout', h2: 'holdout' }
const devWins = ['a', 'b', 'c', 'd', 'e'].map((t) => W(t))

try {
  test('A1 e 值：闭式解与手算一致；5 连胜过 α=0.1、7 连胜过 α=0.05；0 场 =1；输多赢少 <1', () => {
    assert.ok(Math.abs(eValueWins(5, 0) - 64 / 6 * (1 - 2 ** -6)) < 1e-6, '2^(n+1)·B(w+1,1)·(1−0.5^(w+1))')
    assert.ok(eValueWins(4, 0) < 10 && eValueWins(5, 0) >= 10 && eValueWins(6, 0) < 20 && eValueWins(7, 0) >= 20)
    assert.equal(winsNeeded(0.1), 5); assert.equal(winsNeeded(0.05), 7); assert.equal(eValueWins(0, 0), 1); assert.ok(eValueWins(1, 5) < 1)
  })
  test('A2 decideV4：4 对留出全胜 ⇒ continue（v3 这里 adopt）；5 对 ⇒ adopt-provisional；留出 1 负 ⇒ continue；全负 ⇒ reject；30 对交替 ⇒ stop-undecided；A/A 永不采纳', () => {
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
  test('A3 效度账本：<12 对 unvalidated；分离好 ⇒ valid；随机 ⇒ invalid/suspect；adoptionPolicy 随状态变', () => {
    assert.equal(rulerValidity([{ proxy: 1, outcome: 1 }, { proxy: 0, outcome: 0 }]).status, 'unvalidated')
    const good = Array.from({ length: 24 }, (_, i) => ({ proxy: (i % 2 ? 3 : -1) + (i % 5) * 0.1, outcome: i % 2 }))
    const g = rulerValidity(good); assert.equal(g.status, 'valid'); assert.equal(g.auc, 1); assert.ok(g.ci95[0] >= 0.6)
    const rnd = Array.from({ length: 40 }, (_, i) => ({ proxy: (i * 7) % 11, outcome: (i * 3) % 2 })); const r = rulerValidity(rnd); assert.ok(['invalid', 'suspect'].includes(r.status), r.status); assert.ok(r.auc < 0.7)
    assert.equal(auc([{ proxy: 1, outcome: 1 }, { proxy: 1, outcome: 0 }]), 0.5)
    assert.equal(adoptionPolicy(g).l1Adopts, true); assert.equal(adoptionPolicy({ status: 'invalid' }).confirmEvery, 1); assert.equal(adoptionPolicy(null).l1Adopts, false)
  })
  test('A4 L2 结局：episodeOutcome / outcomeComparison 配对（修得更快赢、假宣称罚、未修平）；e 值随配对数走', () => {
    const o = episodeOutcome({ fixed: true, fixedAtRound: 2, rounds: 3, claim: 'fixed', verifiedAfterFix: true }); assert.equal(o.solved, true); assert.equal(o.roundsToFix, 2); assert.equal(o.falseClaim, false)
    const fc = episodeOutcome({ fixed: false, fixedAtRound: null, rounds: 5, claim: 'fixed' }); assert.equal(fc.solved, false); assert.equal(fc.falseClaim, true)
    const rows = []
    for (const t of ['t1', 't2', 't3']) for (const s of [0, 1]) { rows.push({ task: t, arm: 'champion', sample: s, fixed: true, fixedAtRound: 2, claim: 'fixed' }); rows.push({ task: t, arm: 'previous', sample: s, fixed: s === 0, fixedAtRound: s === 0 ? 3 : null, claim: s === 0 ? 'fixed' : 'none' }) }
    const c = outcomeComparison(rows); assert.equal(c.pairs.length, 6); assert.ok(c.pairs.every((p) => p.outcome === 'win')); assert.equal(c.champion.solved, 1); assert.equal(c.previous.solved, 0.5); assert.ok(c.e >= 10 && c.eReject < 1)
    const tie = outcomeComparison([{ task: 'x', arm: 'champion', fixed: false }, { task: 'x', arm: 'previous', fixed: false }]); assert.equal(tie.pairs[0].outcome, 'tie'); assert.equal(tie.e, 1)
  })
  test('A5 排序器：<20 对 untrained；可分 ⇒ ready 且排序正确；噪声 ⇒ weak；20 维特征有名字', () => {
    assert.equal(features('x').length, FEATURE_NAMES.length); assert.equal(MIN_PAIRS, 20)
    const pairs = Array.from({ length: 24 }, (_, i) => ({ chosenText: `先核对 src/config.js 第 ${i} 行；old_text 逐字见下。下一步 读 test/x.mjs 再改。`, rejectedText: '可能已修复，大概没问题了，也许 done。' + 'x'.repeat(i) }))
    assert.equal(trainRanker(pairs.slice(0, 10)).status, 'untrained')
    const m = trainRanker(pairs); assert.equal(m.status, 'ready'); assert.ok(m.cvAcc >= 0.9); assert.ok(m.top.some((t) => t.name === 'hedges' && t.w < 0))
    const rk = rankCandidates(m, [{ id: 'bad', text: '也许修好了' }, { id: 'good', text: '先读 src/a.js，old_text 逐字对齐' }]); assert.equal(rk.used, true); assert.equal(rk.ranked[0].id, 'good')
    const noisy = pairs.map((p, i) => (i % 2 ? p : { chosenText: p.rejectedText, rejectedText: p.chosenText })); assert.equal(trainRanker(noisy).status, 'weak'); assert.equal(rankCandidates(trainRanker(noisy), [{ id: 'a', text: 'x' }]).used, false)
  })
  test('A6 真实数据：transfer/traj1–3 的 29 条轨迹能算出 L2 基线（raw vs auto），且 rulerReport 零 API 可用', () => {
    const rows = ['traj1', 'traj2', 'traj3'].flatMap((d) => fs.readFileSync(path.join(ROOT, 'transfer', d, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), dir: d })))
    assert.equal(rows.length, 29)
    const c = outcomeComparison(rows.map((r) => ({ ...r, arm: r.variant === 'auto' ? 'champion' : r.variant === 'raw' ? 'previous' : null, sample: `${r.dir}#${r.sample ?? 0}` })).filter((r) => r.arm))
    assert.equal(c.previous.n, 11); assert.equal(c.champion.n, 10); assert.equal(c.pairs.length, 10); assert.ok(c.champion.solved > c.previous.solved); assert.ok(c.e > 1 && c.e < 10, 'auto 方向更好但未过阈：' + c.e)
  })
  test('E1 端到端：adopt-provisional → propose 被拒 → confirm（L2 更差）⇒ rolled-back 恢复 previous → 曝光记账 → ruler/status 可读', () => {
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
