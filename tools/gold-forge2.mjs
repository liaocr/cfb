#!/usr/bin/env node
// tools/gold-forge2.mjs —— 批量锻造到达线（v14.23.0，$0）；取代 gold-forge 的人工环节
// 铁律（违反就是银标，不是金标）：
//   1) 所有引用一律**逐字取自该条 raw/ctx**（含中文引号内的整句）；抽不到 ⇒ 标 needs-manual，绝不代写内容；
//   2) 全稿只允许**一处**反引号（生产闸的配对在中文语境下只扛得住一处，v14.23.0 已修的那类错位不再依赖）；
//   3) 长度必须 ≤ min(C1 线 = 0.55·raw, C6 线 = 同 raw 产线稿实长)，超出就从尾部"复述句"开始削，削到判读段为止。
// 用法：
//   node tools/gold-forge2.mjs --pending .cfb-runtime/traj/tNN/pending/*.json [--write]
//   node tools/gold-forge2.mjs --ids a,b,c            # 直接吃注册表/隔离区条目（$0 预锻，不含真机读数）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const lineFile = path.join(ROOT, '.cfb-offline', 'ruler', 'gold-vs-line.json')
const lines = fs.existsSync(lineFile) ? (JSON.parse(fs.readFileSync(lineFile, 'utf8')).lines || {}) : {}
const uniq = (a) => [...new Set(a.filter(Boolean))]
const clip = (s, n) => { s = String(s).trim(); return s.length > n ? null : s }

