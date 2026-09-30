// 训练大制品只放忽略目录/外部持久卷；流式指纹缓存而非把权重读进Node内存。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertSafePath } from './eval-files.mjs'
import { evidenceDigest } from '../../src/evidence-program.js'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export function privateTrainingPath(value, options = {}) {
  const p = assertSafePath(value, options), rel = path.relative(ROOT, p)
  if (!rel.startsWith('..') && rel !== '.cfb-runtime' && !rel.startsWith('.cfb-runtime' + path.sep)) throw new Error('training-private-output-must-be-ignored')
  return p
}
export async function fingerprintModelCache(directory, { adapter = false } = {}) {
  if (!directory || !fs.existsSync(directory)) return null
  const root = assertSafePath(directory, { directory: true }), files = {}
  let bytes = 0, weights = 0
  for (const name of fs.readdirSync(root).sort()) {
    if (!/\.(?:json|safetensors|model|txt)$/.test(name)) continue
    const file = assertSafePath(path.join(root, name)), st = fs.statSync(file)
    if (!st.isFile()) throw new Error('training-model-cache-file')
    const hash = crypto.createHash('sha256')
    for await (const b of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) hash.update(b)
    const after = fs.statSync(file)
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ino !== st.ino) throw new Error('training-model-cache-changed')
    files[name] = { bytes: st.size, sha256: hash.digest('hex') }; bytes += st.size; if (name.endsWith('.safetensors')) weights++
  }
  if (!(files[adapter ? 'adapter_config.json' : 'config.json']) || !weights) return null
  return { schema: 'cfb.base-model-cache/1', files, bytes, weights, digest: evidenceDigest(files) }
}
