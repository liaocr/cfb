// Append-only trajectory logs are event logs, not independent observations.
// Never resolve contradictory terminal results by silently taking the last row.
import crypto from 'node:crypto'

export function trajectoryKey(row) {
  const task = row?.fromState || row?.task
  const variant = row?.variant
  const sample = row?.sample
  if (typeof task !== 'string' || !task || typeof variant !== 'string' || !variant ||
      !((Number.isInteger(sample) && sample >= 0) || (typeof sample === 'string' && sample))) {
    throw new Error('trajectory-key-missing:task/variant/sample')
  }
  return JSON.stringify([task, variant, sample])
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, stable(value[k])]))
  }
  return value
}
export function trajectoryRecordDigest(row) {
  const { at, ...content } = row
  // Time alone cannot create a new independent sample. Every other field is evidence.
  return crypto.createHash('sha256').update(JSON.stringify(stable(content))).digest('hex')
}

export function auditTrajectoryRecords(events) {
  if (!Array.isArray(events)) throw new Error('trajectory-events-not-array')
  const groups = new Map(), invalid = []
  events.forEach((row, index) => {
    let key
    try {
      key = trajectoryKey(row)
      if (row.status != null && !['awaiting-draft', 'complete', 'completed', 'done'].includes(row.status)) throw new Error('unsupported-trajectory-status:' + row.status)
    }
    catch (e) { invalid.push({ line: index + 1, why: e.message }); return }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ row, line: index + 1 })
  })
  const rows = [], pending = [], errors = [], conflicts = [], duplicates = []
  for (const [key, group] of groups) {
    const terminal = group.filter(({ row }) => !row.error && row.status !== 'awaiting-draft')
    if (!terminal.length) {
      const last = group[group.length - 1].row
      if (last.error) errors.push(last)
      else pending.push(last)
      continue
    }
    const bySignature = new Map()
    for (const event of terminal) {
      const sig = trajectoryRecordDigest(event.row)
      if (!bySignature.has(sig)) bySignature.set(sig, [])
      bySignature.get(sig).push(event)
    }
    if (bySignature.size > 1) {
      conflicts.push({ key, lines: terminal.map((e) => e.line), signatures: [...bySignature.keys()] })
      continue
    }
    rows.push(terminal[0].row)
    if (terminal.length > 1) duplicates.push({ key, lines: terminal.map((e) => e.line) })
  }
  return { rows, pending, errors, conflicts, duplicates, invalid, eventCount: events.length, logicalKeys: groups.size }
}

export function requireUnambiguousTrajectories(events, label = 'results') {
  const result = auditTrajectoryRecords(events)
  if (result.invalid.length || result.conflicts.length) {
    throw new Error(`trajectory-evidence-ambiguous:${label}:invalid=${result.invalid.length}:conflicts=${result.conflicts.length}; quarantine and adjudicate, do not rerun or pick the last row`)
  }
  for (const row of result.rows) {
    const ref = row.reusedFrom
    if (ref && ((ref.sample != null && ref.sample !== row.sample) || (ref.task != null && ref.task !== row.task))) {
      throw new Error(`trajectory-source-identity-mismatch:${label}:task=${row.task}:sample=${row.sample}; reconstruct provenance, do not relabel or pick by position`)
    }
  }
  return result
}

export function reusableRawIndex(events, label = 'fork-from') {
  const result = requireUnambiguousTrajectories(events, label)
  const index = new Map()
  for (const row of result.rows) {
    if (row.variant !== 'raw' || !Array.isArray(row.roundMessages) || !row.roundMessages.length) continue
    index.set(trajectoryKey(row), row)
  }
  return index
}

export function findReusableRaw(index, task, sample) {
  return index.get(trajectoryKey({ task, variant: 'raw', sample })) || null
}
