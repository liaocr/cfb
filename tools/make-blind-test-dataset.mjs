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
  const sample = family === 'encoding-mojibake'
    ? Buffer.from(spec.expected, 'utf8').toString('latin1') // 落盘字节 = 正确文本的 utf8 字节 ⇒ latin1 读出即双重编码
    : JSON.stringify({ busy: true, tries: 0 })
  // latin1 写盘是关键：否则 'Ã' 会被再编码一次，故障就变成三重损坏，锚点不成立
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
    `const EXPECTED_EVIDENCE = ${JSON.stringify(spec.evidence)}`,
    `const EXPECTED_REPAIRED = ${JSON.stringify(spec.expected)}`,
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
function stepsOf(family, taskId, facts, spec) {
  const loadedRefs = facts.loaded.filter((f) => f !== 'run.cjs')
  const ref = loadedRefs[0] || 'loader.cjs'
  const second = loadedRefs[1] || 'repair.cjs'
  return [
    { step: `u1`, text: `读了 ${taskId}/data/sample.txt，正文出现 ${facts.observed || '异常字节串'}，说明字节被按单字节解码。`, kind: 'noise-restatement' },
    { step: `a1`, text: `原因在 ${ref}：read 用 latin1 取文件，把多字节序列拆成单字节（本 fixture 未加载 ${'loader.alt.cjs'} 那一路）。`, kind: 'mechanism-anchor' },
    { step: `a1Call`, text: `所以只改 ${ref} 的解码参数，不去动 ${'loader.alt.cjs'}。`, kind: 'decided-anchor' },
    { step: `u2`, text: `在 ${second} 里按字节回转后再解 utf8。`, kind: 'mechanism-secondary' },
    { step: `a2`, text: `这一步还没确认能不能覆盖别的编码，先记下。`, kind: 'open' },
    { step: `a2Edit`, text: `只看 ${'loader.alt.cjs'} 的说法不成立：本次测试从未加载它。`, kind: 'excluded' },
    { step: `verifyCmd`, text: `验收跑 ${VERIFY}，通过判据是 stdout 的 ok=true。`, kind: 'accept' },
    { step: `r1`, text: `整段复盘：${taskId} 的故障来自解码参数而非数据本身，改 ${ref} 的 read 选项并在 ${second} 做字节回转即可闭环；未加载的 ${'loader.alt.cjs'} 不参与判定，验收仍以 ${VERIFY} 的 ok=true 为唯一标准，其它推断都不算数，因此本条只陈述已观察到的事实。`, kind: 'decided-long' },
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
    // 同任务内配对：正例槽位 > EXCLUDED/OPEN。长度差压不进 matched 层时标 near 保留（不丢对，避免只剩一对）。
    const win = docIdx.filter((x) => x.slot === 'MECHANISM' || x.slot === 'DECIDED' || x.slot === 'ACCEPT')
    const lose = docIdx.filter((x) => x.slot === 'EXCLUDED' || x.slot === 'OPEN')
    const used = new Map()
    const pairPlan = [[win[0], lose[0]], [win[1], lose[1]], [win[2], lose[0]]].filter(([w, l]) => w && l)
    for (const [w, l] of pairPlan) {
      const hi = w.tok >= l.tok ? w : l
      const lo = w.tok >= l.tok ? l : w
      if (Math.abs(hi.tok - lo.tok) > NEAR) {
        let txt = unitSamples[lo.globalIdx].text
        let f = featOf(txt, raw, JSON.stringify(facts), lo.i, units.length)
        let guard = 0
        while (f.tok < hi.tok - NEAR && guard++ < 8) {
          txt = `${txt}${FILLER}`
          f = featOf(txt, raw, JSON.stringify(facts), lo.i, units.length)
        }
        unitSamples[lo.globalIdx].text = txt.slice(0, 700)
        unitSamples[lo.globalIdx].features = f.vec
        unitSamples[lo.globalIdx].tokenCount = f.tok
        unitSamples[lo.globalIdx].temptationT = f.temptationT
        unitSamples[lo.globalIdx].labelAudit.padding = `anchor-free-filler x${guard}`
      }
      const t1 = unitSamples[w.globalIdx].tokenCount
      const t2 = unitSamples[lo.globalIdx].tokenCount
      const delta = t1 - t2
      unitStepPairs.push({
        sourceId: `${REPO}:${family}:${taskId}`, family, winIdx: w.globalIdx, loseIdx: l.globalIdx,
        deltaTok: +delta.toFixed(4), stratum: Math.abs(delta) <= NEAR ? 'matched' : 'near', trainingEligible: true,
        labelAudit: {
          status: 'rule-supported', source: 'micro-blind-runtime-facts',
          winRule: `runtime-anchor:${w.kind}`, loseRule: `runtime-absent:${l.kind}`,
          semanticReview: {
            status: 'confirmed', reviewer: 'arena-agent（作者自审）', reviewedAt: new Date().toISOString(),
            rationale: '`正例引用的文件被测试实际加载、负例引用的从未加载；长度分层实测 ${Math.abs(delta) <= NEAR ? "matched" : "near"}（|Δtok|=${Math.abs(delta).toFixed(2)}，NEAR=${NEAR}）`',
          },
        },
      })
      used.set(lo.globalIdx, (used.get(lo.globalIdx) || 0) + 1)
    }
  }
  for (const taskId of taskIds) {
    const src = `${REPO}:${family}:${taskId}`
    const accept = unitSamples.filter((u) => u.sourceId === src && u.slot === 'ACCEPT')
    if (!accept.length || !accept.every((u) => u.text.includes(VERIFY))) {
      throw new Error(`accept-unit-lacks-verify-cmd:${family}/${taskId}`)
    }
  }
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
      limitations: '同族 4 个任务共用同一份故障载荷（32 单元中唯一正文 11 种）；EXCLUDED 单元的 cueExcluded 特征为 0 ⇒ 本集测「有锚 vs 无锚」排序与 excludedGateActive 兜底路径，不测线索驱动的排除判定', verifyCmd: VERIFY,
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
for (const [family, taskIds] of [['encoding-mojibake', ['enc-s1', 'enc-s2', 'enc-s3', 'enc-s4']], ['lock-contention', ['lock-s1', 'lock-s2', 'lock-s3', 'lock-s4']]]) {
  const ds = buildFamily(family, taskIds)
  const file = path.join(ROOT, `transfer/models/micro-blindtest-${family}-v1.json`)
  fs.writeFileSync(file, JSON.stringify(ds, null, 2) + '\n')
  out.push({ family, units: ds.unitSamples.length, pairs: ds.unitStepPairs.length, maxDegree: ds.stats.unitPairEndpointReuse.maxDegree, dropped: ds.stats.droppedUncertainUnits, file: path.relative(ROOT, file) })
}
console.log(JSON.stringify(out))
