// tools/traj-run.mjs —— 2c「假仓库全轨迹」（理论 S10.6）：主模型在真的文件上跑完整循环（≤ N 轮），每轮的 reasoning 按变体处理：
//   raw = 原样留在上下文里；auto = 当轮结束时用副模型压成稿（生产同口径：makeBirthCompiler + buildCompressCtx 台账 + 本轮已发出的调用，≥ birthMinChars 才压），替换 reasoning_content；
//   ledger = 不压缩，只把程序算的【台账】附在每轮工具结果后（零副模型成本；S10.11 的对照）。
//   工具：read_file / edit_file 真改；bash 先查 canned（测试 / trace / CI 按文件状态给结果），否则白名单命令真跑（grep/sed/cat/ls/head/tail/wc/find）。
//   量：到修好的轮数、edit 次数、重复命令、修好后有没有验收、最终声明是否与状态相称、prompt tokens 合计、上下文里 reasoning 字数。
// 用法：DEEPSEEK_API_KEY=… node tools/traj-run.mjs --variants raw,auto --samples 1 --max-rounds 6 --require-fp --base-url … --model … --out traj1 [--only id]
// v4.7（v14.12）影子分叉（shadow-until-divergence）：分叉组里 raw 臂先跑完整条；其余臂**不发主调用**地复用 raw 的每一轮回复，直到自己真正存进历史的稿
//   第一次与原文不同（压缩闸通过 / 手写稿收下）那一轮为止 —— 之后才各自发主调用。在那之前两臂输入逐字节相同，各自采样只是重复抽样（纯噪声、零对比信息；
//   29 条真实轨迹审计：原文 ≥3100 字的轮只占 13%，首次有效压缩多在第 3 轮，旧设计每组白付 2–4 次主调用并把独立噪声混进「配对」）。
//   没分歧到底的组 = 压缩器整条都没触发 ⇒ 结局与 raw 相同（记 shadow.divergedAt=null；confirm/ceiling 里按平手计并单独报数）。
//   --fork-from FILE：复用已有 results.jsonl 里带 roundMessages 的 raw 轨迹当 leader（非同期对照：只能同模型、短窗口；行上记 reusedFrom）。
// v4.6（v14.11）模式 1：变体 hand = 助手代替副模型手写稿。到了要压缩的那一轮，把副模型本该拿到的 prompt / 原文 / ctx 写进 <out>/pending/<id>.json、
//   把轨迹状态存进 <out>/state/<task>-s<k>.json 后暂停（results.jsonl 记一行 status:'awaiting-draft'）；助手写好 <out>/drafts/<id>.md 后用**同一条命令**再跑，
//   自动从状态续：稿走与生产完全相同的闸链（compileV4Direct → 程序部件拼接 → birthAccept）外加 G2「决策不变」闸（hand-draft.mjs）；任一闸不过 ⇒ 继续暂停并把违规写回 pending。
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
import { BASE_POLICY, applyPolicyToPrompt, PRODUCTION_COMPRESSOR } from './helpers/generation.mjs'
import { handDraftGate, HAND_PROTOCOL } from './helpers/hand-draft.mjs'

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
    else if (a === '--preflight-only') o.preflightOnly = true          // v4.7.1：只做通道预检（一次 ≤64 token 的小请求），不跑任何轨迹
    else if (a === '--compress-thinking') o.compressThinking = true   // v14.9：诊断用（只在 --legacy-compress 下有意义）
    else if (a === '--legacy-compress') o.legacyCompress = true   // v14.10：旧的工具自拼请求路径（对照 v14.9 之前的收据用）；缺省走生产 birth 同构体
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
    else if (a === '--fork-from') o.forkFrom = v()
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
  if ((plan.reuseRaw?.file || null) !== (o.forkFrom ? path.normalize(path.relative(process.cwd(), path.resolve(o.forkFrom))) : null)) throw new Error(`traj-plan-mismatch:forkFrom（计划 ${plan.reuseRaw?.file || '无'} ≠ 运行 ${o.forkFrom || '无'}）`)
  if (!plan || plan.schema !== 'cfb.traj-plan/1') throw new Error('traj-plan-schema')
  const want = { variants: [...plan.variants].sort().join(','), samples: plan.samples, maxRounds: plan.maxRounds, fork: !!plan.fork, only: (plan.scenarios || []).slice().sort().join(','), fromState: plan.fromStates ? path.normalize(plan.fromStates.file) : '', storeText: !!plan.storeText }
  const have = { variants: [...o.variants].sort().join(','), samples: o.samples, maxRounds: o.maxRounds, fork: !!o.fork, only: (o.only || []).slice().sort().join(','), fromState: o.fromState ? path.normalize(path.relative(process.cwd(), path.resolve(o.fromState))) : '', storeText: !!o.storeText }
  const diff = Object.keys(want).filter((k) => String(want[k]) !== String(have[k]))
  if (diff.length) throw new Error('traj-plan-mismatch:' + diff.map((k) => `${k} plan=${want[k]} run=${have[k]}`).join('; '))
  return { ok: true, digest: plan.digest }
}
/** 策略压缩请求体 —— v14.9 起与生产 distillOnce 同形（temperature 0、max_tokens 850、thinking disabled；见 generation.PRODUCTION_COMPRESSOR）。
 *  policy:base 臂因此就是生产压缩器本身（只差走不走 birth 的重试/对冲），候选臂与它的差只来自补丁。`--compress-thinking` 可开回旧形态（诊断用，不是生产）。 */
