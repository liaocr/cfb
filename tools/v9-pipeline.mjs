// tools/v9-pipeline.mjs —— PREREG-v9 流水线：hand → calibrate → validate → build
//   node tools/v9-pipeline.mjs hand       收集 hand 标准集（t133–t135 的 pending 原文 + 手写稿）
//   node tools/v9-pipeline.mjs calibrate  用 hand 定软分下限、检查尺子有效性 → data-v9/thresholds.json
//   node tools/v9-pipeline.mjs validate   确定性、负对照、空稿/照抄对照、教师通过率 → data-v9/validation.json
//   node tools/v9-pipeline.mjs build      切分、过滤、写数据集 + 清单 → data-v9/
// 所有步骤只读源数据；产物写到 data-v9/。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { grade, isGoodDraft, RULER_V9, HARD_GATES, assertFrozen, sha256File, NEGATIVES_FILE } from './ruler-v9.mjs'
import { auditRuler } from './gen-negatives-v9.mjs'
import { readLines, parseSample } from './v9-inventory.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'data-v9')
const HAND_ROUNDS = ['t133', 't134', 't135']
const MIN_HAND_PASS = 0.80       // 预注册：hand 标准集的硬门通过率下限
const MIN_TEACHER_TEST_PASS = 0.20 // 预注册：尺子对教师稿必须不是「一个都不过」
const SOFT_PCTL = 0.10           // 预注册：软分下限 = hand 通过稿软分的第 10 百分位
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const jdump = (o) => JSON.stringify(o, null, 2)
fs.mkdirSync(OUT, { recursive: true })

function wilson(k, n, z = 1.96) {
  if (!n) return [null, null]
  const p = k / n, d = 1 + z * z / n
  const c = (p + z * z / (2 * n)) / d
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
  return [+(c - h).toFixed(4), +(c + h).toFixed(4)]
}
function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
const splitOf = (repo) => { const m = fnv1a(String(repo)) % 10; return m <= 1 ? 'test' : m === 2 ? 'dev' : 'train' }

// ---------- hand ----------
function loadHand() {
  const rows = []
  for (const r of HAND_ROUNDS) {
    const base = path.join(ROOT, '.cfb-runtime', 'traj', r)
    const pend = []
    for (const d of ['pending', path.join('pending', 'done')]) {
      const dir = path.join(base, d)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) pend.push(path.join(dir, f))
    }
    for (const p of pend.sort()) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      const name = path.basename(p, '.json')
      const dp = path.join(base, 'drafts', name + '.md')
      if (!fs.existsSync(dp)) continue
      rows.push({ id: `${r}/${name}`, round: r, raw: String(j.raw || ''), ctx: String(j.ctx || ''), draft: fs.readFileSync(dp, 'utf8'), draftSha: sha(fs.readFileSync(dp, 'utf8')) })
    }
  }
  return rows
}
function cmdHand() {
  const rows = loadHand()
  const byRound = {}
  for (const r of rows) byRound[r.round] = (byRound[r.round] || 0) + 1
  fs.writeFileSync(path.join(OUT, 'hand-standard.jsonl'), rows.map((r) => JSON.stringify({ ...r })).join('\n') + '\n')
  console.log(jdump({ handSet: rows.length, byRound }))
}

// ---------- pool (教师样本) ----------
function loadPool() {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (/node_modules|\.git[\\/]|\/traj\/|archive|pending|drafts/.test(p)) continue
      if (e.isDirectory()) walk(p); else if (/\.jsonl(\.gz)?$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'transfer', 'models'))
  files.sort()
  const seen = new Map(), dup = []
  for (const f of files) {
    let lines
    try { lines = readLines(f) } catch { continue }
    lines.forEach((l, i) => {
      const s = parseSample(l)
      if (!s || !s.unitId) return
      const rec = { ...s, sourceFile: path.relative(ROOT, f), sourceLine: i + 1, sourceLineSha: sha(l) }
      if (seen.has(s.unitId)) { const o = seen.get(s.unitId); dup.push({ unitId: s.unitId, a: o.sourceFile, b: rec.sourceFile, sameTarget: o.target === s.target }); return }
      seen.set(s.unitId, rec)
    })
  }
  return { units: [...seen.values()], dup, files: files.map((f) => path.relative(ROOT, f)) }
}

