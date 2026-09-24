// dsh-cot-form-b / config.js —— 默认参数与配置归一化
//
//   DEFAULTS         全部可在 profile patch 的 config 里覆盖（每个值的来历写在旁边）
//   normalizeConfig  扁平键 + 嵌套写法（distill: / birth:）→ 生效配置；
//                    退役键/模式、未知键、自动调整全部留痕（BOOT 可见），只报不抛
//   resolveCompileMode / compileModeOf  编译模式三选一（memory / compress / legacy）的唯一裁决点
import os from 'node:os'

// ── harness home 解析（★ 2026-09-18 公测可移植性：禁止把作者机器路径当默认值）──
// 契约与 @deepseek-ai/dsh-home-paths 的 resolveDshHome() 逐字一致（该包在 dsh 自身
// 的 node_modules 里，本插件作为 file:// 外部挂载解析不到它，故此处内联同一契约）：
//   显式传入 > $DSH_HOME（空/纯空白视为未设）> ~/.dsh
// 优先级链在本插件内为：profile 显式 config > 上面这三个 > 旧字面量（本机回退）。
export function dshHome(configured) {
  if (typeof configured === 'string' && configured.trim()) return configured
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env
  return os.homedir() + '/.dsh'
}
export function dshHomePath() {
  const segs = Array.prototype.slice.call(arguments).filter((s) => typeof s === 'string' && s)
  const base = dshHome().replace(/[\\/]+$/, '')
  return segs.length ? base + '/' + segs.join('/') : base
}

