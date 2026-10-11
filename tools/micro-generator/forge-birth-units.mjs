#!/usr/bin/env node
// forge-birth-units.mjs —— 给「锻造稿」打分：用**生产的同一批尺子**量 AI 写的参考压缩块。
//
// 存在理由（2026-10-07）：出生单元没有 CFB 台账，measureGold 的 R1/R2/E1/E2 全部无从回放；
// 但 M1/M3/M4/M5/M6/M7/M8 这几条只依赖 (raw, ctx, draft) 三元文本，可以原样复用。
// 本工具**逐字照抄** measureGold 中这几条轴的表达式（tools/helpers/gold-standard.mjs:88-240），
// 只把「证据基」固定为 raw ∪ ctx —— 出生时刻起草人看得见的就这些；after.* 是事后代理，
// 故意不进证据基（否则刚出生的稿子可以引用未来信息，接地精度就是假的）。
// 未测的轴（M2/E1/E2/R1/R2）如实记 未测，绝不折算成通过。
//
// 用法：
//   node tools/micro-generator/forge-birth-units.mjs \
//     --units transfer/models/micro-generator-v4flash-scenarios/birth-units-sample.jsonl \
//     --forge transfer/models/micro-generator-forge/forge-drafts-batch0.jsonl \
//     --out   transfer/models/micro-generator-forge/forge-scores-batch0.jsonl
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hasClosedRead, anchorsOf, handDraftGate, FIX_INTENT_RE, slotsOf } from '../helpers/hand-draft.mjs'
import { auditMode1Gold } from '../helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RATIO_MAX = 0.60                       // 与 GOLD-STANDARD THRESHOLDS.ratioMax 同一数字
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const argOf = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }

/** 一条出生单元的 (raw, ctx, draft) → 轴表。轴表达式 = measureGold 同源；证据基 = raw ∪ ctx。 */
export function scoreBirthDraft(unit, draft, { forge = null, now = new Date().toISOString() } = {}) {
  const d = String(draft || '').trim()
  const raw = String(unit?.raw ?? '')
  const ctx = String(unit?.ctx ?? '')
  const ev = [raw, ctx].filter(Boolean).join('\n')
  const A = {}
  const put = (id, value, pass, { gap = 0, margin = 0, note = '' } = {}) => {
    A[id] = { value, pass: pass === null ? null : !!pass, gap, margin, note }
  }

  // M1 压缩力度（分母 = 出生块原文逐字长度）
  const ratio = d.length / Math.max(1, raw.length)
  put('M1', +ratio.toFixed(4), ratio <= RATIO_MAX, {
    gap: +Math.max(0, (ratio - RATIO_MAX) / RATIO_MAX).toFixed(4),
    margin: +clamp01((RATIO_MAX - ratio) / RATIO_MAX).toFixed(4),
  })

  // M2 不劣于产线：该语料没有产线对照 ⇒ 未测（照 GOLD-STANDARD：未测 ≠ 通过）
  put('M2', null, null, { gap: 1, note: '该语料没有产线对照稿 ⇒ 未测' })

  // M3 闭合判读（生产 compileV4Direct 同一条 hasClosedRead）
  put('M3', hasClosedRead(d) ? 1 : 0, hasClosedRead(d), { gap: hasClosedRead(d) ? 0 : 1, margin: hasClosedRead(d) ? 1 : 0 })

  // M4 可执行验收（窗 = 首个「验收/读数」锚点后 400 字；命令片段须逐字在证据基里）
  const at = d.search(/验收|读数|即收工|看到/)
  const win = at < 0 ? '' : d.slice(at, at + 400)
  const cmds = [...win.matchAll(/`([^`\n]{3,60})`/g)].map((m) => m[1])
  const grounded = cmds.filter((c) => ev.includes(c))
  const branches = (win.match(/⇒|则算|即算完/g) || []).length
  const v4 = grounded.length ? (branches >= 2 ? 1 : 0.5) : 0
  put('M4', v4, v4 === 1, { gap: 1 - v4, margin: v4, note: grounded.length ? `${grounded.length} 个逐字命令片段 · ${branches} 个分支` : '窗内没有逐字存在的命令' })

  // M5 接地精度（口径 = 生产 invented-identifier：无据符号名 + 伪引）
  const cited = [...d.matchAll(/「([^」]{6,})」/g)].map((m) => m[1])
  const citedOk = (q0) => {
    const q = String(q0).replace(/^[…\s.]+|[…\s.]+$/g, '')
    if (!q) return true
    if (ev.includes(q)) return true
    const segs = q.split(/…+|\.{3,}/).map((x) => x.trim()).filter((x) => x.length >= 12)
    if (!segs.length) return false
    let cursor = 0
    for (const sg of segs) { const i = ev.indexOf(sg, cursor); if (i < 0) return false; cursor = i + sg.length }
    return true
  }
  const evIdents = anchorsOf(ev)
  const localAnchors = [...anchorsOf(d)].filter((a) => !/^[-+]?\d+(?:\.\d+)?$/.test(a) && !evIdents.has(a))
  const badCited = cited.filter((q) => !citedOk(q))
  const denom = localAnchors.length + cited.length
  const prec = denom === 0 ? 1 : +(1 - (localAnchors.length + badCited.length) / denom).toFixed(4)
  put('M5', prec, prec === 1, { gap: +(1 - prec).toFixed(4), margin: prec, note: denom === 0 ? '稿里没有需核实的符号/引用 ⇒ 无可核项' : [...new Set(localAnchors.concat(badCited.map((q) => '伪引:' + q.slice(0, 20))))].slice(0, 4).join(', ') })

  // M6 装置话术（auditMode1Gold 同一实现；出生单元没有 stored，只查 draft）
  const qa = auditMode1Gold({ raw, ctx, draft: d }, { reviewer: 'birth-forge-lint/1', reviewedAt: now })
  put('M6', qa.status === 'clean' ? 1 : 0, qa.status === 'clean', { gap: qa.status === 'clean' ? 0 : 1, margin: qa.status === 'clean' ? 1 : 0, note: [...new Set((qa.issues || []).map((x) => x.category))].slice(0, 3).join('+') || 'clean' })

  // M7 决策不变 G2（生产闸逐字复用）
  let g2 = { ok: false, why: 'no-raw' }
  try { const g = handDraftGate(raw, d, ctx); g2 = { ok: !!g.ok, why: (g.violations || []).map((x) => x.kind).slice(0, 3).join(',') || 'gate-ok' } }
  catch (e) { g2 = { ok: false, why: 'gate-threw:' + e.message.slice(0, 60) } }
  put('M7', g2.ok ? 1 : 0, g2.ok, { gap: g2.ok ? 0 : 1, margin: g2.ok ? 1 : 0, note: g2.why })

  // M8 落点唯一（多于一条 = 菜单；裸引原文思考流同样判缺陷）
  const sl = slotsOf(d)
  const outside = d.split('\n').map((l) => l.replace(/「[^」]*」/g, ''))
  const fixLines = outside.filter((l) => FIX_INTENT_RE.test(l) || /^(?:[-*]\s*)?(?:这条线只有一处|落点|改法|改一处)/.test(l.trim())).length
  const narration = outside.filter((l) => /(^|\s)(?:Let me|Let's|Hmm,|Actually,|I should|I realize|I need to)\b/.test(l)).length
  const menu = (d.match(/或\s*\S{2,}(?:也|又)?可以|二选一|任选|择一|以下任一|(?:也可以|或者)/g) || []).length
  const m8ok = fixLines === 1 && menu === 0 && narration === 0
  put('M8', fixLines, m8ok, { gap: m8ok ? 0 : Math.max(0, Math.abs(fixLines - 1)) + menu + narration, margin: clamp01(1 / Math.max(1, fixLines + menu + narration)), note: `改法句 ${fixLines} 条${menu ? ` · ${menu} 个「或」` : ''}${narration ? ` · ${narration} 行裸引思考流` : ''} · 排除 ${(sl.excluded || []).length} · 验收 ${(sl.accept || []).length}` })

  // E1/E2：真机才有 ⇒ 未测（出生单元数据里根本没有回喂后的读数）
  put('E1', null, null, { gap: 1, note: '未测 — fixedAtRound 需要把压缩块喂回目标模型真跑（本语料没有回喂读数）' })
  put('E2', null, null, { gap: 1, note: '未测 — vsRaw 同上' })
  // R1/R2：CFB 台账五件与独立趟数在这里不存在；只记「来源钉扎」（revision+shard+row+内容哈希），不冒充 R1
  put('R1', null, null, { gap: 1, note: '未测 — CFB 五件台账（hand-samples/results）在该语料不存在；来源钉扎见 provenance' })
  put('R2', null, null, { gap: 1, note: '未测 — 独立真机趟数 ≥2 无从计算' })

  // 落点对齐（离线代理，不是真机判据）：稿的「落点」行里的标识符，有多少在轨迹随后的动作里真的出现。
  //   after.* 是这段思维链之后的真实续写（未压缩世界），所以它只能说「这条线没把读者带偏」，
  //   不能替代 E1/E2：真机要拿压缩块回喂目标模型才作数。
  const afterText = (unit?.after?.steps || []).join('\n')
  const fixLine = outside.find((l) => FIX_INTENT_RE.test(l) || /^(?:[-*]\s*)?(?:这条线只有一处|落点|改法|改一处)/.test(l.trim())) || ''
  const fixTokens = [...anchorsOf(fixLine)].filter((t) => t.length >= 3 && !/^[-+]?\d+(\.\d+)?$/.test(t))
  const hitTokens = fixTokens.filter((t) => afterText.includes(t))
  const allTokens = [...anchorsOf(d)].filter((t) => t.length >= 3 && !/^[-+]?\d+(\.\d+)?$/.test(t))
  const allHits = allTokens.filter((t) => afterText.includes(t))
  const stepHits = (unit?.after?.steps || []).map((s, i) => ({ i, hits: allTokens.filter((t) => s.includes(t)).length }))
  const bestStep = stepHits.sort((a, b) => b.hits - a.hits)[0] || null
  const proxy = {
    fixTokens, fixHitTokens: hitTokens,
    fixRatio: fixTokens.length ? +(hitTokens.length / fixTokens.length).toFixed(3) : null,
    draftTokens: allTokens.length,
    draftHits: allHits.length,
    draftRatio: allTokens.length ? +(allHits.length / allTokens.length).toFixed(3) : null,
    bestMatchingStep: bestStep,
    note: '离线代理：稿中标识符在后续真实动作（未压缩续写）里的出现率；对齐的是「这条线把读者带到哪」，不是 E1/E2，不构成质量通过',
  }

  const ids = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'E1', 'E2', 'R1', 'R2']
  const unmeasured = ids.filter((id) => A[id].pass === null)
  const failedMeasured = ids.filter((id) => A[id].pass === false)
  const gapSum = ids.reduce((s, id) => s + (A[id].gap || 0), 0)
  const measured = ids.filter((id) => A[id].pass !== null)
  const margin = measured.length ? +(measured.reduce((s, id) => s + (A[id].margin || 0), 0) / measured.length).toFixed(4) : null
  const status = failedMeasured.length ? 'not-gold' : (unmeasured.length ? 'provisional-gold' : 'gold')

  return {
    schema: 'cfb.birth-forge-score/1',
    unitId: unit?.unitId ?? null,
    at: now,
    draftChars: d.length,
    rawChars: raw.length,
    ctxChars: ctx.length,
    status,
    gap: +gapSum.toFixed(4),
    margin,
    failedMeasured,
    unmeasured,
    axes: A,
    fixAlignmentProxy: proxy,
    provenance: {
      source: unit?.source ?? null,
      birthStep: unit?.birthStep ?? null,
      rawSha256: sha(raw),
      ctxSha256: sha(ctx),
      draftSha256: sha(d),
      evidenceBase: 'raw ∪ ctx（出生时刻可见；after.* 故意排除）',
    },
    reviewer: { mode: 'ai-single', reviewerId: 'ai-single-reviewer/birth-forge/1', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false },
    forgeNotes: forge?.forgeNotes ?? null,
  }
}

function main() {
  const unitsPath = path.resolve(ROOT, argOf('units'))
  const forgePath = path.resolve(ROOT, argOf('forge'))
  const outArg = argOf('out')
  const units = readJsonl(unitsPath)
  const forgeRows = readJsonl(forgePath)
  const byId = new Map(forgeRows.map((r) => [r.unitId, r]))
  const scores = []
  const missing = []
  for (const unit of units) {
    const f = byId.get(unit.unitId)
    if (!f || !String(f.referenceDraft || '').trim()) { missing.push(unit.unitId); continue }
    scores.push(scoreBirthDraft(unit, f.referenceDraft, { forge: f }))
  }
  if (outArg) {
    const out = path.resolve(ROOT, outArg)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, scores.map((s) => JSON.stringify(s)).join('\n') + '\n')
    console.log(`wrote ${scores.length} scored forge rows to ${path.relative(ROOT, out)}`)
  }
  if (missing.length) console.log(`missing drafts for ${missing.length} units: ${missing.join(', ')}`)
  const ids = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
  console.log('\nunit'.padEnd(44) + 'status'.padEnd(18) + 'ratio  ' + ids.join('  '))
  for (const s of scores) {
    console.log(`${String(s.unitId).padEnd(44)}${s.status.padEnd(18)}${String(s.axes.M1.value).padEnd(7)}` +
      ids.map((id) => (s.axes[id].pass === null ? '未测' : s.axes[id].pass ? ' ✓ ' : ' ✗ ')).join(' '))
  }
  const passCount = (id) => `${scores.filter((s) => s.axes[id].pass === true).length}/${scores.length}`
  console.log('\n轴通过率：' + ids.map((id) => `${id} ${passCount(id)}`).join(' · '))
  console.log(`状态：gold ${scores.filter((s) => s.status === 'gold').length} · provisional-gold ${scores.filter((s) => s.status === 'provisional-gold').length} · not-gold ${scores.filter((s) => s.status === 'not-gold').length}`)
  console.log('注：全部单元的 E1/E2/R1/R2 均为未测（需要目标模型端点回喂）⇒ 本期最高只能到 provisional-gold，这不是通过。')
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('forge-birth-units.mjs')) main()
