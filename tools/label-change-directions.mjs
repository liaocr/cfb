#!/usr/bin/env node
/**
 * label-change-directions.mjs —— 教师（副模型）标注「改动方向」。
 *
 * 目的（本会话决议）：微模型要从候选改动里学「挑对方向」，但金标只有 3 条可用条目（19 正例）。
 * 本脚本让副模型只凭「原文结论区 + 候选清单」独立判读每条对话最终采纳的改动，产出：
 *   ① 微模型判读头的训练监督（教师标签，独立于金标）；
 *   ② 副模型在「决定」槽位上距金标的实测差距（mode 2 逼近上限的逐项证据）。
 *
 * 用法：DEEPSEEK_API_KEY=... node tools/label-change-directions.mjs [--cap-usd 0.12] [--batch 4] [--max-candidates 24]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadGold, goldUse } from './helpers/three-mode.mjs'
import { isMode1GoldEligible } from './helpers/mode1-quality.mjs'
import { slotsOf, anchorsOf } from './helpers/hand-draft.mjs'
import { mineChangeCandidates, parseGoldDirections } from './helpers/mine-change.mjs'

const argValue = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const OUT = path.resolve(argValue('--out', path.join(REPO, 'transfer/models/change-direction-teacher.json')))
const CAP_USD = Number(argValue('--cap-usd', '0.12'))
const BATCH = Number(argValue('--batch', '4'))
const MAXC = Number(argValue('--max-candidates', '16'))
const RESUME = process.argv.includes('--resume')
const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.a6api.com/v1').replace(/\/$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash'
if (!API_KEY) { console.error('missing DEEPSEEK_API_KEY'); process.exit(2) }
const USD_PER_TOKEN = 6.35e-6   // 取本会话 t18 回执反推（14803+4436 词 = $0.122）

const SYSTEM = [
  '你是一名独立判读员，分析对象是长对话（自动化调试会话）的末尾片段与一份「候选改动对」清单。',
  '任务：判定这条对话最终采纳的改动是哪个候选；方向必须从候选原样选，不许自己编（编的判为无效）。',
  '判读规则：',
  '- 以片段里最后形成的结论为准；前面提过、后面被否掉的只能算过程，不能当最终改动。',
  '- 关注改动词与量级增减的语境（“改成/换回/去掉/调小/调大/应该”等）与哪一版真正被拿去验证。',
  '- 若候选里没有能对应最终结论的，pick 填 null；宁可 null，不要猜。',
  '只输出 JSON，不要多余文字：{"items":[{"id":"<原样回填>","pick":<候选下标或null>,"reason":"一句话中文理由","confidence":"high|medium|low"}]}',
].join('\n')

const DEV_FAMS = new Set(['flaky-timeout', 'perf-regression', 'sse-truncated'])
const gold = loadGold(path.join(REPO, 'transfer/gold')).filter((g) => goldUse(g) !== 'ruler' && isMode1GoldEligible(g)
  && g.qualityAudit?.status === 'clean' && g.split === 'dev' && DEV_FAMS.has(String(g.family || '').replace(/^pool:/, '').split(':', 1)[0].replace(/_(?:decoy|long-horizon).*$/, '')))
  .map((g) => ({ ...g, hand: g.draft || g.gold || g.hand || '' }))
const items = gold.map((g) => {
  const hay = String(g.raw) + '\n' + String(g.ctx || '')
  const cands = mineChangeCandidates(hay).slice(0, MAXC).map((c, i) => ({ i, old: c.old.slice(0, 100), new: c.nw.slice(0, 100), kind: c.kind }))
  const G = slotsOf(g.hand)
  const dirs = parseGoldDirections(G.decided || [], G.triples || [])
  return { id: g.id, family: g.family, tail: String(g.raw).slice(-1500), candidates: cands, goldDirections: dirs }
})
let todo = items
if (RESUME && fs.existsSync(OUT)) {
  const prior = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  const doneIds = new Set((prior.items || []).map((r) => r.id))
  const priorRows = prior.items || []
  const priorMeter = prior.costMeter || {}
  meter.promptTokens += priorMeter.promptTokens || 0
  meter.completionTokens += priorMeter.completionTokens || 0
  meter.calls += priorMeter.calls || 0
  meter.usd += priorMeter.usd || 0
  todo = items.filter((it) => !doneIds.has(it.id))
  rows.push(...priorRows)
  console.log(`[labels] resume: 已有 ${priorRows.length} 条，待补 ${todo.length} 条（此前已花 ≈$${(priorMeter.usd || 0).toFixed(4)}）`)
}
const batches = []
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const meter = { promptTokens: 0, completionTokens: 0, calls: 0, usd: 0, capped: false }
async function callModel(batch) {
  if (meter.capped) throw new Error(`cap-usd already reached: $${meter.usd.toFixed(4)} >= $${CAP_USD} (硬停，不再发起调用)`)
  const body = {
    model: MODEL, temperature: 0, max_tokens: 1600,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(batch.map((it) => ({ id: it.id, tail: it.tail, candidates: it.candidates })), null, 1) },
    ],
  }
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = await res.json()
      const u = json.usage || {}
      meter.promptTokens += Number(u.prompt_tokens) || 0
      meter.completionTokens += Number(u.completion_tokens) || 0
      meter.calls++
      meter.usd = (meter.promptTokens + meter.completionTokens) * USD_PER_TOKEN
      if (CAP_USD > 0 && meter.usd >= CAP_USD) { meter.capped = true; throw new Error(`cap-usd reached: $${meter.usd.toFixed(4)} >= $${CAP_USD}`) }
      const text = json.choices?.[0]?.message?.content || ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('no JSON in reply')
      const parsed = JSON.parse(match[0])
      if (!Array.isArray(parsed.items)) throw new Error('items missing')
      return parsed.items
    } catch (err) {
      if (meter.capped) throw err            // 触顶错误不可重试：重试会继续烧钱（2026-10-05 实测教训）
      lastErr = err; await sleep(1200 * attempt)
    }
  }
  throw lastErr
}

const norm = (s) => String(s).replace(/\s+/g, '').replace(/[.;。]+$/, '')
const overlapTok = (a, b) => { const A = new Set([...anchorsOf(a)].map((x) => x.toLowerCase())), B = new Set([...anchorsOf(b)].map((x) => x.toLowerCase())); if (!A.size || !B.size) return 0; let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.min(A.size, B.size) }
const rows = []
for (const batch of batches) {
  const got = await callModel(batch)
  const byId = new Map(batch.map((b) => [b.id, b]))
  for (const r of got) {
    const it = byId.get(String(r.id))
    if (!it) continue
    const pick = Number.isInteger(r.pick) ? it.candidates.find((c) => c.i === r.pick) || null : null
    const pickObj = pick ? { old: pick.old, new: pick.new, kind: pick.kind } : null
    const agree = pickObj && it.goldDirections.length
      ? it.goldDirections.some((d) => (norm(pickObj.old).includes(norm(d.from).slice(0, 40)) || norm(d.from).includes(norm(pickObj.old)) || overlapTok(pickObj.old, d.from) >= 0.5) && (norm(pickObj.new).includes(norm(d.to).slice(0, 40)) || norm(d.to).includes(norm(pickObj.new)) || overlapTok(pickObj.new, d.to) >= 0.5))
      : null
    rows.push({ id: it.id, teacher: { pick: pick ? pick.i : null, old: pickObj?.old || null, new: pickObj?.new || null, reason: String(r.reason || '').slice(0, 200), confidence: String(r.confidence || '').slice(0, 10) }, goldDirections: it.goldDirections.length, agreeWithGold: agree })
    console.log(`${it.id.padEnd(36)} 教师pick=${pick ? pick.i : 'null'} | 金标方向 ${it.goldDirections.length} | 与金标一致 ${agree === null ? '（无金标方向，不可比）' : agree ? '✓' : '✗'} | ${String(r.reason || '').slice(0, 60)} | $${meter.usd.toFixed(4)}`)
  }
}
const comparable = rows.filter((r) => r.agreeWithGold !== null)
const payload = {
  schema: 'cfb.change-direction-teacher/1',
  at: new Date().toISOString(),
  teacher: `${MODEL} via ${BASE}`,
  task: '仅凭原文末尾片段 + 候选改动清单，独立判读每条对话最终采纳的改动方向；结果用于（a）微模型判读头的教师标签（b）副模型在决定槽位上距金标的实测',
  costMeter: { ...meter, usdPerToken: USD_PER_TOKEN, capUsd: CAP_USD, note: 'token 数为网关实测；usd 为按 t18 回执混合单价估算' },
  agreement: { comparable: comparable.length, agree: comparable.filter((r) => r.agreeWithGold).length, abstain: rows.filter((r) => r.teacher.pick === null).length },
  items: rows,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`\n教师标注 → ${path.relative(REPO, OUT)}`)
console.log(`可比条目 ${comparable.length}：一致 ${comparable.filter((r) => r.agreeWithGold).length} | 弃权 ${payload.agreement.abstain} | 用量 ${meter.promptTokens}+${meter.completionTokens} 词 ≈ $${meter.usd.toFixed(4)}${meter.capped ? '（触顶停机）' : ''}`)
