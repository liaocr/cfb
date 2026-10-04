#!/usr/bin/env node
/**
 * review-unit-labels.mjs — independent LLM semantic review of deterministic unit labels.
 *
 * Reads the dev training dataset (cfb.micro-dev-dataset/3), selects units whose deterministic
 * screen left them trainingEligible=false, asks an independent model for slot/value/temptation
 * with a rationale, and writes cfb.unit-label-review/1 bound to the dataset hash.
 * The builder consumes this file to promote confirmed labels (never touches the blind family).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... node tools/review-unit-labels.mjs [--dataset <path>] [--out <path>]
 *     [--limit N] [--batch 8] [--concurrency 4] [--resume]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argValue = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (process.argv.includes(name) ? fallback : fallback)
}
const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const DATASET = path.resolve(argValue('--dataset', path.join(REPO, 'transfer/models/micro-dev-dataset.json')))
const OUT = path.resolve(argValue('--out', path.join(REPO, 'transfer/models/unit-label-review.json')))
const LIMIT = Number(argValue('--limit', '0')) || 0
const BATCH = Number(argValue('--batch', '8')) || 8
const CONCURRENCY = Number(argValue('--concurrency', '4')) || 4
const RESUME = process.argv.includes('--resume')
const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.a6api.com/v1').replace(/\/$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash'
const REVIEWER = `${MODEL} (independent LLM review via ${BASE})`
const REVIEWED_AT = process.env.CFB_REVIEW_TIME || new Date().toISOString()
if (!API_KEY) { console.error('missing DEEPSEEK_API_KEY'); process.exit(2) }

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const SLOTS = ['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE']
const SYSTEM = [
  '你是一名独立的标注复核员，为「长对话分析单元排序器」复核确定性规则生成的单元标签。你的结论会写进训练数据集审核记录并影响训练，请严格、保守、给出理由。',
  '',
  '槽位定义（六选一）：',
  '- MECHANISM：揭示因果机制/证据链的单元（解释“为什么”、给出可核查的证据与推理），推进理解。',
  '- EXCLUDED：明确排除某条路径/假设的单元（说明“不是这个原因”“不用改这里”），排除本身有价值。',
  '- DECIDED：已落定的结论/动作决定（明确“改成什么”“怎么做”、执行顺序、交付物清单）。',
  '- ACCEPT：验收标准与验证动作（怎么算修好、跑什么命令、先红后绿）。',
  '- OPEN：显式挂起的开放问题（“留待下一轮”），非逃避型。',
  '- NOISE：不推进任务：情绪化总结、无依据猜测、逃避/掩盖式捷径（重启、跳过、加 try/catch、调大超时）、无关闲聊。',
  '',
  '价值与诱惑度：',
  '- yVal∈[0,1]：该单元对“定位并修复问题”的推进价值。校准锚点（按项目既有量表）：',
  '  · DECIDED（落定结论/动作）0.85~1.00；ACCEPT（验收标准）0.78~0.90；OPEN（显式挂起）0.72~0.85；EXCLUDED（有效排除，被排路径越诱人越高）0.70~0.90。',
  '  · MECHANISM：能直接支撑根因/给出可核查证据链 0.75~0.90；仅背景铺垫或一般机制补充 0.45~0.65。',
  '  · NOISE：≤0.10。注意 yVal≥0.75 会被排序器当作“值得续读的正例”，只有真正推进定位/修复的单元才给到这个区间。',
  '- yTempt∈[0,1]：它作为“看似合理其实有害的捷径”的诱惑度；NOISE 通常 ≥0.4（越像行家话越高）；MECHANISM/DECIDED/ACCEPT/OPEN 通常 ≤0.2；EXCLUDED 0.05~0.3。',
  '',
  '只输出 JSON，不要多余文字：{"items":[{"id":"<原样回填>","slot":"...","yVal":0.00,"yTempt":0.00,"confidence":"high|medium|low","rationale":"一句话中文理由"}]}',
  'confidence：high=语义明确；medium=需一点上下文判断；low=信息不足（此时选保守槽位并给 low）。',
].join('\n')

const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'))
const datasetSha = sha256(fs.readFileSync(DATASET))
const targets = dataset.unitSamples.filter((u) => !u.trainingEligible && String(u.text || '').trim().length >= 8)
const ONLY_IDS = (() => {
  const i = process.argv.indexOf('--only')
  if (i === -1) return null
  const raw = String(process.argv[i + 1] || '').trim()
  if (!raw) return null
  let ids = null
  if (fs.existsSync(raw)) ids = JSON.parse(fs.readFileSync(raw, 'utf8'))
  else if (raw.startsWith('[')) ids = JSON.parse(raw)
  else ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!Array.isArray(ids)) throw new Error('--only must be a JSON array file, inline JSON array, or comma-separated id list')
  return new Set(ids)
})()
const selected = (ONLY_IDS ? targets.filter((u) => ONLY_IDS.has(`u${u.globalIdx}`)) : targets).slice(0, LIMIT || Number.MAX_SAFE_INTEGER)
console.log(`[review] dataset=${path.relative(REPO, DATASET)} sha=${datasetSha.slice(0, 12)}… needs-review=${targets.length} selected=${selected.length}`)

let prior = { items: [] }
if (RESUME && fs.existsSync(OUT)) {
  prior = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  console.log(`[review] resume: ${prior.items?.length || 0} items already reviewed`)
}
const byId = new Map((prior.items || []).map((row) => [row.id, row]))

const itemId = (u) => `u${u.globalIdx}`
const digestOf = (u) => sha256(JSON.stringify({ sourceId: u.sourceId, unitIdx: u.unitIdx, text: u.text }))
const promptItem = (u) => ({
  id: itemId(u),
  family: u.family,
  document: u.sourceId,
  position: `${u.unitIdx + 1}/${u.totalUnits}`,
  text: u.text,
  ruleSuggestion: {
    slot: u.slot, yVal: u.yVal, yTempt: u.yTempt,
    labelRule: u.labelAudit?.labelRule, flags: u.labelAudit?.flags || [],
  },
})

const todo = selected.filter((u) => !byId.has(itemId(u)))
const batches = []
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))
console.log(`[review] batches=${batches.length} batch=${BATCH} concurrency=${CONCURRENCY}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function callModel(items) {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ items: items.map(promptItem) }, null, 1) },
    ],
  }
  let lastErr = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const text = json.choices?.[0]?.message?.content || ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('no JSON object in reply')
      const parsed = JSON.parse(match[0])
      if (!Array.isArray(parsed.items)) throw new Error('items missing')
      const ok = []
      for (const row of parsed.items) {
        const id = String(row.id || '')
        const slot = String(row.slot || '').toUpperCase()
        const yVal = Number(row.yVal)
        const yTempt = Number(row.yTempt)
        const confidence = String(row.confidence || '').toLowerCase()
        const rationale = String(row.rationale || '').trim()
        if (!id || !SLOTS.includes(slot) || !Number.isFinite(yVal) || !Number.isFinite(yTempt)) continue
        if (!['high', 'medium', 'low'].includes(confidence) || !rationale) continue
        ok.push({ id, slot, yVal: +yVal.toFixed(5), yTempt: +yTempt.toFixed(5), confidence, rationale })
        if (row.usage) { /* per-item usage not provided */ }
      }
      if (!ok.length) throw new Error('no valid items parsed')
      return ok
    } catch (err) {
      lastErr = err
      await sleep(1500 * attempt)
    }
  }
  throw lastErr
}

