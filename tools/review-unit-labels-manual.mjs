#!/usr/bin/env node
/**
 * review-unit-labels-manual.mjs —— 「人工逐条盲审」单元标签，产出与 tools/review-unit-labels.mjs 同协议同 schema 的审核文件。
 *
 * 为什么要有它：review-unit-labels.mjs 的 reviewer 是付费 LLM（缺 key 直接 exit 2），API 通道不可用时
 * 审核线就整条停住。本工具把同一个 v3 盲审协议改成人工执行，**不给审核者看规则槽位/目标值/旗标/规则名**
 * （看了就会被锚定，独立性作废），只给 family / 文档 / 位置 / 正文。
 *
 * 用法（三个子命令）：
 *   node tools/review-unit-labels-manual.mjs dump                       # 写工作表（默认只含 needs-review 的单元）
 *   node tools/review-unit-labels-manual.mjs print --offset 0 --count 30   # 把一批打成可读文本（审核者读这个）
 *   node tools/review-unit-labels-manual.mjs apply --verdicts v.jsonl --done 30
 *
 * verdicts 每行一个 JSON：
 *   {"id":"u12","slot":"EXCLUDED","yVal":0.78,"yTempt":0.12,"confidence":"high","rationale":"一句话中文理由"}
 *   slot ∈ MECHANISM EXCLUDED DECIDED ACCEPT OPEN NOISE；confidence ∈ high medium low（low 不参与回灌）
 *
 * 量表与 yVal/yTempt 校准锚点与 v3 协议逐字一致（见本文件 SCALE 常量），换协议就换 protocol 名，
 * 老审核行会因协议不符被拒（不冒充）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const argValue = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DATASET = path.resolve(argValue('--dataset', path.join(REPO, 'transfer/models/micro-dev-dataset.json')))
const OUT = path.resolve(argValue('--out', path.join(REPO, 'transfer/models/unit-label-review-blind-v3.json')))
const SHEET = path.resolve(argValue('--sheet', path.join(REPO, '.cfb-offline/review/units-worksheet.jsonl')))
const SCOPE = String(argValue('--scope', 'needs-review'))     // needs-review | all
const PROTOCOL = 'blind-unit-label-v3'
const REVIEWER = 'arena-agent（人工逐条盲读；非生产模型、非规则复述）'
const REVIEWER_KIND = 'blind-human-agent-no-rule-suggestions'
const REVIEWED_AT = process.env.CFB_REVIEW_TIME || new Date().toISOString()
const SLOTS = ['MECHANISM', 'EXCLUDED', 'DECIDED', 'ACCEPT', 'OPEN', 'NOISE']

// 量表原文照抄 v3 协议，保证两条审核路径（LLM / 人工）判据同尺
const SCALE = [
  '槽位定义（六选一）：',
  '- MECHANISM：揭示因果机制/证据链的单元（解释"为什么"、给出可核查的证据与推理），推进理解。',
  '- EXCLUDED：明确排除某条路径/假设的单元（说明"不是这个原因""不用改这里"），排除本身有价值。',
  '- DECIDED：已落定的结论/动作决定（明确"改成什么""怎么做"、执行顺序、交付物清单）。',
  '- ACCEPT：验收标准与验证动作（怎么算修好、跑什么命令、先红后绿）。',
  '- OPEN：显式挂起的开放问题（"留待下一轮"），非逃避型。',
  '- NOISE：不推进任务：情绪化总结、无依据猜测、逃避/掩盖式捷径（重启、跳过、加 try/catch、调大超时）、无关闲聊。',
  '',
  '价值与诱惑度：',
  '- yVal∈[0,1]：该单元对"定位并修复问题"的推进价值。校准锚点：',
  '  · DECIDED 0.85~1.00；ACCEPT 0.78~0.90；OPEN 0.72~0.85；EXCLUDED 0.70~0.90（被排路径越诱人越高）。',
  '  · MECHANISM：能直接支撑根因/给出可核查证据链 0.75~0.90；仅背景铺垫或一般机制补充 0.45~0.65。',
  '  · NOISE：≤0.10。注意 yVal≥0.75 会被排序器当作"值得续读的正例"，只有真正推进定位/修复的单元才给到这个区间。',
  '- yTempt∈[0,1]：它作为"看似合理其实有害的捷径"的诱惑度；NOISE 通常 ≥0.4（越像行家话越高）；',
  '  MECHANISM/DECIDED/ACCEPT/OPEN 通常 ≤0.2；EXCLUDED 0.05~0.3。',
  '',
  'confidence：high=语义明确；medium=需一点上下文判断；low=信息不足（此时选保守槽位并给 low ⇒ 不参与回灌）。',
].join('\n')

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const itemId = (u) => `u${u.globalIdx}`
const digestOf = (u) => sha256(JSON.stringify({ sourceId: u.sourceId, unitIdx: u.unitIdx, text: u.text }))

function load() {
  if (!fs.existsSync(DATASET)) throw new Error(`缺数据集：${path.relative(REPO, DATASET)}（先 node tools/build-micro-dataset.mjs）`)
  const ds = JSON.parse(fs.readFileSync(DATASET, 'utf8'))
  if (ds.schema !== 'cfb.micro-dev-dataset/3') throw new Error(`unsupported-dataset-schema:${ds.schema}`)
  return ds
}
/** 盲审工作表：只保留对判定合法的四个字段。规则槽位/旗标/规则名一律不进表（锚定 = 独立性作废）。 */
function targets(ds) {
  const base = ds.unitSamples.filter((u) => String(u.text || '').trim().length >= 8)
  const list = SCOPE === 'all' ? base : base.filter((u) => !u.trainingEligible)
  return list
}

