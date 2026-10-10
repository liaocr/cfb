#!/usr/bin/env node
// tools/screen-raw-mine.mjs —— raw 矿花钱前的资格筛（$0、本地、确定性）
//
// 它做什么、不做什么（这一节是这个工具存在的全部意义）：
//   做：从 10558 行 census 里去掉重复、去掉根本不可能产出好稿的输入、按仓库分层排好序，
//       给出一份**可以直接送去压缩**的清单，外加 token 体量与花费的量级。
//   不做：**它不判断稿子好坏。** 那是 tools/gen-ruler.mjs 的 judge() 的事，而 judge()
//       需要一份 draft —— draft 是要花钱的。所以这个筛子只说「值不值得去试」。
//
// 两个刻意的设计决定：
//   1) 去重按**内容**（(raw,ctx) 的 sha256），不按 unitId。实测同一个 unitId 会出现
//      多行且 raw 各不相同（266 组），按 unitId 去重会**静默丢掉 266 份不同的原文**。
//   2) 默认**全部保留**过检单元，不按 teachScore 砍。teachScore 的权重没经过任何真实
//      压缩结果校准，拿它丢掉 1600 条样本是拿一个没根据的排序器换真金白银的数据。
//      清单按「仓库轮转」排序 —— 想截断到任意 N，多样性都还在。
//
// 用法：
//   node tools/screen-raw-mine.mjs [--n 3000] [--out shortlist.jsonl] [--report screen.json]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { preflight, splitSentences, maskQuotes } from './gen-ruler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CENSUS = 'transfer/models/micro-generator-v4flash-scenarios'
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** 推理散文占 raw 的比例 —— 用来区分「在思考」和「在抄日志」。 */
function proseRatio(raw) {
  const sents = splitSentences(maskQuotes(raw))
  if (!sents.length) return 0
  return +(sents.filter((s) => /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(s) && !/^\s*\[/.test(s)).length / sents.length).toFixed(3)
}

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const outFile = arg('--out', path.join(ROOT, '.cfb-offline', 'ruler', 'raw-mine-shortlist.jsonl'))
const reportFile = arg('--report', path.join(ROOT, '.cfb-offline', 'ruler', 'raw-mine-screen.json'))

const t0 = Date.now()
const dir = path.join(ROOT, CENSUS)
const files = fs.readdirSync(dir).filter((f) => /^birth-units-census-batch\d+\.jsonl\.gz$/.test(f)).sort()
const rows = []
for (const f of files) {
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(dir, f)))
  for (const line of buf.toString('utf8').split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)) } catch {} }
}
const rep = { schema: 'cfb.raw-mine-screen/1', at: new Date().toISOString(), inputs: files, nRawRows: rows.length }

// ── 阶段 1：按**内容**去重
const byContent = new Map()
for (const r of rows) {
  const k = sha((r.raw || '') + '\u0000' + (r.ctx || ''))
  if (!byContent.has(k)) byContent.set(k, r)
}
rep.dedup = {
  rows: rows.length,
  uniqueUnitId: new Set(rows.map((r) => r.unitId)).size,
  uniqueContent: byContent.size,
  droppedByContent: rows.length - byContent.size,
  // 按 unitId 去重会丢掉多少份**不同的原文** —— 这是为什么不能用 unitId
  unitIdGroupsWithDifferentRaw: (() => {
    const m = new Map()
    for (const r of rows) { if (!m.has(r.unitId)) m.set(r.unitId, new Set()); m.get(r.unitId).add(sha(r.raw || '')) }
    let n = 0
    for (const [, s] of m) if (s.size > 1) n++
    return n
  })(),
}

