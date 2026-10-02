// tools/helpers/traj-proxy.mjs —— 从全轨迹记录（tools/traj-run.mjs 的行）机械地算每轮的「执行器代理分」，六旗标与 v9 的 L1 同族：
//   next     本轮有至少一个推进动作（非重复、非失败的调用）
//   avoid    本轮没有被执行器拒绝 / 失败的调用（越界、白名单外、old_text 没找到）
//   falseDone 本轮文字宣称已修复，而此时仓库状态尚未修好
//   bump     本轮没有任何调用、却把问题抛回给用户（问号 / 征询）而任务未完成
//   reEdit   本轮编辑了前几轮已经编辑过的文件
//   repeat   本轮 bash 命令与之前某轮逐字相同且中间没有新编辑
//   score = next + avoid − falseDone − bump − reEdit − repeat（与 experiment.structuralScore 同式，range [−4, 2]）
// 用途：① 回溯效度——已付费的 29 条历史轨迹立刻变成 (proxy, outcome) 配对，效度账本从 n=0 变成有数（零 API）；
//      ② traj-run 在线逐轮记 proxy，和 L2 结局同一条轨迹产出 ⇒ 一次付费同时喂 L1 / L2 / 效度 / 飞轮 / 子状态任务。
// 口径说明：v9 的 L1 由任务规格（d1/d2）判「下一步对不对」，这里由执行器状态判；两者是同一构念（结构性下一步质量）的两个估计量，账本里分 source 记。
import { claimOf } from '../effect-mr.mjs'
import { auc, rulerValidity } from './ruler.mjs'

const normCmd = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { return JSON.parse(a) } catch { return { command: String(a || '') } } }
const FAILED_RE = /^(?:edit_file 失败|read_file 失败|未知工具|bash: 该沙箱不支持|拒绝|不允许|路径越界)/
/** 逐轮旗标。rows 的 transcript[{round, text, calls[{name,args}], results[]}] 为输入；fixedAtRound 给出修好的轮。 */
export function stepFlags(row) {
  const steps = []
  const seen = new Map(); const edited = new Set(); let lastEditRound = 0
  for (const t of row.transcript || []) {
    const calls = t.calls || [], results = t.results || []
    const fixedBefore = Number.isInteger(row.fixedAtRound) && row.fixedAtRound < t.round
    const fixedHere = Number.isInteger(row.fixedAtRound) && row.fixedAtRound === t.round
    let next = 0, avoid = 1, reEdit = 0, repeat = 0
    calls.forEach((c, i) => {
      const a = parseArgs(c.args); const out = String(results[i] ?? '')
      const failed = FAILED_RE.test(out)
      if (failed) avoid = 0
      if (c.name === 'bash') { const k = normCmd(a.command); if (seen.has(k) && lastEditRound <= seen.get(k)) repeat = 1; else if (!failed) next = 1; seen.set(k, t.round) }
      else if (c.name === 'edit_file') { const p = String(a.path || ''); if (edited.has(p)) reEdit = 1; if (!failed) { next = 1; edited.add(p); lastEditRound = t.round } }
      else if (!failed) next = 1
    })
    const claim = claimOf(t.text || '')
    const falseDone = claim === 'fixed' && !fixedBefore && !fixedHere ? 1 : 0
    const bump = !calls.length && !fixedBefore && !fixedHere && /[?？]/.test(t.text || '') ? 1 : 0
    const flags = { next, avoid, falseDone, bump, reEdit, repeat }
    steps.push({ round: t.round, flags, score: next + avoid - falseDone - bump - reEdit - repeat, fixedHere, fixedBefore })
  }
  return steps
}
/**
 * (proxy, outcome) 配对。level='trajectory'（主口径）：每条轨迹一对，proxy = 修好之前各轮（含修好那轮之前、不含修好轮）的均分；
 * level='step'：每个修好前的轮一对（簇 = 轨迹，自助时按簇重抽）。round-1 没有压缩稿，但同样反映步质量，默认保留（fromRound=1）。
 */
