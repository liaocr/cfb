// 评测状态的普通文件 IO；所有错误码不复制输入/凭据正文。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
export function assertSafePath(file, { directory = false, createParents = false } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('eval-path')
  const absolute = path.resolve(file), parts = absolute.split(path.sep)
  if (absolute === path.parse(absolute).root || parts.some((p) => ['.git', '.secrets'].includes(p)) || /^(?:keys\.env|\.env|\.credentials.*)$/.test(path.basename(absolute))) throw new Error('eval-path-protected')
  let at = path.parse(absolute).root
  for (const part of absolute.slice(at.length).split(path.sep)) {
    at = path.join(at, part)
    const leaf = at === absolute
    if (!fs.existsSync(at)) {
      // lstat 仍能识别悬空符号链接。
      try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error('eval-path-symlink') } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (createParents && (!leaf || directory)) fs.mkdirSync(at, { mode: 0o700 })
      else continue
    }
    const st = fs.lstatSync(at)
    if (st.isSymbolicLink()) throw new Error('eval-path-symlink')
    if ((!leaf || directory) && !st.isDirectory() || leaf && !directory && !st.isFile()) throw new Error('eval-path-type')
  }
  return absolute
}
export function readBytes(file, maxBytes = 64 * 1024 * 1024) {
  const absolute = assertSafePath(file), fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > maxBytes) throw new Error('eval-file-budget'); return fs.readFileSync(fd) }
  finally { fs.closeSync(fd) }
}
export function readJson(file, maxBytes = 8 * 1024 * 1024) {
  let value
  try { value = JSON.parse(readBytes(file, maxBytes).toString('utf8')) } catch (e) { if (e.code === 'ENOENT' || /^eval-/.test(e.message)) throw e; throw new Error('eval-json') }
  return value
}
export function syncDirectory(directory) {
  let fd
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd) } catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(e.code)) throw e }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
export function writeBytes(file, data, { exclusive = false } = {}) {
  const absolute = assertSafePath(file, { createParents: true }), tmp = path.join(path.dirname(absolute), '.eval-writing-' + crypto.randomUUID())
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (exclusive) fs.linkSync(tmp, absolute)
    else fs.renameSync(tmp, absolute)
    syncDirectory(path.dirname(absolute))
  } finally { try { fs.unlinkSync(tmp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  return absolute
}
export const writeJson = (file, value, options) => writeBytes(file, JSON.stringify(value, null, 2) + '\n', options)
export function hasSecretMaterial(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /(?:\bsk-[a-zA-Z0-9_-]{20,}\b|\bgithub_pat_[a-zA-Z0-9_]{20,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b)/.test(text)
}