// ── 阶段 2：每个 trajectory 只留一个单元。
// 同一个 trajectory 的不同 birthStep，raw 是彼此的嵌套前缀 —— 同一段思维的不同截断，
// 全收进训练集等于给同一个样本加权重。取「raw 长度最接近全体中位数」的那个：
// 确定性，且不偏向最长的（最长的那批往往只是把更多工具输出抄了进来）。
const byTraj = new Map()
for (const r of byContent.values()) {
  const t = (r.source || {}).trajectoryId || r.unitId
  if (!byTraj.has(t)) byTraj.set(t, [])
  byTraj.get(t).push(r)
}
const lensAll = [...byContent.values()].map((r) => r.rawChars).sort((a, b) => a - b)
const medianLen = lensAll[Math.floor(lensAll.length / 2)] || 0
const reps = []
for (const [, g] of byTraj) {
  g.sort((a, b) => Math.abs(a.rawChars - medianLen) - Math.abs(b.rawChars - medianLen) || String(a.unitId).localeCompare(String(b.unitId)))
  reps.push(g[0])
}
rep.dedup.trajectories = byTraj.size
rep.dedup.afterOnePerTrajectory = reps.length
rep.dedup.medianRawChars = medianLen

// ── 阶段 3：预检（尺子里不需要稿子的那部分门）
const pass = []
const reasonCount = {}
for (const r of reps) {
  const pf = preflight({ raw: r.raw, ctx: r.ctx })
  for (const x of pf.reasons) reasonCount[x] = (reasonCount[x] || 0) + 1
  if (!pf.ok) continue
  const sig = r.offlineSignals || {}
  const ids = Array.isArray(sig.identifiersInRaw) ? sig.identifiersInRaw : []
  const verdicts = Array.isArray(sig.verdictLinesInRaw) ? sig.verdictLinesInRaw : []
  const pr = proseRatio(r.raw)
  // 教学价值分（**只在排序时用，不参与任何硬判定**；权重未经真读数校准，见 notes.unvalidated）
  const teach =
    0.30 * Math.min(1, ids.length / 12) +
    0.25 * (verdicts.length > 0 ? 1 : 0) +
    0.25 * Math.min(1, pr / 0.6) +
    0.20 * Math.min(1, pf.signals.anchors / 15)
  pass.push({
    unitId: r.unitId, repository: (r.source || {}).repository, license: (r.source || {}).repositoryLicense,
    trajectoryId: (r.source || {}).trajectoryId, instanceId: (r.source || {}).instanceId, birthStep: r.birthStep,
    rawChars: r.rawChars, ctxChars: r.ctxChars, identifiers: ids.length, verdicts: verdicts.length,
    proseRatio: pr, anchors: pf.signals.anchors, fenceRatio: pf.signals.fenceRatio, toolMarkers: pf.signals.toolMarkers,
    teachScore: +teach.toFixed(4), raw: r.raw, ctx: r.ctx,
  })
}
const q = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? { min: a[0], q25: a[Math.floor(a.length * .25)], med: a[Math.floor(a.length * .5)], q75: a[Math.floor(a.length * .75)], max: a[a.length - 1] } : {} }
rep.preflight = {
  checked: reps.length, passed: pass.length, rejected: reps.length - pass.length, reasons: reasonCount,
  // 为什么预检几乎不拦：把这个语料的**实测分布**摆出来，而不是含糊地说「质量高」。
  // 阈值不咬不是阈值太松，是语料本来就整段落在带内。
  measured: { rawChars: q(reps.map((r) => r.rawChars)), identifiers: q(reps.map((r) => ((r.offlineSignals || {}).identifiersInRaw || []).length)), verdicts: q(reps.map((r) => ((r.offlineSignals || {}).verdictLinesInRaw || []).length)) },
}

