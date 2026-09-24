// Limits concern this plugin's evidence-v1 tree, not the host's shared CAS.
// Reservations precede writes: a crash can over-account, never under-account.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
export const STORAGE_LIMITS = Object.freeze({ globalBytes: 256 * 1024 * 1024, scopeBytes: 64 * 1024 * 1024, globalFiles: 100000, scopeFiles: 20000 })
function census(root) {
  const state = { schema: 1, bytes: 0, files: 0, scopes: {} }
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[a-f0-9]{64}$/.test(d.name)) continue
    const scope = state.scopes[d.name] = { bytes: 0, files: 0 }
    for (const f of fs.readdirSync(path.join(root, d.name), { withFileTypes: true })) {
      if (!f.isFile() || f.name === 'index.lock') continue
      const size = fs.statSync(path.join(root, d.name, f.name)).size
      scope.bytes += size; scope.files++; state.bytes += size; state.files++
    }
  }
  return state
}
function save(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file)
}
export function boundedEvidenceWrite(file, text, exclusive = false) {
  return boundedEvidenceBatch([{ file, text, exclusive }])
}
export function boundedEvidenceBatch(writes) {
  if (!writes.length) return
  const scopeDir = path.dirname(writes[0].file), key = path.basename(scopeDir), root = path.dirname(scopeDir)
  if (writes.some(w => path.dirname(w.file) !== scopeDir)) throw Error('evidence-batch-scope-mismatch')
  const lock = path.join(root, '.quota.lock'), usage = path.join(root, '.usage.json')
  let fd
  try { fd = fs.openSync(lock, 'wx') } catch (e) { if (e.code === 'EEXIST') throw Error('evidence-quota-busy'); throw e }
  try {
    const state = fs.existsSync(usage) ? JSON.parse(fs.readFileSync(usage, 'utf8')) : census(root)
    if (state.schema !== 1 || !Number.isSafeInteger(state.bytes) || !Number.isSafeInteger(state.files) || !state.scopes) throw Error('invalid-evidence-quota')
    const scoped = state.scopes[key] ||= { bytes: 0, files: 0 }
    if ([state.bytes, state.files, scoped.bytes, scoped.files].some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('invalid-evidence-quota')
    const planned = writes.map(w => ({ ...w, old: fs.existsSync(w.file) ? fs.statSync(w.file).size : null }))
    if (planned.some(w => w.exclusive && w.old !== null)) throw Object.assign(Error('exists'), { code: 'EEXIST' })
    const size = planned.reduce((n, w) => n + Buffer.byteLength(w.text), 0), files = planned.length, l = STORAGE_LIMITS
    // Reserve the temporary peak as well as final data. Only two accounting
    // writes per observation batch, not two per body/metadata file.
    if (state.bytes + size > l.globalBytes || scoped.bytes + size > l.scopeBytes || state.files + files > l.globalFiles || scoped.files + files > l.scopeFiles) throw Error('evidence-quota-exceeded')
    state.bytes += size; scoped.bytes += size; state.files += files; scoped.files += files
    save(usage, state)
    for (const w of planned) {
      const tmp = w.exclusive ? w.file : w.file + '.' + crypto.randomUUID() + '.tmp'
      try { fs.writeFileSync(tmp, w.text, { flag: 'wx', mode: 0o600 }); if (!w.exclusive) fs.renameSync(tmp, w.file) }
      catch (e) { if (e.code !== 'EEXIST') { try { fs.unlinkSync(tmp) } catch {} }; throw e }
      if (w.old !== null) { state.bytes -= w.old; scoped.bytes -= w.old; state.files--; scoped.files-- }
    }
    save(usage, state)
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
// Offline reconciliation is deliberately explicit. No age-based deletion of
// live artifacts: a view in a model message may still reference an old body.
export function auditEvidenceStorage(root, reconcile = false) {
  if (fs.existsSync(path.join(root, '.quota.lock'))) throw Error('active quota writer; stop host before reconciliation')
  for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'index.lock'))) throw Error('active/stale ledger lock; inspect before reconciliation')
  const measured = census(root)
  if (reconcile) save(path.join(root, '.usage.json'), measured)
  return { limits: STORAGE_LIMITS, measured, reconciled: reconcile, requiresStoppedHost: true, deletionPerformed: false }
}

export function collectEvidenceGarbage(root) {
  const lock = path.join(root, '.quota.lock')
  const fd = fs.openSync(lock, 'wx')
  try {
    const candidates = []
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !/^[a-f0-9]{64}$/.test(d.name)) continue
      const dir = path.join(root, d.name), keep = new Set()
      if (fs.existsSync(path.join(dir, 'index.lock'))) throw Error('ledger active/stale; stop host and inspect lock before GC')
      const addRecord = r => { if (r.bodyPath) { keep.add(path.basename(r.bodyPath)); keep.add(r.bodyHash + '.cas.json') }; if (r.id) keep.add(r.id + '.json') }
      const index = path.join(dir, 'index.json')
      if (fs.existsSync(index)) {
        const state = JSON.parse(fs.readFileSync(index, 'utf8'))
        for (const r of Object.values(state.records)) addRecord(JSON.parse(fs.readFileSync(r.recordPath, 'utf8')))
      }
      for (const name of fs.readdirSync(dir)) if (/^view-[a-f0-9]{64}\.json$/.test(name)) {
        const view = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        for (const record of view.records) addRecord(record)
      }
      for (const name of fs.readdirSync(dir)) if (/^[a-f0-9]{64}(\.txt|\.json|\.cas\.json)$/.test(name) && !keep.has(name)) candidates.push(path.join(dir, name))
    }
    let bytes = 0
    for (const file of candidates) { bytes += fs.statSync(file).size; fs.unlinkSync(file) }
    const measured = census(root); save(path.join(root, '.usage.json'), measured)
    return { deletedFiles: candidates.length, deletedBytes: bytes, measured, policy: 'unreferenced-only; no TTL deletion of live views, records or evidence', requiresStoppedHost: true }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
