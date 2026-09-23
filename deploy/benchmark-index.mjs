// Reproducible local microbenchmark against the actual original Git revision.
// Requires a Git checkout. No provider calls, no production session access.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = '5a4def6daed0da4e0d2678d36d398d80f258aef2'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-index-bench-'))
function run(mod) {
  let reads = 0
  const nodes = Array.from({ length: 1000 }, (_, i) => i)
  const session = { surface: { nodes }, eventAt: seq => {
    reads++
    return { seq, type: 'user/message', data: { origin: 'user', content: [{ type: 'text', text: 'evidence-' + seq }] } }
  } }
  const start = performance.now()
  mod.evidenceIndex(session)
  for (let i = 1000; i < 1100; i++) { nodes.push(i); mod.evidenceIndex(session) }
  return { eventAtCalls: reads, elapsedMs: +(performance.now() - start).toFixed(3), finalNodes: nodes.length }
}
try {
  const files = execFileSync('git', ['ls-tree', '--name-only', baseline], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f.endsWith('.js') || f === 'package.json')
  for (const f of files) fs.writeFileSync(path.join(tmp, f), execFileSync('git', ['show', baseline + ':' + f], { cwd: root }))
  const old = await import(pathToFileURL(path.join(tmp, 'index.js')))
  const current = await import(pathToFileURL(path.join(root, 'index.js')))
  const before = run(old), after = run(current)
  console.log(JSON.stringify({ scenario: '1000 surface nodes, then 100 one-node appends', baseline,
    before, after, eventReadsReducedPct: +(100 * (1 - after.eventAtCalls / before.eventAtCalls)).toFixed(3),
    scope: 'Synthetic local index microbenchmark only; not API latency or token savings.' }, null, 2))
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
