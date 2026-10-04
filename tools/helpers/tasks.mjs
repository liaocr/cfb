// tools/helpers/tasks.mjs —— 任务池（闭环 v3）：冻结 5 题 + 外加任务（铸造 / 挖掘）→ 确定性 dev/holdout 切分 → 逐轮轮换。
//
// 为什么要有它（v14.2 的硬伤）：同 5 道题既当训练又当验收，重复观测被当成独立观测，误采纳无法被发现。
// 规则：
//   · 切分按 sha256(seed + id) 排序取前 ceil(40%) 为 holdout（≥2 题）；seed 冻结在池文件里，换 seed = 换池 = 新假设键。
//   · holdout 题只给裁判（采纳证据），永不喂给提议器 / 离线筛选；dev 题用于筛选、喂提议器。
//   · 外加任务放 .cfb-offline/tasks/<id>.task.json（schema cfb.task/1，形状与冻结链一致），加载时校验，digest 进计划。
//   · 轮换：池 > 每轮题数时按轮次确定性滑窗，dev/holdout 各自滑，保证每轮两类都有。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadFrozenTasks, productionContext } from './candidates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TASK_SCHEMA = 'cfb.task/1'
export const POOL_SCHEMA = 'cfb.task-pool/1'
export const DEFAULT_SPLIT_SEED = 'cfb-holdout-2026-10-02'
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

/** 外加任务文件形状校验：与冻结链同形（u1/a1/a1Call/u2/a2/a2Edit/verifyCmd）+ spec（可缺 next/avoid）+ r1 + side。 */
export function validateTaskFile(t) {
  const bad = (m) => { throw new Error('task-file:' + m) }
  if (!t || t.schema !== TASK_SCHEMA) bad('schema')
  if (!TASK_ID_RE.test(t.id || '')) bad('id')
  if (!['minted', 'mined', 'authored'].includes(t.source)) bad('source')
  const c = t.chain
  if (!c || c.id !== t.id || typeof c.u1 !== 'string' || !c.a1?.raw || typeof c.a1.content !== 'string' || !c.a1Call || typeof c.u2 !== 'string' || !c.a2?.raw || typeof c.a2.content !== 'string') bad('chain')
  if (typeof t.r1 !== 'string' || t.r1.length < 50) bad('r1')
  if (typeof t.side !== 'string' || t.side.length < 50) bad('side')
  const s = t.spec
  if (!s || s.id !== t.id || typeof s.obs?.red?.followup !== 'string') bad('spec')
  for (const k of ['next', 'avoid']) if (s.obs.red[k] !== undefined && (!Array.isArray(s.obs.red[k]) || s.obs.red[k].some((x) => typeof x !== 'string'))) bad('spec.' + k)
  return true
}
export function taskDigest(t) { return sha(JSON.stringify({ id: t.id, chain: t.chain, spec: t.spec, r1: t.r1, side: t.side })).slice(0, 16) }

/** 读外加任务目录；坏文件记入 warnings，不中断。 */
export function loadExtraTasks(dir = path.join(ROOT, '.cfb-offline', 'tasks')) {
  const out = [], warnings = []
  if (!fs.existsSync(dir)) return { tasks: out, warnings }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.task.json')).sort()) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      validateTaskFile(t)
      out.push({ id: t.id, source: t.source, chain: t.chain, spec: t.spec, r1: t.r1, side: t.side, ctx: productionContext(t.chain, t.r1), digest: taskDigest(t), file: f })
    } catch (e) { warnings.push(f + ': ' + (e && e.message || e)) }
  }
  return { tasks: out, warnings }
}

/** 确定性切分：holdout = 按 sha256(seed+id) 排序的前 ceil(frac·n)（至少 2，若 n ≥ 4）。 */
export function splitTasks(ids, { seed = DEFAULT_SPLIT_SEED, holdoutFraction = 0.4 } = {}) {
  const uniq = [...new Set(ids)]
  if (uniq.length !== ids.length) throw new Error('task-pool-duplicate-id')
  const ranked = uniq.map((id) => ({ id, h: sha(seed + '|' + id) })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0)).map((x) => x.id)
  const k = uniq.length >= 4 ? Math.max(2, Math.ceil(holdoutFraction * uniq.length)) : uniq.length >= 2 ? 1 : 0
  const holdout = new Set(ranked.slice(0, k))
  return Object.fromEntries(uniq.map((id) => [id, holdout.has(id) ? 'holdout' : 'dev']))
}

/** 组池：冻结题（source frozen）+ 外加题；返回 { schema, seed, tasks[], split, digest, warnings }。 */
export function buildPool({ frozen = loadFrozenTasks(), extra = loadExtraTasks(), seed = DEFAULT_SPLIT_SEED, holdoutFraction = 0.4 } = {}) {
  const tasks = [...frozen.map((t) => ({ ...t, source: 'frozen', digest: taskDigest(t) })), ...extra.tasks]
  const split = splitTasks(tasks.map((t) => t.id), { seed, holdoutFraction })
  const registry = Object.fromEntries(tasks.map((t) => [t.id, { digest: t.digest, source: t.source, split: split[t.id] }]))
  return { schema: POOL_SCHEMA, seed, holdoutFraction, tasks: tasks.map((t) => ({ ...t, split: split[t.id] })), split, registry, digest: sha(JSON.stringify(registry)).slice(0, 12), warnings: extra.warnings || [] }
}

/** 逐轮轮换：每类按轮次滑窗；池 ≤ perRound 时全用。保证每轮 holdout ≥ 1（池里有的话）。 */
export function rotateTasks(pool, round, perRound = 5) {
  const dev = pool.tasks.filter((t) => t.split === 'dev').map((t) => t.id).sort()
  const hold = pool.tasks.filter((t) => t.split === 'holdout').map((t) => t.id).sort()
  if (dev.length + hold.length <= perRound) return [...dev, ...hold]
  const wantHold = Math.min(hold.length, Math.max(1, Math.round(perRound * hold.length / (dev.length + hold.length))))
  const wantDev = Math.min(dev.length, perRound - wantHold)
  const window = (ids, n, r) => { if (!ids.length || !n) return []; const start = ((r - 1) * n) % ids.length; return Array.from({ length: n }, (_, i) => ids[(start + i) % ids.length]) }
  return [...window(dev, wantDev, round), ...window(hold, wantHold, round)]
}

/** 铸造协议（4 请求 / 题，需人写 u2 与 followup；本文件只定义形状，请求由 generation.mjs 组装）：
 *   A. 主模型 [u1] + 工具 → a1.content / a1.raw / a1Call
 *   B. 作者按 a1Call 写 u2（真实工具输出）→ 主模型 [u1,a1,u2] → a2.content / a2.raw / a2Edit
 *   C. 压缩器 compress(a1.raw, ctx1) → r1；D. 压缩器 compress(a2.raw, ctx2) → side
 *  写成 .cfb-offline/tasks/<id>.task.json 后 buildPool 自动纳入并切分。 */
export const MINT_PROTOCOL = Object.freeze({ requestsPerTask: 4, steps: ['A:a1', 'B:a2(需作者写 u2)', 'C:r1', 'D:side'], file: '.cfb-offline/tasks/<id>.task.json' })
