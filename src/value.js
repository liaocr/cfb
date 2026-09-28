// dsh-cot-form-b / value.js —— v4 编译器：观测量 → v(i;λ) → 选取 → 渲染 → 控制器（纯函数，零依赖）
//
// 理论来源：docs/theory/CFB-THEORY-COMPLETE.md 第四卷（价值与控制）、第五卷（开放问题与 v4 规格）
//   副模型只输出 ops（语义标注，无数值）；本模块用可审计的计数决定取舍、顺序与措辞。
//   ⚠ 参考实现，尚未接入 birth.js。所有系数为理论初值，见 SPEC S6。
import { estimateTokens } from './tokens.js'

export const VALUE_VERSION = 'v4-ops-0'

// ── 常量 ────────────────────────────────────────────────────────────────────
const KINDS = new Set(['FACT', 'COMPUTED', 'INCUMBENT', 'REFUTED', 'SHELVED', 'OPEN', 'PLAN'])
const EVS = new Set(['tool', 'derived', 'guess'])
// P1：agent 专用句子功能先验（Thought Anchors：计划/不确定性管理高，自检/答案复述低）
const PRIOR_D = { pivot: 1.0, plan: 1.0, hypothesize: 0.8, localize: 0.7, compute: 0.5, inspect: 0.4, verify: 0.25, answer: 0.1, restate: 0.05 }
const H_K = { INCUMBENT: 1.2, OPEN: 1.2, PLAN: 1.2, FACT: 1.0, COMPUTED: 1.2, SHELVED: 1.0, REFUTED: 0 }
// A2：可重导概率 R 的类别先验
const R_BASE = { FACT_VISIBLE: 0.85, FACT: 0.3, COMPUTED: 0.1, INCUMBENT: 0.2, OPEN: 0.5, PLAN: 0.4, SHELVED: 0.3 }

export const V4_DEFAULTS = {
  lambda0: 0.004, lambdaMin: 0.001, lambdaMax: 0.02,
  beta: 0.6, delta: 0.0005, noiseStreak: 2,
  swMax: 0.7,
  mu0: 1.0, nu: 0.5, nuNeut: 0.5, rhoRed: 0.3,
  pRetry: 0.7,
  dualEncodeFactor: 3,
  maxTailSentences: 3,
}

