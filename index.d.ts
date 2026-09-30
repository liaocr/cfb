// dsh-cot-form-b —— 类型契约
//
// ⚠ 本包是 ESM JavaScript（`"type": "module"`），Node 直接加载 `index.js`。
//    项目当前没有 TypeScript 构建链（无 tsconfig、无 typescript 依赖），
//    因此这里用 `.d.ts` 只做「对外契约声明」，不参与运行。
//    若将来引入 tsc，可直接由本文件约束实现。

/** Cordis 插件名 */
export declare const name: 'cot-form-b'

/** 本插件不依赖任何服务 */
export declare const inject: []

export interface CotFormBConfig {
  /** 总开关。false = 完全不介入（回滚用）。默认 true */
  enabled?: boolean
  /**
   * true = 只观测、只写 trace：birth 模式下零副模型调用、零改写。灰度观察用。默认 true
   *
   * 回滚优先级：① dryRun=true → ② mode='off' → ③ enabled=false → ④ 摘掉插件
   */
  dryRun?: boolean

  /**
   * 模式（缺省 'birth'）：
   *   'birth'      出生即压缩（唯一生产路径）：llm/stream 里扣住 reasoning，CAS 归档 + 副模型压缩后放行
   *   'off'        完全不介入，原样放行
   * ⛔ 'distill' / 'rules'（v11.8）与 'checkpoint'（v12.1）已退役：写回路径协议上永久非法；传入时按 'off' 处理，
   *    并由 normalizeConfig 记入 retiredMode（BOOT 可见）。不认识的值同样按 'off'（记入 invalidMode）。
   */
  mode?: 'birth' | 'off' | 'distill' | 'rules' | 'checkpoint'

  /**
   * compress 提示词版本（v12.1 起 compress 是唯一编译模式）：'v3'（缺省）= 保真规则 + 绝对长度目标；
   * 'v2' = 同一套保真规则 + 相对长度目标（20%~35%）。'x1'（v12.0）与 'v1' legacy 蒸馏（v12.1）已退役，
   * 出现时按 'v3' 处理并记入 configAdjusted。
   * 'v4'（v12.2，opt-in）= compress-v4-ops：副模型只输出结构化标注（JSON ops），出生文本由 compile-v4.js 用代码写出。
   */
  compressPrompt?: 'v2' | 'v3' | 'v4'
  /** 仅 v3 生效：绝对长度目标下限（字符，缺省 250） */
  compressTargetMin?: number
  /** 仅 v3 生效：绝对长度目标上限（字符，缺省 450）；v4 未设 compressV4BudgetChars 时也用它作渲染预算 */
  compressTargetMax?: number
  /** 仅 v4：渲染预算（字符）。null ⇒ 跟随 compressTargetMax。当前方案 / 证伪路 / 未决问题为必留，不受预算限制 */
  compressV4BudgetChars?: number | null
  /** 仅 v4：副模型输出上限（缺省 1600）；实际取 max(maxOutputTokens, 本项) */
  compressV4MaxOutputTokens?: number
  /** 仅 v4：尾段（结论 + 未决问句），缺省 true */
  compressV4Tail?: boolean
  /** 仅 v4：硬不变量拒绝占比超过它 ⇒ 整块原文（缺省 0.5） */
  compressV4MaxRejectRatio?: number
  /** 仅 v4（v12.3）：流式增量编译 —— 思考还在写时按段起飞副模型调用，收网只等最后一段；来不及 ⇒ 已编译前缀 + 原文尾巴。缺省 true */
  compressV4Incremental?: boolean | 'auto'
  /** 仅 v4 增量：非尾段超过这么久没结果就对冲一份（缺省 7000；0 关） */
  compressV4SegmentHedgeMs?: number
  /** 仅 v4 增量：同时在飞的段数上限（缺省 3） */
  compressV4MaxInFlight?: number
  /** 仅 v4（v12.5）：副模型漏标判读 / 改法时由代码把原文句子逐字补成 IF / READY（缺省 true） */
  compressV4AutoHints?: boolean
  compressV4Loci?: boolean
  compressV4Prose?: boolean
  /** 仅 v4（v12.6，理论 S8-R6）：副模型直写原生语域散文（oracle C 形态），不经 ops→模板；缺省 true（v12.8.8 转正；false = 回到 ops→散文路） */
  compressV4Direct?: boolean
  /** 仅 v4 直写（v12.7，理论 S8-R7）：尾段判读分支的闭合与落点绑定（改法分支必须带已核真的逐字落点 + 分支内可用句）；缺省 true */
  compressV4DirectBind?: boolean
  /** 仅 v4 直写：超过此长度熔断为原文放行（缺省 2000；v12.7.1 起 1600、v12.8.6 起 1800、v12.8.9 起 2000——完整闭合稿 1600–1950 字，熔断只拦「跑飞」照抄原文） */
  compressV4DirectMaxChars?: number
  /** 仅 v4 直写：整块编译 ⇒ 收网窗口 birthFinishWaitMs 只抬不降到此下限（缺省 6000；0 = 不抬），BOOT configAdjusted 留痕 */
  compressV4DirectMinWaitMs?: number
  /** 仅 v4 直写：当前任务 / 观察上下文（工具注入；生产缺省由 plugin 自动构造，见 compressCtxAuto） */
  compressCtx?: string
  /** v12.7：v4 时自动从出站消息构造 compressCtx（最后一条人类 user + 本回合工具结果）；缺省 true */
  compressCtxAuto?: boolean
  /** 仅 v4 直写：宿主的编辑工具名与参数名（缺省由 plugin 从出站 tools 认出） */
  compressEditTool?: { name: string, oldKey?: string, newKey?: string } | null
  /** 自动 compressCtx 的总预算（字符，缺省 8000） */
  compressCtxMaxChars?: number
  /** 仅工具用：meta.sideOutput 带回副模型原始输出（缺省 false） */
  captureSideOutput?: boolean
  /** 默认关：发布宿主证据程序侧车；不自动接管 DSH decision/工具/上下文 */
  evidenceProgram?: boolean
  /** 仅 v4 增量：目标段长（字符，缺省 1200；在段落 / 行 / 句末处切，0.6–1.5 倍浮动） */
  compressV4SegmentChars?: number
  /** 仅 v4 增量：非尾段的请求超时（缺省 30000；尾段仍用 timeoutMs） */
  compressV4SegmentTimeoutMs?: number
  /** 仅 v4 增量：每段副模型输出上限（缺省 1200） */
  compressV4SegmentMaxOutputTokens?: number
  /** 仅 v4 增量：首段目标长度（null ⇒ 段长一半） */
  compressV4FirstSegmentChars?: number | null
  /** 仅 v4 增量：尾段走流式（响应头宽限才能生效；多等最多 finishHeadersGraceMs），缺省 false */
  compressV4TailStream?: boolean
  /** v11.7（opt-in，缺省 false）：把 v2/v3 压缩提示词的固定规则前缀放进 system 消息、原文放 user 消息（字节等价），让 DeepSeek Context Caching 命中规则前缀；打开后 promptVersion 追加 ':sys' */
  compressSystemPrompt?: boolean
  birthCancelOnGiveUp?: boolean
  birthDiskWaitMs?: number
  distillStream?: boolean
  /** finish 处收网等待上限（ms，缺省 1500）。birth 下 timeoutMs 至少会被抬到 本值 + finishHeadersGraceMs + 2000 */
  birthFinishWaitMs?: number
  /** v11.6 默认 3100（R=60 自洽保本原长 2,747，保守取整且不下调；见 docs/analysis/AUDIT-V11.5.md §一）。 */
  birthMinChars?: number
  /** v11.6 成本模型观测参数（只影响 birth-econ trace，不参与判定）。 */
  econCacheDiscount?: number
  econTemplateChars?: number
  /** R 回落值（取不到每轮增量时用）。默认 60（2026-09-24 用户拍板） */
  econR?: number
  econCharsPerTurn?: number | null
  birthArchive?: boolean
  /** v12.1 发明标识符闸（缺省 true）：摘要含原文没有的路径 / URL / 反引号代码 / camelCase / snake_case / file.ext ⇒ 原文放行（why=invented-identifier） */
  birthIdentifierGate?: boolean
  birthArchiveTimeoutMs?: number
  /** P0-2：内存预推句柄（deriveArtHandle）的读回验证限时（ms，缺省 800）。超时=不可证 ⇒ 原文放行 */
  birthHandleProbeTimeoutMs?: number
  birthMinSavedChars?: number
  /**
   * @deprecated v11.10 退役：2026-09-18 起句柄绝不进模型可见文本，本键早已无任何效果。
   * 配置里出现时进 BOOT 的 retiredOptions，并从生效配置中删除。
   */
  birthHandleInText?: boolean
  /** v11.10（opt-in）：正数 ⇒ 按 token 估算判定「值得压缩」，完全接管 birthMinChars。缺省 null（仍按字符） */
  birthMinTokens?: number | null
  /** v11.10 token 闸门（缺省 true）：字符净省达标但估算 token 净省 < max(1, birthMinSavedTokens) ⇒ 原文放行（why=no-token-gain） */
  birthTokenGate?: boolean
  /** v11.10：token 闸门的最小估算净省（缺省 0 ⇒ 按 1 计，即「token 必须真的变少」） */
  birthMinSavedTokens?: number
  /** v11.10：trace.log 轮转阈值（字节，缺省 64 MiB；0 = 不轮转）。超限改名 trace.log.1 */
  traceMaxBytes?: number
  /** v11.10：llm-stream 溯源里用户原话开头片段长度（缺省 48；0 = 不记录任何正文片段） */
  tracePreviewChars?: number
  /**
   * v11.11：流归属不可证（多个会话交错进入 agent/pre-step，无法判定这条 llm/stream 属于谁）时的处置。
   * 'passthrough'（缺省）= 原文放行、不归档不压缩；'latest' = v11.10 行为（按最近一次 pre-step 的会话）。
   * 非法值回到 'passthrough' 并进 configAdjusted。两种都留 birth-session-ambiguous trace。
   */
  birthSessionAmbiguity?: 'passthrough' | 'latest'
  /** CAS 归档 producer 名。默认 'cot-birth' */
  birthProducer?: string
  /** v11.7：birth finish 处 budget 到点但蒸馏已收到 200 响应头（正在生成）时再多等的上限（ms，缺省 1500；0 关） */
  finishHeadersGraceMs?: number
  birth?: {
    minChars?: number; archive?: boolean
    /** @deprecated v11.10 退役（见 birthHandleInText） */
    handleInText?: boolean
    producer?: string
    archiveTimeoutMs?: number; probeTimeoutMs?: number; finishWaitMs?: number; minSavedChars?: number
    finishHeadersGraceMs?: number
    /** = birthMinTokens / birthTokenGate / birthMinSavedTokens */
    minTokens?: number | null; tokenGate?: boolean; minSavedTokens?: number
    /** = birthSessionAmbiguity */
    sessionAmbiguity?: 'passthrough' | 'latest'
    identifierGate?: boolean
  }
  followHostProvider?: boolean
  followProvider?: string
  settingsPath?: string

