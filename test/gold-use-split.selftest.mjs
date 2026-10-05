#!/usr/bin/env node
// test/gold-use-split.selftest.mjs —— v14.21.0 用途隔离（标尺 / 训练料分家）的验收
// 要钉住的四件事：
//   1) 缺省保守：没登记 use 的条目 = 'ruler'（新条目绝不因为忘了登记就溜进训练）；
//   2) 两侧互斥：ruler 侧读不到 train，train 侧读不到 ruler；want 拼错必须抛（防止错字把闸关掉）；
//   3) 加 use 字段不作废既有基准计划：digest 只 hash raw/ctx/draft；
//   4) 训练料通道 fail closed：不合规稿不收、标尺 id 混进来要能炸、同稿多版要产出偏好对。
// 另附一条「真数据回归」：本机的 b13 实测稿重算必须逐分逐位一致（缺 runtime 目录时记 skip，不算通过也不算失败）。
import nodeAssert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (target, kind) => (...args) => { const r = target[kind](...args); pass += 1; return r },
  apply: (target, thisArg, args) => { const r = target(...args); pass += 1; return r },
})
const { goldUse, filterGoldByUse, saveGold, loadGold, goldDigest, buildBenchPlan, DRAFT_DISTANCE_VERSION } = await import('../tools/helpers/three-mode.mjs')
const { loadTrajTrainingSamples, rulerIdSet } = await import('../tools/helpers/traj-corpus.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-gold-use-'))
const root = (p) => path.join(tmp, p)
const cleanAudit = { schema: 'mode1-output-lint/1', status: 'clean', issues: [], textSha256: 'x' }
const mk = (id, fam, over = {}) => ({ schema: 'cfb.gold/1', id, family: fam, split: 'dev', validated: true, raw: '原文：' + id + '\n' + '证据行 A\n'.repeat(40), ctx: 'ctx', draft: '改法只落 src/a.js。\n' + '排除说明\n'.repeat(8), stored: 'ok', qualityAudit: cleanAudit, outcome: { vsRaw: 'win' }, ...over })

// ── 1) 缺省与显式值 ────────────────────────────────────────────────────────
assert.equal(goldUse({}), 'ruler', '缺省 = 标尺（保守）')
assert.equal(goldUse({ use: 'train' }), 'train')
assert.equal(goldUse({ use: 'both' }), 'both')
assert.equal(goldUse({ use: 'garbage' }), 'ruler', '非法值退回标尺，不给它放行到训练侧')
const both = [mk('r1', 'f-a'), mk('t1', 'f-a', { use: 'train' }), mk('b1', 'f-b', { use: 'both' })]
assert.deepEqual(filterGoldByUse(both, 'ruler').map((g) => g.id).sort(), ['b1', 'r1'], 'ruler 侧 = ruler+both')
assert.deepEqual(filterGoldByUse(both, 'train').map((g) => g.id).sort(), ['b1', 't1'], 'train 侧 = train+both')
assert.throws(() => filterGoldByUse(both, 'traun'), /gold-use-want-unknown/, 'want 拼错必须抛')

// ── 2) saveGold 落盘 + digest 不受 use 影响 ─────────────────────────────────
const res = saveGold(root('gold'), [both[0], both[1]], { includeLoss: true })
assert.equal(res.added.length, 2, JSON.stringify(res.skipped))
const reloaded = loadGold(root('gold'))
assert.equal(goldUse(reloaded.find((g) => g.id === 'r1')), 'ruler', '未登记的落盘后仍是 ruler')
assert.equal(goldUse(reloaded.find((g) => g.id === 't1')), 'train', '登记过的落盘保留 use')
const disk = JSON.parse(fs.readFileSync(root('gold/f-a/t1.json'), 'utf8'))
assert.equal(disk.use, 'train')
assert.equal(disk.digest, goldDigest({ raw: disk.raw, ctx: disk.ctx, draft: disk.draft }), 'digest 只算 raw/ctx/draft ⇒ 改用途不作废基准计划')

// ── 3) 基准计划不把 train 条目当标尺 ───────────────────────────────────────
const plan = buildBenchPlan({ n: 99, policies: ['base'], gold: reloaded, split: 'dev', pricing: { compressUsd: 0.011, compressCapUsd: 0.02 } })
assert.deepEqual(plan.gold.map((x) => x.id), ['r1'], 'train 条目不得出现在标尺计划里')
assert.equal(plan.metric, DRAFT_DISTANCE_VERSION)

