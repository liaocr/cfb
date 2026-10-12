// Distinguish explicitly sparse Git paths from genuinely missing evidence.
// Sparse checking is a scoped check, never a full-tree integrity receipt.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function sparseOmissions(root) {
  const config = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], { cwd: root, encoding: 'utf8' })
  if (config.status !== 0 || config.stdout.trim() !== 'true') return new Set()
  const result = spawnSync('git', ['ls-files', '-t', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('cannot-enumerate-sparse-index')
  return new Set(result.stdout.split('\0').filter((line) => line.startsWith('S ')).map((line) => line.slice(2)).filter((rel) => !fs.existsSync(path.join(root, rel))))
}

export function parseManifest(text) {
  const result = new Map()
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (!match) throw new Error(`invalid-manifest-line:${i + 1}`)
    const rel = match[2]
    if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((part) => !part || part === '..' || part === '.') || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`unsafe-manifest-path:${i + 1}`)
    }
    if (result.has(rel)) throw new Error(`duplicate-manifest-path:${rel}`)
    result.set(rel, match[1])
  }
  return result
}
