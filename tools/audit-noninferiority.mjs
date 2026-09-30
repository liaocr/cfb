#!/usr/bin/env node
// tools/audit-noninferiority.mjs — v12.9.2 非劣性审计（零调用、零成本）
//
// 目的：v12.9.2 给稿层加了程序写的部件（【延续段】/【验收提示】/ 收工三问 / 已排除候选剥离 / 出处括注折叠），
//   用户的验收标准是「给模型的每一样东西在任何情况下都只能是优化、不能变差」。这里把手头所有历史稿
//   （多轮各版本 auto-d2* / 手写 oracle-d2* / 单步 direct-*）逐份推过新闸门，机检以下不变量：
//   N1 接受性不退：旧闸门放行（accept=ok）的稿，新闸门也放行（程序部件不能把稿变成 invented-identifier / no-gain）
//   N2 程序部件的出处：延续段 / 提示 / 三问里每个反引号片段都逐字出自 ctx 或原文（程序不发明标识符）
//   N3 幂等：拼过一次的稿再过一遍闸门不变（生产里 compileV4Direct 拼一次、birthFinish 再拼一次）
//   N4 不删有用东西：剥延续句 / 剥已排除候选之后，落定三元组、验收命令、逃生句仍在；形态分不降
//   N5 三问只在有改法在场时补、且从不重复；单步 ctx（无【台账】）一律不动（continuation/hints/closing/excluded 全为 0）
//   N6 长度：程序部件总量有界（延续段 ≤ 1200、提示 ≤ 4 条、三问 ≤ 400），全稿 ≤ 3300
//   N7 剥已排除候选不误伤：被删句必含已排除标识符且是提议式（edit_file / old_text 是 / 改回），落定句从不被删
//   J  评委补票策略回放（tools/effect-mr.mjs needsEscalation）：在 run4 三票数据上，首票 + 条件补票 vs 全三票中位数
//
// 用法：node tools/audit-noninferiority.mjs [--chains transfer/mr/chains.json] [--d1 transfer/direct-d9a-r.json]
//        [--mr transfer/mr] [--direct transfer] [--run4 transfer/mr/run4/results.jsonl] [--json out.json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const here = path.dirname(fileURLToPath(import.meta.url))
const I = createRequire(import.meta.url)(path.join(here, '..', 'index.js'))
const { mrMessages, mrFormCheck } = await import('./compile-mr.mjs')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const root = path.join(here, '..')
const o = {
  chains: opt('--chains', path.join(root, 'transfer/mr/chains.json')),
  d1: opt('--d1', path.join(root, 'transfer/direct-d9a-r.json')),
  mr: opt('--mr', path.join(root, 'transfer/mr')),
  direct: opt('--direct', path.join(root, 'transfer')),
  run4: opt('--run4', path.join(root, 'transfer/mr/run4/results.jsonl')),
  json: opt('--json', ''),
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const rowsOf = (j) => Array.isArray(j) ? j : (j.rows || j.results || [])
const chains = rowsOf(readJson(o.chains)).length ? rowsOf(readJson(o.chains)) : readJson(o.chains).chains
const d1 = Object.fromEntries(rowsOf(readJson(o.d1)).map((r) => [r.id, r.text]))

// 多轮 ctx（生产同口径）：buildCompressCtx（台账 + 延续段）+ 本轮调用块
function ctxFor(chain) {
  const calls = [...String(chain.a2.content || '').matchAll(/\[tool_call\s+([\w-]+)\]\s*(\{[\s\S]*?\})(?=\s*(?:\[tool_call|\n|$))/g)].map((m) => ({ name: m[1], args: m[2] }))
  const block = I.turnCallsBlock(calls)
  return I.buildCompressCtx(mrMessages(chain, d1[chain.id])) + (block ? '\n\n' + block : '')
}
const ticks = (s) => [...String(s).matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
const norm = (s) => String(s).replace(/\s+/g, '')

const findings = []   // { check, file, id, detail }
const F = (check, file, id, detail) => findings.push({ check, file, id, detail })
const counts = { drafts: 0, mrDrafts: 0, singleDrafts: 0, hintsTotal: 0, closingAdded: 0, excludedStripped: 0, continuationAdded: 0, dedupe: 0 }
const lens = []

// ── 多轮稿：transfer/mr/auto-d2*.json + oracle-d2*.json（每份都有 side = 副模型原稿 / 手写稿）──
const mrFiles = fs.readdirSync(o.mr).filter((f) => /^(?:auto|oracle)-d2.*\.json$/.test(f)).sort()
for (const f of mrFiles) {
  let rows
  try { rows = rowsOf(readJson(path.join(o.mr, f))) } catch { continue }
  for (const r of rows) {
    const chain = chains.find((c) => c.id === r.id); if (!chain) continue
    const side = r.side || r.text; if (!side) continue
    counts.drafts++; counts.mrDrafts++
    const ctx = ctxFor(chain)
    const raw = chain.a2.raw || side
    const cfg = { compressCtx: ctx }
    const g = I.compileV4Direct(side, raw, cfg)
    const tag = `${f}:${r.id}`
    if (!g.ok) { if (r.accept === 'ok' || r.why === 'condensed') F('N1', f, r.id, `旧放行、新闸门拒绝：${g.reason}`); continue }
    // 同一把尺子比：旧存稿（r.text，当时的闸门产物）与新出稿各过一遍 birthAccept；旧 ok、新不 ok 才是退步
    //   （这些链的第 2 轮原文只有 500–1050 字，低于生产 birthMinChars 3100，no-gain 在生产里根本不会到这一步；但仍要求「不比旧稿差」）
    const accOld = I.birthAccept(raw, r.text || side, { ...cfg, birthMinSavedChars: 50 })
    const acc = I.birthAccept(raw, g.text, { ...cfg, birthMinSavedChars: 50 })
    if (accOld.ok && !acc.ok) F('N1', f, r.id, `birthAccept 由 ok 变 ${acc.why} ${JSON.stringify(acc.info || {}).slice(0, 120)}`)

    const st = g.stats || {}
    counts.hintsTotal += st.splicedHints || 0; counts.closingAdded += st.splicedClosing || 0; counts.continuationAdded += st.continuation || 0
    counts.excludedStripped += (st.excludedFallback || []).length; counts.dedupe += st.dedupedParentheticals || 0
    lens.push({ tag, side: side.length, out: g.text.length })
    // N2 程序部件出处
    const cont = (ctx.match(/【延续段】[^\n]*\n([^\n]+)/) || [])[1] || ''
    const hints = I.verifyHints(ctx)
    const closing = I.closingQuestions(ctx)
    const pool = norm(ctx + '\n' + raw + '\n' + side)
    for (const [part, txt] of [['延续段', cont], ['提示', hints.join('\n')], ['三问', closing]]) {
      for (const t of ticks(txt)) {
        // 提示 / 三问里的派生命令（grep -n "key" file、: > log、wc -l log、grep -rn --exclude-dir=node_modules "key" .）：键名与文件名都得出自 ctx
        const idents = [...t.matchAll(/[A-Za-z_][\w./~-]{3,}/g)].map((m) => m[0]).filter((w) => !/^(?:grep|exclude-dir|node_modules|wc|tail|head|cat|bash|true|false|null)$/.test(w))
        const missing = idents.filter((w) => !pool.includes(norm(w)))
        if (missing.length) F('N2', f, r.id, `${part} 片段 \`${t}\` 里的 ${missing.join(',')} 不在 ctx / 原文里`)
      }
    }
    // N3 幂等
    const again = I.spliceProgramParts(g.text, ctx, {})
    if (again !== g.text) F('N3', f, r.id, `再拼一次变了：${again.length} vs ${g.text.length}`)
    const again2 = I.stripExcludedFallback(g.text, ctx, {}); if (again2 !== g.text) F('N3', f, r.id, '剥已排除候选不幂等')
    const again3 = I.dedupeParentheticals(g.text, {}); if (again3 !== g.text) F('N3', f, r.id, '括注折叠不幂等')
    // N4 不删有用东西：三元组 / 验收命令 / 逃生句 在 side 里有 ⇒ 出稿里也有；形态分不降
    const triple = side.match(/old_text 是 `([^`]+)`/); if (triple && !g.text.includes('old_text 是 `' + triple[1] + '`')) F('N4', f, r.id, '落定三元组的 old_text 丢了')
    const vc = side.match(/验收是[^。]*?`([^`]+)`/); if (vc && !g.text.includes(vc[1])) F('N4', f, r.id, '验收命令丢了')
    if (/如果输出跟这两种都不像/.test(side) && !/如果输出跟这两种都不像/.test(g.text)) F('N4', f, r.id, '逃生句丢了')
    const f0 = mrFormCheck(side, hints), f1 = mrFormCheck(g.text, hints)
    if (f1.score < f0.score) F('N4', f, r.id, `形态分降：${f0.score} → ${f1.score} ${JSON.stringify(Object.fromEntries(Object.keys(f0).filter((k) => f0[k] === 1 && f1[k] === 0).map((k) => [k, '丢'])))}`)
    // N5 三问不重复
    const nQ = (g.text.match(/能说修好要三件事都在手/g) || []).length; if (nQ > 1) F('N5', f, r.id, `三问出现 ${nQ} 次`)
    // N6 长度
    if (cont.length > 1200) F('N6', f, r.id, `延续段 ${cont.length} 字`)
    if (hints.length > 4) F('N6', f, r.id, `提示 ${hints.length} 条`)
    if (closing.length > 400) F('N6', f, r.id, `三问 ${closing.length} 字`)
    if (g.text.length > 3300) F('N6', f, r.id, `全稿 ${g.text.length} 字`)
    // N7 剥已排除候选：被删的句必含已排除标识符且是提议式；落定句仍在
    if (st.excludedFallback && st.excludedFallback.length) {
      const before = I.spliceProgramParts(side, ctx, {})
      const removed = before.split(/(?<=[。；])/).filter((s0) => !g.text.includes(s0.trim()) && s0.trim())
      for (const s0 of removed) {
        if (!/edit_file|old_text 是|new_text 是|改回|让它回到|另一个值行|第二个三元组|改\s+[\w./-]+\s+的\s+`/.test(s0)) continue   // 其他闸门（样例抄写剥离等）删的不算
        if (!st.excludedFallback.some((id) => s0.includes(id))) F('N7', f, r.id, `删了一句不含已排除标识符的提议：${s0.slice(0, 80)}`)
        if (/^\s*所以下一步工具调用是/.test(s0)) F('N7', f, r.id, '落定句被删')
      }
    }
  }
}

// ── 单步稿：transfer/direct-*.json（无【台账】⇒ 新机制必须全部沉默）──
const directFiles = fs.readdirSync(o.direct).filter((f) => /^direct-.*\.json$/.test(f)).sort()
for (const f of directFiles) {
  let rows
  try { rows = rowsOf(readJson(path.join(o.direct, f))) } catch { continue }
  for (const r of rows) {
    const side = r.side; if (!side) continue
    const ctx = r.ctx || ''
    if (/【台账】/.test(ctx)) continue
    counts.drafts++; counts.singleDrafts++
    const g = I.compileV4Direct(side, r.raw || side, ctx ? { compressCtx: ctx } : {})
    const st = (g && g.stats) || {}
    if (st.continuation || st.splicedHints || st.splicedClosing || (st.excludedFallback && st.excludedFallback.length) || st.dedupedParentheticals) F('N5', f, r.id, `单步 ctx 却触发了多轮机制：${JSON.stringify({ c: st.continuation, h: st.splicedHints, q: st.splicedClosing, x: st.excludedFallback, d: st.dedupedParentheticals })}`)
    if (g.ok && /能说修好要三件事都在手|上一轮已定：/.test(g.text) && !/能说修好要三件事都在手|上一轮已定：/.test(side)) F('N5', f, r.id, '单步稿被加了多轮部件')
  }
}

// ── J 评委补票策略回放 ──
let J = null
if (fs.existsSync(o.run4)) {
  const { needsEscalation } = await import('./effect-mr.mjs')
  const rows = fs.readFileSync(o.run4, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r && r.judge && r.rule && Array.isArray(r.judge.votes) && r.judge.votes.length >= 3)
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] }
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
  let calls = 0, esc = 0, dev2 = 0; const by = {}
  for (const r of rows) {
    const first = r.judge.votes[0], full = med(r.judge.votes)
    const e = needsEscalation(r.rule, r.action, { overall: first }, r.obs)
    esc += e ? 1 : 0; calls += e ? 3 : 1
    const est = e ? full : first; if (Math.abs(est - full) >= 2) dev2++
    const k = r.variant + '|' + r.obs; (by[k] = by[k] || { full: [], est: [] }); by[k].full.push(full); by[k].est.push(est)
  }
  J = { rows: rows.length, escalated: esc, judgeCalls: calls, judgeCallsAllThree: rows.length * 3, saved: rows.length ? Math.round(100 - 100 * calls / (rows.length * 3)) : 0, rowsDeviating2: dev2, maxVariantMeanShift: Math.max(0, ...Object.values(by).map((x) => Math.abs(mean(x.full) - mean(x.est)))) }
}

// ── 报告 ──
const byCheck = {}; for (const x of findings) byCheck[x.check] = (byCheck[x.check] || 0) + 1
const L = []
L.push('# 非劣性审计（v12.9.2 稿层程序部件）', '')
L.push(`稿：${counts.drafts} 份（多轮 ${counts.mrDrafts}：${mrFiles.join('、')}；单步 ${counts.singleDrafts}：${directFiles.length} 个文件）`)
L.push(`程序部件触发：延续段 ${counts.continuationAdded}、提示 ${counts.hintsTotal} 条、三问补齐 ${counts.closingAdded}、已排除候选剥离 ${counts.excludedStripped} 句、出处括注折叠 ${counts.dedupe}`)
if (lens.length) { const outs = lens.map((x) => x.out).sort((a, b) => a - b); L.push(`多轮出稿长度：中位 ${outs[Math.floor(outs.length / 2)]}、最长 ${outs[outs.length - 1]}（${lens.find((x) => x.out === outs[outs.length - 1]).tag}）、> 2600 的 ${outs.filter((x) => x > 2600).length} 份`) }
L.push('', '| 不变量 | 违反 |', '|---|---|')
for (const k of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7']) L.push(`| ${k} | ${byCheck[k] || 0} |`)
if (findings.length) { L.push('', '## 违反明细'); for (const x of findings) L.push(`- ${x.check} ${x.file}:${x.id} — ${x.detail}`) }
if (J) L.push('', `## 评委补票回放（${path.relative(root, o.run4)}）`, `三票行 ${J.rows}；补票 ${J.escalated} 行；评委调用 ${J.judgeCalls} vs 全三票 ${J.judgeCallsAllThree}（省 ${J.saved}%）；逐行偏差 ≥ 2 的 ${J.rowsDeviating2} 行；变体均分最大偏移 ${J.maxVariantMeanShift.toFixed(2)}`)
L.push('', findings.length ? `结论：有 ${findings.length} 处违反，见上。` : '结论：全部不变量成立——新部件只增不减、单步全程沉默、幂等、无发明。')
console.log(L.join('\n'))
if (o.json) fs.writeFileSync(o.json, JSON.stringify({ counts, findings, lens, J }, null, 2))
process.exit(findings.length ? 1 : 0)
