// tools/cfb-corpus.mjs —— 把「生产 trace + 历史实跑记录」编译成一份可复用的离线语料。
//
// 一次性产出（全部零 API）：
//   .cfb-offline/corpus.json     生产块轨迹 + 实跑效果行 + 候选 + 判据标注
//   .cfb-offline/split.json      按「任务族」的确定性切分（题不跨集，防止候选调优偷看）
//   .cfb-offline/report.md       人读的一页摘要
//
// 用法：node tools/cfb-corpus.mjs [--trace <path>] [--out <.cfb-offline>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readTraceEvents, rebuildTrajectories, funnelOf, annotate, gateDraft, kItemsOf, writeJson, ensureDir } from './helpers/offline-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')


export const DEFAULT_TRACE = (() => {
  const candidates = [
    process.env.CFB_TRACE,
    path.join(os.homedir(), '.dsh', 'storages', 'cot-form-b', 'trace.log'),
  ].filter(Boolean)
  return candidates.find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) || candidates[1]
})()

const readRows = (p) => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.rows || []) }

/** 历史实跑：把 transfer/ 下每一轮的 chains + 稿 + 结果折成候选。缺文件就跳过，绝不编造。 */
export function loadRecordedRuns(root = ROOT) {
  const runs = []
  const chainsPath = path.join(root, 'transfer/mr/chains.json')
  if (!fs.existsSync(chainsPath)) return runs
  const chains = (() => { const j = JSON.parse(fs.readFileSync(chainsPath, 'utf8')); return j.chains || j })()
  const d1 = path.join(root, 'transfer/direct-d9a-r.json')
  const d2 = path.join(root, 'transfer/mr/auto-d2d.json')
  const byId = {}
  if (fs.existsSync(d1)) for (const r of readRows(d1)) byId[r.id] = byId[r.id] || {}
  for (const r of fs.existsSync(d1) ? readRows(d1) : []) byId[r.id].d1 = r.text
  for (const r of fs.existsSync(d2) ? readRows(d2) : []) byId[r.id] = { ...(byId[r.id] || {}), d2: r.text }
  for (const c of chains) {
    const ctx = [c.u1, c.a1 && c.a1.content, c.u2, c.a2 && c.a2.content].filter(Boolean).join('\n')
    const cands = []
    if (c.a1 && c.a1.raw || c.a2 && c.a2.raw) cands.push({ kind: 'raw', id: c.id, text1: c.a1 && c.a1.raw, text2: c.a2 && c.a2.raw })
    if (byId[c.id] && byId[c.id].d1) cands.push({ kind: 'auto-d1', id: c.id, text1: byId[c.id].d1 })
    if (byId[c.id] && byId[c.id].d2) cands.push({ kind: 'auto-d2', id: c.id, text2: byId[c.id].d2 })
    runs.push({ id: c.id, ctx, verifyCmd: c.verifyCmd, a1Call: c.a1Call, a2Edit: c.a2Edit, candidates: cands })
  }
  return runs
}

