// tools/helpers/offline-core.mjs —— cfb 离线层内核：把「生产 trace + 历史实跑记录」变成可训练、可搜索、
// 可判分的样本，全过程零 API。
//
// 目的（用户 2026-10-02 指令）：离线层要成为一台「接上 API 就能高速开练」的机器。
// 三个必须离线完成的问题：
//   Q1 判据对不对？   → 逐条标注 + 一致性回归（labelOf / labelBatch）
//   Q2 候选好不好？   → 静态打分（scoreDraft：闸门 / 不变量 / K 项 / 七个理论指标）
//   Q3 哪个候选最好？ → 在历史实跑行上排序，与真实结果对齐（rankCandidates / rankAgreement）
// 全部确定性、无网络、无随机（除显式 seed 的 PRNG）。
import fs from 'node:fs'
import path from 'node:path'

// ── 1. trace 解析（零依赖、流式安全：逐行正则，绝不在 JSON 文本里切分） ──────────────
// 两段式：先认「锚定前缀」，再单独解析 JSON 体。
// 若把 JSON 体写进同一条正则（\{.*\}$），格式正确的锚定行但坏掉的 JSON 体会**匹配失败**，
// 从而被误记为 ignored 而不是 malformed —— 那会把生产 trace 里的真实损坏静默吞掉。
const ANCHOR_RE = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] \[([A-Za-z0-9_-]+)\] (.*)$/

/**
 * 逐行解析 trace 文本。malformed 计入统计但不抛。
 * 返回值既可迭代（for..of，得到事件）也可 .stats() 取统计——生成器「边产出边计数」，
 * 用 for..of 完整消费后统计是准的。
 */
export function parseTrace(text) {
  const stats = { lines: 0, ignored: 0, malformed: 0 }
  const events = []
  for (const line of String(text || '').split('\n')) {
    stats.lines++
    if (!line) continue
    const m = ANCHOR_RE.exec(line)
    if (!m) { stats.ignored++; continue }
    let obj
    try { obj = JSON.parse(m[3]) } catch { stats.malformed++; continue }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { stats.malformed++; continue }
    events.push({ at: m[1], tag: m[2], obj })
  }
  const arr = events.slice()
  arr.stats = () => ({ ...stats })
  arr[Symbol.iterator] = events[Symbol.iterator].bind(events)
  return arr
}

/** 从磁盘读 trace。 */
export function readTraceEvents(file) {
  const text = fs.readFileSync(file, 'utf8')
  const it = parseTrace(text)
  const out = [...it]
  return { events: out, stats: it.stats(), bytes: text.length }
}

// ── 2. 轨迹重建：把事件流折叠成「按 taskId 的块生命周期」 ─────────────────────────
// 一个块的生命周期：birth-fired → (distill-settled | distill-failed | passthrough | below-floor)
//                    → birth-finish-enter → birth-condensed
export const BLOCK_STAGES = Object.freeze(['fired', 'distilled', 'entered', 'condensed', 'failed', 'passthrough', 'belowFloor'])