// ── 标识符抽取（路径 / 反引号 / 点分或下划线标识 / 错误码 / 带单位数字） ────────────
const RE_IDS = [
  /`([^`\n]{1,80})`/g,
  /(?:^|[\s(（"'])((?:\/|\.\/|~\/)[\w.\-/]+)/g,          // 路径
  /\b([A-Za-z_][\w-]*(?:[./][\w-]+)+)\b/g,               // a.b.c / a/b / file.ext
  /\b(E[A-Z]{3,}|[A-Z]{2,}_[A-Z_]+|0x[0-9a-fA-F]+)\b/g,  // EACCES / ERR_X / 0x..
  /\b([a-z]+_[a-z_0-9]+)\b/g,                            // snake_case
]
export function extractIds(text = '') {
  const out = new Set()
  for (const re of RE_IDS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) { const s = (m[1] || '').trim(); if (s.length >= 3) out.add(s) }
  }
  return out
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let n = 0; for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n)
}
const countOcc = (hay, needle, from = 0) => {
  if (!needle) return []
  const pos = []; let i = hay.indexOf(needle, from)
  while (i >= 0) { pos.push(i); i = hay.indexOf(needle, i + needle.length) }
  return pos
}

// ── 句子切分与功能线索（零依赖近似；副模型的 kind2 优先） ─────────────────────────
const RE_EXPLORE = /(也许|或许|可能是|试试|换个|要不|会不会|what if|maybe|perhaps|let me try|alternatively|或者)/i
const RE_COMPUTE = /(\d+\s*[+\-*/=×÷]\s*\d+|计算|算出|compute|calculate|=)/i
export function splitSentences(raw = '') {
  return raw.split(/(?<=[。！？!?\n]|\.\s)/).map(s => s.trim()).filter(Boolean)
}

// ── ② 校验器：硬不变量 I1–I4、I7 ─────────────────────────────────────────────
export function validateOps(ops, ctx) {
  const { raw = '', toolText = '' } = ctx
  const kept = [], dropped = []
  for (const op0 of ops || []) {
    const op = { ...op0 }
    const why = []
    if (!KINDS.has(op.k)) why.push('bad-k')
    if (!EVS.has(op.ev)) op.ev = 'guess'
    if (op.anchor && !raw.includes(op.anchor)) why.push('I1-anchor-not-verbatim')
    for (const id of extractIds(op.text)) {
      if (!raw.includes(id) && !toolText.includes(id)) { why.push('I2-id-not-grounded:' + id); break }
    }
    // I4：非工具证据的否定一律为 SHELVED
    if (op.k === 'REFUTED' && op.ev !== 'tool') op.k = 'SHELVED'
    // I3：REFUTED 必须带替代方案
    if (op.k === 'REFUTED' && !op.alt) why.push('I3-refuted-without-alt')
    ;(why.length ? dropped : kept).push(why.length ? { op, why } : op)
  }
  return { kept, dropped }
}

// ── ③ 观测量 ────────────────────────────────────────────────────────────────
export function observe(ops, ctx) {
  const { raw = '', toolText = '', contextText = '', nextToolArgs = '' } = ctx
  const rawTok = Math.max(1, estimateTokens(raw))
  const nextIds = extractIds(nextToolArgs)
  // 分支跨度：从本条 anchor 到下一条 anchor
  const anchored = ops.map(op => ({ op, at: op.anchor ? raw.indexOf(op.anchor) : -1 }))
    .filter(x => x.at >= 0).sort((a, b) => a.at - b.at)
  const spanOf = new Map()
  anchored.forEach((x, j) => spanOf.set(x.op.id, [x.at, j + 1 < anchored.length ? anchored[j + 1].at : raw.length]))
  const negs = anchored.filter(x => x.op.k === 'REFUTED' || x.op.k === 'SHELVED')
  const firstNegId = negs.length ? negs[0].op.id : null

  const obs = new Map()
  for (const op of ops) {
    const ids = extractIds([op.text, op.alt, op.anchor].filter(Boolean).join(' '))
    const [s0, s1] = spanOf.get(op.id) || [-1, -1]
    let explore = 0, compute = 0
    if (s0 >= 0) {
      for (const s of splitSentences(raw.slice(s0, s1))) {
        const t = estimateTokens(s)
        if (RE_EXPLORE.test(s)) explore += t
        else if (RE_COMPUTE.test(s)) compute += t
      }
    }
    // revisit：任一标识符在间隔 >400 字符后再次出现
    let revisit = 0
    for (const id of ids) {
      const p = countOcc(raw, id)
      for (let k = 1; k < p.length; k++) if (p[k] - p[k - 1] > 400) revisit++
    }
    // fanout：分支结束后，标识符被引用次数
    let fanout = 0
    if (s1 >= 0) for (const id of ids) fanout += countOcc(raw, id, s1).length
    const actionLink = [...ids].some(id => nextIds.has(id)) ? 1 : 0
    const textIds = extractIds(op.text)
    const visible = textIds.size > 0 && [...textIds].every(id => toolText.includes(id)) ? 1 : 0
    const staleVisible = op.supersedes && (contextText.includes(op.supersedes) || toolText.includes(op.supersedes)) ? 1 : 0
    obs.set(op.id, {
      ids, effortExplore: explore / rawTok, effortCompute: compute / rawTok,
      revisit, fanout, actionLink, visible, staleVisible,
      firstAttempt: op.id === firstNegId ? 1 : 0,
    })
  }
  return obs
}

// ── ④ 打分 v(i;λ) ──────────────────────────────────────────────────────────
const clip01 = x => Math.max(0, Math.min(1, x))
export function temptation(op, o) {           // P4：只用探索型投入
  return clip01(0.45 * Math.min(1, o.effortExplore * 4) + 0.25 * (o.revisit >= 1 ? 1 : 0)
    + 0.15 * o.firstAttempt + 0.15 * (op.ev === 'guess' ? 1 : 0))
}
export function locality(op, render) {         // A3：配对且替代先行 → 高局部性
  if (!op.alt) return 0.3
  return render?.altFirst === false ? 0.8 : 0.9
}
export function muOf(op, T, cfg) {             // P2：μ 随渲染变化
  const order = 0.45                            // 渲染器固定替代先行
  const spec = T > 0.6 && /[\s`]-|\/|\b(chmod|rm|git|npm|pip|curl|sudo)\b/.test(op.why || op.text || '') ? 1.0 : 0.6
  const evFactor = op.ev === 'tool' ? 0.7 : 1.0
  return cfg.mu0 * order * spec * evFactor
}

