#!/usr/bin/env node
// tools/cfb-gold-repair.mjs —— 金标「改稿 → 离线重测 → 换稿」通道（v14.20.1）
//
// 背景：越界（装置话术）审计判死了一批 Mode 1 金标。金标是**手写的稿**，稿里的越界句应当改稿去掉，
// 而不是把整条数据连同原文、ctx、真机结局一起扔掉。本文件只做 $0 的本地动作，绝不发任何网络请求：
//   audit                       注册表（active + 隔离区）逐项复算新口径审计：draft 定罪、逐字引用免检
//   replay  --id X --draft F    用条目自带的 raw/ctx/calls 复跑**生产同一条闸链**（G2 → compileV4Direct
//                               → 程序部件拼接 → birthAccept）+ 越界 lint + 与旧稿的逐槽差（归因）；只读
//   restore --id A,B [--apply]  把「稿子本来就干净」的隔离条目放回 active registry（字节不变 ⇒ digest 不变 ⇒
//                               冻结的基准计划照旧可用）；不改任何文本
//   stage   --id X --draft F    replay 全绿才写 transfer/gold-repair/{drafts,staged}/，供真机续跑
//   next-cmds                   打印真机复测（唯一能定 outcome 的一步）的确切命令
// 铁律：离线全绿 ≠ 金标。`outcome`（主模型读这份稿能否真修好）只能由 Mode 1 真机轨迹决定。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as I from '../index.js'
import { handDraftGate, draftDistance, slotsOf } from './helpers/hand-draft.mjs'
import { auditMode1Gold, auditMode1Output } from './helpers/mode1-quality.mjs'
import { loadGold, loadArchivedGold, goldDigest } from './helpers/three-mode.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE = path.join(ROOT, 'transfer', 'gold')
const REJECTED = path.join(ROOT, 'transfer', 'gold-rejected')
const REPAIR = path.join(ROOT, 'transfer', 'gold-repair')

const argv = process.argv.slice(2)
const CMD = argv[0]
const f = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
const has = (flag) => argv.includes(flag)
const ids = () => String(f('--id') || '').split(',').map((x) => x.trim()).filter(Boolean)
const now = () => new Date().toISOString()
const die = (m) => { console.error('✗ ' + m); process.exit(1) }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); return p }
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const evidenceOf = (g) => String(g?.raw || '') + '\n' + String(g?.ctx || '')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** 金标条目定位：先 active 注册表，再隔离区（含子目录）。 */
function findGold(id) {
  const inActive = loadGold(ACTIVE).find((g) => g.id === id)
  if (inActive) return { item: inActive, origin: 'active' }
  const inArchive = loadArchivedGold(REJECTED).find((g) => g.id === id)
  if (inArchive) return { item: inArchive, origin: 'rejected' }
  return { item: null, origin: null }
}
/** 与 traj-run 的 hand 臂同一条闸链：G2 决策不变 → compileV4Direct → 程序部件 → birthAccept → stored lint。 */
async function runGateChain({ raw, ctx, calls, draft }) {
  const g2 = handDraftGate(raw, draft, ctx)
  if (!g2.ok) return { stage: 'G2', ok: false, violations: g2.violations }
  const quality = auditMode1Output(draft, evidenceOf({ raw, ctx }))
  if (quality.status !== 'clean') return { stage: 'mode1-quality', ok: false, violations: quality.issues.map((v) => ({ kind: 'mode1-quality:' + v.category, detail: v.excerpt })) }
  const compact = String(raw || '').length < 3100
  const handPolicy = { id: 'hand', config: compact ? { continuationPath: 'bounded', programParts: 'compact' } : { programParts: 'no-hints' } }
  const cfg0 = I.offlineBirthConfig({ model: 'hand', baseUrl: 'local://offline', credentialsPath: null, policy: handPolicy, normalizeConfig: I.normalizeConfig })
  const cfg = compact ? { ...cfg0, birthMinSavedChars: Math.min(cfg0.birthMinSavedChars || 50, Math.max(20, Math.floor(String(raw || '').length * 0.05))), ...(String(raw || '').length < 2600 ? { birthTokenGate: false } : {}) } : cfg0
  const b = await I.birthOffline({ raw, ctx, calls, cfg, gate: true, compile: async (rawText, c) => {
    const v = I.compileV4Direct(draft, rawText, c)
    const pv = I.compressPromptVersion(c) + '+hand'
    if (!v.ok) { const e = new Error('v4-direct:' + v.reason); e.meta = { v4: v.stats, promptVersion: pv }; throw e }
    return { text: v.text || draft, meta: { promptVersion: pv, v4: v.stats } }
  } })
  if (!b.ok) return { stage: 'production-gate', ok: false, why: b.why, reason: b.reason || null, info: b.info || null, v4: b.v4 || null }
  const storedQuality = auditMode1Output(b.text, evidenceOf({ raw, ctx }))
  if (storedQuality.status !== 'clean') return { stage: 'mode1-quality-stored', ok: false, violations: storedQuality.issues.map((v) => ({ kind: 'mode1-quality:stored:' + v.category, detail: v.excerpt })), stored: b.text }
  return { stage: 'pass', ok: true, stored: b.text, promptVersion: b.promptVersion, v4: b.v4 || null, accept: b.accept || null, storedQuality, draftChars: draft.length, outChars: b.text.length, rawChars: String(raw || '').length }
}
/** 逐槽差：新稿相对旧金标稿删了什么、加了什么 —— 这就是「归因」。 */
function slotDiff(oldDraft, newDraft) {
  const O = slotsOf(String(oldDraft || '')), N = slotsOf(String(newDraft || ''))
  const list = (s, k) => Array.isArray(s[k]) ? s[k] : []
  const same = (a, b) => norm(a) === norm(b)
  const cmp = (k) => ({ old: list(O, k).length, new: list(N, k).length,
    dropped: list(O, k).filter((x) => !list(N, k).some((y) => same(x, y))).map((s) => norm(s).slice(0, 110)),
    added: list(N, k).filter((x) => !list(O, k).some((y) => same(x, y))).map((s) => norm(s).slice(0, 110)) })
  return { decision: cmp('decided'), excluded: cmp('excluded'), accept: cmp('accept'), open: cmp('open'), triples: cmp('triples') }
}