export function policyCompressBody({ I, model, reasoning, ctx, policy, maxTokens = PRODUCTION_COMPRESSOR.maxTokens, thinking = PRODUCTION_COMPRESSOR.thinking }) {
  const prompt = applyPolicyToPrompt(I.buildCompressPromptV4Direct(reasoning, ctx, null), policy)
  return { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, thinking, stream: false }
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
export function execTool(task, repo, name, args) {
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

/** v4.7.1 通道预检（≈1/300 轮的钱）：开跑前一次小请求，证明这条通道**现在**会把思维链返回来（reasoning_content 非空）、指纹可信、不是 Claude 形状、型号回显一致。
 *  起因：2026-10-02 a6api 上游一度不返回思维链；主循环把「空思考」当成路由黏住去重试，每次重试都是一次完整付费请求 —— 预检不过就一分钱不花地停。 */
const canonModel = (x) => String(x || '').toLowerCase().replace(/[._-]+/g, '-')
/** v4.7.2 「携带」检验：通道有没有把历史 assistant 消息里的 reasoning_content 真的送进模型。
 *  可信指纹（fp_dspure_app_v1）是这件事的代理证据（2026-09-28 实测该后端拼接历史思考：1 字 → 776、1000 字 → 1375 prompt tokens）；指纹为空时直接量：
 *  同一份消息，带 / 不带历史 reasoning_content 各发一次 max_tokens:1（只花 prefill），Δprompt_tokens ≥ CARRY_MIN_RATIO × 历史思考字数才算送进去了。
 *  这与 effect-eval 的 sawReasoning（base + 0.3×字数）同一思路，但在每一轮上直接量而不是用一个全局 base。 */
// 阈值校准（2026-10-02 实测）：中文假历史 1200 字 ⇒ Δ594（0.495/字）；真实第 1 轮思考 82 字（英文 / 代码为主）⇒ Δ19（0.232/字）；丢思考的通道 Δ=0。
//   取 0.12/字 且 ≥ 4 tokens：与「0」分得开，又不误杀英文 / 代码为主的短思考（第一次用 0.25 把 0.232 判成不过、白烧 15 对探针 —— 教训记在 §17.5）。
export const CARRY_MIN_RATIO = 0.12, CARRY_MIN_DELTA = 4, CARRY_MIN_HISTORY = 40   // 历史思考 < 40 字时量不出来也无所谓（被测变量是 ≥ 几百字的稿），按 no-history 放行，后面轮会补验
export const stripReasoning = (messages) => messages.map((m) => (m.role === 'assistant' && m.reasoning_content ? { ...m, reasoning_content: '' } : m))
export const historyReasoningChars = (messages) => messages.filter((m) => m.role === 'assistant').reduce((n, m) => n + String(m.reasoning_content || '').length, 0)
export async function carryCheck({ chat, o, messages, tools = null, probe = null }) {
  const L = historyReasoningChars(messages); const body = (ms) => ({ model: o.model, messages: ms, ...(tools ? { tools } : {}), thinking: { type: 'enabled' }, max_tokens: 1, stream: false })
  const withR = probe || await chat(body(messages)); const without = await chat(body(stripReasoning(messages)))
  const a = Number(withR.usage?.prompt_tokens), b = Number(without.usage?.prompt_tokens), delta = a - b
  const ok = L > 0 && Number.isFinite(delta) && delta >= Math.max(CARRY_MIN_DELTA, CARRY_MIN_RATIO * L)
  return { L, withReasoning: a, without: b, delta, ratio: L ? +(delta / L).toFixed(3) : null, need: Math.max(CARRY_MIN_DELTA, Math.ceil(CARRY_MIN_RATIO * L)), ok, fp: withR.fp || null }
}
export async function preflightUpstream({ chat, o }) {
  const t0 = Date.now(); let r = null, error = null
  try { r = await chat({ model: o.model, messages: [{ role: 'user', content: '1+1=?只答数字。' }], thinking: { type: 'enabled' }, max_tokens: 64, stream: false }) } catch (e) { error = String(e?.message || e) }
  const reasoning = String(r?.message?.reasoning_content || ''); const rt = Number(r?.usage?.completion_tokens_details?.reasoning_tokens)
  // 携带检验（两次 max_tokens:1）：1200 字的假历史思考要让 prompt_tokens 至少多 300；指纹可信时也量一次留证据，指纹为空时它就是放行依据
  let carry = null
  if (!error && r) {
    try {
      const fake = '这一段只是用来量通道有没有把历史思考送进模型：先确认 settled.ok 的来源，再看 parseSse 对半包的处理，排除权限路线，下一步读 src/sse.js。'.repeat(15).slice(0, 1200)
      const hist = [{ role: 'user', content: '1+1=?只答数字。' }, { role: 'assistant', content: '2', reasoning_content: fake }, { role: 'user', content: '再答一次。' }]
      carry = await carryCheck({ chat, o, messages: hist })
    } catch (e) { carry = { error: String(e?.message || e), ok: false } }
  }
  const fpTrusted = !!r && TRUSTED_FP.has(r.fp)
  const checks = { reachable: !error, fp: !!r && (!o.requireFp || fpTrusted || !!carry?.ok), notClaude: !!r && !claudeShaped(r.usage), reasoning: reasoning.length > 0 || (Number.isFinite(rt) && rt > 0), model: !!r && (!r.model || canonModel(r.model) === canonModel(o.model)) }
  return { schema: 'cfb.preflight/1', at: new Date().toISOString(), model: o.model, modelEcho: r?.model || null, baseUrl: o.baseUrl, fp: r?.fp || null, fpTrusted, carry, mode: fpTrusted ? 'trusted-fp' : carry?.ok ? 'carry-verified' : null, finish: r?.finish || null, usage: r?.usage || null, reasoningChars: reasoning.length, contentChars: r ? responseText(r.message).length : 0, ms: Date.now() - t0, error, checks, ok: Object.values(checks).every(Boolean),
    failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k) }
}
export async function runOne({ o, task, variant, sample, chat, I, cred, forkMessage = null, state = null, resume = null, leader = null, extend = null }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-'))
  materialize(task, repo)
  const policy = loadPolicyFor(variant, o.policyDir)
  const hand = variant === 'hand'
  let messages = [{ role: 'system', content: o.textTools ? SYSTEM_TEXT_TOOLS : SYSTEM }, { role: 'user', content: task.prompt }]
  const rec = { at: new Date().toISOString(), task: task.id, variant, sample, rounds: 0, calls: 0, edits: [], repeats: 0, fixedAtRound: null, verifiedAfterFix: false, promptTokens: 0, compile: [], transcript: [], rejected: 0, ...(policy ? { policy: policy.id } : {}), ...(forkMessage || leader ? { forked: true } : {}), ...(task.perturb ? { perturb: task.perturb } : {}), ...(state ? { fromState: state.id, family: state.family, startRound: state.startRound } : {}) }
  // v4.7 影子分叉：lead = leader（raw 臂逐轮回复）或老式单条 forkMessage；diverged 之前每轮直接取 lead 的回复，不发主调用
  let lead = leader ? leader.slice() : (forkMessage ? [forkMessage] : null), diverged = false
  if (leader) rec.shadow = { rounds: 0, divergedAt: null }   // 只有 raw 当 leader 的影子分叉才有「分歧轮」语义；老式单条 forkMessage 只分叉第 1 轮
  if (extend) rec.extended = extend   // v4.7.2 延长：raw 影子自己被轮数上限截断的过去（前 from 轮零主调用），从 from+1 轮起真跑；不是跟随臂，不算「未分歧」
  const ownRounds = []   // 本臂每轮的主模型回复（raw 臂 + --store-text 时持久化为 roundMessages，供影子分叉 / --fork-from 复用）
  let seenCmds = new Map()
  let firstRound = 1
  const replayLog = []   // 本轨迹已执行过的全部调用（含子状态前缀）—— hand 臂暂停时存下来，续跑时确定性重放恢复仓库
  if (resume) {
    // v4.6 hand 臂续跑：仓库 = 重放已执行调用；消息 / 记录 / 已见命令 = 暂停时的快照；本轮主模型回复已在手，不再发主调用
    for (const c of resume.replay || []) execTool(task, repo, c.name, c.args)
    replayLog.push(...(resume.replay || []))
    messages = resume.messages; Object.assign(rec, resume.rec); seenCmds = new Map(resume.seenCmds || []); firstRound = resume.round
    rec.resumed = (rec.resumed || 0) + 1
    if (resume.lead) { lead = resume.lead; diverged = !!resume.diverged; if (!rec.shadow) rec.shadow = { rounds: 0, divergedAt: null } }
  }
  if (state && !resume) {
    // v4.3 子状态续跑：确定性重放前 k−1 轮的调用得到仓库状态，消息前缀只含 assistant 文字 + 工具结果（无思维链；模型从这里重新思考）
    for (const c of state.replay || []) { const out = execTool(task, repo, c.name, c.args); if (c.name === 'bash') seenCmds.set(normCmd(c.args && c.args.command), state.startRound - 1); if (c.name === 'edit_file') rec.edits.push({ round: 0, path: c.args && c.args.path, ok: /^ok/.test(out), replayed: true }) }
    replayLog.push(...(state.replay || []))
    if (task.fixed(repo)) throw new Error('state-already-fixed:' + state.id)
    for (const m of state.messages || []) messages.push(m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content })
    firstRound = state.startRound
    rec.replayKeys = (state.replay || []).map((c) => c.name + '|' + normCmd(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)))
  }
  try {
    for (let round = firstRound; round <= o.maxRounds; round++) {
      let r
      if (round === firstRound && resume) r = { message: resume.message, usage: { prompt_tokens: 0 }, fp: 'resume' }
      else if (lead && !diverged && lead[round - 1]) { r = { message: lead[round - 1], usage: { prompt_tokens: 0 }, fp: round === 1 ? 'fork' : 'shadow' }; if (rec.shadow) rec.shadow.rounds++ }   // 输入与 leader 逐字节相同 ⇒ 它的采样就是本臂的采样；leader 已结束 / 出错则落到自己发
      else for (let k = 0; ; k++) {
        // 中转按请求内容（大致）黏住后端，作废重发常连续落到同一不可信后端 ⇒ 先用 max_tokens:1 的探针（只花 prefill）试后端，可信了再发真请求；
        //   每次重试在末条 user 末尾加 k 个零宽空格打散黏性，并退避几秒让路由轮转
        const msgs = k === 0 ? messages : messages.map((m, i) => i === messages.length - 1 && m.role === 'user' ? { ...m, content: m.content + '\u200b'.repeat(k) } : m)
        let carried = null   // v4.7.2：本轮放行依据 —— 'trusted-fp'（指纹）或 'carry-verified'（直接量到历史思考进了 prompt）或 'no-history'（历史里还没有思考可送，无需验）
        if (o.requireFp) {
          const probe = await chat({ model: o.model, messages: msgs, ...(o.textTools ? {} : { tools: TOOLS }), thinking: { type: 'enabled' }, max_tokens: 1, stream: false })
          rec.probes = (rec.probes || 0) + 1
          if (claudeShaped(probe.usage)) { rec.probeMiss = (rec.probeMiss || 0) + 1; if (k >= o.maxProbes - 1) throw new Error(`探针 ${o.maxProbes} 次都没等到可信后端`); await new Promise((s) => setTimeout(s, Math.min(30000, 3000 + 1500 * k))); continue }
          if (TRUSTED_FP.has(probe.fp)) carried = 'trusted-fp'
          else if (historyReasoningChars(msgs) < CARRY_MIN_HISTORY) carried = 'no-history'
          else {
            const c = await carryCheck({ chat, o, messages: msgs, tools: o.textTools ? null : TOOLS, probe }); rec.probes++; rec.carry = (rec.carry || []).concat({ round, ...c })
            if (c.ok) carried = 'carry-verified'
            else {
              rec.probeMiss = (rec.probeMiss || 0) + 1
              const prev = rec.carry.length >= 2 ? rec.carry[rec.carry.length - 2] : null
              // 携带检验是确定性的：同一后端两次 Δ 相同就不是路由抖动，再重试只是烧探针 ⇒ 立刻停
              if (prev && prev.round === round && prev.delta === c.delta && prev.L === c.L) throw new Error(`携带检验稳定不过（Δ=${c.delta}/${c.L} 字，需 ≥${c.need}；两次相同 ⇒ 后端没把历史思考送进模型，不是路由抖动）`)
              if (k >= o.maxProbes - 1) throw new Error(`探针 ${o.maxProbes} 次都没等到可信后端（指纹 ${probe.fp}，携带 Δ=${c.delta}/${c.L} 字，需 ≥${c.need}）`)
              await new Promise((s) => setTimeout(s, Math.min(30000, 3000 + 1500 * k))); continue
            }
          }
        }
        r = await chat({ model: o.model, messages: msgs, ...(o.textTools ? {} : { tools: TOOLS }), thinking: { type: 'enabled' }, max_tokens: o.maxTokens - k, stream: false })
        rec.mainCalls = (rec.mainCalls || 0) + 1   // v4.6：真发出的主调用数（fork / resume 轮不计；hand 臂续跑跨进程累加）
        // 真请求的放行：指纹可信；或探针已验携带 / 无历史，且真请求与探针走的是同一条路（prompt_tokens 相差 ≤ 2%：中转按内容黏住后端，但要防换路）
        const samePath = carried && (carried === 'trusted-fp' || Math.abs(Number(r.usage?.prompt_tokens) - Number(rec.carry?.length && carried === 'carry-verified' ? rec.carry[rec.carry.length - 1].withReasoning : r.usage?.prompt_tokens)) <= 0.02 * Number(r.usage?.prompt_tokens))
        const seen = !claudeShaped(r.usage) && (!o.requireFp || TRUSTED_FP.has(r.fp) || !!samePath)
        if (seen && o.requireFp) { const mode = TRUSTED_FP.has(r.fp) ? 'trusted-fp' : carried; rec.fpModes = rec.fpModes || {}; rec.fpModes[mode] = (rec.fpModes[mode] || 0) + 1 }   // 每轮放行依据计数（回执 / review 可见）
        if (seen && (r.message.reasoning_content || '').length > 0) break
        rec.rejected++
        if (seen) { rec.emptyReasoning = (rec.emptyReasoning || 0) + 1; if (rec.emptyReasoning >= 3) throw new Error('upstream-no-reasoning：可信指纹但思维链为空已连续 3 次 ⇒ 停（通道不返回思考，重试只是烧钱）') }   // v4.7.1
        rec.rejectedWhy = (rec.rejectedWhy || []).concat(claudeShaped(r.usage) ? 'claude' : 'fp=' + r.fp)
        if (k >= o.maxProbes - 1) throw new Error('通道始终未送入思考：' + rec.rejectedWhy.slice(-10).join(','))
      }
      rec.rounds = round
      if (round === firstRound && !forkMessage && !resume && !leader) rec.firstMessage = r.message   // --fork：其他臂从这条（起始轮）回复分叉
      ownRounds.push(r.message)
      rec.promptTokens += Number(r.usage && r.usage.prompt_tokens) || 0
      rec.completionTokens = (rec.completionTokens || 0) + (Number(r.usage && r.usage.completion_tokens) || 0)   // v4.7.2：真实输出 token（含思考），成本校准用
      const reasoning = String(r.message.reasoning_content || '')
      const text = responseText(r.message)
      const calls = callsOfMessage(r.message)
      let stored = reasoning, compileInfo = null
      if ((variant === 'auto' || policy || hand) && reasoning.length < o.minChars) { compileInfo = { ok: false, belowFloor: true, rawChars: reasoning.length }; rec.compile.push(compileInfo) }
      else if (hand && (!calls.length || round >= o.maxRounds)) { compileInfo = { ok: false, skipped: 'no-next-round', rawChars: reasoning.length }; rec.compile.push(compileInfo) }   // 没有下一轮会读这份稿 ⇒ 不让操作员白写
      else if (hand) {
        // v4.6 模式 1：助手当副模型。稿文件在 ⇒ 过 G2 + 生产闸链；不在 / 不过 ⇒ 写 pending + state 暂停
        const ctx = I.buildCompressCtx(messages)
        const safeId = task.id.replace(/[^\w.-]/g, '_')
        const id = `${safeId}-s${sample}-r${round}`
        const draftFile = path.join(o.out, 'drafts', id + '.md'), pendingFile = path.join(o.out, 'pending', id + '.json'), stateFile = path.join(o.out, 'state', `${safeId}-s${sample}.json`)
        const cfg = I.offlineBirthConfig({ model: o.model || 'hand', baseUrl: o.baseUrl || 'http://127.0.0.1:1', credentialsPath: cred, policy: null, normalizeConfig: I.normalizeConfig })
        const draft = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8').trim() : null
        let violations = null, b = null
        if (draft) {
          const g2 = handDraftGate(reasoning, draft, ctx)
          if (!g2.ok) violations = g2.violations
          else {
            b = await I.birthOffline({ raw: reasoning, ctx, calls, cfg, gate: !o.noGate, compile: async (rawText, c) => {
              const v = o.noGate ? { ok: true, text: draft, stats: null } : I.compileV4Direct(draft, rawText, { compressCtx: c.compressCtx })
              const pv = I.compressPromptVersion(c) + '+hand'
              if (!v.ok) { const e = new Error('v4-direct:' + v.reason); e.meta = { v4: v.stats, promptVersion: pv }; throw e }
              return { text: v.text || draft, meta: { promptVersion: pv, v4: v.stats } }
            } })
            if (!b.ok) violations = [{ kind: 'production-gate:' + b.why, detail: String(b.reason || JSON.stringify(b.info || null)).slice(0, 200) }]
          }
        }
        if (b && b.ok) {
          stored = b.text
          compileInfo = { ok: true, path: 'hand', ms: b.ms, rawChars: reasoning.length, outChars: stored.length, draftChars: draft.length, policy: 'hand', promptVersion: b.promptVersion, gate: b.v4 || null, spliced: b.spliced || null, accept: b.accept || null, draftFile: path.relative(process.cwd(), draftFile) }
          rec.compile.push(compileInfo)
          if (fs.existsSync(pendingFile)) { fs.mkdirSync(path.join(o.out, 'pending', 'done'), { recursive: true }); fs.renameSync(pendingFile, path.join(o.out, 'pending', 'done', id + '.json')) }
          if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile)
        } else {
          fs.mkdirSync(path.dirname(pendingFile), { recursive: true }); fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.mkdirSync(path.join(o.out, 'drafts'), { recursive: true })
          const prompt = I.compressPromptFor({ ...cfg, compressCtx: ctx }, reasoning)
          fs.writeFileSync(pendingFile, JSON.stringify({ schema: 'cfb.hand-pending/1', id, task: task.id, sample, round, at: new Date().toISOString(), draftFile: path.relative(process.cwd(), draftFile), protocol: HAND_PROTOCOL, violations, draftSeenChars: draft ? draft.length : null, prompt, raw: reasoning, ctx, calls: calls.map((c) => ({ name: c.name, args: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) })), minChars: o.minChars }, null, 2))
          fs.writeFileSync(stateFile, JSON.stringify({ schema: 'cfb.hand-state/1', id, task: task.id, variant, sample, round, at: new Date().toISOString(), message: r.message, messages, rec: { ...rec, firstMessage: undefined }, seenCmds: [...seenCmds], replay: replayLog, lead: lead && !diverged ? lead : null, diverged }))
          rec.status = 'awaiting-draft'; rec.awaiting = { id, round, pending: path.relative(process.cwd(), pendingFile), state: path.relative(process.cwd(), stateFile), draftFile: path.relative(process.cwd(), draftFile), violations }
          return rec
        }
      }
      else if (variant === 'auto' || policy) {
        // v14.10：两种压缩臂都走生产 birth 的离线同构体（src/offline-birth.js）：压缩器看不到本轮调用（与生产同）→ 程序部件拼接 → birthAccept 闸。
        //   auto = 无策略；policy:<id> = cfg.compressPolicy（生产同一配置项）⇒ auto ≡ policy:base 由构造保证，不再有工具自拼的第二条请求路径。
        //   旧路径（policyCompressBody 直连 + compileV4Direct）只在 --legacy-compress 下保留，供对照 v14.9 之前的收据。
        const ctx = I.buildCompressCtx(messages)
        if (o.legacyCompress && policy) {
          const callsBlock = I.turnCallsBlock(calls); const ctxL = ctx + (callsBlock ? '\n\n' + callsBlock : '')
          const t0 = Date.now()
          try {
            const g = await chat(policyCompressBody({ I, model: o.model, reasoning, ctx: ctxL, policy, ...(o.compressThinking ? { thinking: { type: 'enabled' }, maxTokens: 2048 } : {}) })); const txt = responseText(g.message); if (!txt || txt.length < 80) throw new Error('empty-compress')
            const gate = o.noGate ? { ok: true, stats: null, text: txt } : I.compileV4Direct(txt, reasoning, { compressCtx: ctxL })
            if (gate.ok) { stored = gate.text || txt; compileInfo = { ok: true, path: 'legacy', ms: Date.now() - t0, rawChars: reasoning.length, outChars: stored.length, policy: policy.id, gate: gate.stats || null } }
            else { stored = reasoning; compileInfo = { ok: false, path: 'legacy', gateFail: true, reason: gate.reason, ms: Date.now() - t0, rawChars: reasoning.length, policy: policy.id, gate: gate.stats || null } }
          } catch (e) { compileInfo = { ok: false, path: 'legacy', ms: Date.now() - t0, rawChars: reasoning.length, policy: policy.id, error: String(e && e.message || e).slice(0, 120) } }
        } else {
          const cfg = I.offlineBirthConfig({ model: o.model, baseUrl: o.baseUrl, credentialsPath: cred, policy: policy || null, normalizeConfig: I.normalizeConfig })
          const b = await I.birthOffline({ raw: reasoning, ctx, calls, cfg, gate: !o.noGate, compile: o._compile || null })
          stored = b.text
          compileInfo = { ok: b.ok, path: 'birth-offline', ms: b.ms, rawChars: reasoning.length, outChars: b.text.length, policy: b.policy, promptVersion: b.promptVersion, gate: b.v4 || null, ...(b.ok ? { spliced: b.spliced || null, accept: b.accept || null } : { why: b.why, reason: b.reason || null, info: b.info || null }) }
        }
        rec.compile.push(compileInfo)
      }
      if (lead && !diverged && stored !== reasoning) { diverged = true; if (rec.shadow) rec.shadow.divergedAt = round }   // 从下一轮起本臂的历史与 raw 不同 ⇒ 自己发主调用
      messages.push({ role: 'assistant', content: text, reasoning_content: stored })
      rec.transcript.push({ round, reasoningChars: reasoning.length, storedChars: stored.length, text: text.slice(0, 3000), calls: calls.map((c) => ({ name: c.name, args: String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)).slice(0, o.storeText ? 8000 : 400) })), ...(o.storeText ? { reasoning: reasoning.slice(0, 12000), stored: stored === reasoning ? null : stored.slice(0, 12000) } : {}) })
      if (!calls.length) {
        // 中转偶发把「让我读 README…」这类意图当纯文本返回、没带调用 ⇒ 催一次（真实宿主里用户也会这么做）；只催一次
        if (!rec.nudged && round < o.maxRounds && /^(?:让我|我先|先|接下来|下一步|我来)/.test(text.trim()) && text.length < 200) { rec.nudged = true; messages.push({ role: 'user', content: '继续，直接发出工具调用。' }); continue }
        rec.final = text; break
      }
      const results = []
      // v4.3 续跑探针：接上前缀后的第一轮里，有多少调用是在重做前缀里已做过的事（重做多 ⇒ 模型没有把重放的历史当成自己的）
      if (state && round === firstRound) { const keys = calls.map((c) => c.name + '|' + normCmd(typeof c.args === 'string' ? c.args : JSON.stringify(c.args))); const rep = keys.filter((k) => rec.replayKeys.includes(k)).length; rec.continuation = { firstRoundCalls: calls.length, prefixRepeats: rep, verdict: !calls.length ? 'unclear' : rep / calls.length >= 0.5 ? 'restarted' : 'continued' } }
      for (const c of calls) {
        rec.calls++
        const argsObj = typeof c.args === 'string' ? (() => { try { return JSON.parse(c.args) } catch { return { command: c.args } } })() : c.args
        if (c.name === 'bash') { const k = normCmd(argsObj && argsObj.command); if (seenCmds.has(k) && !rec.edits.some((e) => e.round > seenCmds.get(k))) rec.repeats++; seenCmds.set(k, round) }
        const out = execTool(task, repo, c.name, c.args)
        replayLog.push({ name: c.name, args: argsObj })
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
    if (variant === 'raw' && !state) { rec._lead = ownRounds; if (o.storeText) rec.roundMessages = ownRounds }   // raw 臂逐轮回复：同组影子分叉用 _lead；--store-text 时持久化供 --fork-from 复用
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
  const ok = rows.filter((r) => !r.error && r.status !== 'awaiting-draft')
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
  const sh = ok.filter((r) => r.shadow && !r.extended), ex = ok.filter((r) => r.extended)
  if (sh.length) L.push('', `影子分叉：跟随臂 ${sh.length} 条，省下主调用 ${sh.reduce((a, r) => a + r.shadow.rounds, 0)} 次；分歧轮 ${sh.map((r) => r.shadow.divergedAt ?? '无').join(',')}；**未分歧 ${sh.filter((r) => r.shadow.divergedAt == null).length} 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**`)
  if (ex.length) L.push(`延长：raw ${ex.length} 条从第 ${ex.map((r) => r.extended.from + 1).join(',')} 轮续跑（前面的轮复用自 ${[...new Set(ex.map((r) => r.extended.file))].join(',')}，零主调用）`)
  const waiting = rows.filter((r) => r.status === 'awaiting-draft')
  if (waiting.length) L.push('', `等待手写稿 ${waiting.length} 条：` + waiting.map((r) => `${r.task}/${r.variant} #${r.sample} 第 ${r.awaiting?.round} 轮（${r.awaiting?.pending}）`).join('；'))
  return L.join('\n')
}