export function scoreOp(op, o, lambda, cfg = V4_DEFAULTS, tok = null) {
  const t = tok ?? estimateTokens(renderRow(op))
  const g = 1 - Math.exp(-o.fanout / 2)
  const D = (PRIOR_D[op.kind2] ?? 0.5) * (0.6 + 0.4 * g) * (1 + 0.5 * o.actionLink) * (H_K[op.k] ?? 1)
  const P = clip01(0.35 + 0.25 * o.actionLink + 0.2 * (['OPEN', 'PLAN', 'INCUMBENT', 'COMPUTED'].includes(op.k) ? 1 : 0) + 0.15 * Math.min(1, Math.log1p(o.fanout)))
  let R = op.k === 'FACT' ? (o.visible ? R_BASE.FACT_VISIBLE : R_BASE.FACT) : (R_BASE[op.k] ?? 0.3)
  if (op.kind2 === 'restate') R = Math.max(R, 0.95)   // 复述工具输出：原件仍在上下文
  if (op.kind2 === 'verify') R = Math.max(R, 0.9)     // 自检：随时可重做
  let info = op.k === 'REFUTED' ? 0 : D * P * (1 - R)
  if (op.k === 'SHELVED') {                           // P4：搁置的价值在于回头条件；浅尝且无触发条件的搁置不值得写
    const Ts = temptation(op, o)
    info *= (op.trigger ? 1 : 0.5) * (0.5 + Ts)
  }
  let vac = 0, prime = 0, T = 0
  if (op.k === 'REFUTED') {
    T = temptation(op, o)
    vac = T * cfg.pRetry * Math.min(1, 0.3 + o.effortExplore * 3 + o.effortCompute)
    prime = muOf(op, T, cfg) * T * (1 - locality(op))
  }
  const neut = op.supersedes && o.staleVisible ? cfg.nuNeut : 0
  const dist = op.supersedes && !o.staleVisible ? cfg.nu * 0.5 : 0   // 旧值已不可见还写它 = 重新引入干扰
  const v = info + vac + neut - dist - prime - lambda * t
  return { v, tok: t, parts: { D, P, R, info, vac, neut, dist, prime, T } }
}

// ── ⑤ 选取：惰性贪心 + 冗余递减 + 同键互斥（划分拟阵）+ 支撑闭包 ────────────────
export function selectOps(ops, obs, lambda, cfg = V4_DEFAULTS) {
  const scored = ops.map(op => ({ op, o: obs.get(op.id), ...scoreOp(op, obs.get(op.id), lambda, cfg) }))
  const chosen = [], usedKeys = new Map()
  let pool = scored.slice()
  const gain = c => c.v - chosen.reduce((s, x) => s + cfg.rhoRed * jaccard(c.o.ids, x.o.ids) * (c.op.k === x.op.k ? 1 : 0.5), 0)
  while (pool.length) {
    pool.sort((a, b) => gain(b) - gain(a))
    const best = pool.shift()
    const g = gain(best)
    if (g <= 0) break                                       // λ 是唯一停止条件
    if (best.op.key && usedKeys.has(best.op.key)) continue  // 同键只保留一个当前值（输入按时间顺序，后者应已携带 supersedes）
    chosen.push({ ...best, gain: g })
    if (best.op.key) usedKeys.set(best.op.key, best.op.id)
  }
  // 支撑闭包：COMPUTED 的依赖若未入选，至少保留 art:// 指针
  const inSet = new Set(chosen.map(c => c.op.id))
  const allIds = new Set(ops.map(o => o.id))
  for (const c of chosen) c.pointers = (c.op.deps || []).filter(d => allIds.has(d) && !inSet.has(d))
  return { chosen, rejected: scored.filter(s => !inSet.has(s.op.id)) }
}

