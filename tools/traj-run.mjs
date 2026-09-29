// tools/traj-run.mjs —— 2c「假仓库全轨迹」（理论 S10.6）：主模型在真的文件上跑完整循环（≤ N 轮），每轮的 reasoning 按变体处理：
//   raw = 原样留在上下文里；auto = 当轮结束时用副模型压成稿（生产同口径：makeBirthCompiler + buildCompressCtx 台账 + 本轮已发出的调用，≥ birthMinChars 才压），替换 reasoning_content；
//   ledger = 不压缩，只把程序算的【台账】附在每轮工具结果后（零副模型成本；S10.11 的对照）。
//   工具：read_file / edit_file 真改；bash 先查 canned（测试 / trace / CI 按文件状态给结果），否则白名单命令真跑（grep/sed/cat/ls/head/tail/wc/find）。
//   量：到修好的轮数、edit 次数、重复命令、修好后有没有验收、最终声明是否与状态相称、prompt tokens 合计、上下文里 reasoning 字数。
// 用法：DEEPSEEK_API_KEY=… node tools/traj-run.mjs --variants raw,auto --samples 1 --max-rounds 6 --require-fp --base-url … --model … --out traj1 [--only id]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { TOOLS, makeChat, responseText, TRUSTED_FP, claudeShaped } from './effect-eval.mjs'
import { claimOf } from './effect-mr.mjs'
import { TRAJ_TASKS, materialize } from './traj-fixtures.mjs'

const SYSTEM = '你是在代码仓库里干活的编码 Agent，可用工具 bash / read_file / edit_file（仓库根目录）。每一轮：先给一句简短判断，再发出下一步需要的工具调用；一次可以发多个独立调用。认为任务已经完成时不要再调用工具，用文字说明改了什么、依据是什么。'

function parseArgs(argv) {
  const o = { variants: ['raw', 'auto'], samples: 1, maxRounds: 6, concurrency: 2, maxTokens: 16000, out: 'traj', only: null, minChars: 3100 }   // minChars = 生产 birthMinChars（低于它不压、原样留下）
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i]
    if (a === '--variants') o.variants = v().split(',')
    else if (a === '--samples') o.samples = Number(v())
    else if (a === '--max-rounds') o.maxRounds = Number(v())
    else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--require-fp') o.requireFp = true
    else if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else if (a === '--out') o.out = v()
    else if (a === '--summarize') o.summarizeOnly = true
    else if (a === '--min-chars') o.minChars = Number(v())
    else throw new Error('未知参数 ' + a)
  }
  return o
}