  /** 以下四项由 normalizeConfig 填入（调用方不应手填），BOOT 上报 */
  /** 不认识的键（含嵌套容器里拼错的键，形如 'birth.finishWait'） */
  unknownOptions?: string[]
  /** 已退役、已从生效配置里删除的键（v7 四个旧开关 + v11.8 随 distill/rules 退役的键，含 'rules' 容器） */
  retiredOptions?: string[]
  /** 配置里写了已退役模式（'distill' | 'rules' | 'checkpoint'）时记录原值；生效 mode 为 'off' */
  retiredMode?: 'distill' | 'rules' | 'checkpoint'
  /** 配置里写了不认识的 mode 时记录原值；生效 mode 为 'off' */
  invalidMode?: unknown
  /** 自动调整留痕：timeoutMs 抬高、退役的 compressPrompt 值回落 'v3'、stateMemory:true（memory 模式已删除） */
  configAdjusted?: {
    timeoutMs?: { from: number; to: number; why: string }
    compressPrompt?: { from: unknown; to: 'v3'; why: string }
    stateMemory?: { from: 'memory'; to: 'compress'; why: string }
  }

  /** 副模型单次请求硬超时。默认 8000；birth 下可能被自动抬高（见 configAdjusted） */
  timeoutMs?: number
  maxAttempts?: number
  /** v11.7 对冲请求：主请求 N ms 内未收到 200 响应头就再发一份相同请求，先回头者胜、另一份 abort。0 = 关（缺省）；建议 ≥ TTFB p50（3000）；仅 maxAttempts ≤ 1 时生效 */
  hedgeAfterMs?: number
  /** v11.6 默认 850，恒定；不随输入放大。 */
  maxOutputTokens?: number

  /**
   * ── 传输层（杠杆 3：连接复用 + 预热）────────────────────────────────────
   * 实测（本机 → 当时使用的商户端点）：冷连接 TTFB 676ms，复用连接 265ms ⇒ 单次省 411ms。
   * ⚠ 进程内**第一次**调用永远是冷的；要让它也温热必须开 `prewarm`。
   */
  keepAlive?: boolean
  keepAliveMsecs?: number
  /** 启动 / 每步之前用一次 HEAD 把 TLS 通道捂热。零 token（不产生 completion）。默认 false */
  prewarm?: boolean
  /** 两次预热的最小间隔（ms）。默认 20000 */
  prewarmMinGapMs?: number

  /** 伴生调用：通道 */
  baseUrl?: string
  /**
   * 伴生调用：模型。
   *
   * ★ 2026-09-15 用户拍板：**跟随宿主对话模型**。默认 `''`（不指定）。
   *   `followHostModel: true` 时，本字段在运行期会被 `llm/stream` 里读到的
   *   宿主对话模型覆盖；若配了显式模型名，它只作为「还没见过宿主模型」时的兜底。
   *   ⛔ 不要往这里写死从商户目录里挑的模型名 —— 那些名字身份不可核实。
   */
  model?: string
  /**
   * ★ 是否跟随宿主对话模型（`llm/stream` 的 `options.model`）。默认 true。
   *
   * 用户原话：「宿主用哪个模型对话，我们就用那个模型压缩。」
   * 读不到宿主模型且 `model` 为空 ⇒ **不猜**，放弃提纯、原文放行（原因落 trace）。
   */
  followHostModel?: boolean
  /**
   * ★★ 关掉模型的「思考」（`thinking: {type:'disabled'}`）。默认 true，**别关这个开关**。
   *
   * 实测（真实 CoT，max_tokens 1200，2026-09-15）：宿主对话模型是思考型，
   * 不关思考 ⇒ 整个 max_tokens 烧在 `reasoning_content` 上，`content` 返回空串、
   * `finish_reason='length'` ⇒ 提纯失败 + 白花一次调用 + 白等 7~19 秒。
   *
   *   基线（不关）              6,952ms  finish=length  content 0  reasoning 3,453
   *   reasoning_effort='none'   5,048ms  finish=stop    content 612  reasoning 1,591
   *   thinking={type:'disabled'} 3,746ms finish=stop    content 401  reasoning 0   ← 采用
   *   enable_thinking=false     6,652ms  finish=length  content 0  reasoning 3,399
   *   chat_template_kwargs      7,123ms  finish=length  content 0  reasoning 4,260
   *
   * 被网关 4xx 拒掉时会**免费裸试一次**（4xx 不消耗 token），所以开启它不会把路走死。
   */
  disableThinking?: boolean
  /** 伴生调用：凭据键名（在 credentialsPath 里查） */
  credentialRef?: string
  /** 伴生调用：凭据文件 */
  credentialsPath?: string

  /** 观测：trace 文件路径；null 表示不落盘 */
  traceFile?: string
  trace?: boolean
}

export declare const DEFAULTS: Readonly<CotFormBConfig>

/** 依赖模块指纹（BOOT 自证上岗用）：`file=size@mtimeMs ...`，覆盖全部本地依赖模块 */
export declare const DEP_ID: string

/**
 * 按键名从 credentials 文件取钥匙。
 * ⛔ 行首锚定 + 键名转义 + 剥引号：防止 `MY_DEEPSEEK_API_KEY` 被 `DEEPSEEK_API_KEY` 子串误命中。
 */
export declare function readApiKey(cfg: Pick<CotFormBConfig, 'credentialRef' | 'credentialsPath'>): string

/**
 * 配置归一化：同时接受扁平键与嵌套写法（`distill: {...}` / `birth: {...}`）。
 * 嵌套键覆盖同名扁平键；退役模式 / 非法 `mode` 按 `'off'` 处理（绝不猜成会改写会话的模式）；
 * 退役键进 retiredOptions、未知键进 unknownOptions（都只报不抛）。
 */
