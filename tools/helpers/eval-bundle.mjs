// 私有仓迁移：只允许加密包，绝不把 authority/API钥匙放进Git或控制台。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evidenceDigest } from '../../src/evidence-program.js'
import { auditApiPlan, inspectApiBudget } from './api-budget.mjs'
import { apiStoreDirectory, readWatermark } from './api-watermark.mjs'
import { assertSafePath, readBytes, readJson, writeBytes, writeJson, syncDirectory } from './eval-files.mjs'
const MAGIC = Buffer.from('CFBSTATE1\n'), MAX = 64 * 1024 * 1024
const PASSWORD = (p) => { if (typeof p !== 'string' || Buffer.byteLength(p) < 16 || Buffer.byteLength(p) > 4096) throw new Error('eval-bundle-passphrase-required'); return p }
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
const keyOf = (p, salt) => crypto.scryptSync(PASSWORD(p), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const scopeHex = path.basename(apiStoreDirectory('unused'))
function allowedPath(p) {
  return typeof p === 'string' && (['plan.json', 'preflight.json', 'summary.json'].includes(p) || new RegExp('^ledger/' + scopeHex + '/(?:authority\\.key|[a-f0-9]{64}\\.json|\\.head-api-budget\\.json)$').test(p))
}
function collect(home) {
  const files = []; let bytes = 0
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + e.name, absolute = path.join(dir, e.name)
      if (e.isSymbolicLink()) throw new Error('eval-bundle-symlink')
      if (e.isDirectory()) {
        if (!['ledger', 'ledger/' + scopeHex].includes(relative)) throw new Error('eval-bundle-unexpected-path')
        walk(absolute, relative + '/')
      } else {
        if (!allowedPath(relative)) throw new Error('eval-bundle-unexpected-path')
        const b = readBytes(absolute, 32 * 1024 * 1024); bytes += b.length
        if (bytes > 32 * 1024 * 1024 || files.length >= 128) throw new Error('eval-bundle-budget')
        files.push({ path: relative, bytes: b.length, sha256: hash(b), data: b.toString('base64') })
      }
    }
  }
  walk(home); return files.sort((a, b) => a.path.localeCompare(b.path))
}
function encode(payload, passphrase) {
  const plain = Buffer.from(JSON.stringify(payload)), salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
  if (plain.length > MAX) throw new Error('eval-bundle-budget')
  const header = { schema: 'cfb.encrypted-eval-bundle/1', kdf: 'scrypt-16384-8-1', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), bytes: plain.length }
  const aad = Buffer.from(JSON.stringify(header)), cipher = crypto.createCipheriv('aes-256-gcm', keyOf(passphrase, salt), iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]), tag = cipher.getAuthTag()
  const size = Buffer.alloc(4); size.writeUInt32BE(aad.length)
  return Buffer.concat([MAGIC, size, aad, tag, ciphertext])
}
function decode(encoded, passphrase) {
  PASSWORD(passphrase)
  if (encoded.length < MAGIC.length + 4 || encoded.length > MAX + 8192 || !encoded.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('eval-bundle-format')
  const length = encoded.readUInt32BE(MAGIC.length), offset = MAGIC.length + 4
  if (length < 1 || length > 4096 || encoded.length < offset + length + 16) throw new Error('eval-bundle-format')
  let h; const aad = encoded.subarray(offset, offset + length)
  try { h = JSON.parse(aad.toString()) } catch { throw new Error('eval-bundle-format') }
  const salt = Buffer.from(h.salt || '', 'base64'), iv = Buffer.from(h.iv || '', 'base64')
  if (h.schema !== 'cfb.encrypted-eval-bundle/1' || h.kdf !== 'scrypt-16384-8-1' || h.cipher !== 'aes-256-gcm' || salt.length !== 16 || iv.length !== 12 || !Number.isSafeInteger(h.bytes) || h.bytes < 1 || h.bytes > MAX || encoded.length !== offset + length + 16 + h.bytes) throw new Error('eval-bundle-format')
  let payload
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(passphrase, salt), iv)
    decipher.setAAD(aad); decipher.setAuthTag(encoded.subarray(offset + length, offset + length + 16))
    const plain = Buffer.concat([decipher.update(encoded.subarray(offset + length + 16)), decipher.final()])
    payload = JSON.parse(plain.toString())
  } catch { throw new Error('eval-bundle-auth') }
  if (payload.schema !== 'cfb.eval-checkpoint/1' || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > 128) throw new Error('eval-bundle-payload')
  const names = new Set(); let total = 0
  for (const f of payload.files) {
    if (!allowedPath(f.path) || names.has(f.path) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || typeof f.data !== 'string') throw new Error('eval-bundle-path')
    names.add(f.path); const b = Buffer.from(f.data, 'base64'); total += b.length
    if (f.bytes !== b.length || f.sha256 !== hash(b) || total > 32 * 1024 * 1024) throw new Error('eval-bundle-integrity')
  }
  if (!names.has('plan.json')) throw new Error('eval-bundle-plan-missing')
  return payload
}
export function exportEvaluationBundle({ home, receiptPath, file, passphrase, replace = false }) {
  PASSWORD(passphrase); const root = assertSafePath(home, { directory: true })
  if (path.resolve(file).startsWith(root + path.sep)) throw new Error('eval-bundle-output-inside-state')
  const output = assertSafePath(file, { createParents: true }), lock = output + '.lock'
  let lease
  try { lease = fs.openSync(lock, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') throw new Error('eval-checkpoint-busy'); throw e }
  try {
    const plan = readJson(path.join(root, 'plan.json'))
    auditApiPlan(plan, { allowUnpriced: true })
    const marker = readWatermark(receiptPath), budget = inspectApiBudget({ plan, directory: path.join(root, 'ledger'), receiptPath })
    if (marker && !budget) throw new Error('api-budget-restore-required')
    const files = collect(root), after = readWatermark(receiptPath)
    if (marker?.digest !== after?.digest) throw new Error('eval-checkpoint-changed')
    if (budget) budget.snapshot()
    if (marker) {
      const f = files.find((f) => f.path === 'ledger/' + scopeHex + '/.head-api-budget.json')
      const h = f && JSON.parse(Buffer.from(f.data, 'base64').toString())
      if (!h || h.revision !== marker.revision || h.sequence !== marker.sequence) throw new Error('eval-checkpoint-changed')
    }
    const payload = { schema: 'cfb.eval-checkpoint/1', planDigest: evidenceDigest(plan), watermark: marker, files }
    if (replace && fs.existsSync(file)) {
      const old = decode(readBytes(file, MAX + 8192), passphrase)
      if (old.planDigest !== payload.planDigest || old.watermark && (!marker || old.watermark.authorityId !== marker.authorityId || old.watermark.sequence > marker.sequence || old.watermark.requests > marker.requests)) throw new Error('eval-bundle-stale-watermark')
    }
    const encoded = encode(payload, passphrase)
    if (marker?.digest !== readWatermark(receiptPath)?.digest) throw new Error('eval-checkpoint-changed')
    if (budget) budget.snapshot()
    writeBytes(file, encoded, { exclusive: !replace })
    return { schema: 'cfb.bundle-export/1', encrypted: true, bytes: encoded.length, sha256: hash(encoded), planDigest: payload.planDigest, requestsReserved: marker?.requests || 0 }
  } finally { fs.closeSync(lease); fs.unlinkSync(lock) }
}
/** 自动备份的只读前置检查，必须在初始化预算/读模型钥匙执行前完成。 */
export function assertAutoCheckpoint({ home, receiptPath, file, passphrase }) {
  PASSWORD(passphrase); assertSafePath(file)
  const root = assertSafePath(home, { directory: true })
  if (path.resolve(file).startsWith(root + path.sep)) throw new Error('eval-bundle-output-inside-state')
  if (fs.existsSync(file)) {
    const old = decode(readBytes(file, MAX + 8192), passphrase), plan = readJson(path.join(root, 'plan.json')), current = readWatermark(receiptPath)
    if (old.planDigest !== evidenceDigest(plan) || old.watermark && (!current || old.watermark.authorityId !== current.authorityId || old.watermark.sequence > current.sequence || old.watermark.requests > current.requests)) throw new Error('eval-bundle-stale-watermark')
  }
  return true
}
export function importEvaluationBundle({ home, receiptPath, file, passphrase }) {
  const payload = decode(readBytes(file, MAX + 8192), passphrase), root = assertSafePath(home, { directory: true })
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('eval-import-target-not-empty')
  const current = readWatermark(receiptPath), incoming = payload.watermark
  if (current && (!incoming || incoming.planDigest !== current.planDigest || incoming.authorityId !== current.authorityId || incoming.sequence < current.sequence || incoming.requests < current.requests || incoming.reservedNano < current.reservedNano || incoming.sequence === current.sequence && incoming.digest !== current.digest)) throw new Error('eval-bundle-stale-watermark')
  assertSafePath(path.dirname(root), { directory: true, createParents: true })
  const stage = fs.mkdtempSync(path.join(path.dirname(root), '.eval-import-')), stageReceipt = stage + '.watermark.json'
  let installed = false
  try {
    for (const f of payload.files) writeBytes(path.join(stage, ...f.path.split('/')), Buffer.from(f.data, 'base64'), { exclusive: true })
    const plan = readJson(path.join(stage, 'plan.json')); auditApiPlan(plan, { allowUnpriced: !incoming })
    if (evidenceDigest(plan) !== payload.planDigest) throw new Error('eval-bundle-plan-digest')
    if (incoming) {
      writeJson(stageReceipt, incoming, { exclusive: true })
      const budget = inspectApiBudget({ plan, directory: path.join(stage, 'ledger'), receiptPath: stageReceipt })
      if (!budget) throw new Error('eval-bundle-budget-missing')
      for (const e of budget.snapshot().entries) if (e.status === 'accepted') budget.cached(e.key)
    } else if (fs.existsSync(path.join(stage, 'ledger'))) throw new Error('eval-bundle-watermark-missing')
    // 私有树先完整验证再一次rename；不覆盖任何非空目标。双平面发布故障随后fail-closed。
    fs.renameSync(stage, root); installed = true; syncDirectory(path.dirname(root))
    if (incoming) writeJson(receiptPath, incoming, { exclusive: !current })
    return { schema: 'cfb.bundle-import/1', restored: true, planDigest: payload.planDigest, requestsReserved: incoming?.requests || 0, modelRequests: 0 }
  } finally {
    if (!installed) fs.rmSync(stage, { recursive: true, force: true })
    try { fs.unlinkSync(stageReceipt) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}
