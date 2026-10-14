const MARK = '\n\n[思考过程]\n'
const PREFIX = '[题面]\n'

export function parseStrictJsonl(text, label = 'jsonl') {
  const out = []
  for (const [i, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) }
    catch { throw new Error(`eval-sft-invalid-json:${label}:${i + 1}`) }
  }
  return out
}
function devEntry(row, index) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || row.id.trim() !== row.id || typeof row.user !== 'string' || typeof row.assistant !== 'string') {
    throw new Error(`eval-sft-invalid-dev-row:${index + 1}`)
  }
  if (!row.user.startsWith(PREFIX)) throw new Error(`eval-sft-invalid-dev-prompt-prefix:${row.id}`)
  const at = row.user.indexOf(MARK, PREFIX.length)
  if (at < 0 || row.user.indexOf(MARK, at + MARK.length) >= 0) throw new Error(`eval-sft-invalid-dev-thinking-marker:${row.id}`)
  return { id: row.id, ctx: row.user.slice(PREFIX.length, at), raw: row.user.slice(at + MARK.length), draft: row.assistant }
}
export function pairDevGenerations(devRows, generatedRows) {
  if (!Array.isArray(devRows) || !devRows.length || !Array.isArray(generatedRows)) throw new Error('eval-sft-input-arrays-required')
  const dev = [], devIds = new Set(), duplicateDev = []
  for (const [i, row] of devRows.entries()) {
    const item = devEntry(row, i)
    if (devIds.has(item.id)) duplicateDev.push(item.id)
    else { devIds.add(item.id); dev.push(item) }
  }
  const generated = new Map(), duplicateGenerated = [], unknown = [], invalid = []
  for (const [i, row] of generatedRows.entries()) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || row.id.trim() !== row.id || typeof row.raw !== 'string' || typeof row.ctx !== 'string' || typeof row.draft !== 'string') {
      invalid.push(i + 1); continue
    }
    if (generated.has(row.id)) { duplicateGenerated.push(row.id); continue }
    generated.set(row.id, row)
    if (!devIds.has(row.id)) unknown.push(row.id)
  }
  const missing = [...devIds].filter((id) => !generated.has(id))
  const rawMismatch = [], ctxMismatch = []
  for (const d of dev) {
    const g = generated.get(d.id)
    if (!g) continue
    if (g.raw !== d.raw) rawMismatch.push(d.id)
    if (g.ctx !== d.ctx) ctxMismatch.push(d.id)
  }
  const faults = []
  if (duplicateDev.length) faults.push('duplicate-dev-ids')
  if (duplicateGenerated.length) faults.push('duplicate-generation-ids')
  if (unknown.length) faults.push('unknown-generation-ids')
  if (missing.length) faults.push('missing-generation-ids')
  if (invalid.length) faults.push('invalid-generation-rows')
  if (rawMismatch.length) faults.push('generation-raw-mismatch')
  if (ctxMismatch.length) faults.push('generation-ctx-mismatch')
  if (faults.length) {
    const detail = { faults, duplicateDev, duplicateGenerated, unknown, missing, invalidLines: invalid, rawMismatch, ctxMismatch }
    throw new Error('eval-sft-incomplete-or-mismatched-coverage:' + JSON.stringify(detail))
  }
  const pairs = dev.map((d) => ({ teacher: d, generated: generated.get(d.id) }))
  if (pairs.length !== devRows.length || pairs.length !== generatedRows.length) throw new Error('eval-sft-cardinality-mismatch')
  return Object.freeze({ pairs: Object.freeze(pairs), expected: devRows.length, observed: generatedRows.length, missing: Object.freeze([]), unexpected: Object.freeze([]), duplicateIds: Object.freeze([]) })
}