export declare function normalizeConfig(config?: CotFormBConfig): CotFormBConfig
/** 重试退避（纯函数）：非瞬时错误返回 null（不重试），否则返回带抖动的毫秒数 */
export declare function retryDelayMs(e: unknown, attempt: number, rand?: () => number): number | null
/** compress 提示词版本唯一裁决点（BOOT / 每次编译 / trace 共用） */
export declare function compressPromptVersion(cfg: CotFormBConfig | null | undefined): string
/** 按 cfg 选压缩提示词（只有显式 'v2' 走 v2，其余一律 v3） */
export declare function compressPromptFor(cfg: CotFormBConfig | null | undefined, cot: string): string
/** v3 的绝对长度目标（字符）；非法输入回落缺省，保证 min < max */
export declare function compressTargets(cfg: CotFormBConfig | null | undefined): { min: number; max: number }
/** compress-v2 中性压缩提示词（相对长度目标 20%~35%） */
export declare function buildCompressPrompt(cot: string): string
/** compress-v3：v2 的保真规则 + 绝对长度目标 */
export declare function buildCompressPromptV3(cot: string, minChars?: number, maxChars?: number): string
/** compress-v4-ops：副模型只做结构化标注（JSON ops）的提示词 */
export declare function buildCompressPromptV4(cot: string): string
/** v12.4：从原文摘出「改法措辞 + 具体对象」的句子（逐字，最后 max 条），附在压缩提示词里供副模型核对 */
export declare function fixHints(text: string, max?: number): string[]
/** v12.5：从原文摘出条件判读句（若 A 则/就/说明 B），附在压缩提示词里供副模型标 IF */
export declare function condHints(text: string, max?: number): string[]
/** v4 提示词在内容之后的重申段（防副模型替 Agent 答题） */
export declare const V4_TAIL: string
/** v4 渲染预算（字符）：compressV4BudgetChars，未设则 compressTargetMax */
export declare function v4Budget(cfg: CotFormBConfig | null | undefined): number
/** v4 流式增量编译是否开启：true / false 强制；'auto'（缺省）= 收网窗口 birthFinishWaitMs < 5000 时增量，否则整块 */
export declare function v4Incremental(cfg: CotFormBConfig | null | undefined): boolean
/** 增量目标段长（字符） */
export declare function v4SegmentChars(cfg: CotFormBConfig | null | undefined): number
/** 分段提示词：规则前缀与整块 v4 逐字相同；priorLines 为空时与 buildCompressPromptV4(seg) 完全相同 */
export declare function buildCompressPromptV4Segment(seg: string, priorLines?: string[]): string

// ── compress-v4-ops 编译器（src/compile-v4.js，纯函数） ──
export type V4Kind = 'FACT' | 'COMPUTED' | 'INCUMBENT' | 'REFUTED' | 'SHELVED' | 'OPEN' | 'PLAN' | 'READY' | 'IF'
export type V4Ev = 'tool' | 'derived' | 'guess'
export type V4Kind2 = 'pivot' | 'plan' | 'hypothesize' | 'localize' | 'inspect' | 'compute' | 'verify' | 'restate' | 'answer'
export declare const V4_KINDS: V4Kind[]
export declare const V4_EVS: V4Ev[]
export declare const V4_KIND2: V4Kind2[]
/** 归一化后的条目（idx = 在副模型输出中的原始位置） */
export interface V4Op {
  id: string; idx: number; k: V4Kind | string; ev: V4Ev; kind2: V4Kind2 | null
  text: string; anchor: string; key: string; src: string; alt: string; why: string; trigger: string; supersedes: string; deps: string[]
  /** v12.3：本条推翻的此前条目 id（可跨段，如 's1.o2'）；被推翻的条目在合并时移除 */
  retracts?: string[]
}
export interface V4Stats {
  outputChars: number; ops?: number; valid?: number; rejected?: Record<string, number>; converted?: number
  inventedSample?: string[]; selected?: number; kinds?: Record<string, number>
  dropped?: { restate: number; verify: number; budget: number }; lang?: 'zh' | 'en'; budget?: number; chars?: number
  /** v12.3 增量：原文尾巴字符数 / 已编译段数 / 总段数 / 是否部分结果 */
  rawSuffixChars?: number; compiledSegments?: number; segments?: number; incremental?: boolean; partial?: boolean
  rawGapChars?: number; gapSegments?: number; stale?: { demotedIncumbent: number; droppedOpen: number }
}
/** 容错解析副模型输出（{ops:[…]} / 裸数组 / 围栏 / 前后废话 / JSON Lines） */
export declare function parseOps(output: string): { ops: Record<string, unknown>[] } | { error: string }
export declare function normalizeOp(o: Record<string, unknown>, i: number): V4Op
/** 硬不变量 I1–I5、I7、I8；fatal 非空 ⇒ 整块回退原文 */
export declare function validateOps(ops: unknown[], raw: string): {
  kept: V4Op[]; rejected: { id: string; k: string; rule: string; sample?: string[] }[]
  converted: { id: string; from: string; to: string }[]; fatal: string | null; total: number
}
export declare function scoreOp(op: V4Op, depCount?: number): number
export declare function selectOps(ops: V4Op[], opts?: { budget?: number; lang?: 'zh' | 'en' }): { chosen: V4Op[]; dropped: { restate: number; verify: number; budget: number } }
export declare function renderLine(op: V4Op, lang?: 'zh' | 'en'): string
export declare function renderOps(chosen: V4Op[], opts?: { lang?: 'zh' | 'en'; tail?: boolean }): string
export declare function renderLang(raw: string): 'zh' | 'en'
/** 副模型输出 + 原文 ⇒ 出生文本；失败返回 ok:false（调用方原文放行） */
export declare function compileV4(output: string, raw: string, cfg?: CotFormBConfig, budget?: number | null):
  { ok: true; text: string; stats: V4Stats } | { ok: false; reason: string; stats: V4Stats }
/** 已解析条目 ⇒ 出生文本；rawSuffix ⇒ 不出尾段、逐字接原文尾巴；rawPrefix ⇒ 原文空洞放最前；segmented ⇒ 状态后写者胜 */
export declare function locusFromRaw(raw: string, text: string): string
export declare function compileOpsV4(rawOps: unknown[], raw: string, cfg?: CotFormBConfig, budget?: number | null, stats?: V4Stats, opts?: { rawSuffix?: string; rawPrefix?: string; segmented?: boolean }):
  { ok: true; text: string; stats: V4Stats } | { ok: false; reason: string; stats: V4Stats }
/** 拒绝占比（dup / I7 / retracted 不计入） */
export declare function v4RejectRatioOf(v: { rejected: { rule: string }[]; total: number }): number
/** 多段条目合并：id 加 's{n}.' 前缀，段内 deps / retracts 同步加前缀，跨段引用原样保留 */
export declare function mergeSegmentOps(segs: { n: number; ops: unknown[] }[]): Record<string, unknown>[]
/** supersedes 是条目 id 列表（'s3.o11' / 'o1, o2'）⇒ 返回 id 数组（按 retracts 处理）；否则 null */
export declare function supersedesIds(v: unknown): string[] | null
/** 状态后写者胜：只有最后一个含 INCUMBENT / OPEN 的段的这两类算当前；更早的 INCUMBENT 降为 COMPUTED、OPEN 丢弃（被依赖的除外） */
export declare function freshenState(kept: V4Op[], stats?: V4Stats): V4Op[]
/** 给后段提示词的「此前已标注」行（最多 max 条，取最近的） */
export declare function priorLines(kept: V4Op[], max?: number): string[]

// ── v12.3 流式增量编译（src/segment-v4.js） ──
/** text[minAt, to) 内最后一个切点（空行 > 换行 > 句末）；没有 ⇒ -1 */
export declare function findCut(text: string, from: number, minAt: number, to: number): number
/** text[from, to) 内第一个切点（换行或句末之后）；没有 ⇒ -1 */
export declare function findFirstCut(text: string, from: number, to: number): number
export interface V4SegmentState {
  n: number; start: number; end: number; text: string; status: 'pending' | 'ok' | 'failed'
  ops: Record<string, unknown>[] | null; kept: V4Op[]; reason: string | null; ms: number | null
}
export type V4SegmentCompile = (segText: string, priorLines: string[], signal: AbortSignal,
  opts: { onHeaders?: (info: { status: number; ttfbMs: number }) => void; trace?: (tag: string, data: object) => void; tail?: boolean }) => Promise<{ ops: unknown[]; meta?: Record<string, unknown> }>
export interface V4Segmenter {
  /** 每个 reasoning-delta 调用一次，传当前累积全文 */
  feed(text: string): void
  /** block-end：送出最后一段，等全部段落定，合并；有失败段 ⇒ 连续成功前缀 + 原文尾巴；一段都没成 ⇒ reject */
  finish(raw: string, signal?: AbortSignal, opts?: { onHeaders?: (info: { status: number; ttfbMs: number }) => void; v4Budget?: number }): Promise<{ text: string; meta: Record<string, unknown> }>
  /** 同步取「已编译前缀 + 原文尾巴」；没有可用前缀 ⇒ null */
  partial(raw: string, budget?: number): { text: string; partial: boolean; stats: V4Stats } | null
  /** 取消全部在飞的段 */
  cancel(why?: string): void
  readonly segments: V4SegmentState[]
}
export declare function createSegmenter(opts: { cfg: CotFormBConfig; compileSegment: V4SegmentCompile; trace?: (tag: string, data: object) => void; index?: number }): V4Segmenter

