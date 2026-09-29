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
  /** 仅 v4（v12.6，理论 S8-R6）：副模型直写原生语域散文（oracle C 形态），不经 ops→模板；缺省 false */
  compressV4Direct?: boolean
  /** 仅 v4 直写（v12.7，理论 S8-R7）：尾段判读分支的闭合与落点绑定（改法分支必须带已核真的逐字落点 + 分支内可用句）；缺省 true */
  compressV4DirectBind?: boolean
  /** 仅 v4 直写：超过此长度熔断为原文放行（缺省 1300） */
  compressV4DirectMaxChars?: number
  /** 仅 v4 直写：当前任务 / 观察上下文（工具注入；生产缺省由 plugin 自动构造，见 compressCtxAuto） */
  compressCtx?: string
  /** v12.7：v4 时自动从出站消息构造 compressCtx（最后一条人类 user + 本回合工具结果）；缺省 true */
  compressCtxAuto?: boolean
  /** 自动 compressCtx 的总预算（字符，缺省 8000） */
  compressCtxMaxChars?: number
  /** 仅工具用：meta.sideOutput 带回副模型原始输出（缺省 false） */
  captureSideOutput?: boolean
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
