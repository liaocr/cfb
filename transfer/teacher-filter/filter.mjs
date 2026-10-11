// 只读过滤：教师 v4-full 逐行过 goldCeiling（C1 压缩力度 / C2 闭合判读 / C3 可执行验收）。
// 不写入教师文件；输出为新文件 candidates.tsv（只有 id 与闸门标志，不含稿文本）。
// 用法：node transfer/teacher-filter/filter.mjs   （cwd = cfb/）
import fs from 'node:fs'
import { goldCeiling } from '../../tools/helpers/three-mode.mjs'
const SRC = '.cfb-offline/teacher/v4-full.jsonl'
const OUT = 'transfer/teacher-filter/candidates.tsv'
const rows = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const head = ['id', 'family', 'rawChars', 'draftChars', 'floor3100', 'C1', 'C2', 'C3', 'passesCeilingGate', 'failReasons']
const lines = [head.join('\t')]
let pass = 0, floor = 0
for (const r of rows) {
  const raw = String(r.raw || ''), draft = String(r.draft || '')
  const g = { raw, draft, stored: draft, outcome: {} }
  const res = goldCeiling(g, null) || {}
  const fails = res.fails || []
  const c1 = !fails.some((x) => x.startsWith('C1')), c2 = !fails.some((x) => x.startsWith('C2')), c3 = !fails.some((x) => x.startsWith('C3'))
  const ok = c1 && c2 && c3
  const f3100 = raw.length >= 3100
  if (f3100) floor++
  if (ok) pass++
  lines.push([r.id, r.family ?? '', raw.length, draft.length, f3100 ? 1 : 0, c1 ? 1 : 0, c2 ? 1 : 0, c3 ? 1 : 0, ok ? 1 : 0, fails.map((x) => x.split('：')[0]).join('|')].join('\t'))
}
fs.writeFileSync(OUT, lines.join('\n') + '\n')
console.log(JSON.stringify({ rows: rows.length, floor3100: floor, passesCeilingGate: pass, out: OUT, source: SRC, sourceModified: false }))
