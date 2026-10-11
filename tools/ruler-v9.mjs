// tools/ruler-v9.mjs —— PREREG-v9 尺子（冻结规范的唯一实现入口）。
//
// 设计原则（来自 §10.x 与 gen-ruler 的历史修订，见 transfer/route-2026-10-11/PREREG-v9.md）：
//   1. 硬门只装布尔不变量：G0 受力点、G1 引号接地、G2 落点接地（稿子声明落点时）、
//      G3 承重锚点保留、G4 可动手、G5 不反因果、G6 不照抄。全部是确定性规则，不调用 LLM，
//      因此同一输入永远得到同一判定（可重复性由 validate 验证）。
//   2. G7（压缩比）**不在硬门**：它在 gen-ruler/4 已下架，只作为软分的一部分（S4）计分。
//   3. 软分 = gen-ruler/5 的 score（0..1，权重固定，见 gen-ruler.mjs 的 W）。
//   4. 「好稿」= 硬门全过 且 软分 >= SOFT_FLOOR。SOFT_FLOOR 由 hand 标准集的校准决定（见 v9-pipeline calibrate），写入 data-v9/thresholds.json，
//      不是手填常数。
//
// 本模块只读、无副作用。它依赖的 gen-ruler.mjs 的哈希被记录在 PREREG-v9.md；哈希不匹配即拒绝运行。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { judge, RULER_VERSION } from './gen-ruler-v9.mjs'

export const RULER_V9 = 'ruler-v9/1'
export const HARD_GATES = Object.freeze([
  'G0 no-leverage', 'G1 quote-grounded', 'G2 locus-grounded', 'G3 anchors-kept',
  'G4 actionable', 'G5 no-cause-inversion', 'G6 not-copy',
])
export const RULER_BASE_VERSION = 'gen-ruler-v9/1'
export const NEGATIVES_FILE = 'gen-negatives-v9.mjs'
const HERE = path.dirname(fileURLToPath(import.meta.url))

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

// 冻结检查：依赖文件的哈希必须与 PREREG-v9 记录一致。
export function assertFrozen(frozen) {
  if (RULER_VERSION !== RULER_BASE_VERSION) throw new Error(`ruler base version drift: ${RULER_VERSION}`)
  const cur = sha256File(path.join(HERE, 'gen-ruler-v9.mjs'))
  const curNeg = sha256File(path.join(HERE, NEGATIVES_FILE))
  if (frozen && frozen.genRulerSha256 && frozen.genRulerSha256 !== cur) {
    throw new Error(`gen-ruler-v9.mjs 哈希与冻结记录不符：冻结=${frozen.genRulerSha256} 当前=${cur}`)
  }
  if (frozen && frozen.negativesSha256 && frozen.negativesSha256 !== curNeg) {
    throw new Error(`${NEGATIVES_FILE} 哈希与冻结记录不符：冻结=${frozen.negativesSha256} 当前=${curNeg}`)
  }
  return cur
}

// 单条判定。输入 {raw, ctx, draft}，返回 {pass, hardFailed, softScore, sub, gaugeable, detail}。
// v9 修订（G0）：gaugeable=false 的单元（raw 没有路径、没有承重锚点）对任何草稿都无定义，
// 它是单元属性而不是草稿属性。旧版把它当成「草稿失败」计分，等于把草稿质量与单元可测性混在一起。
// 现在：不可测单元 pass=null（不计分、不入分母、不进训练集），数量单独报告。
// 空稿在不可测单元上的「白拿分」问题由此消失：这些单元根本不计分。
export function grade({ raw, ctx, draft }) {
  const r = judge({ raw, ctx, draft })
  const hardFailed = r.failed.filter((f) => HARD_GATES.some((g) => f === g))
  if (r.gaugeable !== true) {
    return { pass: null, unscorable: true, hardFailed, softScore: null, sub: r.sub, gaugeable: false, advisory: r.advisory, detail: r.detail }
  }
  return {
    pass: hardFailed.length === 0,
    unscorable: false,
    hardFailed,
    softScore: r.score == null ? null : Number(r.score),
    sub: r.sub,
    gaugeable: r.gaugeable,
    advisory: r.advisory,
    detail: r.detail,
  }
}

// 「好稿」判定：硬门 + 软分下限。floor 为 null 时只返回硬门结果。
export function isGoodDraft(sample, floor) {
  const g = grade(sample)
  const good = g.pass && (floor == null || (g.softScore != null && g.softScore >= floor))
  return { ...g, good }
}