/** content 双兼容：纯字符串 或 [{type:'text',text}] 块数组 */
export declare function textOfContent(content: unknown): string

/** 取一条 assistant 消息里的 reasoning 文本（多块拼接） */
export declare function reasoningTextOf(message: unknown): string
export declare function artRefsOf(msgs: unknown): { handles: number; handleLines: number; toolCalls: number; retrieved: number }

/** 一次请求的传输层证据（直接落 trace） */
export interface RequestMeta {
  /** 是否复用了已有 socket（node:https 的 req.reusedSocket） */
  reused: boolean | null
  /** 从发起到 TLS 握手完成（复用时为 ~0） */
  connectMs: number | null
  /** 从发起到首字节 */
  ttfbMs: number | null
  status: number | null
  bytes: number | null
}

/** 单次 HTTP(S) 请求，不做重试。cfg 为空则不使用持久连接。 */
export declare function requestOnce(
  urlStr: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: string | null
    timeoutMs?: number
    cfg?: CotFormBConfig | null
  },
): Promise<{ status: number; text: string; meta: RequestMeta }>

/** 提纯调用的完整证据 = 传输层 + 模型层 */
export interface DistillMeta extends RequestMeta {
  /** 模型侧 finish_reason（'length' 是「思考把 max_tokens 吃光」的招牌） */
  finish?: string
  /** `reasoning_content` 的字符数；非 0 说明思考没关掉 */
  reasoningChars?: number
  /** 本次是否带了 `thinking:{type:'disabled'}` */
  thinkingOff?: boolean
  /** 本次实际用的模型（followHostModel 下应等于宿主对话模型） */
  model?: string
}

/**
 * 发起一次副模型调用（压缩 / 蒸馏共用的传输、重试、对冲、超时与取消）。返回 { text, meta }。
 *
 * ⛔ `cfg.model` 为空时**直接抛错**（`no model: ...`），绝不猜模型名 ——
 *    上层据此原文放行。这是「跟随宿主模型」的执行机构。
 * @param promptOverride 自定义提示词（不传 = compressPromptFor(cfg, cot)）
 * @param runtime        { trace, promptVersion }：传输 trace 与版本号贯通
 */
export declare function generateDistillation(
  cot: string,
  cfg: CotFormBConfig,
  signal?: AbortSignal,
  promptOverride?: string,
  runtime?: { trace?: (tag: string, data: object) => void; promptVersion?: string; [k: string]: unknown },
): Promise<{ text: string; meta: DistillMeta }>

/** Cordis 插件入口 */
export declare function apply(ctx: unknown, config?: CotFormBConfig): void

/** v11.6 成本模型（纯函数，只用于观测与自测）。见 docs/analysis/AUDIT-V11.5.md §一。 */
/** v11.7：把 v2/v3 压缩提示词拆成 { system, user }，满足 system + '\n\n' + user === prompt；无 marker 返回 null */
export declare function splitCompressPrompt(prompt: string): { system: string; user: string } | null
export declare function birthEconomics(
  B: number,
  pressure: { usedTokens?: number; contextWindow?: number; source?: string } | null,
  cfg?: { econCacheDiscount?: number; econTemplateChars?: number; econR?: number; econCharsPerTurn?: number; compressTargetMax?: number },
): { B: number; R: number; rSource: string; remainingTokens: number | null; d: number; T: number; rhoMax: number; bAbs: number; bMin: number | null; netAtTarget: number; verdict: 'below-abs' | 'below-min' | 'ok' } | null

// ── v11.10 ──────────────────────────────────────────────────────────────────
/** 按书写系统区分的 token 粗估（DeepSeek 官方口径：中文 0.6/字、其余 0.3/字）。估算，不是分词器读数，更不是钱。 */
export declare function estimateTokens(text: string): number
/** 宽字符（CJK）占比 0~1，trace 画像用。 */
export declare function wideShare(text: string): number
/** birth 编译器工厂：构造 deps.distill(input, signal, budget)（compress-only）。 */
export declare function makeBirthCompiler(
  cfg: CotFormBConfig,
): (input: unknown, signal?: AbortSignal, budget?: { onHeaders?: (info: { status: number; ttfbMs: number }) => void; trace?: (tag: string, data: object) => void; [k: string]: unknown }) => Promise<{ text: string; meta: Record<string, unknown> }>
/** v12.3 分段编译器工厂：同一模型关思考，promptVersion 加 ':seg' */
export declare function makeV4SegmentCompiler(cfg: CotFormBConfig): V4SegmentCompile
/** 取消一个 birth 任务仍在飞的提纯（已落地的结果绝不取消）。返回是否真的取消了。 */
export declare function birthCancelFlying(task: unknown, cfg?: CotFormBConfig, trace?: (tag: string, data: object) => void, why?: string): boolean
/** 此刻物理水位（tokenMeter 优先，其次 surfaceChars/4 估算），供 birth-econ 观测。 */
export declare function readPressure(deps: { session?: unknown; ctx?: unknown; surfaceChars?: number }): { usedTokens: number | undefined; contextWindow: number | undefined; source: 'meter' | 'estimated' | 'none' }
/** v12.1 发明标识符闸：返回摘要里原文没有的路径 / URL / 代码标识符（最多 8 个样本）；[] = 未发现 */
export declare function inventedIdentifiers(src: string, out: string): string[]

// ── v11.11 ──────────────────────────────────────────────────────────────────
/** 按书写系统拆分字符数（只有数量）；trace 用它记录校准样本。 */
export declare function scriptCounts(text: string): { wide: number; other: number }
/** 宿主模型 / provider 跟随：每次调用派生专属配置，共享配置永不改写。 */
export declare function createHostFollower(
  cfg: CotFormBConfig,
  trace: (tag: string, data: object) => void,
): {
  observe(options: { model?: string; provider?: string } | null | undefined, n: number): void
  callConfig(options: { model?: string; provider?: string } | null | undefined): CotFormBConfig
  hostModel(): string | null
  explicitModel: string | undefined
}
/** 流归属检测：多个会话交错进入 pre-step 时判定为不可证。 */
export declare function createSessionTracker(opts?: { staleMs?: number; now?: () => number }): {
  onPreStep(session: unknown): void
  forStream(): { session: unknown; sessionId: string | null; ambiguous: boolean; candidates: string[] }
  latest(): { session: unknown; sessionId: string | null }
  pendingCount(): number
}

// ── v13 宿主证据程序：生成器只能交提议；宿主拥有冻结契约、签名与 IO 能力 ──
export type EvidenceJson = null | boolean | number | string | readonly EvidenceJson[] | { readonly [key: string]: EvidenceJson }
export type EvidencePredicate =
  | { readonly op: 'and' | 'or'; readonly items: readonly EvidencePredicate[] }
  | { readonly op: 'not'; readonly item: EvidencePredicate }
  | { readonly op: 'equals'; readonly field: string; readonly value: EvidenceJson }
  | { readonly op: 'includes' | 'absent'; readonly field: string; readonly value: string }
  | { readonly op: 'at-least' | 'at-most'; readonly field: string; readonly value: number }
  | { readonly op: 'before'; readonly field: string; readonly other: string }
