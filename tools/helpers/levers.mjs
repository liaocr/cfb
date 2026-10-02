// tools/helpers/levers.mjs —— 生成层：候选来自「理论按效应量排出的四个杠杆」，不是旋钮。
//
// 上一轮我把候选空间做成 7 个旋钮（版面/人称/长度/记号），那是错的：
// 理论给出的效应量顺序是 K 项（红题 4.9→8.0）>> 取舍规则 > 死路处置 > 宿主接口 > 版面旋钮。
// 本文件把前三个杠杆做成**可选臂**，旋钮降级为最低优先级的混杂因子。
//
// 每个杠杆的取值都必须能 back 到理论的一条明确主张，否则不进来。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ── 杠杆 1（最高优先级）：可推导的预见 K1–K6 ─────────────────────────────────
// 理论 S10.14 / S10.18：这是仓库历史上最大的效应量（红题均值 4.9 → 8.0）。
// 三个臂：off（完全不写）/ core（只写最关键的 K1 K4 K5）/ all（六条齐全）
export const K_ARM = Object.freeze({ off: [], core: ['K1', 'K4', 'K5'], all: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] })

// ── 杠杆 2：逐条信息取舍 v(i) = D · Pn · (1 − R)（卷四 A2）─────────────────────
// 取值 = 取舍规则的严格度。strict：只留高 D×Pn 的条目；loose：只要能重导就留。
export const SELECT_ARM = Object.freeze({ keepAll: { minV: -1, rFloor: 1 }, balanced: { minV: 0, rFloor: 0.85 }, strict: { minV: 0.2, rFloor: 0.6 } })

// ── 杠杆 3：死路处置（卷五 P4：REFUTED 要工具证据，SHELVED 只需触发条件）─────
export const DEADEND_ARM = Object.freeze({ drop: 'none', shelveOnly: 'shelved', paired: 'paired' })

export const LEVERS = Object.freeze([
  { id: 'kItems', priority: 1, values: Object.keys(K_ARM), theory: 'S10.14 可推导的预见（效应量最大：4.9→8.0）' },
  { id: 'selection', priority: 2, values: Object.keys(SELECT_ARM), theory: '卷四 A2 v(i)=D·Pn·(1−R)' },
  { id: 'deadEnd', priority: 3, values: Object.keys(DEADEND_ARM), theory: '卷五 P4 REFUTED/SHELVED 拆分' },
  { id: 'layout', priority: 5, values: ['state-first', 'conclusion-first'], theory: '卷三原则7 价值靠尾（低优先）' },
  { id: 'length', priority: 5, values: ['tight', 'normal', 'roomy'], theory: '卷一 T2 长度是输出（低优先）' },
])

export const priorityOrder = () => [...LEVERS].sort((a, b) => a.priority - b.priority)

/** 生成一组的候选配置：默认只动 priority=1 的杠杆，其余固定为基线（消融，不是乱扫）。 */
export function ablationSet({ lever = 'kItems', baseline = null, includeBaseline = true } = {}) {
  const base = baseline || Object.fromEntries(LEVERS.map((l) => [l.id, l.values[0]]))
  const l = LEVERS.find((x) => x.id === lever)
  if (!l) throw new Error('unknown-lever:' + lever)
  const out = includeBaseline ? [{ id: 'baseline', lever, value: base[lever], knobs: { ...base }, isBaseline: true }] : []
  for (const v of l.values) if (v !== base[lever]) out.push({ id: lever + '=' + v, lever, value: v, knobs: { ...base, [lever]: v }, isBaseline: false })
  return out
}

/** 三个杠杆同时给基线/变体，用于「显著性优先」的一轮：只跑最有希望的那一个变体。 */
export function layeredSet({ baseline = null } = {}) {
  const base = baseline || Object.fromEntries(LEVERS.map((l) => [l.id, l.values[0]]))
  const out = [{ id: 'baseline', knobs: { ...base }, isBaseline: true }]
  // 每个杠杆各取"区别于基线"的**第一个**值（保守：一轮只推进一格，便于归因）
  for (const l of priorityOrder()) {
    const v = l.values.find((x) => x !== base[l.id])
    if (v) out.push({ id: l.id + '=' + v, lever: l.id, value: v, knobs: { ...base, [l.id]: v }, isBaseline: false })
  }
  return out
}

/** 把 knob 配置翻成「副模型要遵守的约束 + 程序要判的规则」。不产生文本。 */
export function renderSpec(knobs) {
  const kItems = K_ARM[knobs.kItems] || []
  const sel = SELECT_ARM[knobs.selection] || SELECT_ARM.balanced
  return {
    knobs, kItems,
    deadEnd: DEADEND_ARM[knobs.deadEnd] || 'paired',
    minV: sel.minV, rFloor: sel.rFloor,
    maxChars: { tight: 1200, normal: 2000, roomy: 2600 }[knobs.length] || 2000,
    targetChars: { tight: 900, normal: 1500, roomy: 2300 }[knobs.length] || 1500,
    sections: knobs.layout === 'conclusion-first' ? ['结论', '依据', '已排除', '下一步'] : ['延续', '增量', '验收', '状态'],
  }
}

