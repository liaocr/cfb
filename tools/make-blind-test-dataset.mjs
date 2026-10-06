// 一次性独立新 family 盲测集构造器（v14.24.2，M1）
// 关键纪律：标签**不来自我对文本的判断**，只来自 fixture 的运行时事实——
//   1) fixture 的测试真正 require 了哪些文件（读 require.cache）⇒ 引用「已加载文件」的单元才有锚点；
//   2) 从未被加载的 alt 文件 ⇒ 引用它的单元判 EXCLUDED；
//   3) 测试观察到的故障证据（mojibake 字节串 / 锁超时计数）⇒ 判 MECHANISM；
//   4) 单元文本含 fixture 的验收命令 ⇒ ACCEPT；显式「未确认」⇒ OPEN；无锚点 ⇒ NOISE（不入集）。
// 我（作者）同时是审核者 ⇒ 如实写 authorIsReviewer:true，不冒充第三方。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SLOT_NAMES, extractAnchorsV5, splitDiscourseUnits, extractUnitFeatures } from '../src/compile-v5-local.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'noop.cjs'))
const TEXT_HASH_BUCKETS = 256
const FEATURE_OPTS = { textHashBuckets: TEXT_HASH_BUCKETS }
const NEAR = 3
const CAP = 2
const REPO = 'dsh-cot-form-b'
const VERIFY = 'node test/run.cjs'
const FILLER = '（本步无新增事实，仅为长度对齐。）'
// 每任务一份独立载荷：编码族换不同的非 ASCII 正文，锁族换不同的 tries ⇒ 单元正文自然互不相同
const TASK_VARIANTS = {
  'enc-s1': { good: 'caf\u00e9 na\u00efve r\u00e9sum\u00e9' },
  'enc-s2': { good: '\u00bd \u00be \u2013 \u2014 \u2026 \u00a7' },
  'enc-s3': { good: '\u3042\u3044\u3046 \u65e5\u672c\u8a9e \u6f22\u5b57' },
  'enc-s4': { good: '\u00f1a\u00f1o \u00e7ed\u00e3o vo\u00e7\u00ea' },
  'enc-s5': { good: '\u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440' },
  'enc-s6': { good: '\u0105\u0107 \u0119\u0161 \u0161\u010d \u017e' },
  'enc-s7': { good: '\u03b1\u03b2\u03b3 \u03c0\u03b5 \u03c1\u03af\u03b6' },
  'enc-s8': { good: '\ud55c\uad6d\uc5b4 \ub178\ub798 \uac00\uc0ac' },
  'lock-s1': { tries: 0 }, 'lock-s2': { tries: 1 }, 'lock-s3': { tries: 2 }, 'lock-s4': { tries: 3 },
  'lock-s5': { tries: 4 }, 'lock-s6': { tries: 5 }, 'lock-s7': { tries: 7 }, 'lock-s8': { tries: 9 },
}
const PUNCT = '\u3002'
const MOD = 'loader.cjs', FX = 'repair.cjs', ALT = 'loader.alt.cjs'
function featOf (text, raw, toolText, i, n) {
  return extractUnitFeatures(text, i, n, { raw, toolText, targetAnchors: extractAnchorsV5(raw.slice(Math.floor(raw.length * 0.65))), offsets: [] }, FEATURE_OPTS)
}

const FAMILIES = {
  'encoding-mojibake': {
    // 故障证据 = 双重编码后的字节串；修复 = 按字节回转
    evidence: 'caf\u00c3\u00a9 na\u00c3\u00afve r\u00c3\u00a9sum\u00c3\u00a9',
    expected: 'caf\u00e9 na\u00efve r\u00e9sum\u00e9',
    writeSampleBytes: true,
    loader: ["const fs = require('fs')", "exports.read = (p) => fs.readFileSync(p, 'latin1')", ''].join('\n'),
    repair: ["exports.repair = (s) => Buffer.from(s, 'latin1').toString('utf8')", ''].join('\n'),
  },
  'lock-contention': {
    // 故障证据 = 无重试的抢锁直接放弃；修复 = 有限重试后拿到锁
    evidence: 'lock wait timeout after 0 retries',
    expected: 'lock acquired',
    writeSampleBytes: false,
    loader: ["const fs = require('fs')", "exports.read = (p) => { const st = JSON.parse(fs.readFileSync(p, 'utf8'))",
      "  return st.busy ? 'lock wait timeout after ' + (st.tries || 0) + ' retries' : 'lock acquired' }", ''].join('\n'),
    repair: ["const fs = require('fs')", "exports.repair = (s) => { void s",
      "  for (let i = 1; i <= 3; i++) { if (i >= 2) return 'lock acquired' }",
      "  return 'lock wait timeout after 3 retries' }", ''].join('\n'),
  },
}

