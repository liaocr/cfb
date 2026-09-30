// 无损、会话隔离、带持久 HMAC 的本地块仓。只保存，不自动向模型回灌原文/失败制品。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalJson, evidenceDigest, immutableJson } from './evidence-program.js'
const STORES = new WeakSet()
export const isEvidenceStore = (value) => !!value && STORES.has(value)
const HEX = /^[0-9a-f]{64}$/
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
function noLinkDirectory(directory) {
  const absolute = path.resolve(directory)
  if (absolute === path.parse(absolute).root || absolute === path.resolve(process.cwd()) || absolute.split(path.sep).some((x) => ['.git', '.secrets'].includes(x))) throw new Error('unsafe-store-directory')
  let at = path.parse(absolute).root
  for (const part of absolute.slice(at.length).split(path.sep)) {
    at = path.join(at, part)
    if (!fs.existsSync(at)) fs.mkdirSync(at, { mode: 0o700 })
    const s = fs.lstatSync(at)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('store-directory-symlink')
  }
  return absolute
}
function readRegular(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const s = fs.fstatSync(fd)
    if (!s.isFile() || s.size > max) throw new Error('store-file-budget')
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}
export function createEvidenceStore({ directory, sessionId, maxBlobBytes = 8 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024 }) {
  if (typeof directory !== 'string' || !directory || typeof sessionId !== 'string' || !sessionId || !Number.isInteger(maxBlobBytes) || maxBlobBytes < 1 || maxBlobBytes > 16 * 1024 * 1024 || !Number.isInteger(maxTotalBytes) || maxTotalBytes < maxBlobBytes || maxTotalBytes > 128 * 1024 * 1024) throw new Error('store-schema')
  const base = noLinkDirectory(directory), scope = sha(sessionId), home = noLinkDirectory(path.join(base, scope)), keyPath = path.join(home, 'authority.key')
  let key
  try { key = readRegular(keyPath, 32) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }) } catch (e2) { if (e2.code !== 'EEXIST') throw e2 }
    key = readRegular(keyPath, 32)
  }
  if (key.length !== 32) throw new Error('store-authority-corrupt')
  const mac = (digest) => crypto.createHmac('sha256', key).update(digest).digest()
  const prefix = 'evd://' + scope.slice(0, 22) + '/'
  const stats = () => {
    let bytes = 0, files = 0, heads = 0
    for (const f of fs.readdirSync(home)) if (/^[a-f0-9]{64}\.json$/.test(f) || /^\.head-[a-z0-9_-]+\.json$/.test(f)) {
      const s = fs.lstatSync(path.join(home, f)); if (!s.isFile() || s.isSymbolicLink()) throw new Error('store-file-type')
      if (f.startsWith('.head-')) heads++; else files++
      bytes += s.size
    }
    return { files, heads, bytes, maxTotalBytes }
  }
  const getRecord = (handle, kind) => {
    if (typeof handle !== 'string' || !handle.startsWith(prefix) || !HEX.test(handle.slice(prefix.length))) throw new Error('handle-session-or-format')
    const id = handle.slice(prefix.length), record = JSON.parse(readRegular(path.join(home, id + '.json'), maxBlobBytes * 6 + 2048).toString('utf8'))
    const { digest, signature, ...body } = record
    if (body.schema !== 'cfb.evidence-blob/1' || body.scope !== scope || evidenceDigest(body) !== id || digest !== id || !/^[0-9a-f]{64}$/.test(signature) || !crypto.timingSafeEqual(mac(id), Buffer.from(signature, 'hex'))) throw new Error('blob-integrity')
    if (kind && body.kind !== kind) throw new Error('blob-kind')
    if (!['text', 'base64'].includes(body.encoding) || typeof body.data !== 'string') throw new Error('blob-encoding')
    return body
  }
  const put = (value, { kind = 'source' } = {}) => {
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind) || !(typeof value === 'string' || value instanceof Uint8Array)) throw new Error('blob-schema')
    const bytes = Buffer.byteLength(value), encoding = typeof value === 'string' ? 'text' : 'base64'
    if (bytes > maxBlobBytes) throw new Error('blob-budget')
    const body = { schema: 'cfb.evidence-blob/1', scope, kind, encoding, data: encoding === 'base64' ? Buffer.from(value).toString('base64') : value }
    const digest = evidenceDigest(body), handle = prefix + digest, file = path.join(home, digest + '.json')
    if (fs.existsSync(file)) { getRecord(handle, kind); return handle }
    const encoded = canonicalJson({ ...body, digest, signature: mac(digest).toString('hex') })
    if (stats().bytes + Buffer.byteLength(encoded) > maxTotalBytes) throw new Error('store-total-budget')
    // 独占内容地址：写完整临时文件后 link；不会覆盖别的生产者/已损坏的同名块。
    const tmp = path.join(home, '.writing-' + crypto.randomUUID())
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      try { fs.linkSync(tmp, file) } catch (e) { if (e.code !== 'EEXIST') throw e }
      getRecord(handle, kind)
    } finally { try { fs.unlinkSync(tmp) } catch { /* no scratch left */ } }
    return handle
  }
  const get = (handle, { kind } = {}) => { const r = getRecord(handle, kind); return r.encoding === 'base64' ? Buffer.from(r.data, 'base64') : r.data }
  const putJson = (value, { kind = 'json' } = {}) => put(canonicalJson(value), { kind })
  const getJson = (handle, { kind = 'json' } = {}) => immutableJson(JSON.parse(get(handle, { kind })))
  const headPath = (name) => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('head-name')
    return path.join(home, '.head-' + name + '.json')
  }
  const readHead = (name) => {
    let record
    try { record = JSON.parse(readRegular(headPath(name), 4096)) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    const { revision, signature, ...body } = record
    if (body.schema !== 'cfb.evidence-head/1' || body.scope !== scope || body.name !== name || !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
      !HEX.test(revision) || evidenceDigest(body) !== revision || !HEX.test(signature) || !crypto.timingSafeEqual(mac(revision), Buffer.from(signature, 'hex'))) throw new Error('head-integrity')
    getRecord(body.ref)
    return immutableJson({ ref: body.ref, revision, sequence: body.sequence })
  }
  const setHead = (name, ref, options) => {
    const file = headPath(name), lock = file + '.lock'
    let lockFd
    try { lockFd = fs.openSync(lock, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') throw new Error('head-conflict'); throw e }
    try {
      const current = readHead(name)
      if (!options || !Object.hasOwn(options, 'expectedRevision') || options.expectedRevision !== (current?.revision || null)) throw new Error('head-conflict')
      getRecord(ref)
      if (!current && stats().heads >= 64) throw new Error('head-budget')
      const body = { schema: 'cfb.evidence-head/1', scope, name, ref, sequence: (current?.sequence || 0) + 1, previousRevision: current?.revision || null }
      const revision = evidenceDigest(body), encoded = canonicalJson({ ...body, revision, signature: mac(revision).toString('hex') })
      if (stats().bytes - (current ? fs.statSync(file).size : 0) + Buffer.byteLength(encoded) > maxTotalBytes) throw new Error('store-total-budget')
      const tmp = path.join(home, '.writing-' + crypto.randomUUID())
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600)
        try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmp, file)
      } finally { try { fs.unlinkSync(tmp) } catch { /* renamed / absent */ } }
      return immutableJson({ ref, revision, sequence: body.sequence })
    } finally {
      try { fs.closeSync(lockFd) } finally { fs.unlinkSync(lock) }
      // 崩溃遗留锁不自动过期/抢锁，须宿主排查；安全性优先于自动可用性。
    }
  }
  const store = Object.freeze({ sessionId, directory: home, put, get, putJson, getJson, stats, readHead, setHead })
  STORES.add(store); return store
}
/** 一个轮制品的完整块表。RAW/EXPLANATION 无损保存，STEP 有类型，不做抽取式压缩。 */
export function archiveEvidenceArtifact(store, { raw, program }) {
  if (store.sessionId !== program.sessionId || typeof raw !== 'string') throw new Error('artifact-session')
  const blocks = [
    { id: 'raw', type: 'RAW', chars: raw.length, bytes: Buffer.byteLength(raw), handle: store.put(raw, { kind: 'raw' }) },
    { id: 'explanation', type: 'EXPLANATION', chars: program.explanation.length, bytes: Buffer.byteLength(program.explanation), handle: store.put(program.explanation, { kind: 'explanation' }) },
    ...program.steps.map((s) => ({ id: s.id, type: 'STEP', bytes: Buffer.byteLength(canonicalJson(s)), handle: store.putJson(s, { kind: 'step' }) })),
  ]
  const programRef = store.putJson(program, { kind: 'program' })
  const index = immutableJson({ schema: 'cfb.artifact-index/1', sessionId: program.sessionId, programId: program.id, contractDigest: program.contractDigest, programRef, blocks })
  return immutableJson({ programRef, indexRef: store.putJson(index, { kind: 'index' }), index })
}
export function recoverEvidenceBlock(store, indexRef, blockId) {
  const index = store.getJson(indexRef, { kind: 'index' })
  if (index.schema !== 'cfb.artifact-index/1' || index.sessionId !== store.sessionId) throw new Error('index-session')
  const b = index.blocks.find((b) => b.id === blockId)
  if (!b) throw new Error('block-not-found')
  return b.type === 'STEP' ? store.getJson(b.handle, { kind: 'step' }) : store.get(b.handle, { kind: b.type === 'RAW' ? 'raw' : 'explanation' })
}
