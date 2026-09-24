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
   *   'checkpoint' 实验：pre-step 用官方 user/message 看板整段替换已出站的推理
   *   'off'        完全不介入，原样放行
   * ⛔ 'distill' / 'rules' 已于 v11.8 退役：写回路径协议上永久非法；传入时按 'off' 处理，
   *    并由 normalizeConfig 记入 retiredMode（BOOT 可见）。不认识的值同样按 'off'（记入 invalidMode）。
   */
  mode?: 'birth' | 'checkpoint' | 'off' | 'distill' | 'rules'

  /**
   * 编译模式三选一（唯一裁决点 resolveCompileMode）：
   *   stateMemory   → 'memory'   证据账本 / 快照 / 两栏判断（状态记忆）
   *   stateCompress → 'compress' 仅本段 reasoning 的摘要（不采集证据；产物可进迟到暂存区）
   *   都不开        → 'legacy'   旧蒸馏提示词
   * 两者同时为 true 时 memory 生效，并在 BOOT 里记录 compileModeConflict（不抛错）。
   */
  stateMemory?: boolean
  stateCompress?: boolean
  /** compress 提示词版本：'v2' 中性压缩（缺省，相对长度目标）；'v1' 与 legacy 蒸馏逐字相同（回滚/对照）；'v3' = v2 的保真规则 + 绝对长度目标 */
  compressPrompt?: 'v1' | 'v2' | 'v3'
  /** 仅 v3 生效：绝对长度目标下限（字符，缺省 250） */
  compressTargetMin?: number
  /** 仅 v3 生效：绝对长度目标上限（字符，缺省 450） */
  compressTargetMax?: number
  /** v11.7（opt-in，缺省 false）：把 v2/v3 压缩提示词的固定规则前缀放进 system 消息、原文放 user 消息（字节等价），让 DeepSeek Context Caching 命中规则前缀；打开后 promptVersion 追加 ':sys' */
  compressSystemPrompt?: boolean
  /** pre-step 整段 replace 时随看板带走的旧看板正文/可见回答/工具调用参数的内联总预算（字符，缺省 3000）；超出归档为句柄 */
  maxCarryChars?: number
  /** emit 仅在预计节省至少该字符数时替换（缺省 100） */
  emitterMinSavingsChars?: number
  /** emit 仅在预计字符净省比例不低于该值时替换（缺省 0.05；字符估算非 tokenizer token） */
  emitterMinSavingsRatio?: number
  /** 短期诊断开关：实际 replace 前后采样宿主 tokenMeter；默认 false，不调用模型 API */
  emitterMeasureTokens?: boolean
  /** 迟到认领：多块消息允许「已就绪块用摘要、未就绪块逐字保留」的混合认领。缺省 false（保持全覆盖铁律） */
  lateClaimPartial?: boolean
  /** 由 normalizeConfig 派生，调用方不应手填 */
  compileMode?: 'memory' | 'compress' | 'legacy'
  compileModeConflict?: { stateMemory: true; stateCompress: true; winner: 'stateMemory' }
  /** pre-step 发射器：活跃尾部宽度（≥1）、看板署名插件名、工具结果内联上限 */
  keepTail?: number
  pluginName?: string
  maxInlineToolResultChars?: number
  staticMinRawChars?: number
  emitterProducer?: string
  birthCancelOnGiveUp?: boolean
  birthDiskWaitMs?: number
  /** false disables the ledger; current in-memory evidence is still available for compilation. */
  stateSnapshot?: boolean
  stateCoveredEvidence?: boolean
  stateStructuralFirst?: boolean
  stateEvidenceLimit?: number
  stateCacheKeyTrace?: boolean
  stateProblemUnits?: boolean
  distillStream?: boolean
  /**
   * 下轮收网（Deferred Claim，实验）。v11.8 缺省 false（docs/AUDIT-V11.5.md §四 建议 ②）：
   * 关闭时 finish 处限时等待（birthFinishWaitMs + finishHeadersGraceMs）后原文放行；
   * 打开时 finish 只取已就绪结果，未就绪的进暂存区、下一轮 pre-step 认领。BOOT 的 birth.experimental 标记。
   */
  birthDeferredClaim?: boolean
  /** finish 处收网等待上限（ms，缺省 1500）。birth + deferredClaim 关时 timeoutMs 至少会被抬到 本值 + finishHeadersGraceMs + 2000 */
  birthFinishWaitMs?: number
  /** v11.6 默认 3100（成本模型自洽保本原长 2,959，见 docs/AUDIT-V11.5.md §一）。 */
  birthMinChars?: number
  /** v11.6 成本模型观测参数（只影响 birth-econ trace，不参与判定）。 */
  econCacheDiscount?: number
  econTemplateChars?: number
  econR?: number
  econCharsPerTurn?: number
  birthArchive?: boolean
  birthArchiveTimeoutMs?: number
  birthMinSavedChars?: number
  /** 归档句柄是否拼进正文。默认 true */
  birthHandleInText?: boolean
  /** CAS 归档 producer 名。默认 'cot-birth' */
  birthProducer?: string
  /** v11.7：birth finish 处 budget 到点但蒸馏已收到 200 响应头（正在生成）时再多等的上限（ms，缺省 1500；0 关） */
  finishHeadersGraceMs?: number
  birth?: {
    minChars?: number; archive?: boolean; handleInText?: boolean; producer?: string
    archiveTimeoutMs?: number; finishWaitMs?: number; minSavedChars?: number
    finishHeadersGraceMs?: number
  }
  followHostProvider?: boolean
  followProvider?: string
  settingsPath?: string

  /** checkpoint 模式：推理短于此值不发起提前调用（early-fire）。默认 800 */
  minRawChars?: number

  /** 以下四项由 normalizeConfig 填入（调用方不应手填），BOOT 上报 */
  /** 不认识的键（含嵌套容器里拼错的键，形如 'birth.finishWait'） */
  unknownOptions?: string[]
  /** 已退役、已从生效配置里删除的键（v7 四个旧开关 + v11.8 随 distill/rules 退役的键，含 'rules' 容器） */
  retiredOptions?: string[]
  /** 配置里写了已退役模式（'distill' | 'rules'）时记录原值；生效 mode 为 'off' */
  retiredMode?: 'distill' | 'rules'
  /** 配置里写了不认识的 mode 时记录原值；生效 mode 为 'off' */
  invalidMode?: unknown
  /** 自动调整留痕（目前只有 timeoutMs 抬高） */
  configAdjusted?: { timeoutMs?: { from: number; to: number; why: string } }

  /** checkpoint 模式：在 `llm/stream` 里一看到 reasoning 块结束就**非阻塞**地发起副模型调用。默认 true */
  earlyFire?: boolean
  /** 副模型单次请求硬超时（所有模式共用）。默认 8000；birth 下可能被自动抬高（见 configAdjusted） */
  timeoutMs?: number
  /** checkpoint 模式：pre-step 里最多额外等提前调用结果多久 = 用户感知延迟上限。默认 300 */
  graceMs?: number
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
export declare function resolveCompileMode(cfg: CotFormBConfig | null | undefined): 'memory' | 'compress' | 'legacy'
/** 重试退避（纯函数）：非瞬时错误返回 null（不重试），否则返回带抖动的毫秒数 */
export declare function retryDelayMs(e: unknown, attempt: number, rand?: () => number): number | null
/** compress 提示词版本唯一裁决点（BOOT / 每次编译 / trace 共用） */
export declare function compressPromptVersion(cfg: CotFormBConfig | null | undefined): string
/** v3 的绝对长度目标（字符）；非法输入回落缺省，保证 min < max */
export declare function compressTargets(cfg: CotFormBConfig | null | undefined): { min: number; max: number }
/** compress-v2 中性压缩提示词（相对长度目标 20%~35%） */
export declare function buildCompressPrompt(cot: string): string
/** compress-v3：v2 的保真规则 + 绝对长度目标 */
export declare function buildCompressPromptV3(cot: string, minChars?: number, maxChars?: number): string
/** 诊断：为何该原文认领不了 */
export declare function explainLateMiss(sessionId: string, fullRaw: string, opts?: { branchId?: string | null }): 'empty' | 'no-candidate' | 'ambiguous' | 'partial-coverage' | 'ok'
/** 混合认领（opt-in，见 lateClaimPartial） */
export declare function peekLateMemoryPartial(sessionId: string, fullRaw: string, opts?: { branchId?: string | null }): { count: number; receipt: unknown[]; texts: string[]; entries: unknown[]; partial: true; replacedChars: number; keptChars: number } | null

