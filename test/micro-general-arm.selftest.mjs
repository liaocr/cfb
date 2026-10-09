// test/micro-general-arm.selftest.mjs —— 钉住「原型命中 vs 真实用户仓兜底路径」这道差，以及围绕它的每一条文档引用。
//
// 为什么单独钉这一条（v14.25.1 外部审计后补）：`src/compile-v5-local.js` 的 `draft` 由 5 个手写原型模板
// 或兜底路径 `compileGeneralDiscourseGraph` 二选一产出，而模板命中的判据是 raw 里带**我们自己的**标识符
// （`hedgeAfterMs` / `assembleSseFrames` / `compressTargetMax` / `host-follow.js` / `config.js`）——
// 金标条目就是从这批语料长出来的 ⇒ `distanceScore = 1.000` 里有多少是泛化、多少是"回自家仓库查表"，
// 只能靠 `cfg.forceGeneralPath` 这条测量臂分开量（`src/policy.js` 注释原文："= 真实用户仓的处境；缺省不出现 ⇒ 生产不变"）。
//
// 这条差是本项目最要紧的一个数，但它此前**只躺在 `transfer/models/micro-gap-map.json` 里**：
// 没有任何套件或 CI 步骤读它 ⇒ 谁改了指标口径、谁把 1.000 抄进 README 抄错位数，都不会有人发现。
// 本套件不做判据、不动闸：它只做三件事 —— ① 账本结构还在；② 文档引用的数与账本逐位一致；③ 负例证明 ② 会咬人。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAP = path.join('transfer', 'models', 'micro-gap-map.json')
const LEDGER = path.join('transfer', 'models', 'cfb-micro-final-test-ledger.json')
const REPORT = path.join('transfer', 'models', 'cfb-micro-97m-report.json')
const WEIGHTS = path.join('transfer', 'models', 'v5-micro-weights.json')

let pass = 0, fail = 0, skip = 0
const test = (name, fn) => {
  try {
    const r = fn()
    if (r === 'skip') { skip++; console.log('SKIP ' + name); return }
    pass++; console.log('PASS ' + name)
  } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.message || e)) }
}
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
const rounds = (x, n = 4) => Number(Number(x).toFixed(n))

/** 文档 ↔ 账本 的一致性判定本体；03（正例）与 09（负例）跑的是同一个函数，不另写一份。 */
function assertGapMatchesReadme(gapObj, readmeText) {
  const q = gapNumbersFromReadme(readmeText)
  assert.equal(q.arch, 1, 'README 写的原型臂不是 1.000')
  assert.equal(q.gen, rounds(gapObj.aggregateAfterW1.generalProduction.distanceScore), 'README 的 generalProduction 与 aggregateAfterW1 不符')
  assert.equal(q.before, rounds(gapObj.aggregateBeforeW1.generalProduction.distanceScore), 'README 的 "W1 前" 与 aggregateBeforeW1 不符')
  assert.equal(q.after11, rounds(gapObj.aggregateAfterW1_1.generalProduction.distanceScore), 'README 的 "W1.1 后" 与 aggregateAfterW1_1 不符')
}

/** README §5 引用 gap map 的四个数；抽不出来直接算失败（文档改写法 ⇒ 必须同时改这里，别想悄悄漂移）。 */
function gapNumbersFromReadme(readmeText) {
  const line = readmeText.split('\n').find((l) => l.includes('micro-gap-map.json') && l.includes('generalProduction'))
  assert.ok(line, 'README §5 找不到引用 gap map 的那一行（改写文档时必须同步本套件）')
  const arch = line.match(/archetypeProduction\.distanceScore\s*=\s*`?([\d.]+)/)
  const gen = line.match(/generalProduction\s*=\s*`?([\d.]+)/)
  const before = line.match(/W1 前\s*`?([\d.]+)/)
  const after11 = line.match(/W1\.1 后\s*`?([\d.]+)/)
  assert.ok(arch && gen && before && after11, 'README 里 gap map 的四个数没写全（实得：' + JSON.stringify({ arch: arch && arch[1], gen: gen && gen[1], before: before && before[1], after11: after11 && after11[1] }) + '）')
  return { arch: Number(arch[1]), gen: Number(gen[1]), before: Number(before[1]), after11: Number(after11[1]) }
}