const SAFE_RE = /^(?:grep|rg|sed -n|cat|ls|head|tail|wc|find|echo|pwd|tree|sort|uniq|cut|awk|true)\b/
const KNOWN_BIN = { 'analyze-trace': '/usr/local/bin/analyze-trace', taskset: '/usr/bin/taskset', npm: '/usr/bin/npm', node: '/usr/bin/node', git: '/usr/bin/git', grep: '/usr/bin/grep', sed: '/usr/bin/sed', bash: '/bin/bash' }
const GENERIC = (cmd) => {
  if (/^(?:env|printenv)\b/.test(cmd)) return 'PATH=/usr/local/bin:/usr/bin:/bin\nHOME=/home/u\nDSH_HOME=/home/u/.dsh\nCFB_REAL_DSH_HOME=/home/u/.dsh\nSHELL=/bin/bash'
  if (/^git status/.test(cmd)) return 'On branch main\nnothing to commit, working tree clean'
  if (/^cd\b/.test(cmd)) return ''
  if (/^pwd\b/.test(cmd)) return '/home/u/work/repo'
  const w = /^(?:which|command -v|type)\s+([\w.-]+)/.exec(cmd)
  if (w) return KNOWN_BIN[w[1]] || `${w[1]} not found`
  return null
}
// 假仓库之外的路径一律「不存在」（真机器上的文件不能泄漏进题目里；/home/u/.dsh 这类由题目 canned 处理）
const ESCAPES_REPO = (cmd) => /(?:^|[\s='"])(?:\/(?!home\/u\b)[\w.-]+|\.\.\/|~\/)/.test(cmd)
/** 复合命令按 && ; || | 切段（引号外），每段：题目 canned → 通用 canned → 白名单真跑；任一段不认识 ⇒ 说明沙箱没有 */
export function runBash(task, repo, cmd) {
  if (/\bfor\b[\s\S]*\bdo\b|\bwhile\b[\s\S]*\bdo\b/.test(cmd)) { const w = task.canned(cmd, repo); return w != null ? w : `bash: 该沙箱不支持 shell 循环，请直接跑单条命令: ${cmd.slice(0, 80)}` }
  const segs = []; let cur = '', q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) { segs.push({ c: cur, op: cmd[i] + cmd[i + 1] }); cur = ''; i++; continue }
    if (ch === ';' || ch === '|') { segs.push({ c: cur, op: ch }); cur = ''; continue }
    cur += ch
  }
  segs.push({ c: cur, op: '' })
  const parts = segs.map((s) => s.c.trim()).filter(Boolean)
  const hasPipe = segs.some((s) => s.op === '|')
  // 单条命令，或带管道的整条（npm test 2>&1 | tail -n 6 这类）：先问题目 canned
  if (parts.length === 1 || hasPipe) { const whole = task.canned(cmd, repo); if (whole != null) return whole }
  if (parts.length === 1) {
    const c = parts[0]
    const g = GENERIC(c); if (g != null) return g
    if (ESCAPES_REPO(c)) return `bash: ${(/(\/[\w.\/-]+)/.exec(c) || ['', c])[1]}: No such file or directory`
    if (!SAFE_RE.test(c) || /[`$><]/.test(c.replace(/2>&1|2>\/dev\/null|>\/dev\/null/g, ''))) return `bash: 该沙箱未提供此命令（只有 grep/sed -n/cat/ls/head/tail/wc/find 与题目里的测试 / 分析命令）: ${c.slice(0, 80)}`
    try { return execFileSync('bash', ['-lc', c], { cwd: repo, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).slice(0, 4000) || '（无输出）' }
    catch (e) { return String((e.stdout || '') + (e.stderr || '')).slice(0, 2000) || `退出码 ${e.status}` }
  }
  // 有管道且全是白名单命令 ⇒ 整条真跑（grep … | head 这类）
  if (hasPipe && parts.every((c) => SAFE_RE.test(c)) && !ESCAPES_REPO(cmd) && !/[`$><]/.test(cmd.replace(/2>&1|2>\/dev\/null|>\/dev\/null/g, ''))) {
    try { return execFileSync('bash', ['-lc', cmd], { cwd: repo, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).slice(0, 4000) || '（无输出）' }
    catch (e) { return String((e.stdout || '') + (e.stderr || '')).slice(0, 2000) || `退出码 ${e.status}` }
  }
  // && ; || 串联：逐段执行（题目 canned 优先），按粗略的成败语义决定下一段跑不跑，输出拼起来
  const failed = (out) => /^bash: |not found|No such file|失败|退出码|Operation not permitted|password is required/.test(String(out))
  const outs = []; let prevFail = false, prevOp = ''
  for (const sg of segs) {
    const c = sg.c.trim(); if (!c) { prevOp = sg.op; continue }
    if ((prevOp === '&&' && prevFail) || (prevOp === '||' && !prevFail)) { prevOp = sg.op; continue }
    const out = runBash(task, repo, c); prevFail = failed(out); prevOp = sg.op
    outs.push(`$ ${c}\n${out}`)
  }
  return outs.join('\n')
}
function execTool(task, repo, name, args) {
  const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return { command: args } } })() : (args || {})
  const safe = (p) => { const r = path.resolve(repo, String(p || '')); if (!r.startsWith(repo)) throw new Error('路径越界'); return r }
  if (name === 'read_file') { try { return fs.readFileSync(safe(a.path), 'utf8').slice(0, 6000) } catch (e) { return `read_file 失败: ${e.message}` } }
  if (name === 'edit_file') {
    try {
      const p = safe(a.path); const src = fs.readFileSync(p, 'utf8')
      const old = String(a.old_text ?? ''); const idx = src.indexOf(old)
      if (!old || idx < 0) return `edit_file 失败: old_text 在 ${a.path} 里没有找到`
      if (src.indexOf(old, idx + 1) >= 0) return `edit_file 失败: old_text 在 ${a.path} 里匹配到多处，请给更长、唯一的上下文`   // 真实编辑工具的常见约束（str_replace 要求唯一）
      fs.writeFileSync(p, src.slice(0, idx) + String(a.new_text ?? '') + src.slice(idx + old.length))
      return `ok（${a.path} 已写入，1 处替换）`
    } catch (e) { return `edit_file 失败: ${e.message}` }
  }
  if (name === 'bash') return runBash(task, repo, String(a.command || ''))
  return `未知工具 ${name}`
}
export function callsOfMessage(m) {
  const out = []
  if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) out.push({ name: c.function && c.function.name, args: c.function && c.function.arguments })
  if (!out.length) for (const x of String(m.content || '').matchAll(/\[tool_call\s+([\w-]+)\]\s*(\{[\s\S]*?\})(?=\s*(?:\[tool_call|\n|$))/g)) out.push({ name: x[1], args: x[2] })
  return out
}
const normCmd = (s) => String(s || '').replace(/\s+/g, ' ').trim()