/** 主入口：编译语料。 */
export function buildCorpus({ root = ROOT, tracePath = DEFAULT_TRACE, outDir = path.join(root, '.cfb-offline') } = {}) {
  const warnings = []
  // ── 生产侧
  let production = { available: false, reason: null, funnel: null, tasks: 0, blocks: 0, tags: {} }
  if (tracePath && fs.existsSync(tracePath)) {
    const { events } = readTraceEvents(tracePath)
    for (const e of events) production.tags[e.tag] = (production.tags[e.tag] || 0) + 1
    const trajs = rebuildTrajectories(events)
    production = { ...production, available: true, runAt: new Date().toISOString(), bytes: fs.statSync(tracePath).size,
      funnel: funnelOf(trajs), tasks: trajs.tasks.length, blocks: trajs.tasks.reduce((n, t) => n + t.blocks.length, 0),
      events: events.length }
  } else warnings.push('trace 不可用，生产轨迹为空（不影响实跑语料）')

  // ── 实跑侧
  const runs = loadRecordedRuns(root)
  if (!runs.length) warnings.push('transfer/mr/chains.json 不可用，实跑语料为空')
  const items = []
  for (const r of runs) {
    for (const c of r.candidates) {
      for (const [slot, text] of [['d1', c.text1], ['d2', c.text2]]) {
        if (typeof text !== 'string' || !text) continue
        const gate = gateDraft(text, r.ctx)
        const ann = annotate(text, { expectClaim: null })
        // 全文随语料一起存：下游（标注 / 打分 / 排序）必须自包含，不能回头再去读 transfer/
        items.push({ key: r.id + '|' + c.kind + '|' + slot, task: r.id, kind: c.kind, slot, chars: text.length,
          text, ctx: r.ctx, gateOk: gate.ok, invented: gate.invented.length, k: kItemsOf(text).count, claim: ann.claim,
          greenAsProof: ann.greenAsProof, citesSymptom: ann.citesSymptom, citesFreshness: ann.citesFreshness })
      }
    }
  }

  // ── 确定性切分：按任务排序后 60/20/20，任务不跨集
  const ids = [...new Set(runs.map((r) => r.id))].sort()
  const n = ids.length
  const cut = (f) => Math.max(1, Math.round(n * f))
  const split = { train: ids.slice(0, cut(0.6)), dev: ids.slice(cut(0.6), cut(0.8)), test: ids.slice(cut(0.8)) }

  const corpus = { schema: 'cfb.offline-corpus/1', builtAt: new Date().toISOString(), production, runs: runs.length, items, split, warnings }
  ensureDir(outDir)
  writeJson(path.join(outDir, 'corpus.json'), corpus)
  writeJson(path.join(outDir, 'split.json'), { schema: 'cfb.offline-split/1', ...split, rule: '按任务 id 排序后 60/20/20，题不跨集' })

  const lines = ['# 离线语料（零 API）', '', '生成: ' + corpus.builtAt, '',
    '- 生产 trace: ' + (production.available ? production.bytes + ' 字节 / ' + production.events + ' 事件 / ' + production.blocks + ' 块' : '不可用'),
    '- 实跑任务: ' + runs.length + ' ；候选行: ' + items.length,
    '- 切分: train ' + split.train.length + ' / dev ' + split.dev.length + ' / test ' + split.test.length, '']
  if (production.funnel) {
    const f = production.funnel
    lines.push('## 生产漏斗', '', '| 块 | 值 |', '| --- | --- |',
      '| 起火 | ' + f.fired + ' |', '| 蒸馏成功 | ' + f.distilled + ' |', '| 蒸馏失败 | ' + f.distillFailed + ' |',
      '| 完成态拼接 | ' + f.condensed + ' |', '| 直通 | ' + f.passthrough + ' |', '| 低于门槛 | ' + f.belowFloor + ' |',
      '| 达成率 | ' + (f.condenseRate == null ? '—' : (f.condenseRate * 100).toFixed(1) + '%') + ' |',
      '| 平均压缩比 | ' + (f.meanRatio == null ? '—' : (f.meanRatio * 100).toFixed(1) + '%') + ' |', '')
  }
  if (warnings.length) lines.push('## 警告', '', ...warnings.map((w) => '- ' + w), '')
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'))
  return { corpus, dir: ensureDir(outDir) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) { if (args[i] === '--trace') opts.tracePath = args[++i]; else if (args[i] === '--out') opts.outDir = path.resolve(args[++i]) ; else throw new Error('未知参数 ' + args[i]) }
  const { corpus, dir } = buildCorpus(opts)
  console.log('语料已写入 ' + dir)
  console.log('  生产 trace: ' + (corpus.production.available ? corpus.production.events + ' 事件 / ' + corpus.production.blocks + ' 块' : '不可用'))
  console.log('  实跑任务: ' + corpus.runs + ' ；候选行: ' + corpus.items.length)
  console.log('  切分: train ' + corpus.split.train.length + ' / dev ' + corpus.split.dev.length + ' / test ' + corpus.split.test.length)
  for (const w of corpus.warnings) console.log('  ! ' + w)
}
