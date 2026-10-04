// test/helpers/platform.mjs —— 平台能力探测（供各处显式跳过「本平台无法验证」的断言）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本平台是否允许创建符号链接（Windows 需开发者模式或管理员权限）。 */
export function canSymlink() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-symlink-probe-'))
  try {
    fs.symlinkSync(path.join(d, 'missing'), path.join(d, 'link'), 'file')
    return true
  } catch { return false } finally { fs.rmSync(d, { recursive: true, force: true }) }
}

/** 是否有 POSIX 权限位（Windows 的 chmod 不产生真实 mode）。 */
export const hasPosixMode = () => process.platform !== 'win32'

/** 可用的 Python 解释器（Windows 上 python3 可能是 Store 占位存根）。 */
export const POSIX = process.platform !== 'win32'