// ── 4) 训练料通道 ──────────────────────────────────────────────────────────
fs.mkdirSync(root('traj/tX'), { recursive: true })
const row = (over) => ({ schema: 'cfb.hand-sample/1', id: 'f-a-s0-r1', task: 'f-a', round: 1, at: '2026-10-05T00:00:00.000Z', raw: '原文内容 '.repeat(60), ctx: '', draft: '改法只落 src/a.js。', qualityAudit: { status: 'clean' }, trainingEligible: true, ...over })
fs.writeFileSync(root('traj/tX/hand-samples.jsonl'), [
  JSON.stringify(row({})),
  JSON.stringify(row({ at: '2026-10-05T09:00:00.000Z', draft: '改法只落 src/a.js（改稿版）。' })),
  JSON.stringify(row({ id: 'f-a-dirty', trainingEligible: false })),
  JSON.stringify(row({ id: 'f-a-unclean', qualityAudit: { status: 'quarantined' } })),
  JSON.stringify(row({ id: 'f-a-short', raw: '太短' })),
].join('\n') + '\n')
const t = loadTrajTrainingSamples({ root: tmp, dirs: ['traj/tX'], rulerIds: new Set(), minRawChars: 50 })
assert.equal(t.samples.length, 1, '只留 trainingEligible + clean + 够长的')
assert.equal(t.samples[0].id, 'f-a-s0-r1')
assert.equal(t.samples[0].split, 'train', '通道出来的料用途固定为 train')
assert.equal(t.samples[0].hand.includes('改稿版'), true, '同 id 多版取最新当标签')
assert.equal(t.pairs.length, 1, '较早版本进 chosen/rejected 对')
assert.equal(t.stats.droppedIneligible, 1, 'trainingEligible≠true 的一条被剔')
assert.equal(t.stats.droppedShort, 1, '原文长度不够的一条被剔（分项计数，不混在一起）')
assert.equal(t.stats.droppedAudit, 1, '审计不 clean 的一条被剔')
// 标尺 id 混进来：skip 报数 / throw 炸
const s2 = loadTrajTrainingSamples({ root: tmp, dirs: ['traj/tX'], rulerIds: new Set(['f-a-s0-r1']), minRawChars: 50 })
assert.equal(s2.samples.length, 0, '命中标尺 id ⇒ 整条剔除')
assert.equal(s2.stats.asRuler, 2, '剔除要计数（含同 id 的两版）')
assert.deepEqual(s2.stats.rulerIds, ['f-a-s0-r1'], '并且把 id 报出来，不许静默')
assert.throws(() => loadTrajTrainingSamples({ root: tmp, dirs: ['traj/tX'], rulerIds: rulerIdSet([{ id: 'f-a-s0-r1', use: 'ruler' }]), onRulerId: 'throw' }), /ruler-leakage-into-train/, '严格模式必须炸')
assert.throws(() => loadTrajTrainingSamples({ root: tmp, dirs: ['traj/tX'], onRulerId: 'whatever' }), /traj-corpus-onRulerId/, '未知策略直接抛')

// ── 5) 真数据回归（有 runtime 才跑；缺则记 skip） ──────────────────────────
let skipped = 0
const goldReal = loadGold(path.resolve(import.meta.dirname, '..', 'transfer/gold'))
if (goldReal.length) {
  assert.ok(goldReal.every((g) => g.use === 'ruler'), '现注册表 7 条必须显式标尺用途（分家后的起点）')
  assert.ok(goldReal.every((g) => g.digest === goldDigest(g)), '金标 digest 与内容自洽')
  const b13 = path.resolve(import.meta.dirname, '..', '.cfb-runtime/bench/b13/results.jsonl')
  if (fs.existsSync(b13)) {
    const { draftDistance } = await import('../tools/helpers/hand-draft.mjs')
    const rows = fs.readFileSync(b13, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    let same = 0, diff = 0
    for (const r of rows) {
      if (!r.distance || typeof r.text !== 'string') continue
      const g = goldReal.find((x) => x.id === r.gold)
      if (!g) continue
      const d = draftDistance(r.text, g.draft, { raw: g.raw, ctx: g.ctx })
      if (Math.abs(d.score - r.distance.score) < 1e-9 && JSON.stringify(d.key) === JSON.stringify(r.distance.key)) same++; else diff++
    }
    assert.ok(same > 0 && diff === 0, `b13 实测稿在分家后必须逐分逐位复现（同 ${same} / 异 ${diff}）`)
    pass += same
  } else { skipped = 1 }
} else { skipped = 1 }

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`gold-use-split: 用途隔离（缺省保守 / 两侧互斥 / digest 不敏感 / 计划过滤 / 训练通道 fail-closed）通过${skipped ? ` · 真数据回归缺数据而跳过 ${skipped}` : ''}`)
console.log(`PASS=${pass} FAIL=0`)