const cmd = process.argv[2]
const ds = load()
const dsSha = sha256(fs.readFileSync(DATASET))
const list = targets(ds)

if (cmd === 'dump') {
  fs.mkdirSync(path.dirname(SHEET), { recursive: true })
  const lines = list.map((u) => JSON.stringify({
    id: itemId(u), family: u.family, document: u.sourceId,
    position: `${(u.unitIdx ?? 0) + 1}/${u.totalUnits ?? '?'}`, text: u.text,
  }))
  fs.writeFileSync(SHEET, lines.join('\n') + '\n')
  console.log(`[dump] needs-review 口径=${SCOPE} 单元 ${lines.length} 条（全量 ${ds.unitSamples.length}）⇒ ${path.relative(REPO, SHEET)}`)
  console.log(`[dump] 数据集 sha=${dsSha.slice(0, 12)}…（审核文件会钉这个，换数据集就要重审）`)
  process.exit(0)
}

if (cmd === 'print') {
  const off = Number(argValue('--offset', '0')) || 0
  const n = Number(argValue('--count', '30')) || 30
  const rows = list.slice(off, off + n)
  console.log(`─── 工作表 ${off + 1}–${off + rows.length} / ${list.length} ───`)
  console.log(SCALE, '\n')
  for (const u of rows) {
    console.log(`[${itemId(u)}] ${u.family} · ${u.sourceId} · ${u.unitIdx + 1}/${u.totalUnits ?? '?'}`)
    console.log(u.text.replace(/\s+/g, ' ').trim())
    console.log('')
  }
  process.exit(0)
}

