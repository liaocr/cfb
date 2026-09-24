#!/usr/bin/env node
/**
 * verify.mjs —— 一条命令跑完全部自测套件，给出**单一**通过/失败结论。
 *
 * 用法：
 *   node verify.mjs              跑全部套件（npm test 等价）
 *   node verify.mjs birth hedge  只跑文件名包含任一关键字的套件
 *   node verify.mjs --json       机器可读输出
 *
 * 套件 = test/ 下全部 *.selftest.mjs（自动发现）。ORDER 只决定运行顺序：先纯函数层，再集成层
 * （失败时定位最快）；目录里有、ORDER 里没有的套件照样跑（排在最后，并提示登记）。
 * ORDER 里登记了但文件不存在 ⇒ 判失败（防止测试被悄悄删掉而结论仍是「全部通过」）。
 *
 * 退出码 0 = 所有套件通过；非 0 = 有失败（并逐条列出）。
 * ⚠ 跑不起来的套件报 SKIP 且计为不通过，**绝不**报 PASS —— 样本 != 总体。
 *
 * 隔离：每个套件在**独立的临时 DSH_HOME** 里跑，跑完即删 ⇒ 自测绝不写真实 ~/.dsh。
 *   原 DSH_HOME（若有）经 CFB_REAL_DSH_HOME 传给套件，仅用于**只读**探测宿主兄弟包。
 *
 * 纯 Node 内置模块，无第三方依赖，无硬编码路径 ⇒ 在任何机器/容器里都能跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_DIR = path.join(HERE, 'test')
const SUFFIX = '.selftest.mjs'
const args = process.argv.slice(2)
const json = args.includes('--json')
const filters = args.filter((a) => !a.startsWith('--'))

// 运行顺序：纯函数层 → 核心 → birth → 持久化/证据 → 集成与观测
const ORDER = [
  'balanced-span', 'headroom', 'imperative', 'emitter', 'state-memory', 'provider-endpoint',
  'core', 'birth', 'optimization', 'memory-quality', 'snapshot-invariants', 'robustness',
  'late-identity', 'hybrid', 'grounding', 'evidence-sharing', 'efficiency', 'coverage-provenance', 'hedge',
]

const found = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(SUFFIX)).map((f) => f.slice(0, -SUFFIX.length))
const unlisted = found.filter((n) => !ORDER.includes(n)).sort()
const selected = [...ORDER, ...unlisted].filter((n) => !filters.length || filters.some((k) => n.includes(k)))

// 汇总行取**最后一个**匹配：套件自身输出里可能先出现同形字符串（如 JSON 片段）
function lastMatch(re, text) {
  let m, last = null
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  while ((m = g.exec(text)) !== null) last = m
  return last
}

const rows = []
for (const name of selected) {
  const suite = 'test/' + name + SUFFIX
  const f = path.join(HERE, suite)
  if (!fs.existsSync(f)) { rows.push({ suite, status: 'SKIP', note: 'ORDER 里登记了但文件不存在', pass: 0, fail: 0 }); continue }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-verify-home-'))
  const env = { ...process.env, DSH_HOME: home }
  if (process.env.DSH_HOME && String(process.env.DSH_HOME).trim()) env.CFB_REAL_DSH_HOME = process.env.DSH_HOME
  let r
  try { r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 300000, cwd: HERE, env }) }
  finally { fs.rmSync(home, { recursive: true, force: true }) }
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.error) { rows.push({ suite, status: 'SKIP', note: String(r.error.message).slice(0, 100), pass: 0, fail: 0 }); continue }
  // 各套件的计数格式不同，逐个认；认不出就不报数（绝不猜）
  let pass = 0, fail = 0, found = false
  let m = lastMatch(/PASS=(\d+)\s+FAIL=(\d+)/, out)
  if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true }
  if (!found) { m = lastMatch(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/, out); if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true } }
  if (!found) { m = lastMatch(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/, out); if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true } }
  if (!found && /^PASS[: ]/m.test(out)) { found = true; pass = (out.match(/^\s*PASS/gm) || []).length; fail = (out.match(/^\s*FAIL/gm) || []).length }
  const ms = lastMatch(/SKIP=(\d+)/, out)
  const skips = ms ? Number(ms[1]) : 0
  const firstBad = (out.split('\n').filter((l) => /FAIL|✗/.test(l) && !/FAIL=0\b/.test(l))[0] || '').trim().slice(0, 120)
  const status = r.status === 0 && fail === 0 ? 'PASS' : 'FAIL'
  rows.push({ suite, status, note: (status === 'PASS' ? (found ? pass + ' passed' : 'exit 0') : (firstBad || ('exit ' + r.status))) + (skips ? '  (' + skips + ' skipped)' : ''), pass, fail, skips })
}

const bad = rows.filter((r) => r.status !== 'PASS')
if (json) {
  console.log(JSON.stringify({ ok: bad.length === 0, unlisted, rows }, null, 2))
} else {
  console.log('')
  for (const r of rows) console.log('  ' + r.status.padEnd(5) + r.suite.padEnd(40) + r.note)
  const tp = rows.reduce((a, r) => a + r.pass, 0)
  const tf = rows.reduce((a, r) => a + r.fail, 0)
  const ts = rows.reduce((a, r) => a + (r.skips || 0), 0)
  console.log('')
  if (unlisted.length) console.log('  ⚠ 未登记运行顺序的套件（已自动纳入，请加进 verify.mjs 的 ORDER）：' + unlisted.join(', '))
  if (filters.length) console.log('  （按关键字过滤：' + filters.join(' ') + '，共 ' + rows.length + ' 个套件；不是全量结论）')
  console.log('  合计: ' + tp + ' 通过 / ' + tf + ' 失败 / ' + ts + ' 跳过   (' + (rows.length - bad.length) + '/' + rows.length + ' 套件通过)')
  console.log(bad.length === 0 ? (ts ? '  ==> 已执行检查通过；存在跳过项，非完整宿主验证' : '  ==> 全部通过') : '  ==> 有失败，见上')
  console.log('')
}
process.exit(bad.length === 0 && rows.length > 0 ? 0 : 1)
