#!/usr/bin/env node
// judge-micro-predictions.mjs —— 把「微模型 dev 预测稿」跑一遍 7 轴判据（与教师同一实现）。
//
// 为什么必须用它：dev 上的 anchorRecall / exact_match 只是正则代理，不是验收。
// 验收 = 与训练同源的一套轴（M1 压缩 / M3 闭合 / M4 可执行 / M5 接地 / M6 无装置话术 /
// M7 决策不变 / M8 落点唯一），由 scoreBirthDraft 逐字复用生产判据计算。
//
// 诚实边界（照 GOLD-STANDARD）：E1/E2/R1/R2 仍是「未测」——需要把压缩块回喂真机，本数据没有。
// 同源测量只说明「学生学没学到尺子定义的好形状」，不构成对尺子本身的验证。
//
// 用法：
//   node tools/micro-generator/judge-micro-predictions.mjs \
//     --predictions <dev-predictions.jsonl> --corpus transfer/models/micro-generator-gen-v3 \
//     [--out <judgement.json>] [--examples 5]
//
// --predictions 里若缺 prediction 字段，或想自检口径，可加 --use-gold（用 gold 当预测跑一遍，
// 应与 corpus-report.json 的逐轴数字一致）。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreBirthDraft } from './forge-birth-units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argOf = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const AXES = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']

function readJsonlGz(p) {
  const buf = fs.readFileSync(p)
  const text = p.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 从语料行的 user 消息解出 unit.raw / unit.ctx（格式与 teach-shape 的 USER_TMPL 一致）。 */
function unitFromRow(row) {
  const user = (row.messages || []).find((m) => m.role === 'user')?.content || ''
  const m = user.match(/^【CONTEXT】\n([\s\S]*?)\n\n【RAW】\n([\s\S]*)$/)
  if (!m) throw new Error(`unitId ${row.unitId} 的 user 段不符合 【CONTEXT】/【RAW】格式`)
  return { unitId: row.unitId, ctx: m[1], raw: m[2], repo: row.repo, gold: (row.messages || []).slice(-1)[0]?.content || '' }
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

function main() {
  const predPath = argOf('predictions')
  const corpusDir = path.resolve(ROOT, argOf('corpus', 'transfer/models/micro-generator-gen-v3'))
  const outPath = argOf('out')
  const nEx = Number(argOf('examples', '5'))
  const useGold = process.argv.includes('--use-gold')
  if (!predPath) { console.error('缺 --predictions <jsonl[.gz]>'); process.exit(2) }

  const corpus = readJsonlGz(path.join(corpusDir, 'dev.jsonl.gz'))
  const byId = new Map(corpus.map((r) => [r.unitId, unitFromRow(r)]))
  const preds = readJsonlGz(path.resolve(ROOT, predPath))

  const rows = []
  for (const p of preds) {
    const u = byId.get(p.unitId)
    if (!u) { console.error(`[warn] 预测里的 unitId 不在评测集：${p.unitId}`); continue }
    const draft = useGold ? u.gold : (p.prediction ?? p.draft ?? '')
    const score = scoreBirthDraft({ raw: u.raw, ctx: u.ctx }, draft)
    const axis = Object.fromEntries(AXES.map((a) => [a, score.axes[a]?.pass ?? null]))
    rows.push({
      unitId: p.unitId, repo: u.repo, rawChars: u.raw.length, draftChars: draft.length,
      ratio: +(draft.length / Math.max(1, u.raw.length)).toFixed(4),
      axis, failed: AXES.filter((a) => axis[a] === false),
      notes: Object.fromEntries(AXES.map((a) => [a, score.axes[a]?.note || ''])),
      draft,
    })
  }

  const n = rows.length
  const axisPass = Object.fromEntries(AXES.map((a) => [a, rows.filter((r) => r.axis[a] === true).length]))
  const allPass = rows.filter((r) => r.failed.length === 0).length
  const summary = {
    schema: 'cfb.micro-generator-judgement/1',
    at: new Date().toISOString(),
    predictions: path.relative(ROOT, path.resolve(ROOT, predPath)), corpus: path.relative(ROOT, corpusDir),
    useGold, rows: n,
    axesAllPass: allPass, axisPass,
    axisPassRate: Object.fromEntries(AXES.map((a) => [a, +(axisPass[a] / Math.max(1, n)).toFixed(4)])),
    medianRatio: median(rows.map((r) => r.ratio)),
    ratioMin: rows.length ? Math.min(...rows.map((r) => r.ratio)) : null,
    ratioMax: rows.length ? Math.max(...rows.map((r) => r.ratio)) : null,
    medianRawChars: median(rows.map((r) => r.rawChars)),
    failuresByAxis: Object.fromEntries(AXES.map((a) => [a, rows.filter((r) => r.axis[a] === false).length])),
    boundaries: {
      measured: AXES, untested: ['M2', 'E1', 'E2', 'R1', 'R2'],
      note: 'E1/E2 仍需真机回喂（本轮不查）；同源测量不等于对尺子的验证。',
    },
  }

  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2))
  const worst = rows.filter((r) => r.failed.length).sort((a, b) => b.failed.length - a.failed.length).slice(0, nEx)
  if (worst.length) {
    console.log(`\n=== 失败最多的 ${worst.length} 条（每条截 240 字）===`)
    for (const w of worst) {
      console.log(`--- ${w.unitId} · ratio ${w.ratio} · 未过轴 ${w.failed.join(',')}`)
      for (const a of w.failed) console.log(`    ${a}: ${w.notes[a]}`)
      console.log('    稿:', w.draft.slice(0, 240).replace(/\n/g, ' ⏎ '))
    }
  }
  if (outPath) {
    fs.writeFileSync(path.resolve(ROOT, outPath), JSON.stringify({ summary, rows: rows.map(({ draft, ...r }) => r) }, null, 2))
    console.log(`\n[written] ${outPath}`)
  }
}

main()
