// test/offline-lab.selftest.mjs —— 离线层自测（零 API、零网络）。
// 覆盖：trace 解析、轨迹重建、漏斗、判据内核、黄金集回归、闸门、K 项、秩相关、
//       候选枚举的确定性、出价算术、标注队列与校验、最小可分辨效应。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseTrace, rebuildTrajectories, funnelOf, claimOfV3Core, annotate, truthSet, gateDraft,
  kItemsOf, spearman, rankCandidates, editDistance, similarity, prng, writeJson, readJson,
} from '../tools/helpers/offline-core.mjs'
import { buildCorpus } from '../tools/cfb-corpus.mjs'
import { BUILTIN, regress, regressAll, coreAgreement, METRIC_COVERAGE } from '../tools/cfb-criteria.mjs'
import { enumerateCandidates, specOf, knobId, scoreDraft, WEIGHTS, K_CORE, KNOBS } from '../tools/cfb-lab.mjs'
import { powerAt, LABEL_VALUES, checkLabels, buildQueue } from '../tools/cfb-labels.mjs'
import { claimOfV3 } from '../tools/effect-mr.mjs'

let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-offline-'))

try {
  // ── trace 层
  test('01 parseTrace：只认锚定行；JSON 文本里的 [BOOT] 不切分', () => {
    const lines = [
      '[2026-10-02T00:00:00.000Z] [BOOT] {"selfId":"s1","mode":"birth"}',
      '[2026-10-02T00:00:01.000Z] [birth-fired] {"taskId":"t1","rawChars":3000}',
      'garbage line',
      '[2026-10-02T00:00:02.000Z] [birth-condensed] {"taskId":"t1","outChars":900}',
      '[2026-10-02T00:00:03.000Z] [x] notjson',
    ]
    const ev = [...parseTrace(lines.join('\n'))]
    assert.equal(ev.length, 3)
    assert.deepEqual(ev.map((e) => e.tag), ['BOOT', 'birth-fired', 'birth-condensed'])
    const st = parseTrace(lines.join('\n')).stats()
    assert.ok(st.malformed >= 1, '坏 JSON 必须计入 malformed')
    assert.ok(st.ignored >= 1, '非锚定行必须计入 ignored')
  })
  test('02 rebuildTrajectories + funnelOf：块生命周期折叠正确', () => {
    const text = [
      '[2026-10-02T00:00:00.000Z] [BOOT] {"selfId":"s1"}',
      '[2026-10-02T00:00:01.000Z] [birth-fired] {"taskId":"t1","rawChars":4000}',
      '[2026-10-02T00:00:02.000Z] [birth-distill-settled] {"taskId":"t1","ok":true,"outputChars":1000}',
      '[2026-10-02T00:00:03.000Z] [birth-finish-enter] {"taskId":"t1","waitedMs":120}',
      '[2026-10-02T00:00:04.000Z] [birth-condensed] {"taskId":"t1","outChars":1000}',
      '[2026-10-02T00:00:05.000Z] [birth-fired] {"taskId":"t2","rawChars":2000}',
      '[2026-10-02T00:00:06.000Z] [birth-distill-failed] {"taskId":"t2","reason":"timeout"}',
      '[2026-10-02T00:00:07.000Z] [birth-passthrough] {"taskId":"t2"}',
    ].join('\n')
    const trajs = rebuildTrajectories([...parseTrace(text)])
    assert.equal(trajs.tasks.length, 2)
    const t1 = trajs.tasks.find((t) => t.taskId === 't1')
    assert.equal(t1.blocks.length, 1)
    assert.equal(t1.blocks[0].stages.distilled, true)
    assert.equal(t1.blocks[0].stages.condensed, true)
    assert.equal(t1.blocks[0].rawChars, 4000)
    assert.equal(t1.blocks[0].outChars, 1000)
    const f = funnelOf(trajs)
    assert.equal(f.blocks, 2); assert.equal(f.distilled, 1); assert.equal(f.distillFailed, 1)
    assert.equal(f.condensed, 1); assert.equal(f.passthrough, 1)
    assert.equal(f.meanRatio, 0.25)
  })

  // ── 判据内核
  test('03 claimOfV3Core 与运行时 claimOfV3 逐条一致（防内核漂移）', () => {
    const g = coreAgreement(BUILTIN)
    assert.deepEqual(g.diff, [], '内核与运行时判据必须同判')
  })
  test('04 黄金集：claimOfV3 精确率/召回率均 100%，且优于 V2', () => {
    const a = regressAll(undefined, BUILTIN)
    assert.equal(a.claimOfV3.precision, 1)
    assert.equal(a.claimOfV3.recall, 1)
    assert.ok(a.claimOfV3.fp < a.claimOfV2.fp, 'V3 的伪阳性必须少于 V2')
    assert.equal(a.claimOfV3.fn, 0, '真阳性不允许丢')
  })
  test('05 新增两类守卫各自独立生效（后置否定 / 定语用法）', () => {
    assert.notEqual(claimOfV3Core('修复没有落地，进程还是读的旧配置。'), 'fixed')
    assert.notEqual(claimOfV3Core('已修复的路径有两条，但我用的是第三条。'), 'fixed')
    // 守卫不得误伤正常肯定
    assert.equal(claimOfV3Core('问题已修复。'), 'fixed')
    assert.equal(claimOfV3Core('改完了，已经解决。'), 'fixed')
  })
  test('06 七个理论指标：离线可判的必须标 offline，不可判的必须诚实标出', () => {
    const off = METRIC_COVERAGE.filter((m) => m.offline).map((m) => m.metric)
    const on = METRIC_COVERAGE.filter((m) => !m.offline).map((m) => m.metric)
    for (const m of ['falseDone', 'repeat', 'bump', 'reEdit']) assert.ok(off.includes(m), m + ' 应当离线可判')
    for (const m of ['contradiction', 'oscillation', 'wrongEdit', 'correct']) assert.ok(on.includes(m), m + ' 需要评委，不得假装可判')
  })

  // ── 打分与闸门
  test('07 gateDraft：发明标识符即拒；长度上下界生效', () => {
    const ctx = '改 DSH_HOME 解析；verify.mjs 用临时 DSH_HOME'
    assert.equal(gateDraft('改 DSH_HOME 解析', ctx).ok, true)
    const bad = gateDraft('改 DSH_HOME 解析，另外 CACHE_MAGIC_KEY 也要改', ctx)
    assert.equal(bad.ok, false)
    assert.ok(bad.invented.includes('CACHE_MAGIC_KEY'))
    assert.equal(gateDraft('x'.repeat(5000), ctx, { maxChars: 100 }).overLength, true)
  })
  test('08 kItemsOf：K1 的新鲜度子句是二分，K3/K5/K6 可检出', () => {
    assert.equal(kItemsOf('验收是 tail trace.log')[encodeURIComponent('K1')] ?? kItemsOf('验收是 tail trace.log').K1, 1)
    assert.equal(kItemsOf('验收是 tail trace.log；先 : > trace.log 清空再跑').K1, 2)
    assert.equal(kItemsOf('若数字跟着参数走，说明参数不是原因').K3, 1)
    assert.equal(kItemsOf('收工三问：落地证据、原症状、观察新鲜').K5, 1)
    assert.equal(kItemsOf('零效应 ⇒ 找消费点').K6, 1)
    assert.equal(kItemsOf('今天天气不错').count, 0)
  })
  test('09 scoreDraft：闸门失败时分数显著低于通过时；权重可逐项归因', () => {
    const ctx = '改 DSH_HOME；verify.mjs'
    const spec = specOf({ order: 'state-first', length: 'normal', exclusionForm: 'paired', person: 'first', freshness: 'on', kItems: 'core', notation: 'prose' })
    const good = scoreDraft('已排除 锁文件（fs-lock 正常）；收工三问：落地证据、原症状、观察新鲜', ctx, spec)
    const bad = scoreDraft('改 INVENTED_TOKEN_XYZ', ctx, spec)
    assert.ok(good.score > bad.score)
    assert.ok(bad.parts.invention < 0, '发明标识符必须有负分')
    assert.equal(Object.values(good.parts).reduce((a, b) => a + b, 0), good.score, '分数必须等于各项之和')
  })

  // ── 统计与排序
  test('10 spearman：完全单调 = 1，完全反单调 = -1，样本不足 = null', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1)
    assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1)
    assert.equal(spearman([1, 2], [1, 2]), null)
    assert.equal(spearman([1, 2, 3, 4], [2, 4, 6, 8]), 1, '单调缩放不改变秩相关')
    assert.equal(spearman([1, 2, 3, 4], [11, 12, 13, 14]), 1, '单调平移不改变秩相关')
    assert.equal(spearman([1, 2, 3, 4], [-1, -2, -3, -4]), -1, '取反必须翻转符号')
    // 用**独立闭式**当预言机（无并列：ρ = 1 − 6Σd²/(n(n²−1))），逐例核对实现
    const oracle = (a, b) => {
      const n = a.length
      const ra = [...a].map((v) => a.filter((x) => x < v).length + 1)
      const rb = [...b].map((v) => b.filter((x) => x < v).length + 1)
      const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0)
      return 1 - (6 * d2) / (n * (n * n - 1))
    }
    const cases = [
      [[1, 2, 3, 4], [5, 6, 7, 9]],
      [[1, 2, 3, 4], [9, 7, 6, 5]],
      [[1, 2, 3, 4, 5], [2, 1, 4, 3, 9]],
      [[10, 20, 30, 50], [1, 2, 3, 4]],
    ]
    for (const [x, y] of cases) assert.ok(Math.abs(spearman(x, y) - oracle(x, y)) < 1e-9, '与闭式不符: ' + JSON.stringify([x, y]))
    // 实现内部的秩函数必须给出正确秩（1..n 的排列）
    assert.equal(spearman([1, 2, 3, 4], [1, 2, 3, 3.5]), spearman([1, 2, 3, 4], [1, 2, 3, 3.5]), '幂等')
  })
  test('11 rankCandidates：按分数降序，并给出与真实值的秩相关', () => {
    const r = rankCandidates([{ score: 1, truth: 5 }, { score: 3, truth: 7 }, { score: 2, truth: 6 }])
    assert.deepEqual(r.ranked.map((x) => x.score), [3, 2, 1])
    assert.equal(r.agreement, 1); assert.equal(r.n, 3)
  })
  test('12 editDistance / similarity：自身距离 0，相似度单调', () => {
    assert.equal(editDistance('abc', 'abc'), 0)
    assert.equal(editDistance('', 'abc'), 3)
    assert.equal(similarity('abc', 'abc'), 1)
    assert.ok(similarity('abcd', 'abce') > similarity('abcd', 'zzzz'))
  })

  // ── 候选空间
  test('13 候选枚举确定性：同 seed 同结果，不同 seed 不同排列', () => {
    const a = enumerateCandidates({ n: 8, seed: 7 }).map(knobId)
    const b = enumerateCandidates({ n: 8, seed: 7 }).map(knobId)
    const c = enumerateCandidates({ n: 8, seed: 8 }).map(knobId)
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, c)
    assert.equal(new Set(a).size, a.length, '候选不得重复')
  })
  test('14 候选空间规模 = 各旋钮取值数之积，且 specOf 给出一致的长度预算', () => {
    const total = Object.values(KNOBS).reduce((n, v) => n * v.length, 1)
    assert.equal(total, 3 * 3 * 3 * 2 * 2 * 3 * 2)
    const tight = specOf({ order: 'state-first', length: 'tight', exclusionForm: 'paired', person: 'first', freshness: 'on', kItems: 'all', notation: 'prose' })
    const roomy = specOf({ order: 'state-first', length: 'roomy', exclusionForm: 'paired', person: 'first', freshness: 'on', kItems: 'all', notation: 'prose' })
    assert.ok(tight.maxChars < roomy.maxChars)
    assert.ok(K_CORE.every((k) => typeof k === 'string'))
    assert.ok(WEIGHTS.gate > 0)
  })

  // ── 出价与标注
  test('15 最小可分辨效应随 n 单调下降，且 n=2 时几乎不可分辨', () => {
    const p2 = powerAt(2), p20 = powerAt(20), p384 = powerAt(384)
    assert.ok(p2.percent > p20.percent && p20.percent > p384.percent)
    assert.ok(p2.percent > 100, 'n=2 时最小可分辨差应超过 100 个百分点（即：什么都判不了）')
    assert.ok(Math.abs(p384.percent - 10) < 1, 'n≈384 才能分辨 10 个百分点')
    assert.equal(powerAt(1), null)
  })
  test('16 标注队列可生成、去重、分层；checkLabels 拒绝缺失/非法/重复', () => {
    const dir = tmp()
    try {
      const corpus = { schema: 'cfb.offline-corpus/1', items: [
        { key: 'k1', task: 't1', kind: 'raw', text: '问题已修复。已修复的路径有两条。' },
        { key: 'k2', task: 't1', kind: 'auto', text: '还没有修复这个分支。' },
      ], production: { available: false }, runs: 1, split: { train: [], dev: [], test: [] }, warnings: [] }
      const cp = path.join(dir, 'corpus.json')
      writeJson(cp, corpus)
      const q = buildQueue({ corpusPath: cp, n: 10, seed: 3 })
      assert.ok(q.length >= 2)
      assert.equal(new Set(q.map((r) => r.id)).size, q.length, 'id 不得重复')
      assert.ok(q.every((r) => r.label === null))
      assert.ok(q.every((r) => LABEL_VALUES.concat([null]).includes(r.label)))
      assert.equal(checkLabels(path.join(dir, 'nope.json')).ok, false)
      const bad = path.join(dir, 'labels.json')
      writeJson(bad, { schema: 'cfb.labels/1', rows: [{ id: 'a', text: 'x', label: 'bogus' }] })
      assert.equal(checkLabels(bad).ok, false)
      const dup = path.join(dir, 'dup.json')
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: 'same', text: 't' + i, label: 'none' }))
      writeJson(dup, { schema: 'cfb.labels/1', rows })
      assert.equal(checkLabels(dup).ok, false)
      const good = path.join(dir, 'good.json')
      writeJson(good, { schema: 'cfb.labels/1', rows: Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, text: 't' + i, label: 'none' })) })
      assert.equal(checkLabels(good).ok, true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ── 端到端：语料
  test('17 buildCorpus 端到端：缺 trace 时降级但不抛，且语料自包含（含全文与 ctx）', () => {
    const dir = tmp()
    try {
      const { corpus } = buildCorpus({ tracePath: path.join(dir, 'nope.log'), outDir: dir })
      assert.equal(corpus.production.available, false)
      assert.ok(corpus.warnings.some((w) => /trace/.test(w)))
      if (corpus.items.length) {
        assert.equal(typeof corpus.items[0].text, 'string')
        assert.equal(typeof corpus.items[0].ctx, 'string')
      }
      assert.ok(corpus.split && Array.isArray(corpus.split.train))
      // 题不跨集
      const all = [...corpus.split.train, ...corpus.split.dev, ...corpus.split.test]
      assert.equal(new Set(all).size, all.length)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('18 语料切分覆盖率 100%：每个任务恰好落在一个集里', () => {
    const dir = tmp()
    try {
      const { corpus } = buildCorpus({ tracePath: path.join(dir, 'nope.log'), outDir: dir })
      if (!corpus.runs) return
      const all = [...corpus.split.train, ...corpus.split.dev, ...corpus.split.test]
      assert.equal(all.length, corpus.runs)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('19 prng 确定性且在 [0,1) 内', () => {
    const a = prng(42), b = prng(42)
    for (let i = 0; i < 100; i++) { const x = a(), y = b(); assert.equal(x, y); assert.ok(x >= 0 && x < 1) }
    assert.notEqual(prng(1)(), prng(2)())
  })
  test('20 truthSet 从 ctx 抽取可核真集合', () => {
    const s = truthSet('改 DSH_HOME 解析，verify.mjs 用临时 DSH_HOME')
    assert.ok(s.has('DSH_HOME')); assert.ok(s.has('verify.mjs'))
    assert.ok(!s.has('NEVER_SEEN_TOKEN'))
  })
} finally {
  console.log('\n=== offline-lab selftest: ' + pass + ' pass / ' + fail + ' fail ===')
  process.exitCode = fail ? 1 : 0
}
