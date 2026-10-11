#!/usr/bin/env node
// attrib-regime —— 零 API 归因：仓库里唯一的「压稿 vs raw」结局证据（transfer/traj1–3，v4d7 时代、同模型、无地板每轮都压）
// 到底证明了什么制度？答：证明的是「每轮增补」（41 字原文 → 1446 字稿），不是「把长思维链压短」。
//   - 压缩轮里 稿 > 原文 的占比（增补占比）
//   - 压缩轮里 原文 ≥ 3100 的占比（= 现行生产地板下还会触发的占比）
//   - raw vs auto 每轮思考长度（稿会不会让主模型下一轮想得更多 = 启动效应）
//   - 配对结局（同目录 / 同题 / 同样本）
// 用法：node tools/attrib-regime.mjs [--json] [--floor 3100] [dir ...]   缺省 transfer/traj1 transfer/traj2 transfer/traj3（含 results.nofloor.jsonl）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function loadRows(dirs) {
  const rows = []
  for (const d of dirs) for (const f of ['results.jsonl', 'results.nofloor.jsonl']) {
    const p = path.isAbsolute(d) ? path.join(d, f) : path.join(ROOT, d, f)
    if (!fs.existsSync(p)) continue
    for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); if (!r.error && !r.status) rows.push({ ...r, dir: path.basename(d), file: f }) } catch {} }
  }
  return rows
}

const solved = (r) => !!(r.fixed || Number.isInteger(r.fixedAtRound))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100)

/** 归因表（纯函数，可测） */
export function attribRegime(rows, { floor = 3100 } = {}) {
  const by = {}
  for (const r of rows) (by[r.variant] = by[r.variant] || []).push(r)
  const outcomes = Object.fromEntries(Object.entries(by).map(([v, rs]) => [v, { n: rs.length, solved: r2(rs.filter(solved).length / rs.length), rounds: r2(mean(rs.map((r) => r.rounds || 0))), reasoningChars: Math.round(mean(rs.map((r) => (r.transcript || []).reduce((a, t) => a + (t.reasoningChars || 0), 0))) || 0) }]))
  // 压缩轮：stored ≠ reasoning 的轮（v4d7 时代 transcript 只有 reasoningChars / storedChars 两个数）
  let rounds = 0, compressed = 0, expansion = 0, aboveFloor = 0
  for (const r of rows) {
    if (r.variant === 'raw') continue
    for (const t of r.transcript || []) {
      rounds++
      if (t.storedChars && t.reasoningChars && t.storedChars !== t.reasoningChars) { compressed++; if (t.storedChars > t.reasoningChars) expansion++; if (t.reasoningChars >= floor) aboveFloor++ }
    }
  }
  const perRound = []
  for (let k = 1; k <= 8; k++) {
    const a = [], b = []
    for (const r of rows) for (const t of r.transcript || []) if (t.round === k) (r.variant === 'raw' ? a : r.variant === 'auto' ? b : []).push(t.reasoningChars || 0)
    if (a.length || b.length) perRound.push({ round: k, raw: a.length ? Math.round(mean(a)) : null, nRaw: a.length, auto: b.length ? Math.round(mean(b)) : null, nAuto: b.length })
  }
  const pair = {}
  for (const r of rows) { if (!['raw', 'auto'].includes(r.variant)) continue; (pair[`${r.dir}|${r.file}|${r.task}|${r.sample}`] = pair[`${r.dir}|${r.file}|${r.task}|${r.sample}`] || {})[r.variant] = r }
  const pairs = []
  for (const [k, p] of Object.entries(pair)) {
    if (!p.raw || !p.auto) continue
    const a = solved(p.auto), b = solved(p.raw), fa = p.auto.fixedAtRound ?? 99, fb = p.raw.fixedAtRound ?? 99
    pairs.push({ key: k, raw: b ? `✓@${p.raw.fixedAtRound}` : '✗', auto: a ? `✓@${p.auto.fixedAtRound}` : '✗', result: a && !b ? 'auto' : b && !a ? 'raw' : a && b && fa < fb ? 'auto' : a && b && fb < fa ? 'raw' : 'tie' })
  }
  return {
    floor, outcomes,
    compressedRounds: { rounds, compressed, expansion, expansionShare: compressed ? r2(expansion / compressed) : null, aboveFloor, aboveFloorShare: compressed ? r2(aboveFloor / compressed) : null },
    perRound, pairs, pairSummary: { auto: pairs.filter((p) => p.result === 'auto').length, raw: pairs.filter((p) => p.result === 'raw').length, tie: pairs.filter((p) => p.result === 'tie').length },
  }
}

export function renderAttrib(A) {
  const L = [`# 归因：压稿证据是哪种制度？（地板 ${A.floor}）`, '', '| 臂 | n | 修好率 | 平均轮 | 每条思考字数 |', '|---|---|---|---|---|']
  for (const [v, o] of Object.entries(A.outcomes)) L.push(`| ${v} | ${o.n} | ${o.solved} | ${o.rounds} | ${o.reasoningChars} |`)
  const c = A.compressedRounds
  L.push('', `压缩轮 ${c.compressed} / ${c.rounds}；其中 **稿比原文长（增补）${c.expansion} = ${Math.round((c.expansionShare || 0) * 100)}%**；原文 ≥ ${A.floor}（现行地板下才会触发）${c.aboveFloor} = ${Math.round((c.aboveFloorShare || 0) * 100)}%`, '', '| 轮 | raw 思考字数 | auto 思考字数 |', '|---|---|---|')
  for (const p of A.perRound) L.push(`| ${p.round} | ${p.raw ?? '—'} (n${p.nRaw}) | ${p.auto ?? '—'} (n${p.nAuto}) |`)
  L.push('', `配对（同目录/题/样本）raw vs auto：auto 更好 ${A.pairSummary.auto} / raw 更好 ${A.pairSummary.raw} / 平或都没修 ${A.pairSummary.tie}`)
  for (const p of A.pairs) L.push(`- ${p.key}：raw ${p.raw} · auto ${p.auto} ⇒ ${p.result}`)
  return L.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const json = args.includes('--json'); const fi = args.indexOf('--floor'); const floor = fi >= 0 ? Number(args[fi + 1]) : 3100
  const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--floor')
  const A = attribRegime(loadRows(dirs.length ? dirs : ['transfer/traj1', 'transfer/traj2', 'transfer/traj3']), { floor })
  console.log(json ? JSON.stringify(A, null, 2) : renderAttrib(A))
}