// ── 变体文本生成：由「改写已有稿」实现，零 API（这使消融可以完全离线做）──────
// 依据：K 项与死路处置都是**结构性**的 —— 关掉一段、加一段，不需要重新调用模型。
const K_TEXT = Object.freeze({
  K1: '验收观察的新鲜度：从日志尾部 tail 取的行不算新鲜，先清空（: > 日志）或在命令里带时间戳再跑。',
  K2: '验收若没有复现失败条件（taskset / 限核 / 负载不同），通过了也没有信息量。',
  K3: '若仍失败且新数字随参数移动（≈ 新值 + 偏移），说明参数不是原因、只是触发点：不要再调数字、不要改等待逻辑。',
  K4: '若输出里出现了上一轮没有的事件名 / 键 / 文件，那就是下一条取证的对象；只有输出里没有新东西，才走预写的分支。',
  K5: '能说"修好"要三样同时在手：改动落地的证据、症状级验收（单元测试不算）、观察新鲜。缺任一项只能说"已改未验证"。',
  K6: '若验收是改后新产生的、数字却与上一轮一样、症状原样 ⇒ 改动落地但零效应：先 grep 确认键落在文件里，再找真实消费点，不试第二候选。',
})
// ⚠ v14.2（2026-10-02，用户核实的缺陷）：此前 DEADEND_TEXT 写死了 eacces 的 chown / 锁文件两条死路，贴到任何题上都是注入错误；
//   且先贴 K 段再按 maxChars 硬截断 ⇒ 真实 5–10k 字稿配 tight 时 K 段整段被截掉，9 个候选 7 个退化为同一份原稿前缀。
//   现在：死路条目只来自调用方显式传入的 deadEnds（取自 ctx 台账 / 稿自己的已排除段），没有就只做剥离 / 改标签；
//   长度先裁正文、后保附录（K 段与死路段永远在最后、永远保留），稿与 K 段都放不下时才裁 K 段本身。
//   生产等价的候选生成已迁到 tools/helpers/candidates.mjs（真实生产重编译 + 生产闸门）；本函数保留给离线消融自测。
const DEADEND_LABEL = Object.freeze({ none: null, shelved: '已搁置（未取证，不作为结论）：', paired: '已排除（工具证伪的才是这条）：' })
function deadEndBlock(mode, deadEnds) {
  const items = (deadEnds || []).filter((d) => d && typeof d.claim === 'string' && d.claim.trim())
  if (!DEADEND_LABEL[mode] || !items.length) return ''
  if (mode === 'shelved') return '\n' + DEADEND_LABEL.shelved + items.map((d) => d.claim.trim()).join('；') + '。'
  const paired = items.filter((d) => typeof d.evidence === 'string' && d.evidence.trim())   // paired 只收有工具证据的条目（卷五 P4）
  if (!paired.length) return ''
  return '\n' + DEADEND_LABEL.paired + paired.map((d) => '✗ ' + d.claim.trim() + ' —— ' + d.evidence.trim()).join('；') + '。这些不要再试。'
}
/** 按句裁到 limit 以内（句号 / 换行边界），不足一句时硬切。 */
function trimSentences(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'))
  return i > limit * 0.5 ? cut.slice(0, i + 1) : cut
}

/**
 * 对一份已有稿施加 knob 变换，得到变体文本（确定性、零 API、幂等）。
 * opts.deadEnds: [{ claim, evidence? }] —— 调用方从 ctx 台账 / 稿的已排除段抽出来的条目；不传则不写任何死路文本。
 */
export function applyKnobs(draft, knobs, { baseDraft = null, deadEnds = null } = {}) {
  let t = String(draft || '').trim()
  const spec = renderSpec(knobs)
  // 1. 剥掉已有的死路段与 K 段（幂等的前提）
  t = t.replace(/\n?已排除[（(][^\n]*\n?/g, '\n').replace(/\n?已搁置[（(][^\n]*\n?/g, '\n')
  t = t.replace(/\n?✗[^\n]*/g, '')
  t = t.replace(/\n*【验收与推翻路】\n?/g, '\n')
  for (const v of Object.values(K_TEXT)) t = t.split(v).join('')
  t = t.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  // 2. 附录按目标形态生成（不写死任何题的事实）
  const dead = deadEndBlock(spec.deadEnd, deadEnds)
  const kBlock = spec.kItems.length ? '\n\n【验收与推翻路】\n' + spec.kItems.map((k) => K_TEXT[k]).join('\n') : ''
  // 3. 长度：先裁正文、后保附录；附录本身都放不下时才裁附录
  const budgetBody = spec.maxChars - dead.length - kBlock.length
  if (budgetBody >= Math.min(200, t.length)) t = trimSentences(t, budgetBody)
  else t = trimSentences(t, Math.max(0, Math.floor(spec.maxChars * 0.3)))
  let out = t.replace(/\s+$/, '') + dead + kBlock
  if (out.length > spec.maxChars) out = trimSentences(out, spec.maxChars)
  return out
}

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
export function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }
