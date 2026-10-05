/**
 * hand-capture.mjs —— Mode 1（手写探顶）训练轮的**侧数据采集**（本会话决议：训练金标时顺手产数据）。
 *
 * 采集四路（全部来自训练轮本身，零额外花费）：
 *   (a) pending→draft 示范对：每轮 (原文 + ctx) → 手写稿（含闸门结论）——"该写什么"的示范；
 *   (b) 跨轮修订差：draft_{t} → draft_{t+1} 的增删句 + 触发它的新证据——判读/方向监督（最缺的一路）；
 *   (c) G2 / 生产闸的违规理由文本——结构负例（带原因，不只是类型）；
 *   (d) 对金标任务，builder 侧补 draftDistance 六维向量——回归/排序监督。
 *
 * 写入端在 tools/traj-run.mjs（hand 臂每轮结论落一条 JSONL）；读取端在 tools/build-micro-dataset.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'

export const HAND_SAMPLE_SCHEMA = 'cfb.hand-sample/2'

/** id 形如 <task>-s<sample>-r<round>（traj-run 的 safeId 规则）。 */
export function parseHandId(id) {
  const m = String(id || '').match(/^(.*)-s(\d+)-r(\d+)$/)
  return m ? { key: m[1], sample: Number(m[2]), round: Number(m[3]) } : null
}

/** 同一 episode 里、比 round 小的最大一轮已存在的草稿（返回 {round, file}）。 */
export function previousDraft(outDir, key, sample, round) {
  const dir = path.join(outDir, 'drafts')
  if (!fs.existsSync(dir)) return null
  let best = null
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(.*)-s(\d+)-r(\d+)\.md$/)
    if (!m || m[1] !== key || Number(m[2]) !== sample) continue
    const r = Number(m[3])
    if (r < round && (!best || r > best.round)) best = { round: r, file: path.join(dir, f) }
  }
  return best
}

const sentences = (t) => String(t || '').split(/(?<=[。！？\n])/).map((s) => s.trim()).filter((s) => s.length >= 4)
const norm = (s) => s.replace(/\s+/g, '')
/** 两稿的句级增删（用于 (b)：改了什么）。 */
export function draftDelta(prevText, nextText) {
  const A = sentences(prevText), B = sentences(nextText)
  const sa = new Set(A.map(norm)), sb = new Set(B.map(norm))
  const added = B.filter((s) => !sa.has(norm(s)))
  const removed = A.filter((s) => !sb.has(norm(s)))
  return { added, removed, addedChars: added.reduce((a, s) => a + s.length, 0), removedChars: removed.reduce((a, s) => a + s.length, 0) }
}

/** 追加一条 hand 采样记录（append-only）。Mode 1 采集是本轮验收范围，写失败必须显式失败，不能静默丢数据。 */
export function appendHandSample(outDir, rec) {
  if (!outDir) throw new Error('hand-sample-output-directory-required')
  fs.mkdirSync(outDir, { recursive: true })
  fs.appendFileSync(path.join(outDir, 'hand-samples.jsonl'), JSON.stringify(rec) + '\n')
  return true
}

/** 读取全部 traj 目录下的 hand-samples.jsonl；按 id 去重（保留最后一条），按 at 排序。 */
export function readHandSamples(repoRoot) {
  const base = path.join(repoRoot, '.cfb-runtime', 'traj')
  const out = [], files = []
  if (!fs.existsSync(base)) return { samples: out, files }
  for (const dir of fs.readdirSync(base)) {
    const p = path.join(base, dir, 'hand-samples.jsonl')
    if (!fs.existsSync(p)) continue
    files.push(path.relative(repoRoot, p))
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r && r.id) out.push({ ...r, traj: dir, at: r.at || null }) } catch {}
    }
  }
  const byId = new Map()
  for (const r of out) byId.set(r.traj + '#' + r.id, r)
  return { samples: [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))), files }
}
