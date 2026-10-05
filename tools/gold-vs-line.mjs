#!/usr/bin/env node
// tools/gold-vs-line.mjs —— 「上限闸」的产线对照（$0，无 API）
//
// 为什么要它（2026-10-05 实测）：金标准入只卡「槽位齐 ∧ 真机修好 ∧ 不输 raw ∧ 审计 clean」，
//   没有任何一条问「这算不算极限」⇒ 在册 8 条里 wrong-model_decoy-s0-r4 把 1787 字「压」到 1736 字
//   （净省 51 字，压缩比 0.97）也当金标用；而同一条 raw 交给生产路径（本地 v5-micro + 程序门）能压到
//   1790 字均值以下、G2 8/8 过闸 ⇒ **上限低于产线**。尺子低于产品时，模式 2 会去追一个比产品还松的靶子。
// 本工具把「线」从我的主观阈值改成**同题产线稿的实测长度**：逐条对金标的 raw 重压一遍，记下产线稿
//   的字符数与过闸结果，供 `gold add` 的 C6 判据使用（金标必须压得不比产线少）。
// 成本：compressLocalModel 走 transfer/models/v5-micro-weights.json，实测 ~9.5 ms/条 ⇒ 全量 8 条 <0.1 s，$0。
//
// 用法：node tools/gold-vs-line.mjs [--gold-dir transfer/gold] [--out .cfb-offline/ruler/gold-vs-line.json]
//                                     [--ids a,b] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { birthOffline, offlineBirthConfig } from '../src/offline-birth.js'
import { normalizeConfig } from '../src/config.js'
import { loadV5MicroWeights } from '../src/compile-v5-local.js'
import { handDraftGate } from './helpers/hand-draft.mjs'
import { loadGold } from './helpers/three-mode.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const f = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }

// 产线基线策略 = p-1490eefcdf 的 config（prescreen 实测 dd 0.906 那条；exemplars/patches 全 0 ⇒ 纯程序门）
const LOCAL_POLICY = { id: 'p-v5-local-micro', patches: [], config: { compressLocalModel: true, continuationPath: 'bounded', programParts: 'compact' } }

const goldDir = path.resolve(ROOT, f('--gold-dir') || path.join('transfer', 'gold'))
const out = path.resolve(ROOT, f('--out') || path.join('.cfb-offline', 'ruler', 'gold-vs-line.json'))
const onlyIds = (f('--ids') || '').split(',').map((x) => x.trim()).filter(Boolean)

const weights = loadV5MicroWeights(path.join(ROOT, 'transfer', 'models', 'v5-micro-weights.json'))
const baseCfg = { ...offlineBirthConfig({ model: 'v5-micro-local', baseUrl: 'local://v5-micro', policy: LOCAL_POLICY, normalizeConfig }), captureSideOutput: true, microWeights: weights }

const gold = loadGold(goldDir).filter((g) => !g.missing)
const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null
const lines = { ...(prev && prev.schema === 'cfb.gold-vs-line/1' ? prev.lines : {}) }
const targets = onlyIds.length ? gold.filter((g) => onlyIds.includes(g.id)) : gold
if (!targets.length) { console.log(`✗ 没有可算的金标条目（${path.relative(ROOT, goldDir)}${onlyIds.length ? '，--ids 未命中' : ''}）`); process.exit(2) }

for (const g of targets) {
  // 与 tools/train-v5-micro.mjs 的标尺检验同构：短 raw 放宽净省地板，<2600 字关掉 token 门 ⇒ 免得把「压不出」记成「产线更强」
  const cfg = g.raw.length < 3100
    ? { ...baseCfg, birthMinSavedChars: Math.min(baseCfg.birthMinSavedChars || 50, Math.max(20, Math.floor(g.raw.length * 0.05))), ...(g.raw.length < 2600 ? { birthTokenGate: false } : {}) }
    : baseCfg
  const t0 = performance.now()
  const gated = await birthOffline({ raw: g.raw, ctx: g.ctx, calls: g.calls || [], cfg, gate: true })
  const b = gated.ok ? gated : await birthOffline({ raw: g.raw, ctx: g.ctx, calls: g.calls || [], cfg, gate: false })
  const gate = handDraftGate(g.raw, b.text, g.ctx)
  lines[g.id] = {
    family: g.family, split: g.split || null, rawChars: g.raw.length, lineChars: b.text.length,
    lineRatio: +(b.text.length / Math.max(1, g.raw.length)).toFixed(4),
    g1Ok: !!gated.ok, g1Why: gated.ok ? null : (gated.why || gated.reason || null), g2Ok: !!gate.ok,
    ms: +(performance.now() - t0).toFixed(2), at: new Date().toISOString(),
  }
  console.log(`${g.id.padEnd(46)} 产线 ${String(b.text.length).padStart(5)} 字 / raw ${String(g.raw.length).padStart(5)} ⇒ 线长比 ${lines[g.id].lineRatio}${lines[g.id].g1Ok ? ' · G1✓' : ' · G1✗(' + lines[g.id].g1Why + ')'}`)
}

const doc = { schema: 'cfb.gold-vs-line/1', at: new Date().toISOString(), goldDir: path.relative(ROOT, goldDir), policy: LOCAL_POLICY, weightsDigest: weights?.meta?.weightsDigest || null, note: '金标 C6 判据的线：金标 stored 必须 ≤ 这里记录的 lineChars（产线同题稿实测，不是拍脑袋阈值）', lines }
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
console.log(`\n写入 ${path.relative(ROOT, out)}（${Object.keys(lines).length} 条；本轮算 ${targets.length} 条）`)
if (argv.includes('--json')) console.log(JSON.stringify(doc))