export async function main(argv) {
  const o = parseArgs(argv)
  fs.mkdirSync(o.out, { recursive: true })
  const resPath = path.join(o.out, 'results.jsonl')
  const done = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const have = new Set(done.filter((r) => !r.error && r.status !== 'awaiting-draft').map((r) => `${r.fromState || r.task}|${r.variant}|${r.sample}`))
  // v4.6：hand 臂暂停过的轨迹有 state 文件 ⇒ 同一条命令再跑时从状态续，而不是重新开始
  const resumeFor = (task, variant, sample) => { if (variant !== 'hand') return null; const f = path.join(o.out, 'state', `${task.id.replace(/[^\w.-]/g, '_')}-s${sample}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  let plan = null, stopped = null; const spent = { usd: 0 }   // 回执在 if 块之外写 ⇒ 声明在函数作用域（v4.7.2 修：第一张真回执 ReferenceError: spent is not defined）
  if (o.plan) { plan = JSON.parse(fs.readFileSync(o.plan, 'utf8')); checkTrajPlan(plan, o); console.log(`按预注册计划 ${plan.id}（digest ${plan.digest}，预估 ≈$${plan.cost?.expectedUsd}，上界 ≈$${plan.cost?.capUsd}）运行；目的：${plan.purpose}`) }
  if (!o.summarizeOnly) {
    const apiKey = process.env.DEEPSEEK_API_KEY || (o.dryRun ? 'dry' : null); if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
    const I = await import('../index.js')
    const chat = o.dryRun ? async () => { throw new Error('dry-run') } : makeChat({ baseUrl: o.baseUrl, apiKey })
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')); const cred = path.join(d, 'c.yaml'); fs.writeFileSync(cred, 'K: "' + apiKey + '"\n', { mode: 0o600 })
    const jobs = []
    const states = o.fromState ? loadStates(o.fromState) : null
    // v4.7 --fork-from：复用旧 results.jsonl 里带 roundMessages 的 raw 轨迹当 leader（非同期对照），本次不再跑 raw 臂
    const reusable = new Map()
    if (o.forkFrom) { for (const r of fs.readFileSync(o.forkFrom, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) if (r.variant === 'raw' && !r.error && Array.isArray(r.roundMessages) && r.roundMessages.length) (reusable.get(r.task) || reusable.set(r.task, []).get(r.task)).push(r) }
    const reused = []
    const scenarioSpecs = (o.only || TRAJ_TASKS.map((t) => t.id)).map((x) => { const [id, kind] = x.split(':'); return { id, kind: kind || (o.perturb && o.perturb[0] !== 'none' ? o.perturb[0] : null) } })
    if (states) { for (const st of states) { const base = TRAJ_TASKS.find((t) => t.id === st.family); if (!base) throw new Error('state-family-unknown:' + st.family); for (const v of o.variants) for (let k = 0; k < o.samples; k++) if (!have.has(`${st.id}|${v}|${k}`)) jobs.push({ task: base, variant: v, sample: k, state: st }) } }
    else for (const spec of scenarioSpecs) {
      const base = TRAJ_TASKS.find((t) => t.id === spec.id); if (!base) throw new Error('unknown-scenario:' + spec.id); const task = perturbTask(base, spec.kind)
      for (let k = 0; k < o.samples; k++) {
        const old = reusable.get(task.id)?.[k]
        let extend = null
        if (old && o.fork && o.variants.includes('raw') && !have.has(`${task.id}|raw|${k}`)) {
          // 旧 raw 被轮数上限截断（最后一轮还在发调用）而本计划轮数更多 ⇒ 延长：raw 作业照建，前 old.rounds 轮影子自己的过去（零主调用），之后真跑；否则整条复用、不跑 raw
          if (old.rounds < o.maxRounds && (old.transcript?.[old.transcript.length - 1]?.calls?.length > 0)) extend = { lead: old.roundMessages, from: old.rounds, file: o.forkFrom, at: old.at || null }
          else { const copy = { ...old, sample: k, reusedFrom: { file: o.forkFrom, at: old.at || null, sample: old.sample, task: old.task, mainCalls: old.mainCalls ?? old.rounds ?? null }, mainCalls: 0, roundMessages: undefined }; reused.push({ task, sample: k, row: copy, lead: old.roundMessages }); have.add(`${task.id}|raw|${k}`) }
        }
        for (const v of o.variants) if (!have.has(`${task.id}|${v}|${k}`)) jobs.push({ task, variant: v, sample: k, resume: resumeFor(task, v, k), ...(v === 'raw' && extend ? { extend } : {}) })
      }
    }
    if (o.forkFrom && !o.dryRun) for (const x of reused) fs.appendFileSync(resPath, JSON.stringify(x.row) + '\n')
    if (o.forkFrom) console.log(`--fork-from ${o.forkFrom}：复用 raw 轨迹 ${reused.length} 条当 leader（非同期对照：只配同模型、短窗口；行上记 reusedFrom）`)
    console.log(`轨迹 ${jobs.length} 条（每条 ≤ ${o.maxRounds} 轮主调用${o.variants.includes('auto') ? ' + 同数副调用' : ''}），并发 ${o.concurrency}`)
    // --fork：同题同样本分组，第一臂跑完第 1 轮后其余臂从同一条第 1 轮回复分叉（配对在分叉点、每组省 (臂数−1) 次主调用）
    const groups = o.fork ? [...jobs.reduce((m, j) => { const k = `${j.state ? j.state.id : j.task.id}|${j.sample}`; (m.get(k) || m.set(k, []).get(k)).push(j); return m }, new Map()).values()].map((g) => g.sort((a, b) => (a.variant === 'raw' ? -1 : 0) - (b.variant === 'raw' ? -1 : 0))) : jobs.map((j) => [j])   // raw 先跑：它是影子分叉的 leader
    const stop = plan?.stop || null
    if (o.fork) console.log(`--fork：${groups.length} 组，每组 ${o.variants.length} 臂共用第 1 轮`)
    if (o.dryRun) {
      // 零 API 核对：对子状态还做一次确定性重放，确认仓库状态可达且尚未修好
      let replayed = 0, bad = []
      for (const j of jobs) if (j.state) { const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-dry-')); try { materialize(j.task, repo); for (const c of j.state.replay || []) execTool(j.task, repo, c.name, c.args); if (j.task.fixed(repo)) bad.push(j.state.id + ':already-fixed'); else replayed++ } catch (e) { bad.push(j.state.id + ':' + e.message) } finally { fs.rmSync(repo, { recursive: true, force: true }) } }
      console.log(`dry-run：任务 ${jobs.length}（${[...new Set(jobs.map((j) => j.state ? j.state.id : j.task.id))].length} 个起点 × ${o.variants.length} 臂 × ${o.samples} 样本）、组 ${groups.length}；子状态重放成功 ${replayed}${bad.length ? '，失败 ' + bad.length + '：' + bad.slice(0, 5).join(' ') : ''}${stop ? `；停止规则 α=${stop.alpha} 上界 $${stop.capUsd}` : ''}；未发任何请求`)
      fs.rmSync(d, { recursive: true, force: true }); return { dryRun: true, jobs: jobs.length, groups: groups.length, replayed, bad, reusedRaw: reused.length }
    }
    // v4.7.1 通道预检：没过就一条轨迹都不开（之前主循环会把「没有思维链」当路由黏住重试 ≤15 次，每次都是完整付费请求）
    const pf = await preflightUpstream({ chat, o })
    fs.appendFileSync(path.join(o.out, 'preflight.jsonl'), JSON.stringify(pf) + '\n')
    console.log(`通道预检 ${pf.ok ? '通过' : '失败'}：fp=${pf.fp}（${pf.mode || '无放行依据'}）思考 ${pf.reasoningChars} 字 / 正文 ${pf.contentChars} 字 / 型号回显 ${pf.modelEcho} / 携带 ${pf.carry ? (pf.carry.error ? '错误 ' + pf.carry.error : `Δ${pf.carry.delta} tokens / ${pf.carry.L} 字 = ${pf.carry.ratio}`) : '未量'} / ${pf.ms} ms${pf.error ? ' / 错误 ' + pf.error : ''}${pf.ok ? '' : ' / 未过：' + pf.failed.join(',')}`)
    if (!pf.ok) { fs.rmSync(d, { recursive: true, force: true }); throw new Error('preflight-failed:' + pf.failed.join(',') + '（通道现在不返回思维链 / 指纹不可信 / 型号不符 ⇒ 不开跑、不花钱）') }
    if (o.preflightOnly) { fs.rmSync(d, { recursive: true, force: true }); return { preflight: pf } }
    let i = 0
    await Promise.all(Array.from({ length: Math.min(o.concurrency, groups.length) }, async () => {
      while (i < groups.length) {
        const grp = groups[i++]
        let forkMessage = null, lead = null
        const pre = reused.find((x) => grp.some((j) => !j.state && j.task.id === x.task.id && j.sample === x.sample)); if (pre) lead = pre.lead
        for (const j of grp) {
        if (stopped) break
        const rec = await runOne({ o, task: j.task, variant: j.variant, sample: j.sample, chat, I, cred, forkMessage: j.resume || lead || j.extend ? null : forkMessage, state: j.state || null, resume: j.resume || null, leader: j.resume ? null : (j.extend ? j.extend.lead : lead), extend: j.extend ? { from: j.extend.from, file: j.extend.file, at: j.extend.at } : null })
        spent.usd += ((rec.mainCalls ?? rec.rounds ?? 0) - (j.resume?.rec?.mainCalls || 0)) * (plan?.cost?.pricing?.mainUsd ?? 0.0125) + (rec.compile || []).filter((c) => !c.belowFloor && c.path !== 'hand').length * (plan?.cost?.pricing?.compressUsd ?? 0.0075)   // hand 稿零成本；续跑只算本次新发的主调用
        if (o.fork && !forkMessage && rec.firstMessage) forkMessage = rec.firstMessage
        if (o.fork && !lead && rec.variant === 'raw' && rec._lead && !rec.error) lead = rec._lead   // 同组其余臂影子跟随 raw 直到分歧
        delete rec.firstMessage; delete rec._lead
        fs.appendFileSync(resPath, JSON.stringify(rec) + '\n')
        if (rec.status === 'awaiting-draft') { console.log(`  ${rec.task}/${rec.variant} #${rec.sample}: 等待手写稿（第 ${rec.awaiting.round} 轮）→ 读 ${rec.awaiting.pending}，写 ${rec.awaiting.draftFile}，再跑同一条命令` + (rec.awaiting.violations ? `；上一份稿被拒：${rec.awaiting.violations.map((v) => v.kind).join(', ')}` : '')); continue }
        console.log(`  ${rec.task}/${rec.variant} #${rec.sample}: ${rec.error ? 'ERR ' + rec.error : `${rec.fixed ? '修好@' + rec.fixedAtRound : '未修好'} · ${rec.rounds} 轮${rec.extended ? `（延长：前 ${rec.extended.from} 轮复用）` : rec.shadow ? `（影子 ${rec.shadow.rounds}，${rec.shadow.divergedAt ? '第 ' + rec.shadow.divergedAt + ' 轮分歧' : '未分歧=与 raw 全同'}）` : ''} · ${rec.calls} 调用 · edit ${rec.edits.length} · 重复 ${rec.repeats} · 验收 ${rec.verifiedAfterFix ? '●' : '·'} · 声明 ${rec.claim}${rec.claimJustified ? '' : '（不相称）'} · tokens ${rec.promptTokens}${rec.compile.length ? ' · 压稿 ' + rec.compile.filter((c) => c.ok).length + '/' + rec.compile.length : ''} · proxy ${rec.proxyScore ?? '—'}${rec.forked ? ' · 分叉' : ''}`}`)
        }
        // v4.3 有界续跑：一次批准内自动跑到判定或预算上界（e 值任意停时有效，提前停不损失保证）
        if (stop && !stopped) {
          const done = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error && r.status !== 'awaiting-draft')
          const cmp = stop.compare && stop.compare.champion !== stop.compare.previous ? outcomeComparison(done.map((r) => ({ ...r, arm: r.variant === stop.compare.champion ? 'champion' : r.variant === stop.compare.previous ? 'previous' : null, sample: `${r.fromState || r.task}#${r.sample ?? 0}` })).filter((r) => r.arm)) : null
          const thr = 1 / (stop.alpha || 0.1)
          if (cmp && cmp.pairs.length >= (stop.minPairs || 4) && (cmp.e >= thr || cmp.eReject >= thr)) stopped = `判定达成（${cmp.pairs.length} 对，e=${cmp.e} / 更差 e=${cmp.eReject} ≥ ${thr}）`
          else if (stop.capUsd && spent.usd >= stop.capUsd) stopped = `预算上界 $${stop.capUsd} 已到（估 $${spent.usd.toFixed(3)}）`
          if (stopped) console.log('提前停止：' + stopped)
        }
      }
    }))
    fs.rmSync(d, { recursive: true, force: true })
  }
  const all = fs.readFileSync(resPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = new Map(); for (const r of all) { const k = `${r.fromState || r.task}|${r.variant}|${r.sample}`; if (!last.has(k) || !r.error) last.set(k, r) }
  let md = summarizeTraj([...last.values()])
  const cont = [...last.values()].filter((r) => r.continuation); if (cont.length) md += `\n\n续跑探针（${cont.length} 条）：${cont.map((r) => `${r.fromState}/${r.variant}: ${r.continuation.verdict}（首轮 ${r.continuation.firstRoundCalls} 次调用、重做前缀 ${r.continuation.prefixRepeats}）`).join('；')}\n结论：${cont.every((r) => r.continuation.verdict === 'continued') ? '模型顺着前缀继续 —— 子状态可用' : cont.some((r) => r.continuation.verdict === 'restarted') ? '**有轨迹从头重来** —— 子状态口径存疑，先别扩到 14 个' : '不清楚（首轮无调用）'}`
  fs.writeFileSync(path.join(o.out, 'summary.md'), md + '\n')
  if (plan) { const rows = [...last.values()]; fs.writeFileSync(path.join(o.out, 'receipt.json'), JSON.stringify({ schema: 'cfb.traj-receipt/1', plan: plan.id, digest: plan.digest, at: new Date().toISOString(), trajectories: rows.length, errors: rows.filter((r) => r.error).length, awaiting: rows.filter((r) => r.status === 'awaiting-draft').length, mainCalls: rows.reduce((a, r) => a + (r.mainCalls ?? (r.shadow || r.reusedFrom ? 0 : r.rounds ?? 0)), 0), compressCalls: rows.reduce((a, r) => a + (r.compile || []).filter((c) => c.path === 'birth-offline').length, 0), handDrafts: rows.reduce((a, r) => a + (r.compile || []).filter((c) => c.path === 'hand').length, 0), shadowRounds: rows.reduce((a, r) => a + (r.shadow?.rounds || 0), 0), noContrastGroups: rows.filter((r) => r.shadow && !r.extended && r.shadow.divergedAt == null && r.status !== 'awaiting-draft').length, extended: rows.filter((r) => r.extended).length, reusedRaw: rows.filter((r) => r.reusedFrom).length, fpModes: rows.reduce((a, r) => { for (const [k, v] of Object.entries(r.fpModes || {})) a[k] = (a[k] || 0) + v; return a }, {}), preflights: fs.existsSync(path.join(o.out, 'preflight.jsonl')) ? fs.readFileSync(path.join(o.out, 'preflight.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0, promptTokens: rows.reduce((a, r) => a + (r.promptTokens || 0), 0), gateFails: rows.reduce((a, r) => a + (r.compile || []).filter((c) => c.gateFail).length, 0), completionTokens: rows.reduce((a, r) => a + (r.completionTokens || 0), 0), estimatedUsd: +rows.reduce((a, r) => a + (r.mainCalls || 0) * (plan.cost?.pricing?.mainUsd ?? 0.0125) + (r.compile || []).filter((c) => c.path === 'birth-offline').length * (plan.cost?.pricing?.compressUsd ?? 0.0075), 0).toFixed(3), stoppedEarly: stopped || null }, null, 2) + '\n') }
  console.log('\n' + md)
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
