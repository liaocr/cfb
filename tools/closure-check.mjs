// tools/closure-check.mjs —— 零成本闭合检查（v12.8.9，理论 S8-R11）：自动稿是否落在 oracle I 的落点上、三元组是否完整、有没有落定句、门统计里的缺陷、长度
//   用法：node tools/closure-check.mjs direct-a.json direct-b.json …   （compile-direct 的输出；每份稿一行，末尾按文件汇总）
//   这是**基准专用**的尺：LOCI 表写死了 5 基题在 oracle I 里的落点。它的用处是在花钱做主模型评测之前，用便宜的副模型压稿（每版 2–3 遍）
//   量「结构闭合率」——本会话里它预测了主模型评测的结果（v4d5 主落点 5/10 ⇒ 6.75 分；v4d6+在手清单 14/14 ⇒ 8.5 分）。
//   列：主落点 = oracle 的第一落点出现在尾段 old_text 里；替代 = 调用处等次优落点；第二 = perf 的第二个三元组；new = new_text 存在且 ≠ old_text；
//       落定句 = 「改法只落一个 / 落点已经在手」；门缺陷 = disjunctiveFix / unboundFix / repairedAffordance / hedgedTrigger / noopNewText。
import fs from 'node:fs'
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const LOCI = {
  'eacces-config': { primary: ['const env = { ...process.env, DSH_HOME: tmp }'], alt: [] },
  'flaky-timeout': { primary: ['hedgeAfterMs: 1600'], alt: [] },
  'wrong-model': { primary: ['observe(options) { if (options && options.model) lastModel = options.model }'], alt: ['host.observe(options, n)'] },
  'sse-truncated': { primary: ["return { out, finish: finish || (done ? 'stop' : null) }"], alt: [] },
  'perf-regression': { primary: ['compressTargetMax: 1800,'], alt: [], second: ['maxOutputTokens: 4096,'] },
}
const files = process.argv.slice(2)
const rows = []
for (const f of files) {
  const name = f.replace(/^.*direct-/, '').replace(/\.json$/, '')
  const d = JSON.parse(fs.readFileSync(f, 'utf8')).rows
  for (const r of d) {
    const L = LOCI[r.id]; if (!L) continue
    const t = r.text || ''
    const tail = t.slice(Math.floor(t.length * 0.4))
    const olds = [...tail.matchAll(/old_text 是 `([^`]+)`/g)].map((m) => norm(m[1]))
    const news = [...tail.matchAll(/new_text 是 `([^`]+)`/g)].map((m) => norm(m[1]))
    const has = (arr, list) => list.some((x) => arr.some((o) => o.includes(norm(x))))
    const primary = has(olds, L.primary), alt = has(olds, L.alt), second = L.second ? has(olds, L.second) : null
    const newOk = news.length >= 1 && news.every((n) => !olds.includes(n))
    const commit = /改法只落一个|落点已经在手|落点选|只落定|落定[:：]/.test(t)
    const g = r.gate || {}
    const defects = ['disjunctiveFix', 'unboundFix', 'repairedAffordance', 'hedgedTrigger', 'noopNewText'].filter((k) => g[k])
    const ok = r.why === 'condensed' && r.accept === 'ok' && (primary || alt) && newOk && commit && !defects.length && (second !== false)
    rows.push({ name, id: r.id, why: r.why, accept: r.accept, chars: t.length, ms: r.ms, primary, alt, second, newOk, commit, defects: defects.join('+') || '-', ok })
  }
}
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('稿', 5), pad('任务', 16), pad('状态', 10), pad('accept', 26), pad('字数', 6), pad('主落点', 7), pad('替代', 5), pad('第二', 5), pad('new', 5), pad('落定句', 7), pad('门缺陷', 22), '闭合')
for (const r of rows) console.log(pad(r.name, 5), pad(r.id, 16), pad(r.why, 10), pad(r.accept, 26), pad(r.chars, 6), pad(r.primary ? '●' : '·', 7), pad(r.alt ? '●' : '·', 5), pad(r.second === null ? '—' : r.second ? '●' : '·', 5), pad(r.newOk ? '●' : '·', 5), pad(r.commit ? '●' : '·', 7), pad(r.defects, 22), r.ok ? '✔' : '✘')
const byName = {}
for (const r of rows) { (byName[r.name] ??= []).push(r) }
for (const [n, rs] of Object.entries(byName)) {
  const okN = rs.filter((r) => r.ok).length
  console.log(`\n${n}: 闭合 ${okN}/${rs.length} · 主落点 ${rs.filter((r) => r.primary).length}/${rs.length} · 落定句 ${rs.filter((r) => r.commit).length}/${rs.length} · 无门缺陷 ${rs.filter((r) => r.defects === '-').length}/${rs.length} · 字数均值 ${Math.round(rs.reduce((a, r) => a + r.chars, 0) / rs.length)} · 超 1800: ${rs.filter((r) => r.chars > 1800).length}`)
}
