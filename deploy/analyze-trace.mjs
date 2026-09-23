// Usage: node deploy/analyze-trace.mjs /path/to/trace.log
// Only anchored records are evidence. Never split on '[BOOT]' inside JSON text.
import fs from 'node:fs'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
export function createTraceAudit() {
  const groups = []; let current = null, ignored = 0, malformed = 0
  const fresh = (at, boot) => ({ start: at, boot: boot ? {
    selfId: boot.selfId ?? null, deps: boot.deps ?? null, mode: boot.mode ?? null,
    timeoutMs: boot.timeoutMs ?? null, birthFinishWaitMs: boot.birthFinishWaitMs ?? null,
  } : null, events: Object.create(null), settled: { ok: 0, failed: 0, unknown: 0 },
    reasons: Object.create(null), promptChars: [], durationMs: [], coverObserved: 0 })
  function add(line) {
    const m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/.exec(line)
    if (!m) { ignored++; return }
    let obj; try { obj = JSON.parse(m[3]) } catch { malformed++; return }
    if (!current || m[2] === 'BOOT') { current = fresh(m[1], m[2] === 'BOOT' ? obj : null); groups.push(current) }
    const tag = m[2]; current.events[tag] = (current.events[tag] || 0) + 1
    if (tag === 'state-envelope' && obj.cover) current.coverObserved++
    if (tag === 'birth-distill-settled') {
      if (obj.ok === true) current.settled.ok++
      else if (obj.ok === false) {
        current.settled.failed++
        const reason = typeof obj.reason === 'string' && obj.reason ? obj.reason : 'unknown-failure'
        current.reasons[reason] = (current.reasons[reason] || 0) + 1
        if (reason === 'unknown-failure') current.settled.unknown++
      }
      if (Number.isFinite(obj.promptChars) && obj.promptChars >= 0) current.promptChars.push(obj.promptChars)
      if (Number.isFinite(obj.ms) && obj.ms >= 0) current.durationMs.push(obj.ms)
    }
  }
  function stats(xs) {
    const s = [...xs].sort((a, b) => a - b)
    const q = p => s.length ? s[Math.ceil(p * s.length) - 1] : null
    return { n: s.length, p50: q(.5), p90: q(.9), max: s.length ? s.at(-1) : null }
  }
  return { add, result: () => ({ ignored, malformed, quantile: 'nearest-rank',
    warning: 'Per-BOOT samples only. Missing fields remain unknown; no causal or task-success claims.',
    groups: groups.map(g => ({ ...g, promptChars: stats(g.promptChars), durationMs: stats(g.durationMs) })) }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: node deploy/analyze-trace.mjs trace.log'); process.exitCode = 2 }
  else {
    const audit = createTraceAudit()
    for await (const line of readline.createInterface({ input: fs.createReadStream(process.argv[2]), crlfDelay: Infinity })) audit.add(line)
    console.log(JSON.stringify(audit.result(), null, 2))
  }
}
