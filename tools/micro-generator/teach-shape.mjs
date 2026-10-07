#!/usr/bin/env node
// teach-shape.mjs —— 教师 v0.3：把「只看稿子就能判」的尺子装进目标生成器。
//
// 尺子集合（= GOLD-STANDARD 里的 draft-only 轴，E1/E2/R1/R2/M2 全部剔除）：
//   M1 压缩力度 ≤0.60 · M3 闭合判读 · M4 可执行验收（逐字命令+两分支） · M5 接地精度
//   M6 无装置话术 · M7 决策不变 G2 · M8 落点唯一
// 生成规则（全部机械、零 API、零训练）：
//   1) 从 raw 抽「信息句」：判定行｜命令｜围栏代码｜路径｜强结论句｜带在手引用的非探索句（教师 v0.2 同款，保证关键锚点覆盖 1.0）；
//   2) 过滤会顶掉形状轴的句子：旁白（Let me…）／改法词行／菜单词／装置话术／含「验收·看到」等标记词；
//   3) 组装：在手要点 + 唯一落点行 + 验收行（含逐字命令与两条互斥分支）；
//   4) 预算：总量 ≤0.60×raw（关键锚点句必留，超预算则丢弃低优先句并如实记账）；
//   5) 产出前用 scoreBirthDraft（= 生产判据的逐字副本）自检，报每轴通过率。
//
// 诚实边界：教师 = 尺子的执行器。学生学的是"尺子定义的好形状"，因此之后再用同一把尺子
// 量学生 ≈ 同源测量（能量出学没学到形状），**不构成对尺子本身的验证**；E1/E2 仍是唯一外部终验。
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasClosedRead, anchorsOf, FIX_INTENT_RE } from '../helpers/hand-draft.mjs'
import { auditMode1Gold } from '../helpers/mode1-quality.mjs'
import { scoreBirthDraft } from './forge-birth-units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argOf = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const argAll = (n) => { const o = []; process.argv.forEach((a, i) => { if (a === `--${n}`) o.push(process.argv[i + 1]) }) ; return o }

