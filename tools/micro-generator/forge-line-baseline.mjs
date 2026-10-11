#!/usr/bin/env node
// forge-line-baseline.mjs —— 在同一批出生单元上跑**生产微编译器**（compileV5Local），
// 用**同一条尺子**（forge-birth-units.mjs 的 scoreBirthDraft）给产线稿打分，并与锻造稿对照。
//
// 这一步回答的问题（不是修辞问题，是要有读数的）：
//   1. 产线稿在同一情景上，7 条可测轴过几条？（预期：大面积挂——这就是"拟合器"在异分布上的形态）
//   2. 产线自己的生产闸（birthAccept：净省/发明标识符/接受条件）放不放行这些稿？
//   3. M2（不劣于产线）能不能接上：只有产线稿本身是"可用稿"时，M2 的长度比较才有意义；
//      否则 M2 继续记未测，产线稿改当"真实负例"入库。
//
// 零 API、零训练。用法：
//   node tools/micro-generator/forge-line-baseline.mjs \
//     --units <units.jsonl> [--units <units2.jsonl> ...] \
//     --out transfer/models/micro-generator-forge/forge-line-baseline.jsonl
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreBirthDraft } from './forge-birth-units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argAll = (name) => { const out = []; process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]) }); return out }

const unitsFiles = argAll('units')
const outArg = process.argv.indexOf('--out') > 0 ? process.argv[process.argv.indexOf('--out') + 1] : null
if (!unitsFiles.length) { console.error('需要 --units <file.jsonl>（可多次）'); process.exit(2) }

const I = await import(path.join(ROOT, 'src/compile-v5-local.js'))
const Birth = await import(path.join(ROOT, 'src/birth.js'))
const Cfg = await import(path.join(ROOT, 'src/config.js'))
const rows = []
for (const f of unitsFiles) {
  for (const line of fs.readFileSync(path.resolve(ROOT, f), 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line))
  }
}

const results = []
const axisIds = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
let acceptOk = 0, threw = 0, empty = 0
for (const unit of rows) {
  let lineText = '', meta = null, err = null
  try {
    const out = I.compileV5Local(unit.raw, { compressCtx: unit.ctx })
    lineText = String(typeof out === 'string' ? out : (out?.text || '')).trim()
    meta = out?.meta ?? null
    if (typeof out === 'object' && out && out.ok === false) err = 'not-ok:' + (out.reason || '?')
  } catch (e) { err = 'threw:' + e.message.slice(0, 80) }
  const lineChars = lineText.length
  if (!lineChars) empty++
  // 产线自己的生产闸（离线同判）：出生稿会不会被放行
  // 产线自己的生产闸（src/birth.js birthAccept：净省 / 发明标识符 / token 增益）离线同判
  let accept = null
  try {
    const cfg = Cfg.normalizeConfig({ compressCtx: unit.ctx })
    const a = Birth.birthAccept(unit.raw, lineText, cfg)
    accept = a.ok ? 'ok' : String(a.why) + (a.info && a.info.invented ? ':' + a.info.invented.slice(0, 2).join('|') : '')
    if (a.ok) acceptOk++
  } catch (e) { accept = 'threw:' + e.message.slice(0, 60) }
  const scored = lineChars ? scoreBirthDraft(unit, lineText) : null
  results.push({
    schema: 'cfb.birth-forge-line-baseline/1',
    unitId: unit.unitId,
    lineChars,
    rawChars: unit.rawChars,
    compressRatio: +(lineChars / Math.max(1, unit.rawChars)).toFixed(4),
    lineError: err,
    birthAccept: accept,
    status: scored?.status ?? null,
    failedMeasured: scored?.failedMeasured ?? null,
    unmeasured: scored?.unmeasured ?? null,
    axes: scored ? Object.fromEntries(axisIds.map((id) => [id, { value: scored.axes[id].value, pass: scored.axes[id].pass, note: scored.axes[id].note }])) : null,
    fixAlignmentProxy: scored?.fixAlignmentProxy ?? null,
    lineTextSample: lineText.slice(0, 240),
  })
}

if (outArg) {
  const out = path.resolve(ROOT, outArg)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`wrote ${results.length} line-baseline rows to ${path.relative(ROOT, out)}`)
}

const withText = results.filter((r) => r.lineChars > 0)
const passRate = (id) => `${withText.filter((r) => r.axes[id].pass === true).length}/${withText.length}`
console.log(`units: ${results.length} · line empty/error: ${results.length - withText.length} · birthAccept ok: ${acceptOk}`)
console.log('产线稿轴通过率：' + axisIds.map((id) => `${id} ${passRate(id)}`).join(' · '))
console.log('产线稿状态：' + JSON.stringify(Object.fromEntries(['gold', 'provisional-gold', 'not-gold'].map((s) => [s, withText.filter((r) => r.status === s).length]))))
const ratios = withText.map((r) => r.compressRatio).sort((a, b) => a - b)
if (ratios.length) console.log(`产线稿压缩率：min ${ratios[0]} · 中位 ${ratios[Math.floor(ratios.length / 2)]} · max ${ratios[ratios.length - 1]}`)
console.log('\n逐条（前 12）：')
for (const r of results.slice(0, 12)) {
  const a = r.axes || {}
  console.log(`${String(r.unitId).padEnd(44)} ${String(r.status || '-').padEnd(18)} ` +
    axisIds.map((id) => (a[id]?.pass === null ? '未测' : a[id]?.pass ? ' ✓ ' : ' ✗ ')).join(' ') + `  accept=${r.birthAccept}`)
}