// ── ⑥ 渲染 ─────────────────────────────────────────────────────────────────
export function styleProfile(raws = []) {          // P6：自镜像风格画像
  const txt = raws.join('\n')
  const cjk = (txt.match(/[\u4e00-\u9fff]/g) || []).length
  const lang = cjk > txt.length * 0.15 ? 'zh' : 'en'
  const backtick = (txt.match(/`/g) || []).length > 4
  const so = lang === 'zh' ? ((txt.match(/所以/g) || []).length >= (txt.match(/因此/g) || []).length ? '所以' : '因此') : 'So'
  return { lang, backtick, so }
}
const wrap = (s, st) => s // 保留原文标识符写法；backtick 偏好可在此扩展

export function renderRow(op, st = { lang: 'zh' }, pointers = [], handle = '') {
  const src = op.src && op.src.startsWith('tool:') ? `（${op.src.slice(5)}）` : ''
  const ptr = pointers.length && handle ? `  → ${handle}#${pointers.join(',')}` : ''
  switch (op.k) {
    case 'REFUTED': // P2：替代先行；X 只出现一次
      return `- ${op.alt}（已排除：${op.text}${op.why ? '——' + op.why : ''}）${ptr}`
    case 'SHELVED':
      return `- 暂不走：${op.text}${op.why ? '，因为' + op.why : ''}${op.trigger ? '；若' + op.trigger + '再回来' : ''}${ptr}`
    case 'OPEN':
      return `- 待定：${/[?？]$/.test(op.text) ? op.text : op.text + '？'}`
    case 'PLAN':
      return `- 打算：${op.text}`
    default: {
      const sup = op.supersedes ? `；取代 ${op.supersedes}` : ''
      const hedge = op.ev === 'derived' ? '目前判断：' : op.ev === 'guess' ? '（未证实）' : ''
      return `- ${hedge}${op.text}${src}${sup}${ptr}`
    }
  }
}

export function renderBirth(chosen, st, cfg = V4_DEFAULTS, handle = '', lambda = cfg.lambda0) {
  const rows = chosen.map(c => renderRow(c.op, st, c.pointers, handle))
  // 尾部散文：v 最高且递减后仍 > dualEncodeFactor·λ·tok 的 1–3 条 + OPEN 问句（证据定粘性）
  const tail = []
  // 只有 COMPUTED / INCUMBENT / 关键 FACT 可双编码；工具来源内容只写“我确认”（事实），永不写“我决定”（I5）
  const strong = chosen.filter(c => ['COMPUTED', 'INCUMBENT', 'FACT'].includes(c.op.k))
    .filter(c => c.gain > cfg.dualEncodeFactor * lambda * c.tok).slice(0, cfg.maxTailSentences - 1)
  for (const c of strong) {
    const t = c.op.ev === 'tool' ? `我确认${c.op.text}` : c.op.ev === 'derived' ? `我目前判断${c.op.text}` : null
    if (t) tail.push(t)
  }
  const open = chosen.find(c => c.op.k === 'OPEN')
  if (open) tail.push(`还没弄清的是：${open.op.text.replace(/[?？]$/, '')}？`)
  const prose = tail.length ? `\n${st.so}${tail.join('；')}。`.replace(/。？。$/, '？').replace(/？。$/, '？') : ''
  return rows.join('\n') + prose
}

// ── ⑦ 控制器：非对称 AIMD（丢失快降，噪声慢升），s_w 消歧 ─────────────────────
export function recencyCompiledShare(segments, W) {  // P3：[{tok, compiled}]，按时间顺序
  // 逐 token 指数衰减权重 w(d)=exp(−d/W) 在每段跨度上的积分：W·(e^{−d0/W} − e^{−d1/W})
  const w = Math.max(1, W)
  let num = 0, den = 0, d = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const t = Math.max(0, segments[i].tok || 0)
    const mass = w * (Math.exp(-d / w) - Math.exp(-(d + t) / w)); d += t
    den += mass; if (segments[i].compiled) num += mass
  }
  return den ? num / den : 0
}

export function updateLambda(state, sensors, cfg = V4_DEFAULTS) {
  // sensors: { readbackExcess, reprobeFact, vaccineFail, loopRising, sw, difficulty∈[0,1] }
  let { lambda = cfg.lambda0, noiseRun = 0 } = state || {}
  const lamMin = cfg.lambdaMin * (1 + 2 * (1 - (sensors.difficulty ?? 0.5)))  // 定律 3：越难下限越低
  let action = 'hold', forceRawNear = false
  if (sensors.readbackExcess || sensors.reprobeFact) {
    lambda *= cfg.beta; noiseRun = 0; action = 'decrease:loss'
  } else if (sensors.loopRising && sensors.sw >= cfg.swMax) {
    lambda *= cfg.beta; noiseRun = 0; forceRawNear = true; action = 'decrease:saturation'
  } else if (sensors.loopRising) {
    noiseRun++
    if (noiseRun >= cfg.noiseStreak) { lambda += cfg.delta; noiseRun = 0; action = 'increase:noise' }
  } else noiseRun = 0
  if (sensors.sw >= cfg.swMax) forceRawNear = true
  lambda = Math.max(Math.min(lamMin, cfg.lambdaMax), Math.min(cfg.lambdaMax, lambda))
  return { lambda, noiseRun, action, forceRawNear, promote: sensors.vaccineFail || [] }
}

// ── ⑧ 自监督标签：条目标识符在后续 K 轮复现 → needed=1（Pn 的在线训练信号） ─────
export function neededLabels(ops, laterTexts = []) {
  const later = laterTexts.join('\n')
  return ops.map(op => {
    const ids = [...extractIds(op.text)]
    return { id: op.id, k: op.k, needed: ids.length && ids.some(id => later.includes(id)) ? 1 : 0 }
  })
}

// ── 一站式 ─────────────────────────────────────────────────────────────────
export function compileBirth(ops, ctx, opts = {}) {
  const cfg = { ...V4_DEFAULTS, ...(opts.cfg || {}) }
  const lambda = opts.lambda ?? cfg.lambda0
  const { kept, dropped } = validateOps(ops, ctx)
  if (!kept.length) return { text: null, fallback: 'raw', dropped }
  const obs = observe(kept, ctx)
  const { chosen, rejected } = selectOps(kept, obs, lambda, cfg)
  const st = opts.style || styleProfile(ctx.recentRaws || [ctx.raw])
  const text = renderBirth(chosen, st, cfg, opts.handle || '', lambda)
  return { text, chosen, rejected, dropped, lambda, version: VALUE_VERSION }
}
