import crypto from 'node:crypto'
export const EVIDENCE_VIEW_VERSION = 'utf16-chunks-v1'
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
export const validReceipt = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)

// Receipts certify inclusion in a successful compilation, NOT factual truth.
// Positions are JS UTF-16 offsets, not bytes or Unicode code-point counts.
export function selectEvidenceViews(tools, receipts = [], { budget = 6000, chunk = 600 } = {}) {
  budget = Number.isSafeInteger(budget) && budget >= 0 ? budget : 6000
  chunk = Number.isSafeInteger(chunk) && chunk > 1 && chunk <= 1000 ? chunk : 600
  const known = new Set(receipts.filter(validReceipt))
  const rows = (tools || []).map(t => ({ ...t }))
  const candidates = []
  let reused = 0, deferred = 0, used = 0
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]
    if (!['completed', 'failed', 'cancelled'].includes(t.status) || t.result == null) continue
    const raw = String(t.result)
    // Do not mint identities for results whose full source was already truncated.
    const trusted = Number.isSafeInteger(t.resultSeq) && t.resultSeq >= 0 && !t.resultTruncated
    const identity = JSON.stringify([EVIDENCE_VIEW_VERSION, t.resultSeq, t.id, t.name, t.args,
      t.status, t.exitCode, !!t.isError, !!t.argsTruncated, sha(raw), raw.length, chunk])
    const ranges = []
    for (let start = 0; start < raw.length;) {
      let end = Math.min(raw.length, start + chunk)
      // Never split a surrogate pair.
      if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]) && /[\uDC00-\uDFFF]/.test(raw[end])) end--
      ranges.push([start, end]); start = end
    }
    if (!ranges.length) ranges.push([0, 0])
    // Head, tail, then interior: boundaries first, eventual interior progress.
    const order = ranges.length > 1 ? [ranges[0], ranges.at(-1), ...ranges.slice(1, -1)] : ranges
    let chosen
    for (const [start, end] of order) {
      const key = trusted ? sha(identity + ':' + start + ':' + end) : null
      if (key && known.has(key)) { reused++; continue }
      chosen = { start, end, key }; break
    }
    t.result = null; t.resultTruncated = true
    t.resultDeferred = chosen ? '正文未纳入本轮；不是结果为空，也不是尚未执行。' : '各可见区间已由完整快照承载；不是新增观察。'
    if (chosen) candidates.push({ i, raw, chosen, failed: t.status === 'failed' || t.isError })
  }
  // Failed results first, then newest. All unselected events retain metadata.
  candidates.sort((a, b) => Number(b.failed) - Number(a.failed) || b.i - a.i)
  for (const c of candidates) {
    const { start, end, key } = c.chosen, t = rows[c.i], size = end - start
    if (used + size > budget) { deferred++; continue }
    used += size
    t.result = c.raw.slice(start, end)
    t.resultDeferred = null
    t.resultTruncated = start !== 0 || end !== c.raw.length || !!tools[c.i].resultTruncated
    t.evidenceView = `${EVIDENCE_VIEW_VERSION} [${start},${end})/${c.raw.length}`
    t.viewReceipt = key
  }
  return { tools: rows, stats: { bodyChars: used, deferred, reused, version: EVIDENCE_VIEW_VERSION } }
}
