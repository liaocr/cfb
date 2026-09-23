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
   * true = 只判定、只写 trace，不真的 replace。灰度观察用。默认 true
   *
   * 回滚优先级：① dryRun=true → ② rulesEnabled=false → ③ mode='off' → ④ 摘掉插件
   */
  dryRun?: boolean

  /**
   * ★ 三级模式（2026-09-15 用户主权开关）。
   *   'distill'（默认）伴生提纯 ~67%；未就绪 / 超时 / 未保本 ⇒ 自动降级 rules
   *   'rules'   纯规则：零网络、零 await、同步 <10ms
   *   'off'     完全不介入，原样放行
   */
  mode?: 'distill' | 'rules' | 'birth' | 'checkpoint' | 'off'

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
  birthDeferredClaim?: boolean
  /** Legacy maximum (1500ms); hybrid birth only uses already-ready results. */
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
  birth?: {
    minChars?: number; archive?: boolean; handleInText?: boolean; producer?: string
    archiveTimeoutMs?: number; finishWaitMs?: number; minSavedChars?: number
  }
  followHostProvider?: boolean
  followProvider?: string
  settingsPath?: string

  /**
   * 防线①：触发门槛。raw 思维链短于此值**不发起伴生调用**。默认 800。
   *
   * ⚠ 低于门槛**不等于不压缩**：会降级走纯规则（规则档零成本）。
   * 800 = `breakevenRaw(4) = 774` 的保守取整；自测锁死 `minRawChars >= breakevenRaw(hurdleRounds)`。
   */
  minRawChars?: number
  /** 防线③：保本不等式的结构轮数 =「这块之后还会被携带几轮」的保守假设。默认 4 */
  hurdleRounds?: number
  /** 防线③：不等式里的提示词模板量级。默认 500 */
  templateChars?: number

  /** 防线④：机械注入的用户原话上限（超限保留头 60% + 尾 40%）。默认 600 */
  maxVerbatimChars?: number

  /** 纯规则档总开关。默认 true */
  rulesEnabled?: boolean
  /** 纯规则档：游程折叠（连续 ≥3 行「已验证 OK」折成区间；含稀有实体的行永不折叠）。默认 true */
  rulesFoldRuns?: boolean
  /** 纯规则档：逐字重复行只留第一次。默认 true */
  rulesDropDuplicateLines?: boolean
  /** 纯规则档：削减不足此百分比就不做替换。默认 10 */
  rulesMinSavingPct?: number

  /**
   * ★ 提前发起：在 `llm/stream` 里一看到 reasoning 块结束就**非阻塞**地拉起伴生调用，
   * 用「模型自己生成工具参数的那段时间」消化掉那 5.4 秒。默认 true。
   *
   * ⚠ 这不违反 H2：提前发起只把**结果准备好**，落盘仍只发生在那个 pre-step 里。
   */
  earlyFire?: boolean
  /** 伴生调用自身的超时。默认 8000 */
  timeoutMs?: number
  /** ★ pre-step 里最多额外等多久 = **用户感知延迟的上限**。默认 300 */
  graceMs?: number
  maxAttempts?: number
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
   * 读不到宿主模型且 `model` 为空 ⇒ **不猜**，放弃提纯、降级 rules（原因落 trace）。
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

/**
 * 配置归一化：同时接受扁平键与用户文档里的嵌套写法（`distill: {...}` / `rules: {...}`）。
 * 嵌套键覆盖同名扁平键；非法 `mode` 回落到 `'distill'`（绝不带电裸奔）。
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

/** 机械截取：超限保留头 60% + 尾 40% */
export declare function sliceVerbatim(text: string, maxChars: number): string

/**
 * ⚠ 实测形状差异（2026-09-15 金丝雀抓出）：
 *   assistant/message → 消息挂在 `data.message`
 *   user/message      → 没有 `data.message`，字段平铺在 `data` 上
 */
