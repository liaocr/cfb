#!/usr/bin/env node
// tools/bench-run.mjs — 模式 2 压缩器基准（v14.11 / 闭环 v4.6）。
// 每个（策略 × 金标项）发**一次**压缩调用：副模型 = 生产 birthOffline 同构体（关思考、temperature 0、max_tokens 1600、与生产同一提示词 + 同一闸链），
// 输出稿（闸不过 ⇒ 原文放行，与生产同）与助手手写金标按 draftDistance（dd）比对；结果 results.jsonl + receipt.json。
// 用法：DEEPSEEK_API_KEY=… node tools/bench-run.mjs --plan .cfb-runtime/bench/b1/plan.json --base-url … --model deepseek-v4.1-flash --out .cfb-runtime/bench/b1 [--policy-dir D] [--gold-dir D]
//   --dry-run  零 API：核对金标摘要、枚举请求，并给出两条基线 —— 「不压（原文当稿）」与「金标自比（应全 1）」；不写 receipt。
// 续跑：results.jsonl 里已有的（策略 × 金标）跳过；同一条命令再跑只补缺的。本文件之外不发网络请求；主模型从不参与（模式 2 不量结局）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { BASE_POLICY } from './helpers/generation.mjs'
import { loadPolicyFor } from './traj-run.mjs'
import { draftDistance } from './helpers/hand-draft.mjs'
import { isMode1GoldEligible } from './helpers/mode1-quality.mjs'
import { loadGold, goldUse, goldRulerOk, DRAFT_DISTANCE_VERSION, benchReport, benchReportMd } from './helpers/three-mode.mjs'
import { evidenceDigest } from '../src/evidence-program.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
export const benchCacheKey = ({ policyId, policy, goldId, goldDigest, model }) => evidenceDigest({
  policyId: policyId || (policy && policy.id) || 'base',
  patches: (policy && policy.patches) || [],
  config: (policy && policy.config) || null,
  goldId,
  goldDigest,
  model: model || '',
}).slice(0, 16)

function parseArgs(argv) {
  const o = { plan: null, out: null, baseUrl: null, model: null, dryRun: false, noCache: false, policyDir: null, goldDir: null, concurrency: 2, timeoutMs: Number(process.env.CFB_BENCH_TIMEOUT_MS || 22000) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--plan') o.plan = v(); else if (a === '--out') o.out = v(); else if (a === '--base-url') o.baseUrl = v(); else if (a === '--model') o.model = v()
    else if (a === '--dry-run') o.dryRun = true; else if (a === '--no-cache') o.noCache = true; else if (a === '--policy-dir') o.policyDir = v(); else if (a === '--gold-dir') o.goldDir = v(); else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--timeout-ms') o.timeoutMs = Number(v()); else if (a === '--require-fp') { /* 压缩调用走生产 birthOffline，没有指纹口径（与 traj-run 压缩臂同）；接受但不起作用 */ }
    else throw new Error('未知参数 ' + a)
  }
  if (!o.plan) throw new Error('--plan FILE 必填（cfb-cycle plan-bench 冻结的 cfb.bench-plan/1）')
  if (!o.out) o.out = path.dirname(o.plan)
  return o
}
const strip = (d) => { const { slots, ...rest } = d; return rest }
// v14.20.1：调用失败（超时 / 异常）不是「压不出」，是通道故障 ⇒ 不计分、不写进缓存（下次要重试）、单独计数
const TRANSIENT = new Set(['error', 'distill-failed'])
// v14.20.1 dd/2：闸失败 ⇒ 这轮等于「没交稿」。以前把原文当稿去比，白捡决定/锚点两项（base 因此虚高到 0.519）；现在记 0 分，原始数字留在 distanceOnRaw 里可回看。
const REFUSAL = (why) => ({ score: 0, decision: 0, excludedRecall: 0, acceptOk: 0, openRecall: 0, anchorPrecision: 1, lengthOk: 0, key: [0, 0, 0, 0, 1, 0], verdict: 'refused:' + (why || 'gate'), slots: null })


