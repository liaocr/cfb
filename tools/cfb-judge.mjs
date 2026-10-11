// tools/cfb-judge.mjs —— 判断层工作台：测量、投票、一致性、分歧裁决（全部可离线自检）。
//
// 判断层的三条硬要求（用户 2026-10-02）：
//   ① 科学可量化：每个维度有定义/刻度/锚点/测量误差；
//   ② 上限要高：15 维向量（代码 9 / 评委 6）；但 v14.2 起只有代码维（含 6 个任务真值维）是选择信号，
//      评委维只做诊断——状态空间的 bit 数是「能分多细」，不是「关于质量的信息量」，二者别混（见 CLOSED-LOOP-V2.md）；
//   ③ 必须有大模型参与：语义维度交评委，代码只做确定性部分，二者交叉验证。
//
// 子命令：
//   node tools/cfb-judge.mjs capacity                报告判断层容量与分辨率上限
//   node tools/cfb-judge.mjs dims                    打印维度表（定义/刻度/锚点/谁测）
//   node tools/cfb-judge.mjs prompt --task f --ctx f --draft f   生成评委提示词
//   node tools/cfb-judge.mjs agree --votes f.json    多票一致性（ICC 近似）
//   node tools/cfb-judge.mjs check --votes f.json    校验评委输出合法性
//   node tools/cfb-judge.mjs disagree --code JSON --llm JSON     规则与评委双向交叉校验（同时抓评委虚高与规则盲区）
//   node tools/cfb-judge.mjs audit-traj --results f.jsonl        分叉轨迹分歧轮语义归因（代码维 + 评委归因提示词）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DIMENSIONS, DIMS_BY_RATER, judgeCapacity, binaryCeiling, judgeLadPrompt, parseJudgeLad, compositeScore, DEFAULT_WEIGHTS, raterAgreement, ruleLlmDisagreement, pairedBootstrap, pairedEffectSize, codeDimensions, trajDivergenceJudgePrompt, CAUSAL_ATTRIBUTIONS, benchJudgePrompt, parseBenchJudge, BENCH_SEMANTIC_VERDICTS } from './helpers/judge-layer.mjs'
import { episodeOutcome } from './helpers/ruler.mjs'
import { toRow, fitWeights, rankAgreement, missingDimensionSignal, activeSelect } from './helpers/calibration.mjs'
import { loadGold, goldUse, goldRulerOk } from './helpers/three-mode.mjs'
import { auditMode1Output, isMode1GoldEligible } from './helpers/mode1-quality.mjs'
import { loadFrozenTasks } from './helpers/candidates.mjs'
import { truthDimensions } from './helpers/truth-dims.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const f = (a, d) => (a.includes(d) ? a[a.indexOf(d) + 1] : null)
const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const PAD = (s, n) => String(s).padEnd(n)
const NUM = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : '—')