// ── 默认参数（全部可在 profile patch 的 config 里覆盖）───────────────────────
export const DEFAULTS = {
  enabled: true,
  // ★ 安全默认：dryRun 默认 true。必须先跑金丝雀观察，再由 patch 显式设 false 才合闸。
  //   这样即使 config 没被正确传入，也绝不会带电裸奔。
  dryRun: true,

  // ★★ 模式 ★★
  //   'birth'      ★ 出生即提纯（缺省，唯一生产路径）：在 llm/stream 里扣住 reasoning 块，
  //                先归档进 CAS、再由副模型压缩，然后以【普通 append】放行。
  //                为什么必须用它：0.1.5-rc.1 的 surface.js:207/234 使 assistant/message
  //                永远无法充当 surfaceOp:replace 的载体 ⇒ 事后改写被架构性禁止。
  //   'checkpoint' 实验：pre-step 用官方 user/message 看板整段替换已出站的推理（emitter.js）
  //   'off'        完全不介入，原样放行
  //   ⛔ v11.8 退役：'distill'（事后改写 assistant/message）与 'rules'（纯规则改写）——
  //      两者唯一的写回路径被 surface.js:207 永久禁止（恒为 replace-refused-h2），
  //      'distill' 还会在缺省 dryRun 下照样发起副模型调用（白花钱）。配置里出现时按 'off' 处理，
  //      BOOT 的 retiredMode 可见。代码可从 v11.7（e818cff）取回。
  //   ⚠ 缺省 dryRun:true ⇒ birth 在合闸前零调用、零改写（只落观测 trace）。
  mode: 'birth',

  // checkpoint 模式提前发起（early-fire）的最小推理长度：低于此长度不发起副模型调用。
  minRawChars: 800,

  // ── 出生即提纯（mode: 'birth'）──
  //   铁律③：先归档后压缩。归档失败 ⇒ 原样透传（原始 CoT 绝不允许因压缩而丢失）。
  birthArchive: true,
  //   低于此长度不值得归档+压缩（CAS 写盘是 async，块太小会白付 I/O 又压不动）
  // ★★ 2026-09-23 v11.6：500 → 3100（成本模型反解，见 docs/AUDIT-V11.5.md §一）★★
  //   净收益 = (R−1)·d·(B−B′) − T − 5·B′   d=0.02（缓存命中价/全价，官方价目）
  //   v3 把 B′ 钉在 ≈450、T≈460（v3 前缀实测）、R=60（2026-09-24 用户拍板；原值 55 为生产实测压缩间隔）：
  //     自洽保本原长 B = 2,747 ⇒ 仍保守取 3,100（门槛不下调：实测 token/账单未到手前不放松闸门）。
  //   绝对下界 B_abs = T/((R−1)·d) = 426：低于它无论压多狠都亏。旧值 500 贴着下界。
  //   最坏情况：短块不再压缩 = 宿主原生行为（已知安全态）。
  birthMinChars: 3100,
  //   把 CAS 句柄附在压缩文本尾部，给模型留一条「可回查」的路
  birthHandleInText: true,
  //   CAS 归档的 producer 标签（事后可按来源检索）
  birthProducer: 'cot-birth',
  //   CAS 写盘超时护栏：卡住就当归档失败处理（原样透传），绝不许拖死模型流
  birthArchiveTimeoutMs: 3000,
  //   ★ P0-2：内存预推句柄的读回验证上限。只在「store 说成功但没给句柄」这条罕见分支上花这个时间；
  //     超时 = 不可证 ⇒ 当归档失败、保留原文（绝不用一根没验证过的地址顶替原文）。
  birthHandleProbeTimeoutMs: 800,
  // ★ 方案一（流式双轨）2026-09-18 终审锁定 —— finish 处收尾等待硬上限。
  //   块尾**不阻塞主流**：reasoning delta 实时透传、text/tool 实时透传，
  //   只有 finish 前的收网最多等这么久，到点立即熔断，放行 raw + 句柄。
  birthFinishWaitMs: 1500,
  // ★★ 方案二「下轮收网」（Deferred Claim，实验）★★
  //   打开后：没赶上 finishWaitMs 的结果进暂存区，在下一轮 pre-step 用官方
  //   user/message + surfaceOp replace 收网（finish 处只取已就绪结果，不等待）。
  //   ⚠ v11.8 缺省改为 false（docs/AUDIT-V11.5.md §四 建议 ②，与线上配置一致）：
  //     当轮阻塞的最坏情况是确定的（等满 finishWaitMs 后原文放行）；late-claim 的最坏情况是
  //     部分认领 / 歧义匹配（缺陷 B）/ 重启丢失，且替换已出站块的缓存代价至今无定论。
  //     打开时 BOOT 的 birth.experimental=true。
  birthDeferredClaim: false,
  //   净省保本线：蒸馏稿 + 句柄必须比原文少 ≥ 这么多字符才允许替换。
  //   低于此线说明模型在抄书（没完成有效浓缩）⇒ 原样放行 raw + 句柄。
  birthMinSavedChars: 50,

  // ── 延迟预算 ──
  // ★ 提前发起（early-fire，仅 checkpoint 模式）：在 llm/stream 里一看到 reasoning 块结束就
  //   **非阻塞**地拉起副模型调用，pre-step 到达时结果通常已经就绪。
  earlyFire: true,
  // 副模型单次请求的硬超时（所有模式共用；birth 下会按 finishWaitMs 自动抬高，见 normalizeConfig）
  timeoutMs: 8000,
  // checkpoint 模式：pre-step 里最多额外等 early-fire 结果多久（= 用户感知延迟上限）
  graceMs: 300,
  // 重试 4 → 1。退避 1200×attempt 会让"抖动一次 + 两次重试"多出 3.6 秒。
  maxAttempts: 1,
  // ★ v11.7 对冲请求：主请求 N ms 内未收到响应头就再发一份相同请求，谁先回头用谁（见 hedgedDistill）。
  //   0 = 关闭（缺省，行为与 v11.6 完全一致）。建议值 ≥ TTFB p50（实测 3000）：只对尾部对冲。
  //   仅 maxAttempts ≤ 1 时生效（重试与对冲叠加会让并发失控）。
  hedgeAfterMs: 0,
  // ★ v11.7 收尾宽限：finish 处 budget 到点时若蒸馏**已收到响应头**（排队已结束、正在生成），
  //   再多等最多这么久。实测 contentSpanMs 137~1,267ms ⇒ 此刻放弃最亏。0 = 关闭。
  finishHeadersGraceMs: 1500,

  // ── 传输层（2026-09-15 杠杆 3：连接复用 / 预热）──────────────────────────
  // 实测（本机 → 当时使用的商户端点，见 deploy/probe/_probe-keepalive-win.mjs）：
  //   冷连接 TTFB p50 = 676 ms（DNS 2.6 + TCP 187 + TLS 199 + 网关路由）
  //   复用连接 TTFB p50 = 265 ms（connect 0.5 ms）⇒ **单次省 411 ms**
  // ⚠ 但**进程内第一次调用永远是冷的** —— 没有东西可复用。
  //   我们实测的那次 3,882 ms 恰好就是进程内第一次调用 ⇒ 光开 keepAlive 省 0 ms。
  // ⇒ 所以必须配 `prewarm`：在插件启动 / 每个 pre-step 之前，
  //   用一次 HEAD 请求把 socket 提前捂热，让**第一次真正的调用也能复用**。
  //   （HEAD / 与 POST /v1/chat/completions 同 host:port ⇒ 同一个 freeSockets 键，已实测跨路径复用）
  keepAlive: true,
  keepAliveMsecs: 60000,
  // ★★ 2026-09-21 默认改为 **false**（三组对照实测，见 deploy/probe/_probe-prewarm-3way.mjs）★★
  //   判据是【预热启动 → 蒸馏完成】的总时间，不是 POST 的 connectMs：
  //     none  n=3  ★总 p50=1827ms   复用率 0/3
  //     old   n=3  ★总 p50=2408ms   复用率 0/3   （打 /v1/ ⇒ 404）
  //     new   n=3  ★总 p50=2082ms   复用率 3/3   （打 origin ⇒ 200）
  //   ⇒ 新路径**确实修好了复用**（3/3），也**确实比旧路径好**（2082 < 2408），
  //     但**仍然比"什么都不做"慢**（2082 > 1827）：HEAD 自身要 344~1002ms，
  //     省下的建连只有几百毫秒 —— 没有省回来，部分只是把等待搬到了前面。
  //   ⇒ 故默认关闭。连接复用改由【正常业务流量】自然维持（连续蒸馏之间本就复用，已实测）。
  //     旧注释"HEAD 把 socket 提前捂热让第一次调用也能复用"已被上述总时间数据推翻。
  prewarm: false,
  // 两次预热之间的最小间隔（毫秒）；池里已有空闲 socket 且未超此间隔则不重复预热
  prewarmMinGapMs: 20000,
  // ★★ 2026-09-23 v11.6：1200 → 850，且**恒定、不随输入放大**★★
  //   v3 目标 250~450 字符 ≈ 200~400 token，×2 安全系数 = 850。
  //   为什么不按输入派生：输出上限随输入增长 ⇒ 允许的 B′ 变大 ⇒ 与「ρ 越小净收益恒增」反向。
  //   仍打满 finish=length ⇒ 原文放行 + trace（说明 v3 目标对该块不可达），不放宽、不分段。
  maxOutputTokens: 850,

  // 伴生调用
  // ★★ 2026-09-19 公测加固：原为作者商户端点字面量 ★★
  //   两个问题，同一行：
  //   ① 泄漏：把本机使用的商户端点写进了可分发的代码。
  //   ② 与自身契约矛盾：上面 followHostProvider 段写着"解析不出来**不猜**"，
  //      但"回落到上面的 baseUrl"这个回落目标却是作者自己的商户 ⇒ 外人装上后，
  //      宿主 provider 不是作者那家商户时会去连一个不属于他的端点：连不上，且暴露来源。
  //   改为空串 = 没有端点 ⇒ 提纯不发起、原文放行（与 no-model 抛错路径完全同形）。
  //   本机行为不变：profile 显式 baseUrl 与 followHostProvider 解析两条路照旧。
  baseUrl: '',
  // ★★ 提纯用哪个模型：**跟着宿主对话模型走**（2026-09-15 用户拍板）★★
  //   「宿主用哪个模型对话，我们就用那个模型压缩。」
  //   ⇒ `model` 留空 = 不指定；运行期从 `llm/stream` 的 options.model 实时读取宿主模型。
  //   ⇒ 不写死任何具体模型名（写死的名字都是从商户目录里挑的，身份不可核实）。
  //   ⇒ 读不到宿主模型时**不猜**：直接放弃提纯、原文放行，并把原因落 trace。
  model: '',
  // 是否跟随宿主模型（关掉则必须显式给 `model`，否则不发起提纯）
  followHostModel: true,
  // ★★ 必须关掉「思考」★★（2026-09-15 实测，这是本模块最重要的一条运行时约束）
  //   宿主对话模型是**思考型**：它会把整个 max_tokens 烧在 `reasoning_content` 上，
  //   然后 `content` 返回空串、finish_reason='length' ⇒ 提纯失败 + 白花一次调用 + 白等 7~19 秒。
  //   实测（真实 CoT，同一提示词，max_tokens 1200）：
  //     基线（不关思考）            6,952ms  finish=length  content   0  reasoning 3,453
  //     reasoning_effort='none'     5,048ms  finish=stop    content 612  reasoning 1,591
  //     thinking={type:'disabled'}  3,746ms  finish=stop    content 401  reasoning     0  ← 采用
  //     enable_thinking=false       6,652ms  finish=length  content   0  reasoning 3,399
  //     chat_template_kwargs        7,123ms  finish=length  content   0  reasoning 4,260
  //   关掉之后（真实 CoT 2,400 / 6,803 字符）：2,402~2,632ms，content 280~456，reasoning 0。
  //   ⇒ **不用换模型，只要把思考关掉**；比旧行为快 2.7 倍，且耗时不再随输入变长而增长。
  disableThinking: true,
  // ★★ 2026-09-21 观测型流式迁移（外部审计 P0-1）★★
  //   默认 **false** —— 保持既有生产行为不变，必须先显式打开才走 SSE。
  //   打开后：插件与蒸馏服务之间改用 stream:true；会话协议 / 用户可见行为 / 兜底语义全不变。
  //   目的只是把"响应到达前的等待"与"可见输出阶段"分开，为下一刀提供证据。
  distillStream: false,
  // ★★ 2026-09-22 开关切分（用户令）："压缩"与"状态记忆"原本焊死在 stateMemory 一个开关上 ★★
  //   实测病征（本机 trace.log，27 次副编译）：
  //     要压缩的原文（birth-fired.rawChars）  均值  5,371   合计   145,009
  //     实际发出的 prompt（promptChars）      均值 40,522   合计 1,094,097
  //                                            ⇒ 放大 7.5x，其中工具正文占 58.7%
  //   根因：触发粒度是「每段 reasoning 结束」，输入范围却是「整个 60 节点证据窗口」。
  //     每编译 5,371 字符的推理，就要重发 23,800 字符的窗口证据。
  //   后果：副模型手握 23K 工具正文 + 11K 其他材料写两栏判断 ⇒ 1200 输出上限必然不够
  //     ⇒ finish=length 60% / timeout 30% ⇒ 27 次里 0 次替换成功。
  //   切分后两者互不拖累：
  //     stateCompress → 输入=这段 reasoning，输出=它的摘要。**真压缩**
  //     stateMemory   → 证据账本 + 状态快照 + 判断编译。**状态记忆**
  //   ⚠ 两者仍共用同一条传输/重试/超时/取消机制（仍是**一次**模型调用）。
  //   ⚠ 同时打开时 stateMemory 优先（它的产物已是判断稿，不再做二次摘要）。
  //   ⚠ 两者都开：normalizeConfig 记录 compileModeConflict（BOOT 里可见）并按 stateMemory 生效；不抛错。
  stateMemory: false,
  // ★ 纯压缩：把这段 reasoning 改写成更短的摘要。与 stateMemory 独立开关。
  //   输入 ≈ 本段推理，不背整窗证据 ⇒ 输入体量回到设计预期，压缩率可核。
  stateCompress: false,
  // compress 提示词版本：
  //   'v2' 中性压缩（缺省）—— 保真规则 + **百分比**长度目标（20%~35%），输出随输入线性增长
  //   'v1' 与 legacy 蒸馏逐字相同（三栏裁决式；回滚/对照用）
  //   'v3' = v2 的保真规则 + **绝对值**长度目标（见 compressTargetMin/Max）
  //        动机（2026-09-23 本机实测）：v1 的输出长度几乎不随输入变化（输入 892→9,794，输出仅 403→801），
  //        而 v2 稳定贴住输入的 30%。二者在 <1,500 输入时输出几乎同长（v2 甚至更短：344 vs 403）
  //        ⇒ **保真规则本身不花长度**，长度差异 100% 来自第 7 条目标口径。v3 即「v2 的规则 + v1 的口径」。
  compressPrompt: 'v2',
  // v3 专用的绝对长度目标（字符）。只影响 v3；v1/v2 不看这两项。
  //   为什么用绝对值：百分比对小输入是灾难（900 字符按 20% 压到 180 必然丢信息），绝对值不会。
  compressTargetMin: 250,
  compressTargetMax: 450,
  // ★ v11.7 缓存友好拆分（opt-in）：把压缩提示词的**固定规则前缀**放进 system 消息、原文放 user 消息。
  //   DeepSeek Context Caching 按「缓存前缀单元」整段匹配（官方 kv_cache 文档 Example 1：system+user 形状），
  //   现状 461 字符规则与原文挤在同一条 user 消息里 ⇒ 实测 prompt_cache_hit_tokens 恒为 0。
  //   拆分后规则前缀成为稳定单元 ⇒ 每次压缩调用的前缀按 0.02 价计。**提示词文字一个字节不变。**
  //   缺省关闭：v3 是在「全部放 user」的形状下实测的，system/user 拆分是否影响输出需 A/B；
  //   打开后 promptVersion 追加 ':sys'，trace 自动分桶。
  compressSystemPrompt: false,
  // pre-step 整段 replace 时，随看板带走的旧看板正文/可见回答/工具调用参数的内联总预算（字符）；超出归档为句柄
  maxCarryChars: 3000,
  // 只在估算至少节省 100 字符且 5% 时才替换；不满足就保留原始 surface，避免"压缩"后反增。
  emitterMinSavingsChars: 100,
  emitterMinSavingsRatio: 0.05,
  // 默认关闭；短期诊断时在实际 surface append 前后读宿主 tokenMeter，不发模型请求。
  emitterMeasureTokens: false,
  // ★ P0-2：checkpoint 发射前抽样做几次「按句柄读回」验证（1 页）。句柄是这条路径唯一写进模型
  //   上下文的地址，写成功 ≠ 读得回（跨 session / 配额驱逐 / 公式漂移 ⇒ 死指针，且静默）。
  //   只有**正面证伪**才拦住发射；设 0 = 关闭抽样（无读 API 的宿主自动退化为只记录）。
  emitHandleProbeMax: 2,
  // ★ 迟到认领：多块消息允许「已就绪块用摘要、未就绪块保留原文」的混合认领。缺省 false（保持全覆盖铁律）。
  lateClaimPartial: false,
  // 证据采集只看最后 N 个 surface 节点：**关联优先，不全文堆积**
  // ⚠ 只在 stateMemory 打开时才进入编译输入；stateCompress 不采集证据。
  stateEvidenceLimit: 60,
  // ★ 编译输入止血（2026-09-22）：已覆盖的旧工具证据不再重复发送。
  //   此字段只控制旧兼容路径；默认 hybrid 不再依赖模型覆盖集合。
  stateCoveredEvidence: true,
  stateSnapshot: true,
  // Legacy-only options below; hybrid birth bypasses old body views and lanes.
  // ★ 结构性上下文跨窗口检索（2026-09-22，A 方案）。
  //   设 false 可一键回滚到「只看最后 N 个节点」的旧行为。
  // ★ A 方案（跨窗口结构节点检索）**默认关闭**（2026-09-22 用户裁定"暂不上线"）。
  //   实测：priorMemory 0→0、userAsks 3→9、prompt.total 26381→30092（+3711），净负。
  //   代码与诊断字段全部保留，随时可开（stateStructuralFirst: true）。
  stateStructuralFirst: false,
  // 是否把缓存身份写进 trace（默认关，避免噪音；打开便于排查"为什么复用了旧摘要"）
  stateCacheKeyTrace: false,
  // 问题单元：把散在六栏里、属于同一问题的信息归拢（只归拢已有材料，不新增事实）
  stateProblemUnits: true,
  // ★ 2026-09-19：原为作者商户的钥匙名，同样去具体化。
  //   留空 ⇒ 钥匙只能来自 followHostProvider 解析出的 apiKeyEnv 或显式配置。
  credentialRef: '',
  // ★ 2026-09-18 公测可移植性：原为作者机器字面量，改成 harness home 推导；
  //   profile 里显式给值仍然优先，本机行为不变。
  credentialsPath: dshHomePath('.credentials.yaml'),
  // ★★ 2026-09-17 端点/钥匙也跟随宿主 provider（禁止硬编码）★★
  //   实测根因：followHostModel 只重写【模型名】（当时 index.js:1300，现 plugin.js 的 llm/stream 钩子），端点与钥匙被钉死在
  //   作者那家商户（baseUrl/credentialRef）。宿主 provider 一旦不是它
  //   （本机 settings.yaml:50-52 agent-default-model.provider = 'open'），
  //   提纯就发到一个不承载该模型路由的商户上 ⇒ 40 次全部打满 timeoutMs（tookMs 8002~8012）。
  //   ⇒ 打开本开关后，端点在运行期从**宿主自己的** provider 表解析：
  //       settings.yaml → llm-pi-ai.providers.<hostProvider> → { api, baseURL, apiKeyEnv }
  //       .credentials.yaml → <apiKeyEnv>
  //   ⇒ 解析不出来**不猜**：明确回落到上面的 baseUrl/credentialRef，并把结果落 trace。
  followHostProvider: true,
  // 宿主 provider 表位置（与宿主同源读取；只读，不改写、不复制端点）
  settingsPath: dshHomePath('settings.yaml'),

  // 观测
  traceFile: dshHomePath('storages', 'cot-form-b', 'trace.log'),
  trace: true,
}

