#!/usr/bin/env node
// tools/phase0-report.mjs —— 决议阶段 0 的六个数字（docs/analysis/DECISION-2026-09-27.md §5）
//
//   node tools/phase0-report.mjs <trace.log> [trace.log.1 ...] [--json]
//
// 只读 trace，不改任何东西。按 BOOT 分组（每次网关重启 = 一组；不同构建不混算）。
// 每个数字旁边直接印出决策表的判定，不需要人再解释。
//
//   N1  历史 reasoning 是否跨 user 轮保留           ← llm-stream.roles / reasoningChars（0a 即可）
//   N2  reasoning 块长度分布（回本门槛的唯一依据）   ← birth-below-floor / birth-passthrough / birth-condensed 的 rawChars（0b 精确）
//                                                      没有时退化为 llm-stream.reasoningChars 去重估算（0a 近似，会标明）
//   N3  免费窗口 otherStartToLastEndMs                ← birth-window-probe（0b 才有）
//   N4  lastEndToFinishMs                             ← 同上
//   N5  宿主模型 / provider                            ← host-model / llm-stream.model
//   N6  基线：每会话请求数、工具结果数、每个人类回合的工具结果数 ← llm-stream（粗粒度；细指标由阶段 1 cf-eval 的 loop/recheck 给）
//   健康：birth-start-error / birth-settle-error / birth-flush / llm-stream-error / birth-no-async-iter / birth-session-ambiguous
import fs from 'node:fs'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const RE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/

const q = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)
const fmtMs = (v) => (v == null ? '—' : v + 'ms')

/** 'system user assistant tool*3' → ['system','user','assistant','tool','tool','tool'] */
export function expandRoles(roles) {
  const out = []
  for (const tok of String(roles || '').split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(.*?)\*(\d+)$/)
    if (m) { for (let i = 0; i < Number(m[2]); i++) out.push(m[1]) } else out.push(tok)
  }
  return out
}

const freshGroup = (boot, ts) => ({
  boot, bootAt: ts, lastAt: ts, lines: 0,
  streams: [], hostModels: Object.create(null), streamModels: Object.create(null),
  rawExact: [], rawExactWhy: Object.create(null), rawApprox: new Map(),
  probes: [], health: Object.create(null), dryRunStreams: 0,
})

export async function readTraces(files) {
  const groups = []
  let g = null
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      const m = line.match(RE)
      if (!m) continue
      let obj
      try { obj = JSON.parse(m[3]) } catch { continue }
      const ts = m[1], tag = m[2]
      if (tag === 'BOOT') { if (!obj.rotatedCopy || !g) { g = freshGroup(obj, ts); groups.push(g) } ; continue }
      if (!g) { g = freshGroup(null, ts); groups.push(g) }
      g.lines++; g.lastAt = ts
      switch (tag) {
        case 'llm-stream': g.streams.push(obj); if (obj.model) g.streamModels[obj.model] = (g.streamModels[obj.model] || 0) + 1; break
        case 'host-model': { const k = (obj.model || '?') + ' @ ' + (obj.provider || '?'); g.hostModels[k] = (g.hostModels[k] || 0) + 1; break }
        case 'birth-below-floor': case 'birth-passthrough': case 'birth-condensed':
          if (Number.isFinite(obj.rawChars)) { g.rawExact.push(obj.rawChars); const w = tag === 'birth-condensed' ? 'condensed' : (obj.why || tag); g.rawExactWhy[w] = (g.rawExactWhy[w] || 0) + 1 }
          break
        case 'birth-window-probe': g.probes.push(obj); break
        case 'birth-dry-run-stream': g.dryRunStreams++; break
        case 'birth-start-error': case 'birth-settle-error': case 'birth-flush': case 'llm-stream-error':
        case 'birth-no-async-iter': case 'birth-session-ambiguous': case 'birth-distill-failed':
          { const k = tag + (obj.why ? ':' + obj.why : '') + (obj.code ? ':' + obj.code : ''); g.health[k] = (g.health[k] || 0) + 1; break }
        default: break
      }
    }
  }
  return groups
}