export type EvidenceCheckRole = 'precondition' | 'acceptance' | 'diagnostic'
export type EvidenceCheck = {
  readonly id: string; readonly role: EvidenceCheckRole; readonly predicate: EvidencePredicate
  readonly label?: string; readonly conditions?: Readonly<Record<string, EvidenceJson>>
} & (
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'observation'; readonly timeoutMs?: number }
  | { readonly kind: 'command'; readonly executable: string; readonly args: readonly string[]; readonly localOnly: true
      readonly timeoutMs: number; readonly maxOutputBytes?: number; readonly env?: Readonly<Record<string, string>> }
)
export type EvidenceAction = {
  readonly id: string; readonly preconditions: readonly string[]; readonly checks: readonly string[]
} & ({ readonly type: 'observe' } | { readonly type: 'replace'; readonly path: string; readonly oldText: string; readonly newText: string })
export interface EvidenceContractDefinition {
  readonly task: string; readonly version: string; readonly checks: readonly EvidenceCheck[]; readonly actions?: readonly EvidenceAction[]
  readonly protectedFiles?: readonly { readonly path: string; readonly sha256: string }[]
}
export interface EvidenceContract extends EvidenceContractDefinition {
  readonly schema: 'cfb.evidence-contract/1'; readonly digest: string; readonly actions: readonly EvidenceAction[]
  readonly protectedFiles: readonly { readonly path: string; readonly sha256: string }[]
}
export interface EvidenceStep {
  readonly id: string; readonly preconditions: readonly string[]; readonly action: EvidenceAction
  readonly expectedObservations: readonly { readonly checkId: string; readonly predicate: EvidencePredicate }[]
  readonly checkCommand: readonly { readonly checkId: string; readonly kind: EvidenceCheck['kind']; readonly command: string }[]
}
export interface EvidenceProgram {
  readonly schema: 'cfb.evidence-program/1'; readonly id: string; readonly sessionId: string; readonly contractDigest: string
  readonly explanation: string; readonly steps: readonly EvidenceStep[]
}
export interface EvidenceProposal {
  readonly schema: 'cfb.evidence-proposal/1'; readonly explanation: string; readonly parsed: boolean; readonly authorized: false
  readonly steps: readonly {
    readonly id: string; readonly preconditions: readonly { readonly type: 'file-contains'; readonly path: string | null; readonly text: string }[]
    readonly action: { readonly type: 'observe' } | { readonly type: 'replace'; readonly path: string | null; readonly oldText: string; readonly newText: string }
    readonly expectedObservation: string | null; readonly checkCommand: string | null
  }[]
}
export type EvidencePhase = 'preconditions' | 'action' | 'postconditions' | 'diagnostic'
export interface EvidenceBinding {
  readonly sessionId: string; readonly programId: string; readonly contractDigest: string; readonly roundId: string
  readonly revision: string; readonly stepId: string; readonly phase: EvidencePhase
}
export interface EvidenceState {
  readonly programId: string; readonly contractDigest: string; readonly sessionId: string; readonly roundId: string; readonly revision: string
  readonly cursor: number; readonly phase: EvidencePhase; readonly status: 'ready' | 'blocked' | 'verified'
  readonly verifiedSteps: readonly string[]; readonly receiptIds: readonly string[]; readonly reason?: string
}
export interface EvidenceReceipt {
  readonly schema: 'cfb.evidence-receipt/1'; readonly id: string; readonly signature: string; readonly subjectId: string; readonly binding: EvidenceBinding
  readonly status: 'pass' | 'fail' | 'unknown'; readonly ok: boolean; readonly reason: string; readonly observationDigest: string | null; readonly nextRevision: string | null
}
export interface EvidenceObservation {
  readonly value?: EvidenceJson; readonly revision?: string; readonly roundId?: string
  readonly conditions?: Readonly<Record<string, EvidenceJson>>; readonly error?: string
}
export interface EvidenceVerifier {
  readonly contract: EvidenceContract
  check(id: string, binding: EvidenceBinding, options?: { signal?: AbortSignal }): Promise<EvidenceReceipt>
  action(id: string, binding: EvidenceBinding): EvidenceReceipt
  authenticate(receipt: unknown): boolean
  intact(): boolean
}
export declare const EVIDENCE_SCHEMA: 'cfb.evidence-program/1'
export declare const CONTRACT_SCHEMA: 'cfb.evidence-contract/1'
export declare function canonicalJson(value: unknown): string
export declare function evidenceDigest(value: unknown): string
export declare function immutableJson<T>(value: T): Readonly<T>
export declare function safeRelativePath(value: unknown): value is string
export declare function evaluateEvidencePredicate(predicate: EvidencePredicate, value: EvidenceJson): boolean | null
export declare function freezeEvidenceContract(def: EvidenceContractDefinition): EvidenceContract
export declare function assertEvidenceContract(contract: EvidenceContract): EvidenceContract
export declare function createEvidenceProgram(explanation: string, options: { contract: EvidenceContract; actionIds: readonly string[]; sessionId: string }): EvidenceProgram
export declare function assertEvidenceProgram(program: EvidenceProgram, contract: EvidenceContract): EvidenceProgram
export declare function parseEvidenceProposal(text: string, options?: { calls?: readonly { name: string; args: EvidenceJson | string }[]; ctx?: string }): EvidenceProposal
export declare function bindEvidenceProposal(proposal: EvidenceProposal, contract: EvidenceContract, sessionId: string): { ok: true; program: EvidenceProgram } | { ok: false; reason: string }
export declare function initialEvidenceState(program: EvidenceProgram, options: { roundId: string; revision: string }): EvidenceState
export declare function evidenceBinding(program: EvidenceProgram, state: EvidenceState): EvidenceBinding
export declare function advanceEvidenceState(program: EvidenceProgram, state: EvidenceState, receipts: readonly EvidenceReceipt[], authenticate?: (r: EvidenceReceipt) => boolean): EvidenceState
export declare function compileV4Evidence(side: string, raw: string, config?: CotFormBConfig, options?: { contract?: EvidenceContract; sessionId?: string; calls?: readonly { name: string; args: EvidenceJson | string }[] }):
  { ok: true; text: string; stats: V4Stats; proposal: EvidenceProposal; evidence: { ok: true; program: EvidenceProgram } | { ok: false; reason: string } } |
  { ok: false; reason: string; stats: V4Stats }
export declare function protectEvidenceContract(def: EvidenceContractDefinition, options: { root: string; paths: readonly string[] }): EvidenceContract
export declare function evidenceFilePath(root: string, relative: string, options?: { missing?: boolean }): string
export declare function readEvidenceFile(root: string, relative: string, maxBytes?: number): Uint8Array
export declare function replaceEvidenceFile(root: string, action: Extract<EvidenceAction, { type: 'replace' }>): { changed: true }
export declare function createEvidenceVerifier(options: {
  contract: EvidenceContract; root: string; allowCommands?: boolean; allowEdits?: boolean
  observe?: (check: EvidenceCheck, binding: EvidenceBinding, signal?: AbortSignal) => EvidenceObservation | Promise<EvidenceObservation>
  perform?: (action: Extract<EvidenceAction, { type: 'replace' }>) => { changed: boolean }
  readRevision?: () => string; readConditions?: () => Record<string, EvidenceJson>
}): EvidenceVerifier

export type EvidencePrior = Readonly<Record<string, number>>
export type EvidenceLikelihood = Readonly<Record<string, { readonly pass: number; readonly fail: number }>>
export interface DiagnosticProbe { readonly checkId: string; readonly cost: number; readonly likelihood: EvidenceLikelihood }
export interface DiagnosticModel { readonly schema: 'cfb.diagnostic-model/1'; readonly digest: string; readonly contractDigest: string; readonly prior: EvidencePrior; readonly probes: readonly DiagnosticProbe[] }
export interface DiagnosticState {
  readonly prior: EvidencePrior; readonly count: number; readonly cost: number; readonly maxChecks: number; readonly maxCost: number
  readonly pending: { readonly checkId: string; readonly gain: number; readonly cost: number; readonly binding: EvidenceBinding } | null
  readonly stopped: string | null; readonly history: readonly { checkId: string; revision: string; status: EvidenceReceipt['status']; gain: number; posteriorApplied: boolean; receiptId: string }[]
}
export interface DiagnosticController {
  choose(binding: EvidenceBinding): { ok: true; selected: NonNullable<DiagnosticState['pending']> } | { ok: false; reason: string }
  record(receipt: EvidenceReceipt, authenticate: (r: EvidenceReceipt) => boolean): DiagnosticState
  view(): DiagnosticState
}
export declare function evidenceEntropy(prior: EvidencePrior): number
export declare function expectedEvidenceGain(prior: EvidencePrior, likelihood: EvidenceLikelihood): number
export declare function evidencePosterior(prior: EvidencePrior, likelihood: EvidenceLikelihood, outcome: string): { ok: true; probability: number; prior: EvidencePrior } | { ok: false; reason: string; prior: EvidencePrior }
export declare function freezeDiagnosticModel(def: { prior: EvidencePrior; probes: readonly DiagnosticProbe[] }, contract: EvidenceContract): DiagnosticModel
export declare function createDiagnosticController(options: { model: DiagnosticModel; contract: EvidenceContract; maxChecks?: number; maxCost?: number; minGain?: number; strategy?: 'active' | 'fixed'; checkOrder?: readonly string[] | null; stopOnUnknown?: boolean }): DiagnosticController
export interface DiagnosticResult { readonly schema: 'cfb.diagnostic-result/1'; readonly receipts: readonly EvidenceReceipt[]; readonly state: DiagnosticState; readonly acceptanceUnchanged: true }
export declare function runActiveEvidenceChecks(options: { controller: DiagnosticController; verifier: EvidenceVerifier; binding: EvidenceBinding; signal?: AbortSignal }): Promise<DiagnosticResult>

