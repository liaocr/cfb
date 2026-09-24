// Lossless within-request representation sharing. Recording does NOT authorize
// omission across requests. Equal text does NOT merge event identity or status.
import crypto from 'node:crypto'
const terminal = t => t.result != null && ['completed', 'failed', 'cancelled'].includes(t.status)
function freezeRanges(ranges) { return Object.freeze(ranges.map(r => Object.freeze([...r]))) }
export function unionEvidenceRanges(ranges) {
  const out = []
  for (const [start, end] of ranges.map(r => [...r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw Error('invalid-evidence-range')
    const prev = out.at(-1)
    if (prev && start <= prev[1]) prev[1] = Math.max(prev[1], end)
    else out.push([start, end])
  }
  return freezeRanges(out)
}
export function compilerEvidence(tools = []) {
  const groups = new Map(), hashes = new Map(), events = []
  let v7BodyChars = 0
  const hashOf = text => { if (!hashes.has(text)) hashes.set(text, crypto.createHash('sha256').update(text).digest('hex')); return hashes.get(text) }
  const last = tools.map((t, i) => terminal(t) ? i : -1).filter(i => i >= 0).at(-1)
  for (const [i, t] of tools.entries()) {
    const raw = t.result == null ? '' : String(t.result), hasResult = terminal(t)
    const failure = !!t.isError || (typeof t.exitCode === 'number' && t.exitCode !== 0) || ['failed', 'cancelled'].includes(t.status)
    const limit = failure ? 8192 : i === last ? 4096 : 1200
    const headEnd = Math.min(raw.length, limit)
    const tailStart = Math.max(limit, raw.length - 1200)
    const requestedRanges = hasResult ? [[0, headEnd], ...(raw.length > limit && (failure || i === last) ? [[tailStart, raw.length]] : [])] : []
    let group = null
    if (hasResult) {
      // Key on exact text, not a truncated prefix or hash alone.
      group = groups.get(raw)
      if (!group) { group = { label: 'B' + (groups.size + 1), raw, hash: hashOf(raw), requested: [], views: new Set(), references: 0 }; groups.set(raw, group) }
      group.requested.push(...requestedRanges); group.references++
      // Diagnostic only: exactly the old v7 deduplication boundary.
      const key = JSON.stringify(requestedRanges)
      if (!group.views.has(key)) { group.views.add(key); v7BodyChars += requestedRanges.reduce((n, [a, b]) => n + b - a, 0) }
    }
    events.push({ t, raw, group, requestedRanges })
  }
  const bodies = [], rows = [], receipts = []
  let bodyChars = 0
  for (const group of groups.values()) {
    group.ranges = unionEvidenceRanges(group.requested)
    const segments = Object.freeze(group.ranges.map(([start, end]) => Object.freeze({ start, end, text: group.raw.slice(start, end) })))
    bodyChars += segments.reduce((n, s) => n + s.text.length, 0)
    bodies.push(Object.freeze({ label: group.label, sha256: group.hash, capturedChars: group.raw.length, ranges: group.ranges, segments }))
    group.rendered = `${group.references > 1 ? '共享正文' : '正文'} ${group.label} sha256=${group.hash} 已提供字符区间=${JSON.stringify(group.ranges)} 总字符=${group.raw.length}\n` + segments.map((s, i) => (i ? '\n〔中间未提供，不可假定已核验〕\n' : '') + s.text).join('')
  }
  if ([...groups.values()].some(g => g.references > 1)) rows.unshift('共享正文仅合并相同采集文本；调用、来源、执行结果及截断标记仍按各事件独立解释。')
  const emitted = new Set()
  for (const { t, raw, group, requestedRanges } of events) {
    if (group && !emitted.has(group.label)) { rows.push(group.rendered); emitted.add(group.label) }
    const ranges = group?.ranges || freezeRanges([])
    const sourceTruncated = !!(t.sourceTruncated ?? t.resultTruncated)
    const providedComplete = !!group && ranges.reduce((n, [a, b]) => n + b - a, 0) === raw.length && !sourceTruncated
    const args = typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? null)
    rows.push(`事件 callSeq=${t.seq ?? null} resultSeq=${t.resultSeq ?? null} id=${JSON.stringify(t.id)} tool=${JSON.stringify(t.name)} status=${t.status} exitCode=${t.exitCode ?? null} isError=${!!t.isError} 参数${args.length > 400 ? '片段' : ''}=${args.slice(0, 400)} 正文=${group ? group.label : 'pending：没有显式结果'} 上游截断标记=${sourceTruncated} 采集正文完整提供=${providedComplete}`)
    receipts.push(Object.freeze({ callSeq: t.seq ?? null, resultSeq: t.resultSeq ?? null, sha256: hashOf(raw),
      bodyLabel: group?.label || null, ranges, requestedRanges: freezeRanges(requestedRanges), sourceTruncated, providedComplete }))
  }
  return Object.freeze({ text: rows.join('\n\n'), bodyChars, receipts: Object.freeze(receipts), bodies: Object.freeze(bodies),
    duplicateBodyCharsAvoided: v7BodyChars - bodyChars,
    policy: 'all-visible-prefix+failure-and-latest-detail+shared-range-union-v2' })
}