// ── 配置归一化：同时接受扁平键与嵌套写法 ─────────────────────────────────────
// 用户配置规范（profile 的 cordis.patch.yml → config）：
//   mode: "birth" | "checkpoint" | "off"
//   distill: { timeoutMs, maxOutputTokens, hedgeAfterMs, ... }   ← 副模型传输参数
//   birth:   { minChars, finishWaitMs, finishHeadersGraceMs, ... }
// 嵌套对象里的键**覆盖**同名扁平键。不认识的键不报错，但进 unknownOptions（BOOT 可见）；
// 退役的键/模式进 retiredOptions / retiredMode，并从生效配置里删除。
const NESTED_DISTILL_KEYS = ['timeoutMs', 'minRawChars', 'maxAttempts', 'maxOutputTokens', 'baseUrl', 'model', 'credentialRef', 'credentialsPath', 'graceMs', 'keepAlive', 'keepAliveMsecs', 'prewarm', 'prewarmMinGapMs', 'followHostModel', 'disableThinking', 'hedgeAfterMs']
const NESTED_BIRTH_KEYS = ['minChars', 'archive', 'handleInText', 'producer', 'archiveTimeoutMs', 'finishWaitMs', 'minSavedChars', 'finishHeadersGraceMs']
// 退役键：v7 四个旧生产开关 + v11.8 随 'distill'/'rules' 模式退役的键（含整个 rules: 容器）
const RETIRED_OPTIONS = ['stateEvidenceViews', 'stateEvidenceBodyBudget', 'stateSnapshotMirror', 'stateCompileQueue',
  'hurdleRounds', 'templateChars', 'maxVerbatimChars', 'skeletonizeArgs', 'skeletonMinChars', 'skeletonKeepHead', 'skeletonKeepTail',
  'rulesEnabled', 'rulesFoldRuns', 'rulesDropDuplicateLines', 'rulesMinSavedChars', 'rulesRequireArchive', 'rules']