if (cmd === 'apply') {
  const vf = path.resolve(argValue('--verdicts', ''))
  if (!vf || !fs.existsSync(vf)) throw new Error('apply 需要 --verdicts <file.jsonl>')
  const byId = new Map((list.map((u) => [itemId(u), u])))
  const raw = fs.readFileSync(vf, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  const accepted = []
  const rejected = []
  for (const l of raw) {
    let row
    try { row = JSON.parse(l) } catch (e) { rejected.push({ line: l.slice(0, 60), why: 'json:' + e.message.slice(0, 60) }); continue }
    const id = String(row.id || '')
    const slot = String(row.slot || '').toUpperCase()
    const yVal = Number(row.yVal); const yTempt = Number(row.yTempt)
    const confidence = String(row.confidence || '').toLowerCase()
    const rationale = String(row.rationale || '').trim()
    const u = byId.get(id)
    if (!u) { rejected.push({ id, why: 'id 不在本口径工作表里（可能被规则筛为可训练或文本过短）' }); continue }
    if (!SLOTS.includes(slot)) { rejected.push({ id, why: 'bad slot:' + slot }); continue }
    if (!Number.isFinite(yVal) || !Number.isFinite(yTempt) || !['high', 'medium', 'low'].includes(confidence) || !rationale) {
      rejected.push({ id, why: 'yVal/yTempt/confidence/rationale 缺一或非法' }); continue
    }
    accepted.push({ id, slot, yVal: +yVal.toFixed(5), yTempt: +yTempt.toFixed(5), confidence, rationale, reviewProtocol: PROTOCOL, globalIdx: u.globalIdx, sourceId: u.sourceId, unitIdx: u.unitIdx, digest: digestOf(u) })
  }
  // 与 LLM 版同款合并：只保留同协议同数据集的行，历史/异协议行不冒充
  let prior = { items: [] }
  if (fs.existsSync(OUT)) {
    try {
      prior = JSON.parse(fs.readFileSync(OUT, 'utf8'))
      // 继承判据用「单元 digest 是否仍在当前数据集里」而不是「数据集 sha 是否相同」：
      //   审核本身会改变数据集（回灌后重建），拿 sha 当闸会把已完成的审核整批判废（v14.24.1 我自己踩过：一次 apply 清了 245 条）。
      const alive = new Set(list.map((u) => digestOf(u)))
      const same = prior.schema === 'cfb.unit-label-review/2' && prior.reviewProtocol === PROTOCOL
      const before = (prior.items || []).length
      prior.items = same ? (prior.items || []).filter((r) => r.reviewProtocol === PROTOCOL && alive.has(r.digest)) : []
      if (before !== prior.items.length) console.log(`[apply] 继承 ${prior.items.length}/${before} 条（${before - prior.items.length} 条指向的单元已不在本数据集 ⇒ 丢弃，不拿旧标注套新数据）`)
    } catch (e) { console.warn('[apply] 既有文件读失败，重建：' + String(e.message).slice(0, 80)) }
  }
  const merged = new Map(prior.items.map((r) => [r.id, r]))
  for (const r of accepted) merged.set(r.id, r)
  const items = [...merged.values()].sort((a, b) => a.globalIdx - b.globalIdx)
  const counts = { scope: SCOPE, targetUnits: list.length, submitted: raw.length, accepted: accepted.length, rejected: rejected.length, totalReviewed: items.length }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({
    schema: 'cfb.unit-label-review/2', reviewProtocol: PROTOCOL,
    reviewer: REVIEWER, reviewerKind: REVIEWER_KIND, reviewedAt: REVIEWED_AT,
    datasetPath: path.relative(REPO, DATASET), datasetSha256AtReview: dsSha,
    selectionRule: SCOPE === 'all' ? 'text.length>=8（含已可训练单元：允许双向改判）' : 'trainingEligible=false && text.length>=8',
    reviewerIndependence: '人工盲读：工作表不含规则槽位/目标值/旗标/规则名',
    counts, items,
  }, null, 2) + '\n')
  const slots = {}
  for (const r of accepted) slots[r.slot] = (slots[r.slot] || 0) + 1
  console.log(`[apply] 收 ${accepted.length} 条 / 退 ${rejected.length} 条 ⇒ ${path.relative(REPO, OUT)}（累计 ${items.length}）`)
  console.log(`[apply] 本批槽位：${Object.entries(slots).map(([k, v]) => k + '=' + v).join(' · ') || '无'}`)
  for (const r of rejected.slice(0, 8)) console.log(`  退：${JSON.stringify(r)}`)
  process.exit(0)
}

console.log('子命令：dump | print --offset N --count M | apply --verdicts f.jsonl [--scope all]')
console.log('量表：\n' + SCALE)