export function rebuildTrajectories(events) {
  const byTask = new Map()
  const ensure = (taskId) => {
    if (!byTask.has(taskId)) byTask.set(taskId, { taskId, blocks: [], events: [], lastFiredAt: null })
    return byTask.get(taskId)
  }
  let boot = null, sessionEvents = 0
  for (const e of events) {
    const o = e.obj || {}
    if (e.tag === 'BOOT') { boot = { selfId: o.selfId ?? null, mode: o.mode ?? null, dryRun: o.dryRun ?? null, at: e.at }; continue }
    const taskId = o.taskId ?? o.task ?? null
    sessionEvents++
    if (taskId == null) continue
    const t = ensure(String(taskId))
    t.events.push({ at: e.at, tag: e.tag, obj: o })
    if (e.tag === 'birth-fired') {
      t.blocks.push({ firedAt: e.at, rawChars: num(o.rawChars ?? o.chars ?? o.reasoningChars), ctxChars: num(o.ctxChars), stages: { fired: true } })
      t.lastFiredAt = e.at
    }
    const b = t.blocks[t.blocks.length - 1]
    if (!b) continue
    if (e.tag === 'birth-distill-settled') { b.stages.distilled = o.ok === true; b.stages.failed = o.ok === false; b.distillMs = num(o.ms ?? o.settledMs); b.draftChars = num(o.outputChars ?? o.draftChars ?? o.chars) }
    else if (e.tag === 'birth-distill-failed') { b.stages.failed = true; b.failReason = o.reason ?? o.code ?? null }
    else if (e.tag === 'birth-finish-enter') { b.stages.entered = true; b.waitedMs = num(o.waitedMs ?? o.waitMs) }
    else if (e.tag === 'birth-condensed') { b.stages.condensed = true; b.outChars = num(o.outChars ?? o.chars ?? o.condensedChars); b.savedChars = num(o.savedChars ?? o.netSavedChars) }
    else if (e.tag === 'birth-passthrough') { b.stages.passthrough = true }
    else if (e.tag === 'birth-below-floor') { b.stages.belowFloor = true }
  }
  return { boot, sessionEvents, tasks: [...byTask.values()] }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/** 把轨迹折算成压缩器的漏斗统计（纯计数，无模型）。 */
export function funnelOf(trajs) {
  const f = { blocks: 0, fired: 0, distilled: 0, distillFailed: 0, entered: 0, condensed: 0, passthrough: 0, belowFloor: 0,
    rawChars: 0, draftChars: 0, outChars: 0, savedChars: 0, ratioSum: 0, ratioN: 0 }
  for (const t of trajs.tasks) for (const b of t.blocks) {
    f.blocks++
    for (const k of ['fired', 'distilled', 'entered', 'condensed', 'passthrough', 'belowFloor']) if (b.stages[k]) f[k]++
    if (b.stages.failed) f.distillFailed++
    if (b.rawChars) f.rawChars += b.rawChars
    if (b.draftChars) f.draftChars += b.draftChars
    if (b.outChars) f.outChars += b.outChars
    if (b.savedChars) f.savedChars += b.savedChars
    if (b.rawChars && b.outChars) { f.ratioSum += b.outChars / b.rawChars; f.ratioN++ }
  }
  f.condenseRate = f.blocks ? f.condensed / f.blocks : null
  f.meanRatio = f.ratioN ? f.ratioSum / f.ratioN : null
  return f
}

// ── 3. 判据内核：确定性规则标签（claimOf 系列 + K 项 + 七个理论指标） ─────────────
// 理论 S10.5 要求七个指标；这里实现其中**规则可判**的部分，评委项显式标注为 null 而不是猜。
export const METRIC_NAMES = Object.freeze(['falseDone', 'greenAsProof', 'repeat', 'oscillation', 'contradiction', 'wrongEdit', 'roundsToFix'])

const CLAIM_RE = /(已|已经|彻底|成功)?(修复|解决|搞定|修好|完成)|问题(已|就)?(不复存在|消失)|可以收工|fixed|resolved/g
const NEG_RE = /(不能|尚未|还不|还没|未|不算|无法|没有|不足以|不等于|谈不上|不是|并非|无法确认|不代表)\s*$/
const HEDGE_RE = /不能(证明|说明|确认)|不足以|没有信息量|不算(证据|验证|验收)|尚未验证|未验证|待 ?CI|CI 上(跑|验证|确认)|以 CI 为准|大概率|很可能|还需要|仍需|需要(进一步|再)验证/
const EVENT_NOUN_RE = /(请求|加载|构建|编译|传输|握手|连接|渲染|初始化|启动|写入|读取|下载|上传|安装|部署|迁移|扫描|采样|轮询|重试|超时|动画|队列)\s*$/
const CONCESSIVE_RE = /(?:即使|即便|哪怕|就算|纵然|尽管|虽然)[^。；\n]{0,40}?(?:修复|解决|搞定|修好|完成)[^。；\n]{0,40}?(?:仍|仍然|还|还是|依旧|依然|也)/
const INTENT_RE = /(?:以|先|再|然后|去|来|准备|打算|计划|设计|想要|需要|应该)[^。；\n]{0,6}?(?:修复|解决|搞定|修好)/
const LATIN_DONE_RE = /[A-Za-z_][\w.$\[\]]*\s*(?:完成|完成回调|回调时刻)/
const DISCLAIM_RE = /(?:但|不过|只是|然而|却)[^。；\n]{0,20}?(?:不是|并非|不等于|谈不上|次要|无关|不是主因)/
// v13.8 新增（由黄金集 bd3/bd5 暴露）：claimOfV3 之前只看「修复词附近有没有否定」，漏掉两类真伪阳性——
//   ① 修复词**本身**被否定（「修复没有落地」）——NEG_RE 只往前看 10 字且要求否定词收尾，够不到；
//   ② 修复词当**定语**（「已修复的路径」）——它描述的是名词，不是对本次问题的宣称。
const POST_NEG_RE = /^(?:没有|没|未|尚未|不|无法|不能|并未|从未)/
const ATTR_RE = /(?:修复|解决|搞定|修好|完成)(?:的|之)(?:路|路径|分支|方案|方法|方式|代码|逻辑|部分|地方)/

function claimHitFixed(t) {
  let fixed = false
  for (const m of t.matchAll(CLAIM_RE)) {
    const before = t.slice(Math.max(0, m.index - 10), m.index)
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12)
    if (NEG_RE.test(before) || /^(?:吗|？|\?|了吗|与否|的前提|之前|以前|才|→|⇒|=>)/.test(after)) continue
    if (POST_NEG_RE.test(after)) continue
    if (ATTR_RE.test(m[0] + after.split(/[，。；\n]/)[0].slice(0, 4))) continue
    if (/完成$/.test(m[0]) && EVENT_NOUN_RE.test(before)) continue
    fixed = true
  }
  return fixed
}

