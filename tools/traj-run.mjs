// tools/traj-run.mjs —— 2c「假仓库全轨迹」（理论 S10.6）：主模型在真的文件上跑完整循环（≤ N 轮），每轮的 reasoning 按变体处理：
//   raw = 原样留在上下文里；auto = 当轮结束时用副模型压成稿（生产同口径：makeBirthCompiler + buildCompressCtx 台账 + 本轮已发出的调用，≥ birthMinChars 才压），替换 reasoning_content；
//   ledger = 不压缩，只把程序算的【台账】附在每轮工具结果后（零副模型成本；S10.11 的对照）。
//   工具：read_file / edit_file 真改；bash 先查 canned（测试 / trace / CI 按文件状态给结果），否则白名单命令真跑（grep/sed/cat/ls/head/tail/wc/find）。
//   量：到修好的轮数、edit 次数、重复命令、修好后有没有验收、最终声明是否与状态相称、prompt tokens 合计、上下文里 reasoning 字数。
// 用法：DEEPSEEK_API_KEY=… node tools/traj-run.mjs --variants raw,auto --samples 1 --max-rounds 6 --require-fp --base-url … --model … --out traj1 [--only id]
// v4.1：--policy base,p-xxxx ⇒ 变体 policy:<id>（压缩器 = 生产 v4 提示词 + 策略补丁，两臂同一路径，可比）；--fork ⇒ 同题同样本只跑一次第 1 轮，
//   各臂从同一第 1 轮状态分叉（配对在分叉点、省 1 次主调用）；每行记逐轮执行器代理旗标 proxySteps / proxyScore（traj-proxy.mjs），
//   直接喂 cfb-cycle confirm --results（L2 结局 + 效度账本一次到位）。本文件不读任何计划文件；花钱仍只在显式带 KEY 运行时发生。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { TOOLS, makeChat, responseText, TRUSTED_FP, claudeShaped } from './effect-eval.mjs'
import { claimOf } from './effect-mr.mjs'
import { TRAJ_TASKS, materialize } from './traj-fixtures.mjs'
import { stepFlags } from './helpers/traj-proxy.mjs'
import { outcomeComparison } from './helpers/ruler.mjs'
import { BASE_POLICY, applyPolicyToPrompt } from './helpers/generation.mjs'

const SYSTEM = '你是在代码仓库里干活的编码 Agent，可用工具 bash / read_file / edit_file（仓库根目录）。每一轮：先给一句简短判断，再发出下一步需要的工具调用；一次可以发多个独立调用。认为任务已经完成时不要再调用工具，用文字说明改了什么、依据是什么。'
// --text-tools：不带 tools 字段（中转把带 tools 的请求路由到不可信后端时用），改用文本协议发调用；三种变体同一协议，比较仍成立
const SYSTEM_TEXT_TOOLS = SYSTEM + '\n\n工具用文本协议调用：每条调用单独一行，格式为 [tool_call bash] {"command":"…"} / [tool_call read_file] {"path":"…"} / [tool_call edit_file] {"path":"…","old_text":"…","new_text":"…"}（JSON 一行、字符串内换行写成 \\n）。调用行之外的文字就是你的判断。结果会以「[tool: 名字 结果]」回给你。'