function loadSiblingBenchCache(outDir, resPath) {
  const map = new Map()
  const parent = path.dirname(path.resolve(outDir))
  if (!fs.existsSync(parent)) return map
  for (const name of fs.readdirSync(parent).sort()) {
    const fp = path.join(parent, name, 'results.jsonl')
    if (path.resolve(fp) === path.resolve(resPath) || !fs.existsSync(fp)) continue
    for (const line of fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line)
        if (!r || r.dry || TRANSIENT.has(r.why) || !r.cacheKey) continue
        if (r.ok && typeof r.text !== 'string') continue
        map.set(r.cacheKey, r)
      } catch { /* ignore malformed row */ }
    }
  }
  return map
}

export async function benchRun(o, { I = null, compile = null, now = () => new Date().toISOString() } = {}) {
  const plan = JSON.parse(fs.readFileSync(o.plan, 'utf8'))
  if (plan.schema !== 'cfb.bench-plan/1') throw new Error('bench-plan-schema')
  if (plan.metric !== DRAFT_DISTANCE_VERSION) throw new Error(`metric-mismatch: 计划 ${plan.metric} ≠ 本机 ${DRAFT_DISTANCE_VERSION}（公式改过，这个计划不能再跑）`)
  const goldDir = o.goldDir || (process.env.CFB_CYCLE_DIR ? path.join(path.resolve(process.env.CFB_CYCLE_DIR), 'gold') : path.join(ROOT, 'transfer', 'gold'))
  const allGold = loadGold(goldDir)
  const gold = new Map(allGold.map((g) => [g.id, g]))
  // 用途隔离（v14.21.0）：use=train 的条目只为训练料存在，出现在标尺计划里 = 泄漏，直接拒跑而不是悄悄跳过
  const trainScoped = allGold.filter((g) => !goldRulerOk(g))   // 训练侧 = 非有效标尺（含被尺子降级的）
  if (trainScoped.length) console.log(`  用途隔离：注册表里 ${trainScoped.length} 条 use=train 不进标尺（只作 micro 训练料）`)
  const items = plan.gold.map((p) => {
    const g = gold.get(p.id)
    if (!g) throw new Error('gold-missing:' + p.id + '（' + goldDir + '）')
    if (!goldRulerOk(g)) throw new Error(`gold-use-mismatch:${p.id}（train-only：use=train 或被尺子判 not-gold ⇒ 只能当训练料。要进标尺得真机重跑到线，再 node tools/gold-attest.mjs 重盖章）`)
    if (!isMode1GoldEligible(g) || g.qualityAudit?.status !== 'clean') throw new Error(`gold-quality-rejected:${p.id}（内容审计/谱系未通过；旧计划作废）`)
    if (g.digest !== p.digest) throw new Error(`gold-changed:${p.id}（计划 ${p.digest} ≠ 现在 ${g.digest}：金标被改过，计划作废）`)
    return { ...g, split: p.split }
  })
  const policies = plan.policies.map((id) => ({ id, policy: id === 'base' ? BASE_POLICY : loadPolicyFor('policy:' + id, o.policyDir) }))
  fs.mkdirSync(o.out, { recursive: true })
  const resPath = path.join(o.out, 'results.jsonl')
  // 续跑只认「结构完好」的行：坏行 / 故障行（distance 为 null 或 key 不是 6 元数组）必须重跑，
  //   并就地从 results.jsonl 里剔掉 —— 否则报告按 (策略×金标) 计数会发现同键两行，把两行一起判废。
  const usableRow = (r) => r && r.schema === 'cfb.bench-row/1' && !!r.distance && Array.isArray(r.distance.key) && r.distance.key.length === 6
  const priorRaw = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r && !r.dry) : []
  const prior = priorRaw.filter(usableRow)
  if (prior.length !== priorRaw.length) {
    if (prior.length) fs.writeFileSync(resPath, prior.map((r) => JSON.stringify(r)).join('\n') + '\n'); else fs.rmSync(resPath, { force: true })
    console.log(`  续跑剔掉 ${priorRaw.length - prior.length} 行坏结果（故障未计分行或结构不全），这些 job 重跑`)
  }
  const have = new Set(prior.map((r) => `${r.policy}|${r.gold}`))
  const jobs = []
  for (const p of policies) for (const g of items) if (o.dryRun || !have.has(`${p.id}|${g.id}`)) jobs.push({ p, g })
  console.log(`按计划 ${plan.id}（digest ${plan.digest}，${plan.metric}）：策略 ${plan.policies.join(', ')} × 金标 ${items.length}（${plan.split}）= ${plan.policies.length * items.length} 次压缩调用；已有 ${have.size}，本次 ${o.dryRun ? '0（dry-run）' : jobs.length}；预估 ≈$${plan.cost.expectedUsd}（上界 $${plan.cost.capUsd}）`)
  const rows = []
  if (o.dryRun) {
    for (const g of items) {
      const self = draftDistance(g.draft, g.draft, { raw: g.raw, ctx: g.ctx }), none = draftDistance(g.raw, g.draft, { raw: g.raw, ctx: g.ctx })
      console.log(`  ${g.id} [${g.split}] 金标 ${g.draft.length} 字 / 原文 ${g.raw.length} 字：自比 key=${self.key.join(',')}（${self.verdict}）；不压 score=${none.score} ${none.verdict}`)
      rows.push({ schema: 'cfb.bench-row/1', plan: plan.id, at: now(), dry: true, policy: 'none(raw)', gold: g.id, family: g.family, split: g.split, ok: false, why: 'dry-run', outChars: g.raw.length, draftChars: g.draft.length, rawChars: g.raw.length, distance: strip(none) })
      rows.push({ schema: 'cfb.bench-row/1', plan: plan.id, at: now(), dry: true, policy: 'self(gold)', gold: g.id, family: g.family, split: g.split, ok: true, why: null, outChars: g.draft.length, draftChars: g.draft.length, rawChars: g.raw.length, distance: strip(self) })
    }
    console.log(`dry-run：不发请求、不写 receipt。真跑：去掉 --dry-run（需要 DEEPSEEK_API_KEY）`)
    return { plan, rows, dry: true }
  }
  const allLocal = policies.every((p) => p.policy?.config?.compressLocalModel === true)
  const apiKey = process.env.DEEPSEEK_API_KEY || (compile || allLocal ? 'mock' : null); if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
  if (!compile && !allLocal && (!o.baseUrl || !o.model)) throw new Error('--base-url 与 --model 必填')
  I = I || await import('../index.js')
  const crossCache = o.noCache ? new Map() : loadSiblingBenchCache(o.out, resPath)
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); const cred = path.join(d, 'c.yaml'); fs.writeFileSync(cred, 'K: "' + apiKey + '"\n', { mode: 0o600 })
  let i = 0
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency || 2) }, async () => {
    while (i < jobs.length) {
      const { p, g } = jobs[i++]
      const isLocal = p.policy?.config?.compressLocalModel === true
      const ck = benchCacheKey({ policyId: p.id, policy: p.policy, goldId: g.id, goldDigest: g.digest, model: isLocal ? 'v5-micro-local' : o.model })
      const hit = crossCache.get(ck)
      if (hit) {
        const text = hit.ok && typeof hit.text === 'string' ? hit.text : g.raw
        const raw0 = draftDistance(text, g.draft, { raw: g.raw, ctx: g.ctx })
        const dist = hit.ok ? raw0 : (TRANSIENT.has(hit.why) ? null : REFUSAL(hit.why))
        const row = { schema: 'cfb.bench-row/1', plan: plan.id, at: now(), dry: false, policy: p.id, gold: g.id, family: g.family, split: g.split, ok: !!hit.ok, why: hit.why || null, reason: hit.reason || null, promptVersion: hit.promptVersion || null, ms: 0, cachedFrom: hit.plan, cacheKey: ck, outChars: text.length, draftChars: g.draft.length, rawChars: g.raw.length, distance: strip(dist), distanceOnRaw: hit.ok ? undefined : strip(raw0), text: hit.ok ? text : null }
        fs.appendFileSync(resPath, JSON.stringify(row) + '\n'); rows.push(row)
        console.log(`  ${p.id} × ${g.id} [${g.split}]: [缓存自 ${hit.plan}] ${hit.ok ? `稿 ${text.length} 字` : '闸不过 ' + hit.why + ' ⇒ 原文'} · score ${dist.score} · ${dist.verdict}`)
        continue
      }
      const cfg0 = I.offlineBirthConfig({ model: isLocal ? 'v5-micro-local' : o.model, baseUrl: isLocal ? 'local://v5' : o.baseUrl, credentialsPath: cred, policy: p.id === 'base' ? null : p.policy, normalizeConfig: I.normalizeConfig, timeoutMs: o.timeoutMs })
      const cfg = g.raw.length < 3100 ? { ...cfg0, birthMinSavedChars: Math.min(cfg0.birthMinSavedChars || 50, Math.max(20, Math.floor(g.raw.length * 0.05))), ...(g.raw.length < 2600 ? { birthTokenGate: false } : {}) } : cfg0
      let b
      try { b = await I.birthOffline({ raw: g.raw, ctx: g.ctx, calls: g.calls || [], cfg, compile }) } catch (e) { b = { ok: false, text: g.raw, why: 'error', reason: String(e && e.message || e), ms: 0 } }
      const text = b.ok ? b.text : g.raw
      const raw0 = draftDistance(text, g.draft, { raw: g.raw, ctx: g.ctx })
      const skipped = !b.ok && TRANSIENT.has(b.why)                  // 调不通 ≠ 压不出：这行不计分（distance=null，报告里按错误剔除）
      const dist = skipped ? null : b.ok ? raw0 : REFUSAL(b.why)
      const row = { schema: 'cfb.bench-row/1', plan: plan.id, at: now(), dry: false, policy: p.id, gold: g.id, family: g.family, split: g.split, ok: !!b.ok, why: b.why || null, reason: b.reason ? String(b.reason).slice(0, 200) : null, info: b.info || null, promptVersion: b.promptVersion || null, ms: b.ms ?? null, cacheKey: ck, outChars: text.length, draftChars: g.draft.length, rawChars: g.raw.length, distance: dist ? strip(dist) : null, distanceOnRaw: b.ok || skipped ? undefined : strip(raw0), text: b.ok ? text : null }
      if (!TRANSIENT.has(row.why)) crossCache.set(ck, row)
      fs.appendFileSync(resPath, JSON.stringify(row) + '\n'); rows.push(row)
      console.log(`  ${p.id} × ${g.id} [${g.split}]: ${b.ok ? `稿 ${text.length} 字` : skipped ? '调用失败 ⇒ 不计分' : '闸不过 ' + b.why + ' ⇒ 记 0 分（原文白送分 ' + raw0.score + ' 已另存）'} · score ${dist ? dist.score : '—'} · ${dist ? dist.verdict : '—'} · key ${dist ? dist.key.join(',') : '—'}`)
    }
  }))
  fs.rmSync(d, { recursive: true, force: true })
  const all = prior.concat(rows)
  const paidCalls = all.filter((r) => !r.cachedFrom && !String(r.promptVersion || '').startsWith('compress-v5-local:')).length
  const cachedHits = all.filter((r) => r.cachedFrom).length
  const rep = benchReport(all); const md = benchReportMd(rep, { title: `基准 ${plan.id}` })
  fs.writeFileSync(path.join(o.out, 'report.md'), md + '\n'); fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(rep, null, 2) + '\n')
  const receipt = { schema: 'cfb.bench-receipt/1', plan: plan.id, digest: plan.digest, at: now(), rows: all.length, callsThisRun: rows.filter((r) => !r.cachedFrom).length, cachedHits, gateFails: all.filter((r) => !r.ok && !TRANSIENT.has(r.why)).length, errors: all.filter((r) => TRANSIENT.has(r.why)).length, timeoutMs: o.timeoutMs, estimatedUsd: +(paidCalls * plan.cost.pricing.compressUsd).toFixed(3), best: rep.best }
  fs.writeFileSync(path.join(o.out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log('\n' + md)
  return { plan, rows: all, report: rep, receipt, dry: false, cachedHits }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) benchRun(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
