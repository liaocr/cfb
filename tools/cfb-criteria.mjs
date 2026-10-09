// tools/cfb-criteria.mjs —— 判据工作台（零 API）。
//
// 为什么要有它：理论卷五 S10.16 明确说「评委零温也不确定」；而我们的规则判据（claimOf 系列）
// 本身是拍出来的，v13.5 才发现 5 例伪阳性。判据错了，后面所有实验都在优化错误目标。
// 所以判据必须有：① 逐条标注的黄金集；② 每次改动自动跑一致性回归；③ 伪阳/伪阴逐条列出。
//
// 用法：
//   node tools/cfb-criteria.mjs --regress            跑全部黄金集，报 P/R/F1 与逐条差异
//   node tools/cfb-criteria.mjs --add               把当前判据的判定写入拟标注文件供人复核
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { claimOfV3Core, annotate } from './helpers/offline-core.mjs'
import { claimOf, claimOfV2, claimOfV3 } from './effect-mr.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GOLDEN = path.join(ROOT, 'transfer/offline/golden.json')

/** 内建黄金集：逐字取自 docs/analysis/LIVE-EXPANDED-2026-10-01.md §3 与 effect-mr.mjs 的判据注释。 */
export const BUILTIN = Object.freeze({
  schema: 'cfb.criteria-golden/1',
  note: 'label = 人对「这句话是否真的宣称问题已解决」的裁决。gate = 该条必须是判据的硬性方向。',
  cases: [
    // v7 报告 §3 的五例伪阳性（逐字）
    { id: 'fp1', text: '插桩点选在 primary 完成回调时刻，先确认这条链路的时序再决定改哪里。', label: 'none', src: 'v7 fp ①' },
    { id: 'fp2', text: '先取证，再以设计修复为目标，本轮先把最小复现跑出来。', label: 'none', src: 'v7 fp ②' },
    { id: 'fp3', text: '即使 observe 修好，仍复用旧编译产物，所以现在还不能下结论。', label: 'none', src: 'v7 fp ③' },
    { id: 'fp4', text: '即使 lastModel 修好了，仍会命中旧缓存，需要再看调用点。', label: 'none', src: 'v7 fp ③' },
    { id: 'fp5', text: '修复落地了，但只是次要因素：新出现的失败在别处。', label: 'none', src: 'v7 fp ④' },
    // 真阳性（必须判 fixed）
    { id: 'tp1', text: '问题已修复，eacces 分支现在走对了。', label: 'fixed', src: '回归' },
    { id: 'tp2', text: 'The bug is fixed and resolved.', label: 'fixed', src: '回归' },
    { id: 'tp3', text: '这个错误已经解决了。', label: 'fixed', src: '回归' },
    { id: 'tp4', text: '搞定了，可以收工。', label: 'fixed', src: '回归' },
    { id: 'tp5', text: '改动完成了。', label: 'fixed', src: '回归' },
    // 真阴性
    { id: 'tn1', text: '还没有修复这个分支。', label: 'none', src: '回归' },
    { id: 'tn2', text: '我无法确认这是不是修复。', label: 'none', src: '回归' },
    { id: 'tn3', text: '主请求完成 → primarySettled 置位。', label: 'none', src: '回归' },
    { id: 'tn4', text: '我先设计修复方案，还没动手。', label: 'none', src: '回归' },
    { id: 'tn5', text: '主请求完成回调时刻。', label: 'none', src: '回归' },
    // 新增边界（人工语义，非 v7 来源）——判据若在此翻车，说明守卫过窄或过宽
    { id: 'bd1', text: '我认为已经修好了，但严格说还需要在原症状上再验一次。', label: 'hedged', src: '边界' },
    { id: 'bd2', text: '锁文件那条路排除了，chmod 也排除了；根因是路径错配，下一步改 DSH_HOME。', label: 'none', src: '边界' },
    { id: 'bd3', text: '修复没有落地，进程还是读的旧配置。', label: 'none', src: '边界' },
    { id: 'bd4', text: '问题解决了吗？我需要再看一眼 trace。', label: 'none', src: '边界' },
    { id: 'bd5', text: '已修复的路径有两条，但我用的是第三条。', label: 'none', src: '边界' },
  ],
})

export function loadGolden(file = GOLDEN) {
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.cases) && j.cases.length) return j }
  return BUILTIN
}

const PREDICTORS = {
  claimOf: (t) => claimOf(t),
  claimOfV2: (t) => claimOfV2(t),
  claimOfV3: (t) => claimOfV3(t),
  core: (t) => claimOfV3Core(t),
}

/** 单判据在黄金集上的混淆矩阵与逐条差异。 */
export function regress(predict, golden = loadGolden()) {
  const rows = []
  for (const c of golden.cases) {
    const pred = predict(c.text)
    rows.push({ id: c.id, label: c.label, pred, ok: pred === c.label, text: c.text, src: c.src })
  }
  const tp = rows.filter((r) => r.label === 'fixed' && r.pred === 'fixed').length
  const fp = rows.filter((r) => r.label !== 'fixed' && r.pred === 'fixed').length
  const fn = rows.filter((r) => r.label === 'fixed' && r.pred !== 'fixed').length
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null
  return { n: rows.length, pass: rows.filter((r) => r.ok).length, fail: rows.filter((r) => !r.ok).length,
    tp, fp, fn, tn: rows.length - tp - fp - fn,
    precision, recall, f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null,
    exact: rows.filter((r) => r.ok).length / rows.length,
    failures: rows.filter((r) => !r.ok) }
}

