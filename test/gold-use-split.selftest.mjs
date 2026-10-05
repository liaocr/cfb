#!/usr/bin/env node
// test/gold-use-split.selftest.mjs —— v14.21.0 用途隔离（标尺 / 训练料分家）的验收
// 要钉住的五件事：
//   1) 缺省保守：没登记 use 的条目 = 'ruler'（新条目绝不因为忘了登记就溜进训练）；
//   2) 两侧互斥：ruler 侧读不到 train，train 侧读不到 ruler；want 拼错必须抛（防止错字把闸关掉）；
//   3) 加 use 字段不作废既有基准计划：digest 只 hash raw/ctx/draft；
//   4) 训练料通道 fail closed：不合规稿不收、标尺 id 混进来要能炸、同稿多版要产出偏好对；
//   5) v14.22.0 上限闸：松软稿进不了标尺（C2/C6 等），达线稿要有产线对照读数才收（缺读数 fail-closed）。
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
const res = saveGold(root('gold'), [both[0], both[1]], { includeLoss: true, legacyFloor: true })   // legacyFloor：本例只测 use/digest，上限闸另在第 5 组里测
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
  assert.ok(goldReal.every((g) => ['ruler', 'train', 'both'].includes(g.use || 'ruler')), '每条必须登记用途')
  // v14.22.0 上限闸：还在当标尺的条目必须带 ceiling.ok；被降级成训练料的必须留 useNote（可审计，不许静默）
  assert.ok(goldReal.filter((g) => (g.use || 'ruler') === 'ruler').every((g) => g.ceiling?.ok === true), 'use=ruler 的金标必须过上限闸（缺 ceiling.ok 就别当尺子）')
  assert.ok(goldReal.filter((g) => g.use === 'train').every((g) => g.useNote?.note), '金标降级为训练料必须写 useNote（为什么降级）')
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

// ── 6) 上限闸 goldCeiling：达线放行 / 松软稿挡 / 缺产线对照 fail-closed ──────
{
  const { goldCeiling } = await import('../tools/helpers/three-mode.mjs')
  const raw = 'z'.repeat(1000)
  const goodDraft = '第 3 轮已定因。本轮唯一动作：`edit_file` 把 `compressTargetMax: 1800,` 改为 `compressTargetMax: 450,`。\n'
    + '验收：同轮 `cat src/config.js` 看到 450；若读数仍是 1800 ⇒ 说明 edit 没写进去，重发同一条 edit_file，别回头改别的。\n'
    + '已排除：`maxOutputTokens`——260 < 850、1150 < 4096，上限从没咬过人。'
  const okCase = goldCeiling({ raw, draft: goodDraft, stored: 'w'.repeat(380), outcome: { vsRaw: 'win', roundsToFix: 5 } }, { lineChars: 400, lineRatio: 0.4 })
  assert.ok(okCase.ok, '达线稿要放行：' + JSON.stringify(okCase.fails))
  const soft = goldCeiling({ raw, draft: 'x'.repeat(900) + '\n已排除：A——因为 B。', stored: 'y'.repeat(1200), outcome: { vsRaw: 'win', roundsToFix: 5 } }, { lineChars: 400, lineRatio: 0.4 })
  assert.ok(soft.fails.some((x) => x.startsWith('C1')) && soft.fails.some((x) => x.startsWith('C2')) && soft.fails.some((x) => x.startsWith('C6')), '松软稿（900 字且无判读）必须被 C1 压缩力度 / C2 闭合判读 / C6 不劣于产线 三条同时挡（口径=draft，不含台账）')
  const noLine = goldCeiling({ raw, draft: goodDraft, stored: 'w'.repeat(380), outcome: { vsRaw: 'win', roundsToFix: 5 } }, null)
  assert.ok(!noLine.ok && noLine.fails.some((x) => x.startsWith('C6')), '缺产线对照 ⇒ fail-closed：判不了就是不合格，不默认放行')
  const slow = goldCeiling({ raw, draft: goodDraft, stored: 'w'.repeat(380), outcome: { vsRaw: 'win', roundsToFix: 9 } }, { lineChars: 400, lineRatio: 0.4 })
  assert.ok(slow.fails.some((x) => x.startsWith('C4')), '贴轮数上限的赢法要挡（perf 那条真机就是 r9）')
  const tieLoss = goldCeiling({ raw, draft: goodDraft, stored: 'w'.repeat(380), outcome: { vsRaw: 'tie', roundsToFix: 7, rawRoundsToFix: 5 } }, { lineChars: 400, lineRatio: 0.4 })
  assert.ok(tieLoss.fails.some((x) => x.startsWith('C5')), 'vsRaw=tie 且不比 raw 快要挡')
}

