// src/universal-select.js —— 通用抽取式压缩选择器（v14.26 原型，2026-10-07）
//
// 目标：任意文本（思维链/日志/文档/代码笔记）都能压缩，不依赖任何 CFB 专用槽位规则、
//       不依赖模板字面量、不需要人工标注的 yVal 常量表。
// 原理：集合级（submodular）边际增益 —— 每加入一个单元，只按它带来的**新**信息计分：
//         gain(u) = (新锚点数 + λ·新内容词数) / 长度
//       锚点 = 数字/反引号跨度/标识符（extractAnchorsV5 + 纯数字），内容词 = 文内 IDF 加权的 token。
//       推理是贪心（O(n²) 上限，n=单元数；n≤300 时 JS 里 < 5ms），因此可同步运行、无依赖。
// 与现有路径的关系：不动 compileV5Local 默认行为；这是一个**可选选择器**，用于替换
//       selectOpsV5 的槽位硬上限路径（实测后者在任意文本上选中 0–3 个单元）。

import { extractAnchorsV5, splitDiscourseUnits } from './compile-v5-local.js'

const NUM_RE = /\d+(?:[.,]\d+)*/g
const LAT_RE = /[a-z][a-z0-9_]{2,}/g
const CJK_RUN = /[\u4e00-\u9fff]+/g

function tokensOf (text) {
  const out = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(LAT_RE)) out.push(m[0])
  for (const m of s.matchAll(CJK_RUN)) {
    const r = m[0]
    for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2))
  }
  return out
}

function anchorsOf (text) {
  const a = new Set(extractAnchorsV5(String(text || '')))
  for (const m of String(text || '').matchAll(NUM_RE)) a.add(m[0])
  return a
}

function jaccard (a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const x of a) if (b.has(x)) hit++
  return hit / (a.size + b.size - hit)
}

/**
 * @param {string[]} units 已切分的单元（或传原文 + 由调用方切分）
 * @param {{charBudget?:number, lambda?:number, redundancyPenalty?:number, maxUnits?:number}} opts
 * @returns {{indices:number[], chars:number, stats:object}}
 */
export function selectUniversalUnits (units, opts = {}) {
  const list = Array.isArray(units) ? units : splitDiscourseUnits(String(units || ''))
  const n = list.length
  if (!n) return { indices: [], chars: 0, stats: { units: 0, reason: 'empty' } }
  const charBudget = Number.isFinite(opts.charBudget)
    ? Math.max(1, Math.floor(opts.charBudget))
    : Math.max(200, Math.round(0.30 * list.join('').length))
  const lambda = Number.isFinite(opts.lambda) ? opts.lambda : 0.5
  const redundancyPenalty = Number.isFinite(opts.redundancyPenalty) ? opts.redundancyPenalty : 0.35
  const maxUnits = Number.isFinite(opts.maxUnits) ? opts.maxUnits : Infinity

  // 文内 IDF：df 文档内计数，idf = log((n+1)/(df+0.5))；不需要外部语料，任意文本可算。
  const df = new Map()
  const tokSets = list.map((t) => {
    const s = new Set(tokensOf(t))
    for (const x of s) df.set(x, (df.get(x) || 0) + 1)
    return s
  })
  const idfOf = (t) => Math.log((n + 1) / ((df.get(t) || 0) + 0.5))
  const unitInfo = list.map((t, i) => {
    const content = new Set([...tokSets[i]].filter((x) => idfOf(x) > 0))
    return { t, len: Math.max(1, t.length), anchors: anchorsOf(t), content, tk: tokSets[i] }
  })

  const selected = []
  const picked = new Set()
  const coveredAnchors = new Set()
  const coveredContent = new Set()
  let used = 0
  while (selected.length < maxUnits) {
    let best = -1
    let bestGain = 0
    for (let i = 0; i < n; i++) {
      if (picked.has(i)) continue
      const u = unitInfo[i]
      if (used + u.len > charBudget && selected.length) continue
      let newA = 0
      for (const a of u.anchors) if (!coveredAnchors.has(a)) newA++
      let newC = 0
      for (const c of u.content) if (!coveredContent.has(c)) newC++
      if (!newA && !newC) continue
      let redundancy = 0
      for (const j of selected) redundancy = Math.max(redundancy, jaccard(u.tk, unitInfo[j].tk))
      const gain = (newA + lambda * newC) * (1 - redundancyPenalty * redundancy) / u.len
      if (gain > bestGain) { bestGain = gain; best = i }
    }
    if (best < 0) break
    selected.push(best)
    picked.add(best)
    used += unitInfo[best].len
    for (const a of unitInfo[best].anchors) coveredAnchors.add(a)
    for (const c of unitInfo[best].content) coveredContent.add(c)
    if (used >= charBudget) break
  }
  const indices = [...selected].sort((a, b) => a - b) // 原序输出（可读性；抽取式不动原文）
  return {
    indices,
    chars: indices.reduce((s, i) => s + unitInfo[i].len, 0),
    stats: {
      units: n,
      selected: indices.length,
      charBudget,
      anchorsCovered: coveredAnchors.size,
      contentCovered: coveredContent.size,
    },
  }
}

/** 通用渲染：原序逐字拼接选中单元，只加最小分隔。无模板、无固定槽位、无改写。 */
export function renderUniversalUnits (units, indices, opts = {}) {
  const list = Array.isArray(units) ? units : splitDiscourseUnits(String(units || ''))
  const sep = typeof opts.sep === 'string' ? opts.sep : '\n'
  return indices.map((i) => String(list[i]).trim()).filter(Boolean).join(sep)
}

/** 一步到位：任意文本 → 压缩文本（抽取式、原序、可审计）。 */
export function compressUniversal (text, opts = {}) {
  const units = splitDiscourseUnits(String(text || ''))
  const sel = selectUniversalUnits(units, opts)
  const rendered = renderUniversalUnits(units, sel.indices, opts)
  return { text: rendered, indices: sel.indices, chars: rendered.length, stats: { ...sel.stats, sourceChars: String(text || '').length } }
}
