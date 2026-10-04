// tools/helpers/perturb-check.mjs —— 扰动是否「活的」（v4.3，零 API）：把已有真实轨迹的调用原样重放到原仓库与扰动仓库，看模型在修好之前会不会看到不同的东西。
//   这回答的是「扰动在真实 Agent 走的路径上可见吗」（必要条件），不是「题变难了吗」—— 后者只能由模型续跑回答（见 plan-traj --perturb 的小探针）。
//   教训来源：bind=off 在冻结语料上是惰性的（inert）——任何扰动先查惰性，再谈效果。
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { TRAJ_TASKS, materialize } from '../traj-fixtures.mjs'
import { perturbTask, execTool } from '../traj-run.mjs'

const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { return JSON.parse(a) } catch { return null } }
/** 单条轨迹的反事实重放：返回 {divergedAt, beforeFix, mentionsPerturb, call, truncated}。 */
export function replayAgainst(row, { kind = 'decoy', tasks = TRAJ_TASKS, full = false } = {}) {
  const base = tasks.find((t) => t.id === row.task); if (!base || row.error || !Array.isArray(row.transcript)) return null
  const pert = perturbTask(base, kind)
  const added = Object.keys(pert.files).filter((f) => !(f in base.files) || pert.files[f] !== base.files[f])
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-b-'))
  const res = { id: `${row.dir || ''}|${row.task}|${row.variant}|${row.sample ?? 0}`, family: row.task, variant: row.variant, fixedAtRound: Number.isInteger(row.fixedAtRound) ? row.fixedAtRound : null, divergedAt: null, beforeFix: false, mentionsPerturb: false, call: null, searchHits: 0, searchHitAt: null, truncated: false, roundsReplayed: 0 }
  const isSearch = (name, args) => name === 'read_file' ? /README|legacy/.test(String(args.path || '')) : /\b(grep|rg|find|cat|sed -n|head|tail)\b/.test(String(args.command || '')) && !/^\s*(pwd\s*&&\s*)?ls\b[^&|;]*$/.test(String(args.command || ''))
  try {
    materialize(base, a); materialize(pert, b)
    outer: for (const t of row.transcript) {
      if (res.fixedAtRound != null && t.round > res.fixedAtRound) break
      for (const c of t.calls || []) {
        const args = parseArgs(c.args); if (!args) { res.truncated = true; break outer }
        const oa = execTool(base, a, c.name, args), ob = execTool(pert, b, c.name, args)
        if (oa === ob) continue
        const mentions = added.some((f) => ob.includes(path.basename(f))) || /排查时先看/.test(ob)
        if (res.divergedAt == null) { res.divergedAt = t.round; res.beforeFix = res.fixedAtRound == null || t.round <= res.fixedAtRound; res.mentionsPerturb = mentions; res.call = `${c.name} ${String(args.command || args.path || '').slice(0, 60)}` }
        // 比「目录里多了个文件」更强的证据：排查类调用（grep / cat / find / read_file README）的输出里出现了扰动物 ⇒ 它进入了模型的证据链
        if (mentions && isSearch(c.name, args) && (res.fixedAtRound == null || t.round <= res.fixedAtRound)) { res.searchHits++; if (res.searchHitAt == null) res.searchHitAt = t.round }
        // v4.5：裁决只用「首次可见」与「排查命中 ≥ 1」—— 两者都有了就不必把剩余轮次（含 npm test / 基准脚本）再跑两遍；full=true 保留全量重放（searchHits 计满）
        if (!full && res.divergedAt != null && res.searchHits > 0) { res.stoppedEarly = true; res.roundsReplayed++; break outer }
      }
      res.roundsReplayed++
    }
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }) }
  return res
}
/** 按家族汇总：n、修好前看到分歧的条数、分歧轮次、输出里直接出现扰动物的条数；判定 active（≥ 1/2）/ weak / inert（0）。 */
const memo = new Map()   // v4.5：同进程内同一批轨迹 + 同扰动只重放一次（ruler / states / perturb-check / 测试会反复问同一个问题）
const rowSig = (r) => [r.dir || '', r.task, r.variant, r.sample ?? 0, r.fixedAtRound ?? null, r.error ? 1 : 0, (Array.isArray(r.transcript) ? r.transcript : []).map((t) => [t.round, (t.calls || []).map((c) => [c.name, typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? null)])])]
export function perturbExposure(rows, opts = {}) {
  const key = createHash('sha1').update(JSON.stringify([opts.kind || 'decoy', !!opts.full, rows.map(rowSig)])).digest('hex')
  if (memo.has(key)) return memo.get(key)
  const out = perturbExposureUncached(rows, opts); memo.set(key, out); return out
}
function perturbExposureUncached(rows, opts = {}) {
  const per = rows.map((r) => replayAgainst(r, opts)).filter(Boolean)
  const fam = {}
  for (const r of per) { const f = (fam[r.family] = fam[r.family] || { n: 0, exposedBeforeFix: 0, mentions: 0, searchHit: 0, rounds: {}, truncated: 0 }); f.n++; if (r.truncated) f.truncated++; if (r.divergedAt != null && r.beforeFix) { f.exposedBeforeFix++; f.rounds[r.divergedAt] = (f.rounds[r.divergedAt] || 0) + 1; if (r.mentionsPerturb) f.mentions++ } if (r.searchHits) f.searchHit++ }
  for (const f of Object.values(fam)) { f.rate = f.n ? +(f.exposedBeforeFix / f.n).toFixed(3) : null; f.searchRate = f.n ? +(f.searchHit / f.n).toFixed(3) : null; f.verdict = !f.n ? 'n/a' : f.exposedBeforeFix === 0 ? 'inert' : f.searchRate >= 0.5 ? 'active' : 'weak' }
  const n = per.length, exposed = per.filter((r) => r.divergedAt != null && r.beforeFix).length, search = per.filter((r) => r.searchHits > 0).length
  return { kind: opts.kind || 'decoy', n, exposedBeforeFix: exposed, searchHit: search, rate: n ? +(exposed / n).toFixed(3) : null, searchRate: n ? +(search / n).toFixed(3) : null, byFamily: fam, rows: per, verdict: !n ? 'n/a' : exposed === 0 ? 'inert' : search / n >= 0.5 ? 'active' : 'weak', note: '可见 ≠ 更难：这里只证明扰动落在真实 Agent 走过的路径上（不是惰性改动）；「更难」要看模型在扰动题上的到修好轮数，需付费小探针' }
}