function cmdCapacity() {
  const c = judgeCapacity(), b = binaryCeiling(2)
  console.log('判断层容量（分辨率上限，不是「关于质量的信息量」）')
  console.log('  维度数        : ' + c.dimensions + '（代码 ' + c.codeDims + ' / 评委 ' + c.llmDims + '）')
  console.log('  状态空间      : ' + c.states.toLocaleString() + ' 种（全部维度）  ⇒ log2 = ' + c.bits.toFixed(2) + ' bit / 次观测')
  console.log('  其中代码维    : ' + c.codeBits.toFixed(2) + ' bit / 次观测（选择信号只用这部分：selectionSignal=' + c.selectionSignal + '）')
  console.log('  二值判据对照  : ' + b.bits.toFixed(2) + ' bit / 次观测')
  console.log('')
  console.log('  含义：这些 bit 是「刻度能分多细」的上限；一次观测真正带来的、关于「候选是否更好」的信息')
  console.log('        要按配对胜负的后验来算（tools/cfb-cycle.mjs 的 expectedBitsNextPair，先验下一对 ≈ 0.19 bit）。')
  console.log('        评委维（llm）未经校准、锚点一致性未测，v14.2 起只做诊断，不进选择信号。')
  console.log('')
  console.log('  最低可分辨效应（pairedBootstrap，双侧 95%）：')
  for (const n of [5, 10, 20, 50, 100]) {
    // 近似：σ=1 刻度、效应 d 时，n 能分辨的最小 d
    console.log('    n=' + PAD(n, 5) + ' ⇒ 若 σ≈1 刻度，可分辨 d ≈ ' + (2.8 / Math.sqrt(n)).toFixed(2) + '（d<0.2 为微小、0.5 中等、0.8 大）')
  }
  console.log('')
  console.log('  权重默认值（将被回灌层用真实结果覆盖，不是写死的最终值）：')
  for (const [k, v] of Object.entries(DEFAULT_WEIGHTS)) console.log('    ' + PAD(k, 20) + (v > 0 ? '+' : '') + v)
}
function cmdDims() {
  console.log(PAD('维度', 22) + PAD('刻度', 10) + PAD('谁来测', 8) + '定义')
  console.log('-'.repeat(110))
  for (const d of DIMENSIONS) console.log(PAD(d.id, 22) + PAD('[' + d.scale[0] + ',' + d.scale[1] + ']', 10) + PAD(d.rater, 8) + d.def.slice(0, 66))
  console.log('')
  console.log('锚点（评委刻度对齐的依据，必须与黄金集一起维护）：')
  for (const d of DIMENSIONS.filter((x) => x.rater === 'llm')) console.log('  ' + PAD(d.id, 22) + JSON.stringify(d.anchors))
}
function cmdPrompt(args) {
  const p = judgeLadPrompt({ task: read(f(args, '--task')), ctx: read(f(args, '--ctx')), draft: read(f(args, '--draft')), followup: read(f(args, '--followup')), reference: read(f(args, '--reference')) })
  process.stdout.write(p)
}
function cmdAgree(args) {
  const file = f(args, '--votes')
  const votes = file && fs.existsSync(file) ? readJson(file) : null
  if (!votes) { console.log('需要 --votes <json>：数组，每项是一次评委输出'); process.exitCode = 1; return }
  const parsed = votes.map((v) => parseJudgeLad(v))
  const bad = parsed.filter((p) => !p.ok)
  console.log('票数 ' + votes.length + ' ；合法 ' + (votes.length - bad.length) + ' ；非法 ' + bad.length)
  if (bad.length) for (const b of bad) console.log('  非法: ' + b.reason)
  const okVotes = parsed.filter((p) => p.ok).map((p) => p.values)
  if (okVotes.length >= 2) {
    const ag = raterAgreement(okVotes)
    console.log('')
    console.log(PAD('维度', 22) + PAD('均值', 10) + PAD('标准差', 10) + PAD('ICC近似', 10) + '判定')
    for (const [k, v] of Object.entries(ag)) {
      const verdict = v.sd == null ? '样本不足' : v.sd <= 0.5 ? '一致' : v.sd <= 1.2 ? '尚可' : '**分歧大**'
      console.log(PAD(k, 22) + PAD(NUM(v.mean, 2), 10) + PAD(NUM(v.sd, 2), 10) + PAD(NUM(v.icc, 2), 10) + verdict)
    }
    console.log('')
    const cs = okVotes.map((v) => compositeScore(v).score)
    console.log('综合分: ' + cs.map((x) => NUM(x, 2)).join(' / ') + '  ⇒ 极差 ' + NUM(Math.max(...cs) - Math.min(...cs), 2))
    console.log('提示：极差 > 5 说明该样本的评委分歧足以改变结论，应送人工裁决或加票。')
  }
}
function cmdCheck(args) {
  const file = f(args, '--votes')
  if (!file || !fs.existsSync(file)) { console.log('需要 --votes <json>'); process.exitCode = 1; return }
  const votes = readJson(file)
  let bad = 0
  for (const [i, v] of votes.entries()) {
    const p = parseJudgeLad(v)
    if (!p.ok) { bad++; console.log('第 ' + i + ' 票不合法: ' + p.reason) }
    else if (p.missing.length) console.log('第 ' + i + ' 票缺维度: ' + p.missing.join(','))
  }
  console.log(bad ? '有 ' + bad + ' 票不合法' : '全部合法（' + votes.length + ' 票）')
  process.exitCode = bad ? 1 : 0
}
function cmdDisagree(args) {
  const codeVals = JSON.parse(f(args, '--code') || '{"formClosed":1,"invention":0}')
  const llmVals = JSON.parse(f(args, '--llm') || '{"formClosed":1,"evidenceSufficiency":0.25,"stateCalibration":0.3,"actionResolve":2}')
  const out = ruleLlmDisagreement(codeVals, llmVals)
  console.log(JSON.stringify({ codeVals, llmVals, disagreements: out }, null, 2))
  return out
}
function cmdAuditTraj(args) {
  const planN = f(args, '--plan')
  const file = f(args, '--results') || (planN ? path.join(ROOT, '.cfb-runtime', 'traj', 't' + planN, 'results.jsonl') : null)
  if (!file || !fs.existsSync(file)) { console.log('需要 --results <jsonl> 或 --plan N'); process.exitCode = 1; return }
  const rows = fs.readFileSync(path.resolve(file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error && r.status !== 'awaiting-draft')
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.task}|${r.sample ?? 0}`
    const arm = r.policy ? `policy:${r.policy}` : r.variant
    if (!groups.has(key)) groups.set(key, { task: r.task, sample: r.sample ?? 0, arms: {} })
    groups.get(key).arms[arm] = r
  }
  const items = []
  for (const g of groups.values()) {
    const raw = g.arms.raw; if (!raw) continue
    for (const [arm, r] of Object.entries(g.arms)) {
      if (arm === 'raw') continue
      let div = r.shadow?.divergedAt ?? null
      if (!div) {
        const rounds = Math.max((raw.transcript || []).length, (r.transcript || []).length)
        for (let i = 1; i < rounds; i++) {
          const sa = JSON.stringify(raw.transcript?.[i]?.calls || []), sb = JSON.stringify(r.transcript?.[i]?.calls || [])
          if (sa !== sb) { div = i + 1; break }
        }
      }
      if (!div || div < 2) continue
      const rawT = (raw.transcript || [])[div - 2], compT = (r.transcript || [])[div - 2]
      if (auditMode1Output(compT?.stored || '').status !== 'clean') continue
      const code = codeDimensions(compT?.stored || '', rawT?.reasoning || '')
      const prompt = trajDivergenceJudgePrompt({
        task: g.task,
        round: div,
        rawReasoning: rawT?.reasoning || '',
        compressedDraft: compT?.stored || '',
        rawNextAction: JSON.stringify(raw.transcript?.[div - 1]?.calls || []),
        compressedNextAction: JSON.stringify(r.transcript?.[div - 1]?.calls || []),
        outcome: { raw: episodeOutcome(raw), [arm]: episodeOutcome(r) },
      })
      items.push({ task: g.task, sample: g.sample, arm, divergeRound: div, codeDims: code, outcome: { raw: episodeOutcome(raw), [arm]: episodeOutcome(r) }, prompt })
    }
  }
  console.log(`双轨轨迹分歧审计：${items.length} 个分歧对（因果归因集：${CAUSAL_ATTRIBUTIONS.join(' | ')}）`)
  for (const it of items) console.log(`  ${it.task}#${it.sample} ${it.arm} @ r${it.divergeRound}：code(form=${it.codeDims.formClosed}, inv=${it.codeDims.invention.toFixed(3)})  raw=${it.outcome.raw.solved ? 'solved@r' + it.outcome.raw.roundsToFix : 'unsolved'} vs ${it.arm}=${it.outcome[it.arm].solved ? 'solved@r' + it.outcome[it.arm].roundsToFix : 'unsolved'}`)
  return items
}
function cmdAuditBench(args) {
  const planN = f(args, '--plan')
  const file = f(args, '--results') || (planN ? path.join(ROOT, '.cfb-runtime', 'bench', 'b' + planN, 'results.jsonl') : null)
  if (!file || !fs.existsSync(file)) { console.log('需要 --results <bench results.jsonl> 或 --plan N'); process.exitCode = 1; return }
  const goldDir = f(args, '--gold-dir') || path.join(ROOT, 'transfer', 'gold')
  // 用途隔离：use=train 的条目是训练料，不得充当评审参照（v14.21.0）
  const goldMap = new Map(loadGold(goldDir).filter((g) => goldRulerOk(g) && isMode1GoldEligible(g) && g.qualityAudit?.status === 'clean').map((g) => [g.id, g]))
  const rawRows = fs.readFileSync(path.resolve(file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rows = rawRows.filter((r) => !r.dry && r.policy && r.gold && r.distance && goldMap.has(r.gold)
    && (typeof r.text !== 'string' || auditMode1Output(r.text).status === 'clean'))
  const items = []
  for (const r of rows) {
    if (r.distance.verdict === 'close' && !args.includes('--all')) continue
    const g = goldMap.get(r.gold)
    const prompt = benchJudgePrompt({
      goldId: r.gold,
      family: r.family,
      rawReasoning: g?.raw || '',
      ctx: g?.ctx || '',
      goldDraft: g?.draft || '',
      candidateDraft: r.text || '',
      ruleDistance: r.distance,
    })
    items.push({ policy: r.policy, gold: r.gold, family: r.family, ok: !!r.ok, text: r.text || '', raw: g?.raw || '', verdict: r.distance.verdict, score: r.distance.score, prompt })
  }
  console.log(`Mode 2 基准双轨语义复核：${items.length} 项待语义裁决（裁决集：${BENCH_SEMANTIC_VERDICTS.join(' | ')}）`)
  for (const it of items) console.log(`  ${it.policy} × ${it.gold} [${it.family}]：dd verdict=${it.verdict} score=${it.score}`)
  return items
}
async function cmdAuditBenchLive(args) {
  const items = cmdAuditBench(args)
  if (!items || !items.length || !args.includes('--live')) return items
  const { makeChat } = await import('./effect-eval.mjs')
  const onlyPol = f(args, '--policy')
  const chat = makeChat({ baseUrl: f(args, '--base-url') || process.env.DEEPSEEK_BASE_URL, apiKey: process.env.DEEPSEEK_API_KEY, timeoutMs: 90000 })
  const model = f(args, '--model') || process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash'
  for (const it of items) {
    if (onlyPol && it.policy !== onlyPol) continue
    if (!it.ok || !it.text) { console.log(`  [LLM 跳过] ${it.policy} × ${it.gold}：未产出有效压缩稿（已走原文回退）`); continue }
    const res = await chat({ model, messages: [{ role: 'user', content: it.prompt }], thinking: { type: 'disabled' }, max_tokens: 400, stream: false })
    const rawJson = String(res.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed = parseBenchJudge(rawJson)
    const code = codeDimensions(it.text, it.raw)
    const dis = parsed.ok ? ruleLlmDisagreement(code, parsed.values) : []
    it.llm = parsed
    it.disagreements = dis
    console.log(`  [LLM 语义裁决] ${it.policy} × ${it.gold}：verdict=${parsed.semanticVerdict || parsed.reason} blindspot=${parsed.ruleBlindspot ?? '—'} dis=${dis.length} note=${parsed.note || rawJson.slice(0, 100)}`)
  }
  return items
}
function cmdCalibrate(args) {
  const file = f(args, '--obs')
  let rows = []
  if (file && fs.existsSync(file)) {
    const rawRows = fs.readFileSync(path.resolve(file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    rows = rawRows.map((r) => r.x && Number.isFinite(r.y) ? r : toRow(r.features || r, r.outcome ?? r.y))
  } else {
    const tasks = new Map(loadFrozenTasks().map((t) => [t.id, t]))
    const loadDraftMap = (p) => {
      if (!fs.existsSync(p)) return new Map()
      const j = readJson(p)
      return new Map((Array.isArray(j) ? j : j.rows || [])
        .filter((r) => r && r.id && typeof r.text === 'string' && auditMode1Output(r.text).status === 'clean')
        .map((r) => [r.id, r.text]))
    }
    const mrDir = path.join(ROOT, 'transfer', 'mr')
    const mapByVar = {
      oracle: loadDraftMap(path.join(mrDir, 'oracle-d2.json')),
      oracle2: loadDraftMap(path.join(mrDir, 'oracle-d2b.json')),
      oracle3: loadDraftMap(path.join(mrDir, 'oracle-d2c.json')),
      auto: loadDraftMap(path.join(mrDir, 'auto-d2.json')),
      auto8: loadDraftMap(path.join(mrDir, 'auto-d2c.json')),
      auto8b: loadDraftMap(path.join(mrDir, 'auto-d2d.json')),
    }
    for (const runName of ['run1', 'run4']) {
      const rf = path.join(mrDir, runName, 'results.jsonl')
      if (!fs.existsSync(rf)) continue
      for (const l of fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean)) {
        const r = JSON.parse(l)
        const t = tasks.get(r.task)
        if (!t || !r.rule || !r.judge) continue
        const draft = r.variant === 'raw' ? t.chain.a2.raw : (mapByVar[r.variant]?.get(r.task) || t.side)
        if (!draft) continue
        const cd = codeDimensions(draft, t.chain.a2.raw, { total: 4 })
        const td = truthDimensions(draft, t.chain, t.spec)
        const full = {
          ...cd,
          ...td,
          evidenceSufficiency: r.judge.claimJustified ? 0.85 : 0.25,
          actionResolve: Number(r.judge.correct ?? 5),
          foresight: r.judge.followsPlan ? 0.85 : 0.3,
          stateCalibration: r.judge.greenAsProof ? 0.2 : 0.85,
          infoDensity: draft.length < t.chain.a2.raw.length ? 0.8 : 0.4,
          redundancy: draft.length < t.chain.a2.raw.length ? 0.2 : 0.6,
        }
        const y = (r.rule.next ? 1 : 0) - (r.rule.falseDone ? 1 : 0) - (r.rule.avoid === 0 ? 0.5 : 0) - (r.rule.repeat ? 0.5 : 0)
        rows.push(toRow(full, y))
      }
    }
  }
  const fit = fitWeights(rows)
  const agreeDefault = rankAgreement(rows, DEFAULT_WEIGHTS)
  const agreeFit = rankAgreement(rows, fit.weights || DEFAULT_WEIGHTS)
  const miss = missingDimensionSignal(rows)
  console.log(`判断层回灌校准（观测数 n=${rows.length}，状态=${fit.ok ? '已拟合' : fit.reason}）`)
  console.log(`  默认权重 Spearman ρ = ${NUM(agreeDefault.rho, 3)} → 岭回归校准后 ρ = ${NUM(agreeFit.rho, 3)}（r²=${NUM(fit.r2, 3)}，LOO-RMSE=${NUM(fit.looRmse, 3)}，置信度=${fit.confidence || 'low'}）`)
  if (fit.ok) {
    const topW = Object.entries(fit.weights).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    console.log(`  拟合非零维度权重：${topW.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  console.log(`  缺维度诊断：${miss.ok ? miss.note : `样本不足（n=${miss.n}）`}`)
  return { ok: fit.ok, n: rows.length, fit, agreeDefault, agreeFit, missingDimension: miss }
}

function main() {
  const [cmd = 'capacity', ...args] = process.argv.slice(2)
  if (cmd === 'capacity') cmdCapacity()
  else if (cmd === 'dims') cmdDims()
  else if (cmd === 'prompt') cmdPrompt(args)
  else if (cmd === 'agree') cmdAgree(args)
  else if (cmd === 'check') cmdCheck(args)
  else if (cmd === 'disagree') cmdDisagree(args)
  else if (cmd === 'audit-traj') cmdAuditTraj(args)
  else if (cmd === 'audit-bench') { if (args.includes('--live')) cmdAuditBenchLive(args); else cmdAuditBench(args) }
  else if (cmd === 'calibrate') cmdCalibrate(args)
  else throw new Error('未知子命令 ' + cmd)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