export function proxyPairs(rows, { level = 'trajectory', fromRound = 1 } = {}) {
  const out = []
  for (const row of rows) {
    if (row.error) continue
    const steps = stepFlags(row).filter((s) => s.round >= fromRound && !s.fixedHere && !s.fixedBefore)
    if (!steps.length) continue
    const solved = !!(row.fixed || Number.isInteger(row.fixedAtRound))
    const id = `${row.dir || ''}|${row.task}|${row.variant}|${row.sample ?? 0}`
    if (level === 'step') for (const s of steps) out.push({ cluster: id, task: row.task, arm: row.variant, round: s.round, proxy: s.score, outcome: solved ? 1 : 0, roundsToFix: solved ? row.fixedAtRound : null })
    else out.push({ cluster: id, task: row.task, arm: row.variant, rounds: steps.length, proxy: +(steps.reduce((a, s) => a + s.score, 0) / steps.length).toFixed(3), outcome: solved ? 1 : 0, roundsToFix: solved ? row.fixedAtRound : null })
  }
  return out
}
/** 簇自助（按轨迹重抽）版的效度：避免未修好的长轨迹用多轮灌水。 */
export function clusteredValidity(pairs, { minPairs = 12, minPerClass = 5, boots = 1000, seed = 11 } = {}) {
  const clusters = [...new Set(pairs.map((p) => p.cluster))]
  const point = auc(pairs), pos = pairs.filter((p) => p.outcome === 1).length
  if (pairs.length < minPairs || point == null || Math.min(pos, pairs.length - pos) < minPerClass) return { ...rulerValidity(pairs, { minPairs, minPerClass }), clusters: clusters.length }
  let s = seed >>> 0; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const byC = Object.fromEntries(clusters.map((c) => [c, pairs.filter((p) => p.cluster === c)]))
  const vals = []
  for (let b = 0; b < boots; b++) { const smp = []; for (let i = 0; i < clusters.length; i++) smp.push(...byC[clusters[Math.floor(rnd() * clusters.length)]]); const a = auc(smp); if (a != null) vals.push(a) }
  vals.sort((a, b) => a - b)
  const lo = vals[Math.floor(vals.length * 0.025)], hi = vals[Math.floor(vals.length * 0.975)]
  const status = lo >= 0.6 ? 'valid' : point <= 0.55 ? 'invalid' : 'suspect'
  return { n: pairs.length, pos, neg: pairs.length - pos, clusters: clusters.length, auc: +point.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)], status, why: status === 'valid' ? '执行器代理分与端到端修好同向，簇自助 CI 下界 ≥ 0.6' : status === 'invalid' ? '执行器代理分与修好无关' : '方向存疑（簇自助 CI 跨 0.6）' }
}
/** 回溯效度总表：轨迹级（主）+ 步级（簇自助）+ 只看第 2 轮（最早受压缩稿影响的一步）。 */
export function retroValidity(rows) {
  const traj = proxyPairs(rows, { level: 'trajectory' }), step = proxyPairs(rows, { level: 'step' }), r2 = proxyPairs(rows, { level: 'step', fromRound: 2 }).filter((p) => p.round === 2)
  const flagRates = (() => { const all = rows.filter((r) => !r.error).flatMap((r) => stepFlags(r)); const k = ['next', 'avoid', 'falseDone', 'bump', 'reEdit', 'repeat']; return Object.fromEntries(k.map((x) => [x, all.length ? +(all.filter((s) => s.flags[x] === 1).length / all.length).toFixed(3) : null])) })()
  return { trajectory: { ...rulerValidity(traj), pairs: traj }, step: clusteredValidity(step), round2: { ...rulerValidity(r2, { minPairs: 8 }), n: r2.length }, flagRates, steps: rows.filter((r) => !r.error).reduce((a, r) => a + (r.transcript || []).length, 0) }
}