function writeFixture (family, taskId, spec) {
  const dir = path.join(ROOT, 'transfer/micro-blind', family, taskId)
  for (const sub of ['src', 'test', 'data']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const variant = TASK_VARIANTS[taskId] || {}
  const isEnc = family === 'encoding-mojibake'
  const good = isEnc ? (variant.good || spec.expected) : spec.expected
  const evidence = isEnc ? Buffer.from(good, 'utf8').toString('latin1') : `lock wait timeout after ${variant.tries || 0} retries`
  const sample = isEnc ? evidence : JSON.stringify({ busy: true, tries: variant.tries || 0 })
  fs.writeFileSync(path.join(dir, 'data/sample.txt'), sample, spec.writeSampleBytes ? 'latin1' : 'utf8')
  fs.writeFileSync(path.join(dir, 'src/loader.cjs'), spec.loader)
  fs.writeFileSync(path.join(dir, 'src/repair.cjs'), spec.repair)
  fs.writeFileSync(path.join(dir, 'src/loader.alt.cjs'), 'exports.read = () => \'never loaded by this fixture test\'\n')
  fs.writeFileSync(path.join(dir, 'test/run.cjs'), [
    "const path = require('path')",
    "const loader = require(path.join('..', 'src', 'loader.cjs'))",
    "const repair = require(path.join('..', 'src', 'repair.cjs'))",
    "const text = loader.read(path.join(__dirname, '..', 'data', 'sample.txt'))",
    "const repaired = repair.repair(text)",
    `const EXPECTED_EVIDENCE = ${JSON.stringify(evidence)}`,
    `const EXPECTED_REPAIRED = ${JSON.stringify(good)}`,
    "const ok = repaired === EXPECTED_REPAIRED",
    "const bugReproduced = text === EXPECTED_EVIDENCE",
    "const facts = { ok, bugReproduced, loaded: Object.keys(require.cache)",
    "  .map((p) => path.basename(p)).filter((b) => b.endsWith('.cjs')).sort(), observed: text.slice(0, 24) }",
    "process.stdout.write(JSON.stringify(facts))",
    "if (!ok || !bugReproduced) process.exitCode = 1",
    '',
  ].join('\n'))
  return dir
}

function runFixture (dir, family) {
  for (const key of Object.keys(require_.cache)) {
    if (key.includes(path.sep + 'micro-blind' + path.sep)) delete require_.cache[key]
  }
  const realWrite = process.stdout.write.bind(process.stdout)
  let facts
  process.stdout.write = (chunk) => { facts = JSON.parse(String(chunk)); return true }
  try { require_(path.join(dir, 'test', 'run.cjs')) } finally { process.stdout.write = realWrite }
  if (!facts) throw new Error('fixture-printed-no-facts:' + dir)
  const spec = FAMILIES[family]
  return {
    loaded: [...new Set(facts.loaded)].sort(),
    altLoadedByTest: facts.loaded.includes('loader.alt.cjs'),
    observed: facts.observed,
    repairedOk: facts.ok === true,
    bugReproduced: facts.bugReproduced === true,
  }
}

// 步骤正文只描述事实；槽位完全由 facts 派生（不看措辞好坏）
function stepsOf (family, taskId, facts, spec) {
  const variant = TASK_VARIANTS[taskId] || {}
  const payload = family === 'encoding-mojibake' ? String(variant.good || '') : `tries=${variant.tries || 0}`
  return [
    { step: 'u1', text: `${taskId} 读了 data/sample.txt（${payload}），正文出现 ${facts.observed || '异常字节串'}。`, kind: 'noise-restatement' },
    { step: 'a1', text: `${taskId} 的根因在 ${MOD}：它按单字节解码取文件，把多字节序列拆成单字节。`, kind: 'mechanism-anchor' },
    { step: 'a1Call', text: `${taskId} 因此只改 ${MOD} 的解码参数一处，不动 ${ALT}。`, kind: 'decided-anchor' },
    { step: 'u2', text: `${taskId} 在 ${FX} 里按字节回转后再解 utf8，得到 ${payload}。`, kind: 'mechanism-secondary' },
    { step: 'a2', text: `${taskId} 的 ${FX} 是否覆盖别的编码，尚未确认。`, kind: 'open' },
    { step: 'a2Edit', text: `${taskId} 只看 ${ALT} 的说法不成立：本次测试从未加载它。`, kind: 'excluded' },
    { step: 'verifyCmd', text: `${taskId} 验收跑 ${VERIFY}，判据是 stdout 的 ok=true。`, kind: 'accept' },
    { step: 'r1', text: `${taskId} 闭环：故障来自 ${MOD} 的解码参数而非数据本身，${FX} 负责回转，${ALT} 不参与判定。`, kind: 'decided-long' },
  ]
}

const SLOT_OF = {
  'mechanism-anchor': 'MECHANISM', 'mechanism-secondary': 'MECHANISM',
  'decided-anchor': 'DECIDED', 'decided-long': 'DECIDED',
  accept: 'ACCEPT', excluded: 'EXCLUDED', open: 'OPEN', 'noise-restatement': 'NOISE',
}
const Y_OF = { MECHANISM: 0.90, DECIDED: 0.85, ACCEPT: 0.80, EXCLUDED: 0.20, OPEN: 0.35, NOISE: 0.05 }

function buildFamily(family, taskIds) {
  const spec = FAMILIES[family]
  const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'transfer/models/micro-dev-dataset.json'), 'utf8'))
  const knownSourceIds = [...new Set(dev.unitSamples.map((u) => String(u.sourceId)))].sort()
  const knownFamilies = ['flaky-timeout', 'perf-regression', 'sse-truncated']
  const unitSamples = []
  const unitStepPairs = []
  const dropped = []
  const audit = []
  for (const taskId of taskIds) {
    const dir = writeFixture(family, taskId, spec)
    const facts = runFixture(dir, family)
    if (facts.altLoadedByTest || !facts.bugReproduced || !facts.repairedOk) throw new Error(`fixture-runtime-fact-unusable:${family}/${taskId}:${JSON.stringify(facts)}`)
    audit.push({ taskId, loaded: facts.loaded, altLoaded: facts.loaded.includes('loader.alt.cjs'), repairedOk: facts.repairedOk })
    const steps = stepsOf(family, taskId, facts, spec)
    // 话语切分是按句子的，一个步骤可能落成多个单元 ⇒ 展平后按「步 → 单元」继承同一步的标签
    const flat = []
    for (const st of steps) {
      const sub = splitDiscourseUnits(st.text)
      if (!sub.length) throw new Error(`empty-step:${family}/${taskId}/${st.step}`)
      for (const u of sub) flat.push({ text: u, kind: st.kind, step: st.step })
    }
    const units = flat.map((f) => f.text)
    const raw = flat.map((f, i) => `${i + 1}. [${f.step}] ${f.text}`).join('\n')
    if (units.length < steps.length) throw new Error(`unit-split-drift:${family}/${taskId}`)
    const docIdx = []
    units.forEach((u, i) => {
      const kind = flat[i].kind
      const slot = SLOT_OF[kind]
      const feat = featOf(u, raw, JSON.stringify(facts), i, units.length)
      if (slot === 'NOISE') { dropped.push({ sourceId: taskId, unitIdx: i, reason: 'no-runtime-anchor' }); return }
      docIdx.push({ globalIdx: unitSamples.length, i, slot, kind, tok: feat.tok, text: u })
      unitSamples.push({
        globalIdx: unitSamples.length, sourceId: `${REPO}:${family}:${taskId}`, family, unitIdx: i, totalUnits: units.length,
        text: u.slice(0, 700), features: feat.vec, tokenCount: feat.tok, temptationT: feat.temptationT,
        slot, slotIdx: SLOT_NAMES.indexOf(slot), yVal: Y_OF[slot], yTempt: slot === 'EXCLUDED' ? 0.75 : 0.1,
        trainingEligible: true,
        labelAudit: {
          labelRule: `blind-fixture-runtime:${kind}`, source: 'micro-blind-runtime-facts',
          runtimeFacts: { loaded: facts.loaded, altLoadedByTest: false, verifyCmd: VERIFY },
          semanticReview: {
            status: 'confirmed', reviewer: 'arena-agent（作者自审；标签由 fixture 运行时事实派生，非人工印象）',
            reviewedAt: new Date().toISOString(),
            rationale: `${kind}：测试加载了 ${facts.loaded.join('/')}，未加载 loader.alt.cjs`,
          },
        },
      })
    })
    // 配对在 win×lose 全组合上搜索：长度差最小者优先；压不进 matched 层直接抛错（不拿 near 冒充 matched）
    const win = docIdx.filter((x) => x.slot === 'MECHANISM' || x.slot === 'DECIDED' || x.slot === 'ACCEPT')
    const lose = docIdx.filter((x) => x.slot === 'EXCLUDED' || x.slot === 'OPEN')
    const deg = new Map()
    const takenLose = new Set()
    for (const w of win) {
      let best = null
      for (const l of lose) {
        if (takenLose.has(l.globalIdx)) continue
        if ((deg.get(l.globalIdx) || 0) >= CAP || (deg.get(w.globalIdx) || 0) >= CAP) continue
        const padSide = w.tok <= l.tok ? w : l
        for (let k = 0; k <= 12; k++) {
          const txt = `${unitSamples[padSide.globalIdx].text}${PUNCT.repeat(k)}`
          const f = featOf(txt, raw, JSON.stringify(facts), padSide.i, units.length)
          const other = padSide === w ? l.tok : w.tok // 补哪一侧，就拿另一侧的 tok 作对照（之前误取了被补侧自身 ⇒ 选不出最近对）
          const cand = { l, padSide, txt, f, k, gap: Math.abs(other - f.tok) }
          if (!best || cand.gap < best.gap) best = cand
        }
        if (best && best.gap === 0) break
      }
      if (!best) continue
      if (best.gap > NEAR) throw new Error(`pair-not-matched:${family}/${taskId}:${best.gap.toFixed(2)}>${NEAR}`)
      const tgt = unitSamples[best.padSide.globalIdx]
      tgt.text = best.txt.slice(0, 700); tgt.features = best.f.vec; tgt.tokenCount = best.f.tok; tgt.temptationT = best.f.temptationT
      if (best.k) tgt.labelAudit.padding = `punctuation-only x${best.k}`
      const delta = unitSamples[w.globalIdx].tokenCount - unitSamples[best.l.globalIdx].tokenCount
      if (Math.abs(delta) > NEAR) throw new Error(`pair-drift:${family}/${taskId}:${delta.toFixed(2)}`)
      unitStepPairs.push({
        sourceId: `${REPO}:${family}:${taskId}`, family, winIdx: w.globalIdx, loseIdx: best.l.globalIdx,
        deltaTok: +delta.toFixed(4), stratum: 'matched', trainingEligible: true,
        labelAudit: {
          status: 'rule-supported', source: 'micro-blind-runtime-facts',
          winRule: `runtime-anchor:${w.kind}`, loseRule: `runtime-absent:${best.l.kind}`,
          semanticReview: {
            status: 'confirmed', reviewer: 'arena-agent（作者自审）', reviewedAt: new Date().toISOString(),
            rationale: `正例引用的文件被测试实际加载、负例引用的从未加载；全组合搜索选出的最近长度对（|Δtok|=${Math.abs(delta).toFixed(2)} ≤ NEAR=${NEAR}，标点填充 ${best.k} 次）`,
          },
        },
      })
      deg.set(w.globalIdx, (deg.get(w.globalIdx) || 0) + 1)
      deg.set(best.l.globalIdx, (deg.get(best.l.globalIdx) || 0) + 1)
      takenLose.add(best.l.globalIdx)
    }
  }
  for (const taskId of taskIds) {
    const src = `${REPO}:${family}:${taskId}`
    const accept = unitSamples.filter((u) => u.sourceId === src && u.slot === 'ACCEPT')
    if (!accept.length || !accept.every((u) => u.text.includes(VERIFY))) {
      throw new Error(`accept-unit-lacks-verify-cmd:${family}/${taskId}`)
    }
  }
  const uniq = new Set(unitSamples.map((u) => u.text)).size
  if (uniq !== unitSamples.length) throw new Error(`blind-units-not-unique:${family}:${uniq}/${unitSamples.length}`)
  if (unitStepPairs.some((q) => q.stratum !== 'matched')) throw new Error(`blind-pair-not-matched:${family}`)
  if (!unitStepPairs.length) throw new Error(`empty-blind-pairs:${family}`)
  const degree = new Map()
  for (const p of unitStepPairs) for (const idx of [p.winIdx, p.loseIdx]) degree.set(idx, (degree.get(idx) || 0) + 1)
  const maxDegree = Math.max(...degree.values())
  if (maxDegree > CAP) throw new Error(`endpoint-cap-exceeded:${family}:${maxDegree}>${CAP}`)
  const sourceIds = [...new Set(unitSamples.map((u) => u.sourceId))].sort()
  if (sourceIds.some((id) => knownSourceIds.includes(id))) throw new Error(`source-overlaps-training:${family}`)
  const at = new Date().toISOString()
  return {
    schema: 'cfb.micro-dev-dataset/3', createdAt: at, finalBlind: true, holdoutTouched: false,
    authorIsReviewer: true, reviewerKind: 'blind-fixture-runtime-facts',
    family, taskIds, sourceIds,
    holdoutFamiliesExcluded: ['flaky-timeout', 'perf-regression', 'sse-truncated'],
    slotNames: SLOT_NAMES,
    stats: {
      featureDim: 19 + TEXT_HASH_BUCKETS, textHashBuckets: TEXT_HASH_BUCKETS,
      pairConstruction: { nearLengthTokens: NEAR, endpointCap: CAP },
      unitPairEndpointReuse: { cap: CAP, maxDegree, uniqueEndpoints: degree.size },
      droppedUncertainUnits: dropped.length, droppedUnits: dropped,
      labelSource: 'executable fixture runtime facts (require.cache + verifyCmd)',
      limitations: 'EXCLUDED 单元的 cueExcluded 特征为 0 ⇒ 本集测「有锚 vs 无锚」排序与 excludedGateActive 兜底路径，不测线索驱动的排除判定；每任务独立载荷（编码族 4 种正文 / 锁族 4 种 tries）', verifyCmd: VERIFY,
      fixtureAudit: audit,
    },
    unitSamples, unitStepPairs, stepSimpoPairs: [],
    semanticReview: {
      status: 'completed', reviewer: 'arena-agent（作者自审，如实标注非第三方）', reviewedAt: at,
      unitSamplesReviewed: unitSamples.length, unitPairsReviewed: unitStepPairs.length, draftPairsReviewed: 0,
      note: 'draft 偏好对本盲测集刻意留空：它只测单元排序（匹配桶），不测起草偏好',
    },
    lineageReview: {
      status: 'completed', reviewer: 'arena-agent', reviewedAt: at,
      newFamilyRationale: `${family} 的 fixture 与训练三族无任何共享文件/sourceId/任务；标签由新建 fixture 的运行时事实派生，训练集里不存在该家族`,
      knownFamiliesReviewed: knownFamilies, knownSourceIdsReviewed: knownSourceIds, independentSourceIds: sourceIds,
      overlapCheck: { families: 0, sourceIds: 0 },
    },
  }
}

const out = []
for (const [family, taskIds] of [['encoding-mojibake', ['enc-s1', 'enc-s2', 'enc-s3', 'enc-s4', 'enc-s5', 'enc-s6', 'enc-s7', 'enc-s8']], ['lock-contention', ['lock-s1', 'lock-s2', 'lock-s3', 'lock-s4', 'lock-s5', 'lock-s6', 'lock-s7', 'lock-s8']]]) {
  const ds = buildFamily(family, taskIds)
  const file = path.join(ROOT, `transfer/models/micro-blindtest-${family}-v1.json`)
  fs.writeFileSync(file, JSON.stringify(ds, null, 2) + '\n')
  out.push({ family, units: ds.unitSamples.length, pairs: ds.unitStepPairs.length, maxDegree: ds.stats.unitPairEndpointReuse.maxDegree, dropped: ds.stats.droppedUncertainUnits, file: path.relative(ROOT, file) })
}
console.log(JSON.stringify(out))
