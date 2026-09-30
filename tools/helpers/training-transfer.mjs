// 私有训练workspace加密搬迁：语料/审核authority/作业状态不以明文共享；基模型放独立缓存/持久卷。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evidenceDigest } from '../../src/evidence-program.js'
import { hasTrainingSecrets } from '../../src/training-core.js'
import { readBytes, readJson, writeBytes, writeJson, assertSafePath, syncDirectory } from './eval-files.mjs'
import { privateTrainingPath } from './training-io.mjs'
const MAGIC = Buffer.from('CFBTRAIN1\n'), MAX = 128 * 1024 * 1024
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex')
function key(passphrase, salt) { if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase) < 16) throw new Error('training-transfer-passphrase-required'); return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) }
function markerValue(file) { const r = readJson(file), { digest, ...b } = r; if (b.schema !== 'cfb.training-watermark/1' || evidenceDigest(b) !== digest) throw new Error('training-transfer-watermark'); return r }
function allowed(p) { return typeof p === 'string' && p.length < 500 && !p.startsWith('/') && p.split('/').every((x) => x && !['..', '.', '.git', '.secrets', '.env', 'keys.env'].includes(x)) && /\.(?:json|jsonl|bin|safetensors|pt|model|txt|key)$/.test(p) && (!p.endsWith('.key') || path.basename(p) === 'authority.key') }
function verifyPackedWatermarks(files, markers) {
  for (const { value: marker } of markers) {
    const found = files.find((f) => {
      if (!f.name.endsWith('/.head-training-session.json')) return false
      try { const h = JSON.parse(Buffer.from(f.data, 'base64').toString()); return h.revision === marker.revision && h.sequence === marker.sequence } catch { return false }
    })
    if (!found) throw new Error('training-transfer-inconsistent-state')
    const head = JSON.parse(Buffer.from(found.data, 'base64').toString()), prefix = found.name.slice(0, -'.head-training-session.json'.length), authority = files.find((f) => f.name === prefix + 'authority.key')
    if (!authority) throw new Error('training-transfer-inconsistent-state')
    const key = Buffer.from(authority.data, 'base64'), identity = crypto.createHmac('sha256', key).update('cfb.store-identity/1:' + head.scope).digest('hex')
    const { revision, signature, ...header } = head
    if (key.length !== 32 || identity !== marker.authorityId || evidenceDigest(header) !== revision || crypto.createHmac('sha256', key).update(revision).digest('hex') !== signature) throw new Error('training-transfer-inconsistent-state')
  }
}
export function exportTrainingWorkspace({ home, file, markerFiles = [], passphrase }) {
  key(passphrase, Buffer.alloc(16)); const root = privateTrainingPath(home, { directory: true }), output = assertSafePath(file, { createParents: true })
  if (output.startsWith(root + path.sep)) throw new Error('training-transfer-output-inside-home')
  const markers = markerFiles.map((p) => ({ name: path.basename(p), value: markerValue(p) })), files = []; let total = 0
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + e.name, p = path.join(dir, e.name)
      if (e.isSymbolicLink()) throw new Error('training-transfer-symlink')
      if (e.isDirectory()) { walk(p, name + '/'); continue }
      if (!allowed(name)) throw new Error('training-transfer-path')
      const b = readBytes(p, MAX); total += b.length; if (total > MAX || files.length >= 4096) throw new Error('training-transfer-budget-use-persistent-volume')
      if (/\.jsonl?$/.test(name) && hasTrainingSecrets(b.toString())) throw new Error('training-transfer-secret-material')
      files.push({ name, bytes: b.length, sha256: hash(b), data: b.toString('base64') })
    }
  }
  walk(root)
  verifyPackedWatermarks(files, markers)
  for (let i = 0; i < markerFiles.length; i++) if (markerValue(markerFiles[i]).digest !== markers[i].value.digest) throw new Error('training-transfer-state-changed')
  const payload = Buffer.from(JSON.stringify({ schema: 'cfb.training-workspace/1', originalHome: root, markers, files }))
  if (payload.length > MAX) throw new Error('training-transfer-budget-use-persistent-volume')
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt), iv), aad = Buffer.from('cfb.training-workspace/1'); cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]), header = Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag()]), data = Buffer.concat([header, encrypted])
  writeBytes(output, data, { exclusive: true }); return { encrypted: true, bytes: data.length, sha256: hash(data), files: files.length, externalApiCalls: 0 }
}
export function importTrainingWorkspace({ home, file, markerDirectory, passphrase }) {
  const data = readBytes(file, MAX + 128)
  if (data.length < MAGIC.length + 44 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('training-transfer-format')
  let payload
  try {
    const offset = MAGIC.length, salt = data.subarray(offset, offset + 16), iv = data.subarray(offset + 16, offset + 28), tag = data.subarray(offset + 28, offset + 44)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(passphrase, salt), iv); decipher.setAAD(Buffer.from('cfb.training-workspace/1')); decipher.setAuthTag(tag)
    payload = JSON.parse(Buffer.concat([decipher.update(data.subarray(offset + 44)), decipher.final()]).toString())
  } catch { throw new Error('training-transfer-auth') }
  if (payload.schema !== 'cfb.training-workspace/1' || !Array.isArray(payload.files) || payload.files.length > 4096 || !Array.isArray(payload.markers) || payload.markers.length > 256) throw new Error('training-transfer-schema')
  const root = privateTrainingPath(home, { directory: true }); if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('training-transfer-target-not-empty')
  assertSafePath(path.dirname(root), { directory: true, createParents: true }); const stage = fs.mkdtempSync(path.join(path.dirname(root), '.training-import-')), names = new Set(); let installed = false
  try {
    for (const m of payload.markers) {
      if (!/^[A-Za-z0-9_.-]+\.json$/.test(m.name)) throw new Error('training-transfer-marker-name')
      const { digest, ...body } = m.value; if (body.schema !== 'cfb.training-watermark/1' || evidenceDigest(body) !== digest) throw new Error('training-transfer-watermark')
      const target = path.join(markerDirectory, m.name)
      if (fs.existsSync(target)) { const old = markerValue(target); if (old.planDigest !== m.value.planDigest || old.authorityId !== m.value.authorityId || old.sequence > m.value.sequence || old.steps > m.value.steps || old.httpRequests > m.value.httpRequests || old.sequence === m.value.sequence && old.digest !== m.value.digest) throw new Error('training-transfer-stale-watermark') }
    }
    for (const f of payload.files) {
      if (!allowed(f.name) || names.has(f.name)) throw new Error('training-transfer-path'); names.add(f.name)
      const b = Buffer.from(f.data, 'base64'); if (b.length !== f.bytes || hash(b) !== f.sha256) throw new Error('training-transfer-file-integrity')
      writeBytes(path.join(stage, ...f.name.split('/')), b, { exclusive: true })
    }
    verifyPackedWatermarks(payload.files, payload.markers)
    fs.renameSync(stage, root); installed = true; syncDirectory(path.dirname(root))
    for (const m of payload.markers) writeJson(path.join(markerDirectory, m.name), m.value)
    return { restored: true, files: payload.files.length, originalHome: payload.originalHome, modelRequests: 0,
      next: '验证新位置数据集/基模型指纹后relocate，不更改逻辑planDigest/批准/已花额度。' }
  } finally { if (!installed) fs.rmSync(stage, { recursive: true, force: true }) }
}
