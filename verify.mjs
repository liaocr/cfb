#!/usr/bin/env node
/**
 * verify.mjs —— 一条命令跑完本包**全部**自测。
 *
 *   node verify.mjs            跑全部（18 个套件）
 *   node verify.mjs --json     机器可读输出
 *
 * 退出码 0 = 所有套件通过；非 0 = 有失败（并逐条列出）。
 * ⚠ 跑不起来的套件报 SKIP，**绝不**报 PASS —— 样本 != 总体。
 *
 * 纯 Node 内置模块，无第三方依赖，无硬编码路径 ⇒ 在任何机器/容器里都能跑。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const json = process.argv.includes('--json')

// 套件顺序：先纯函数层，再集成层（失败时定位最快）
const SUITES = [
  'test/balanced-span.selftest.mjs',
  'test/headroom.selftest.mjs',
  'test/imperative.selftest.mjs',
  'test/emitter.selftest.mjs',
  'test/state-memory.selftest.mjs',
  'test/provider-endpoint.selftest.mjs',
  'test/selftest.mjs',
  'test/selftest-birth.mjs',
  'test/optimization.selftest.mjs',
  'test/memory-quality.selftest.mjs',
  'test/incremental.selftest.mjs',
  'test/evidence-views.selftest.mjs',
  'test/late-identity.selftest.mjs',
  'test/hybrid.selftest.mjs',
  'test/grounding.selftest.mjs',
  'test/evidence-sharing.selftest.mjs',
  'test/efficiency.selftest.mjs',
  'test/coverage-provenance.selftest.mjs',
  'test/hedge.selftest.mjs',
]

const rows = []
for (const s of SUITES) {
  const f = path.join(HERE, s)
  if (!fs.existsSync(f)) { rows.push({ suite: s, status: 'SKIP', note: 'file missing', pass: 0, fail: 0 }); continue }
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 300000, cwd: HERE })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.error) { rows.push({ suite: s, status: 'SKIP', note: String(r.error.message).slice(0, 100), pass: 0, fail: 0 }); continue }
  // 各套件的计数格式不同，逐个认；认不出就不报数（绝不猜）
  let pass = 0, fail = 0, found = false
  let m = /PASS=(\d+)\s+FAIL=(\d+)/.exec(out)
  if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true }
  if (!found) { m = /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/.exec(out); if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true } }
  if (!found) { m = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(out); if (m) { pass = Number(m[1]); fail = Number(m[2]); found = true } }
  if (!found) {
    const p = /^PASS[: ]/m.test(out)
    if (p) { found = true; pass = (out.match(/^\s*PASS/gm) || []).length; fail = (out.match(/^\s*FAIL/gm) || []).length }
  }
  let skips = 0
  const ms = /SKIP=(\d+)/.exec(out)
  if (ms) skips = Number(ms[1])
  const bad = (out.split('\n').filter((l) => /FAIL/.test(l))[0] || '').trim().slice(0, 120)
  const status = r.status === 0 && fail === 0 ? 'PASS' : 'FAIL'
  rows.push({ suite: s, status, note: (status === 'PASS' ? (found ? pass + ' passed' : 'exit 0') : (bad || ('exit ' + r.status))) + (skips ? '  (' + skips + ' skipped)' : ''), pass, fail, skips })
}

const bad = rows.filter((r) => r.status !== 'PASS')
if (json) {
  console.log(JSON.stringify({ ok: bad.length === 0, rows }, null, 2))
} else {
  console.log('')
  for (const r of rows) {
    const tag = r.status === 'PASS' ? 'PASS' : (r.status === 'SKIP' ? 'SKIP' : 'FAIL')
    console.log('  ' + tag.padEnd(5) + r.suite.padEnd(40) + r.note)
  }
  const tp = rows.reduce((a, r) => a + r.pass, 0)
  const tf = rows.reduce((a, r) => a + r.fail, 0)
  const ts = rows.reduce((a, r) => a + (r.skips || 0), 0)
  console.log('')
  console.log('  合计: ' + tp + ' 通过 / ' + tf + ' 失败 / ' + ts + ' 跳过   (' + (rows.length - bad.length) + '/' + rows.length + ' 套件通过)')
  console.log(bad.length === 0 ? (ts ? '  ==> 已执行检查通过；存在跳过项，非完整宿主验证' : '  ==> 全部通过') : '  ==> 有失败，见上')
  console.log('')
}
process.exit(bad.length === 0 ? 0 : 1)
