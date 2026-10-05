// tools/helpers/traj-corpus.mjs —— 模式 1 手稿轨迹 → micro 的**训练料通道**（零 API）
//
// 为什么要有这个文件（v14.21.0，见 docs/GOLD-EXPANSION-PROGRAM.md §1）：
//   以前 micro 的拟合料直接来自 transfer/gold —— 而同一份 gold 又是模式 2 的标尺（策略在它上面被挑出来）。
//   用同一份数据既挑策略又拟合模型，「micro 追平标尺」就是自证，读数无意义。所以分家：
//     transfer/gold（use=ruler）→ 只当标尺 / 评审参照；
//     本通道（traj hand-samples）→ 只当训练料。
//   这里挑的正是**没进标尺**的那部分手稿：trainingEligible=true 且内容审计 clean，含改稿前后版本 ⇒ 天然的 rejected/chosen 偏好对。
//
// 硬规则（fail closed，宁可不训也不泄漏）：
//   1) 只收 trainingEligible === true 且 qualityAudit.status === 'clean'；
//   2) id 命中注册表标尺侧（use=ruler / both）⇒ 整条剔除并**报出 id**（onRulerId:'throw' 时直接抛）。
//      为什么默认剔除而不是抛：金标本来就是 goldItemsFromTraj 从这些 traj 手稿里 add 进去的，两通道必然有 id 交集；
//      抛 = 永远跑不动，静默丢 = 看不见漏了多少。所以「剔除 + 显式计数 + 调用方对最终拟合集再断一次」。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { goldRulerOk } from './three-mode.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CORPUS_ROOT = path.resolve(HERE, '..', '..')

/** 默认料源 = .cfb-runtime/traj/t* 的 hand-samples.jsonl（存在才收，缺目录不算错）。 */
export function defaultTrajDirs(root = CORPUS_ROOT) {
  const base = path.join(root, '.cfb-runtime', 'traj')
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).sort().map((d) => path.join(base, d))
    .filter((d) => fs.existsSync(path.join(d, 'hand-samples.jsonl')))
}

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
  try { return JSON.parse(l) } catch { return null }
}).filter(Boolean)

/**
 * @param {object} o
 * @param {string} [o.root]      仓库根
 * @param {string[]} [o.dirs]    traj 计划目录（默认自动发现 t*）
 * @param {Set<string>} [o.rulerIds] 标尺侧 id 集合，命中即泄漏 ⇒ 抛
 * @param {string[]} [o.families]     只要这些家族（缺省 = 全收）
 * @param {number} [o.minRawChars]    原文长度下限（覆盖矩阵用，缺省 0）
 */
export function loadTrajTrainingSamples({ root = CORPUS_ROOT, dirs = null, rulerIds = new Set(), families = null, minRawChars = 0, onRulerId = 'skip' } = {}) {
  if (onRulerId !== 'skip' && onRulerId !== 'throw') throw new Error('traj-corpus-onRulerId:' + onRulerId)
  const roots = dirs && dirs.length ? dirs.map((d) => path.resolve(root, d)) : defaultTrajDirs(root)
  const byId = new Map()
  const stats = { files: 0, rows: 0, droppedIneligible: 0, droppedAudit: 0, droppedFamily: 0, droppedShort: 0, revised: 0, asRuler: 0, rulerIds: [] }
  for (const dir of roots) {
    const file = path.join(dir, 'hand-samples.jsonl')
    if (!fs.existsSync(file)) continue
    stats.files++
    const planId = path.basename(dir)
    for (const r of readJsonl(file)) {
      stats.rows++
      const id = String(r.id || '')
      if (!id) { stats.droppedIneligible++; continue }
      if (rulerIds.has(id)) {
        if (onRulerId === 'throw') throw new Error(`ruler-leakage-into-train:${id}（该条目在标尺侧 use=ruler，不得进训练料：${path.relative(root, file)}）`)
        stats.asRuler++
        if (!stats.rulerIds.includes(id)) stats.rulerIds.push(id)
        continue
      }
      if (r.trainingEligible !== true) { stats.droppedIneligible++; continue }
      if (r.qualityAudit?.status !== 'clean') { stats.droppedAudit++; continue }
      const family = String(r.task || r.family || '').replace(/^pool:/, '')
      if (families && families.length && !families.includes(family.split(/[:_]/)[0])) { stats.droppedFamily++; continue }
      const raw = String(r.raw || '')
      if (raw.length < minRawChars) { stats.droppedShort++; continue }
      const hand = String(r.draft || r.gold || r.hand || '')
      if (!raw || !hand) { stats.droppedIneligible++; continue }
      const item = {
        id, family, split: 'train', use: 'train', raw, ctx: String(r.ctx || ''), draft: hand, hand,
        plan: planId, source: 'traj:' + planId, sourceFile: path.relative(root, file),
        at: r.at || null, round: r.round ?? null, gate: r.gate ?? null,
        rawChars: r.rawChars ?? raw.length, draftChars: r.draftChars ?? hand.length,
      }
      const prev = byId.get(id)
      if (!prev) { byId.set(id, { main: item, history: [] }); continue }
      // 同 id 多版 = 改稿迭代：较新的当标签，较早的稿留作 rejected（chosen/rejected 对）
      const newer = String(item.at || '') >= String(prev.main.at || '') ? item : prev.main
      const older = newer === item ? prev.main : item
      stats.revised++
      byId.set(id, { main: newer, history: [...prev.history, older] })
    }
  }
  const samples = [...byId.values()].map((v) => v.main)
  const pairs = []
  for (const v of byId.values()) for (const h of v.history) pairs.push({ kind: 'revision', chosen: v.main.hand, rejected: h.hand, id: v.main.id, family: v.main.family, chosenAt: v.main.at, rejectedAt: h.at })
  return { samples: samples.sort((a, b) => (a.family + a.id).localeCompare(b.family + b.id)), pairs, stats, dirs: roots.map((d) => path.relative(root, d)) }
}

/** 给标尺侧的 id 全集（含 use=ruler / both —— 后者是"允许当标尺"，一旦当标尺就不能再当训练料）。 */
export function rulerIdSet(goldItems) {
  // v14.24.1：从「use 字段」升级到「尺子盖章」——被判 not-gold 的条目不再是标尺（哪怕 use 还写着 ruler）
  return new Set(goldItems.filter(goldRulerOk).map((g) => g.id))
}