/** N1 / N2(近似) / N6 都从 llm-stream 记录算 */
export function analyzeStreams(streams) {
  const n1 = { requests: streams.length, withHistoryReasoning: 0, eligible: 0, firstAssistantHasReasoning: 0, reasoningAssistantRatio: [] }
  const approx = new Map()
  // 会话切分：messageCount 回落 ⇒ 新会话（粗粒度，只用于 N6 与去重）
  const sessions = []
  let cur = null, prevCount = -1
  for (const s of streams) {
    const roles = expandRoles(s.roles)
    const mc = Number.isFinite(s.messageCount) ? s.messageCount : roles.length
    if (!cur || mc < prevCount) { cur = { requests: 0, maxToolResults: 0, maxHumanUsers: 0, id: sessions.length }; sessions.push(cur) }
    prevCount = mc
    cur.requests++
    const hasToolRole = roles.includes('tool')
    const userCount = Number.isFinite(s.userCount) ? s.userCount : roles.filter((r) => r === 'user').length
    const toolResults = Number.isFinite(s.toolResultCount) ? s.toolResultCount : 0
    const humanUsers = hasToolRole ? userCount : Math.max(0, userCount - toolResults)
    cur.maxToolResults = Math.max(cur.maxToolResults, toolResults)
    cur.maxHumanUsers = Math.max(cur.maxHumanUsers, humanUsers)
    const rc = Array.isArray(s.reasoningChars) ? s.reasoningChars : []
    const reasoningAt = new Map(rc.map(([i, c]) => [i, c]))
    const assistantIdx = []
    roles.forEach((r, i) => { if (r === 'assistant') assistantIdx.push(i) })
    const lastIdx = roles.length - 1
    const historyAsst = assistantIdx.filter((i) => i < lastIdx)
    if (historyAsst.some((i) => (reasoningAt.get(i) || 0) > 0)) n1.withHistoryReasoning++
    if (assistantIdx.length) n1.reasoningAssistantRatio.push(assistantIdx.filter((i) => (reasoningAt.get(i) || 0) > 0).length / assistantIdx.length)
    if (humanUsers >= 2 && assistantIdx.length >= 2) {
      n1.eligible++
      if ((reasoningAt.get(assistantIdx[0]) || 0) > 0) n1.firstAssistantHasReasoning++
    }
    // N2 近似：同一会话里 (下标, 长度) 相同视为同一块
    for (const [i, c] of rc) if (roles[i] === 'assistant' && c > 0) approx.set(cur.id + ':' + i + ':' + c, c)
  }
  return { n1, approxRaw: [...approx.values()], sessions }
}