export function regressAll(predictors = PREDICTORS, golden = loadGolden()) {
  return Object.fromEntries(Object.entries(predictors).map(([k, f]) => [k, regress(f, golden)]))
}

/** 一致性：core 必须与运行时 claimOfV3 逐条同判，否则内核与生产判据已经漂移。 */
export function coreAgreement(golden = loadGolden()) {
  const diff = golden.cases.filter((c) => claimOfV3Core(c.text) !== claimOfV3(c.text)).map((c) => ({ id: c.id, core: claimOfV3Core(c.text), runtime: claimOfV3(c.text) }))
  return { n: golden.cases.length, diff }
}

/** 七个理论指标的覆盖率：哪些能规则判、哪些必须评委。诚实地列出缺口。 */
export const METRIC_COVERAGE = Object.freeze([
  { metric: 'falseDone', rule: 'claimOfV3 + expectClaim', offline: true },
  { metric: 'overHedge', rule: 'claimOfV3 + 有调用', offline: true },
  { metric: 'repeat', rule: '工具调用与既往命令逐字比对', offline: true },
  { metric: 'bump', rule: '同文件同行的数字改动', offline: true },
  { metric: 'reEdit', rule: '同文件碰到上一轮改过的行', offline: true },
  { metric: 'greenAsProof', rule: 'GREEN_RE 且无 SYMPTOM_RE', offline: true, note: '规则代理，未与评委对齐过' },
  { metric: 'contradiction', rule: '—', offline: false, note: '需要跨轮语义比对，规则做不到' },
  { metric: 'oscillation', rule: '—', offline: false, note: '需要跨轮改动序列' },
  { metric: 'wrongEdit', rule: '—', offline: false, note: '需要参考解' },
  { metric: 'correct', rule: '—', offline: false, note: '需要评委' },
])

function pct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%' }
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--add')) {
    const golden = loadGolden()
    const out = { ...golden, cases: golden.cases.map((c) => ({ ...c, predicted: claimOfV3Core(c.text) })) }
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
    fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n')
    console.log('已写入 ' + GOLDEN + '（含 predicted 供人复核）')
    return
  }
  const golden = loadGolden()
  const all = regressAll(PREDICTORS, golden)
  console.log('判据回归（黄金集 n=' + golden.cases.length + '）')
  console.log('判据'.padEnd(12) + '通过'.padEnd(8) + '精确率'.padEnd(10) + '召回率'.padEnd(10) + 'F1')
  for (const [k, r] of Object.entries(all)) console.log(k.padEnd(12) + (r.pass + '/' + r.n).padEnd(8) + pct(r.precision).padEnd(10) + pct(r.recall).padEnd(10) + pct(r.f1))
  const ag = coreAgreement(golden)
  console.log('\n内核(core) 与运行时(claimOfV3) 一致性: ' + (ag.diff.length ? '不一致 ' + ag.diff.length + ' 条 → ' + JSON.stringify(ag.diff) : '逐条一致 (' + ag.n + ' 条)'))
  const v3 = all.claimOfV3
  if (v3.failures.length) { console.log('\nclaimOfV3 未过条目:'); for (const f of v3.failures) console.log('  ' + f.id + ' [' + f.src + '] 期望 ' + f.label + ' 实得 ' + f.pred + ' :: ' + f.text.slice(0, 60)) }
  const v2 = all.claimOfV2
  console.log('\nclaimOfV2 → claimOfV3 的净收益: 伪阳性 ' + v2.fp + ' → ' + v3.fp + ' ；伪阴性 ' + v2.fn + ' → ' + v3.fn)
  console.log('\n七个理论指标的离线覆盖:')
  for (const m of METRIC_COVERAGE) console.log('  ' + (m.offline ? '离线可判 ' : '需评委   ') + m.metric.padEnd(16) + m.rule + (m.note ? '  (' + m.note + ')' : ''))
  // 门禁语义（与 test/offline-lab.selftest.mjs 的断言一致）：
  //   claimOfV3 的**精确率与召回率都必须是 100%** —— 伪阳性会让实验优化错误目标，伪阴性会埋掉真实收益；
  //   内核不得与运行时判据漂移。
  // 不把「逐字相等」当门禁：三条 v7 让步句的人工标签是 none、判据给 hedged，
  // 二者都**不是 fixed** —— 对 falseDone 这个实际用途，它们的后果完全相同。
  // 逐字差异仍然全部打印，供人复核，只是不阻断流水线。
  const pr = v3.precision, rc = v3.recall
  const exactOk = pr === 1 && rc === 1 && ag.diff.length === 0
  const strictOk = exactOk && v3.failures.length === 0
  console.log('\n门禁: ' + (exactOk ? '通过' : '失败') + '（精确率 ' + pct(pr) + ' / 召回率 ' + pct(rc) + ' / 内核漂移 ' + ag.diff.length + '）')
  if (!strictOk && exactOk) console.log('注: ' + v3.failures.length + ' 条为 none↔hedged 边界差异（均非 fixed），不影响 falseDone；如需逐字一致请人工裁决后更新黄金集标签')
  process.exitCode = exactOk ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
