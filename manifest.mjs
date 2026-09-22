#!/usr/bin/env node
/**
 * manifest.mjs —— 完整性清单（sha256）。
 *
 *   node manifest.mjs          重新生成 MANIFEST.sha256
 *   node manifest.mjs --check  逐文件校验，任何漂移都非零退出
 *
 * 为什么需要：这个包会被复制到别的机器/云端 workspace，
 * 「我拿到的是不是那份经过 928 项自测的代码」必须能用一条命令回答。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIST = path.join(HERE, 'MANIFEST.sha256')
const SELF = new Set(['MANIFEST.sha256'])

function walk(dir, base) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const abs = path.join(dir, e.name)
    const rel = base ? base + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(abs, rel))
    else if (!SELF.has(rel)) out.push(rel)
  }
  return out
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const files = walk(HERE, '').sort()

if (process.argv.includes('--check')) {
  if (!fs.existsSync(LIST)) { console.log('缺 MANIFEST.sha256，先跑 node manifest.mjs'); process.exit(2) }
  const want = new Map()
  for (const line of fs.readFileSync(LIST, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line.trim())
    if (m) want.set(m[2], m[1])
  }
  let bad = 0, missing = 0
  for (const f of files) {
    const abs = path.join(HERE, f)
    const got = sha(abs)
    if (!want.has(f)) { console.log('  新增(不在清单): ' + f); bad++; continue }
    if (want.get(f) !== got) { console.log('  漂移: ' + f + '\n    清单 ' + want.get(f).slice(0, 16) + '\n    实际 ' + got.slice(0, 16)); bad++ }
  }
  for (const f of want.keys()) {
    if (!fs.existsSync(path.join(HERE, f))) { console.log('  缺失: ' + f); missing++ }
  }
  console.log('')
  console.log('  文件 ' + files.length + ' 个；漂移/新增 ' + bad + '；缺失 ' + missing)
  process.exit((bad + missing) === 0 ? 0 : 1)
}

const lines = files.map((f) => sha(path.join(HERE, f)) + '  ' + f)
fs.writeFileSync(LIST, lines.join('\n') + '\n', 'utf8')
console.log('已写入 MANIFEST.sha256：' + files.length + ' 个文件')
