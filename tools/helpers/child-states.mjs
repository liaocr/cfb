// tools/helpers/child-states.mjs —— 子状态（v4.3）：全轨迹的每个「修好之前」的轮次状态都是一个可续跑的 L2 起点。
//   状态 = {family（父场景）, startRound, messages 前缀（assistant 文字 + 工具结果，不含思维链）, replay（第 1..k−1 轮的调用，执行器确定性重放得到仓库状态）}
//   诚实边界：① 历史 transcript 没存思维链 ⇒ 子状态只能做 L2 续跑起点（续跑时模型重新产生思维链、各臂再压缩），不能做 v9 的 L1 冻结题；
//            traj-run --store-text 之后的新轨迹存了 reasoning / stored，子状态才同时是压缩任务与飞轮材料。
//            ② 同一场景派生的状态共享仓库与故障 ⇒ 是同一「家族」：它们增加家族内功效（配对数），不增加家族数；留出的泛化保证只看家族数。
//   价值估计（Math-Shepherd 式）：从同一状态多次续跑的修好率 / 到修好轮数 = 该状态在该压缩策略下的蒙特卡洛价值 V；两臂在同一分叉点的 V 之差才是「压缩稿好不好」的原则性定义，
//            六旗标只是预测 V 的特征（见 ruler.fitFlagWeights）。
import { eValueWins } from './ruler.mjs'

const parseArgs = (a) => { if (a && typeof a === 'object') return { ok: true, args: a }; try { return { ok: true, args: JSON.parse(a) } } catch { return { ok: false, args: { command: String(a || '') } } } }   // 解析失败 = transcript 里的参数被截断（旧行 400 字上限）⇒ 不可重放
/** 从一条 traj-run 结果行派生子状态（只取修好之前、且至少完成 1 轮之后的状态）。 */
export function childStates(row, { split = null, maxPerRow = 4, onlyReplayable = true } = {}) {
  if (row.error || !Array.isArray(row.transcript) || row.transcript.length < 2) return []
  const fixAt = Number.isInteger(row.fixedAtRound) ? row.fixedAtRound : Infinity
  const out = []
  for (let k = 2; k <= row.transcript.length && out.length < maxPerRow; k++) {
    if (k > fixAt) break   // 修好之后的状态不是题
    const prefix = row.transcript.slice(0, k - 1)
    if (prefix.some((t) => !t.calls?.length || !t.results?.length)) break   // 没有工具交互的轮无法重放
    const parsed = prefix.map((t) => (t.calls || []).map((c) => ({ name: c.name, ...parseArgs(c.args) })))
    const replayable = parsed.every((cs) => cs.every((c) => c.ok && (c.name !== 'edit_file' || (c.args && c.args.path))))
    if (!replayable && onlyReplayable) continue
    const messages = prefix.flatMap((t, i) => [{ role: 'assistant', content: t.text || '', calls: parsed[i].map((c) => ({ name: c.name, args: c.args })) }, { role: 'user', content: (t.results || []).map((r, j) => `[tool: ${(t.calls || [])[j]?.name || 'tool'} 结果]\n${r}`).join('\n\n') }])
    out.push({ schema: 'cfb.child-state/1', id: `${row.task}@r${k}#${row.variant}#${row.sample ?? 0}${row.dir ? '#' + row.dir : ''}`, family: row.task, parentVariant: row.variant, parentSample: row.sample ?? 0, startRound: k, split: split?.[row.task] || row.split || null, replayable, replay: parsed.flat().map((c) => ({ name: c.name, args: c.args })), messages, parentFixedAtRound: Number.isFinite(fixAt) ? fixAt : null, parentRounds: row.rounds ?? null })
  }
  return out
}
/** 家族 / 状态盘点：家族数才是留出保证的分母。 */
export function familyCensus(states, { holdoutFamilies = [] } = {}) {
  const fam = {}
  for (const s of states) { const f = (fam[s.family] = fam[s.family] || { states: 0, split: s.split || null }); f.states++ }
  const families = Object.keys(fam)
  return { families: families.length, states: states.length, holdoutFamilies: families.filter((f) => holdoutFamilies.includes(f) || fam[f].split === 'holdout').length, byFamily: fam, note: '状态扩的是家族内配对数（功效），不是家族数（泛化）；留出家族 < 4 之前不按分搜索' }
}
/** 蒙特卡洛状态价值：同一状态、同一臂的多次续跑 → 修好率 / 平均到修好轮数（相对 startRound 的增量）/ n；两臂在同一状态的差 + e 值。 */
export function valueTable(rows) {
  const by = {}
  for (const r of rows) {
    if (r.error || !r.fromState) continue
    const key = r.fromState; const arm = r.variant
    const v = ((by[key] = by[key] || {})[arm] = by[key][arm] || { n: 0, solved: 0, roundsToFix: [] })
    v.n++; if (r.fixed || Number.isInteger(r.fixedAtRound)) { v.solved++; if (Number.isInteger(r.fixedAtRound)) v.roundsToFix.push(r.fixedAtRound - ((r.startRound || 1) - 1)) }
  }
  const table = []
  for (const [state, arms] of Object.entries(by)) {
    const row = { state, arms: Object.fromEntries(Object.entries(arms).map(([a, v]) => [a, { n: v.n, solveRate: +(v.solved / v.n).toFixed(3), meanRoundsToFix: v.roundsToFix.length ? +(v.roundsToFix.reduce((x, y) => x + y, 0) / v.roundsToFix.length).toFixed(2) : null }])) }
    const names = Object.keys(arms)
    if (names.length === 2) { const [a, b] = names; row.delta = { [`${b}−${a}`]: +(row.arms[b].solveRate - row.arms[a].solveRate).toFixed(3) } }
    table.push(row)
  }
  // 跨状态配对（同一状态两臂谁的价值高）→ 胜负 → e 值
  let w = 0, l = 0
  for (const row of table) { const names = Object.keys(row.arms); if (names.length !== 2) continue; const [a, b] = names; const va = row.arms[a], vb = row.arms[b]; const ka = va.solveRate * 100 - (va.meanRoundsToFix || 0), kb = vb.solveRate * 100 - (vb.meanRoundsToFix || 0); if (kb > ka) w++; else if (kb < ka) l++ }
  return { states: table.length, table, pairs: { win: w, loss: l }, e: +eValueWins(w, l).toFixed(3), eReject: +eValueWins(l, w).toFixed(3) }
}