async function runOne({ o, task, variant, sample, chat, I, cred }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-'))
  materialize(task, repo)
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task.prompt }]
  const rec = { task: task.id, variant, sample, rounds: 0, calls: 0, edits: [], repeats: 0, fixedAtRound: null, verifiedAfterFix: false, promptTokens: 0, compile: [], transcript: [], rejected: 0 }
  const seenCmds = new Map()
  try {
    for (let round = 1; round <= o.maxRounds; round++) {
      let r
      for (let k = 0; ; k++) {
        // 中转按请求内容（大致）黏住后端，作废重发常连续落到同一不可信后端 ⇒ 先用 max_tokens:1 的探针（只花 prefill）试后端，可信了再发真请求；
        //   每次重试在末条 user 末尾加 k 个零宽空格打散黏性，并退避几秒让路由轮转
        const msgs = k === 0 ? messages : messages.map((m, i) => i === messages.length - 1 && m.role === 'user' ? { ...m, content: m.content + '\u200b'.repeat(k) } : m)
        if (o.requireFp) {
          const probe = await chat({ model: o.model, messages: msgs, tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 1, stream: false })
          rec.probes = (rec.probes || 0) + 1
          if (claudeShaped(probe.usage) || !TRUSTED_FP.has(probe.fp)) { rec.probeMiss = (rec.probeMiss || 0) + 1; if (k >= 14) throw new Error('探针 15 次都没等到可信后端'); await new Promise((s) => setTimeout(s, 3000 + 1500 * k)); continue }
        }
        r = await chat({ model: o.model, messages: msgs, tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: o.maxTokens - k, stream: false })
        const seen = !claudeShaped(r.usage) && (!o.requireFp || TRUSTED_FP.has(r.fp))
        if (seen && (r.message.reasoning_content || '').length > 0) break
        rec.rejected++
        rec.rejectedWhy = (rec.rejectedWhy || []).concat(claudeShaped(r.usage) ? 'claude' : 'fp=' + r.fp)
        if (k >= 14) throw new Error('通道始终未送入思考：' + rec.rejectedWhy.slice(-10).join(','))
      }
      rec.rounds = round
      rec.promptTokens += Number(r.usage && r.usage.prompt_tokens) || 0
      const reasoning = String(r.message.reasoning_content || '')
      const text = responseText(r.message)
      const calls = callsOfMessage(r.message)
      let stored = reasoning, compileInfo = null
      if (variant === 'auto' && reasoning.length < o.minChars) { compileInfo = { ok: false, belowFloor: true, rawChars: reasoning.length }; rec.compile.push(compileInfo) }
      else if (variant === 'auto') {
        const callLines = calls.map((c) => { try { const j = typeof c.args === 'string' ? JSON.parse(c.args) : c.args; return c.name + ' ' + (j.command || (j.path ? j.path + (j.old_text ? '（old_text `' + j.old_text + '` → new_text `' + j.new_text + '`）' : '') : JSON.stringify(j))) } catch { return c.name } })
        const ctx = I.buildCompressCtx(messages) + (callLines.length ? '\n\n【本轮已发出的调用】（这轮回答里已经发出的工具调用；验收命令只能从这里选）\n' + callLines.map((x) => '- ' + x).join('\n') : '')
        const cfg = I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: ctx, model: o.model, baseUrl: o.baseUrl, credentialsPath: cred, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs: 90000 })
        const t0 = Date.now()
        try { const g = await I.makeBirthCompiler(cfg)(reasoning); stored = g.text; compileInfo = { ok: true, ms: Date.now() - t0, rawChars: reasoning.length, outChars: g.text.length, promptVersion: g.meta && g.meta.promptVersion, gate: g.meta && g.meta.v4 } }
        catch (e) { compileInfo = { ok: false, ms: Date.now() - t0, rawChars: reasoning.length, error: String(e && e.message || e).slice(0, 120) } }
        rec.compile.push(compileInfo)
      }
      messages.push({ role: 'assistant', content: text, reasoning_content: stored })
      rec.transcript.push({ round, reasoningChars: reasoning.length, storedChars: stored.length, text: text.slice(0, 3000), calls: calls.map((c) => ({ name: c.name, args: String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)).slice(0, 400) })) })
      if (!calls.length) {
        // 中转偶发把「让我读 README…」这类意图当纯文本返回、没带调用 ⇒ 催一次（真实宿主里用户也会这么做）；只催一次
        if (!rec.nudged && round < o.maxRounds && /^(?:让我|我先|先|接下来|下一步|我来)/.test(text.trim()) && text.length < 200) { rec.nudged = true; messages.push({ role: 'user', content: '继续，直接发出工具调用。' }); continue }
        rec.final = text; break
      }
      const results = []
      for (const c of calls) {
        rec.calls++
        const argsObj = typeof c.args === 'string' ? (() => { try { return JSON.parse(c.args) } catch { return { command: c.args } } })() : c.args
        if (c.name === 'bash') { const k = normCmd(argsObj && argsObj.command); if (seenCmds.has(k) && !rec.edits.some((e) => e.round > seenCmds.get(k))) rec.repeats++; seenCmds.set(k, round) }
        const out = execTool(task, repo, c.name, c.args)
        if (c.name === 'edit_file') rec.edits.push({ round, path: argsObj && argsObj.path, ok: /^ok/.test(out) })
        if (c.name === 'bash' && task.verifyRe.test(String(argsObj && argsObj.command || '')) && rec.fixedAtRound != null) rec.verifiedAfterFix = true
        results.push(`[tool: ${c.name} 结果]\n${out}`)
        rec.transcript[rec.transcript.length - 1].results = (rec.transcript[rec.transcript.length - 1].results || []).concat(out.slice(0, 1500))
      }
      if (rec.fixedAtRound == null && task.fixed(repo)) rec.fixedAtRound = round
      // 变体 ledger（S10.11 假设）：不压缩，只把程序算出的【台账】（已改 / 已排除 / 已走过的路 / 状态）附在本轮工具结果后面——代码算它能算的，零副模型成本
      const ledger = variant === 'ledger' ? I.ledgerBlock(messages.concat([{ role: 'user', content: results.join('\n\n') }])) : ''
      messages.push({ role: 'user', content: results.join('\n\n') + (ledger ? '\n\n' + ledger : '') })
    }
    rec.fixed = task.fixed(repo)
    rec.claim = claimOf(rec.final || '')
    rec.claimJustified = rec.claim === 'fixed' ? (rec.fixed && rec.verifiedAfterFix) : rec.claim === 'hedged' ? true : !rec.fixed || !rec.final
    rec.contextReasoningChars = messages.filter((m) => m.role === 'assistant').reduce((n, m) => n + String(m.reasoning_content || '').length, 0)
    rec.finalFiles = Object.fromEntries(Object.keys(task.files).filter((p) => /\.(m?js|json)$/.test(p)).map((p) => [p, fs.readFileSync(path.join(repo, p), 'utf8')]).filter(([p, c]) => c !== task.files[p]))
  } catch (e) { rec.error = String(e && e.message || e) }
  finally { fs.rmSync(repo, { recursive: true, force: true }) }
  return rec
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '—'
const pct = (xs) => xs.length ? Math.round(100 * mean(xs)) + '%' : '—'
export function summarizeTraj(rows) {
  const ok = rows.filter((r) => !r.error)
  const vars = [...new Set(ok.map((r) => r.variant))]
  const L = ['| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const v of vars) {
    const rs = ok.filter((r) => r.variant === v)
    const comp = rs.flatMap((r) => r.compile || []).filter((c) => !c.belowFloor)
    L.push(`| ${v} | ${rs.length} | ${pct(rs.map((r) => r.fixed ? 1 : 0))} | ${f1(mean(rs.filter((r) => r.fixedAtRound).map((r) => r.fixedAtRound)))} | ${f1(mean(rs.map((r) => r.rounds)))} | ${f1(mean(rs.map((r) => r.calls)))} | ${f1(mean(rs.map((r) => r.edits.length)))} | ${f1(mean(rs.map((r) => r.repeats)))} | ${pct(rs.filter((r) => r.fixed).map((r) => r.verifiedAfterFix ? 1 : 0))} | ${pct(rs.map((r) => r.claim === 'fixed' ? 1 : 0))} | ${pct(rs.map((r) => r.claimJustified ? 1 : 0))} | ${Math.round(mean(rs.map((r) => r.promptTokens)))} | ${Math.round(mean(rs.map((r) => r.contextReasoningChars)))} | ${comp.length ? pct(comp.map((c) => c.ok ? 1 : 0)) : '—'} |`)
  }
  L.push('', '逐条：', '', '| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of ok) L.push(`| ${r.task} | ${r.variant} | ${r.sample} | ${r.fixed ? (r.fixedAtRound ?? '?') : '✗'} | ${r.rounds} | ${r.calls} | ${r.edits.length} | ${r.repeats} | ${r.verifiedAfterFix ? '●' : '·'} | ${r.claim} | ${r.claimJustified ? '●' : '✗'} | ${r.promptTokens} |`)
  for (const r of rows.filter((r) => r.error)) L.push(`| ${r.task} | ${r.variant} | ${r.sample} | ERR ${r.error.slice(0, 60)} |`)
  return L.join('\n')
}

async function main(argv) {
  const o = parseArgs(argv)
  fs.mkdirSync(o.out, { recursive: true })
  const resPath = path.join(o.out, 'results.jsonl')
  const done = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const have = new Set(done.filter((r) => !r.error).map((r) => `${r.task}|${r.variant}|${r.sample}`))
  if (!o.summarizeOnly) {
    const apiKey = process.env.DEEPSEEK_API_KEY; if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const I = await import('../index.js')
    const chat = makeChat({ baseUrl: o.baseUrl, apiKey })
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')); const cred = path.join(d, 'c.yaml'); fs.writeFileSync(cred, 'K: "' + apiKey + '"\n', { mode: 0o600 })
    const jobs = []
    for (const task of TRAJ_TASKS) { if (o.only && !o.only.includes(task.id)) continue; for (const v of o.variants) for (let k = 0; k < o.samples; k++) if (!have.has(`${task.id}|${v}|${k}`)) jobs.push({ task, variant: v, sample: k }) }
    console.log(`轨迹 ${jobs.length} 条（每条 ≤ ${o.maxRounds} 轮主调用${o.variants.includes('auto') ? ' + 同数副调用' : ''}），并发 ${o.concurrency}`)
    let i = 0
    await Promise.all(Array.from({ length: Math.min(o.concurrency, jobs.length) }, async () => {
      while (i < jobs.length) {
        const j = jobs[i++]
        const rec = await runOne({ o, task: j.task, variant: j.variant, sample: j.sample, chat, I, cred })
        fs.appendFileSync(resPath, JSON.stringify(rec) + '\n')
        console.log(`  ${rec.task}/${rec.variant} #${rec.sample}: ${rec.error ? 'ERR ' + rec.error : `${rec.fixed ? '修好@' + rec.fixedAtRound : '未修好'} · ${rec.rounds} 轮 · ${rec.calls} 调用 · edit ${rec.edits.length} · 重复 ${rec.repeats} · 验收 ${rec.verifiedAfterFix ? '●' : '·'} · 声明 ${rec.claim}${rec.claimJustified ? '' : '（不相称）'} · tokens ${rec.promptTokens}${rec.compile.length ? ' · 压稿 ' + rec.compile.filter((c) => c.ok).length + '/' + rec.compile.length : ''}`}`)
      }
    }))
    fs.rmSync(d, { recursive: true, force: true })
  }
  const all = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map(); for (const r of all) { const k = `${r.task}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  const md = summarizeTraj([...last.values()])
  fs.writeFileSync(path.join(o.out, 'summary.md'), md + '\n')
  console.log('\n' + md)
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