if (CMD === 'audit' || !CMD) {
  const active = loadGold(ACTIVE), archivedAll = loadArchivedGold(REJECTED)
  const activeIds = new Set(active.map((g) => g.id))
  // 隔离区保留字节相同的原文件作审计轨迹；已在 active 的那份不再重复计数（restore 是复制而非搬走）
  const alreadyBack = archivedAll.filter((g) => activeIds.has(g.id))
  const archived = archivedAll.filter((g) => !activeIds.has(g.id))
  const row = (g, origin) => {
    const ev = evidenceOf(g)
    const d = auditMode1Output(g.draft || '', ev)
    const s = auditMode1Output(g.stored || '', ev)
    const s0 = auditMode1Output(g.stored || '')
    return { origin, id: g.id, family: g.family, split: g.split, plan: g.plan, solved: g.outcome?.solved ?? null, 修好轮: g.outcome?.roundsToFix ?? null, vsRaw: g.outcome?.vsRaw ?? null,
      结论: d.status === 'clean' && s.status === 'clean' ? 'RESTORABLE' : 'NEEDS-REWRITE',
      draft命中: [...new Set(d.issues.map((i) => i.category))].join('+') || '—',
      stored命中: [...new Set(s.issues.map((i) => i.category))].join('+') || '—',
      旧口径误杀: d.status === 'clean' && s0.status !== 'clean' ? 'stored 命中只是工具回显的逐字引用' : '',
      字数: (g.draft || '').length + '/' + String(g.stored || '').length }
  }
  const inRegistry = active.map((g) => { const r = row(g, 'active'); r.结论 = r.draft命中 === '—' && r.stored命中 === '—' ? '在册·干净' : '在册·越界⚠'; return r })
  const rows = [...inRegistry, ...archived.map((g) => row(g, 'rejected'))]
  console.table(rows)
  if (alreadyBack.length) console.log(`（隔离区另有 ${alreadyBack.length} 份同名历史副本：${alreadyBack.map((g) => `${g.id}[${(g.digest||'').slice(0,8)}→在册${(active.find((a) => a.id === g.id) || {}).digest || '?'}]`).join(' ')} —— 放回时字节相同则 digest 一致；真机重挣回来的同名条目 digest 会变，那是换稿、不是重复计数）`)
  const restorable = rows.filter((r) => r.结论 === 'RESTORABLE' && r.origin === 'rejected')
  const rewrite = rows.filter((r) => r.结论 === 'NEEDS-REWRITE')
  console.log(`\nactive ${active.length} 项；隔离区 ${archived.length} 项。新口径（定罪只看手写产出、逐字引用免检）下：可直接恢复 ${restorable.length}、要改稿 ${rewrite.length}`)
  const measuredDir = path.join(REPAIR, 'measured')
  const measured = fs.existsSync(measuredDir) ? fs.readdirSync(measuredDir).filter((f) => f.endsWith('.json')) : []
  if (measured.length) console.log(`量过但不够格当天花板（vsRaw loss / 未修好）：${measured.length} 条在 ${path.relative(ROOT, measuredDir)}/ —— 稿与整单元结果都在，可当模式 2 素材，不是垃圾桶`)
  if (rewrite.length) console.log('要改稿：' + rewrite.map((r) => `${r.id}[${r.draft命中 === '—' ? 'stored:' + r.stored命中 : r.draft命中}]`).join(' '))
  if (restorable.length) console.log(`下一步（$0）: node tools/cfb-gold-repair.mjs restore --id ${restorable.map((r) => r.id).join(',')} --apply`)
  process.exit(0)
}