function writeOut(counts) {
  const items = [...byId.values()].sort((a, b) => a.globalIdx - b.globalIdx)
  const payload = {
    schema: 'cfb.unit-label-review/1',
    reviewer: REVIEWER,
    reviewerKind: 'independent-llm',
    reviewedAt: REVIEWED_AT,
    datasetPath: path.relative(REPO, DATASET),
    datasetSha256AtReview: datasetSha,
    selectionRule: 'trainingEligible=false && text.length>=8',
    counts,
    items,
  }
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
}

let done = 0, failed = 0
const startedAt = Date.now()
async function worker(queue) {
  while (queue.length) {
    const batch = queue.shift()
    try {
      const rows = await callModel(batch)
      const byLocal = new Map(batch.map((u) => [itemId(u), u]))
      for (const row of rows) {
        const u = byLocal.get(row.id)
        if (!u) continue
        byId.set(row.id, { ...row, globalIdx: u.globalIdx, sourceId: u.sourceId, unitIdx: u.unitIdx, digest: digestOf(u) })
      }
      done++
      if (done % 5 === 0 || queue.length === 0) {
        writeOut({ selected: selected.length, reviewed: byId.size, batchesDone: done, batchesFailed: failed, batchesTotal: batches.length })
        const el = ((Date.now() - startedAt) / 1000).toFixed(0)
        console.log(`[review] ${byId.size}/${selected.length} reviewed (batches ${done}/${batches.length}, failed ${failed}, ${el}s)`)
      }
    } catch (err) {
      failed++
      console.error(`[review] batch failed after retries: ${String(err.message || err).slice(0, 200)}`)
    }
  }
}
const queue = [...batches]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
writeOut({ selected: selected.length, reviewed: byId.size, batchesDone: done, batchesFailed: failed, batchesTotal: batches.length })
console.log(`[review] done: ${byId.size} items -> ${path.relative(REPO, OUT)}`)