export function claimOfV3Core(text) {
  const t = String(text || '')
  const fixed = claimHitFixed(t)
  if (!fixed) return HEDGE_RE.test(t) ? 'hedged' : 'none'
  if (CONCESSIVE_RE.test(t) || INTENT_RE.test(t) || LATIN_DONE_RE.test(t) || DISCLAIM_RE.test(t)) return HEDGE_RE.test(t) || /仍|但|只是|并非/.test(t) ? 'hedged' : 'none'
  return HEDGE_RE.test(t) ? 'hedged' : 'fixed'
}

// 「绿灯当证据」的规则代理：宣布收工/修复，但引用的是不具信息量的通过（单元测试绿、CI 绿）
const GREEN_RE = /(?:单元测试|单测|测试|CI|build|lint)\s*(?:全?部?)?(?:通过|绿|绿的|过了)|(?:npm test|jest|vitest|pytest)[^\n]{0,40}(?:通过|pass)|\bPASS\b/
const SYMPTOM_RE = /(?:原症状|同样的症状|原(?:来的)?(?:报错|错误|失败)|trace|日志|复现|重现|截图|实际运行|真机)/
const FRESH_RE = /(?:清空|: >|truncate|带时间戳|时间戳|本次运行|新起|重启|重新跑|删掉.*(?:日志|trace))/

/** 一条回答的确定性标注：claim/hedge + 多个规则派生量。 */
export function annotate(text, { expectClaim = null } = {}) {
  const t = String(text || '')
  const claim = claimOfV3Core(t)
  const a = {
    text, claim,
    lenChars: t.length,
    saysGreen: GREEN_RE.test(t),
    citesSymptom: SYMPTOM_RE.test(t),
    citesFreshness: FRESH_RE.test(t),
    cedesControl: /不能(?:说|称)|还不能|仍不能|无法确认|不敢|需要(?:再|进一步)/.test(t),
  }
  a.greenAsProof = a.saysGreen && !a.citesSymptom ? 1 : 0
  a.falseDone = expectClaim && claim === 'fixed' && expectClaim !== 'fixed' ? 1 : 0
  a.overHedge = expectClaim === 'fixed' && claim === 'none' ? 1 : 0
  // K5 收工三问：落地证据 / 症状级验收 / 观察新鲜
  a.k5 = { landed: /edit|回执|已改|落地|写入|替换/.test(t), symptom: a.citesSymptom, fresh: a.citesFreshness }
  a.k5Complete = a.k5.landed && a.k5.symptom && a.k5.fresh
  return a
}

// ── 4. 静态打分：候选稿的「不劣性」由代码判定，不需要模型 ────────────────────────
const IDENT_RE = /[\u4e00-\u9fa5A-Za-z_$][\w.$\-]{2,}/g

/** 从 ctx（本轮可见材料）抽出可核真集合；副模型不得发明集合外的标识符（卷五 I2）。 */
export function truthSet(ctxText) {
  const s = new Set()
  for (const m of String(ctxText || '').matchAll(IDENT_RE)) s.add(m[0])
  return s
}