export interface MemorySignature { readonly taskFamily: string; readonly environment: string; readonly contractVersion: string; readonly [key: string]: string }
export interface MemoryDefinition { readonly kind: 'rule' | 'fact' | 'vaccine'; readonly body: string; readonly signature: MemorySignature; readonly trigger: EvidencePredicate; readonly sources: readonly string[]; readonly expiresAt?: number }
export interface MemoryCandidate extends MemoryDefinition { readonly schema: 'cfb.memory-candidate/1'; readonly id: string }
export interface EffectFixture { readonly id: string; readonly family: string; readonly input: EvidenceJson; readonly predicate: EvidencePredicate }
export interface EffectSuiteDefinition { readonly id: string; readonly evaluatorVersion: string; readonly train: readonly EffectFixture[]; readonly selection: readonly EffectFixture[]; readonly test: readonly EffectFixture[] }
export interface EffectSuite extends EffectSuiteDefinition { readonly schema: 'cfb.effect-suite/1'; readonly digest: string; readonly testDigest: string }
export interface SignedEffect { readonly fixtureId: string; readonly family: string; readonly split: 'train' | 'selection' | 'test'; readonly before: boolean | null; readonly after: boolean | null; readonly sign: '+' | '0' | '-' | '?' }
export interface EffectCertificate { readonly schema: 'cfb.effect-certificate/1'; readonly cycleId: string; readonly suiteDigest: string; readonly evaluatorDigest: string; readonly candidateId: string; readonly phase: 'screen' | 'final'; readonly effects: readonly SignedEffect[]; readonly gate: { ok: boolean; reason: string }; readonly id: string; readonly signature: string }
export interface HoldoutRegistry { consume(families: readonly string[]): void; snapshot(): readonly string[] }
export interface EffectCycleView { readonly cycleId: string; readonly suiteDigest: string; readonly evaluatorDigest: string; readonly attempts: number; readonly maxCandidates: number; readonly closed: boolean; readonly reserved: boolean }
export interface EffectCycle { readonly cycleId: string; readonly suiteDigest: string; screen(candidate: MemoryDefinition): EffectCertificate; reserve(): boolean; finalize(ids: readonly string[]): readonly EffectCertificate[]; authenticate(certificate: unknown): boolean; view(): EffectCycleView }
export type EffectEvaluator = (candidate: MemoryCandidate | null, input: EvidenceJson) => EvidenceJson
export interface EffectArchiveSnapshot { readonly schema: 'cfb.effect-archive/1'; readonly owner: string | null; readonly active: readonly { entry: MemoryCandidate; cell: string; effects: readonly SignedEffect[]; certificateId: string; suiteDigest: string }[]; readonly rejected: readonly { entry: MemoryCandidate; effects: readonly SignedEffect[]; reason: string }[]; readonly retired: readonly { entry: MemoryCandidate; reason: string }[]; readonly heldoutFamiliesSpent: readonly string[]; readonly events: readonly { type: string; id: string; reason: string }[]; readonly cycle: EffectCycleView | null }
export interface EvidenceArchive {
  beginCycle(options: { suite: EffectSuite; evaluate: EffectEvaluator; maxCandidates?: number }): EffectCycleView
  consider(def: MemoryDefinition): EffectCertificate; finalize(): readonly EffectCertificate[]; retire(id: string, reason?: string): boolean
  retrieve(context: { signature: MemorySignature; observation: EvidenceJson }, options?: { k?: 0 | 1 }): readonly { id: string; kind: MemoryDefinition['kind']; body: string; sources: readonly string[] }[]
  snapshot(): EffectArchiveSnapshot; reserveHoldout(): boolean; persist(): string
}
export declare function createMemoryCandidate(def: MemoryDefinition): MemoryCandidate
export declare function freezeEffectSuite(def: EffectSuiteDefinition): EffectSuite
export declare function createHoldoutRegistry(initial?: readonly string[]): HoldoutRegistry
export declare function gateSignedEffects(effects: readonly SignedEffect[], options?: { requireTest?: boolean }): { ok: boolean; reason: string }
export declare function createEffectCycle(options: { suite: EffectSuite; evaluate: EffectEvaluator; registry: HoldoutRegistry; maxCandidates?: number }): EffectCycle
export declare function createEvidenceArchive(options?: { maxEntries?: number; maxRejected?: number; clock?: () => number; store?: EvidenceStore | null; restoreRef?: string | null }): EvidenceArchive

export interface EvidenceStore {
  readonly sessionId: string; readonly directory: string
  /** Public HMAC-derived identity; not the private signing key. */
  readonly authorityId: string
  put(value: string | Uint8Array, options?: { kind?: string }): string; get(handle: string, options?: { kind?: string }): string | Uint8Array
  putJson(value: unknown, options?: { kind?: string }): string; getJson<T = EvidenceJson>(handle: string, options?: { kind?: string }): Readonly<T>
  stats(): { files: number; heads: number; bytes: number; maxTotalBytes: number }
  readHead(name: string): { ref: string; revision: string; sequence: number } | null
  setHead(name: string, ref: string, options: { expectedRevision: string | null }): { ref: string; revision: string; sequence: number }
}
export interface EvidenceArtifactIndex { readonly schema: 'cfb.artifact-index/1'; readonly sessionId: string; readonly programId: string; readonly contractDigest: string; readonly programRef: string; readonly blocks: readonly { id: string; type: 'RAW' | 'EXPLANATION' | 'STEP'; handle: string; bytes: number; chars?: number }[] }
export declare function createEvidenceStore(options: { directory: string; sessionId: string; maxBlobBytes?: number; maxTotalBytes?: number }): EvidenceStore
export declare function isEvidenceStore(value: unknown): value is EvidenceStore
export declare function archiveEvidenceArtifact(store: EvidenceStore, artifact: { raw: string; program: EvidenceProgram }): { programRef: string; indexRef: string; index: EvidenceArtifactIndex }
export declare function recoverEvidenceBlock(store: EvidenceStore, indexRef: string, blockId: string): string | EvidenceStep
export interface EvidenceHostSnapshot { readonly schema: 'cfb.host-snapshot/1'; readonly scopeDigest: string; readonly state: EvidenceJson; readonly conditions: EvidenceJson; readonly files: readonly { path: string; exists: boolean; mode: number; data: string }[] }
export interface EvidenceStateAdapter {
  readonly root: string; readonly paths: readonly string[]; readonly scopeDigest: string
  capture(): EvidenceHostSnapshot; revision(): string; restore(snapshot: EvidenceHostSnapshot, options: { expectedRevision: string }): { restored: true; revision: string }
  perform(action: Extract<EvidenceAction, { type: 'replace' }>): { changed: boolean }; readConditions(): Record<string, EvidenceJson>
}
export declare function createFileStateAdapter(options: { root: string; paths: readonly string[]; readState?: () => EvidenceJson; writeState?: (state: EvidenceJson) => void; afterAction?: (action: Extract<EvidenceAction, { type: 'replace' }>) => void; readConditions?: () => Record<string, EvidenceJson>; maxSnapshotBytes?: number }): EvidenceStateAdapter
export interface EvidenceCheckpoint { readonly handle: string; readonly revision: string; readonly kind: 'before-round' | 'preconditions' | 'verified-step'; readonly artifactRef: string | null }
export interface EvidenceCheckpoints {
  take(options?: { kind?: EvidenceCheckpoint['kind']; artifactRef?: string | null; program?: EvidenceProgram | null; state?: EvidenceState | null; receipts?: readonly EvidenceReceipt[] }): EvidenceCheckpoint
  restore(handle: string, expectedRevision: string): { restored: true; revision: string; artifactRef: string | null; programId: string | null; state: EvidenceState | null; kind: EvidenceCheckpoint['kind'] }
}
export declare function createEvidenceCheckpoints(options: { store: EvidenceStore; adapter: EvidenceStateAdapter; sessionId: string; contractDigest: string; authenticate: (r: EvidenceReceipt) => boolean }): EvidenceCheckpoints
export interface EvidenceRuntimeOptions {
  contract: EvidenceContract; sessionId: string; store: EvidenceStore; adapter: EvidenceStateAdapter
  observe?: (check: EvidenceCheck, binding: EvidenceBinding, signal?: AbortSignal) => EvidenceObservation | Promise<EvidenceObservation>
  diagnosticModel?: DiagnosticModel | null; archive?: EvidenceArchive | null; memoryContext?: { signature: MemorySignature; observation: EvidenceJson } | null
  diagnosticStrategy?: 'active' | 'fixed'; diagnosticOrder?: readonly string[] | null
  contextOptions?: Omit<EvidenceContextOptions, 'store' | 'contract' | 'verifier' | 'readRevision' | 'readRuntime'> | null
  allowEdits?: boolean; allowCommands?: boolean; maxRounds?: 1 | 2 | 3; maxRepairRounds?: 0 | 1 | 2; maxChecks?: number; roundTimeoutMs?: number; diagnosticChecks?: number; diagnosticCost?: number
}
export interface EvidenceModelView { readonly schema: 'cfb.evidence-view/1'; readonly status: string; readonly lastPassed: { checkpoint: string; kind: EvidenceCheckpoint['kind']; artifact: string | null } | null; readonly diagnostics: readonly { checkId: string; status: EvidenceReceipt['status'] }[]; readonly memories: ReturnType<EvidenceArchive['retrieve']>; readonly next: 'stop' | 'stop-with-unresolved' | 'choose-another-approved-branch' }
export interface EvidenceRoundResult { readonly ok: boolean; readonly status: 'verified' | 'blocked' | 'rolled-back' | 'conflict' | 'recovery-failed'; readonly reason: string; readonly counters: { rounds: number; repairs: number; checks: number }; readonly modelView?: EvidenceModelView; readonly artifactRef?: string | null; readonly checkpoint?: string | null; readonly state?: EvidenceState | null; readonly receipts?: readonly EvidenceReceipt[]; readonly diagnostic?: DiagnosticResult | { receipts: readonly EvidenceReceipt[]; error: string } | null; readonly recoveryError?: string | null; readonly failureReason?: string; readonly restored?: ReturnType<EvidenceCheckpoints['restore']> | null }
export interface EvidenceRoundOptions { roundId?: string; raw?: string; signal?: AbortSignal | null; diagnostics?: boolean; stopOnUnknown?: boolean }
export interface EvidenceRuntime {
  runRound(program: EvidenceProgram, options?: EvidenceRoundOptions): Promise<EvidenceRoundResult>
  program(explanation: string, actionIds: readonly string[]): EvidenceProgram; modelView(): EvidenceModelView
  contextView(): EvidenceContextDashboard | null
  modelInput(options?: EvidenceRenderOptions): EvidenceContextFrame | { readonly ok: false; readonly reason: 'context-disabled'; readonly prefix: null; readonly layers: readonly [] }
  readBlock(indexRef: string, blockId: string, options?: EvidenceBlockReadOptions): EvidenceBlockReadResult
  cancelObligation(id: string): boolean; publishDraft(artifactRef: string): boolean
  view(): { sessionId: string; contractDigest: string; rounds: number; repairs: number; checks: number; maxRounds: number; maxRepairRounds: number; maxChecks: number; busy: boolean; done: boolean; peak: EvidenceCheckpoint | null; history: readonly { roundId: string; programId: string; status: string; resultRef: string }[] }
}
export interface EvidenceHost {
  readonly schema: 'cfb.evidence-host/1'; readonly sessionId: string; readonly runtime: EvidenceRuntime
  captureDraft(draft: { raw: string; text: string; sessionId: string; index?: number; ctx?: string; calls?: readonly { name: string; args: EvidenceJson | string }[]; complete?: boolean }): { index: number; authorized: boolean; artifactRef?: string; programRef?: string; reason?: string }
  latest(): readonly { index: number; authorized: boolean; indexRef?: string; programRef?: string; reason?: string }[]
  runLatest(index: number, options?: Omit<EvidenceRoundOptions, 'raw'>): Promise<EvidenceRoundResult | { ok: false; status: 'blocked'; reason: string }>
}
export declare function createEvidenceRuntime(options: EvidenceRuntimeOptions): EvidenceRuntime
export declare function createEvidenceHost(options: EvidenceRuntimeOptions): EvidenceHost
export declare function isEvidenceHost(value: unknown): value is EvidenceHost