if (CMD === 'replay' || CMD === 'stage') {
  const id = ids()[0] || die('--id <goldId> 必填')
  const draftFile = f('--draft') || die('--draft <file> 必填（修订后的手写稿）')
  if (!fs.existsSync(draftFile)) die('找不到稿文件：' + draftFile)
  const { item, origin } = findGold(id)
  if (!item) die('金标条目不存在：' + id)
  const draft = fs.readFileSync(draftFile, 'utf8').trim()
  const res = await runGateChain({ raw: item.raw, ctx: item.ctx, calls: item.calls || [], draft })
  const dd = draftDistance(draft, item.draft, { raw: item.raw, ctx: item.ctx, calls: item.calls || [] })
  const report = { schema: 'cfb.gold-repair-replay/1', at: now(), id, origin, draftFile: path.relative(ROOT, path.resolve(draftFile)),
    originalDraftHits: auditMode1Output(item.draft || '').issues, revision: { oldDraftChars: (item.draft || '').length, newDraftChars: draft.length },
    gate: { stage: res.stage, ok: res.ok, violations: res.violations || null, why: res.why || null, reason: res.reason || null, v4: res.v4 || null, accept: res.accept || null, outChars: (res.stored || '').length },
    slots: slotDiff(item.draft, draft),
    againstOldGoldDraft: { score: dd.score, verdict: dd.verdict, decision: dd.decision, excludedRecall: dd.excludedRecall, acceptOk: dd.acceptOk, openRecall: dd.openRecall, anchorPrecision: dd.anchorPrecision, lengthRatio: dd.lengthRatio, lengthOk: dd.lengthOk } }
  console.log(JSON.stringify(report, null, 2))
  if (!res.ok) { console.log(`\n✗ 闸链未过（阶段 ${res.stage}）⇒ 继续改稿，不入库`); process.exit(2) }
  console.log(`\n✓ 离线全绿：G2 决策不变 ∧ compileV4Direct ∧ 程序部件 ∧ birthAccept ∧ 越界 lint（draft+stored）`)
  console.log(`  与旧金标稿的 dd/1 = ${dd.score}（${dd.verdict}）：改稿只删越界句 ⇒ 应接近 1.000 / close`)
  console.log(`  stored ${(res.stored || '').length} 字（原 ${String(item.stored || '').length} 字）`)
  console.log('  ⚠ 这不等于金标：`outcome`（主模型读这份稿能否修好）必须重跑 Mode 1 真机单元。见 `next-cmds`。')
  if (CMD === 'stage') {
    const stored = res.stored
    const next = { ...item, draft, stored, qualityAudit: auditMode1Gold({ ...item, draft, stored }, { reviewer: 'draft-only-lint+replay/1', reviewedAt: now() }),
      gates: { ...item.gates, v4: res.v4 || item.gates?.v4 || null, accept: res.accept || item.gates?.accept || null, draftChars: draft.length, outChars: stored.length },
      digest: goldDigest({ raw: item.raw, ctx: item.ctx, draft }) }
    const staged = writeJson(path.join(REPAIR, 'staged', id + '.json'), { ...report, stagedAt: now(), item: next })
    fs.mkdirSync(path.join(REPAIR, 'drafts'), { recursive: true })
    fs.copyFileSync(path.resolve(draftFile), path.join(REPAIR, 'drafts', id + '.md'))
    // 待重测台账：修订稿的 `outcome` 来自旧稿的真机单元，改稿后必须重跑才算金标 ⇒ 先记在这里，不进注册表
    const pendFile = path.join(REPAIR, 'pending-retest.json')
    const pend = readJson(pendFile) || { schema: 'cfb.gold-repair-pending/1', at: now(), items: [] }
    pend.items = (pend.items || []).filter((x) => x.id !== id)
    pend.items.push({ id, family: item.family, split: item.split, plan: item.plan, stagedAt: now(), draftChars: draft.length, dd: report.againstOldGoldDraft?.score, why: '改稿后 outcome 作废，须重跑模式 1 单元（同 plan/同样本/同轮次）才恢复金标身份' })
    pend.at = now()
    writeJson(pendFile, pend)
    console.log('已暂存 → ' + path.relative(ROOT, staged) + '（并登记 ' + path.relative(ROOT, pendFile) + '：等真机重测）')
  }
  process.exit(0)
}