function pickQuota(raw, res) {
  const sents = raw.split(/(?<=[.。!！?？])\s+|\n+/).map((x) => x.trim()).filter(Boolean)
  const ok = (s) => s.length >= 14 && s.length <= 150 && !/```/.test(s)
  const fixPat = /\b(fix|settle|must|should|remove|drop|change|replace|set |use )\b|改|删掉|换成|落点/i
  const decided = sents.filter((s) => /^(So |Actually, |OK, |Right, |Therefore|Thus|I need to|The (minimal|right|clean|correct)|Fix:|Let me (implement|do that|change))/i.test(s) || /\bFix:|That's the bug|the test should|use the isolated/i.test(s))
  const cand = uniq([...decided, ...sents.filter((s) => fixPat.test(s) && /`|\.js|\.mjs|env|null|true|false/.test(s))].map((s) => clip(s, 150)).filter((s) => s && ok(s)))
  res.fix = cand.find((s) => /fix|should|settle|null|isolated/i.test(s)) || null
  const excl = uniq(sents.filter((s) => /can't|cannot|not possible|without sudo|wrong|risky|no |doesn't|doesn/i.test(s) && !/^(So|Fix)/i.test(s)).map((s) => clip(s, 130)).filter((s) => s && ok(s)))
  res.excl = excl[0] || null
  const openQ = uniq(sents.filter((s) => /\?\s*$|maybe|but |or /i.test(s)).map((s) => clip(s, 120)).filter((s) => s && ok(s)))
  res.open = openQ[0] || null
  return res
}
function pickCmd(raw, ctx) {
  const ev = raw + '\n' + String(ctx || '')
  const inTick = [...ev.matchAll(/`([^`\n]{4,60})`/g)].map((m) => m[1].trim())
  const cmds = [...ev.matchAll(/(?:^|\s|;|\|)(?:taskset -c \d+ )?(node [\w./ -]+|npm test[^|;\n]{0,20}|npx [\w-]+|node verify\.mjs|node --test[\w .-]*)/g)].map((m) => m[1].trim().replace(/[.,;:]+$/, ''))
  const good = uniq([...cmds, ...inTick.filter((x) => /^(node|npm|npx)\b/.test(x))]).filter((c) => ev.includes(c) && /\b(node|npm test|npx)\b/.test(c))
  return good.sort((a, b) => a.length - b.length)[0] || null
}
function build(src) {
  const raw = String(src.raw || ''), ctx = String(src.ctx || '')
  const ev = raw + '\n' + ctx
  const r = pickQuota(raw, {})
  const cmd = pickCmd(raw, ctx)
  const bad = clip((raw.match(/expected [^\n。]{4,110}/i) || raw.match(/Error[^\n。]{4,110}/) || [])[0] || '', 110)
  const target = uniq((raw.match(/[\w./-]+\.(?:mjs|js|ts|json|log)/g) || []).filter((x) => ev.includes(x))).sort((a, b) => b.length - a.length)[0] || null
  const notes = []
  if (!r.fix) notes.push('抽不到原文落定句')
  if (!cmd) notes.push('抽不到原文里逐字存在的验证命令')
  const parts = []
  if (r.fix) parts.push(`已落定的决定（原文逐字）：「${r.fix.replace(/[`「」]/g, '')}」`)
  if (target) parts.push(`落点：${target}（只动这一处；` + (r.excl ? `其余路径原文已自证不必动：「${r.excl.replace(/[`「」]/g, '')}」` : `其余路径不动`) + '）')
  else if (r.excl) parts.push(`原文已自证不必动：「${r.excl.replace(/[`「」]/g, '')}」`)
  if (r.open) parts.push(`原文还悬着这句，但它不阻塞落 edit：「${r.open.replace(/[`「」]/g, '')}」`)
  if (cmd && (bad || r.fix)) parts.push(`验收：跑 ${'`' + cmd + '`'}。若不再报 ${bad ? `「${bad.replace(/[`「」]/g, '')}」` : '原判定失败'} ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 ${target || '上面的落点'} 继续查，不要改测试聚合方式。`)
  let draft = parts.join('\n\n')
  const rawLen = raw.length
  const line = lines[src.id]?.lineChars ?? Infinity
  const cap = Math.min(Math.floor(rawLen * 0.55), line)
  if (draft.length > cap) {
    const keep = draft.split('\n\n').filter((b, i) => i === 0 || i >= parts.length - 1)
    draft = keep.join('\n\n')
    if (draft.length > cap) { notes.push(`削到判读段仍超线（${draft.length}>${cap}）⇒ 该格 raw 太短/线太低，换早轮格子`); }
  }
  return { id: src.id, draft, notes, cmd, bad, target, fix: !!r.fix, cap, rawLen }
}
function check(id, draft, pendingPath) {
  const dir = path.join(ROOT, '.cfb-runtime', 'scratch', 'gold-forge')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `${id}.md`)
  fs.writeFileSync(f, draft + '\n')
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'gold-check.mjs'), ...(pendingPath ? ['--pending', pendingPath] : ['--id', id]), '--draft', f], { cwd: ROOT, encoding: 'utf8', timeout: 180000 })
    return { ok: /全过|\$0 判据全过|C1–C6/.test(out) && !/仍缺/.test(out), out }
  } catch (e) { const out = String(e.stdout || '') + String(e.stderr || ''); return { ok: false, out } }
}
const items = []
if (arg('--pending')) {
  for (const p of String(arg('--pending')).split(',').map((x) => x.trim()).filter(Boolean)) {
    const fp = path.resolve(ROOT, p)
    const real = fs.existsSync(fp) ? fp : path.join(path.dirname(fp), 'done', path.basename(fp))
    if (!fs.existsSync(real)) { console.log(`⤷ 跳过（找不到）：${p}`); continue }
    const j = JSON.parse(fs.readFileSync(real, 'utf8'))
    items.push({ id: j.id, raw: j.raw, ctx: j.ctx, calls: j.calls, pending: real })
  }
} else {
  const from = arg('--from', 'transfer/gold,transfer/gold-rejected').split(',').map((s) => path.join(ROOT, s.trim()))
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && !e.name.startsWith('audit-') ? [path.join(d, e.name)] : [])) : [])
  const want = arg('--ids', '').split(',').map((x) => x.trim()).filter(Boolean)
  const seen = new Set()
  for (const d of from) for (const f of walk(d)) { let g; try { g = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue } if (!g?.id || !g.raw || seen.has(g.id)) continue; seen.add(g.id); if (want.length && !want.includes(g.id)) continue; items.push({ id: g.id, raw: g.raw, ctx: g.ctx, calls: g.calls, pending: null }) }
}
const res = []
for (const it of items) {
  const b = build(it)
  if (b.notes.length) { res.push({ id: it.id, ok: false, needsManual: b.notes, draftChars: b.draft.length }); console.log(`⤷ ${it.id} needs-manual：${b.notes.join('；')}`); continue }
  const ck = check(it.id, b.draft, it.pending)
  res.push({ id: it.id, ok: ck.ok, draftChars: b.draft.length, cmd: b.cmd, target: b.target, report: ck.out.trim().split('\n').slice(0, 4).join(' | ') })
  console.log(`${ck.ok ? '✓' : '✗'} ${it.id.padEnd(34)} 稿 ${String(b.draft.length).padStart(4)} 字  ${ck.out.trim().split('\n').slice(0, 2).join('  ')}`)
  if (flag('--write') && it.pending) {
    const d = path.join(path.dirname(path.dirname(it.pending)), 'drafts')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${it.id}.md`), b.draft + '\n')
  }
}
fs.writeFileSync(path.join(ROOT, '.cfb-offline', 'ruler', 'gold-forge2.json'), JSON.stringify({ schema: 'cfb.gold-forge2/1', at: new Date().toISOString(), ok: res.filter((r) => r.ok).length, rows: res }, null, 2) + '\n')
console.log(`\n锻造 ${items.length} 条：$0 达线 ${res.filter((r) => r.ok).length} · 需人工 ${res.filter((r) => r.needsManual).length} · 未过 ${res.filter((r) => !r.ok && !r.needsManual).length}`)
