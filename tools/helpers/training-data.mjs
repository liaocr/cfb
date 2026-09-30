// 完整样本、私有HMAC审核、流式两遍构建；结构通过/旧Likert不成为训练许可。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { normalizeTrainingExample, trainingFingerprints, splitTrainingFingerprints, trainingExportRow, hasTrainingSecrets, CONSUMED_TRAINING_FAMILIES } from '../../src/training-core.js'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { isEvidenceStore } from '../../src/evidence-store.js'
import { privateTrainingPath } from './training-io.mjs'
import { assertSafePath, readJson, writeJson, syncDirectory } from './eval-files.mjs'
export { CONSUMED_TRAINING_FAMILIES } from '../../src/training-core.js'
const CHECKS = Object.freeze(['identifierSafe', 'completeNative', 'goalVerified', 'criterionFrozen'])
export function createTrainingReviews({ store, verify = null }) {
  if (!isEvidenceStore(store) || verify !== null && typeof verify !== 'function') throw new Error('training-review-authority')
  const read = () => { const head = store.readHead('training-reviews'); return { head, state: head ? store.getJson(head.ref, { kind: 'training-reviews' }) : { schema: 'cfb.training-reviews/1', refs: [], revoked: [] } } }
  const approveBatch = (records, { mode, reviewer, checks }) => {
    if (!verify || !['expert', 'objective', 'fixture'].includes(mode) || typeof reviewer !== 'string' || !reviewer || !Array.isArray(records) || !records.length || records.length > 1024 || !checks || CHECKS.some((k) => checks[k] !== true)) throw new Error('training-review-not-approved')
    const rows = records.map(normalizeTrainingExample)
    for (const r of rows) if (verify(r, immutableJson({ mode, reviewer, checks })) !== true) throw new Error('training-review-untrusted')
    const body = { schema: 'cfb.training-review/1', authorityId: store.authorityId, mode, reviewer, checks, records: rows.map((r) => r.digest).sort() }
    const ref = store.putJson(body, { kind: 'training-review' }), { head, state } = read()
    const refs = [...new Set([...state.refs, ref])]; if (refs.length > 1024) throw new Error('training-review-budget')
    store.setHead('training-reviews', store.putJson({ ...state, refs }, { kind: 'training-reviews' }), { expectedRevision: head?.revision || null })
    return immutableJson(rows.map((r) => ({ ...r, reviewRef: ref })))
  }
  const inspectWith = (record, state, cache = new Map(), refs = new Set(state.refs), revoked = new Set(state.revoked)) => {
    const r = normalizeTrainingExample(record)
    if (!r.reviewRef || !refs.has(r.reviewRef) || revoked.has(r.digest)) return null
    let c = cache.get(r.reviewRef)
    if (!c) { c = store.getJson(r.reviewRef, { kind: 'training-review' }); cache.set(r.reviewRef, c) }
    if (c.schema !== 'cfb.training-review/1' || c.authorityId !== store.authorityId || !c.records.includes(r.digest) || CHECKS.some((k) => c.checks[k] !== true)) return null
    return immutableJson({ authorityId: store.authorityId, ref: r.reviewRef, mode: c.mode, checksDigest: evidenceDigest(c.checks) })
  }
  const inspect = (record) => inspectWith(record, read().state)
  const snapshotInspector = () => { const snapshot = read(), cache = new Map(), refs = new Set(snapshot.state.refs), revoked = new Set(snapshot.state.revoked); return Object.freeze({ inspect: (r) => inspectWith(r, snapshot.state, cache, refs, revoked), revision: snapshot.head?.revision || null }) }
  const revoke = (digests) => {
    if (!Array.isArray(digests) || digests.some((d) => !/^[a-f0-9]{64}$/.test(d))) throw new Error('training-review-revocation')
    const { head, state } = read(), revoked = [...new Set([...state.revoked, ...digests])].sort(); if (revoked.length > 100000) throw new Error('training-review-budget')
    store.setHead('training-reviews', store.putJson({ ...state, revoked }, { kind: 'training-reviews' }), { expectedRevision: head?.revision || null })
  }
  return Object.freeze({ approveBatch, inspect, snapshotInspector, revoke, authorityId: store.authorityId, head: () => store.readHead('training-reviews') })
}
export async function* trainingJsonl(file, { maxBytes = 128 * 1024 * 1024, maxLineBytes = 1024 * 1024, maxRows = 100000 } = {}) {
  const absolute = assertSafePath(file), stream = fs.createReadStream(absolute, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), highWaterMark: 65536 })
  let pending = Buffer.alloc(0), bytes = 0, rows = 0
  const parse = (b) => { if (!b.length) return null; if (b.length > maxLineBytes) throw new Error('training-line-budget'); let r; try { r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) } catch { throw new Error('training-jsonl'); } if (++rows > maxRows) throw new Error('training-row-budget'); return r }
  try {
    for await (const chunk of stream) {
      bytes += chunk.length; if (bytes > maxBytes) throw new Error('training-input-budget')
      pending = Buffer.concat([pending, chunk]); let end
      while ((end = pending.indexOf(10)) >= 0) { const r = parse(pending.subarray(0, end)); pending = pending.subarray(end + 1); if (r !== null) yield r }
      if (pending.length > maxLineBytes) throw new Error('training-line-budget')
    }
    const r = parse(pending); if (r !== null) yield r
  } finally { stream.destroy() }
}
const blockedFamily = (row, forbidden) => forbidden.some((f) => [row.family, row.lineage, row.source.id].some((s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').includes(f.toLowerCase().replace(/[^a-z0-9]/g, ''))))
const writer = (file) => {
  const fd = fs.openSync(file, 'wx', 0o600), hash = crypto.createHash('sha256'); let rows = 0, bytes = 0, closed = false, summary = null
  return { append(r) { const b = Buffer.from(JSON.stringify(r) + '\n'); fs.writeSync(fd, b); hash.update(b); rows++; bytes += b.length }, close() { if (closed) return summary; closed = true; try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } summary = { rows, bytes, sha256: hash.digest('hex') }; return summary } }
}
export async function buildTrainingDataset({ input, output, reviews, seed = 'cfb-training-v1', forbiddenFamilies = [], objective = 'sft' }) {
  if (!reviews || typeof reviews.inspect !== 'function' || !['sft', 'preference'].includes(objective)) throw new Error('training-dataset-review-service')
  const root = privateTrainingPath(output, { directory: true })
  if (fs.existsSync(root)) throw new Error('training-dataset-output-exists')
  assertSafePath(path.dirname(root), { directory: true, createParents: true })
  const stage = fs.mkdtempSync(path.join(path.dirname(root), '.training-build-')), opened = [], summaries = {}, metadata = [], seen = new Set()
  let scanned = 0, quarantine = 0, simulated = false, inputDigest
  const reviewHead = reviews.head(), reader = reviews.snapshotInspector?.() || reviews, index = crypto.createHash('sha256')
  const blocked = [...new Set([...CONSUMED_TRAINING_FAMILIES, ...forbiddenFamilies])]
  try {
    const spoolPath = path.join(stage, 'eligible.jsonl'), spool = writer(spoolPath), bad = writer(path.join(stage, 'quarantine.jsonl')); opened.push(spool, bad)
    for await (const value of trainingJsonl(input)) {
      scanned++; let row, reason = null, certificate = null
      try { row = normalizeTrainingExample(value); index.update(row.digest + '\n') } catch (e) { reason = e.message.startsWith('training-') ? e.message : 'training-invalid-row' }
      if (row) {
        if (blockedFamily(row, blocked)) reason = 'training-consumed-family'
        else if (!row.source.trainingAllowed || !row.source.license.trim()) reason = 'training-rights-unconfirmed'
        else if (row.objective !== objective) reason = 'training-objective-mismatch'
        else if (seen.has(row.digest)) reason = 'training-duplicate-record'
        else { try { certificate = reader.inspect(row) } catch { certificate = null } if (!certificate) reason = 'training-review-missing-or-invalid' }
      }
      if (reason) {
        quarantine++; // 秘钥/非法材料不能落盘；其余完整候选留私有隔离区，不成为训练目标。
        bad.append({ line: scanned, reason, ...(row && reason !== 'training-secret-material' ? { record: row } : {}) }); continue
      }
      seen.add(row.digest); simulated ||= row.source.kind === 'fixture' || certificate.mode === 'fixture'
      spool.append(row); metadata.push({ digest: row.digest, fingerprints: trainingFingerprints(row), reviewRef: row.reviewRef })
    }
    inputDigest = index.digest('hex')
    if (reviews.head()?.revision !== reviewHead?.revision) throw new Error('training-review-changed-during-build')
    summaries.quarantine = bad.close(); summaries.spool = spool.close(); opened.length = 0
    if (!metadata.length) {
      const body = { schema: 'cfb.training-dataset/1', objective, inputDigest, reviewed: 0, quarantined: quarantine, scanned, status: 'quarantine-only', simulated, forbiddenFamilies: blocked, reviewAuthorityId: reviews.authorityId, reviewRevision: reviewHead?.revision || null, files: {} }
      writeJson(path.join(stage, 'manifest.json'), { ...body, digest: evidenceDigest(body) }); fs.renameSync(stage, root); syncDirectory(path.dirname(root)); return readJson(path.join(root, 'manifest.json'))
    }
    const split = splitTrainingFingerprints(metadata, { seed }), files = {}
    fs.mkdirSync(path.join(stage, 'export'), { mode: 0o700 }); fs.mkdirSync(path.join(stage, 'custody'), { mode: 0o700 })
    const out = Object.fromEntries(['train', 'selection', 'test'].map((s) => [s, writer(path.join(stage, s === 'test' ? 'custody/test.jsonl' : s + '.jsonl'))]))
    const wire = Object.fromEntries(['train', 'selection'].map((s) => [s, writer(path.join(stage, 'export', `${s}.${objective}.jsonl`))])); opened.push(...Object.values(out), ...Object.values(wire))
    const tokensEst = { train: 0, selection: 0, test: 0 }
    for await (const row of trainingJsonl(spoolPath)) {
      const s = split.assignment[row.digest]; out[s].append(row); tokensEst[s] += Buffer.byteLength(JSON.stringify(trainingExportRow(row)), 'utf8')
      if (s !== 'test') wire[s].append(trainingExportRow(row))
    }
    for (const s of ['train', 'selection', 'test']) files[s] = { path: s === 'test' ? 'custody/test.jsonl' : s + '.jsonl', ...out[s].close() }
    for (const s of ['train', 'selection']) files['export-' + s] = { path: `export/${s}.${objective}.jsonl`, ...wire[s].close() }
    opened.length = 0; fs.unlinkSync(spoolPath)
    const body = { schema: 'cfb.training-dataset/1', objective, inputDigest, status: 'prepared', scanned, reviewed: metadata.length, quarantined: quarantine, simulated,
      counts: split.counts, groups: split.groups, groupDigest: split.groupDigest, seed, tokenUpperEst: tokensEst, forbiddenFamilies: blocked,
      reviewAuthorityId: reviews.authorityId, reviewRevision: reviewHead.revision, files, recordsDigest: evidenceDigest(metadata.map((r) => r.digest).sort()) }
    writeJson(path.join(stage, 'manifest.json'), { ...body, digest: evidenceDigest(body) })
    fs.renameSync(stage, root); syncDirectory(path.dirname(root)); return readJson(path.join(root, 'manifest.json'))
  } catch (e) {
    for (const w of opened) try { w.close() } catch { /* own descriptors only */ }
    fs.rmSync(stage, { recursive: true, force: true }); throw e
  }
}
export async function auditTrainingDataset({ directory, reviews = null }) {
  const root = assertSafePath(directory, { directory: true }), manifest = readJson(path.join(root, 'manifest.json')), { digest, ...body } = manifest
  if (body.schema !== 'cfb.training-dataset/1' || evidenceDigest(body) !== digest || body.status !== 'prepared') throw new Error('training-dataset-manifest')
  if (reviews && reviews.authorityId !== body.reviewAuthorityId) throw new Error('training-dataset-authority-changed')
  const splitSeen = new Map(), ids = new Set(), expectedExports = { train: crypto.createHash('sha256'), selection: crypto.createHash('sha256') }; let checked = 0
  for (const [name, info] of Object.entries(body.files)) {
    if (!/^(?:train|selection)\.jsonl$|^custody\/test\.jsonl$|^export\/(?:train|selection)\.(?:sft|preference)\.jsonl$/.test(info.path)) throw new Error('training-dataset-file-path')
    const file = path.join(root, info.path), hash = crypto.createHash('sha256'); let bytes = 0
    for await (const b of fs.createReadStream(assertSafePath(file), { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) { hash.update(b); bytes += b.length }
    if (hash.digest('hex') !== info.sha256 || bytes !== info.bytes) throw new Error('training-dataset-file-drift')
    let n = 0
    for await (const value of trainingJsonl(file)) {
      n++
      if (name.startsWith('export-')) continue
      const row = normalizeTrainingExample(value)
      if (ids.has(row.digest)) throw new Error('training-dataset-duplicate'); ids.add(row.digest)
      if (reviews && !reviews.inspect(row)) throw new Error('training-review-revoked-or-drifted')
      const f = trainingFingerprints(row), links = ['family:' + f.family, 'lineage:' + f.lineage, 'input:' + f.input, ...f.targets.map((t) => 'target:' + t)]
      for (const k of links) { if (splitSeen.has(k) && splitSeen.get(k) !== name) throw new Error('training-dataset-leakage'); splitSeen.set(k, name) }
      if (name !== 'test') expectedExports[name].update(JSON.stringify(trainingExportRow(row)) + '\n')
      checked++
    }
    if (n !== info.rows) throw new Error('training-dataset-row-drift')
  }
  for (const split of ['train', 'selection']) if (expectedExports[split].digest('hex') !== body.files['export-' + split].sha256) throw new Error('training-export-not-record-equivalent')
  if (checked !== body.reviewed) throw new Error('training-dataset-count')
  return immutableJson({ schema: 'cfb.training-audit/1', ok: true, datasetDigest: digest, checked, simulated: body.simulated, testExported: false })
}
