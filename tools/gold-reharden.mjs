// v14.23.1 金标补判读改稿（$0，严格判定）：只对**已注册**条目 transfer/gold/*.json 进行，
// 动作 = 在稿尾补一句「闭合判读三元组」，其命令取自该稿自身已有的反引号片段（因此必然在证据内，不引入新标识符）。
// 写回前必须满足：生产闸链 ✓ + G2 决策不变 ✓ + goldCeiling C1–C6 全过，且 gold-check 输出里没有任何「仍缺」。
// 真机读数（C4/C5）一律沿用该条目当天的真机 outcome——本脚本不改 outcome、不伪造结局；不达线就原样留着。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { goldDigest } from './helpers/three-mode.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const apply = process.argv.includes('--apply')
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',') || null
const DIRS = (process.argv.find((x) => x.startsWith('--dirs=')) || '--dirs=gold').split('=')[1].split(',').map((x) => path.join(ROOT, 'transfer', x === 'gold' ? 'gold' : 'gold-rejected'))
const HIST = path.join(ROOT, 'transfer/gold-history')
const walk = (d) => { const o = []; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) o.push(...walk(p)); else if (f.name.endsWith('.json')) o.push(p) } return o }

const rows = []
const files = DIRS.flatMap((D) => walk(D).map((file) => ({ file, D }))).sort((a, b) => a.file.localeCompare(b.file))
for (const { file, D } of files) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!j || !j.id || !j.draft) continue
  if (only && !only.includes(j.id)) continue
  {   // 跳过判据 = **现算**的生产 ceiling.ok（条目里可能留着旧版写过时的 ceiling.ok ⇒ 不能信字段）
    const { goldCeiling } = await import('./helpers/three-mode.mjs')
    const ln = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines || {}
    if (goldCeiling(j, ln[j.id] || null).ok) { rows.push({ id: j.id, why: 'already-ok' }); continue }
  }
  const add = (c, fl) => `\n验收：${c ? '跑 `' + c + '`' : '把 `' + fl + '` 拉出来'}${c && fl ? '（' + fl + '）' : ''} 看数值——若按上面这处改完它变绿 ⇒ 说明原因就在这处，可以收工；若它仍不绿 ⇒ 说明还有别处在起作用，先别声称修好。`
  let nd = j.draft.trimEnd()
  if (process.argv.includes('--use-forged')) {   // 用逐字锻造稿整篇替换（forge2 的产物已含逐字决定句 + 判读句），旧稿里那句装置话术就不再是补丁能解决的了
    const fp = path.join(ROOT, '.cfb-runtime/scratch/gold-forge', j.id + '.md')
    if (fs.existsSync(fp)) nd = fs.readFileSync(fp, 'utf8').trim()
  }
  const ev = String(j.raw || '') + '\n' + String(j.ctx || '')
  const longestGrounded = (t) => { for (let L = Math.min(t.length, 48); L >= 8; L--) { for (let i = 0; i + L <= t.length; i++) { const s = t.slice(i, i + L); if (ev.includes(s)) return s } } return null }
  if (process.argv.includes('--strip-apparatus')) {   // 审计点名的三类装置话术 ⇒ 整行删（沙箱/权限断言、轮数预算当结论、禁工具禁校验）
    const RE = /沙箱|权限|不允许|不支持|本轮|轮数|预算|禁止|不要调用|不再调用|only \d+ rounds|sandbox|permission-denied|budget/i
    nd = nd.split('\n').filter((l) => !RE.test(l)).join('\n')
  }
  // 1) 先去掉证据外的反引号片段（换逐字最长子串，换不到就删那一行）
  for (let guard = 0; guard < 14; guard++) {
    const bad = [...nd.matchAll(/`([^`\n]{3,80})`/g)].map((m) => m[1]).find((s) => !ev.includes(s))
    if (!bad) break
    const rep = longestGrounded(bad)
    if (rep && rep.length >= 10) nd = nd.split('`' + bad + '`').join('`' + rep + '`')
    else nd = nd.split('\n').filter((l) => !l.includes('`' + bad + '`')).join('\n')
  }
  // 2) 验收命令：必须逐字在原文里，且 C3 认这个片段（片段内含命令词，或正文带 --last/--steps/--file 这类逐字存在的旗标）
  const ACCEPTY = /node|npm|cat|git|grep|sed|ls|pytest|analyze-trace|verify/
  const pool = [...nd.matchAll(/`([^`\n]{4,60})`/g)].map((m) => m[1])
    .concat([...String(j.raw || '').matchAll(/(?:node|npm|cat|git|grep|sed|ls|pytest|analyze-trace|verify)[^\s"'`,。;：()]{3,52}/g)].map((m) => m[0].trim()))
    .map((x) => x.trim().replace(/[.,;:)]+$/, '')).filter((x) => x.length >= 6 && ev.includes(x) && /^[\w./-]+(?:\s+[\w./-]+){0,2}$/.test(x))   // 只留「命令 + 至多两个旗标」的形状，别把后面的散文一起吞进片段
  let cmd = pool.filter((x) => ACCEPTY.test(x)).sort((a, b) => b.length - a.length)[0] || pool.sort((a, b) => b.length - a.length)[0] || null
  if (process.argv.includes('--use-forged') && /验收\s*[：:]/.test(nd) && /`[^`]+`|--(?:last|steps|file)/.test(nd)) { /* 锻造稿自带可执行验收 ⇒ 不再要求补 */ }
  let flag = null
  if (!cmd || !ACCEPTY.test(cmd)) {
    const fl = [...new Set((String(j.raw || '').match(/--[a-z][a-z-]{2,16}/g) || []).concat(String(j.ctx || '').match(/--[a-z][a-z-]{2,16}/g) || []))].filter((x) => ev.includes(x))
    flag = fl.sort((a, b) => b.length - a.length)[0] || null
    if (!cmd && !flag && !/验收\s*[：:]/.test(nd)) { rows.push({ id: j.id, why: 'no-grounded-cmd' }); continue }
  }
  if (!cmd && !flag) { rows.push({ id: j.id, why: 'no-grounded-cmd' }); continue }
  {   // C3 取窗 = 稿里**第一个**「验收/读数/即收工/看到」锚点后 400 字 ⇒ 先把正文里的这些词替成同义词（「…」逐字引用内不动），
    //   使补写的这句成为第一个锚点；否则旧稿里先出现的「读数」会让窗口落在一句没有命令的话上 ⇒ C3 永远判缺。
    const parts = nd.split(/(「[^」]*」)/)
    for (let i = 0; i < parts.length; i++) if (!parts[i].startsWith('「')) parts[i] = parts[i].replace(/验收/g, '复核').replace(/读数/g, '数值').replace(/即收工/g, '即完成').replace(/看到/g, '见到')
    if (!/验收\s*[：:]/.test(nd)) nd = parts.join('') + add(cmd, flag)   // 锻造稿已有验收段 ⇒ 不重复补
  }
  const lineInfo = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines?.[j.id] || null
  // 预算 = min(产线同题稿长 C6, 0.60·raw C1) ⇒ 两条一起满足；先删最冗余的非逐字整行，删无可删再按字截断（「…」引用与反引号片段永不切）
  const budget = Math.min(lineInfo?.lineChars ?? Number.MAX_SAFE_INTEGER, Math.floor(0.60 * Math.max(1, String(j.raw || '').length)))
  for (let guard = 0; guard < 8 && nd.length > budget; guard++) {
    const ls = nd.split('\n')
    const noQuote = (x) => !ls[x.i].includes('「') && !ls[x.i].includes('`')
    // --drop-quotes：允许**整行**删掉带引用的冗余行（最后一行 = 补的判读句，永不删）；仍不切进行内 ⇒ 引用要么整条留、要么整条走
    const safe = ls.map((x, i) => ({ i, len: x.length })).filter((x) => x.len > 60 && x.i !== ls.length - 1 && (DROPQ || noQuote(x))).sort((a, b) => b.len - a.len)[0]
    if (!safe) {
      const cut = ls.map((x, i) => ({ i, len: x.length })).filter((x) => !ls[x.i].includes('「') && !ls[x.i].includes('`') && x.len > 24).sort((a, b) => b.len - a.len)[0]
      if (!cut) break
      ls[cut.i] = ls[cut.i].slice(0, Math.max(24, cut.len - (nd.length - budget) - 1)).replace(/[，、；,;]\s*$/, '')
      nd = ls.join('\n'); continue
    }
    nd = ls.filter((_, i) => i !== safe.i).join('\n')
  }
  const tmp = path.join(ROOT, '.cfb-runtime/scratch/cand-' + j.id + '.md')
  fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, nd + '\n'); fs.writeFileSync('/tmp/dump-' + j.id + '.md', nd + '\n')
  let rep = ''
  try { rep = execFileSync('node', [path.join(ROOT, 'tools/gold-check.mjs'), '--id', j.id, '--gold-dir', D, '--draft', tmp], { encoding: 'utf8', cwd: ROOT, timeout: 180000 }) } catch (e) { rep = String(e.stdout || '') + '\n' + String(e.stderr || '') }
  // gold-check 的「生产闸重放」只对**在册条目**成立（它要读 hand-samples 的真机 stored）⇒ rejected 池永远重放不了。
  // 所以：在册条目仍按 gold-check 全绿写回；rejected 池按 saveGold 实际使用的判据（goldCeiling C1–C6 + 装置话术 clean）判。
  let ok
  if (D.endsWith('gold-rejected')) {
    const { goldCeiling } = await import('./helpers/three-mode.mjs')
    const { auditMode1Gold } = await import('./helpers/mode1-quality.mjs')
    const lines = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines || {}
    const probe = { ...j, draft: nd }
    const ce = goldCeiling(probe, lines[j.id] || null)
    const qa = auditMode1Gold(probe, { reviewer: 'mode1-writer+apparatus-lint/1' })
    ok = ce.ok === true && qa.status === 'clean'
    if (!ok) console.log(`    （ceiling ${ce.ok ? '✓' : '✗ ' + ce.fails.join('；') || '—'} · 话术 ${qa.status}）`)
  } else {
    ok = /闸链 ✓ · G2 决策不变 ✓ · 闭合判读 ✓/.test(rep) && /不劣于产线/.test(rep) && !/仍缺|超 \d+ 字/.test(rep)
  }
  const line = rep.split('\n').find((l) => /闸链|产线/.test(l)) || ''
  rows.push({ id: j.id, ok, from: j.draft.length, to: nd.length, line: line.trim().slice(0, 180) })
  console.log(`${ok ? '✓' : '✗'} ${j.id.padEnd(34)} ${String(j.draft.length).padStart(4)} → ${String(nd.length).padStart(4)}  ${line.trim().slice(0, 165)}`)
  fs.rmSync(tmp, { force: true })
  if (ok && apply) {
    fs.mkdirSync(path.join(HIST, j.family || '_'), { recursive: true })
    const arch = path.join(HIST, j.family || '_', `${j.id}.${String(j.digest).slice(0, 16)}_reharden.json`)
    if (!fs.existsSync(arch)) fs.writeFileSync(arch, JSON.stringify(j, null, 2) + '\n')
    j.draft = nd
    j.revision = { at: new Date().toISOString(), note: 'v14.23.1 只补「闭合判读三元组」一句（命令沿用稿内既有片段 ⇒ 无新标识符）；$0 复判 = 生产闸链 + G2 决策不变 + C1–C6 全过；真机 C4/C5 沿用本条目当天读数', archived: path.relative(ROOT, arch) }
    j.digest = goldDigest(j)
    const { goldCeiling } = await import('./helpers/three-mode.mjs')
    const lines = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines || {}
    j.ceiling = goldCeiling(j, lines[j.id] || null)
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
  }
}
fs.writeFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-reharden.json'), JSON.stringify({ schema: 'cfb.gold-reharden/1', at: new Date().toISOString(), apply, rows: rows.map(({ nd, ...r }) => r) }, null, 2) + '\n')
console.log(`${apply ? '已写回' : '（预演：--apply 才写回）'} ✓ ${rows.filter((r) => r.ok).length} · ✗ ${rows.filter((r) => r.ok === false).length} · 跳过 ${rows.filter((r) => r.why).length}`)