export function verdicts(g, a) {
  const v = {}
  // N1
  const n1 = a.n1
  const share = n1.eligible ? n1.firstAssistantHasReasoning / n1.eligible : null
  v.n1 = n1.eligible === 0 ? '样本不足（还没有 ≥2 个人类回合的请求）'
    : share >= 0.8 ? '是 ⇒ 全路线成立'
      : share <= 0.2 ? '否 ⇒ 历史 reasoning 在新 user 轮被丢弃：收益只在同一回合的工具循环内，门槛再抬一档，阶段 1 必须回答「是否值得上线」'
        : '混合（' + Math.round(share * 100) + '%）⇒ 可能有多个模型/版本交错，按 N5 分开看'
  // N2
  const raw = g.rawExact.length ? g.rawExact : a.approxRaw
  v.n2Source = g.rawExact.length ? '精确（每块一次：birth-below-floor/passthrough/condensed）' : (raw.length ? '近似（llm-stream.reasoningChars 去重估算；阶段 0b 后会变成精确值）' : '无数据')
  v.n2 = raw.length ? {
    blocks: raw.length, p50: q(raw, 0.5), p75: q(raw, 0.75), p90: q(raw, 0.9), p95: q(raw, 0.95), max: q(raw, 1),
    shareGe: Object.fromEntries([3100, 6680, 10280, 13320].map((t) => [t, pct(raw.filter((x) => x >= t).length, raw.length)])),
  } : null
  if (v.n2) {
    const s = v.n2.shareGe[10280]
    v.n2Verdict = s == null ? '—' : s < 5 ? `≥10,280 字符（≈4000 token@2.57）的块只占 ${s}% ⇒ 大块路线覆盖很小，能否扩面完全取决于副模型单价（阶段 1 G3）`
      : `≥10,280 字符的块占 ${s}% ⇒ 大块起步有可观覆盖`
  }
  // N3 / N4
  const win = g.probes.map((p) => p.otherStartToLastEndMs).filter((x) => Number.isFinite(x))
  const tail = g.probes.map((p) => p.lastEndToFinishMs).filter((x) => Number.isFinite(x))
  const types = Object.create(null)
  for (const p of g.probes) { const k = p.firstOtherType == null ? '(无其它块)' : p.firstOtherType; types[k] = (types[k] || 0) + 1 }
  v.n3 = g.probes.length ? { streams: g.probes.length, withOther: win.length, p50: q(win, 0.5), p90: q(win, 0.9), types } : null
  v.n3Verdict = !g.probes.length ? '无数据（需要阶段 0b：dryRun:false + 不可达门槛）'
    : !win.length ? 'reasoning 之后从未出现其它块 ⇒ 无免费窗口可用'
      : q(win, 0.5) > 1000 ? `p50=${q(win, 0.5)}ms > 1000 ⇒ 阶段 3 实现「第一个非 reasoning 块起火」（带 h.text===raw 硬校验）`
        : q(win, 0.5) <= 300 ? `p50=${q(win, 0.5)}ms ≤ 300 ⇒ 不做免费窗口起火` : `p50=${q(win, 0.5)}ms 在 300~1000 之间 ⇒ 待定，多收数据`
  v.n4 = tail.length ? { p50: q(tail, 0.5), p90: q(tail, 0.9) } : null
  // N5
  v.n5 = { hostModels: g.hostModels, streamModels: g.streamModels }
  const models = Object.keys(g.streamModels)
  v.n5Verdict = models.length === 0 ? '无数据' : models.length === 1 ? `单一模型 ${models[0]}` : `多个模型交错（${models.join(', ')}）⇒ N1/N2 须按模型分开解读`
  // N6
  const ss = a.sessions.filter((s) => s.requests >= 2)
  v.n6 = ss.length ? {
    sessions: ss.length,
    requestsPerSession: { p50: q(ss.map((s) => s.requests), 0.5), p90: q(ss.map((s) => s.requests), 0.9) },
    toolResultsPerSession: { p50: q(ss.map((s) => s.maxToolResults), 0.5), p90: q(ss.map((s) => s.maxToolResults), 0.9) },
    toolResultsPerHumanTurn: { p50: q(ss.map((s) => s.maxToolResults / Math.max(1, s.maxHumanUsers)), 0.5) },
  } : null
  return v
}