function parseArgs(argv) {
  const o = { variants: ['raw', 'auto'], samples: 1, maxRounds: 6, concurrency: 2, maxTokens: 16000, out: 'traj', only: null, minChars: 3100, maxProbes: 15 }   // minChars = 生产 birthMinChars（低于它不压、原样留下）
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
    else if (a === '--text-tools') o.textTools = true
    else if (a === '--max-probes') o.maxProbes = Number(v())
    else if (a === '--policy') { for (const id of v().split(',')) o.variants.push('policy:' + id) }
    else if (a === '--policy-dir') o.policyDir = v()
    else if (a === '--fork') o.fork = true
    else if (a === '--plan') o.plan = v()
    else if (a === '--max-tokens') o.maxTokens = Number(v())
    else if (a === '--no-gate') o.noGate = true
    else if (a === '--dry-run') o.dryRun = true                 // v4.3：只构造任务 / 分组并打印，不发任何请求（计划核对）
    else if (a === '--store-text') o.storeText = true          // v4.3：transcript 存 reasoning / stored 全文（≤12k 字）⇒ 子状态同时是压缩任务与飞轮材料
    else if (a === '--from-state') o.fromState = v()           // v4.3：从子状态文件（单个或数组）续跑，而不是从场景第 1 轮开始
    else if (a === '--perturb') o.perturb = v().split(',')     // v4.3：零 API 场景扰动（decoy：诱饵同名文件 + README 误导；两臂同扰动）
    else throw new Error('未知参数 ' + a)
  }
  o.variants = [...new Set(o.variants)]
  return o
}
/** 零 API 场景扰动：decoy = 把最可能被首先打开的源文件复制成一个诱饵（相近文件名 + 误导注释）并在 README 里指向它 ⇒ 正确下一步不再唯一；fixed / canned 不变。 */
export function perturbTask(task, kind) {
  if (!kind || kind === 'none') return task
  if (kind !== 'decoy') throw new Error('unknown-perturb:' + kind)
  const srcs = Object.keys(task.files).filter((f) => /^src\/.*\.m?js$/.test(f))
  if (!srcs.length) return { ...task, id: task.id + ':decoy', perturb: kind }
  const target = srcs[0], decoy = target.replace(/\.(m?js)$/, '.legacy.$1')
  const files = { ...task.files, [decoy]: `// 旧实现（仍被部分脚本引用；行为与 ${target} 相近）\n` + task.files[target].replace(/\d+/g, (d) => String(Number(d) + 1)), 'README.md': (task.files['README.md'] || '') + `\n\n> 注意：历史原因，${decoy} 与 ${target} 并存，排查时先看 ${decoy}。\n` }
  return { ...task, id: task.id + ':decoy', perturb: kind, files }
}
/** 子状态文件：单个对象或数组（cfb-cycle states 导出）。 */
export function loadStates(file) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : [j] }
/** 策略变体：policy:base = 生产 v4d9 提示词原样（经同一直连路径）；policy:<id> 读 <policyDir>/<id>.json（默认 CFB_CYCLE_DIR/offline/policies 或 .cfb-offline/policies）。 */
export function loadPolicyFor(variant, policyDir) {
  if (!variant.startsWith('policy:')) return null
  const id = variant.slice('policy:'.length)
  if (id === 'base') return BASE_POLICY
  const dir = policyDir || (process.env.CFB_CYCLE_DIR ? path.join(path.resolve(process.env.CFB_CYCLE_DIR), 'offline', 'policies') : path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.cfb-offline', 'policies'))
  const file = path.join(dir, id + '.json')
  if (!fs.existsSync(file)) throw new Error('policy-not-found:' + id + '（' + file + '）')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
/** --plan：预注册的分叉轨迹计划（cfb-cycle plan-traj 冻结）。运行参数必须与计划一致，否则拒绝；跑完写回执 receipt.json。 */
export function checkTrajPlan(plan, o) {
  if (!plan || plan.schema !== 'cfb.traj-plan/1') throw new Error('traj-plan-schema')
  const want = { variants: [...plan.variants].sort().join(','), samples: plan.samples, maxRounds: plan.maxRounds, fork: !!plan.fork, only: (plan.scenarios || []).slice().sort().join(','), fromState: plan.fromStates ? path.normalize(plan.fromStates.file) : '', storeText: !!plan.storeText }
  const have = { variants: [...o.variants].sort().join(','), samples: o.samples, maxRounds: o.maxRounds, fork: !!o.fork, only: (o.only || []).slice().sort().join(','), fromState: o.fromState ? path.normalize(path.relative(process.cwd(), path.resolve(o.fromState))) : '', storeText: !!o.storeText }
  const diff = Object.keys(want).filter((k) => String(want[k]) !== String(have[k]))
  if (diff.length) throw new Error('traj-plan-mismatch:' + diff.map((k) => `${k} plan=${want[k]} run=${have[k]}`).join('; '))
  return { ok: true, digest: plan.digest }
}
/** 策略压缩请求体（与 generation.compressorBody 同口径：temperature 0、thinking on、max_tokens 2048）。 */
export function policyCompressBody({ I, model, reasoning, ctx, policy }) {
  const prompt = applyPolicyToPrompt(I.buildCompressPromptV4Direct(reasoning, ctx, null), policy)
  return { model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0, thinking: { type: 'enabled' }, stream: false }
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
const normCmd = (s) => String(s || '').replace(/\s+/g, ' ').trim()
/** 从「[tool_call name] {…}」文本里抠出调用：从 { 起做括号配对（尊重字符串与转义），容忍尾随的 ] 或多行 JSON */
export function parseTextCalls(text) {
  const out = []; const src = String(text || '')
  const re = /\[tool_call\s+([\w-]+)\]/g; let m
  while ((m = re.exec(src)) !== null) {
    const start = src.indexOf('{', m.index + m[0].length); if (start < 0) continue
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < src.length; i++) {
      const ch = src[i]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const raw = src.slice(start, end + 1)
    let args = raw
    try { args = JSON.parse(raw) } catch { try { args = JSON.parse(raw.replace(/\r?\n/g, '\\n')) } catch {} }
    out.push({ name: m[1], args })
    re.lastIndex = end + 1
  }
  return out
}
export function callsOfMessage(m) {
  const out = []
  if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) out.push({ name: c.function && c.function.name, args: c.function && c.function.arguments })
  out.push(...parseTextCalls(m.content))   // 两个来源都收，再去重（中转可能只把一部分文本调用解析成 tool_calls）
  // 中转有时把文本里的调用同时也解析成 tool_calls、或正文重复 ⇒ 按 (name, args) 去重，保序
  const seen = new Set()
  return out.filter((c) => { const k = c.name + '|' + normCmd(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)); if (seen.has(k)) return false; seen.add(k); return true })
}

export async function runOne({ o, task, variant, sample, chat, I, cred, forkMessage = null, state = null }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-'))
  materialize(task, repo)
  const policy = loadPolicyFor(variant, o.policyDir)
  const messages = [{ role: 'system', content: o.textTools ? SYSTEM_TEXT_TOOLS : SYSTEM }, { role: 'user', content: task.prompt }]
  const rec = { task: task.id, variant, sample, rounds: 0, calls: 0, edits: [], repeats: 0, fixedAtRound: null, verifiedAfterFix: false, promptTokens: 0, compile: [], transcript: [], rejected: 0, ...(policy ? { policy: policy.id } : {}), ...(forkMessage ? { forked: true } : {}), ...(task.perturb ? { perturb: task.perturb } : {}), ...(state ? { fromState: state.id, family: state.family, startRound: state.startRound } : {}) }
  const seenCmds = new Map()
  let firstRound = 1
  if (state) {
    // v4.3 子状态续跑：确定性重放前 k−1 轮的调用得到仓库状态，消息前缀只含 assistant 文字 + 工具结果（无思维链；模型从这里重新思考）
    for (const c of state.replay || []) { const out = execTool(task, repo, c.name, c.args); if (c.name === 'bash') seenCmds.set(normCmd(c.args && c.args.command), state.startRound - 1); if (c.name === 'edit_file') rec.edits.push({ round: 0, path: c.args && c.args.path, ok: /^ok/.test(out), replayed: true }) }
    if (task.fixed(repo)) throw new Error('state-already-fixed:' + state.id)
    for (const m of state.messages || []) messages.push(m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content })
    firstRound = state.startRound
  }
  try {
    for (let round = firstRound; round <= o.maxRounds; round++) {
      let r
      if (round === firstRound && forkMessage) r = { message: forkMessage, usage: { prompt_tokens: 0 }, fp: 'fork' }
      else for (let k = 0; ; k++) {
        // 中转按请求内容（大致）黏住后端，作废重发常连续落到同一不可信后端 ⇒ 先用 max_tokens:1 的探针（只花 prefill）试后端，可信了再发真请求；
        //   每次重试在末条 user 末尾加 k 个零宽空格打散黏性，并退避几秒让路由轮转
        const msgs = k === 0 ? messages : messages.map((m, i) => i === messages.length - 1 && m.role === 'user' ? { ...m, content: m.content + '\u200b'.repeat(k) } : m)
        if (o.requireFp) {
          const probe = await chat({ model: o.model, messages: msgs, ...(o.textTools ? {} : { tools: TOOLS }), thinking: { type: 'enabled' }, max_tokens: 1, stream: false })
          rec.probes = (rec.probes || 0) + 1
          if (claudeShaped(probe.usage) || !TRUSTED_FP.has(probe.fp)) { rec.probeMiss = (rec.probeMiss || 0) + 1; if (k >= o.maxProbes - 1) throw new Error(`探针 ${o.maxProbes} 次都没等到可信后端`); await new Promise((s) => setTimeout(s, Math.min(30000, 3000 + 1500 * k))); continue }
        }
        r = await chat({ model: o.model, messages: msgs, ...(o.textTools ? {} : { tools: TOOLS }), thinking: { type: 'enabled' }, max_tokens: o.maxTokens - k, stream: false })
        const seen = !claudeShaped(r.usage) && (!o.requireFp || TRUSTED_FP.has(r.fp))
        if (seen && (r.message.reasoning_content || '').length > 0) break
        rec.rejected++
        rec.rejectedWhy = (rec.rejectedWhy || []).concat(claudeShaped(r.usage) ? 'claude' : 'fp=' + r.fp)
        if (k >= o.maxProbes - 1) throw new Error('通道始终未送入思考：' + rec.rejectedWhy.slice(-10).join(','))
      }
      rec.rounds = round
      if (round === firstRound && !forkMessage) rec.firstMessage = r.message   // --fork：其他臂从这条（起始轮）回复分叉
      rec.promptTokens += Number(r.usage && r.usage.prompt_tokens) || 0
      const reasoning = String(r.message.reasoning_content || '')
      const text = responseText(r.message)
      const calls = callsOfMessage(r.message)
      let stored = reasoning, compileInfo = null
      if ((variant === 'auto' || policy) && reasoning.length < o.minChars) { compileInfo = { ok: false, belowFloor: true, rawChars: reasoning.length }; rec.compile.push(compileInfo) }
      else if (policy) {
        // v4.1 策略变体：生产 v4 提示词 + 策略补丁，直连同一通道；两臂（policy:base vs policy:<id>）同路径 ⇒ 差异只来自补丁
        const callsBlock = I.turnCallsBlock(calls); const ctx = I.buildCompressCtx(messages) + (callsBlock ? '\n\n' + callsBlock : '')
        const t0 = Date.now()
        try {
          const g = await chat(policyCompressBody({ I, model: o.model, reasoning, ctx, policy })); const txt = responseText(g.message); if (!txt || txt.length < 80) throw new Error('empty-compress')
          // v4.2：过生产同一道闸（compileV4Direct：长度包络 / 无发明标识符 / 三元组保留）；闸不过 ⇒ 与生产 birth 一样原文放行（distill-failed）
          const gate = o.noGate ? { ok: true, stats: null, text: txt } : I.compileV4Direct(txt, reasoning, { compressCtx: ctx })
          if (gate.ok) { stored = gate.text || txt; compileInfo = { ok: true, ms: Date.now() - t0, rawChars: reasoning.length, outChars: stored.length, policy: policy.id, gate: gate.stats || null } }
          else { stored = reasoning; compileInfo = { ok: false, gateFail: true, reason: gate.reason, ms: Date.now() - t0, rawChars: reasoning.length, policy: policy.id, gate: gate.stats || null } }
        }
        catch (e) { compileInfo = { ok: false, ms: Date.now() - t0, rawChars: reasoning.length, policy: policy.id, error: String(e && e.message || e).slice(0, 120) } }
        rec.compile.push(compileInfo)
      }
      else if (variant === 'auto') {
        const callsBlock = I.turnCallsBlock(calls); const ctx = I.buildCompressCtx(messages) + (callsBlock ? '\n\n' + callsBlock : '')   // v12.9.2：与 birth.js / compile-mr 同一渲染（turnCallsBlock）
        const cfg = I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: ctx, model: o.model, baseUrl: o.baseUrl, credentialsPath: cred, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs: 90000 })
        const t0 = Date.now()
        try { const g = await I.makeBirthCompiler(cfg)(reasoning); stored = g.text; compileInfo = { ok: true, ms: Date.now() - t0, rawChars: reasoning.length, outChars: g.text.length, promptVersion: g.meta && g.meta.promptVersion, gate: g.meta && g.meta.v4 } }
        catch (e) { compileInfo = { ok: false, ms: Date.now() - t0, rawChars: reasoning.length, error: String(e && e.message || e).slice(0, 120) } }
        rec.compile.push(compileInfo)
      }
      messages.push({ role: 'assistant', content: text, reasoning_content: stored })
      rec.transcript.push({ round, reasoningChars: reasoning.length, storedChars: stored.length, text: text.slice(0, 3000), calls: calls.map((c) => ({ name: c.name, args: String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)).slice(0, o.storeText ? 8000 : 400) })), ...(o.storeText ? { reasoning: reasoning.slice(0, 12000), stored: stored === reasoning ? null : stored.slice(0, 12000) } : {}) })
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
        if (c.name === 'edit_file') { rec.edits.push({ round, path: argsObj && argsObj.path, ok: /^ok/.test(out) }); if (rec.fixedAtRound == null && task.fixed(repo)) rec.fixedAtRound = round }   // 同一轮里 edit 之后紧跟的验收也算
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
    // v4.1：逐轮执行器代理旗标（与 v9 L1 同族）；proxyScore = 修好前各轮均分（轨迹级口径），proxyRound2 = 第 2 轮（最早受压缩稿影响的一步）
    rec.proxySteps = stepFlags(rec).map((s) => ({ round: s.round, ...s.flags, score: s.score }))
    const pre = rec.proxySteps.filter((s) => !(Number.isInteger(rec.fixedAtRound) && s.round >= rec.fixedAtRound))
    rec.proxyScore = pre.length ? +(pre.reduce((a, s) => a + s.score, 0) / pre.length).toFixed(3) : null
    rec.proxyRound2 = rec.proxySteps.find((s) => s.round === 2)?.score ?? null
  } catch (e) { rec.error = String(e && e.message || e) }
  finally { fs.rmSync(repo, { recursive: true, force: true }) }
  return rec
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '—'
const pct = (xs) => xs.length ? Math.round(100 * mean(xs)) + '%' : '—'
/** 从 transcript 重算「修好后有没有验收」（同一轮 edit 之后的验收也算）；老记录也能修正 */
export function recomputeVerified(r, verifyRe) {
  if (!r.transcript || r.fixedAtRound == null) return r.verifiedAfterFix
  for (const t of r.transcript) {
    if (t.round < r.fixedAtRound) continue
    const calls = t.calls || []
    const editIdx = calls.findIndex((c) => /edit/i.test(c.name))
    for (let i = 0; i < calls.length; i++) {
      if (t.round === r.fixedAtRound && editIdx >= 0 && i < editIdx) continue
      if (calls[i].name === 'bash' && verifyRe.test(String(calls[i].args || ''))) return true
    }
  }
  return false
}
export function summarizeTraj(rows) {
  for (const r of rows) { const task = TRAJ_TASKS.find((t) => t.id === r.task); if (task && !r.error) { r.verifiedAfterFix = recomputeVerified(r, task.verifyRe); r.claimJustified = r.claim === 'fixed' ? (r.fixed && r.verifiedAfterFix) : r.claim === 'hedged' ? true : !r.fixed || !r.final } }
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
  const have = new Set(done.filter((r) => !r.error).map((r) => `${r.fromState || r.task}|${r.variant}|${r.sample}`))
  let plan = null
  if (o.plan) { plan = JSON.parse(fs.readFileSync(o.plan, 'utf8')); checkTrajPlan(plan, o); console.log(`按预注册计划 ${plan.id}（digest ${plan.digest}，预估 ≈$${plan.cost?.expectedUsd}，上界 ≈$${plan.cost?.capUsd}）运行；目的：${plan.purpose}`) }
  if (!o.summarizeOnly) {
    const apiKey = process.env.DEEPSEEK_API_KEY || (o.dryRun ? 'dry' : null); if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const I = await import('../index.js')
    const chat = o.dryRun ? async () => { throw new Error('dry-run') } : makeChat({ baseUrl: o.baseUrl, apiKey })
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')); const cred = path.join(d, 'c.yaml'); fs.writeFileSync(cred, 'K: "' + apiKey + '"\n', { mode: 0o600 })
    const jobs = []
    const states = o.fromState ? loadStates(o.fromState) : null
    const scenarioSpecs = (o.only || TRAJ_TASKS.map((t) => t.id)).map((x) => { const [id, kind] = x.split(':'); return { id, kind: kind || (o.perturb && o.perturb[0] !== 'none' ? o.perturb[0] : null) } })
    if (states) { for (const st of states) { const base = TRAJ_TASKS.find((t) => t.id === st.family); if (!base) throw new Error('state-family-unknown:' + st.family); for (const v of o.variants) for (let k = 0; k < o.samples; k++) if (!have.has(`${st.id}|${v}|${k}`)) jobs.push({ task: base, variant: v, sample: k, state: st }) } }
    else for (const spec of scenarioSpecs) { const base = TRAJ_TASKS.find((t) => t.id === spec.id); if (!base) throw new Error('unknown-scenario:' + spec.id); const task = perturbTask(base, spec.kind); for (const v of o.variants) for (let k = 0; k < o.samples; k++) if (!have.has(`${task.id}|${v}|${k}`)) jobs.push({ task, variant: v, sample: k }) }
    console.log(`轨迹 ${jobs.length} 条（每条 ≤ ${o.maxRounds} 轮主调用${o.variants.includes('auto') ? ' + 同数副调用' : ''}），并发 ${o.concurrency}`)
    // --fork：同题同样本分组，第一臂跑完第 1 轮后其余臂从同一条第 1 轮回复分叉（配对在分叉点、每组省 (臂数−1) 次主调用）
    const groups = o.fork ? [...jobs.reduce((m, j) => { const k = `${j.state ? j.state.id : j.task.id}|${j.sample}`; (m.get(k) || m.set(k, []).get(k)).push(j); return m }, new Map()).values()] : jobs.map((j) => [j])
    const stop = plan?.stop || null; let stopped = null; const spent = { usd: 0 }
    if (o.fork) console.log(`--fork：${groups.length} 组，每组 ${o.variants.length} 臂共用第 1 轮`)
    if (o.dryRun) {
      // 零 API 核对：对子状态还做一次确定性重放，确认仓库状态可达且尚未修好
      let replayed = 0, bad = []
      for (const j of jobs) if (j.state) { const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-dry-')); try { materialize(j.task, repo); for (const c of j.state.replay || []) execTool(j.task, repo, c.name, c.args); if (j.task.fixed(repo)) bad.push(j.state.id + ':already-fixed'); else replayed++ } catch (e) { bad.push(j.state.id + ':' + e.message) } finally { fs.rmSync(repo, { recursive: true, force: true }) } }
      console.log(`dry-run：任务 ${jobs.length}（${[...new Set(jobs.map((j) => j.state ? j.state.id : j.task.id))].length} 个起点 × ${o.variants.length} 臂 × ${o.samples} 样本）、组 ${groups.length}；子状态重放成功 ${replayed}${bad.length ? '，失败 ' + bad.length + '：' + bad.slice(0, 5).join(' ') : ''}${stop ? `；停止规则 α=${stop.alpha} 上界 $${stop.capUsd}` : ''}；未发任何请求`)
      fs.rmSync(d, { recursive: true, force: true }); return { dryRun: true, jobs: jobs.length, groups: groups.length, replayed, bad }
    }
    let i = 0
    await Promise.all(Array.from({ length: Math.min(o.concurrency, groups.length) }, async () => {
      while (i < groups.length) {
        const grp = groups[i++]
        let forkMessage = null
        for (const j of grp) {
        if (stopped) break
        const rec = await runOne({ o, task: j.task, variant: j.variant, sample: j.sample, chat, I, cred, forkMessage, state: j.state || null })
        spent.usd += (rec.rounds || 0) * (plan?.cost?.pricing?.mainUsd ?? 0.0125) + (rec.compile || []).filter((c) => !c.belowFloor).length * (plan?.cost?.pricing?.compressUsd ?? 0.0075)
        if (o.fork && !forkMessage && rec.firstMessage) forkMessage = rec.firstMessage
        delete rec.firstMessage
        fs.appendFileSync(resPath, JSON.stringify(rec) + '\n')
        console.log(`  ${rec.task}/${rec.variant} #${rec.sample}: ${rec.error ? 'ERR ' + rec.error : `${rec.fixed ? '修好@' + rec.fixedAtRound : '未修好'} · ${rec.rounds} 轮 · ${rec.calls} 调用 · edit ${rec.edits.length} · 重复 ${rec.repeats} · 验收 ${rec.verifiedAfterFix ? '●' : '·'} · 声明 ${rec.claim}${rec.claimJustified ? '' : '（不相称）'} · tokens ${rec.promptTokens}${rec.compile.length ? ' · 压稿 ' + rec.compile.filter((c) => c.ok).length + '/' + rec.compile.length : ''} · proxy ${rec.proxyScore ?? '—'}${rec.forked ? ' · 分叉' : ''}`}`)
        }
        // v4.3 有界续跑：一次批准内自动跑到判定或预算上界（e 值任意停时有效，提前停不损失保证）
        if (stop && !stopped) {
          const done = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error)
          const cmp = outcomeComparison(done.map((r) => ({ ...r, arm: r.variant === stop.compare.champion ? 'champion' : r.variant === stop.compare.previous ? 'previous' : null, sample: `${r.fromState || r.task}#${r.sample ?? 0}` })).filter((r) => r.arm))
          const thr = 1 / (stop.alpha || 0.1)
          if (cmp.pairs.length >= (stop.minPairs || 4) && (cmp.e >= thr || cmp.eReject >= thr)) stopped = `判定达成（${cmp.pairs.length} 对，e=${cmp.e} / 更差 e=${cmp.eReject} ≥ ${thr}）`
          else if (stop.capUsd && spent.usd >= stop.capUsd) stopped = `预算上界 $${stop.capUsd} 已到（估 $${spent.usd.toFixed(3)}）`
          if (stopped) console.log('提前停止：' + stopped)
        }
      }
    }))
    fs.rmSync(d, { recursive: true, force: true })
  }
  const all = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map(); for (const r of all) { const k = `${r.task}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  const md = summarizeTraj([...last.values()])
  fs.writeFileSync(path.join(o.out, 'summary.md'), md + '\n')
  if (plan) { const rows = [...last.values()]; fs.writeFileSync(path.join(o.out, 'receipt.json'), JSON.stringify({ schema: 'cfb.traj-receipt/1', plan: plan.id, digest: plan.digest, at: new Date().toISOString(), trajectories: rows.length, errors: rows.filter((r) => r.error).length, mainCalls: rows.reduce((a, r) => a + (r.rounds || 0), 0), compressCalls: rows.reduce((a, r) => a + (r.compile || []).filter((c) => !c.belowFloor).length, 0), promptTokens: rows.reduce((a, r) => a + (r.promptTokens || 0), 0), gateFails: rows.reduce((a, r) => a + (r.compile || []).filter((c) => c.gateFail).length, 0), estimatedUsd: +spent.usd.toFixed(3), stoppedEarly: stopped || null }, null, 2) + '\n') }
  console.log('\n' + md)
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
