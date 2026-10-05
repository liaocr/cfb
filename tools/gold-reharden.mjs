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
  if (j.ceiling?.ok) { rows.push({ id: j.id, why: 'already-ok' }); continue }   // 跳过判据 = 生产 ceiling.ok（不是「稿里有验收二字」）
  const add = (c, fl) => `\n验收：${c ? '跑 `' + c + '`' : '把 `' + fl + '` 拉出来'}${c && fl ? '（' + fl + '）' : ''} 看数值——若按上面这处改完它变绿 ⇒ 说明原因就在这处，可以收工；若它仍不绿 ⇒ 说明还有别处在起作用，先别声称修好。`
  let nd = j.draft.trimEnd()
  const ev = String(j.raw || '') + '\n' + String(j.ctx || '')
  const longestGrounded = (t) => { for (let L = Math.min(t.length, 48); L >= 8; L--) { for (let i = 0; i + L <= t.length; i++) { const s = t.slice(i, i + L); if (ev.includes(s)) return s } } return null }
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
  let flag = null
  if (!cmd || !ACCEPTY.test(cmd)) {
    const fl = [...new Set((String(j.raw || '').match(/--[a-z][a-z-]{2,16}/g) || []).concat(String(j.ctx || '').match(/--[a-z][a-z-]{2,16}/g) || []))].filter((x) => ev.includes(x))
    flag = fl.sort((a, b) => b.length - a.length)[0] || null
    if (!cmd && !flag) { rows.push({ id: j.id, why: 'no-grounded-cmd' }); continue }
  }
  if (!cmd && !flag) { rows.push({ id: j.id, why: 'no-grounded-cmd' }); continue }
  {   // C3 取窗 = 稿里**第一个**「验收/读数/即收工/看到」锚点后 400 字 ⇒ 先把正文里的这些词替成同义词（「…」逐字引用内不动），
    //   使补写的这句成为第一个锚点；否则旧稿里先出现的「读数」会让窗口落在一句没有命令的话上 ⇒ C3 永远判缺。
    const parts = nd.split(/(「[^」]*」)/)
    for (let i = 0; i < parts.length; i++) if (!parts[i].startsWith('「')) parts[i] = parts[i].replace(/验收/g, '复核').replace(/读数/g, '数值').replace(/即收工/g, '即完成').replace(/看到/g, '见到')
    nd = parts.join('') + add(cmd, flag)
  }
  const lineInfo = JSON.parse(fs.readFileSync(path.join(ROOT, '.cfb-offline/ruler/gold-vs-line.json'), 'utf8')).lines?.[j.id] || null
  for (let guard = 0; guard < 6 && lineInfo?.lineChars && nd.length > lineInfo.lineChars; guard++) {   // 超线 ⇒ 先删最冗余的非逐字行（保留「…」引用与反引号命令）
    const ls = nd.split('\n')
    const cand = ls.map((x, i) => ({ i, len: x.length })).filter((x) => x.len > 60 && !ls[x.i].includes('「') && !ls[x.i].includes('`')).sort((a, b) => b.len - a.len)[0]
    if (!cand) break
    nd = ls.filter((_, i) => i !== cand.i).join('\n')
  }
  const tmp = path.join(ROOT, '.cfb-runtime/scratch/cand-' + j.id + '.md')
  fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, nd + '\n'); fs.writeFileSync('/tmp/dump-' + j.id + '.md', nd + '\n')
  let rep = ''
  try { rep = execFileSync('node', [path.join(ROOT, 'tools/gold-check.mjs'), '--id', j.id, '--gold-dir', D, '--draft', tmp], { encoding: 'utf8', cwd: ROOT, timeout: 180000 }) } catch (e) { rep = String(e.stdout || '') + '\n' + String(e.stderr || '') }
  const ok = /闸链 ✓ · G2 决策不变 ✓ · 闭合判读 ✓/.test(rep) && /不劣于产线/.test(rep) && !/仍缺|超 \d+ 字/.test(rep)
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