export function render(groups) {
  const out = []
  groups.forEach((g, gi) => {
    const a = analyzeStreams(g.streams)
    const v = verdicts(g, a)
    const b = g.boot || {}
    const phase = b.dryRun === true ? '阶段 0a（dryRun:true，只有 llm-stream 可见）' : (g.rawExactWhy.condensed ? '⚠ 非观测态：已在压缩' : '阶段 0b（包装态：below-floor 与 window-probe 可见）')
    out.push('═'.repeat(100))
    out.push(`组 #${gi + 1}  BOOT ${g.bootAt} → ${g.lastAt}   selfId=${b.selfId || '?'}  mode=${b.mode || '?'}  dryRun=${b.dryRun}  compiler=${b.compilerMode || '?'}`)
    out.push(`      ${phase}；记录 ${g.lines} 行；llm-stream ${g.streams.length} 次；dry-run 流 ${g.dryRunStreams} 次`)
    out.push('')
    out.push(`N1  历史 reasoning 跨 user 轮保留？   ${v.n1}`)
    out.push(`      请求 ${a.n1.requests}；含历史 reasoning 的请求 ${a.n1.withHistoryReasoning}；可判定（≥2 人类回合）${a.n1.eligible}，其中首条 assistant 带 reasoning ${a.n1.firstAssistantHasReasoning}；带 reasoning 的 assistant 占比中位 ${q(a.n1.reasoningAssistantRatio, 0.5) == null ? '—' : Math.round(q(a.n1.reasoningAssistantRatio, 0.5) * 100) + '%'}`)
    out.push('')
    out.push(`N2  reasoning 块长度分布   来源：${v.n2Source}`)
    if (v.n2) {
      out.push(`      块数 ${v.n2.blocks}；p50 ${v.n2.p50}  p75 ${v.n2.p75}  p90 ${v.n2.p90}  p95 ${v.n2.p95}  max ${v.n2.max} 字符`)
      out.push(`      ≥3,100 字符 ${v.n2.shareGe[3100]}%  ·  ≥6,680（4000token@1.67）${v.n2.shareGe[6680]}%  ·  ≥10,280（@2.57）${v.n2.shareGe[10280]}%  ·  ≥13,320（@3.33）${v.n2.shareGe[13320]}%`)
      if (Object.keys(g.rawExactWhy).length) out.push(`      放行原因：${JSON.stringify(g.rawExactWhy)}`)
      out.push(`      判定：${v.n2Verdict}`)
    } else out.push('      无数据')
    out.push('')
    out.push(`N3  免费窗口 otherStartToLastEndMs（正值 = reasoning 的 block-end 比其它块的 block-start 晚到 = 可提前起火的时间；≤0 = 无窗口）   ${v.n3Verdict}`)
    if (v.n3) out.push(`      流 ${v.n3.streams}；有其它块 ${v.n3.withOther}；p50 ${fmtMs(v.n3.p50)}  p90 ${fmtMs(v.n3.p90)}；其它块类型 ${JSON.stringify(v.n3.types)}`)
    out.push(`N4  最后一个 reasoning 结束 → finish（finish 处本来就有的免费等待）   ${v.n4 ? `p50 ${fmtMs(v.n4.p50)}  p90 ${fmtMs(v.n4.p90)}` : '无数据'}`)
    out.push('')
    out.push(`N5  宿主模型   ${v.n5Verdict}`)
    out.push(`      host-model: ${JSON.stringify(g.hostModels)}   llm-stream.model: ${JSON.stringify(g.streamModels)}`)
    out.push('')
    out.push(`N6  基线（粗粒度）   ${v.n6 ? `会话 ${v.n6.sessions}；每会话请求 p50 ${v.n6.requestsPerSession.p50} / p90 ${v.n6.requestsPerSession.p90}；每会话工具结果 p50 ${v.n6.toolResultsPerSession.p50} / p90 ${v.n6.toolResultsPerSession.p90}；每人类回合工具结果 p50 ${v.n6.toolResultsPerHumanTurn.p50}` : '样本不足'}`)
    out.push('      （重复调用 / 同签名错误重复 这两个细指标由阶段 1 cf-eval 的 loop / recheck 给出）')
    out.push('')
    const h = Object.keys(g.health).length ? JSON.stringify(g.health) : '全绿（无 start-error / settle-error / flush / stream-error）'
    out.push(`健康  ${h}`)
  })
  out.push('═'.repeat(100))
  return out.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const files = args.filter((a) => !a.startsWith('--'))
  if (!files.length) { console.error('用法: node tools/phase0-report.mjs <trace.log> [trace.log.1 ...] [--json]'); process.exit(2) }
  for (const f of files) if (!fs.existsSync(f)) { console.error('找不到文件: ' + f); process.exit(2) }
  const groups = await readTraces(files)
  if (!groups.length) { console.error('没有解析到任何 trace 记录（文件为空，或格式不是 [时间] [事件] {JSON}）'); process.exit(1) }
  if (json) { console.log(JSON.stringify(groups.map((g) => { const a = analyzeStreams(g.streams); return { boot: g.boot, bootAt: g.bootAt, lastAt: g.lastAt, ...verdicts(g, a), n1raw: a.n1, health: g.health } }), null, 2)) }
  else console.log(render(groups))
}