/** 宿主注册品牌；同形对象不能提供回执权。 */
export declare function isEvidenceVerifier(value: unknown): value is EvidenceVerifier
export declare function replayEvidenceTrace(program: EvidenceProgram, receipts: readonly EvidenceReceipt[], verifier: EvidenceVerifier): EvidenceState | null
export interface BinaryEvidenceFeedback {
  readonly schema: 'cfb.binary-feedback/1'; readonly roundId: string | null; readonly revision: string
  readonly checks: readonly { readonly checkId: string; readonly role: EvidenceCheck['role']; readonly status: EvidenceReceipt['status']; readonly fresh: boolean }[]
}
export declare function binaryEvidenceFeedback(options: { program: EvidenceProgram; receipts?: readonly EvidenceReceipt[]; diagnosticReceipts?: readonly EvidenceReceipt[]; verifier: EvidenceVerifier; revision: string }): BinaryEvidenceFeedback
export interface EvidenceIntent {
  readonly id: string; readonly programId: string; readonly roundId: string; readonly stepId: string; readonly contractDigest: string; readonly revision: string
  readonly triggerChecks: readonly string[]; readonly action: EvidenceAction; readonly acceptanceChecks: readonly string[]
  readonly status: 'armed' | 'pending' | 'executed' | 'fulfilled' | 'cancelled' | 'invalidated'; readonly reason: string | null; readonly expiresAt: number | null
  readonly triggerReceipts: Readonly<Record<string, string>>; readonly acceptanceReceipts: Readonly<Record<string, string>>; readonly actionReceipt: string | null; readonly scopeFresh: boolean
}
export interface EvidenceIntents {
  define(options: { program: EvidenceProgram; binding: EvidenceBinding; stepId: string; expiresAt?: number | null }): string
  record(receipts: readonly EvidenceReceipt[]): void; canExecute(programId: string, roundId: string, stepId: string): boolean
  cancel(id: string): boolean; invalidateRound(roundId: string): void; view(): readonly EvidenceIntent[]
}
export declare function createEvidenceIntents(options: { contract: EvidenceContract; verifier: EvidenceVerifier; sessionId: string; readRevision: () => string; clock?: () => number; maxEntries?: number }): EvidenceIntents
export interface EvidenceSlotAudit {
  readonly schema: 'cfb.slot-audit/1'; readonly authorized: boolean; readonly complete: boolean; readonly missing: number; readonly unknown: number
  readonly rows: readonly { readonly stepId: string; readonly preconditions: 'present' | 'missing'; readonly action: 'present' | 'missing'; readonly expectation: 'present' | 'missing' | 'unknown'; readonly check: 'present' | 'missing' | 'unknown' }[]
}
export declare function auditEvidenceSlots(value: unknown, contract?: EvidenceContract): EvidenceSlotAudit
export interface EvidenceContextOptions {
  store: EvidenceStore; contract: EvidenceContract; verifier: EvidenceVerifier; readRevision: () => string
  readRuntime?: () => Partial<{ rounds: number; maxRounds: number; repairs: number; maxRepairRounds: number; checks: number; maxChecks: number }>
  clock?: () => number; maxTokensEst?: number; maxReadBytes?: number; maxReadCalls?: number; maxArtifacts?: number; allowOptimizerReads?: boolean
}
export interface EvidenceContextBudget {
  readonly maxTokensEst: number; readonly tokensUsedEst: number; readonly remainingTokensEst: number; readonly maxReadBytes: number
  readonly maxReadCalls: number; readonly remainingReadCalls: number; readonly readCalls: number; readonly layerDeliveries: number; readonly estimation: string; readonly providerReportedUsage: null
}
export interface EvidenceContextBlock {
  readonly id: string; readonly type: 'RAW' | 'EXPLANATION' | 'STEP'; readonly handle: string; readonly indexRef: string; readonly programId: string
  readonly bytes: number; readonly chars?: number; readonly tokensEst: number; readonly createdAt: number; readonly ageMs: number
  readonly readCalls: number; readonly layerDeliveries: number; readonly accesses: number; readonly lastAccessAt: number | null
  readonly freshness: 'stale-revision' | 'current' | 'older-artifact'; readonly verified: boolean; readonly solverReadable: boolean
}
export interface EvidenceContextDashboard { readonly schema: 'cfb.context-dashboard/1'; readonly epoch: number; readonly latest: string | null; readonly budget: EvidenceContextBudget; readonly blocks: readonly EvidenceContextBlock[]; readonly obligations: readonly EvidenceIntent[] }
export type EvidenceDescriptionLevel = 'L0' | 'L1' | 'L2'
export interface EvidenceObligationCore {
  readonly schema: 'cfb.obligation-core/1'; readonly sessionId: string; readonly contract: EvidenceContract; readonly programId: string; readonly steps: readonly EvidenceStep[]
  readonly cycle: { readonly epoch: number; readonly roundId: string | null; readonly revision: string; readonly status: string; readonly verified: boolean }
  readonly slotAudit: EvidenceSlotAudit; readonly obligations: readonly EvidenceIntent[]; readonly feedback: BinaryEvidenceFeedback
  readonly budgets: { readonly rounds: number | null; readonly maxRounds: number | null; readonly repairs: number | null; readonly maxRepairRounds: number | null; readonly checks: number | null; readonly maxChecks: number | null; readonly context: EvidenceContextBudget }
}
export interface EvidenceRenderOptions { levels?: readonly EvidenceDescriptionLevel[]; tokenBudgetEst?: number }
export type EvidenceContextFrame = { readonly ok: true; readonly prefix: string; readonly prefixDigest: string; readonly layers: readonly { readonly ref: string; readonly level: EvidenceDescriptionLevel; readonly text: string; readonly tokensEst: number }[]; readonly tokensEst: number; readonly budget: EvidenceContextBudget } |
  { readonly ok: false; readonly reason: string; readonly prefix: null; readonly layers: readonly []; readonly budget: EvidenceContextBudget }
