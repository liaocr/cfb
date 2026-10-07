#!/usr/bin/env node
/**
 * manifest.mjs —— 项目交付树的 SHA-256 清单（非全 Git 跟踪树校验）。
 *
 *   node manifest.mjs          重新生成 MANIFEST.sha256
 *   node manifest.mjs --check  对清单范围逐文件校验，任何漂移都非零退出
 *
 * 范围由 .gitignore 驱动；本地/再生状态目录（包括被 Git 强制跟踪但仍匹配忽略规则的 .cfb-runtime/.cfb-offline 资产）有意不进入此清单。
 * 因此它回答的是「交付树里的文件是否漂移」，不回答「所有 Git 跟踪文件是否逐一校验」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIST = path.join(HERE, 'MANIFEST.sha256')
const SELF = new Set(['MANIFEST.sha256'])

/**
 * 忽略规则**从 .gitignore 读取**，而不是再维护一份硬编码副本。
 *
 * 为什么必须这样：清单会被推到远端，而 CI 是**干净检出** —— 被 .gitignore 排除的文件在
 * CI 里根本不存在。之前这里维护着一份与 .gitignore 重复的固定列表，两边一旦不同步
 * （例如新加了 .cfb-offline/ 或 eval-profile.json），本地生成的清单就会收录那些文件，
 * 于是 CI 的 --check 必然报「缺失」而失败。单一事实来源只能有一个。
 */
function ignoreRules() {
  const file = path.join(HERE, '.gitignore')
  const dirs = new Set(['.git'])          // 版本库元数据永远排除
  const names = new Set()                 // 按文件名/后缀匹配的简单规则
  const globs = []                        // 其余模式
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { dirs, names, globs } }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) { globs.push(line); continue }
    const negated = false
    if (line.endsWith('/')) { dirs.add(line.slice(0, -1)); continue }
    // 形如 *.log / *.bak-* / *.py[cod] 的后缀模式
    if (/^\*\.[\w[\]-]+$/.test(line)) { globs.push(line); continue }
    // 前导 '/' 在 .gitignore 里表示「锚定仓库根」；我们按路径段/文件名匹配，去掉它即可，
    // 否则 '/eval-profile.json' 会变成 '^/eval-profile\.json$' 而永远匹配不到 'eval-profile.json'。
    if (line.startsWith('/')) line = line.slice(1)
    if (!line.includes('/') && !line.includes('*')) { names.add(line); continue }
    globs.push(line)
  }
  return { dirs, names, globs }
}
const IGNORE = ignoreRules()
/** 把 .gitignore 的反斜杠无关模式转成正则（仅支持本仓实际用到的子集）。 */
function ignoredByName(name) {
  if (IGNORE.names.has(name)) return true
  for (const g of IGNORE.globs) {
    if (g.startsWith('!')) continue
    const rx = new RegExp('^' + g.replace(/[.+^$(){}|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\[([^\]]+)\]/g, '[$1]') + '$')
    if (rx.test(name)) return true
  }
  return false
}

function walk(dir, base) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // 与 .gitignore 对齐的生成物目录：本地量过覆盖率（c8 → coverage/）再生成清单，曾把几十个本地文件写进清单，
    // 干净的 CI 检出里它们不存在 ⇒ --check 必然失败。只收录真正属于包的文件。
    if (IGNORE.dirs.has(e.name)) continue
    if (ignoredByName(e.name)) continue
    const abs = path.join(dir, e.name)
    const rel = base ? base + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(abs, rel))
    else if (!SELF.has(rel)) out.push(rel)
    // 注：单个文件的忽略（*.log / *.bak / *.pyc / eval-profile.json）统一由上面的 ignoredByName 处理。
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