export declare function messageOfEvent(e: unknown): Record<string, unknown> | null

/** content 双兼容：纯字符串 或 [{type:'text',text}] 块数组 */
export declare function textOfContent(content: unknown): string

/** 取「目标 seq 之前最后一条**人类** user/message」（排除 plugin / skill-catalog 等系统注入） */
export declare function findLastUserMessage(
  sessionLog: unknown[],
  beforeSeq: number,
): { text: string; kind: string | null; seq: number } | null

/** 从会话日志里取「目标 seq 之前最后一条 user/message」的文本 */
export declare function findLastUserText(sessionLog: unknown[], beforeSeq: number): string

/** 把「机械注入的用户原话」与「模型产出的三态结算单」拼成最终替换文本 */
export declare function assembleCheckpoint(distilled: string, verbatim: string): string

/** 防线③ 保本后验不等式：(raw - final) × R > template + raw + final（同时覆盖防线②） */
export declare function passesHurdle(
  rawChars: number,
  finalChars: number,
  cfg: Pick<Required<CotFormBConfig>, 'hurdleRounds' | 'templateChars'>,
): { pass: boolean; saved: number; lhs: number; rhs: number }

/** 拟合式 `final ≈ a·raw + b` 的系数（三点拟合，774 那个数由它反解而来） */
export declare const FIT: { a: number; b: number }

/**
 * 由保本不等式反解出的保本原长（取 floor+1，因为恰好整除时等式取等号不通过）。
 *
 * `breakevenRaw(4) = 774` —— 本模块的默认轮数，门槛 800 由它取整而来。
 *
 * ⚠ 这个函数现在的用途**只剩一个**：它是 `minRawChars` 的唯一推导来源，
 *   自测用它锁死「门槛 ≥ 保本原长」，防止以后有人手改门槛而不同步改轮数。
 *   `breakevenRaw(3) = 1201` 只是参考值 —— 那是「延迟一轮替换」所需门槛，
 *   而延迟替换已被终审否决（H2 首次出站不变律，见 index.js 顶部注释）。
 */
export declare function breakevenRaw(
  hurdleRounds: number,
  cfg?: Pick<Required<CotFormBConfig>, 'templateChars'>,
): number

/** 取一条 assistant 消息里的 reasoning 文本（多块拼接） */
export declare function reasoningTextOf(message: unknown): string

/** 取一条 assistant 消息里的 tool-call 块（原样保活） */
export declare function toolCallsOf(message: unknown): unknown[]

/** 新 reasoning 置顶，其余非 reasoning 块原序保活 */
export declare function rebuildContent(message: unknown, newReasoningText: string): unknown[]

/** 会话日志里最后一条 assistant/message 事件 */
export declare function findLastAssistantEvent(sessionLog: unknown[]): unknown | null

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
 * 发起伴生提纯调用。返回 { text, meta }。
 *
 * ⛔ `cfg.model` 为空时**直接抛错**（`no model: ...`），绝不猜模型名 ——
 *    上层据此降级 rules。这是「跟随宿主模型」的执行机构。
 */
export declare function generateDistillation(
  cot: string,
  cfg: CotFormBConfig,
): Promise<{ text: string; meta: DistillMeta }>

/** Cordis 插件入口 */
export declare function apply(ctx: unknown, config?: CotFormBConfig): void

/** v11.6 成本模型（纯函数，只用于观测与自测）。见 docs/AUDIT-V11.5.md §一。 */
export declare function birthEconomics(
  B: number,
  pressure: { usedTokens?: number; contextWindow?: number; source?: string } | null,
  cfg?: { econCacheDiscount?: number; econTemplateChars?: number; econR?: number; econCharsPerTurn?: number; compressTargetMax?: number },
): { B: number; R: number; rSource: string; remainingTokens: number | null; d: number; T: number; rhoMax: number; bAbs: number; bMin: number | null; netAtTarget: number; verdict: 'below-abs' | 'below-min' | 'ok' } | null