// ---------- calibrate ----------
function cmdCalibrate() {
  const frozenCheck = assertFrozen(null)
  const hand = fs.existsSync(path.join(OUT, 'hand-standard.jsonl')) ? fs.readFileSync(path.join(OUT, 'hand-standard.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : loadHand()
  const all = hand.map((h) => ({ id: h.id, round: h.round, ...pick(grade(h)) }))
  const graded = all.filter((g) => g.gaugeable === true)
  const unscorable = all.filter((g) => g.gaugeable !== true).map((g) => g.id)
  const hp = graded.filter((g) => g.pass === true)
  const k = hp.length, n = graded.length
  const soft = hp.map((g) => g.softScore).filter((x) => x != null).sort((a, b) => a - b)
  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null
  const floor = pct(soft, SOFT_PCTL)
  const byRound = {}
  for (const r of HAND_ROUNDS) { const g = graded.filter((x) => x.round === r); byRound[r] = { n: g.length, hardPass: g.filter((x) => x.pass === true).length } }
  const thr = {
    schema: 'cfb.v9-thresholds/1', ruler: RULER_V9, base: 'gen-ruler-v9/1', genRulerSha256: frozenCheck,
    negativesSha256: sha256File(path.join(path.dirname(fileURLToPath(import.meta.url)), NEGATIVES_FILE)),
    handTotal: all.length, handUnscorable: unscorable,
    handN: n, handHardPass: k, handHardPassRate: +(k / n).toFixed(4), handHardPassCI95: wilson(k, n),
    handByRound: byRound, softFloor: floor, softFloorRule: `hand 硬门通过稿软分的第 ${SOFT_PCTL * 100}% 百分位`,
    softPctlOfHand: { p10: pct(soft, 0.1), p50: pct(soft, 0.5), p90: pct(soft, 0.9) },
    minHandHardPass: MIN_HAND_PASS, handGate: k / n >= MIN_HAND_PASS ? 'PASS' : 'FAIL',
    failedHandIds: graded.filter((g) => g.pass !== true).map((g) => ({ id: g.id, failed: g.hardFailed })),
  }
  fs.writeFileSync(path.join(OUT, 'thresholds.json'), jdump(thr) + '\n')
  console.log(jdump(thr))
  if (thr.handGate !== 'PASS') process.exitCode = 2
}
const pick = (g) => ({ pass: g.pass, hardFailed: g.hardFailed, softScore: g.softScore, gaugeable: g.gaugeable })

// ---------- validate ----------
function cmdValidate() {
  const thr = JSON.parse(fs.readFileSync(path.join(OUT, 'thresholds.json'), 'utf8'))
  assertFrozen({ genRulerSha256: thr.genRulerSha256 })
  const { units } = loadPool()
  const hand = fs.readFileSync(path.join(OUT, 'hand-standard.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const val = { schema: 'cfb.v9-validation/1', ruler: RULER_V9, at: new Date().toISOString(), checks: {}, validity: {} }

  // 1 确定性：每条判两次，且打乱调用顺序，结果必须逐字一致
  let detN = 0, detBad = []
  for (const u of units) {
    const a = JSON.stringify(pick(grade({ raw: u.raw, ctx: u.ctx, draft: u.target })))
    const b = JSON.stringify(pick(grade({ raw: u.raw, ctx: u.ctx, draft: u.target })))
    detN++
    if (a !== b) detBad.push(u.unitId)
  }
  for (const h of hand) {
    const a = JSON.stringify(pick(grade(h))), b = JSON.stringify(pick(grade({ draft: h.draft, ctx: h.ctx, raw: h.raw })))
    detN++
    if (a !== b) detBad.push(h.id)
  }
  val.checks.determinism = { n: detN, mismatches: detBad.length, examples: detBad.slice(0, 5) }

  // 2 负对照（机械派生，标签构造时已知）：只在通过硬门的教师稿上派生
  const posRows = units.filter((u) => grade({ raw: u.raw, ctx: u.ctx, draft: u.target }).pass === true)
  const rows = posRows.map((u) => ({ id: u.unitId, raw: u.raw, ctx: u.ctx, draft: u.target }))
  const neg = auditRuler(rows)
  val.checks.negativeControls = {
    nPos: neg.nPos, nNeg: neg.nNeg, nRejected: neg.nRejected, holes: neg.holes.length,
    holeRate: neg.nNeg ? +(neg.holes.length / neg.nNeg).toFixed(4) : null,
    byAxis: neg.byAxis, holeExamples: neg.holes.slice(0, 5).map((h) => ({ id: h.id, axis: h.axis, mutation: h.mutation })),
    note: '「洞」= 负例整条过了尺子（auditRuler 定义）。',
  }

  // 3 对照：空稿、照抄稿。可测单元上都必须不过。
  const gaug = units.filter((u) => grade({ raw: u.raw, ctx: u.ctx, draft: u.target }).gaugeable)
  let emptyPass = 0, copyPass = 0, copyN = 0
  for (const u of gaug) {
    if (grade({ raw: u.raw, ctx: u.ctx, draft: '' }).pass === true) emptyPass++
    if (u.raw.length >= 400) { copyN++; if (grade({ raw: u.raw, ctx: u.ctx, draft: u.raw }).pass === true) copyPass++ }
  }
  val.checks.emptyDraft = { gaugeableUnits: gaug.length, passed: emptyPass }
  val.checks.verbatimCopy = { n: copyN, passed: copyPass }

  // 4 教师通过率（按切分）与 hand 通过率
  const floor = thr.softFloor
  const by = {}
  for (const sp of ['train', 'dev', 'test']) {
    const all = units.filter((u) => splitOf(u.repo) === sp)
    const s = all.filter((u) => grade({ raw: u.raw, ctx: u.ctx, draft: '' }).gaugeable === true)
    const g = s.map((u) => isGoodDraft({ raw: u.raw, ctx: u.ctx, draft: u.target }, floor))
    const hardK = g.filter((x) => x.pass === true).length, goodK = g.filter((x) => x.good === true).length
    by[sp] = { total: all.length, unscorable: all.length - s.length, n: s.length, hardPass: hardK, hardPassRate: s.length ? +(hardK / s.length).toFixed(4) : null, hardCI95: wilson(hardK, s.length), good: goodK, goodRate: s.length ? +(goodK / s.length).toFixed(4) : null }
  }
  val.checks.teacherBySplit = by
  const hg = hand.map((h) => isGoodDraft(h, floor)).filter((x) => x.gaugeable === true)
  val.checks.handStandard = { n: hg.length, hardPass: hg.filter((x) => x.pass === true).length, good: hg.filter((x) => x.good === true).length, goodRate: +(hg.filter((x) => x.good === true).length / hg.length).toFixed(4) }

  // 5 有效性判定（预注册，不事后改）
  const v = val.validity
  v.determinism = detBad.length === 0 ? 'PASS' : 'FAIL'
  v.handHardPassRate = thr.handHardPassRate >= MIN_HAND_PASS ? 'PASS' : 'FAIL'
  v.negativeHoles = neg.holes.length === 0 ? 'PASS' : 'FAIL'
  v.emptyDraftPasses = emptyPass === 0 ? 'PASS' : 'FAIL'
  v.verbatimCopyPasses = copyPass === 0 ? 'PASS' : 'FAIL'
  v.teacherTestNotZero = (by.test.hardPassRate ?? 0) >= MIN_TEACHER_TEST_PASS ? 'PASS' : 'FAIL'
  v.VALID = Object.values(v).every((x) => x === 'PASS') ? 'VALID' : 'INVALID'
  fs.writeFileSync(path.join(OUT, 'validation.json'), jdump(val) + '\n')
  console.log(jdump(val))
  if (v.VALID !== 'VALID') process.exitCode = 3
}

// ---------- build ----------
function cmdBuild() {
  const thr = JSON.parse(fs.readFileSync(path.join(OUT, 'thresholds.json'), 'utf8'))
  const val = JSON.parse(fs.readFileSync(path.join(OUT, 'validation.json'), 'utf8'))
  if (val.validity.VALID !== 'VALID') throw new Error('尺子无效：拒绝构建数据集（见 validation.json）')
  const { units, dup, files } = loadPool()
  const floor = thr.softFloor
  const out = { train: [], dev: [], test: [] }
  const stats = { pool: units.length, dupUnitIds: dup.length, dupSameTarget: dup.filter((d) => d.sameTarget).length }
  for (const u of units) {
    const sp = splitOf(u.repo)
    const g = isGoodDraft({ raw: u.raw, ctx: u.ctx, draft: u.target }, floor)
    const meta = { unitId: u.unitId, repo: u.repo, license: u.license || null, split: sp, source: u.sourceFile, sourceLine: u.sourceLine, sourceLineSha256: u.sourceLineSha, v9: { gaugeable: g.gaugeable, pass: g.pass === true, good: g.good === true, softScore: g.softScore, hardFailed: g.hardFailed }, ruler: RULER_V9 }
    const row = { messages: [
      { role: 'system', content: u.meta.messages[0].content },
      { role: 'user', content: u.meta.messages[1].content },
      { role: 'assistant', content: u.target },
    ], meta }
    if (sp === 'train') { if (g.good === true) out.train.push(row) } else out[sp].push(row)
  }
  // 训练集只含好稿；dev/test 保留全部并带 good 标签，便于计算通过率。
  stats.counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { rows: v.length, good: v.filter((r) => r.meta.v9.good).length, unscorable: v.filter((r) => !r.meta.v9.gaugeable).length }]))
  stats.trainRule = '仅 split=train 且 v9.good=true'
  stats.splitRule = 'fnv1a(repo) % 10：0–1 → test，2 → dev，其余 → train（仓库级切分，同仓库不跨集）'
  stats.sourceFiles = files
  stats.licenses = [...new Set(units.map((u) => u.license || 'unknown'))]
  for (const [k, rows] of Object.entries(out)) {
    fs.writeFileSync(path.join(OUT, `${k}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  const manifest = Object.fromEntries(['train', 'dev', 'test', 'thresholds.json', 'validation.json'].map((f) => [f, sha256File(path.join(OUT, f.endsWith('.json') ? f : f + '.jsonl'))]))
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), jdump({ ruler: RULER_V9, stats, sha256: manifest }) + '\n')
  console.log(jdump(stats))
}

const cmd = process.argv[2]
const table = { hand: cmdHand, calibrate: cmdCalibrate, validate: cmdValidate, build: cmdBuild }
if (!table[cmd]) { console.error('用法：node tools/v9-pipeline.mjs <hand|calibrate|validate|build>'); process.exit(1) }
table[cmd]()