const RETIRED_NESTED_DISTILL = ['hurdleRounds', 'templateChars', 'maxVerbatimChars']
const RETIRED_MODES = ['distill', 'rules']
const MODES = ['birth', 'checkpoint', 'off']

export function normalizeConfig(config = {}) {
  const c = Object.assign({}, DEFAULTS, config)
  const d = config && config.distill
  if (d && typeof d === 'object') {
    for (const k of NESTED_DISTILL_KEYS) {
      if (d[k] !== undefined) c[k] = d[k]
    }
  }
  const b = config && config.birth
  if (b && typeof b === 'object') {
    if (b.minChars !== undefined) c.birthMinChars = b.minChars
    if (b.archive !== undefined) c.birthArchive = b.archive
    if (b.handleInText !== undefined) c.birthHandleInText = b.handleInText
    if (b.producer !== undefined) c.birthProducer = b.producer
    if (b.archiveTimeoutMs !== undefined) c.birthArchiveTimeoutMs = b.archiveTimeoutMs
    if (b.probeTimeoutMs !== undefined) c.birthHandleProbeTimeoutMs = b.probeTimeoutMs
    if (b.finishWaitMs !== undefined) c.birthFinishWaitMs = b.finishWaitMs
    if (b.minSavedChars !== undefined) c.birthMinSavedChars = b.minSavedChars
    if (b.finishHeadersGraceMs !== undefined) c.finishHeadersGraceMs = b.finishHeadersGraceMs
  }
  // 模式：退役模式按 'off' 处理（它们本来就无法改写任何东西）；不认识的值同样按 'off'
  //   —— 绝不把拼错的模式名「猜」成一个会改写会话的模式。两种情况都在 BOOT 里可见。
  if (RETIRED_MODES.includes(c.mode)) { c.retiredMode = c.mode; c.mode = 'off' }
  else if (!MODES.includes(c.mode)) { c.invalidMode = c.mode; c.mode = 'off' }
  c.retiredOptions = RETIRED_OPTIONS.filter(k => Object.hasOwn(config || {}, k))
  if (d && typeof d === 'object') for (const k of RETIRED_NESTED_DISTILL) if (Object.hasOwn(d, k)) c.retiredOptions.push('distill.' + k)
  for (const k of c.retiredOptions) delete c[k]
  // ★ 未知键不再静默吞掉：拼错的键（如 finishWaitMs 扁平写法）进 unknownOptions，BOOT 里可见。
  //   只报不删 —— 不改变任何既有合法行为；嵌套容器键与运行期注入键都在白名单里。
  {
    const known = new Set([
      ...Object.keys(DEFAULTS),
      'distill', 'birth',                             // 嵌套别名容器
      'compileMode', 'compileModeConflict', 'configAdjusted', 'retiredOptions', 'unknownOptions',
      'retiredMode', 'invalidMode', 'followProvider', '_promptMessages', '_onHeaders',
      'keepTail', 'pluginName', 'maxInlineToolResultChars', 'staticMinRawChars', 'emitterProducer',
      'birthCancelOnGiveUp', 'birthDiskWaitMs',
      'econCacheDiscount', 'econTemplateChars', 'econR', 'econCharsPerTurn',
      ...c.retiredOptions,                            // 退役键算已知（另有专门报法）
    ])
    c.unknownOptions = Object.keys(config || {}).filter((k) => !known.has(k))
    // 嵌套容器里拼错的键同样要报（如 birth: { finishWait: 6000 } 会被静默忽略）
    for (const [box, keys] of [['distill', [...NESTED_DISTILL_KEYS, ...RETIRED_NESTED_DISTILL]], ['birth', NESTED_BIRTH_KEYS]]) {
      const v = config && config[box]
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of Object.keys(v)) if (!keys.includes(k)) c.unknownOptions.push(box + '.' + k)
      }
    }
  }
  c.compileMode = resolveCompileMode(c)
  // ★★ 2026-09-23 v11.6 缺陷 D：timeoutMs 是请求硬顶，finishWaitMs 是收尾等待。★★
  //   实测 finishWaitMs 8000→12000→20000 命中率恒为 23.1%，因为 timeoutMs(8000) 先杀了请求。
  //   只抬不降：timeoutMs < finishWaitMs + 响应头宽限 + 收尾余量(2000) 时抬到该值，并在 BOOT 里留痕。
  //   v11.7 起 finish 最多等 finishWaitMs + finishHeadersGraceMs，宽限也必须算进去，
  //   否则 grace 调大后请求会先被 timeoutMs 杀掉（宽限形同虚设）。
  //   已满足的配置（如线上 20000 ≥ 12000+1500+2000）零变化。
  if (c.mode === 'birth' && c.birthDeferredClaim !== true) {
    const grace = Number(c.finishHeadersGraceMs)
    const need = Number(c.birthFinishWaitMs) + (Number.isFinite(grace) && grace > 0 ? grace : 0) + 2000
    if (Number.isFinite(need) && Number.isFinite(Number(c.timeoutMs)) && Number(c.timeoutMs) < need) {
      c.configAdjusted = Object.assign({}, c.configAdjusted, { timeoutMs: { from: c.timeoutMs, to: need, why: 'timeoutMs < birthFinishWaitMs + finishHeadersGraceMs + 2000' } })
      c.timeoutMs = need
    }
  }
  if (c.stateMemory === true && c.stateCompress === true) {
    // 绝不静默二选一：用户显式配了两个互斥目标，就在 BOOT 里报出来，并明确谁生效。
    c.compileModeConflict = { stateMemory: true, stateCompress: true, winner: 'stateMemory' }
  }
  return c
}

