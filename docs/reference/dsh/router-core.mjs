/**
 * router-core: reasoning-mode routing logic (zero dependencies).
 *
 * BEHAVIORAL REALITY (measured, 21-point × n=2 on v4-pro): model behavior
 * along the react↔spec axis collapses into THREE stable regions, not a
 * continuum — spec [0, 0.15], a transition band [0.2, 0.45] (unstable mix,
 * avoid), and react [0.5, 1.0] (11 mode values behave identically). The
 * numeric interface therefore maps onto three behavior bands; "continuous"
 * tuning is an illusion at the model layer.
 *
 * FOURTH MODE — weak (internal routing): P8/P11 show a weak-persona domain
 * where the model routes itself from the task (discrimination up to +5.0).
 * The optimal weak persona is model-specific (P11, n=3):
 *   - pro:   spec sentence + few-shot routing instruction (w6, +5.00)
 *   - flash: neutral + explicit "classify then act" instruction (w7, +5.67)
 *   - spec-sentence weak personas ANTI-route on flash (planGreen > 0).
 *
 *   mode 0    → pure spec  — plan-first, collective, read-first tools
 *   mode 0.3  → mixed      — transition band (trap; only explicit opt-in)
 *   mode 1    → pure react — doer, produce-verify-fix, test-suppressed
 *   mode W    → weak       — internal routing (model decides per task)
 *
 * `mode` is stored as a number in [0, 1] or the string 'weak'; band mapping
 * quantizes to the four modes.
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** Weak (internal-routing) personas — model-specific optimum (P11/P24).
 *  pro:   spec sentence + classify instruction (w6c, +4.67, P24) — the
 *         few-shot variants and the recall/converge anchors HURT Pro
 *         (P24: suite-full 83% < naked 87.5% vs +guide 100%)
 *  flash: neutral + classify + recall/converge/anti-runaway anchors
 *         (w7, +5.67, P11; anchors lift single-task completion to 100%, P23)
 */
const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

/** Complexity heuristic: long or architecturally-worded tasks are COMPLEX.
 *  Simple tasks get fast-convergence guidance; complex tasks get deep
 *  exploration guidance (depth-adaptive, v19). */
const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

/**
 * Task-type classifier for the A1 detail layer (tree structure):
 * universal layer = RL_GUIDE (all tasks); detail layer = task-type-specific
 * practices injected for every confidently matched type.
 * Returns an ARRAY of types in fixed order solve → visual → exec → info
 * (one task may span several domains — e.g. "render + install + report");
 * empty array = universal layer only. A hard keyword (re) decides a type
 * immediately; otherwise 2+ soft hits are required (conservative — a wrong
 * detail injection pollutes more than no injection).
 */
const TYPE_RULES = [
  // v3.6.1: 收紧通用词——"算法"降为 solve 软信号（渲染任务也提"核心算法"），
  // "装"裸字(拼装/组装)与"环境"(场景/氛围)移出 exec，"原因"(排查动词)/"内容"移出 info。
  { type: 'solve', re: /(judge|contest|竞赛|解题|刷题|测评|题解|判题|submission|accepted|样例|复杂度|OI\b)/i, soft: /\b(?:sample|solution|WA|TLE|AC)\b|超时|评测|验证码|算法/i },
  { type: 'visual', re: /(webgl|three\.?js|render|渲染|截图|画面|材质|光照|shader|bloom|3d|3D|场景|像素|watch|poolroom|黑洞|动画|图形|滤镜|特效|第一人称|游戏|网页|页面|svg|SVG|(?<![\w-])html(?![\w-]))/i, soft: /\b(?:canvas|screenshot|visual|ui)\b|视觉|美观|精美|漂亮|酷炫/i },
  { type: 'exec', re: /(安装|卸载|配置|插件|下载|升级|重装|部署|环境变量|开发环境|npm|pip|install|setup|修复|排查|启用)/i, soft: /\b(?:command|run|start|service|process|error)\b|命令|运行|启动|服务|进程|报错|挂死/i },
  { type: 'info', re: /(搜索|调研|资料|文档|介绍|是什么|怎么用|多少钱|价格|对比|新闻|为什么|区别|叫什么|哪些|如何|报告|(?<!排)查一下|查查|查询|在哪|在哪儿|在哪里)/i, soft: /\b(?:report|search|how|what|why)\b|找|哪里|哪个/i },
]

export function classifyTaskTypes(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const types = []
  for (const rule of TYPE_RULES) {
    const softCount = (text.match(new RegExp(rule.soft.source, 'gi')) || []).length
    if (rule.re.test(text) || softCount >= 2) {
      types.push(rule.type)
    }
  }
  return types
}

/** Primary task type (first match) — convenience for logging/display. */
export function classifyTaskType(text) {
  return classifyTaskTypes(text)[0] ?? null
}

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Quantize a mode to one of the four measured behavior bands. */
export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec' // measured stable spec region (0..0.15)
  if (m < 0.5) return 'transition' // measured unstable band — avoid
  return 'react' // measured stable react region (0.5..1 behave alike)
}

/** Persona for a mode; weak picks the model-specific internal-routing text. */
export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

/** First-turn core tools (shell added dynamically by the plugin).
 *  v0.2.0: the weak (internal-routing) band gets the RL-shape surface —
 *  shell + str_replace_editor — per the interface-restoration measurement
 *  (100% action at 18–29K reasoning chars vs ~25% / 73–101K on the
 *  read/write/edit surface, official API, 2026-08-15). */
export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep'] // read-first
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep'] // union
    case 'weak': return ['str_replace_editor'] // RL shape: shell + editor
    default: return ['read', 'write', 'edit'] // write-first
  }
}

/** Human-readable band name for a mode value. */
export function bandFor(mode) {
  const b = bandOf(mode)
  return b === 'transition' ? 'mixed' : b
}

/** Test-suppression strength for a mode (informational). */
/** Test-suppression strength for a mode (informational). */
export function testinessFor(mode) {
  switch (bandOf(mode)) {
    case 'react': return 'suppressed'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

/**
 * Classify a task text into a mode. Clear keyword evidence picks a stable
 * band (1 react / 0 spec); AMBIGUOUS or unmatched text returns 'weak' —
 * the internal-routing mode, where the model decides per task (P11 optimum).
 */
export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

/** Per-session mode derived from durable events (resume-safe). */
export function sessionMode(session) {
  const events = session.events
  const userMsg = events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

export function extractText(data) {
  if (!data) return ''
  // 防御性解包：插件/工具生成的 user/message 偶有 `data.message` 嵌套形状
  // （如注入器 startIngest 的 seed），直接读 data.content 会得到空串 →
  // 构建/修复任务被误判 weak（router-standard issue #1）。
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

/**
 * Replace only the persona section of an assembled section list, keeping
 * everything else — the plan-mode section above all, which is toggled per
 * plan state and carries the plan-boundary instructions.
 */
export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

/** Parse a user/agent-supplied mode token: number 0-100, 0.0-1.0, or a band name. */
export function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router') return 'weak'
  if (t === 'spec' || t === 'spec-lean') return 0
  if (t === 'balanced' || t === 'mixed') return 0.3 // transition-band center
  if (t === 'react' || t === 'react-lean') return 1
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}