// ── 5) 上限闸进 saveGold：松软稿挡、达线稿收、缺产线对照 fail-closed ─────────
{
  const hardDraft = '第 3 轮已定因。本轮唯一动作：`edit_file` 把 `compressTargetMax: 1800,` 改为 `compressTargetMax: 450,`。\n'
    + '验收：同轮 `cat src/config.js` 看到 450；若仍是 1800 ⇒ 说明 edit 没写进去，重发同一条，别回头改别的。\n'
    + '已排除：`maxOutputTokens`——260 < 850、1150 < 4096，上限从没咬过人。'
  const t5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-ceiling-'))   // 上面几组用完就清了 tmp ⇒ 本组自带目录
  const r5 = (x) => path.join(t5, x)
  const lineFile = r5('gold-vs-line.json')
  // 5a 没有产线对照 ⇒ 一条都不收（不许"没测就算过"）
  const noLine = saveGold(r5('g-a'), [mk('c1', 'f-c', { draft: hardDraft, stored: 'x'.repeat(400), raw: 'r'.repeat(1000), outcome: { vsRaw: 'win', roundsToFix: 5 }, lineFile: null })], { includeLoss: true, lineFile })
  assert.equal(noLine.added.length, 0, '缺 gold-vs-line 读数不能入册')
  assert.ok(noLine.skipped[0].why.includes('C6'), '挡下的理由要指到 C6（并给出该跑的命令）：' + noLine.skipped[0].why)
  // 5b 有对照且达线 ⇒ 收，并把 ceiling 读数留在条目里（可审计）
  fs.writeFileSync(lineFile, JSON.stringify({ schema: 'cfb.gold-vs-line/1', lines: { c1: { lineChars: 500, lineRatio: 0.5 } } }) + '\n')
  const got = saveGold(r5('g-b'), [mk('c1', 'f-c', { draft: hardDraft, stored: 'x'.repeat(400), raw: 'r'.repeat(1000), outcome: { vsRaw: 'win', roundsToFix: 5 } })], { includeLoss: true, lineFile })
  assert.equal(got.added.length, 1, JSON.stringify(got.skipped))
  const saved = JSON.parse(fs.readFileSync(path.join(r5('g-b'), 'f-c', 'c1.json'), 'utf8'))
  assert.equal(saved.ceiling?.ok, true, '入册条目要带 ceiling.ok（尺子的合格凭据留在数据里，不靠人记）')
  // 5c 比产线松 ⇒ 挡（这是「上限低于产品」的直接防线）
  const looser = saveGold(r5('g-c'), [mk('c1', 'f-c', { draft: hardDraft + '\n' + 'y'.repeat(600), stored: 'x'.repeat(900), raw: 'r'.repeat(1000), outcome: { vsRaw: 'win', roundsToFix: 5 } })], { includeLoss: true, lineFile })
  assert.equal(looser.added.length, 0, '稿比产线同题稿长的不能当标尺（口径=draft：台账两边同付，不算作者写的东西）')
  assert.ok(looser.skipped[0].why.includes('C6'), looser.skipped[0].why)
}

console.log(`PASS=${pass} FAIL=0`)