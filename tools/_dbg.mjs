const I = await import('/home/user/cfb/index.js')
const L = await import('/home/user/cfb/tools/draft-lint.mjs')
const V = await import('/home/user/cfb/tools/v4-live.mjs')
const fs = await import('node:fs')
const recs = JSON.parse(fs.readFileSync('/home/user/live-all/recordings.json', 'utf8'))
const rows = JSON.parse(fs.readFileSync('/home/user/oracle/I.json', 'utf8')).rows
for (const id of ['perf-regression', 'sse-truncated']) {
  const t = V.TASKS.find((x) => x.id === id)
  const rec = recs.find((x) => x.id === id)
  const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
  const text = rows.find((r) => r.id === id).text
  const segs = L.tailSegments(text)
  console.log('==', id, 'segments', segs.length)
  for (const s of segs) console.log('  HEAD:', s.head.slice(0, 90), '| fix:', I.isFixBranch(s.head.slice(s.head.search(/(那么|就|则)/))))
  console.log('  lint', JSON.stringify(L.lintDraft(I, text, raw, t.user).items))
  console.log('  gate', JSON.stringify(I.compileV4Direct(text, raw, { compressCtx: t.user }).stats))
}
