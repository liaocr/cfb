// tools/helpers/pareto.mjs —— Pareto 池（GEPA 式候选选择，v4.3）：按题的分向量代替单一擂主的标量；父代按「在多少道题的前沿上」抽样。
//   数据来源零 API：history.hypotheses[*].outcomes 里每道题的 candidate / control 结构分（control = 当时 champion 策略的分）；
//   L2 结局（confirm-N.json）若有则按题覆盖为更高优先级的分。
/** 分矩阵：{policyId: {task: meanScore}}。 */
export function scoreMatrix(history, { championPolicyOf = (h) => h.championPolicy || 'base' } = {}) {
  const acc = {}
  const add = (pid, task, v) => { if (!Number.isFinite(v)) return; const t = ((acc[pid] = acc[pid] || {})[task] = acc[pid][task] || { s: 0, n: 0 }); t.s += v; t.n++ }
  for (const h of Object.values(history?.hypotheses || {})) {
    const cand = h.lever === 'policy' ? h.value : null, ctrl = championPolicyOf(h)
    for (const o of h.outcomes || []) { if (cand) add(cand, o.task, o.candidate); add(ctrl, o.task, o.control) }
  }
  return Object.fromEntries(Object.entries(acc).map(([pid, ts]) => [pid, Object.fromEntries(Object.entries(ts).map(([t, x]) => [t, +(x.s / x.n).toFixed(3)]))]))
}
/** 每道题的前沿成员（并列最高者都算）；返回 {task: [pid…]} 与每个策略的上榜次数。 */
export function paretoFront(matrix) {
  const tasks = [...new Set(Object.values(matrix).flatMap((t) => Object.keys(t)))]
  const byTask = {}; const count = Object.fromEntries(Object.keys(matrix).map((p) => [p, 0]))
  for (const t of tasks) {
    const sc = Object.entries(matrix).filter(([, v]) => v[t] != null).map(([p, v]) => [p, v[t]])
    if (!sc.length) continue
    const best = Math.max(...sc.map(([, v]) => v))
    byTask[t] = sc.filter(([, v]) => v === best).map(([p]) => p); for (const p of byTask[t]) count[p]++
  }
  // 支配：被某个策略在所有共同题上 ≥ 且至少一题 > 的策略不在全局前沿
  const pids = Object.keys(matrix)
  const dominated = new Set()
  for (const a of pids) for (const b of pids) { if (a === b) continue; const common = tasks.filter((t) => matrix[a][t] != null && matrix[b][t] != null); if (common.length < 2) continue; if (common.every((t) => matrix[b][t] >= matrix[a][t]) && common.some((t) => matrix[b][t] > matrix[a][t])) dominated.add(a) }
  return { tasks, byTask, frontCount: count, front: pids.filter((p) => !dominated.has(p) && count[p] > 0), dominated: [...dominated] }
}
/** 父代抽样：概率 ∝ 上榜次数（GEPA §3.3）；seed 固定可复现；没有数据时回退 fallback。 */
export function pickParent(matrix, { seed = 1, fallback = 'base' } = {}) {
  const pf = paretoFront(matrix)
  const pool = pf.front.map((p) => [p, pf.frontCount[p]]).filter(([, c]) => c > 0)
  if (!pool.length) return { parent: fallback, why: '没有前沿数据，回退 ' + fallback, front: pf }
  let s = (seed >>> 0) || 1; s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s ^= s >>> 16; s >>>= 0   // 32 位整数哈希（小种子也均匀）
  const total = pool.reduce((a, [, c]) => a + c, 0); let r = (s / 4294967296) * total
  for (const [p, c] of pool) { r -= c; if (r <= 0) return { parent: p, why: `前沿抽样（上榜 ${c}/${total}）`, front: pf } }
  return { parent: pool[pool.length - 1][0], why: '前沿抽样', front: pf }
}