/** 组装三态提纯提示词（硬标签、无用户原话栏、无工具栏） */
export declare function buildDistillPrompt(cot: string): string

/** content 双兼容：纯字符串 或 [{type:'text',text}] 块数组 */
export declare function textOfContent(content: unknown): string

/** 取一条 assistant 消息里的 reasoning 文本（多块拼接） */
export declare function reasoningTextOf(message: unknown): string

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
 * @param promptOverride 自定义提示词（不传 = buildDistillPrompt(cot)）
 * @param runtime        { trace, promptVersion, flights, scope }：传输 trace、版本号贯通与精确在途共享
 */
export declare function generateDistillation(
  cot: string,
  cfg: CotFormBConfig,
  signal?: AbortSignal,
  promptOverride?: string,
  runtime?: { trace?: (tag: string, data: object) => void; promptVersion?: string; flights?: unknown; scope?: unknown },
): Promise<{ text: string; meta: DistillMeta }>

/** Cordis 插件入口 */
export declare function apply(ctx: unknown, config?: CotFormBConfig): void

/** v11.6 成本模型（纯函数，只用于观测与自测）。见 docs/AUDIT-V11.5.md §一。 */
/** v11.7：把 v2/v3 压缩提示词拆成 { system, user }，满足 system + '\n\n' + user === prompt；无 marker 返回 null */
export declare function splitCompressPrompt(prompt: string): { system: string; user: string } | null
export declare function birthEconomics(
  B: number,
  pressure: { usedTokens?: number; contextWindow?: number; source?: string } | null,
  cfg?: { econCacheDiscount?: number; econTemplateChars?: number; econR?: number; econCharsPerTurn?: number; compressTargetMax?: number },
): { B: number; R: number; rSource: string; remainingTokens: number | null; d: number; T: number; rhoMax: number; bAbs: number; bMin: number | null; netAtTarget: number; verdict: 'below-abs' | 'below-min' | 'ok' } | null