/** 稿的硬闸门：与 compileV4Direct 同口径的纯离线版（标识符出处 / 长度 / 结构）。 */
export function gateDraft(draft, ctxText, { maxChars = 2600, minChars = 0 } = {}) {
  const text = String(draft || '').trim()
  const truth = truthSet(ctxText)
  const invented = []
  for (const m of text.matchAll(IDENT_RE)) {
    const id = m[0]
    if (/^\d+$/.test(id)) continue
    if (!truth.has(id) && id.length >= 3) invented.push(id)
  }
  const uniq = [...new Set(invented)]
  return { ok: text.length > 0 && text.length >= minChars && text.length <= maxChars && uniq.length === 0,
    chars: text.length, invented: uniq, overLength: text.length > maxChars, underLength: text.length < minChars }
}

/** 理论 S10.14 的 K 项在稿里的到位情况（离线可判，逐条）。 */
export const K_ITEMS = Object.freeze({
  K1: { name: '验收自证新鲜', re: /(?:tail|grep)[^\n]{0,40}(?:\.log|日志)|日志尾部/, needFresh: FRESH_RE },
  K2: { name: '条件等价', re: /(?:taskset|--cpus|stress|nice|并行|核数|条件(?:变了|不同))/ },
  K3: { name: '参数跟随检验', re: /(?:跟着参数|参数(?:不是|跟随)|新数字.{0,10}≈|证伪)/ },
  K4: { name: '新出现者优先', re: /(?:新出现|比差|差异|没有新东西)/ },
  K5: { name: '收工三问', re: /(?:落地证据|原症状|观察新鲜|已改未验证)/ },
  K6: { name: '零效应⇒消费点', re: /(?:零效应|消费点|纹丝不动|没读到新值)/ },
})

export function kItemsOf(text) {
  const t = String(text || '')
  const out = {}
  for (const [k, v] of Object.entries(K_ITEMS)) {
    const present = v.re.test(t)
    out[k] = k === 'K1' ? (present && v.needFresh.test(t) ? 2 : present ? 1 : 0) : present ? 1 : 0
  }
  out.total = Object.values(out).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0)
  out.count = Object.entries(out).filter(([k, v]) => k !== 'total' && v).length
  return out
}

// ── 5. 候选排序：在历史实跑行上对齐真实结果 ────────────────────────────────────
/** Spearman 秩相关（无并列修正的 tie 平均秩）。 */
export function spearman(xs, ys) {
  const n = xs.length
  if (n < 3 || ys.length !== n) return null
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let i = 0
    while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1 } return r }
  const rx = rank(xs), ry = rank(ys)
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let num2 = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num2 += a * b; dx += a * a; dy += b * b }
  return dx && dy ? num2 / Math.sqrt(dx * dy) : null
}

/** 给候选打分并按分数排序；返回 { ranked, agreement }。agreement = 静态分与真实分的秩相关。 */
export function rankCandidates(candidates, { truthKey = 'truth', scoreKey = 'score' } = {}) {
  const usable = candidates.filter((c) => Number.isFinite(c[scoreKey]) && Number.isFinite(c[truthKey]))
  const ranked = [...candidates].sort((a, b) => (b[scoreKey] ?? -Infinity) - (a[scoreKey] ?? -Infinity))
  return { ranked, agreement: spearman(usable.map((c) => c[scoreKey]), usable.map((c) => c[truthKey])), n: usable.length }
}

// ── 6. 最小编辑距离（候选稿之间的多样性 / 变异幅度，用于新颖性控制） ─────────────
export function editDistance(a, b) {
  a = String(a || ''); b = String(b || '')
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i), cur = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    const t = prev; prev = cur; cur = t
  }
  return prev[b.length]
}
export const similarity = (a, b) => { const m = Math.max(String(a || '').length, String(b || '').length); return m ? 1 - editDistance(a, b) / m : 1 }

// ── 7. 确定性 PRNG（可复现的候选采样；绝不用于判分） ────────────────────────────
export function prng(seed) { let s = (Number(seed) >>> 0) || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }

export function ensureDir(p) { fs.mkdirSync(path.resolve(p), { recursive: true }); return path.resolve(p) }
export function writeJson(p, obj) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); return p }
export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
