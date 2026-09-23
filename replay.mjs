#!/usr/bin/env node
// Compiler replay is NOT a main-agent replay. Product acceptance requires the
// latter and independently reviewed downstream decisions; this tool refuses to
// infer them from timeout counts, token counts, or a canned model response.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const save = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 })
export function parseTrace(text) {
  return text.split('\n').flatMap(line => {
    const m = /^\[([^\]]+)\] \[([^\]]+)\] (\{.*\})$/.exec(line)
    if (!m) return []
    try { return [{ at: m[1], tag: m[2], ...JSON.parse(m[3]) }] } catch { return [] }
  })
}
async function fullText(store, handle, sid) {
  let at = 1, text = [], bytes = 0
  for (let guard = 0; guard < 20000; guard++) {
    const r = await store.readRangeByHandle(handle, sid, at, 400)
    if (!r || !Array.isArray(r.lines)) throw Error('CAS read unavailable')
    const lines = r.lines.map(x => typeof x === 'string' ? x : x?.text)
    if (lines.some(x => typeof x !== 'string')) throw Error('unknown CAS line format')
    text.push(...lines); bytes += Buffer.byteLength(lines.join('\n'))
    if (bytes > 32 * 1024 * 1024) throw Error('capture body too large')
    if (r.atEof === true) return text.join('\n')
    if (!r.lines.length || !Number.isSafeInteger(r.nextLine) || r.nextLine <= at) throw Error('CAS read incomplete')
    at = r.nextLine
  }
  throw Error('CAS read did not reach EOF')
}
export async function captureTrace(traceText, store) {
  const rows = parseTrace(traceText), cases = [], errors = []
  const frames = rows.filter(r => r.tag === 'evidence-ledger-committed' && r.indexPath)
  const frameIds = new Set(frames.map(r => r.taskId)), archives = new Map(), missing = new Set()
  for (const r of rows) {
    if (r.tag === 'birth-archive-settled' && r.ok && r.handle && !archives.has(r.taskId)) archives.set(r.taskId, r)
    if (['compiler-input-prepared', 'evidence-ledger-unavailable'].includes(r.tag) && r.taskId && !frameIds.has(r.taskId)) missing.add(r.taskId)
  }
  for (const id of missing) errors.push({ id, reason: 'missing recorded evidence frame; transient input cannot be reconstructed from this trace' })
  for (const row of frames) {
    try {
      const archived = archives.get(row.taskId)
      if (!archived) throw Error('missing confirmed reasoning archive')
      const view = read(row.indexPath), raw = await fullText(store, archived.handle, view.sessionId)
      if (sha(raw) !== archived.rawSha256) throw Error('reasoning hash mismatch: no lossy newline repair')
      const observations = { tools: [], userAsks: [], runtimeFacts: [], unknownUserEvents: [], coverage: view.coverage, cut: view.cutSeq }
      for (const r of view.records) {
        const text = fs.readFileSync(r.bodyPath, 'utf8')
        if (sha(text) !== r.bodyHash) throw Error('source hash mismatch')
        if (r.kind === 'tool-observation') observations.tools.push({ id: r.toolCallId, seq: r.callSeq, resultSeq: r.resultSeq,
          name: r.name, args: r.args, status: r.status, exitCode: r.exitCode, isError: r.isError, resultTruncated: r.sourceTruncated, result: text })
        else if (r.kind === 'user-quote') observations.userAsks.push({ seq: r.seq, text })
        else if (r.kind === 'runtime') observations.runtimeFacts.push({ seq: r.seq, text })
        else if (r.kind === 'unconfirmed-source') observations.unknownUserEvents.push({ seq: r.seq, text })
      }
      cases.push({ id: row.taskId, sessionId: view.sessionId, branchId: view.branchId, raw, rawHandle: archived.handle, observations })
    } catch (e) { errors.push({ id: row.taskId, reason: e.message }) }
  }
  return { kind: 'compiler-capture', sourceSha256: sha(traceText), complete: frames.length > 0 && errors.length === 0,
    scope: 'eligible births with recorded evidence; not an entire conversation', cases, errors }
}
export function observationEvents(o) {
  const events = [], inFlightIds = new Set()
  for (const u of o.userAsks || []) events.push({ ...u, type: 'user/message', source: 'human' })
  for (const u of o.unknownUserEvents || []) events.push({ ...u, type: 'user/message', source: 'unknown-user-event' })
  for (const r of o.runtimeFacts || []) events.push({ ...r, type: 'system/message' })
  for (const t of o.tools || []) {
    events.push({ seq: t.seq, type: 'assistant/message', toolCalls: [{ id: t.id, name: t.name, args: t.args }] })
    if (t.result != null && ['completed', 'failed', 'cancelled'].includes(t.status)) events.push({ seq: t.resultSeq, type: 'tool/result', toolCallId: t.id, text: t.result,
      isError: t.isError, exitCode: t.exitCode, cancelled: t.status === 'cancelled', truncated: t.resultTruncated, sourceTruncated: t.sourceTruncated ?? t.resultTruncated })
    else if (t.status === 'running') inFlightIds.add(t.id)
  }
  return { events, inFlightIds, cutSeq: o.cut ?? o.cutSeq, coverage: o.coverage }
}
export async function replayCompiler(capture, cfg, moduleDir, home, candidate = true) {
  if (!capture.complete || !capture.cases?.length) throw Error('incomplete capture')
  if (fs.existsSync(home) && fs.readdirSync(home).length) throw Error('replay home must be empty')
  fs.mkdirSync(home, { recursive: true })
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home
  try {
    const I = await import(pathToFileURL(path.join(moduleDir, 'index.js')))
    const M = await import(pathToFileURL(path.join(moduleDir, 'state-memory.js')))
    const L = candidate ? await import(pathToFileURL(path.join(moduleDir, 'evidence-ledger.js'))) : null
    cfg = { ...I.DEFAULTS, ...cfg, dryRun: false, mode: 'birth', stateMemory: true,
      birthFinishWaitMs: 1500, timeoutMs: 8000, maxOutputTokens: 1200, prewarm: false, distillStream: true, birthDeferredClaim: true,
      birthMinChars: 1 } // Replay recorded captures regardless of the production floor (v11.6 raised it to 3100).
    const sharingPath = path.join(moduleDir, 'exact-flights.js')
    const flights = fs.existsSync(sharingPath) ? (await import(pathToFileURL(sharingPath))).createExactFlights() : null
    const compiles = []
    for (const item of capture.cases) {
      const o = item.observations, traces = []
      const deps = { cfg, sessionId: item.sessionId, branchId: item.branchId,
        archive: async () => item.rawHandle, // Confirmed, owner-checked during capture, never fabricated.
        collectEvidence: () => observationEvents(o),
        buildEnvelope: M.buildEvidenceEnvelope,
        prepareEvidence: L ? input => {
          if (L.prepareCompilerEvidence) return L.prepareCompilerEvidence(input, cfg.stateSnapshot)
          // Compatibility for replaying pre-v8 candidates.
          if (cfg.stateSnapshot === false && L.transientEvidenceFrame) return L.transientEvidenceFrame(input, 'stateSnapshot-disabled')
          try { return L.prepareEvidenceLedger(input).frame }
          catch (e) { if (L.transientEvidenceFrame) return L.transientEvidenceFrame(input, e.message || e); throw e }
        } : undefined,
        distill: (env, signal, runtime) => I.generateStateMemory(env, cfg, signal, { ...runtime, flights }),
        trace: (tag, data) => traces.push({ tag, ...data }),
      }
      const task = I.birthStart({ index: 0, text: item.raw }, deps)
      const started = performance.now(), foreground = await I.birthFinish(task, deps)
      const finishWaitMs = performance.now() - started
      await Promise.all([task.diskP, task.distillP])
      const result = task.distillState, error = result?.error || ''
      compiles.push({ id: item.id, status: result?.ok ? 'ok' : /timeout 8000ms/.test(error) ? 'timeout' : /empty distillate/.test(error) ? 'empty' : 'error',
        error, appliedAtFinish: foreground.why === 'condensed', foreground: foreground.why, finishWaitMs,
        output: result?.text || null, meta: result?.meta || null, traces })
    }
    return { kind: 'compiler-only-replay', productAccepted: false, sourceSha256: capture.sourceSha256,
      complete: true, candidate, configFingerprint: sha(JSON.stringify(cfg)), compiles,
      limitation: 'No main agent, no real source-time scheduling, no repeated-exploration or wrong-route labels. Not product acceptance.' }
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
}
export function evaluateProduct(baseline, candidate, audit) {
  const reasons = []
  const need = (ok, why) => { if (!ok) reasons.push(why) }
  for (const [label, run] of [['baseline', baseline], ['candidate', candidate]]) {
    need(run?.kind === 'full-session-replay' && run.complete === true && run.realModel === true, label + ': 缺完整真实主模型重放')
    need(Array.isArray(run?.compiles) && run.compiles.length > 0 && run.compiles.every(c => ['ok', 'timeout', 'empty', 'error'].includes(c.status)), label + ': 编译终局不完整')
    need(Array.isArray(run?.rounds) && run.rounds.length > 0 && run.rounds.every(r => r.id && r.goalId && typeof r.redundant === 'boolean'), label + ': 缺同目标探索逐轮标注')
    need(run?.compiles?.some(c => c.status === 'ok' && c.applied === true), label + ': 无实际应用，不能用零调用／零替换通过验收')
    need(run?.outcomes && Object.keys(run.outcomes).length > 0 && Object.values(run.outcomes).every(v => ['passed', 'failed', 'incomplete'].includes(v)), label + ': 缺任务结局或未知结局')
    need(Array.isArray(run?.compiles) && run.compiles.every(c => typeof c.id === 'string' && c.id) && new Set(run.compiles.map(c => c.id)).size === run.compiles.length, label + ': 编译身份缺失或重复')
    need(Array.isArray(run?.rounds) && new Set(run.rounds.map(r => r.id)).size === run.rounds.length && run.rounds.every(r => Object.hasOwn(run.outcomes || {}, r.goalId)), label + ': 探索身份重复或目标不在任务集合')
  }
  need(/^[a-f0-9]{64}$/.test(baseline?.sourceSha256 || '') && baseline.sourceSha256 === candidate?.sourceSha256, '重放源未配对')
  need(!!baseline?.profileFingerprint && baseline.profileFingerprint === candidate?.profileFingerprint, '模型／profile／预算不一致或未记录')
  need(audit?.complete === true && !!audit.reviewer && audit.baselineHash === sha(JSON.stringify(baseline)) && audit.candidateHash === sha(JSON.stringify(candidate)), '缺绑定具体运行产物的独立审核')
  for (const [key, run] of [['baseline', baseline], ['candidate', candidate]]) {
    const reviewed = audit?.[key]
    const successIds = (run?.compiles || []).filter(c => c.status === 'ok').map(c => c.id)
    need(successIds.length > 0 && successIds.every(id => id && reviewed?.reviewedCompileIds?.includes(id)), key + ': 成功编译未全部审查')
    need((run?.rounds || []).every(r => reviewed?.reviewedRoundIds?.includes(r.id)), key + ': 探索轮标注未全部审查')
    need(Array.isArray(reviewed?.wrongStateCases), key + ': 缺错误状态因果审核')
  }
  if (reasons.length) return { status: '未验收', reasons }
  const count = run => ({ timeoutPlusEmpty: run.compiles.filter(c => ['timeout', 'empty'].includes(c.status)).length,
    allFailures: run.compiles.filter(c => c.status !== 'ok').length,
    redundantExplorationRounds: run.rounds.filter(r => r.redundant).length })
  const b = count(baseline), c = count(candidate)
  const sameTasks = JSON.stringify(Object.keys(baseline.outcomes).sort()) === JSON.stringify(Object.keys(candidate.outcomes).sort())
  const checks = { timeoutPlusEmptyDown: c.timeoutPlusEmpty < b.timeoutPlusEmpty,
    repeatedExplorationDown: c.redundantExplorationRounds < b.redundantExplorationRounds,
    wrongStateRoutesZero: audit.candidate.wrongStateCases.length === 0,
    allFailuresNotUp: c.allFailures <= b.allFailures,
    sameTasksAndNoOutcomeRegression: sameTasks && Object.keys(baseline.outcomes).every(k => ({ passed: 2, failed: 1, incomplete: 0 })[candidate.outcomes[k]] >= ({ passed: 2, failed: 1, incomplete: 0 })[baseline.outcomes[k]]) }
  return { status: Object.values(checks).every(Boolean) ? '通过' : '未通过', baseline: b, candidate: c, checks,
    limitation: '以提交的宿主记录与独立审核为依据；不能自动认证来源真实性，也不等于统计显著或费用下降。' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    if (cmd === 'storage-audit' || cmd === 'storage-gc') {
      const { auditEvidenceStorage, collectEvidenceGarbage } = await import('./evidence-storage.js')
      const [root, output] = args
      const result = cmd === 'storage-gc' ? collectEvidenceGarbage(root) : auditEvidenceStorage(root)
      if (output) save(output, result); else console.log(JSON.stringify(result, null, 2))
    } else if (cmd === 'inspect') {
      const { readEvidenceHistory } = await import('./evidence-ledger.js')
      const [view, output] = args
      const records = readEvidenceHistory(view)
      if (output) save(output, records); else console.log(JSON.stringify(records, null, 2))
    } else if (cmd === 'capture') {
      const [trace, adapter, output] = args
      const mod = await import(pathToFileURL(path.resolve(adapter)))
      const store = typeof mod.default === 'function' ? await mod.default() : mod.default
      const result = await captureTrace(fs.readFileSync(trace, 'utf8'), store)
      save(output, result); if (!result.complete) process.exitCode = 2
    } else if (cmd === 'run') {
      const [input, config, moduleDir, home, output, mode] = args
      save(output, await replayCompiler(read(input), read(config), path.resolve(moduleDir), path.resolve(home), mode !== 'baseline'))
    } else if (cmd === 'evaluate') {
      const [b, c, a, output] = args
      const result = evaluateProduct(b ? read(b) : null, c ? read(c) : null, a ? read(a) : null)
      if (output) save(output, result); else console.log(JSON.stringify(result, null, 2))
      if (result.status !== '通过') process.exitCode = result.status === '未验收' ? 2 : 1
    } else throw Error('Usage: replay.mjs inspect VIEW [OUT] | capture TRACE STORE_ADAPTER OUT | run CAPTURE CONFIG MODULE_DIR EMPTY_HOME OUT [baseline] | evaluate [BASELINE CANDIDATE AUDIT OUT]')
  } catch (e) { console.error(e.message); process.exitCode = 2 }
}