// ── 与 build-teacher-corpus.py 同一口径的句式判定 ──────────────────────────────
const VERDICT_RE = /(\d+\s+(?:passed|failed|error)|\bpassed\b|\bfailed\b|\btraceback\b|assertionerror|\bexit(?:ed)? code\s*\d|\bok\b|\bFAIL\b|\bPASS\b)/i
const CMD_RE = /(?:^|\n)\s*(?:cd\s+\S+\s*&&\s*)?(?:python3?|pytest|git|npm|npx|node|pip|make|tox|grep|sed|find|cat)\b/
const PATHY_RE = /\w+\.(?:py|js|mjs|ts|json|md|txt|cfg|toml|yaml|yml|sh|go|rs|java|rb|php|c|cpp|h)\b/
const STRONG_RE = /\b(?:the fix is|root cause|the issue is|therefore|this means|so the change|the change is|in short|to summarize|conclusion|that's why|the reason)\b/i
const EXPL_RE = /^(?:let me|now let|i'?ll\b|i will|looking at|i need to|i should|we need|let's|now i\b|first,? i|next,? i)\b/i
const NARRATION_RE = /(^|\s)(?:Let me|Let's|Hmm,|Actually,|I should|I realize|I need to)\b/
const MENU_RE = /或\s*\S{2,}(?:也|又)?可以|二选一|任选|择一|以下任一|(?:也可以|或者)/
const MARKER_WORDS_RE = /验收|读数|即收工|看到/

function splitSentences(raw) {
  const lines = String(raw || '').split('\n')
  const out = []
  let buf = []
  let fence = false
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      fence = !fence
      buf.push(line)
      if (!fence) { out.push(buf.join('\n')); buf = [] }
      continue
    }
    if (fence) { buf.push(line); continue }
    for (const part of line.split(/(?<=[.!?。！？])\s+/)) {
      const p = part.trim()
      if (!p) continue
      if (/^[-*•#>=\-\s]{0,8}$/.test(p)) continue
      out.push(p)
    }
  }
  if (buf.length) out.push(buf.join('\n'))
  return out
}

function selectBody(unit) {
  const raw = unit.raw || ''
  const sentences = splitSentences(raw)
  const total = anchorsOf(raw)
  const entries = sentences.map((s) => {
    const a = anchorsOf(s)
    const pathy = PATHY_RE.test(s) || s.includes('/')
    const verdict = VERDICT_RE.test(s)
    const cmd = CMD_RE.test(s)
    const fence = s.includes('```')
    const backtick = /`[^`\n]{2,120}`/.test(s)
    const strong = STRONG_RE.test(s)
    const expl = EXPL_RE.test(s) || /\b(?:wait|hmm|actually|perhaps|maybe i|but wait|re-read|reconsider)\b/i.test(s)
    return { s, a, pathy, verdict, cmd, fence, backtick, strong, expl }
  })
  const protectedSet = new Set()
  for (const e of entries) {
    if (e.verdict || e.cmd || e.fence || e.pathy) for (const t of e.a) protectedSet.add(t)
  }
  const keep = new Set()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.verdict || e.cmd || e.fence || e.pathy || e.strong || (!e.expl && e.backtick)) keep.add(i)
  }
  const covered = new Set()
  for (const i of keep) for (const t of entries[i].a) covered.add(t)
  for (let i = 0; i < entries.length; i++) {
    for (const t of entries[i].a) {
      if (protectedSet.has(t) && !covered.has(t)) { keep.add(i); for (const x of entries[i].a) covered.add(x) }
    }
  }
  const seen = new Set()
  const body = []
  for (const i of [...keep].sort((a, b) => a - b)) {
    const e = entries[i]
    const key = e.s.replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    body.push(e)
  }
  return { body, protectedSet, total }
}

const isUsableBody = (s) => {
  if (NARRATION_RE.test(s)) return false
  if (FIX_INTENT_RE.test(s)) return false
  if (MENU_RE.test(s)) return false
  if (MARKER_WORDS_RE.test(s)) return false
  try { if (auditMode1Gold({ draft: s }, { reviewer: 'teach-shape/1' }).status !== 'clean') return false } catch { /* lint unavailable on this string */ }
  return true
}

function pickFixSentence(body) {
  const scored = body.map((e) => {
    let score = 0
    if (e.strong) score += 3
    if (/\b(?:fix|return|change|should|must|need|revert|set|use)\b/i.test(e.s)) score += 2
    if (e.backtick) score += 2
    if (e.pathy) score += 1
    if (e.verdict) score += 1
    return { e, score }
  }).sort((a, b) => b.score - a.score)
  return scored[0]?.e ?? null
}

function pickCommand(unit) {
  const ev = `${unit.raw || ''}\n${unit.ctx || ''}`
  const evIdents = anchorsOf(ev)
  const CMD_HEAD = /(?:python3?\s+-m\s+(?:pytest|unittest|compileall|mypy|ruff|flake8|pip)|python3?\s+-c\s|pytest|npm\s+(?:test|run)|make\s+(?:all|build|test|check|lint|install|clean|dist|docs)|go\s+test|ctest|tox)[^\n]{0,70}/g
  const cands = []
  for (const m of ev.matchAll(CMD_HEAD)) {
    if (m.index > 0 && /[\w.$/-]/.test(ev[m.index - 1])) continue          // 关键字必须从词边界开始（别从 unittest 里抠出 ctest）
    let c = m[0].replace(/[\s|;,)\"'`]+$/, '')
    if (c.length > 60) {
      const cut = c.slice(0, 60)
      const sp = cut.lastIndexOf(' ')
      if (sp <= 20) continue                                              // 截到词中间就整条放弃
      c = cut.slice(0, sp)
    }
    cands.push({ c, rank: 0 })
  }
  for (const m of ev.matchAll(/`([^`\n]{3,60})`/g)) cands.push({ c: m[1], rank: /\b(?:pytest|python|npm|node|make|tox|git)\b|-m\s/.test(m[1]) ? 0 : 1 })
  for (const m of ev.matchAll(/[\w./-]+\.(?:py|js|mjs|json|toml|cfg|sh)\b/g)) { if (m[0].length <= 60) cands.push({ c: m[0], rank: 2 }) }
  // 兜底候选：证据里的子标识符（验收行至少要有一个逐字存在、可对照的读数对象）
  for (const t of evIdents) {
    if (t.length >= 4 && t.length <= 60 && /[_.]|\(\)/.test(t)) cands.push({ c: t, rank: 3 })
  }
  const CMD_WORDS = new Set(['pytest', 'python', 'python3', 'npm', 'node', 'make', 'ctest', 'tox', 'go', 'git', 'pip'])
  const seen = new Set()
  const keep = cands.filter(({ c, rank }) => {
    if (seen.has(c) || c.includes('`') || c.length < 3 || c.length > 60) return false
    if (/[:：]/.test(c)) return false
    if (/\b(?:the|this|that|it|them|to|is|are|was)\b/i.test(c)) return false
    if (FIX_INTENT_RE.test(c) || NARRATION_RE.test(c)) return false
    // 逐 token 接地：候选里每个 token 都必须真实存在于证据中（挡住 ctest.DocTestSuite(cmap 这类截断产物）
    if ([...anchorsOf(c)].some((t) => !evIdents.has(t))) return false
    if (rank === 0 && ![...anchorsOf(c)].some((t) => CMD_WORDS.has(t))) return false   // 只有命令类候选才要求命令词
    seen.add(c)
    return ev.includes(c)
  })
  keep.sort((a, b) => a.rank - b.rank || (a.rank === 0 ? b.c.length - a.c.length : a.rank === 1 ? b.c.length - a.c.length : a.c.length - b.c.length))
  return keep[0]?.c || null
}