export interface EvidenceBlockReadOptions { role?: 'solver' | 'optimizer'; tokenBudgetEst?: number }
export type EvidenceBlockReadResult = { readonly ok: true; readonly value: string | EvidenceStep; readonly tokensEst: number; readonly bytes: number; readonly budget: EvidenceContextBudget } | { readonly ok: false; readonly reason: string }
export interface EvidenceContext {
  readonly intents: EvidenceIntents; stablePrefix(): string
  publish(program: EvidenceProgram, result: { ok: boolean; status: string; artifactRef: string; state?: EvidenceState | null; receipts?: readonly EvidenceReceipt[]; diagnostic?: { receipts: readonly EvidenceReceipt[] } | null }): string
  render(options?: EvidenceRenderOptions): EvidenceContextFrame; decode(refs: readonly string[]): EvidenceObligationCore
  readBlock(indexRef: string, blockId: string, options?: EvidenceBlockReadOptions): EvidenceBlockReadResult
  reset(): void; view(): EvidenceContextDashboard
}
export declare function createEvidenceContext(options: EvidenceContextOptions): EvidenceContext


/** 已知参考、代理自写的本地工程场景，不是主模型泛化基准。 */
export declare const LOCAL_EVIDENCE_FAMILIES: Readonly<Record<'train' | 'selection' | 'test', readonly string[]>>
export declare function createLocalEvidenceSuite(): EffectSuite
export declare function parseLocalEvidencePolicy(candidate: MemoryCandidate | null): { readonly mode: 'idle' | 'unchecked' | 'checked' }
export interface LocalEvidenceOutput {
  readonly correct?: boolean; readonly unknownReason?: string; readonly primary: boolean; readonly secondary: boolean | null; readonly agreement: boolean
  readonly actualVerified: boolean; readonly status: string; readonly reason: string; readonly managedStateRestored: boolean
  readonly loopbackRequests: number; readonly externalApiCalls: 0; readonly localOracleProcesses: number
}
export declare function executeLocalEvidenceCase(candidate: MemoryCandidate | null, input: { family: string; variant: number }, options?: { perturbation?: 'none' | 'format'; observer?: 'primary' | 'secondary' }): Promise<LocalEvidenceOutput>
export interface EvidenceDocumentDefinition { readonly protected: EvidenceJson; readonly sections: readonly { readonly id: string; readonly text: string }[]; readonly requiredSections?: readonly string[] }
export interface EvidenceDocument extends EvidenceDocumentDefinition { readonly schema: 'cfb.bounded-document/1'; readonly id: string; readonly requiredSections: readonly string[] }
export type EvidenceDocumentEdit = { readonly type: 'add'; readonly id: string; readonly text: string } | { readonly type: 'replace'; readonly id: string; readonly expectedText: string; readonly text: string } | { readonly type: 'delete'; readonly id: string }
export declare function createEvidenceDocument(definition: EvidenceDocumentDefinition): EvidenceDocument
export declare function editEvidenceDocument(document: EvidenceDocument, operations: readonly EvidenceDocumentEdit[], options?: { maxEdits?: number; maxChangedChars?: number; maxFinalChars?: number }): { readonly document: EvidenceDocument; readonly edits: number; readonly changedChars: number; readonly protectedDigest: string }
export interface EvidenceIssue { readonly id: string; readonly signature: MemorySignature; readonly family: string; readonly component: string; readonly reason: string; readonly count: number; readonly status: 'open' | 'resolved'; readonly firstAt: number; readonly lastAt: number; readonly samples: readonly string[] }
export interface EvidenceIssues {
  record(issue: { signature: MemorySignature; family: string; component: string; reason: string; evidenceRef: string }): boolean
  view(): readonly EvidenceIssue[]; persist(): string; resolve(id: string): boolean
}
export declare function createEvidenceIssues(options: { store: EvidenceStore; maxIssues?: number; clock?: () => number }): EvidenceIssues
export interface EvidencePairedObservations { readonly schema: 'cfb.paired-observations/1'; readonly rows: readonly { readonly id: string; readonly answerUnchanged: boolean | null; readonly actionChanged: boolean | null }[]; readonly answerUnchanged: { n: number; total: number; unknown: number }; readonly actionChanged: { n: number; total: number; unknown: number }; readonly note: string }
export declare function compareEvidencePairs(pairs: readonly { id: string; before?: { answer?: EvidenceJson; action?: EvidenceJson }; after?: { answer?: EvidenceJson; action?: EvidenceJson } }[]): EvidencePairedObservations
export interface EvidenceSearchRecord { readonly schema: 'cfb.search-record/1'; readonly evaluatorSourceDigest: string; readonly suiteDigest: string; readonly candidateId: string | null; readonly fixtureId: string; readonly inputDigest: string; readonly split: 'train' | 'selection' | 'test'; readonly output: EvidenceJson; readonly error: string | null; readonly ref: string }
export interface EvidenceSearchResult {
  readonly schema: 'cfb.evidence-search/1'; readonly suiteDigest: string; readonly evaluatorSourceDigest: string; readonly archiveRef: string; readonly issuesRef: string
  readonly counters: { candidates: number; maxCandidates: number; evaluations: number; maxEvaluations: number; testEvaluations: number; duplicates: number; priorRejections: number }
  readonly screened: readonly (EffectCertificate & { readonly cachedFromPriorCycle?: true })[]; readonly final: readonly EffectCertificate[]
  readonly activeIds: readonly string[]; readonly issues: readonly EvidenceIssue[]; readonly records: readonly EvidenceSearchRecord[]
}
export declare function runEvidenceSearch(options: { store: EvidenceStore; suite: EffectSuite; candidates: readonly MemoryDefinition[]; evaluateAsync: (candidate: MemoryCandidate | null, input: EvidenceJson, signal: AbortSignal) => EvidenceJson | Promise<EvidenceJson>; maxCandidates?: number; maxEvaluations?: number; evaluationTimeoutMs?: number; evaluationScope?: string | null }): Promise<EvidenceSearchResult>


/** 只在冻结契约批准动作内调度；不接收外部后验/失败原文。 */
export interface ApprovedRepairPolicyDefinition {
  routing: 'fixed' | 'posterior'; firstActionId: string; fallbackActionId: string
  routes?: Readonly<Record<string, string>>; minPosterior?: number; maxAttempts?: 1 | 2; diagnosticMode?: 'always' | 'before-retry'
}
export interface ApprovedRepairPolicy extends ApprovedRepairPolicyDefinition {
  readonly schema: 'cfb.approved-repair-policy/1'; readonly contractDigest: string; readonly digest: string
  readonly routes: Readonly<Record<string, string>>; readonly minPosterior: number; readonly maxAttempts: 1 | 2
}
export declare function freezeApprovedRepairPolicy(def: ApprovedRepairPolicyDefinition, contract: EvidenceContract): ApprovedRepairPolicy
export interface ApprovedRepairEpisodeResult {
  readonly schema: 'cfb.approved-repair-episode/1'; readonly policyDigest: string; readonly solved: boolean; readonly status: string
  readonly outcomes: readonly Awaited<ReturnType<EvidenceHost['runLatest']>>[]; readonly publications: readonly ReturnType<EvidenceHost['captureDraft']>[]
  readonly decisions: readonly { afterRound: string; route: 'fixed' | 'posterior'; nextActionId: string; confidence: number; diagnosticChecks: number }[]
  readonly counters: ReturnType<EvidenceRuntime['view']>
}
export interface ApprovedRepairBlocked { readonly schema: 'cfb.approved-repair-blocked/1'; readonly solved: false; readonly status: string }
export interface ApprovedRepairController {
  readonly schema: 'cfb.approved-repair-controller/1'; readonly policyDigest: string
  run(options?: { signal?: AbortSignal | null }): Promise<ApprovedRepairEpisodeResult | ApprovedRepairBlocked>
  view(): { readonly started: boolean; readonly busy: boolean; readonly result: ApprovedRepairEpisodeResult | null }
}
export declare function createApprovedRepairEpisode(options: { host: EvidenceHost; contract: EvidenceContract; policy: ApprovedRepairPolicy }): ApprovedRepairController
