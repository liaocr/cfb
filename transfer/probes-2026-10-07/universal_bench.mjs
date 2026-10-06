// 端到端对打：现有渲染器 vs 通用选择器 vs 随机/lead（同一 30% 字符预算，同一锚点口径）
import fs from 'node:fs'
import { extractAnchorsV5, splitDiscourseUnits, compileV5Local, V5_MICRO_WEIGHTS } from '/home/user/cfb/src/compile-v5-local.js'
import { compressUniversal, selectUniversalUnits, renderUniversalUnits } from '/home/user/cfb/src/universal-select.js'

const docs = []
for (const f of ['math_cot.jsonl', 'multihop_qa.jsonl']) for (const d of JSON.parse(fs.readFileSync(`/home/user/probes/corpus/${f}`, 'utf8'))) docs.push(d)
for (const [rel, tag] of [['transfer/HANDOFF.md', 'repo-handoff'], ['docs/KAGGLE-MICRO-RUN.md', 'repo-runbook']]) {
  if (fs.existsSync(`/home/user/cfb/${rel}`)) docs.push({ id: rel.replace(/\W+/g, '_'), domain: tag, text: fs.readFileSync(`/home/user/cfb/${rel}`, 'utf8').slice(0, 20000) })
}

const tok = (t) => { const s = String(t).toLowerCase(); const o = []; for (const m of s.matchAll(/[a-z][a-z0-9_]{2,}/g)) o.push(m[0]); for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) { const r = m[0]; for (let i = 0; i < r.length - 1; i++) o.push(r.slice(i, i + 2)) } return new Set(o) }
const jac = (a, b) => { if (!a.size || !b.size) return 0; let h = 0; for (const x of a) if (b.has(x)) h++; return h / (a.size + b.size - h) }

function metrics (docText, outText, units, selIdx) {
  const A = extractAnchorsV5(docText); const B = extractAnchorsV5(outText)
  let cov = 0; for (const a of A) if (B.has(a)) cov++
  // 文内 IDF 内容词覆盖
  const df = new Map(); const ts = units.map((u) => tok(u))
  for (const s of ts) for (const x of s) df.set(x, (df.get(x) || 0) + 1)
  const N = units.length
  const content = (s) => new Set([...s].filter((x) => Math.log((N + 1) / ((df.get(x) || 0) + 0.5)) > 0))
  const cd = content(new Set(ts.flatMap((s) => [...s])))
  const cs = content(tok(outText))
  let cc = 0; for (const x of cd) if (cs.has(x)) cc++
  // 冗余
  let dup = 0; const seen = []
  for (const i of (selIdx || [])) { const t = ts[i] || new Set(); if (seen.some((s) => jac(t, s) >= 0.6)) dup++; seen.push(t) }
  return { cov: A.size ? cov / A.size : 0, cc: cd.size ? cc / cd.size : 0, dup: selIdx && selIdx.length ? dup / selIdx.length : 0, outChars: outText.length }
}

function fill (order, units, budget) { let used = 0; const sel = []; for (const i of order) { const L = units[i].length; if (used + L > budget && sel.length) continue; sel.push(i); used += L; if (used >= budget) break } return sel }

const agg = {}
const add = (k, m) => { const a = agg[k] = agg[k] || { n: 0, cov: 0, cc: 0, dup: 0, ratio: 0 }; a.n++; a.cov += m.cov; a.cc += m.cc; a.dup += m.dup; a.ratio += m.outChars / Math.max(1, m.srcChars) }

for (const d of docs) {
  const units = splitDiscourseUnits(d.text)
  if (units.length < 4) continue
  const budget = Math.max(100, Math.round(0.30 * d.text.length))
  const mk = (out, sel) => ({ ...metrics(d.text, out, units, sel), srcChars: d.text.length })

  let cur = ''
  try { cur = compileV5Local(d.text, {}, V5_MICRO_WEIGHTS).text } catch { cur = '' }
  add('现有渲染器(生产)', mk(cur, null))

  const uni = compressUniversal(d.text, { charBudget: budget })
  add('通用选择器(新)', mk(uni.text, uni.indices))

  const uniS = selectUniversalUnits(units, { charBudget: Math.round(budget / 2) })
  add('通用选择器(半预算)', mk(renderUniversalUnits(units, uniS.indices), uniS.indices))

  const rnd = fill([...units.keys()].sort(() => Math.random() - 0.5), units, budget)
  add('随机', mk(renderUniversalUnits(units, rnd), rnd))

  const lead = fill([...units.keys()], units, budget)
  add('lead-k', mk(renderUniversalUnits(units, lead), lead))
}

console.log('（预算=文档 30% 字符；锚点口径=仓库 extractAnchorsV5；内容词=文内 IDF>0 覆盖；冗余=选中单元近重复率）')
console.log(`${'选择器'.padEnd(20)} ${'篇'.padStart(3)}  ${'锚点覆盖'.padStart(8)}  ${'内容词覆盖'.padStart(9)}  ${'冗余'.padStart(6)}  ${'输出/输入'.padStart(8)}`)
for (const [k, v] of Object.entries(agg)) {
  console.log(`${k.padEnd(20)} ${v.n.toString().padStart(3)}  ${(100 * v.cov / v.n).toFixed(1).padStart(7)}%  ${(100 * v.cc / v.n).toFixed(1).padStart(8)}%  ${(100 * v.dup / v.n).toFixed(1).padStart(5)}%  ${(v.ratio / v.n).toFixed(3).padStart(8)}`)
}
// 分域
console.log('\n分域（锚点覆盖）:')
const byDom = {}
for (const d of docs) {
  const units = splitDiscourseUnits(d.text); if (units.length < 4) continue
  const budget = Math.max(100, Math.round(0.30 * d.text.length))
  let cur = ''; try { cur = compileV5Local(d.text, {}, V5_MICRO_WEIGHTS).text } catch {}
  const uni = compressUniversal(d.text, { charBudget: budget })
  const m1 = metrics(d.text, cur, units, null); const m2 = metrics(d.text, uni.text, units, uni.indices)
  const k = d.domain; byDom[k] = byDom[k] || { n: 0, a: 0, b: 0 }; byDom[k].n++; byDom[k].a += m1.cov; byDom[k].b += m2.cov
}
for (const [k, v] of Object.entries(byDom)) console.log(`  ${k.padEnd(14)} n=${v.n}  现有 ${(100 * v.a / v.n).toFixed(1)}%  →  通用 ${(100 * v.b / v.n).toFixed(1)}%`)