if (CMD === 'restore') {
  const want = ids(); if (!want.length) die('--id a,b 必填（`audit` 里 结论=RESTORABLE 的那些）')
  const apply = has('--apply')
  const archived = loadArchivedGold(REJECTED)
  const restored = [], refused = []
  for (const id of want) {
    const g = archived.find((x) => x.id === id)
    if (!g) { refused.push({ id, why: '隔离区里没有这一条' }); continue }
    const draftAudit = auditMode1Output(g.draft || '', evidenceOf(g))
    const storedAudit = auditMode1Output(g.stored || '', evidenceOf(g))
    if (draftAudit.status !== 'clean' || storedAudit.status !== 'clean') { refused.push({ id, why: '新口径下仍有自己写的越界句：' + [...draftAudit.issues, ...storedAudit.issues].map((i) => i.category).join(',') + ' ⇒ 走 stage 改稿' }); continue }
    if (g.validated !== true) { refused.push({ id, why: 'validated≠true：没有真机结局，不能当金标' }); continue }
    const dest = path.join(ACTIVE, g.family, g.id + '.json')
    if (fs.existsSync(dest)) { refused.push({ id, why: 'active registry 里已有同 id' }); continue }
    const srcText = fs.readFileSync(g.archiveFile, 'utf8')
    const src = JSON.parse(srcText)
    const entry = { ...src }
    delete entry.archiveFile; delete entry.quarantine
    entry.qualityAudit = auditMode1Gold(entry, { reviewer: 'draft-only-lint+restore/1', reviewedAt: now() })
    entry.restoration = { at: now(), from: path.relative(ROOT, g.archiveFile), basis: 'apparatus 审计口径修正：定罪只看手写产出（draft / 自己写的主张句）；stored 里逐字来自 raw∪ctx 的工具回显是引用不是主张', bytesUnchanged: true, digest: goldDigest(entry), outcome: 'inherited-from-original-mode1-trajectory', note: '未改一字 ⇒ digest 与冻结基准计划一致；真机结局沿用原轨迹' }
    restored.push({ id, family: g.family, src: path.relative(ROOT, g.archiveFile), dest: path.relative(ROOT, dest), sourceSha256: sha256(srcText), digest: goldDigest(entry), draftChars: entry.draft.length })
    if (apply) writeJson(dest, entry)
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', restored, refused }, null, 2))
  if (!apply) console.log(restored.length ? '以上为预览；加 --apply 落盘。' : '')
  if (apply && restored.length) {
    const ledgerPath = path.join(REPAIR, 'restorations.json')
    const prev = readJson(ledgerPath) || { schema: 'cfb.gold-restorations/1', entries: [] }
    prev.entries.push({ at: now(), action: 'restore-from-quarantine', basis: 'draft-only apparatus audit + verbatim-quote exemption（见 tools/helpers/mode1-quality.mjs exemptQuotedIssues）', items: restored })
    writeJson(ledgerPath, prev)
    const quarantineLedger = path.join(REJECTED, 'audit.json')
    const q = readJson(quarantineLedger)
    if (q && Array.isArray(q.actions)) {
      const set = new Map(restored.map((r) => [r.id, r]))
      for (const a of q.actions) {
        const r = set.get(a.id)
        if (!r) continue
        a.status = 'restored-active'
        a.restoredAt = now()
        a.restoredTo = r.dest
        a.restoredBasis = 'draft-only apparatus audit + verbatim-quote exemption（见 00-README.md）'
      }
      writeJson(quarantineLedger, q)
      console.log('已在 ' + path.relative(ROOT, quarantineLedger) + ' 的对应 action 上标 status=restored-active（留痕，不删记录）')
    }
    console.log(`\n已恢复 ${restored.length} 项 → transfer/gold。现在跑：node tools/cfb-cycle.mjs gold list && node tools/cfb-cycle.mjs next`)
  }
  process.exit(0)
}

if (CMD === 'next-cmds') {
  const pend = readJson(path.join(REPAIR, 'pending-retest.json'))
  if (pend?.items?.length) {
    console.log(`待真机复测的修订稿 ${pend.items.length} 条（$0 离线闸链已全绿；只有真机单元能定 outcome）：\n`)
    for (const it of pend.items) {
      const draft = path.join('transfer', 'gold-repair', 'drafts', it.id + '.md')
      const home = path.join('.cfb-runtime', 'traj', it.plan)
      console.log(`  # ${it.id}（${it.family}，${it.split}，原计划 ${it.plan}，稿 ${it.draftChars} 字，与旧稿 dd/1=${it.dd}）`)
      console.log(`  node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios ${it.family} --max-rounds <R> --dry   # 同设计已存在则直接续跑 ${it.plan}`)
      console.log(`  cp ${draft} ${home}/drafts/${it.id}.md      # 文件名 = 轨迹 id，traj-run 见稿即续跑那一轮`)
      console.log(`  node tools/traj-run.mjs --plan ${home}/plan.json --store-text --variants raw,hand --samples 1 --max-rounds <R>`)
      console.log(`  node tools/cfb-cycle.mjs ceiling --plan ${it.plan.slice(1)} && node tools/cfb-cycle.mjs gold add --plan ${it.plan.slice(1)} --replace\n`)
    }
    console.log('全部放回后：node tools/cfb-cycle.mjs plan-bench --policies base,<候选> → tools/bench-run.mjs（金标摘要变了 ⇒ 旧计划按设计 gold-changed 拒跑）')
    process.exit(0)
  }
  console.log(`真机复测（唯一能定 outcome 的一步，在你本机跑，需要密钥）：
  cd ~/cfb && source ~/.secrets/keys.env
  node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios <family> --max-rounds <R>     # ≈$0.11/单元；--reuse-raw 可压到 ≈$0.025/对
  cp transfer/gold-repair/drafts/<id>.md .cfb-runtime/traj/tN/drafts/<task>-s0-r<round>.md      # 预置稿 ⇒ traj-run 自动续跑该轮
  node tools/traj-run.mjs --plan .cfb-runtime/traj/tN/plan.json --store-text --variants raw,hand --samples 1 --max-rounds <R>
  node tools/cfb-cycle.mjs ceiling --plan N
  node tools/cfb-cycle.mjs gold add --plan N --replace      # 覆盖旧条目前自动归档 transfer/gold-history/
之后：node tools/cfb-cycle.mjs plan-bench --policies base,<候选> → tools/bench-run.mjs → bench-report
      （金标 digest 变了 ⇒ 旧基准计划按设计作废，bench-run 会报 gold-changed）`)
  process.exit(0)
}
die('未知子命令：' + CMD + '（audit | replay | stage | restore | next-cmds）')