/**
 * ★★ 2026-09-22 开关切分：把「压缩」与「状态记忆」的裁决收到一处。★★
 *
 * 背景：这两件事原本并排在同一个 stateMemory 开关下，导致
 *   · 想要压缩的人打开 stateMemory，拿到的却是「整窗证据 → 状态判断」的编译；
 *   · 编译输入 40,522 字符去压 5,371 字符的推理（7.5x），输出上限 1200 必然不够。
 *
 * 现在三个互斥模式，唯一裁决点：
 *   'memory'   stateMemory   → 证据账本 / 快照 / 两栏判断（状态记忆）
 *   'compress' stateCompress → 本段 reasoning 的摘要（纯压缩）
 *   'legacy'   都没开        → 走进度条式的旧蒸馏提示词（保持既有行为）
 *
 * @returns {'memory'|'compress'|'legacy'}
 */
export function resolveCompileMode(cfg) {
  if (!cfg) return 'legacy'
  if (cfg.stateMemory === true) return 'memory'
  if (cfg.stateCompress === true) return 'compress'
  return 'legacy'
}

/**
 * ★ 2026-09-22 容错读取：birthStart / birthFinish 可能收到**未经 normalizeConfig** 的 cfg
 *   （裸库直调、旧回归夹具就是这么传的）。
 *   若直接读 cfg.compileMode，缺字段时一律落到 undefined ⇒ 静默走 legacy，
 *   而这正是本仓库栽过多次的「配了却没生效」。所以这里缺字段就地裁决。
 */
export function compileModeOf(cfg) {
  if (!cfg) return 'legacy'
  return cfg.compileMode != null ? cfg.compileMode : resolveCompileMode(cfg)
}