try {
  const gap = readJson(ROOT, GAP)
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

  test('01 gap map 三臂齐备（beforeW1 / afterW1 / afterW1.1）且逐臂都有四向分栏', () => {
    for (const key of ['aggregateBeforeW1', 'aggregateAfterW1', 'aggregateAfterW1_1']) {
      const arm = gap[key]
      assert.ok(arm, '缺 ' + key)
      for (const side of ['archetypeProduction', 'generalProduction', 'archetypeCandidate', 'generalCandidate']) {
        assert.ok(Number.isFinite(arm[side]?.distanceScore), `${key}.${side}.distanceScore 不在`)
      }
      assert.ok(Number.isFinite(arm.items) && arm.items > 0, key + ' 的 items 必须是个正数（样本量不许被省掉）')
    }
    assert.equal(gap.schema, 'cfb.micro-gap-map/1', '口径版本变了 ⇒ 本套件的断言要重读一遍')
  })
  test('02 原型臂仍是满分参照（1.000），兜底臂显著低于它 ⇒ 1.000 不能当产品价值读', () => {
    const a = gap.aggregateAfterW1
    assert.equal(rounds(a.archetypeProduction.distanceScore), 1, 'archetypeProduction 不再是 1.000：' + a.archetypeProduction.distanceScore)
    const gapSize = a.archetypeProduction.distanceScore - a.generalProduction.distanceScore
    assert.ok(gapSize >= 0.5, `原型臂与兜底臂的差被压缩到 ${gapSize.toFixed(4)} < 0.5 ⇒ 要么真补上了（改文档 + 改本断言），要么口径被动过`)
    assert.ok(a.generalProduction.distanceScore < 0.5, 'generalProduction 越过 0.5 ⇒ 必须有新的真机账本，不能只改判分公式')
  })
  test('03 README §5 引用的四个数与账本逐位一致', () => {
    assertGapMatchesReadme(gap, readme)
  })
  test('04 源码里恰好 5 个原型模板分支，第 6 个出口必须是兜底', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'compile-v5-local.js'), 'utf8')
    const arms = [...new Set([...src.matchAll(/g\.archetype === '([a-z0-9-]+)'/g)].map((m) => m[1]))]
    assert.equal(arms.length, 5, '原型模板数量变成 ' + arms.length + '：' + arms.join(',') + ' ⇒ `src/policy.js` 注释与 README 里的"5 个手写原型模板"同时过期')
    assert.ok(/else\s+draft = compileGeneralDiscourseGraph\(/.test(src), '兜底路径不再是 else 出口 ⇒ 判定顺序被动过')
    assert.ok(arms.every((a) => src.includes('!forceGeneralPath && g.archetype === \'' + a + '\'')), '有模板分支没被 forceGeneralPath 包住 ⇒ 测量臂漏了一个，读数会偏高')
  })
  test('05 forceGeneralPath：默认关、白名单登记、注释说明它是测量臂', () => {
    const policy = fs.readFileSync(path.join(ROOT, 'src', 'policy.js'), 'utf8')
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8')
    assert.match(policy, /forceGeneralPath:\s*Object\.freeze\(\{\s*bool:\s*true\s*\}\)/, 'forceGeneralPath 不再在可训练白名单里 ⇒ 闭环测不到这条臂')
    assert.match(policy, /测量臂/, 'policy.js 里"这是测量臂、不是产品开关"的说明被删了')
    assert.ok(!/forceGeneralPath\s*[:=]\s*true/.test(cfg), 'config.js 默认值里出现 forceGeneralPath: true ⇒ 生产行为被改了')
  })
  test('06 一次性盲测账本：1 条、终态、且 README 引的分数就是账本里的', () => {
    const ledger = readJson(ROOT, LEDGER)
    assert.equal(ledger.schema, 'cfb.micro-final-test-ledger/1')
    assert.equal(ledger.entries.length, 1, '盲测条目数不是 1 ⇒ 要么有人重跑了（禁止），要么有新数据集被登记成盲测')
    const e = ledger.entries[0]
    assert.match(e.status, /below-90-percent-gates$/, '盲测结论不是失败终态：' + e.status)
    assert.equal(e.unitPairs, 30); assert.equal(e.draftPairs, 8)
    assert.equal(rounds(e.unitPairAccuracy, 4), 0.8333, 'README 引用的 unit 分数与账本不符')
    assert.equal(e.draftPairAccuracy, 0, 'README 引用的 draft 分数与账本不符')
    for (const k of ['datasetSha256', 'candidateWeightsDigest', 'evaluatedAt']) assert.ok(typeof e[k] === 'string' && e[k].length > 8, k + ' 缺失 ⇒ 无法证明评的是哪份数据/哪份权重')
    assert.ok(readme.includes('evaluated-below-90-percent-gates'), 'README §5 必须原样写出这个终态（不许写成"待评估"）')
    assert.ok(/`case-fold-collision`/.test(readme), 'README 没点名这条盲测 family ⇒ 读者无法复核')
  })
  test('07 微模型仍未采纳：accepted=false / promoted=false，且唯一未过的门是"新独立家族盲测"', () => {
    const rep = readJson(ROOT, REPORT)
    assert.equal(rep.accepted, false, 'accepted 变了 ⇒ README §5 与 HANDOFF 的现状必须同批改')
    assert.equal(rep.promoted, false, 'promoted=true 意味着生产权重被覆盖过 ⇒ 与本仓库铁律冲突，先查清再说')
    const falses = Object.entries(rep.gates || {}).filter(([, v]) => v === false).map(([k]) => k)
    assert.deepEqual(falses, ['freshIndependentNewFamilyTestPassed'], '未过的门不再是这一条：' + falses.join(','))
    assert.equal(rep.dataset?.freshIndependentNewFamilyTest?.status, 'blocked-no-new-independent-family', '阻塞原因文字变了 ⇒ README 的引用要跟着改')
    assert.ok(/blocked-no-new-independent-family/.test(readme), 'README 没引用这个阻塞状态')
  })
  test('08 生产权重在清单里且哈希一致（不改它，但要能证明没被改）', () => {
    const list = fs.readFileSync(path.join(ROOT, 'MANIFEST.sha256'), 'utf8')
    // MANIFEST 行路径一律正斜杠,与 path.join 的 win32 反斜杠无关;统一转正斜杠再匹配
    const wantRel = WEIGHTS.split(path.sep).join('/')
    const line = list.split('\n').find((l) => l.trim().endsWith(wantRel))
    assert.ok(line, '生产权重不在 MANIFEST 里 ⇒ 它一旦被 .gitignore 吞掉，CI 检出会静缺')
    const want = line.trim().split(/\s+/)[0]
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, WEIGHTS))).digest('hex')
    assert.equal(got, want, '生产权重与清单不一致 ⇒ 立即停手核查（本套件不修，只报警）')
  })
  test('09 负例：账本被改一个数而 README 没跟着改 ⇒ 一致性断言必须炸', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-gap-'))
    try {
      fs.mkdirSync(path.join(dir, 'transfer', 'models'), { recursive: true })
      const tampered = JSON.parse(JSON.stringify(gap))
      tampered.aggregateAfterW1.generalProduction.distanceScore = 0.9999
      fs.writeFileSync(path.join(dir, GAP), JSON.stringify(tampered))
      let threw = null
      try {
        assertGapMatchesReadme(readJson(dir, GAP), readme)   // 同 03 的判定，喂进被篡改的账本
      } catch (e) { threw = String(e.message || e) }
      assert.ok(threw && /generalProduction/.test(threw), '篡改账本后没被发现 ⇒ 03 是摆设（实得：' + threw + '）')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('10 负例：README 里 gap map 的引用被删 ⇒ 抽取器必须拒绝而不是默认通过', () => {
    let threw = null
    try { gapNumbersFromReadme('# README\n- 一切正常（没有任何引用）\n') } catch (e) { threw = String(e.message || e) }
    assert.ok(threw && /找不到引用 gap map/.test(threw), '文档不再引用该数时应报错提示，而不是静默通过（实得：' + threw + '）')
  })
} finally {
  console.log('\n=== micro-general-arm selftest: ' + pass + ' pass / ' + fail + ' fail' + (skip ? ' / 跳过 ' + skip : '') + ' ===')
  console.log('PASS=' + pass + ' FAIL=' + fail + ' SKIP=' + skip)
  process.exitCode = fail ? 1 : 0
}