// ── 阶段 4：按仓库轮转排序（截断到任意 N 都保住多样性）
const byRepo = new Map()
for (const u of pass) { const k = u.repository || '(unknown)'; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(u) }
for (const [, g] of byRepo) g.sort((a, b) => b.teachScore - a.teachScore || String(a.unitId).localeCompare(String(b.unitId)))
const repoKeys = [...byRepo.keys()].sort()
const ordered = []
const cursor = new Map(repoKeys.map((k) => [k, 0]))
for (;;) {
  let advanced = false
  for (const k of repoKeys) {
    const i = cursor.get(k), g = byRepo.get(k)
    if (i < g.length) { ordered.push(g[i]); cursor.set(k, i + 1); advanced = true }
  }
  if (!advanced) break
}
const cap = Number(arg('--n', '0')) || ordered.length
const picked = ordered.slice(0, cap)
const cost = (n) => {
  const sub = ordered.slice(0, n)
  const rawC = sub.reduce((a, b) => a + b.rawChars, 0)
  const rawTok = Math.round(rawC / 3.5)
  // 输出（压缩稿）按经验取 raw 的 15%；这只是量级估算，不是实测。
  const outTok = Math.round(rawTok * 0.15)
  return { n: sub.length, rawChars: rawC, estRawTokens: rawTok, estOutTokens: outTok, estTotalTokens: rawTok + outTok, estMB: +(rawC / 1048576).toFixed(2) }
}
rep.shortlist = {
  orderedTotal: ordered.length, emitted: picked.length,
  repositoriesCovered: new Set(picked.map((p) => p.repository)).size,
  repositoriesAvailable: byRepo.size,
  licenses: picked.reduce((a, b) => { a[b.license] = (a[b.license] || 0) + 1; return a }, {}),
  costAt: [1000, 3000, ordered.length].filter((n, i, a) => n <= ordered.length && a.indexOf(n) === i).map(cost),
}
rep.elapsedMs = Date.now() - t0
rep.notes = {
  whatThisIs: '花钱前的资格筛：只回答「值不值得为这个输入花钱」，不回答「稿子好不好」。后者需要 draft，由 tools/gen-ruler.mjs 的 judge() 判。',
  dedupIsFact: '内容去重与「每个 trajectory 只留一个单元」是硬事实（同轨迹不同 birthStep 的 raw 是嵌套前缀），不依赖任何启发式。',
  unvalidated: 'teachScore 的权重**未经任何真实压缩结果校准**，它只是把「有具体标识符 / 有决断句 / 是散文而非日志」排序。所以默认不拿它砍样本，只拿它排序。第一批付费压缩做完后必须回头校准。',
  singleDistribution: '全部 10558 行来自同一个数据集（nvidia/Open-SWE-Traces v1.1 / openhands）、同一个教师模型（DeepSeek-V4-Flash / reasoningEffort=max）。好处是这正是目标模型的分布；风险是**没有第二种分布**，泛化到别的思维链形态上未测。',
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, picked.map((p) => JSON.stringify(p)).join('\n') + '\n')
fs.writeFileSync(reportFile, JSON.stringify(rep, null, 2) + '\n')

console.log('raw 矿资格筛（' + (rep.elapsedMs / 1000).toFixed(1) + 's，$0）')
console.log('  读入              ' + rep.nRawRows + ' 行 / ' + files.length + ' 个 census 文件')
console.log('  按内容去重        ' + rep.dedup.uniqueContent + '  （丢重复 ' + rep.dedup.droppedByContent + '）')
console.log('  按 unitId 去重会丢 ' + rep.dedup.unitIdGroupsWithDifferentRaw + ' 组**不同的原文** —— 所以不按 unitId 去重')
console.log('  每轨迹留 1 单元    ' + rep.dedup.trajectories + ' trajectories -> ' + rep.dedup.afterOnePerTrajectory + ' 单元（raw 中位数 ' + rep.dedup.medianRawChars + ' 字）')
console.log('  预检              ' + rep.preflight.passed + ' 过 / ' + rep.preflight.rejected + ' 拒')
for (const [k, v] of Object.entries(reasonCount).sort((a, b) => b[1] - a[1])) console.log('                      ' + k.padEnd(28) + ' x' + v)
console.log('  实测分布 rawChars ' + JSON.stringify(rep.preflight.measured.rawChars))
console.log('  仓库覆盖          ' + rep.shortlist.repositoriesCovered + '/' + rep.shortlist.repositoriesAvailable + ' （许可：' + JSON.stringify(rep.shortlist.licenses) + '）')
console.log('  体量与花费量级：')
for (const c of rep.shortlist.costAt) console.log('    N=' + String(c.n).padEnd(6) + ' ' + String(c.estMB).padEnd(7) + 'MB  raw≈' + c.estRawTokens + ' tok  out≈' + c.estOutTokens + ' tok  合计≈' + c.estTotalTokens + ' tok')
console.log('  清单 -> ' + path.relative(ROOT, outFile))
console.log('  报告 -> ' + path.relative(ROOT, reportFile))
