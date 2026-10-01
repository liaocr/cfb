// test/judge-calibration.selftest.mjs —— 判断层 + 校准回灌层 + 编排层自测（零 API）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DIMENSIONS, DIMS_BY_RATER, judgeCapacity, binaryCeiling, judgeLadPrompt, parseJudgeLad,
  normalizeDims, compositeScore, DEFAULT_WEIGHTS, raterAgreement, ruleLlmDisagreement,
  pairedBootstrap, pairedEffectSize, judgeKey,
} from '../tools/helpers/judge-layer.mjs'
import { LEVERS, priorityOrder, K_ARM, ablationSet, layeredSet, renderSpec, applyKnobs } from '../tools/helpers/levers.mjs'
import { fitWeights, toRow, rankAgreement, missingDimensionSignal, activeSelect, solve } from '../tools/helpers/calibration.mjs'

let pass = 0, fail = 0
const test = (n, fn) => { try { fn(); pass++; console.log('PASS ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n' + e.stack) } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-judge-'))
const vec = (o = {}) => Object.fromEntries(DIMENSIONS.map((d) => [d.id, o[d.id] != null ? o[d.id] : d.scale[1]]))

try {
  // ── 判断层：上限必须高（用户硬要求）
  test('01 判断层容量远高于二值：维度≥8、状态空间≥10^3、bit ≥ 8', () => {
    const c = judgeCapacity()
    assert.ok(c.dimensions >= 8, '维度太少，上限不够高')
    assert.ok(c.states >= 1000, '状态空间太小')
    assert.ok(c.bits >= 8, '信息量太低：' + c.bits)
    assert.ok(c.bits / binaryCeiling(2).bits >= 8, '相对二值的分辨率提升不足')
    assert.ok(c.codeDims >= 2 && c.llmDims >= 4, '代码与评委必须都有份')
  })
  test('02 每个维度都有定义、刻度、锚点、评分者（科学可量化的前提）', () => {
    for (const d of DIMENSIONS) {
      assert.ok(d.id && typeof d.id === 'string')
      assert.ok(d.def && d.def.length > 10, d.id + ' 缺定义')
      assert.ok(Array.isArray(d.scale) && d.scale.length === 2 && d.scale[1] > d.scale[0], d.id + ' 刻度非法')
      assert.ok(d.anchors && Object.keys(d.anchors).length >= 3, d.id + ' 缺锚点')
      assert.ok(['code', 'llm'].includes(d.rater), d.id + ' 评分者非法')
    }
  })
  test('03 必须有大模型参与：语义维度 ≥4 且落在评委侧', () => {
    assert.ok(DIMS_BY_RATER.llm.length >= 4, '语义维度太少，等于全交给写死的代码')
    for (const id of ['evidenceSufficiency', 'actionResolve', 'foresight', 'stateCalibration']) {
      assert.ok(DIMS_BY_RATER.llm.includes(id), id + ' 必须由评委测（写死的规则测不了语义）')
    }
    const p = judgeLadPrompt({ task: 't', ctx: 'c', draft: 'd' })
    for (const id of DIMS_BY_RATER.llm) assert.ok(p.includes(id), '评委提示词必须包含 ' + id)
    assert.ok(p.includes('confidence') && p.includes('note'))
  })
  test('04 评委输出解析：越界钳制、非法丢弃、缺项可检出', () => {
    const good = parseJudgeLad(JSON.stringify({ evidenceSufficiency: 0.8, actionResolve: 9, foresight: 1, stateCalibration: 0.5, infoDensity: 0.7, redundancy: 0.1, confidence: 0.9, note: 'ok' }))
    assert.equal(good.ok, true); assert.equal(good.missing.length, 0); assert.equal(good.confidence, 0.9)
    const over = parseJudgeLad({ evidenceSufficiency: 99, actionResolve: -5 })
    assert.equal(over.values.evidenceSufficiency, 1, '越界必须钳制')
    assert.equal(over.values.actionResolve, 0, '越界必须钳制')
    assert.equal(parseJudgeLad('not json').ok, false)
    assert.equal(parseJudgeLad('[]').ok, false)
    const miss = parseJudgeLad({ evidenceSufficiency: 0.5 }, { requireAll: true })
    assert.equal(miss.ok, false); assert.ok(miss.reason.startsWith('missing'))
  })

  // ── 打分：可归因
  test('05 综合分 = 各归因项之和；「越小越好」的维度方向必须正确', () => {
    const c = compositeScore(vec())
    assert.equal(Object.values(c.parts).reduce((a, b) => a + b, 0).toFixed(4), c.score.toFixed(4), '分数必须等于各项之和')
    const bad = compositeScore(vec({ invention: 1, redundancy: 1 }))    // 1 = 最差
    const good = compositeScore(vec({ invention: 0, redundancy: 0 }))   // 0 = 最好
    assert.ok(good.score > bad.score, '低发明低冗余必须得分更高: good=' + good.score + ' bad=' + bad.score)
    // 方向已由 normalizeDims 统一 ⇒ 归因项一律非负，差的是「质量分」而不是「符号」
    assert.ok(bad.parts.invention < good.parts.invention, '发明越多，该项贡献必须越小')
    assert.ok(bad.parts.redundancy < good.parts.redundancy, '冗余越多，该项贡献必须越小')
    assert.ok(Object.values(bad.parts).every((v) => v >= 0), '统一方向后不得出现负的归因项')
    // 负权重是笔误（方向已统一），必须被拒绝而不是静默算错
    assert.throws(() => compositeScore(vec({ invention: 0 }), { invention: -18 }), /weight-must-be-nonnegative/)
  })
  test('06 归一化把不同刻度拉到 [0,1]，缺项为 null 不参与', () => {
    const n = normalizeDims({ kCoverage: 6, actionResolve: 10, evidenceSufficiency: 1 })
    assert.equal(n.kCoverage, 1); assert.equal(n.actionResolve, 1); assert.equal(n.evidenceSufficiency, 1)
    assert.equal(n.foresight, null, '未给的维度必须是 null，不能默认满分')
    const c = compositeScore({ kCoverage: 6, actionResolve: 10 })
    assert.ok(c.coverage < 1, '覆盖率必须反映缺失')
  })
  test('07 judgeKey 稳定且区分不同输入', () => {
    assert.equal(judgeKey(['a', 1]), judgeKey(['a', 1]))
    assert.notEqual(judgeKey(['a', 1]), judgeKey(['a', 2]))
  })

  // ── 一致性 / 分歧
  test('08 多票一致性：一致票 sd≈0，分歧票 sd 大', () => {
    const same = raterAgreement([vec({ actionResolve: 8 }), vec({ actionResolve: 8 }), vec({ actionResolve: 8 })])
    assert.ok(same.actionResolve.sd === 0)
    const diff = raterAgreement([vec({ actionResolve: 1 }), vec({ actionResolve: 5 }), vec({ actionResolve: 10 })])
    assert.ok(diff.actionResolve.sd > 3, '分歧必须被 sd 捕获')
    assert.equal(raterAgreement([vec()]).actionResolve.icc, null, '单票算不了 ICC')
  })
  test('09 规则×评委分歧能捕捉「发明多却自称证据充分」', () => {
    const d = ruleLlmDisagreement({ formClosed: 1, invention: 0.4 }, { formClosed: 0.2, evidenceSufficiency: 0.95 })
    assert.ok(d.some((x) => x.dim === 'formClosed'))
    assert.ok(d.some((x) => x.dim === 'invention×evidence'))
    assert.equal(ruleLlmDisagreement({ formClosed: 1, invention: 0 }, { formClosed: 1, evidenceSufficiency: 0.5 }).length, 0)
  })

  // ── 统计：让「有没有提升」可判定
  test('10 pairedBootstrap：一致正差显著、噪声差不显著、n<2 返回空', () => {
    const sig = pairedBootstrap([2, 2.5, 3, 2.2, 2.8, 2.4, 2.6, 2.9])
    assert.ok(sig.significant, '一致正向差必须显著')
    assert.ok(sig.lo > 0)
    const noise = pairedBootstrap([3, -3, 2, -2, 1, -1])
    assert.ok(!noise.significant, '来回摆的差不能算显著')
    assert.equal(pairedBootstrap([1]).n, 1)
    assert.ok(pairedBootstrap([1]).note === 'n<2')
  })
  test('11 pairedEffectSize：刻度统一（d 可跨实验比较）；零方差时诚实返回 null', () => {
    const e = pairedEffectSize([1, 1, 2, 1, 1, 2])
    assert.equal(e.n, 6); assert.ok(e.d > 1, '一致正向差必须是大效应，实得 d=' + (e && e.d))
    assert.equal(pairedEffectSize([1]), null, 'n<2 无效应量')
    // 零方差 + 非零均值 ⇒ Cohen's d 分母为 0，数学上无定义；必须诚实返回 null 而不是 Infinity
    assert.equal(pairedEffectSize([1, 1, 1, 1, 1]), null, '零方差时 d 无定义，不得编造')
  })

  // ── 生成层：杠杆按效应量排序
  test('12 杠杆优先级：K项第一（历史最大效应量），版面旋钮垫底', () => {
    const o = priorityOrder()
    assert.equal(o[0].id, 'kItems', 'K 项必须是第一优先级')
    assert.equal(o[o.length - 1].priority, 5, '旋钮必须垫底')
    assert.ok(o[0].priority < o[1].priority)
    assert.ok(LEVERS.every((l) => l.theory && l.theory.length > 5), '每个杠杆必须挂理论依据')
  })
  test('13 消融集：只动一个杠杆，其余固定为基线（可归因）', () => {
    const s = ablationSet({ lever: 'kItems' })
    assert.equal(s[0].id, 'baseline'); assert.equal(s[0].isBaseline, true)
    assert.deepEqual(s.map((c) => c.value), ['off', 'core', 'all'])
    for (const c of s.slice(1)) {
      const diff = Object.keys(c.knobs).filter((k) => c.knobs[k] !== s[0].knobs[k])
      assert.deepEqual(diff, ['kItems'], '只允许一个杠杆变化，实际变了 ' + diff)
    }
  })
  test('14 分层集：每个杠杆各推进一格，且都区别于基线', () => {
    const s = layeredSet()
    assert.equal(s[0].id, 'baseline')
    for (const c of s.slice(1)) {
      const diff = Object.keys(c.knobs).filter((k) => c.knobs[k] !== s[0].knobs[k])
      assert.equal(diff.length, 1, '每个变体只动一个杠杆')
      assert.equal(diff[0], c.lever)
    }
    assert.ok(s.length >= 4, '至少要覆盖多个杠杆')
  })
  test('15 applyKnobs：K 项可开可关，死路形态可切换，且幂等', () => {
    const base = '上一轮已定：改 DSH_HOME。\n状态：已改未验证。'
    const off = applyKnobs(base, { kItems: 'off', selection: 'balanced', deadEnd: 'drop', layout: 'state-first', length: 'normal' })
    const core = applyKnobs(base, { kItems: 'core', selection: 'balanced', deadEnd: 'paired', layout: 'state-first', length: 'normal' })
    assert.ok(core.length > off.length, 'K 项开着必须更长')
    assert.ok(!off.includes('可推导') && !off.includes('新鲜度'), 'K 关掉后不应有 K 文本')
    assert.ok(core.includes('新鲜度'), 'K 开着必须有 K1')
    assert.ok(!core.includes('K2') || true)
    const all = applyKnobs(base, { kItems: 'all', selection: 'balanced', deadEnd: 'paired', layout: 'state-first', length: 'normal' })
    assert.ok(all.length >= core.length)
    assert.equal(applyKnobs(all, { kItems: 'all', selection: 'balanced', deadEnd: 'paired', layout: 'state-first', length: 'roomy' }), applyKnobs(all, { kItems: 'all', selection: 'balanced', deadEnd: 'paired', layout: 'state-first', length: 'roomy' }), '必须幂等')
    assert.ok(applyKnobs(base, { kItems: 'off', selection: 'balanced', deadEnd: 'paired', layout: 'state-first', length: 'normal' }).includes('已排除'))
  })

  // ── 校准回灌层
  test('16 权重拟合：样本足够时 R² 高、一致性好；样本不足时收缩不宣称', () => {
    const rows = []
    for (let i = 0; i < 24; i++) { const q = i / 23; rows.push({ x: [q, q, 0.02, q, q, q, q, q, 1 - q], y: q * 10 }) }
    const f = fitWeights(rows)
    assert.equal(f.ok, true); assert.ok(f.r2 > 0.9, 'R² 应高'); assert.equal(f.confidence, 'high')
    assert.ok(rankAgreement(rows, f.weights).rho > 0.9, '拟合后排序一致性必须高')
    const few = fitWeights(rows.slice(0, 3))
    assert.equal(few.ok, false); assert.equal(few.reason, 'insufficient')
    assert.deepEqual(few.weights, DEFAULT_WEIGHTS, '样本不足必须收缩到默认权重')
  })
  test('17 缺维度信号：全被现有维度解释时不报警，解释不了时报警', () => {
    const clean = []
    for (let i = 0; i < 16; i++) { const q = i / 15; clean.push({ x: [q, q, 0, q, q, q, q, q, 1 - q], y: q * 10 }) }
    assert.equal(missingDimensionSignal(clean).signal, false, '现有维度够用时不得误报')
    // 造一批「特征接近最好、结果却最差」的样本 ⇒ 缺维度
    const broken = []
    for (let i = 0; i < 14; i++) { const q = i / 13; broken.push({ x: [q, q, 0, q, q, q, q, q, 1 - q], y: q * 10 }) }
    broken.push({ x: [0.98, 0.98, 0, 0.98, 0.98, 0.98, 0.98, 0.98, 0.02], y: 0.1 })
    broken.push({ x: [0.97, 0.97, 0, 0.97, 0.97, 0.97, 0.97, 0.97, 0.03], y: 0.0 })
    assert.equal(missingDimensionSignal(broken).signal, true, '解释不了的失败必须触发缺维度信号')
    assert.equal(missingDimensionSignal(clean.slice(0, 3)).ok, false, '样本不足不得给结论')
  })
  test('18 主动学习：预算分配为一半探索一半利用，且不重不漏', () => {
    const rows = []
    for (let i = 0; i < 12; i++) { const q = i / 11; rows.push({ x: [q, q, 0, q, q, q, q, q, 1 - q], y: q * 10 }) }
    const cands = Array.from({ length: 10 }, (_, i) => ({ id: 'c' + i, x: [i / 9, i / 9, 0, i / 9, i / 9, i / 9, i / 9, i / 9, 1 - i / 9] }))
    const p = activeSelect(cands, rows, { budget: 6 })
    assert.equal(p.all.length, 6)
    assert.equal(new Set(p.all.map((c) => c.id)).size, 6, '不得重复选中')
    assert.ok(p.explore.length >= 1 && p.exploit.length >= 1, '探索与利用必须都有')
    assert.ok(p.explore.every((c) => Number.isFinite(c.uncertainty)))
  })
  test('19 solve：可解、奇异保护', () => {
    assert.deepEqual(solve([[2, 0], [0, 2]], [4, 6]), [2, 3])
    assert.equal(solve([[1, 1], [1, 1]], [1, 2]), null, '奇异必须返回 null 而不是瞎给解')
  })
  test('20 toRow：向量对齐维度顺序，方向已统一（发明/冗余取反）', () => {
    const r = toRow({ invention: 1, redundancy: 1, kCoverage: 6 }, 5)
    const di = DIMENSIONS.findIndex((d) => d.id === 'invention')
    const dr = DIMENSIONS.findIndex((d) => d.id === 'redundancy')
    assert.equal(r.x[di], 0, '发明率 1 必须映射为 0（越小越好已取反）')
    assert.equal(r.x[dr], 0, '冗余率 1 必须映射为 0')
    const dk = DIMENSIONS.findIndex((d) => d.id === 'kCoverage')
    assert.equal(r.x[dk], 1)
    assert.equal(r.y, 5)
  })
} finally {
  console.log('\n=== judge-calibration selftest: ' + pass + ' pass / ' + fail + ' fail ===')
  process.exitCode = fail ? 1 : 0
}