/** 锚点窗口切片：句子里只保留关键锚点周围的逐字片段（词边界起止，仍逐字），超预算时用来瘦身。 */
function windowSlice(sentence, mustAnchors, radius) {
  const spans = []
  for (const t of mustAnchors) {
    const i = sentence.indexOf(t)
    if (i >= 0) spans.push([Math.max(0, i - radius), Math.min(sentence.length, i + t.length + radius)])
  }
  if (!spans.length) return null
  spans.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp[0] <= last[1] + 30) last[1] = Math.max(last[1], sp[1])
    else merged.push([...sp])
  }
  const atWordStart = (j) => { let k = j; while (k > 0 && !/\s/.test(sentence[k - 1]) && j - k < 30) k--; return k }
  const atWordEnd = (j) => { let k = j; while (k < sentence.length && !/\s/.test(sentence[k]) && k - j < 30) k++; return k }
  return merged.map(([a, b]) => sentence.slice(atWordStart(a), atWordEnd(b)).trim()).join(' … ')
}

const stripNarration = (t) => t.replace(/^(?:But wait,\s*|Wait,\s*|Actually,\s*|Hmm,\s*|Let me\s+|Let's\s+|I need to\s+|I should\s+|I realize\s+)/i, '')

/** 切片必须保持词完整：任一切出的 token 不在证据里 ⇒ 扩边界重试，仍不行返回 null。 */
function safeWindow(sentence, mustAnchors, radius, evIdents) {
  for (const r of [radius, radius + 20, radius + 40, radius + 80, radius + 160]) {
    const piece = windowSlice(sentence, mustAnchors, r)
    if (!piece) continue
    const bad = [...anchorsOf(piece)].filter((t) => !evIdents.has(t))
    if (!bad.length) return piece
  }
  return null
}

function compose(unit, { withShape }) {
  const raw = unit.raw || ''
  const evIdents = anchorsOf(`${raw}\n${unit.ctx || ''}`)
  const { body, protectedSet } = selectBody(unit)
  const usable = body.filter((e) => isUsableBody(e.s))
  const base = body.filter((e) => !isUsableBody(e.s))
  const fix = pickFixSentence(usable)
  const cmd = pickCommand(unit)
  const cmdLooksLikeCommand = !!cmd && /(?:pytest|python|npm|node|make|tox|git)|-m\s/.test(cmd)
  const acceptLine = cmd
    ? `验收：${cmdLooksLikeCommand ? '跑' : '核对'} \`${cmd}\` 的读数：若变绿 ⇒ 说明就是这处；若仍红 ⇒ 说明还有别处。`
    : '验收：重看上面那条命令的输出：若全绿 ⇒ 说明就是这处；若仍红 ⇒ 说明还有别处。'

  if (!withShape) {
    const budget = Math.floor(0.6 * raw.length)
    const chosen = new Set()
    let len = 0
    const crit = (e) => [...e.a].some((t) => protectedSet.has(t))
    for (const e of [...body].sort((a, b) => (Number(crit(b)) - Number(crit(a))) || (a.s.length - b.s.length))) {
      const piece = e.s.length + 1
      if (len + piece > budget && !crit(e)) continue
      chosen.add(e); len += piece
    }
    const target = body.filter((e) => chosen.has(e)).map((e) => e.s).join('\n')
    return { target, meta: { mode: 'extract', keptSentences: chosen.size } }
  }

  const fixLine = fix ? `落点（只此一处）：${fix.s}` : null
  const shapeLen = (fixLine ? fixLine.length + 1 : 0) + acceptLine.length + 1
  const budgetTotal = Math.floor(0.6 * raw.length)
  const budgetLead = Math.max(0, budgetTotal - shapeLen)

  // 关键锚点必须先有着落：找承载句（优先非旁白、短句）
  const carrierFor = (t) => {
    const carriers = body.filter((e) => e.a.has ? e.a.has(t) : [...e.a].includes(t))
    if (!carriers.length) return null
    return carriers.sort((x, y) => (Number(NARRATION_RE.test(y.s)) - Number(NARRATION_RE.test(x.s))) || (x.s.length - y.s.length))[0]
  }

  const leadEntries = []
  const seenKeys = new Set()
  const pushEntry = (e) => {
    const k = e.s.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (seenKeys.has(k)) return
    seenKeys.add(k)
    leadEntries.push(e)
  }
  for (const e of usable) {
    if ([...e.a].some((t) => protectedSet.has(t))) pushEntry(e)
  }
  for (const e of [...usable].sort((a, b) => (Number(b.strong) - Number(a.strong)) || (Number(b.backtick) - Number(a.backtick)) || (a.s.length - b.s.length))) pushEntry(e)

  const buildLeadFrom = (entries, radius) => {
    const parts = []
    const covered = new Set()
    for (const e of entries) {
      const must = [...e.a].filter((t) => protectedSet.has(t))
      // 关键锚点已被前面句子覆盖 ⇒ 这句是复述，跳过（首见保留、重复剪掉）
      if (must.length && must.every((t) => covered.has(t))) continue
      let text = e.s
      if (radius != null) {
        const cut = safeWindow(e.s, must.length ? must : [...e.a].slice(0, 2), radius, evIdents)
        text = cut || e.s
      }
      const piece = stripNarration(text)
      parts.push(piece)
      // 以「本句所有锚点」标记覆盖（未窗口化时也按句内锚点算，避免同一事实反复出现）
      for (const t of e.a) covered.add(t)
    }
    return parts
  }

  const mandatoryEntries = leadEntries.filter((e) => [...e.a].some((t) => protectedSet.has(t)))
  const optionalEntries = leadEntries.filter((e) => !mandatoryEntries.includes(e))
  let leadText = ''
  let usedEntries = []
  for (const radius of [null, 140, 90, 60, 40, 25, 15]) {
    usedEntries = [...mandatoryEntries, ...optionalEntries]
    const pieces = buildLeadFrom(usedEntries, radius)
    leadText = pieces.join('\n')
    if (leadText.length <= budgetLead) break
    // 仍超预算 ⇒ 从价值最低的可选句开始整句丢弃（必须保住关键锚点承载句）
    let opt = [...optionalEntries]
    while (opt.length && leadText.length > budgetLead) {
      opt.pop()
      usedEntries = [...mandatoryEntries, ...opt]
      leadText = buildLeadFrom(usedEntries, radius).join('\n')
    }
    if (leadText.length <= budgetLead) break
  }

  // 行级去重（同前缀）与旁白行清洗：旁白行先在句内再收窗口，仍不行就丢（回补会补关键锚点）
  const lines = leadText.split('\n').map((t) => stripNarration(t))
  const dedup = []
  const seenLine = new Set()
  for (const t of lines) {
    const key = t.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (seenLine.has(key)) continue
    if (fixLine && fixLine.slice(fixLine.indexOf('：') + 1).startsWith(t.slice(0, 40))) continue
    if (NARRATION_RE.test(t)) continue
    seenLine.add(key)
    dedup.push(t)
  }
  leadText = dedup.join('\n')
  let parts = [`在手要点：${leadText}`]
  if (fixLine) parts.push(fixLine)
  parts.push(acceptLine)
  let target = parts.join('\n')

  // 关键锚点兜底：被形状过滤的承载句（含旁白）也只保留锚点窗口
  const have = anchorsOf(target)
  const need = [...protectedSet].filter((t) => !have.has(t))
  if (need.length) {
    const groups = new Map()
    for (const t of need) {
      const c = carrierFor(t) || null
      if (!c) continue
      const key = c.s.slice(0, 80)
      if (!groups.has(key)) groups.set(key, { carrier: c, anchors: [] })
      groups.get(key).anchors.push(t)
    }
    const extra = []
    for (const { carrier, anchors } of groups.values()) {
      let piece = stripNarration(safeWindow(carrier.s, anchors, 80, evIdents) || carrier.s)
      if (NARRATION_RE.test(piece)) piece = stripNarration(safeWindow(carrier.s, anchors, 50, evIdents) || piece)
      if (NARRATION_RE.test(piece)) continue
      if (piece && !target.includes(piece)) extra.push(piece)
    }
    if (extra.length) {
      parts = [`在手要点：${extra.join('\n')}\n${leadText}`, ...(fixLine ? [fixLine] : []), acceptLine]
      target = parts.join('\n')
    }
  }
  return { target, meta: { mode: 'shape', leadSentences: leadEntries.length, cmd, fix: !!fix } }
}

function readUnits(files) {
  const units = []
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(ROOT, f)
    const text = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8')
    for (const line of text.split('\n')) if (line.trim()) units.push(JSON.parse(line))
  }
  const byId = new Map(units.map((u) => [u.unitId, u]))
  return [...byId.values()]
}

function stableRepoHash(repo) { return parseInt(crypto.createHash('sha256').update(String(repo)).digest('hex').slice(0, 8), 16) / 0xFFFFFFFF }

const SYSTEM = 'You are the CFB birth-compressor. You receive the CONTEXT visible at the moment a model produced a long reasoning block (RAW), and you output the compressed version of that block.\nRules: keep every fact-bearing sentence verbatim — identifiers, file paths, numbers, verdict lines (test results) and commands must survive unchanged. Exactly one fix point ("落点（只此一处）："); the acceptance line must carry a verbatim command and two exclusive branches. Never invent an identifier that is not in CONTEXT or RAW. Never lose a fact.'
const USER_TMPL = (u) => `【CONTEXT】\n${u.ctx}\n\n【RAW】\n${u.raw}`

function main() {
  const unitsFiles = argAll('units')
  const outDir = path.resolve(ROOT, argOf('out-dir', 'transfer/models/micro-generator-gen-v3'))
  const mode = argOf('mode', 'shape')       // shape | extract（v0.2 对照）
  const withShape = mode === 'shape'
  const devFrac = Number(argOf('dev-frac', '0.10'))
  const maxRaw = Number(argOf('max-raw-chars', '12000'))
  const units = readUnits(unitsFiles).filter((u) => (u.raw || '').length && u.raw.length <= maxRaw)

  const rows = []
  for (const u of units) {
    const { target, meta } = compose(u, { withShape })
    if (!target.trim()) continue
    const score = scoreBirthDraft(u, target, { forge: { forgeNotes: `teacher-v0.3/${mode}`, meta } })
    const covered = anchorsOf(target)
    const crit = [...score.provenance ? [] : []]
    rows.push({
      unitId: u.unitId,
      repo: (u.source || {}).repository || '?',
      license: (u.source || {}).repositoryLicense || 'unknown',
      rawChars: (u.raw || '').length,
      targetChars: target.length,
      ratio: +(target.length / Math.max(1, (u.raw || '').length)).toFixed(4),
      axes: Object.fromEntries(['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].map((id) => [id, score.axes[id].pass])),
      axesAllPass: ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].every((id) => score.axes[id].pass === true),
      failedAxes: score.failedMeasured,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER_TMPL(u) },
        { role: 'assistant', content: target },
      ],
      teacherMeta: meta,
    })
  }

  const repos = [...new Set(rows.map((r) => r.repo))]
  const devRepos = new Set(repos.filter((r) => stableRepoHash(r) < devFrac))
  if (!devRepos.size && repos.length) devRepos.add(repos[0])
  let train = rows.filter((r) => !devRepos.has(r.repo))
  let dev = rows.filter((r) => devRepos.has(r.repo))
  while (dev.length < 20 && train.length > 1) { const m = train.pop(); dev.push(m); devRepos.add(m.repo) }

  // 只把「全轴通过」的稿喂进训练；不合规的单独留档（透明、可追溯），不混入
  const trainOk = train.filter((r) => r.axesAllPass)
  const trainNo = train.filter((r) => !r.axesAllPass)
  fs.mkdirSync(outDir, { recursive: true })
  const gz = (name, subset) => fs.writeFileSync(path.join(outDir, name), zlib.gzipSync(subset.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 }))
  gz('train.jsonl.gz', trainOk)
  gz('dev.jsonl.gz', dev)
  gz('train-nonconforming.jsonl.gz', trainNo)

  const axisIds = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
  const stat = (subset) => ({
    rows: subset.length,
    repos: new Set(subset.map((r) => r.repo)).size,
    axesAllPass: subset.filter((r) => r.axesAllPass).length,
    axisPass: Object.fromEntries(axisIds.map((id) => [id, subset.filter((r) => r.axes[id] === true).length])),
    medianRatio: (() => { const a = subset.map((r) => r.ratio).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null })(),
    overBudgetRows: subset.filter((r) => r.ratio > 0.6).length,
  })
  const report = {
    schema: 'cfb.micro-generator-gen-corpus/2',
    at: new Date().toISOString(),
    teacher: `shape-teacher v0.3 (${mode}) — draft-only rulers installed: M1/M3/M4/M5/M6/M7/M8 (M2/E1/E2/R1/R2 excluded by request: they need another run)`,
    unitsIn: units.length,
    rowsWritten: rows.length,
    train: stat(trainOk),
    trainNonconforming: stat(trainNo),
    dev: stat(dev),
    devAllPass: dev.filter((r) => r.axesAllPass).length,
    boundaries: [
      'targets are machine-generated (AI single-reviewer count = 0) — NOT reviewed gold',
      'the teacher executes the same rulers it is scored with ⇒ later student numbers are same-source measurements of shape acquisition, NOT validation of the rulers',
      'E1/E2 (target-model feedback) remain 未测 — endpoint needed; no run was faked',
      'dev is repo-disjoint from train',
      'training rows are the all-pass subset; non-conforming rows are kept in train-nonconforming.jsonl.gz (info-preservation outranks the 0.60 ratio cap, so a few rows exceed it on purpose)',
    ],
  }
  fs.writeFileSync(path.join(outDir, 'corpus-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ mode, rows: rows.length, train: report.train, dev: report.dev }, null, 1))
  console.log('wrote', path.relative(ROOT, outDir))
}

main()
