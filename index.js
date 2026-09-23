import { createExactFlights } from './exact-flights.js'
import { createConsumptionMeter } from './consumption.js'
import { prepareCompilerEvidence, prepareJudgmentPrompt, JUDGMENT_PROMPT_VERSION } from './evidence-ledger.js'
import { selectEvidenceViews, validReceipt } from './evidence-views.js'
// dsh-cot-form-b —— 形态 B（通道一）：尾部即时思维链提纯
//
// 人话：模型这一轮写完思维链后，当场把它压成一份「状态结算单」，
//       再用官方通道把历史里那条又长又啰嗦的思维链换掉，
//       这样后续每一轮都不用再重复携带它。
//
// 通道（实测已通）：
//   session.append('assistant/message', {turn, step, message}, {
//     surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
//     sourceEventSeqs: [seq],
//   })
//   ⇒ 保持原生 assistant 角色；tool-call 块原样保活；原文留在落盘日志；UI 零污染。
//
// ─────────────────────────────────────────────────────────────────────────────
// 五道防线（全部为纯物理判据，不做任何"未来会怎样"的预测）
// ─────────────────────────────────────────────────────────────────────────────
//   ① 触发门槛      raw < minRawChars(800) → 不发起伴生调用（省延迟、省调用）
//                   800 = R=4 保本原长（三点拟合：774，保守取整）
//   ② 防增肥        final >= raw → 放弃替换
//   ③ 保本后验      (raw - final) × hurdleRounds > templateChars + raw + final
//                   这是①的同一个不等式，只是用**实测的** final 再验一次。
//                   它包含②；单独用②不够（raw=5000/final=4900 会漏过）。
//   ④ 原话机械注入  用户原话绝不让模型背诵/翻译，由本模块从宿主消息里字符串截取。
//                   定位是「提升显著性」，不是「防止丢失」——用户原话本来就
//                   原封不动留在历史里（replace 只动 assistant）。
//   ⑤ 契约焊死      三态硬标签；无内容整栏省略；严禁软性措辞。
//
// ⚠ 口径纪律（写在代码里，防以后被误读）：
//   本模块只做「字符数」判定。字符数不是钱。
//   ★ 2026-09-18 状态更新：d_eff 已实测（原文写「至今未测」，现已作废）。
//     官方价格参数（用户提供）：输入 : 输出 : 缓存 = 1 : 4 : 0.02
//     独立复现（e1d/e1e 账单差分，见 docs/d-eff-result.md）：
//       d_hit  = 0.0223  （缓存命中单价 / 全价）
//       d_miss = 0.9981  （实测全价 ≈ 官方 1，偏差 0.19%）
//       d_eff  ≈ 0.032   ⇒ 字符→钱的杠杆 ≈ 2.4×（不是 74×；74× 是「0 缓存」的幻觉）
//     结论变化：外置到 CAS 省不了多少钱（杠杆只有 ~2.4×），
//     它的正当性必须建立在**质量/可读性**上，不能建立在省钱上。
//   ⇒ 但本模块的 trace 字符数**仍然不得**被当作 cost savings：
//     字符 → token → 钱 的换算还缺一个可信的字符/token 比，
//     且 §九 硬规矩#0 禁止把商户缓存信息（命中率/cache_hit_tokens）引入任何计算。
// ─────────────────────────────────────────────────────────────────────────────
import { createCompileLanes } from './compile-lane.js'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { compressByRules } from './rules.js'
import { runPreStepEmit, toolTextFromEvent, LEDGER_OPEN } from './emitter.js'
import {
  buildEvidenceEnvelope, buildStateCompilePrompt as buildStateCompilePromptSafe, promptStats,
  parseStateCompile, createMemoryProjection, renderBirth, renderCheckpoint, memoryStats,
  adaptEvidence, mergeOrdered, cacheIdentity, classifySource, SOURCE,
  normalizeEvidenceEvent, assembleEvidence, classifyUserEventSource, ATTRIBUTION,
  LEDGER_MARKERS, RUNTIME_MARKERS,
  renderIncrement, buildProblemUnits, renderProblemUnits, mergeByEvidence,
  SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION, MEMORY_POLICY_VERSION, MODEL_MEMORY_PREAMBLE,
} from './state-memory.js'
// ★★ 快照持久化（2026-09-22，用户批准路线）：把编译成功后的**完整结构化状态**存下来，
//   下一轮直接从这里注入 —— 不再"从看板里捞快照"（看板是渲染产物且会被宿主压缩回收）。
import {
  loadSnapshot, commitSnapshot, markSnapshotApplied, coveredSeqSet, snapshotToText,
  snapshotStats, snapshotIdOf, normalizeBranchId, recoverSnapshot, snapshotStoreInfo,
  SNAPSHOT_SCHEMA_VERSION,
} from './snapshot-store.js'

// ★ 供测试直接校验「唯一解释出口」：索引与回退必须得到同样的证据。
export { normalizeEvidenceEvent, assembleEvidence } from './state-memory.js'

// ── 模块身份证据（★ 2026-09-17 新增）─────────────────────────────────────────
// 两次生产崩溃（06:14:04Z / 07:11:23Z）的根因都是同一个**不可证断言**：
//   「网关里跑的到底是哪一版模块」。
// 原来的上岗判据是 `emitting` 这个手写常量 —— 旧模块会照打一模一样的字，
// 因此它**证明不了任何事**（这正是 07:11 那次崩溃的直接成因）。
// 现在改为记录**模块首次求值那一刻**从磁盘读到的 size/mtimeMs：
//   · 网关里若是旧模块（Node ESM 缓存命中），它根本没有这段代码 ⇒ BOOT 里不会有 selfId；
//   · 出现 selfId 且与磁盘现值逐字一致 ⇒ 新模块确实上岗，可直接 grep 复验。
const SELF_ID = (() => {
  try { const s = fs.statSync(new URL(import.meta.url)); return s.size + '@' + Math.round(s.mtimeMs) } catch { return 'unknown' }
})()
const DEP_ID = ['emitter.js', 'imperative.js', 'balanced-span.js', 'headroom.js', 'rules.js', 'state-memory.js', 'snapshot-store.js', 'compile-lane.js', 'evidence-views.js', 'evidence-ledger.js', 'evidence-input.js', 'evidence-storage.js', 'consumption.js']
  .map((f) => {
    try { const s = fs.statSync(new URL('./' + f, import.meta.url)); return f + '=' + s.size + '@' + Math.round(s.mtimeMs) } catch { return f + '=?' }
  })
  .join(' ')

export const name = 'cot-form-b'
export const inject = []

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

  // ★★ 三级模式（2026-09-15 用户主权开关）★★
  //   'distill' 伴生提纯（默认）：削减 ~67%，但要一次外部调用；拿不到就自动降级 rules
  //   'rules'   纯规则：零网络、零 await、同步 <10ms；削减率见 rules.js 顶部的认知等级说明
  //   'off'     完全不介入，原样放行
  //   'birth'   ★ 出生即提纯（At-Birth Interception）：在 llm/stream 里扣住 reasoning 块，
  //             先归档进 CAS、再用纯规则压缩，然后以【普通 append】放行。
  //             为什么必须用它：0.1.5-rc.1 的 surface.js:207/234 使 assistant/message
  //             永远无法充当 surfaceOp:replace 的载体 ⇒ 事后改写被架构性禁止。
  mode: 'distill',

  // ① 触发门槛：R=4 保本原长。
  //   breakevenRaw(4) = 774（由三点拟合 final ≈ 0.26·raw + 163 反解），保守取整 800。
  //   ⚠ 这只是**便宜的前置筛子**（省一次 API 调用），不是保本判据；真正的判据是 ③。
  //   ⚠ 低于门槛**不再等于不压缩**：会降级走纯规则（规则档零成本，没有 API 费用问题）。
  minRawChars: 800,
  // ③ 保本不等式的结构轮数 =「这块之后还会被携带几轮」的保守假设
  hurdleRounds: 4,
  // ③ 不等式里的模板量级（提示词本身）
  templateChars: 500,
  // ④ 机械注入的用户原话上限
  maxVerbatimChars: 600,
  // 09-16 骨架化（默认关）：把超长工具参数外置成句柄 + 首尾骨架
  // ⚠ 必须两阶段：CAS 写盘是 async，而 appendReplace/rebuildContent 是同步链
  skeletonizeArgs: false,
  skeletonMinChars: 600,
  skeletonKeepHead: 300,
  skeletonKeepTail: 200,

  // ── 纯规则档 ──
  rulesEnabled: true,
  // 游程折叠：连续 ≥3 行「已验证 OK」折成区间（含稀有实体的行永不折叠）
  rulesFoldRuns: true,
  // 逐字重复行删除（最弱的一条有损规则）
  rulesDropDuplicateLines: true,
  // ⛔⛔ 2026-09-17 事故修正（原为 `rulesMinSavingPct: 10`）——
  //   那是一个**奖励暴力的逆向淘汰闸**：只有删得够狠（≥10%）的方案才准过线，
  //   而 100% 保真的精细去重（本语料实测 2.45%）反而被判 no-gain 丢弃
  //   ⇒ 越暴力越容易通过，越保守越被淘汰。这正是旧规则被逼成杀手的原因之一。
  //   新判据**彻底与百分比解耦**：① 零丢失受保护 token ② 净省 ≥ N 字符。
  rulesMinSavedChars: 20,
  // ⛔ 归档前置闸（约束⑤ 先存后压）：拿不到 CAS 句柄就绝不允许替换掉原始 CoT。
  //   注意 appendReplace → flushPendingEmit 这条路上**没有任何归档**，
  //   所以在给它接上归档之前，它会一直拒发 —— 这是**安全状态**，不是故障。
  rulesRequireArchive: true,

  // ── 出生即提纯（mode: 'birth'）──
  //   铁律③：先归档后压缩。归档失败 ⇒ 原样透传（原始 CoT 绝不允许因压缩而丢失）。
  birthArchive: true,
  //   低于此长度不值得归档+压缩（CAS 写盘是 async，块太小会白付 I/O 又压不动）
  birthMinChars: 500,
  //   把 CAS 句柄附在压缩文本尾部，给模型留一条「可回查」的路
  birthHandleInText: true,
  //   CAS 归档的 producer 标签（事后可按来源检索）
  birthProducer: 'cot-birth',
  //   CAS 写盘超时护栏：卡住就当归档失败处理（原样透传），绝不许拖死模型流
  birthArchiveTimeoutMs: 3000,
  // ★ 方案一（流式双轨）2026-09-18 终审锁定 —— finish 处收尾等待硬上限。
  //   块尾**不阻塞主流**：reasoning delta 实时透传、text/tool 实时透传，
  //   只有 finish 前的收网最多等这么久，到点立即熔断，放行 raw + 句柄。
  birthFinishWaitMs: 1500,
  // ★★ 方案二「下轮收网」（Deferred Claim）2026-09-21 ★★
  //   出生即提纯照旧；**没赶上 finishWaitMs 的结果不再丢弃**，而是进暂存区，
  //   在下一轮 pre-step 用官方 user/message + surfaceOp replace 收网。
  //   ⇒ 实际等待 0（结果早就在「用户阅读/工具执行」这段时间里跑完了）。
  //   设为 false 可一键退回旧行为（直接旁路收网器）。
  birthDeferredClaim: true,
  //   净省保本线：蒸馏稿 + 句柄必须比原文少 ≥ 这么多字符才允许替换。
  //   低于此线说明模型在抄书（没完成有效浓缩）⇒ 原样放行 raw + 句柄。
  birthMinSavedChars: 50,


  // ── 延迟预算 ──
  // ★ 提前发起（early-fire）：在 llm/stream 里一看到 reasoning 块结束就**非阻塞**地
  //   拉起伴生调用，用「模型自己生成工具参数的那段时间」把 5.4 秒消化掉。
  //   ⇒ pre-step 到达时结果通常已经就绪 ⇒ 用户感知延迟 ≈ 0。
  earlyFire: true,
  // 伴生调用自身的超时（用户可调：网络差就调大，追求速度就调小）
  timeoutMs: 8000,
  // ★ pre-step 里最多额外等多久。early-fire 已经把大头吃掉了，这里只是补最后一段。
  //   ⚠ 这个数就是**用户感知延迟的上限**。默认 300ms。
  graceMs: 300,
  // 重试 4 → 1。退避 1200×attempt 会让"抖动一次 + 两次重试"多出 3.6 秒。
  maxAttempts: 1,

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
  maxOutputTokens: 1200,

  // 伴生调用
  // ★★ 2026-09-19 公测加固：原为作者商户端点字面量 ★★
  //   两个问题，同一行：
  //   ① 泄漏：把本机使用的商户端点写进了可分发的代码。
  //   ② 与自身契约矛盾：上面 followHostProvider 段写着"解析不出来**不猜**"，
  //      但"回落到上面的 baseUrl"这个回落目标却是作者自己的商户 ⇒ 外人装上后，
  //      宿主 provider 不是作者那家商户时会去连一个不属于他的端点：连不上，且暴露来源。
  //   改为空串 = 没有端点 ⇒ 提纯不发起、降级 rules（与 L751 的 no-model 抛错路径完全同形）。
  //   本机行为不变：profile 显式 baseUrl 与 followHostProvider 解析两条路照旧。
  baseUrl: '',
  // ★★ 提纯用哪个模型：**跟着宿主对话模型走**（2026-09-15 用户拍板）★★
  //   「宿主用哪个模型对话，我们就用那个模型压缩。」
  //   ⇒ `model` 留空 = 不指定；运行期从 `llm/stream` 的 options.model 实时读取宿主模型。
  //   ⇒ 不写死任何具体模型名（写死的名字都是从商户目录里挑的，身份不可核实）。
  //   ⇒ 读不到宿主模型时**不猜**：直接放弃提纯、降级 rules，并把原因落 trace。
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
  // compress 提示词版本：'v2' 中性压缩（缺省）；'v1' = 与 legacy 蒸馏逐字相同（回滚/对照用）
  compressPrompt: 'v2',
  // pre-step 整段 replace 时，随看板带走的旧看板正文/可见回答/工具调用参数的内联总预算（字符）；超出归档为句柄
  maxCarryChars: 3000,
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
  //   实测根因：followHostModel 只重写【模型名】(index.js:1300)，端点与钥匙被钉死在
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

// ── 配置归一化：同时接受扁平键与用户文档里的嵌套写法 ─────────────────────────
// 用户配置规范（cordis.patch.yml）：
//   mode: "distill" | "rules" | "off"
//   distill: { timeoutMs, minRawChars, hurdleRounds, maxVerbatimChars }
//   rules:   { foldRuns, dropDuplicateLines, minSavingPct }
// 嵌套对象里的键**覆盖**同名扁平键。不认识的键一律忽略，绝不报错。
export function normalizeConfig(config = {}) {
  const c = Object.assign({}, DEFAULTS, config)
  const d = config && config.distill
  if (d && typeof d === 'object') {
    for (const k of ['timeoutMs', 'minRawChars', 'hurdleRounds', 'templateChars', 'maxVerbatimChars', 'maxAttempts', 'maxOutputTokens', 'baseUrl', 'model', 'credentialRef', 'credentialsPath', 'graceMs', 'keepAlive', 'keepAliveMsecs', 'prewarm', 'prewarmMinGapMs', 'followHostModel', 'disableThinking']) {
      if (d[k] !== undefined) c[k] = d[k]
    }
  }
  const r = config && config.rules
  if (r && typeof r === 'object') {
    if (r.foldRuns !== undefined) c.rulesFoldRuns = r.foldRuns
    if (r.dropDuplicateLines !== undefined) c.rulesDropDuplicateLines = r.dropDuplicateLines
    if (r.minSavedChars !== undefined) c.rulesMinSavedChars = r.minSavedChars
    if (r.requireArchive !== undefined) c.rulesRequireArchive = r.requireArchive
    // @deprecated 百分比判据已废弃；若仍被配置，只在 BOOT 里报出来提醒，不参与任何决策。
    if (r.minSavingPct !== undefined) c.rulesMinSavingPctDeprecated = r.minSavingPct
  }
  const b = config && config.birth
  if (b && typeof b === 'object') {
    if (b.minChars !== undefined) c.birthMinChars = b.minChars
    if (b.archive !== undefined) c.birthArchive = b.archive
    if (b.handleInText !== undefined) c.birthHandleInText = b.handleInText
    if (b.producer !== undefined) c.birthProducer = b.producer
    if (b.archiveTimeoutMs !== undefined) c.birthArchiveTimeoutMs = b.archiveTimeoutMs
    if (b.finishWaitMs !== undefined) c.birthFinishWaitMs = b.finishWaitMs
    if (b.minSavedChars !== undefined) c.birthMinSavedChars = b.minSavedChars
  }
  // ⚠ 'birth' 必须在这个白名单里，否则会被静默重置回 DEFAULTS.mode
  if (['distill', 'rules', 'birth', 'checkpoint', 'off'].indexOf(c.mode) === -1) c.mode = DEFAULTS.mode
  c.retiredOptions = ['stateEvidenceViews', 'stateEvidenceBodyBudget', 'stateSnapshotMirror', 'stateCompileQueue'].filter(k => Object.hasOwn(config, k))
  for (const k of c.retiredOptions) delete c[k]
  c.compileMode = resolveCompileMode(c)
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
function compileModeOf(cfg) {
  if (!cfg) return 'legacy'
  return cfg.compileMode != null ? cfg.compileMode : resolveCompileMode(cfg)
}

// ── 提示词：三态硬标签 ───────────────────────────────────────────────────────
export function buildDistillPrompt(cot) {
  return (
    '你是上下文提纯器。把下面这段 Agent 上一轮的思维链，压成一份状态结算单（已归档状态记录）。\n\n' +
    '只输出结算单本身。不要任何解释，不要 markdown 代码围栏，不要客套。\n\n' +
    '必须且只能包含以下三栏，顺序固定：\n' +
    '【已归档决策】已经定下来的事：做了什么、为什么、当前处在哪一步。\n' +
    '【已否决分支·不可重开】被明确否决或禁止的方案。记录必须保持同等强度与不可逆性，不得软化、不得降级为"建议"。\n' +
    '【已证伪路径·归档】已经试过并失败的做法。\n\n' +
    '硬性规则：\n' +
    '1. 某栏没有内容时，整栏省略，不要写"无"、不要写"暂无"。\n' +
    '2. 严禁出现"建议""备选""可以考虑""或许""可能应该"等软性措辞。是就是，否就是否。\n' +
    '3. 路径、文件名、命令、变量名、数字、错误信息原文，一律逐字保留，不许意译。\n' +
    // 用正面指令而不是"不要复述用户原话"：模型对负向指令不敏感，点名反而可能诱导它去写那一栏。
    // "用中文输出"是针对伪造引用 bug 的正面防线 —— 那个 bug 的本质就是模型把中文原话脑补翻译成了英文。
    '4. 用中文输出。不要翻译成其他语言。\n' +
    '5. 删掉推理过程、自我怀疑、重复表述。\n' +
    '6. 目标长度 200~400 字符。\n' +
    // ★ 2026-09-17 新增（红队方案 β 的提示词侧实现）。只改【句式】，不改【强度】。
    //   理由：栏头与正文的祈使/第二人称句式会作为 user 角色注入，与当前任务直接冲突（见 _forensic-corrected.md §1.5）。
    //   反例见 imperative.selftest.mjs「红队正则反例」：正则改写会发明事实，故改写只能由提示词侧完成。
    '7. ★ 输出正文一律使用第三人称 + 过去时/完成时陈述；不得出现祈使句，不得使用第二人称"你"/"您"。\n' +
    '   · "禁止再动代码"   ⇒ "代码修改阶段已于 <时间> 结束。"\n' +
    '   · "下一步跑 X"     ⇒ "X 尚未执行。"\n' +
    '   · "不要删会话"     ⇒ "会话文件删除动作经评估为破坏性，已归档为不可行。"\n' +
    '   ⚠ 第 7 条只改变句式，不改变强度：已否决的方案必须仍然读起来不可重开。\n\n' +
    '【上一轮思维链】\n' +
    cot
  )
}

/**
 * ★ 2026-09-23 compress-v2：**中性压缩**提示词（与 legacy 蒸馏的裁决式提示词分离）。
 *   legacy/buildDistillPrompt 要求「已否决·不可重开」「删掉自我怀疑」—— 那是不可逆裁决，
 *   把 reasoning 里的犹豫与备选项抹掉。纯压缩的目标只是**更短且保真**：
 *     · 保留未决问题、备选方案与不确定性的措辞（不升级为结论）；
 *     · 路径 / 命令 / 数字 / 报错逐字保留；
 *     · 不新增事实、不给建议、不使用祈使句与第二人称（作为 user 角色注入时不得与当前任务冲突）。
 *   通过 promptVersion 'compress-v2' 与 v1（=legacy 文本）区分，便于 A/B。
 */
export function buildCompressPrompt(cot) {
  return (
    '你是上下文压缩器。把下面这段 Agent 上一轮的思维链，改写成一份更短的等价记录。\n\n' +
    '只输出记录本身。不要解释，不要 markdown 代码围栏，不要客套。\n\n' +
    '保真规则（优先级高于长度）：\n' +
    '1. 保留原文的确定程度：已确定的写成已确定；原文仍在犹豫、比较或存疑的，保留"尚未确定 / 两种可能 / 待验证"的表述，不得升级为结论，也不得删掉。\n' +
    '2. 保留被考虑过但未采用的方案及其原因（一句话即可）。\n' +
    '3. 路径、文件名、命令、变量名、数字、错误信息原文逐字保留，不许意译。\n' +
    '4. 不新增原文没有的事实，不给建议，不评价。\n' +
    '5. 用中文；第三人称陈述句；不得出现祈使句，不得使用"你 / 您"。\n' +
    '6. 删除重复表述与逐字复读的工具输出；合并同义段落。\n' +
    '7. 目标长度为原文的 20%~35%；原文很短时宁可少删。\n\n' +
    '【上一轮思维链】\n' +
    cot
  )
}

// ── ④ 机械注入：从宿主消息里字符串截取用户原话 ───────────────────────────────
// 超限时保留「头 60% + 尾 40%」而不是砍尾——约束通常写在最后。
export function sliceVerbatim(text, maxChars) {
  const s = String(text || '')
  if (s.length <= maxChars) return s
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return s.slice(0, head) + '\n…（原话过长，中间省略）…\n' + s.slice(s.length - tail)
}

// ⚠ 实测形状差异（2026-09-15 金丝雀抓出，别再猜）：
//   assistant/message → 消息挂在 `data.message` 上
//   user/message      → **没有 data.message**，字段平铺在 `data` 上
//   content           → 可能是纯字符串，也可能是 [{type:'text', text}] 块数组 ⇒ 必须双兼容
//   source.kind       → "user" = 真·人类消息；"plugin" / "skill-catalog" / "system-prompt"
//                       = 系统注入 ⇒ **必须排除**，否则注入进去的是系统提示，比不注入更毒
/**
 * ★★ 2026-09-21 消息溯源（外部审计 P0-3）★★
 * 回答"最终请求里那些连续 user 到底是什么"，而**不是**数 role。
 *
 * 设计要点：
 *   ① 逐条给出 role / 字符数 / 是否看板 / 人类 user 的开头片段；
 *   ② 把"连续同 role 的游程"单独列出来（只报 n>1 的），这正是要看的东西；
 *   ③ **不删上下文、不改 role、不合并消息** —— 这一步只观测。
 *   ④ runtime context 的识别不靠猜标记：只报 head，由人看 trace 判断。
 *
 * @param {Array} messages 出站请求的消息数组
 * @returns {{items:Array, runs:Array}}
 */
export function provenanceOf(messages) {
  const arr = Array.isArray(messages) ? messages : []
  const items = []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i] || {}
    const role = m.role == null ? null : String(m.role)
    let text = ''
    try { text = textOfContent(m.content) || '' } catch { text = '' }
    const reasoningChars = (() => { try { return reasoningTextOf(m).length } catch { return 0 } })()
    const isLedger = text.includes(LEDGER_OPEN)
    // ★ chars:0 ≠ 整条消息为空（外部审计）：把 content 的【结构】也记下来，
    //   否则"非文本块（图片/文件/工具结果）"会被误判成"空壳"。
    const c = m.content
    let contentType = 'other', blockCount = 0, blockTypes = []
    if (typeof c === 'string') { contentType = 'string'; blockCount = 1; blockTypes = ['text'] }
    else if (Array.isArray(c)) {
      contentType = 'array'; blockCount = c.length
      blockTypes = c.map((b) => {
        if (typeof b === 'string') return 'text'
        if (b && typeof b.type === 'string') return b.type
        return b && typeof b.text === 'string' ? 'text' : 'unknown'
      })
    } else if (c == null) { contentType = 'null' }
    const nonTextBlocks = blockTypes.filter((t) => t !== 'text').length
    // ★★ 2026-09-21 真机裁决（类别 A：探针语义不完整，不是消息为空）★★
    //   tool/result 事件的 message 形如：
    //     { role:'user', content:[ { type:'tool-result', toolCallId, content:[{type:'text',text}], isError } ] }
    //   ⇒ 文本在**嵌套 content** 里，而 textOfContent 只看顶层块的 .text ⇒ 读到 0。
    //   这不是"空壳 user"，是**工具结果**。补一个递归提取，只用于观测。
    let nestedChars = 0
    if (Array.isArray(c)) {
      for (const blk of c) {
        if (blk && Array.isArray(blk.content)) {
          for (const inner of blk.content) {
            if (inner && typeof inner.text === 'string') nestedChars += inner.text.length
            else if (typeof inner === 'string') nestedChars += inner.length
          }
        }
      }
    }
    const it = { i, role, chars: text.length, nestedChars, reasoningChars, isLedger, contentType, blockCount, blockTypes, nonTextBlocks }
    // 工具关联：tool_calls / tool_call_id（是否有配对信息）
    if (m.tool_calls !== undefined) it.hasToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.length : true
    if (m.tool_call_id !== undefined) it.toolCallId = String(m.tool_call_id).slice(0, 24)
    // 人类 user 的开头片段：用于区分"真用户发言"与"宿主注入的 runtime context"。
    // 只取 48 字符，足以辨认，不足以泄露大段内容。
    // 人类 user 才取开头片段；tool-result 的 user 没有顶层文本，取嵌套文本开头。
    if (role === 'user' && !isLedger) {
      const src = text || (Array.isArray(c) ? c.map((blk) => (blk && Array.isArray(blk.content) ? blk.content.map((x) => (x && x.text) || '').join('') : '')).join('') : '')
      if (src) it.head = src.slice(0, 48).replace(/\s+/g, ' ')
    }
    items.push(it)
  }
  const runs = []
  let start = 0
  for (let i = 1; i <= items.length; i++) {
    if (i === items.length || items[i].role !== items[start].role) {
      const n = i - start
      if (n > 1) runs.push({ role: items[start].role, n, from: start, to: i - 1 })
      start = i
    }
  }
  return { items, runs }
}

/**
 * ★★ 2026-09-21 建立"出站消息 → 源事件 seq"的链条（外部审计 P0-3）★★
 *
 * 依据（已读源码确认）：
 *   dsh-agent-loop:1204 `session.deriveMessages()` → dsh-session:1269 遍历
 *   `surface.nodes`（**元素就是 seq**）→ 对每个 seq 调 `deriveEventMessage(log[seq])`，
 *   投影为 null 的节点被**丢弃**（例如 content 为空的 assistant/message）。
 *
 * 因此映射规则是确定性的：按 surface.nodes 顺序走，跳过投影为 null 的节点，
 * 剩下的与出站 messages **一一对应**。不需要用正文反查（空串会匹配一大堆节点）。
 *
 * @returns {{map:Array|null, note:string}} map[i] = 第 i 条出站消息的来源 seq
 */
export function mapMessagesToSeqs(session, messageCount) {
  try {
    if (!session || !session.surface || !Array.isArray(session.surface.nodes)) {
      return { map: null, note: 'no-surface' }
    }
    if (typeof session.eventAt !== 'function') return { map: null, note: 'no-eventAt' }
    const nodes = session.surface.nodes
    const map = []
    for (const seq of nodes) {
      let ev = null
      try { ev = session.eventAt(seq) } catch { ev = null }
      if (!ev) continue
      // 与 dsh-session:209 deriveEventMessage 同规则
      if (ev.type === 'user/message') { map.push(seq); continue }
      if (ev.type === 'assistant/message' || ev.type === 'system/message') {
        const c = ev.data && ev.data.message && ev.data.message.content
        if (Array.isArray(c) && c.length === 0) continue   // 空内容 assistant 不投影
        map.push(seq); continue
      }
      if (ev.type === 'tool/result') { map.push(seq); continue }
    }
    // ⚠ 数量一致**不能**排除重排；映射边界由 deriveMessages 的代码路径保证（见函数头注释）。
    return { map, note: map.length === messageCount ? 'aligned' : 'mapping-mismatch', count: map.length, expected: messageCount }
  } catch (e) {
    return { map: null, note: 'error:' + String((e && e.message) || e) }
  }
}

export function messageOfEvent(e) {
  if (!e || !e.data) return null
  return e.data.message && typeof e.data.message === 'object' ? e.data.message : e.data
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (typeof b === 'string' || typeof b.text === 'string'))
    .map((b) => (typeof b === 'string' ? b : b.text))
    .join('\n')
}

export function findLastUserMessage(sessionLog, beforeSeq) {
  const pick = (strict) => {
    for (let i = sessionLog.length - 1; i >= 0; i--) {
      const e = sessionLog[i]
      if (!e || e.type !== 'user/message') continue
      if (typeof beforeSeq === 'number' && typeof e.seq === 'number' && e.seq >= beforeSeq) continue
      const m = messageOfEvent(e)
      if (!m) continue
      const kind = (m.source && m.source.kind) || null
      // 严格档：只认人类消息。宽松档：仍排除已知的系统来源。
      if (strict ? kind !== 'user' : (kind && kind !== 'user')) continue
      const t = textOfContent(m.content)
      if (t.trim()) return { text: t, kind, seq: e.seq }
    }
    return null
  }
  return pick(true) || pick(false)
}

export function findLastUserText(sessionLog, beforeSeq) {
  const hit = findLastUserMessage(sessionLog, beforeSeq)
  return hit ? hit.text : ''
}

export function assembleCheckpoint(distilled, verbatim) {
  const parts = []
  if (verbatim && verbatim.trim()) {
    parts.push('【用户原话·逐字引用】（以下由宿主机械注入，非模型生成，具最高约束力）\n' + verbatim)
  }
  parts.push(String(distilled || '').trim())
  return parts.join('\n\n')
}

// ── ③ 保本后验不等式 ────────────────────────────────────────────────────────
// (raw - final) × R > template + raw + final
// 它同时覆盖「防增肥」：final >= raw 时左侧 ≤ 0，必失败。
export function passesHurdle(rawChars, finalChars, cfg) {
  const saved = rawChars - finalChars
  const lhs = saved * cfg.hurdleRounds
  const rhs = cfg.templateChars + rawChars + finalChars
  return { pass: lhs > rhs, saved, lhs, rhs }
}

// ── 保本原长的反解 ──────────────────────────────────────────────────────────
// final ≈ a·raw + b 是三点拟合出的经验式（774 那个数就是这么来的）。
// 代进 (raw − final)·H > template + raw + final：
//   raw·(1−a)H − bH > T + raw·(1+a) + b
//   raw·[(1−a)H − (1+a)] > T + b(1+H)
//   raw* = (T + b(1+H)) / [(1−a)H − (1+a)]
// 取 floor+1 而不是 ceil：H=3 时正好整除（1200），ceil 会给出一个**恰好不通过**的数。
//
// ⚠ 用途已经收窄（2026-09-15）：延迟替换被否决后，本模块只用 H = hurdleRounds = 4
//   ⇒ 保本原长 774，门槛取 800。保留这个函数是因为它是**门槛的唯一推导来源**：
//   自测里用它锁住「门槛 ≥ 保本原长」，防止以后有人手改 minRawChars 而不同步改轮数。
export const FIT = { a: 0.26, b: 163 }
export function breakevenRaw(hurdleRounds, cfg) {
  const T = (cfg && cfg.templateChars) || DEFAULTS.templateChars
  const den = (1 - FIT.a) * hurdleRounds - (1 + FIT.a)
  if (den <= 0) return Infinity // H ≤ 1.70 时分母 ≤ 0：无论多长都保不了本
  return Math.floor((T + FIT.b * (1 + hurdleRounds)) / den) + 1
}

// ── 消息工具 ────────────────────────────────────────────────────────────────
export function reasoningTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((b) => b && b.type === 'reasoning').map((b) => String(b.text || '')).join('\n')
}

export function toolCallsOf(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'tool-call')
}

// 新 reasoning 放最前，其余非 reasoning 块（text / tool-call）原序保活
// 09-16：plan = [{key, handle, text}] 由 buildSkeletonPlan 异步产出后传入；不传则行为完全不变
// ── 09-16 骨架化：超长工具参数外置（两阶段：async 写盘 → 同步应用）──────────────
// 为什么两阶段：CAS 写盘是 async，而 appendReplace/rebuildContent 是同步链；
// 在同步函数里 await 会把整条链断掉（这是最初草图的坑，必须避开）。
export function collectBigStrings(message, minChars) {
  const out = []
  if (!message || !Array.isArray(message.content)) return out
  message.content.forEach((b, bi) => {
    if (!b || b.type !== 'tool-call' || !b.input || typeof b.input !== 'object') return
    for (const k of Object.keys(b.input)) {
      const v = b.input[k]
      if (typeof v === 'string' && v.length >= minChars) out.push({ bi, k, text: v })
    }
  })
  return out
}

// 首尾保留 + 中间句柄：字段名与类型都不变 ⇒ 工具调用 schema 仍然合法
export function makeSkeleton(full, handle, head, tail) {
  const h = Number(head || 300), t = Number(tail || 200)
  const dropped = full.length - (h + t)
  return full.slice(0, h) + '\n// …[省略 ' + dropped + ' 字符；全文句柄 ' + handle + ' ，可用 inspect_artifact 读回]…\n' + full.slice(full.length - t)
}

export function applySkeletons(message, plan) {
  if (!plan || !plan.length || !message || !Array.isArray(message.content)) return message
  const byKey = new Map(plan.map((p) => [p.bi + '|' + p.k, p]))
  const content = message.content.map((b, bi) => {
    if (!b || b.type !== 'tool-call' || !b.input || typeof b.input !== 'object') return b
    let changed = false
    const input = Object.assign({}, b.input)
    for (const k of Object.keys(input)) {
      const p = byKey.get(bi + '|' + k)
      if (p) { input[k] = p.text; changed = true }
    }
    return changed ? Object.assign({}, b, { input }) : b
  })
  return Object.assign({}, message, { content })
}

// 异步阶段：把大串写进 CAS，产出同步阶段要用的 plan
async function buildSkeletonPlan(orig, cfg, store, sessionId, trace) {
  const big = collectBigStrings(orig, cfg.skeletonMinChars)
  const plan = []
  for (const it of big) {
    const ref = await store.putText(it.text, { producer: 'cot-settler-skel', sessionId, retention: 'session' })
    const handle = (ref && ref.handle) || ''
    if (!handle) continue
    plan.push({ bi: it.bi, k: it.k, fullChars: it.text.length, handle, text: makeSkeleton(it.text, handle, cfg.skeletonKeepHead, cfg.skeletonKeepTail) })
  }
  return plan
}
export function rebuildContent(message, newReasoningText, plan) {
  const skel = plan && plan.length ? applySkeletons(message, plan) : message
  message = skel || message
  const rest = Array.isArray(message.content) ? message.content.filter((b) => b && b.type !== 'reasoning') : []
  return [{ type: 'reasoning', text: newReasoningText }, ...rest]
}

export function findLastAssistantEvent(sessionLog) {
  for (let i = sessionLog.length - 1; i >= 0; i--) {
    const e = sessionLog[i]
    if (e && e.type === 'assistant/message') return e
  }
  return null
}

// ── 伴生调用 ────────────────────────────────────────────────────────────────
function readApiKey(cfg) {
  // ⛔ 2026-09-19 公测加固：空 ref 必须先拦。
  //   new RegExp('' + ':\s*([^\s]+)') 退化成只看冒号后面那段的表达式，会把 credentials 里
  //   【任意一行】的键名后面那段当钥匙 —— 静默用错钥匙比抛错难查得多。
  //   空 ref = 没人指定过钥匙名 ⇒ 明确失败（上层降级 rules）。
  if (!cfg.credentialRef) throw new Error('credentialRef is empty: no key name was resolved or configured')
  const t = fs.readFileSync(cfg.credentialsPath, 'utf8')
  const m = t.match(new RegExp(cfg.credentialRef + ':\\s*([^\\s]+)'))
  if (!m) throw new Error(cfg.credentialRef + ' not found in ' + cfg.credentialsPath)
  return m[1]
}

// 按【任意键名】取钥匙（从宿主 provider 的 apiKeyEnv 来，不写死具体名字）
function readApiKeyRef(cfg, refName) {
  if (!refName) throw new Error('apiKeyEnv is empty')
  return readApiKey(Object.assign({}, cfg, { credentialRef: refName }))
}

// ── 宿主 provider 端点解析（禁止硬编码端点/钥匙）─────────────────────────────
// 只认 settings.yaml 里这一段（缩进解析，零 YAML 依赖）：
//   llm-pi-ai:
//     providers:
//       <name>:
//         apiKeyEnv: X
//         api: openai-completions | openai-responses | anthropic-messages
//         baseURL: https://...
export function readProviderSpec(settingsPath, providerName) {
  if (!providerName) return null
  let text
  try { text = fs.readFileSync(settingsPath, 'utf8') } catch { return null }
  const indentOf = (s) => s.length - s.replace(/^[ \t]*/, '').length
  let pIndent = -1, nameIndent = -1, cur = null, hit = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^[ \t]*#/.test(raw)) continue
    const i = indentOf(raw)
    const body = raw.trim()
    if (pIndent < 0) { if (/^providers:\s*$/.test(body)) pIndent = i; continue }
    if (i <= pIndent) break
    if (nameIndent < 0) nameIndent = i
    if (i === nameIndent) {
      const m = body.match(/^([A-Za-z0-9_.\-]+):\s*$/)
      cur = m ? m[1] : null
      if (cur && cur === providerName) hit = {}
      continue
    }
    if (i > nameIndent && cur === providerName && hit) {
      const m = body.match(/^([A-Za-z0-9_]+):\s*(.+?)\s*$/)
      if (m) { const k = m[1]; if (k !== 'id' && k !== 'name') hit[k] = m[2].replace(/^['"]|['"]$/g, '') }
    }
  }
  return hit && hit.baseURL ? hit : null
}

// 端点 URL 一律由 baseURL + api 风格推导 —— 不在任何地方写死商户地址
export function endpointUrl(baseURL, api) {
  const b = String(baseURL || '').replace(/\/+$/, '')
  if (!b) return null
  if (api === 'openai-responses') return /\/v1$/.test(b) ? b + '/responses' : b + '/v1/responses'
  if (api === 'openai-completions') return /\/v1$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions'
  return null
}

// 解析宿主 provider 的 {api, url, apiKeyEnv}；解析不出/不支持 ⇒ null（回落到显式配置）
export function resolveProviderEndpoint(cfg, providerName) {
  if (!cfg || cfg.followHostProvider === false) return null
  const name = providerName || cfg.followProvider
  if (!name) return null
  const spec = readProviderSpec(cfg.settingsPath || DEFAULTS.settingsPath, name)
  if (!spec) return null
  const api = spec.api || 'openai-completions'
  const url = endpointUrl(spec.baseURL, api)
  if (!url) return null
  return { provider: name, api, url, apiKeyEnv: spec.apiKeyEnv || null, baseURL: spec.baseURL }
}

// ── 传输层：持久连接（keep-alive）+ 预热 ────────────────────────────────────
//
// ⚠ 为什么不用 fetch：
//   ① 全局 fetch 是 undici，`undici` 包在本插件目录**不可导入**（无 node_modules），
//      所以拿不到 `new Agent({keepAliveTimeout})`，也就无法延长默认的 4 秒复用窗口。
//   ② `fetch` **不接受 `https.Agent`** —— 审稿人给的 `new https.Agent({...})` 代码片段
//      贴进 fetch 是无效的。要用 https.Agent 就必须走 node:https。
//   ③ node:https 还能给出 `req.reusedSocket` —— **可落 trace 的复用证据**，
//      这正是本项目「必须看 trace 说话」需要的那个观测口。
//   ⇒ 改用 node:http/https + 自持 Agent。零新增依赖。
// ⚠ agentCache 按**配置签名**分桶，不能只按"有没有缓存过"。
//   模块级单例 + 同进程多次 apply()（自测就是）时，只认第一次的 keepAlive 配置
//   ⇒ 后续 apply 的配置被静默忽略，测试会因为错误的原因通过。
let agentCache = new Map()
function getAgent(cfg) {
  const opts = {
    keepAlive: cfg.keepAlive !== false,
    keepAliveMsecs: cfg.keepAliveMsecs || 60000,
    maxSockets: 4,
    maxFreeSockets: 2,
  }
  const sig = opts.keepAlive + '|' + opts.keepAliveMsecs
  let hit = agentCache.get(sig)
  if (!hit) {
    hit = { 'http:': new http.Agent(opts), 'https:': new https.Agent(opts) }
    agentCache.set(sig, hit)
  }
  return hit
}

// 单次请求（不做重试）。返回 { status, text, meta }
// meta 里的 reused / connectMs / ttfbMs 是**实测的复用证据**，直接落 trace。
export function requestOnce(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 8000, cfg = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const agent = cfg ? getAgent(cfg)[u.protocol] : undefined
    const t0 = Date.now()
    // ★ 2026-09-21 阶段探针（外部审计 P0-1）：把一次请求切成
    //   connectMs（建连）/ ttfbMs（响应头）/ firstByteMs（首个正文字节）/ totalMs（读完）。
    //   非流式下 firstByte≈ttfb（服务端常攒完才发头），但只要上游改成 chunked，这两个数
    //   立刻能把「排队」与「生成」分开 —— 这正是当前最缺、且无法从总时长反推的信息。
    const meta = { reused: null, connectMs: null, ttfbMs: null, firstByteMs: null, status: null, bytes: null, chunks: 0, totalMs: null, cancelled: false }
    let killer = null
    let settled = false
    const done = (fn, v) => { if (settled) return; settled = true; if (killer) clearTimeout(killer); fn(v) }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      agent,
    }, (res) => {
      meta.ttfbMs = Date.now() - t0
      meta.reused = req.reusedSocket === true
      meta.status = res.statusCode
      // ★ 统一响应入口的旁证：协议判定以【响应体结构】为主，Content-Type 只作补充
      meta.contentType = res.headers['content-type'] || null
      const chunks = []
      let bytes = 0
      res.on('data', (c) => {
        if (meta.firstByteMs === null) meta.firstByteMs = Date.now() - t0
        meta.chunks += 1
        bytes += c.length
        // 上限 4MB：与 requestStream 对齐；正常 completion 远小于此，超限即放弃，绝不无限累积
        if (bytes > RESPONSE_BYTES_MAX) {
          const err = new Error('response exceeds 4MB'); err.meta = meta
          req.destroy(err); done(reject, err); return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        meta.bytes = buf.length
        meta.totalMs = Date.now() - t0
        done(resolve, { status: res.statusCode, text: buf.toString('utf8'), meta })
      })
      res.on('error', (e) => done(reject, e))
    })
    req.on('socket', (s) => {
      if (s.connecting) s.once('secureConnect', () => { meta.connectMs = Date.now() - t0 })
      else if (isHttps) meta.connectMs = Date.now() - t0
    })
    req.on('error', (e) => { e.meta = meta; done(reject, e) })
    // ★ 2026-09-21 主动取消（外部审计 P0-2）：放弃应用后，不再让一个注定被丢弃的请求
    //   继续占用本地连接槽与上游算力。注意：本地 abort 是否真的终止了【服务端】计算，
    //   本机无法证明 —— 它只能保证我们这边立刻松手。这一点在文档里如实标注。
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        const err = new Error('cancelled')
        err.cancelled = true
        err.meta = meta
        meta.cancelled = true
        meta.totalMs = Date.now() - t0
        try { req.destroy(err) } catch { /* ignore */ }
        done(reject, err)
      }
      const detach = () => { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', detach)
      }
    }
    // 总超时（对齐原 AbortSignal.timeout 的语义：整通请求的硬上限）
    if (timeoutMs > 0) killer = setTimeout(() => {
      const err = new Error('timeout ' + timeoutMs + 'ms')
      err.meta = meta
      try { req.destroy(err) } catch { /* ignore */ }
      done(reject, err)
    }, timeoutMs)
    if (body != null) req.write(body)
    req.end()
  })
}

/**
 * ★★ 2026-09-21 观测型流式迁移（外部审计 P0-1）★★
 * 目的：把现在混在一起的"响应到达前的等待"与"可见输出阶段"拆开。
 * 只改【插件 ↔ 蒸馏服务】之间的传输方式；会话协议、用户可见行为、兜底语义全部不变。
 *
 * 必须守住的边界（逐条对应外部审计的清单）：
 *   ① 网络 chunk ≠ SSE 事件 ⇒ 跨 chunk 缓冲，按【字节】找 \n 切行
 *      （0x0A 不可能出现在 UTF-8 多字节序列内部，故按字节切行天然 UTF-8 安全）
 *   ② 收到一部分摘要 ≠ 成功 ⇒ 只有协议确认正常完成才算 ok，由调用方判定
 *   ③ 连接断开 ≠ 正常完成 ⇒ 'aborted' 单独报，绝不冒充 end
 *   ④ finish_reason=length ≠ 完整摘要 ⇒ 原样带出去，由调用方拒绝
 *
 * @returns {Promise<{status:number, meta:object, events:Array<{at:number,data:string}>}>}
 */
export function requestStream(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 8000, cfg = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const agent = cfg ? getAgent(cfg)[u.protocol] : undefined
    const meta = {
      reused: null, connectMs: null, ttfbMs: null, status: null, bytes: 0, chunks: 0,
      requestSentAt: null, headersAt: null, firstEventAt: null, completedAt: null,
      eventCount: 0, done: false, cancelled: false, truncated: false,
    }
    const events = []
    let killer = null
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true; if (killer) clearTimeout(killer)
      meta.totalMs ??= Date.now() - meta.requestSentAt
      meta.toFirstEventMs = meta.firstEventAt == null ? null : meta.firstEventAt - meta.requestSentAt
      meta.toFirstContentMs = meta.firstContentAt == null ? null : meta.firstContentAt - meta.requestSentAt
      meta.contentSpanMs = meta.firstContentAt == null ? null : meta.lastContentAt - meta.firstContentAt
      meta.afterContentMs = meta.lastContentAt == null ? null : Date.now() - meta.lastContentAt
      fn(v)
    }
    meta.requestSentAt = Date.now()

    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers, agent,
    }, (res) => {
      meta.headersAt = Date.now()
      meta.ttfbMs = meta.headersAt - meta.requestSentAt
      meta.reused = req.reusedSocket === true
      meta.status = res.statusCode
      meta.contentType = res.headers['content-type'] || null
      // ★ 统一响应入口（反向）：Content-Type 不是 event-stream 时留一份原文，
      //   以便「要求流式、上游却回整段 JSON」时仍能按 JSON 解析（而不是静默变成空摘要）。
      //   是 event-stream 就不留副本 —— 流式响应可达数百 KB，不做无谓复制。
      const rawChunks = String(meta.contentType || '').toLowerCase().includes('event-stream') ? null : []
      // ① 跨 chunk 缓冲：只把【完整的行】解出来，残段留到下一个 chunk
      let buf = Buffer.alloc(0)
      const takeLine = (lineBuf) => {
        let line = lineBuf.toString('utf8')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line || line.startsWith(':')) return          // 心跳/注释 ⇒ 不是事件
        if (!line.startsWith('data:')) return               // event:/id:/retry: 暂不消费
        const data = line.slice(5).trim()
        if (data === '[DONE]') { meta.done = true; return }
        if (meta.firstEventAt === null) meta.firstEventAt = Date.now()
        meta.eventCount += 1
        let parsed
        try {
          const obj = JSON.parse(data)
          parsed = obj
          const usage = obj.usage || obj.response?.usage || obj.message?.usage
          if (usage && typeof usage === 'object') meta.providerReportedUsage = { ...meta.providerReportedUsage, ...usage }
          const content = obj.type === 'response.output_text.delta' ? obj.delta : obj.choices?.[0]?.delta?.content
          if (typeof content === 'string' && content.length) {
            meta.firstContentAt ??= Date.now(); meta.lastContentAt = Date.now()
          }
        } catch {}
        // ★ 只解析一次：下游 parseStreamEvents 直接用 json，不再对同一帧二次 JSON.parse
        events.push({ at: Date.now(), data, json: parsed })
      }
      res.on('data', (c) => {
        meta.chunks += 1
        meta.bytes += c.length
        if (meta.bytes > RESPONSE_BYTES_MAX) {
          const err = new Error('stream response exceeds 4MB'); err.meta = meta
          req.destroy(err); done(reject, err); return
        }
        // 上限 4MB：正常 completion 远小于此；超限即放弃兜底，绝不无限增长
        if (rawChunks && meta.bytes <= RESPONSE_BYTES_MAX) rawChunks.push(c)
        buf = buf.length ? Buffer.concat([buf, c]) : c
        let idx
        while ((idx = buf.indexOf(0x0a)) !== -1) {
          takeLine(buf.subarray(0, idx))
          buf = buf.subarray(idx + 1)
        }
      })
      res.on('end', () => {
        // 收尾残段：上游若没给结尾换行，最后一行也要解出来
        if (buf.length) takeLine(buf)
        meta.completedAt = Date.now()
        meta.totalMs = meta.completedAt - meta.requestSentAt
        // 判据是【内容】：一个 SSE 事件都没解出来，才认为上游给的是整段 JSON
        const text = (rawChunks && meta.eventCount === 0) ? Buffer.concat(rawChunks).toString('utf8') : null
        if (text !== null) meta.nonSse = true
        done(resolve, { status: res.statusCode, meta, events, text })
      })
      // ③ 连接断开 ≠ 正常完成：单独标记，绝不冒充 end
      res.on('aborted', () => { meta.truncated = true })
      res.on('error', (e) => { meta.truncated = true; e.meta = meta; done(reject, e) })
    })
    req.on('socket', (s) => {
      if (s.connecting) s.once('secureConnect', () => { meta.connectMs = Date.now() - meta.requestSentAt })
      else if (isHttps) meta.connectMs = Date.now() - meta.requestSentAt
    })
    // ★ 错误一律附上 meta（否则调用方拿不到 truncated/done 判据 —— 测试 T20 抓到的）
    req.on('error', (e) => {
      if (meta.headersAt !== null) meta.truncated = true
      e.meta = meta
      done(reject, e)
    })
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        const err = new Error('cancelled')
        err.cancelled = true; err.meta = meta
        meta.cancelled = true; meta.totalMs = Date.now() - meta.requestSentAt
        try { req.destroy(err) } catch { /* ignore */ }
        done(reject, err)
      }
      const detach = () => { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else { signal.addEventListener('abort', onAbort, { once: true }); req.on('close', detach) }
    }
    if (timeoutMs > 0) killer = setTimeout(() => {
      const err = new Error('timeout ' + timeoutMs + 'ms')
      err.meta = meta
      try { req.destroy(err) } catch { /* ignore */ }
      done(reject, err)
    }, timeoutMs)
    if (body != null) req.write(body)
    req.end()
  })
}

// 预热：一次 HEAD，只把 socket 捂热，**不产生任何 completion ⇒ 零 token**。
// 实测（_probe-keepalive-win.mjs）：HEAD / 与 POST /v1/chat/completions 同 host:port
// ⇒ 共享 freeSockets 键 ⇒ 跨路径复用已实测为 true。
/**
 * 预热该打哪个 URL（2026-09-21 实机探针修正）。
 * ⛔ 绝不能用 `base + '/'` —— base 形如 `https://host/v1`，那会得到 `/v1/`，
 *    实测返回 **404**，而 404 的 HEAD **不把 socket 归还连接池**，反而吃掉池里的连接，
 *    使紧随其后的蒸馏 POST 每次都新建连接（生产实测 connectMs=227、reused=false）。
 * ✅ 打 origin（`https://host/`）实测 200，且随后的 POST reused=true、connectMs=0~1。
 *    socket 池按 host:port 键控，路径不同不影响复用。
 * @returns {string|null} 预热 URL；无法解析 ⇒ null（调用方应放弃预热）
 */
export function prewarmTargetUrl(base) {
  const b = String(base || '').trim()
  if (!b) return null
  try { return new URL(b).origin + '/' } catch { /* 非绝对 URL ⇒ 回落旧写法 */ }
  return b.replace(/\/+$/, '') + '/'
}

function makePrewarmer(cfg, trace) {
  let lastAt = 0
  let inflight = null
  let prewarmDisabled = false
  return function prewarm(why) {
    if (!cfg.prewarm || (cfg.mode !== 'distill' && cfg.mode !== 'checkpoint' && cfg.mode !== 'birth')) return
    // ★ 2026-09-21：一旦实测到非 2xx（会吃掉连接池），永久停用预热 —— 失败安全。
    if (prewarmDisabled) return
    if (inflight) return
    const now = Date.now()
    const ag = getAgent(cfg)
    let idle = 0
    for (const k of Object.keys(ag['https:'].freeSockets)) idle += ag['https:'].freeSockets[k].length
    // 池里已有热 socket，且没超过最小间隔 ⇒ 不必重复打扰网关
    if (idle > 0 && now - lastAt < (cfg.prewarmMinGapMs || 20000)) return
    if (now - lastAt < 5000) return
    lastAt = now
    // ★ 跟随宿主 provider 时，预热必须打宿主端点（否则捂热的是别人的 socket）
    //  2026-09-19：解析不出就**不预热**（原为回落 cfg.baseUrl，而那个默认值曾是作者商户）。
    //  预热只是省 411ms 的优化，不值得为它连一个不属于用户的端点。
    let base = cfg.baseUrl
    try {
      const ep = resolveProviderEndpoint(cfg, cfg.followProvider)
      if (ep && ep.baseURL) base = ep.baseURL
    } catch { /* 解析失败 ⇒ 回落显式 baseUrl */ }
    if (!base) return
    // ★★ 2026-09-21 实机探针修正（本文件此前的一条错误结论就此推翻）★★
    //   病：原来打 `base + '/'`，而 base 是 `https://<host>/v1` ⇒ 实际请求 `/v1/` ⇒ **404**。
    //       实测（deploy/probe/_probe-404-head.mjs，生产同款 Agent 参数）：
    //         POST → 池里有 1 条 socket
    //         HEAD /v1/chat/completions (404) → 该 socket **不归还** freeSockets
    //         紧随其后的 POST ⇒ reused=false、connectMs=227（= 生产 trace 的实测值）
    //       对照：HEAD 打 origin '/' (200) ⇒ 随后的 POST reused=true、connectMs=0。
    //   即：**404 的预热不但没捂热，反而吃掉池里的连接**，让每次蒸馏都新建连接。
    //   法：打 origin（'/'），那是唯一实测返回 200 的路径；socket 池按 host:port 键控，
    //       路径不同不影响复用。
    const url = prewarmTargetUrl(base)
    inflight = requestOnce(url, { method: 'HEAD', timeoutMs: 4000, cfg })
      .then((r) => {
        trace('prewarm-ok', { why, status: r.status, ttfbMs: r.meta.ttfbMs, reused: r.meta.reused, url })
        // ★ 自愈闸：任何非 2xx 的预热都可能正在消耗连接池 ⇒ 记一次并**永久停用预热**。
        //   宁可没有预热（退化成"什么都不做"），也不能让它变成负优化。
        if (!(r.status >= 200 && r.status < 300)) {
          prewarmDisabled = true
          trace('prewarm-bad-status', { why, status: r.status, url, action: 'prewarm-disabled' })
        }
      })
      .catch((e) => {
        trace('prewarm-failed', { why, error: String((e && e.message) || e) })
      })
      .then(() => { inflight = null })
  }
}

// 网关把「不认识的参数」拒掉时的错误长这样：http 400 ...
/** 响应体上限（流式与非流式共用）。 */
const RESPONSE_BYTES_MAX = 4 * 1024 * 1024

/**
 * 重试退避：按错误类分级 + 抖动。
 *   429 / 5xx / 网络类 ⇒ 基线 1200·attempt，±30% 抖动（避免并发编译同拍重试）；
 *   401 / 403 / 404 / 参数 4xx ⇒ 不重试（再试也是同样的结果，纯白付）。
 * 纯函数，供自测钉住。
 */
export function retryDelayMs(e, attempt, rand = Math.random) {
  const msg = String((e && e.message) || e)
  const m = /^http (\d{3})\b/.exec(msg)
  const status = m ? Number(m[1]) : (e && e.meta && typeof e.meta.status === 'number' ? e.meta.status : null)
  if (status != null && status !== 429 && status < 500) return null   // 非瞬时错误：不重试
  if (e && e.cancelled) return null
  const base = 1200 * Math.max(1, attempt)
  const jitter = (rand() * 2 - 1) * 0.3 * base
  return Math.max(100, Math.round(base + jitter))
}

function isParamRejection(e) {
  return /^http (400|422)\b/.test(String((e && e.message) || e))
}

/**
 * ★★ 2026-09-21 统一响应入口（外部审计 P0：流式／非流式错配）★★
 * 事故证据：非流式请求拿到 SSE 响应体，trace 里 4 次
 *   bad json: data: {"id":"...","object":"chat.completion.chunk",...
 * 说明「我们要求的传输方式」与「上游实际给的响应协议」可以不一致。
 *
 * 原则：**不猜、不重试**。按【响应自身的结构】判协议，再选解析器；
 *   协议与请求模式不一致时**显式记录**，且绝不把「拼出了文字」当成功。
 *   ⚠ 不在这里加「失败后重发一次」——那会把本地解析缺陷变成重复调用与额外等待。
 */

/** 判定响应体的实际协议。结构证据优先，Content-Type 只作旁证。 */
export function detectResponseProtocol(text, contentType) {
  const ct = String(contentType == null ? '' : contentType).toLowerCase()
  const body = String(text == null ? '' : text)
  // SSE 的结构判据：存在以 data: 开头的行（与 requestStream 的 takeLine 同源）
  if (/(^|\r?\n)data:/.test(body)) return 'sse'
  if (ct.includes('text/event-stream')) return 'sse'
  const t = body.replace(/^\uFEFF/, '').trim()
  if (!t) return 'empty'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (ct.includes('json')) return 'json'
  return 'unknown'
}

/** 从【整段响应文本】里抽出 SSE data 帧（判据与 requestStream.takeLine 逐条一致）。 */
export function assembleSseFrames(text) {
  const datas = []
  let sawDone = false
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = raw
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') { sawDone = true; continue }
    datas.push(data)
  }
  return { datas, sawDone }
}

/** 把 SSE data 帧归并成与非流式同形的结果（chat / responses 两种风格）。 */
export function collectSseFrames(datas, style) {
  let out = ''
  let finish = ''
  let reasoningChars = 0, badFrame = 0
  for (const data of (Array.isArray(datas) ? datas : [])) {
    let j
    try { j = JSON.parse(data) } catch { badFrame++; continue }
    if (style === 'responses') {
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string' && j.delta) out += j.delta
      else if (j.type === 'response.completed') finish = 'stop'
      else if (j.type === 'response.incomplete') finish = 'length'
      else if (j.type === 'response.reasoning_summary_text.delta' || j.type === 'response.reasoning_text.delta') reasoningChars += String(j.delta || '').length
      continue
    }
    const ch = j && j.choices && j.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (typeof d.reasoning_content === 'string') reasoningChars += d.reasoning_content.length
    if (typeof d.content === 'string' && d.content) out += d.content
    if (ch.finish_reason) finish = ch.finish_reason
  }
  return { out, finish, reasoningChars, badFrame }
}

/**
 * 把【非流式 JSON 响应体】抽成 {out, finish, reasoningChars}。
 * chat / responses 两种风格共用 —— 非流式与流式两条路径的解析规则必须只有一处。
 * @returns {{out:string, finish:string, reasoningChars:number}|null} null = 没有 choices（调用方决定报错文案）
 */
export function extractFromJsonBody(j, style) {
  let out = ''
  let finish = ''
  let reasoningChars = 0
  if (style === 'responses') {
    const o = j || {}
    finish = o.status || (o.incomplete_details && o.incomplete_details.reason) || (o.error && o.error.message) || ''
    const chunks = []
    for (const item of (Array.isArray(o.output) ? o.output : [])) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text !== 'string') continue
          if (c.type === 'reasoning_text' || c.type === 'summary_text') reasoningChars += c.text.length
          else chunks.push(c.text)
        }
      }
      if (typeof item.text === 'string') chunks.push(item.text)
    }
    if (!chunks.length && typeof o.output_text === 'string') chunks.push(o.output_text)
    out = chunks.join('')
    return { out, finish, reasoningChars }
  }
  const ch = j && j.choices && j.choices[0]
  if (!ch) return null
  const msg = ch.message || {}
  out = msg.content || ''
  finish = ch.finish_reason
  reasoningChars = String(msg.reasoning_content || '').length
  return { out, finish, reasoningChars }
}
// One completion gate for JSON, SSE and protocol-mismatch paths.
function requireCompleteDistill(got, meta) {
  if (got && got.badFrame) {
    const err = new Error('malformed SSE frame: incomplete evidence')
    err.meta = { ...meta, badFrame: got.badFrame }; throw err
  }
  const finish = got && got.finish
  if (finish === 'stop' || finish === 'completed') return
  const err = new Error((String((got && got.out) || '').trim() ? 'incomplete' : 'empty') +
    ' distillate (finish=' + String(finish || 'missing') + ', reasoningChars=' + ((got && got.reasoningChars) || 0) + ')')
  err.meta = Object.assign({}, meta, { finish, reasoningChars: got && got.reasoningChars,
    outputChars: String((got && got.out) || '').length })
  throw err
}

/**
 * ★★ 2026-09-21 流式单次尝试（观测型迁移）★★
 * 与 distillOnce 同输入、同输出形状，只把传输改成 `stream: true`。
 * 产出 meta 里额外带：firstEventAt / firstContentAt / lastContentAt / completedAt /
 *   finishReason / outputChars / eventCount / truncated —— 用于把"输出前等待"与
 *   "可见输出阶段"分开（见外部审计的字段表）。
 * ⚠ 只认【非空 content delta】为首个内容：role-only delta、空串、usage、心跳一律不算。
 * ⚠ 半成品绝不冒充成功：未收到正常 finish 的流一律抛错，由上层原文放行。
 */
async function distillOnceStream(key, prompt, cfg, thinkingOff, ep, signal, inputChars = 0) {
  const style = ep && ep.api === 'openai-responses' ? 'responses' : 'chat'
  const url = (ep && ep.url) ? ep.url : endpointUrl(cfg.baseUrl, 'openai-completions')
  if (!url) throw new Error('no endpoint: neither host provider nor cfg.baseUrl resolved a URL')
  const payload = style === 'responses'
    ? { model: cfg.model, input: prompt, max_output_tokens: cfg.maxOutputTokens, temperature: 0, stream: true }
    : { model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxOutputTokens, temperature: 0, stream: true }
  if (thinkingOff) {
    if (style === 'responses') payload.reasoning = { effort: 'none' }
    else payload.thinking = { type: 'disabled' }
  }
  const body = JSON.stringify(payload)
  let r
  try {
    r = await requestStream(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
        'Accept-Encoding': 'identity',
      },
      body, timeoutMs: cfg.timeoutMs, cfg, signal,
    })
  } catch (e) {
    // ★★ 2026-09-21 补数据缺口（本轮实测发现）★★
    //   失败/取消路径此前**不带 promptChars** —— 恰恰在最需要看输入体积的时候看不见。
    //   后果：无法区分「TTFB 把预算吃光」与「生成本身太慢」这两类完全不同的失败。
    //   这里只补请求指纹，**不改任何行为**，然后原样抛出。
    e.meta = Object.assign({}, e.meta, {
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      stream: true, thinkingOff, model: cfg.model, stage: e.meta?.headersAt == null ? 'await-headers' : (e.meta?.eventCount ? 'receive-body' : 'await-first-event'),
    })
    throw e
  }
  if (r.status !== 200) throw Object.assign(new Error('http ' + r.status + ' (stream)'), { meta: r.meta })
  // ★ 统一响应入口（反向错配）：要求流式（stream:true），上游却回了整段 JSON。
  //   按 JSON 解析并显式记录；仍然遵守「半成品绝不冒充成功」——空摘要照样抛错。
  if (r.meta && r.meta.nonSse) {
    r.meta.protocolMismatch = 'json-body-on-stream-request'
    let j
    try { j = JSON.parse(String(r.text || '')) } catch (e) {
      throw new Error('bad json (stream request got non-sse body): ' + String(r.text || '').slice(0, 120))
    }
    if (j.usage) r.meta.providerReportedUsage = j.usage
    const got = extractFromJsonBody(j, style)
    if (!got) throw new Error('no choices (stream request got non-sse body): ' + String(r.text || '').slice(0, 120))
    requireCompleteDistill(got, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true, model: cfg.model })
    if (!String(got.out).trim()) {
      throw new Error('empty distillate (finish=' + got.finish + ', reasoningChars=' + got.reasoningChars + ', protocol=json-on-stream)')
    }
    return {
      text: String(got.out).trim(),
      meta: Object.assign({ finish: got.finish, reasoningChars: got.reasoningChars, thinkingOff, model: cfg.model, inputChars,
        promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
        endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit' }, r.meta),
    }
  }

  let out = ''
  let finish = ''
  let reasoningChars = 0
  let firstContentAt = null
  let lastContentAt = null
  let sawDone = false
  let badFrame = 0
  for (const ev of r.events) {
    let j = ev.json
    if (j === undefined) { try { j = JSON.parse(ev.data) } catch { badFrame += 1; continue } }
    if (style === 'responses') {
      // responses 流：只认 output_text.delta
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string' && j.delta) {
        out += j.delta
        if (firstContentAt === null) firstContentAt = ev.at
        lastContentAt = ev.at
      } else if (j.type === 'response.completed') { finish = 'stop'; sawDone = true }
      else if (j.type === 'response.incomplete') { finish = 'length'; sawDone = true }
      else if (j.type === 'response.reasoning_summary_text.delta' || j.type === 'response.reasoning_text.delta') {
        reasoningChars += String(j.delta || '').length
      }
      continue
    }
    const ch = j && j.choices && j.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (typeof d.reasoning_content === 'string') reasoningChars += d.reasoning_content.length
    // ⚠ 只有【非空 content】才算"首个摘要内容"
    if (typeof d.content === 'string' && d.content.length > 0) {
      out += d.content
      if (firstContentAt === null) firstContentAt = ev.at
      lastContentAt = ev.at
    }
    if (ch.finish_reason) { finish = ch.finish_reason; sawDone = true }
  }
  if (r.meta.done) sawDone = true

  // ④ 未正常完成 ⇒ 绝不冒充成功（连接断开、缺 [DONE]、缺 finish_reason 都算）
  if (!sawDone || r.meta.truncated) {
    const err = new Error('stream incomplete (done=' + sawDone + ', truncated=' + r.meta.truncated +
      ', events=' + r.events.length + ', finish=' + (finish || 'none') + ')')
    err.meta = Object.assign({}, r.meta, { firstContentAt, lastContentAt, finish })
    throw err
  }
  // ④ finish_reason=length ⇒ 被截断的摘要不是完整摘要
  // ★ 2026-09-22 补漏（用户要求）：这条失败路径此前把 promptChars 丢了 —— 恰好在
  //   最需要看「输入到底多大」的时候看不见。原因：下面 Object.assign 的基对象里
  //   有 promptChars，但失败分支直接用了 r.meta（它没有该字段）。故此处显式带上。
  if (finish === 'length') {
    const err = new Error('empty distillate (finish=length, stream truncated by max_tokens)')
    err.meta = Object.assign({}, r.meta, {
      firstContentAt, lastContentAt, finish,
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true,
      reasoningChars, model: cfg.model,
    })
    throw err
  }
  requireCompleteDistill({ out, finish, reasoningChars, badFrame }, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true, model: cfg.model })
  if (!String(out).trim()) {
    const err = new Error('empty distillate (finish=' + finish + ', reasoningChars=' + reasoningChars + ', stream)')
    err.meta = Object.assign({}, r.meta, {
      firstContentAt, lastContentAt, finish,
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, stream: true,
      reasoningChars, model: cfg.model,
    })
    throw err
  }
  return {
    text: String(out).trim(),
    meta: Object.assign({
      finish, reasoningChars, thinkingOff, model: cfg.model, inputChars,
      inputChars, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      stream: true, eventCount: r.meta.eventCount, badFrame,
      outputChars: String(out).trim().length,
      firstEventAt: r.meta.firstEventAt, firstContentAt, lastContentAt, completedAt: r.meta.completedAt,
      // 阶段分解（都是相对 requestSentAt 的毫秒数，便于直接比较）
      toHeadersMs: r.meta.ttfbMs,
      toFirstEventMs: r.meta.firstEventAt === null ? null : r.meta.firstEventAt - r.meta.requestSentAt,
      toFirstContentMs: firstContentAt === null ? null : firstContentAt - r.meta.requestSentAt,
      contentSpanMs: (firstContentAt === null || lastContentAt === null) ? null : lastContentAt - firstContentAt,
      toCompleteMs: r.meta.totalMs,
      endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit',
    }, r.meta),
  }
}

// 单次尝试。thinkingOff=true 时带上 `thinking:{type:'disabled'}`（关掉模型的思考）
async function distillOnce(key, prompt, cfg, thinkingOff, ep, signal, inputChars = 0) {
  const style = ep && ep.api === 'openai-responses' ? 'responses' : 'chat'
  // ⚠ 端点来自 resolveProviderEndpoint()；ep 为 null 时回落显式配置。
  //   2026-09-19：原写法 `cfg.baseUrl.replace(...)` 在 baseUrl 为空时会产出
  //   '/v1/chat/completions' 这样的**相对 URL**，报错会很难查。空就明说（上层已拦，这里是第二道）。
  const url = (ep && ep.url) ? ep.url : endpointUrl(cfg.baseUrl, 'openai-completions')
  if (!url) throw new Error('no endpoint: neither host provider nor cfg.baseUrl resolved a URL')
  const payload = style === 'responses'
    ? { model: cfg.model, input: prompt, max_output_tokens: cfg.maxOutputTokens, temperature: 0 }
    : { model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxOutputTokens, temperature: 0 }
  if (thinkingOff) {
    // 关思考的字段名按 api 风格给：chat 用 thinking，responses 用 reasoning.effort
    if (style === 'responses') payload.reasoning = { effort: 'none' }
    else payload.thinking = { type: 'disabled' }
  }
  const body = JSON.stringify(payload)
  const r = await requestOnce(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      // ⚠ node:https 不像 fetch 那样自动解压 ⇒ 显式要 identity，避免拿到二进制乱码
      'Accept-Encoding': 'identity',
    },
    body,
    timeoutMs: cfg.timeoutMs,
    cfg,
    signal,
  })
  if (r.status !== 200) throw new Error('http ' + r.status + ' ' + r.text.slice(0, 120))
  // ★★ 统一响应入口（2026-09-21）：先判【响应实际协议】，再选解析器 ★★
  //   事故：非流式请求收到 SSE 体 ⇒ 旧写法直接 JSON.parse ⇒ 'bad json'（trace 4 次）。
  //   错配时按【实际协议】解析并显式记录；绝不靠「失败后重发」掩盖本地解析缺陷。
  const protocol = detectResponseProtocol(r.text, r.meta && r.meta.contentType)
  let got
  if (protocol === 'sse') {
    r.meta.protocolMismatch = 'sse-body-on-json-request'
    got = collectSseFrames(assembleSseFrames(r.text).datas, style)
  } else {
    let j
    try { j = JSON.parse(r.text) } catch (e) { throw new Error('bad json: ' + r.text.slice(0, 120)) }
    if (j.usage) r.meta.providerReportedUsage = j.usage
    got = extractFromJsonBody(j, style)
    if (!got) throw new Error('no choices: ' + r.text.slice(0, 120))
  }
  const out = got.out
  const finish = got.finish
  const reasoningChars = got.reasoningChars
  requireCompleteDistill(got, { ...r.meta, promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style, model: cfg.model })
  // ★ 2026-09-15 实测：思考型模型会把整个 max_tokens 烧在 reasoning_content 上，
  //   然后 content 返回空串、finish_reason='length'。
  //   这时必须**把 finish_reason 和 reasoning 长度写进错误**，
  //   否则 trace 里只会看到一句含糊的 "empty distillate"，查不出真因。
  if (!String(out).trim()) {
    throw new Error('empty distillate (finish=' + finish + ', reasoningChars=' + reasoningChars + ')')
  }
  return {
    text: String(out).trim(),
    meta: Object.assign({ finish, reasoningChars, thinkingOff, model: cfg.model, inputChars,
      // ★ 2026-09-21 请求指纹（外部审计 P0-1）：把这次调用【实际发了什么】钉进 trace，
      //   否则「新旧构建交错测试」无法证明两次请求体是否等价。
      promptChars: prompt.length, maxOutputTokens: cfg.maxOutputTokens, style,
      endpoint: ep ? (ep.provider + '|' + ep.api) : 'legacy|explicit' }, r.meta),
  }
}

// 返回 { text, meta }：meta 里带本次调用的连接复用证据 + 实际用的模型
/**
 * ★★ 2026-09-21 任务状态编译（有证据支撑的任务状态记忆）★★
 *
 * 与 generateDistillation **共用同一条传输/重试/超时/取消机制**：
 * 仍是**一次**模型调用，不加串行调用链。
 * 生产 birth 默认为确定性记录 + 两栏判断；无 frame 的导出调用保留旧六栏兼容。
 *
 * 输出仍受原有铁律约束：模型完整成功 AND CAS 成功 AND 输出可接受 AND 净省达标，
 * 否则原文放行（判定在 birthFinish，不在本函数）。
 */
export async function generateStateMemory(env, cfg, signal, runtime = {}) {
  const hybrid = !!env?.deterministicFrame
  const prepared = hybrid ? (runtime.preparedJudgment?.env === env ? runtime.preparedJudgment : prepareJudgmentPrompt(env)) : null
  const prompt = prepared ? prepared.prompt : buildStateCompilePromptSafe(env)
  let r
  try { r = await generateDistillation(env && env.cot, cfg, signal, prompt, { ...runtime, promptVersion: prepared?.version }) }
  catch (e) {
    e.meta = { ...e.meta, promptBuildMs: prepared?.buildMs ?? null, promptBuildCount: prepared ? 1 : null,
      promptVersion: prepared?.version ?? null, staticPrefixChars: prepared?.staticPrefixChars ?? null }
    throw e
  }
  const renderStarted = performance.now()
  const parsed = parseStateCompile(r && r.text)
  if (hybrid && (!parsed.labeled || !parsed.found.length || parsed.extra.length || parsed.found.some(k => k !== 'judgment' && k !== 'gap'))) {
    const error = new Error('invalid judgment-only response'); error.meta = { ...r?.meta, parseRenderMs: performance.now() - renderStarted, promptVersion: prepared?.version }; throw error
  }
  const mp = createMemoryProjection({ namespace: 'compile-' + crypto.randomUUID() })
  const blockIndex = env && env.host && env.host.blockIndex != null ? env.host.blockIndex : null
  mp.ingest(parsed, { at: env && env.at != null ? env.at : Date.now(), origin: 'model', evidence: 'inferred', blockIndex })
  // ★ 证据驱动归并：时间顺序只决定处理顺序，证据关系决定能否替代
  const entries = mergeByEvidence(mp.all())
  // birth 用**本轮增量**（完整状态由 checkpoint 承载），避免每块复述所有历史约束
  const renderOpts = { preamble: MODEL_MEMORY_PREAMBLE }
  const born = renderIncrement(entries, blockIndex, renderOpts) + (hybrid && env.deterministicFrame.indexPath ? '\n〔确定性证据索引（工具事件不等于任务完成）：' + env.deterministicFrame.indexPath + '〕' : '')
  const board = renderCheckpoint(entries, renderOpts)
  // ★ 问题单元：把同一问题的信息连起来（只归拢已有材料，不新增事实）
  const unitInfo = cfg.stateProblemUnits === false ? { units: [], orphan: [] } : buildProblemUnits(entries)
  return {
    // ⚠ 保持与 generateDistillation 同形状：birthFinish 只认 text/meta
    text: born,
    meta: Object.assign({}, (r && r.meta) || {}, {
      stateMemory: true,
      promptBuildMs: prepared?.buildMs ?? null, promptBuildCount: prepared ? 1 : null,
      promptVersion: prepared?.version ?? null, staticPrefixChars: prepared?.staticPrefixChars ?? null,
      parseRenderMs: performance.now() - renderStarted,
      compilerMode: hybrid ? 'grounded-judgment-v2' : 'legacy-six-section',
      deterministicRevision: env?.deterministicFrame?.revision ?? null,
      evidenceProvided: env?.deterministicFrame?.evidenceInput?.receipts || null,
      evidenceBodyChars: env?.deterministicFrame?.evidenceInput?.bodyChars ?? null,
      duplicateBodyCharsAvoided: env?.deterministicFrame?.evidenceInput?.duplicateBodyCharsAvoided ?? null,
      evidencePolicy: env?.deterministicFrame?.evidenceInput?.policy || null,
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      schemaVersion: SCHEMA_VERSION, compilerVersion: COMPILER_VERSION, rendererVersion: RENDERER_VERSION,
      parsedSections: parsed.found,
      parsedExtra: parsed.extra.length,
      memory: memoryStats(entries),
      birthChars: born.length,
      boardChars: board.length,
      problemUnits: unitInfo.units.length,
      orphanEntries: unitInfo.orphan.length,
    }),
    // 供 checkpoint 路径使用（本函数不自行提交任何东西）
    checkpointText: hybrid ? born : board,
    entries,
    // ★ 供并行块的有序归并使用（按源块顺序，不按完成顺序）
    parsed,
    units: unitInfo.units,
    unitsText: unitInfo.units.length ? renderProblemUnits(unitInfo.units) : null,
  }
}

export async function generateDistillation(cot, cfg, signal, promptOverride, runtime = {}) {
  cfg = { ...cfg } // Freeze effective scalar request settings before asynchronous dispatch.
  if (!cfg.model) {
    // ⛔ 不猜模型名。followHostModel 开着但还没见过宿主模型 ⇒ 放弃提纯，让上层降级 rules。
    throw new Error('no model: followHostModel 开着但尚未读到宿主对话模型，且 cfg.model 为空')
  }
  // ★ 端点与钥匙跟随宿主 provider；解析失败**不猜**。
  //   2026-09-19 加固：原实现「解析失败 ⇒ 回落显式 baseUrl/credentialRef」，而那两个
  //   默认值曾经是作者的商户 ⇒ 外人装上后会去连不属于他的端点。现在两条路都要求
  //   【有人真的给过值】：宿主 provider 解析，或 patch 里的显式配置。都没有 ⇒ 抛错，
  //   由上层降级 rules —— 与上面 no-model 完全同形。
  const ep = resolveProviderEndpoint(cfg, cfg.followProvider)
  if (!ep && !cfg.baseUrl) {
    throw new Error('no endpoint: followHostProvider 解析不出宿主 provider，且 cfg.baseUrl 为空')
  }
  let key
  if (ep && ep.apiKeyEnv) key = readApiKeyRef(cfg, ep.apiKeyEnv)
  else key = readApiKey(cfg)
  // ★ 2026-09-21 任务状态记忆：允许调用方提供自定义提示词（仍是**一次**模型调用）。
  //   不传就沿用旧的 buildDistillPrompt —— 旧路径完全不变，可随时回滚。
  const prompt = promptOverride != null ? String(promptOverride) : buildDistillPrompt(cot)
  // ★ 2026-09-22 切分：记下**真正要压缩的输入**长度，使放大倍数可核。
  //   compress 模式：inputChars = 本段 reasoning 的字符数 ⇒ promptChars/inputChars 应 ≈ 1.x
  //   memory  模式：inputChars 仍是 raw，但真实的证据体量在 evidenceBodyChars，
  //                两者之差就是 7.5x 放大的来源，必须能被同一张表看出来。
  const inputChars = typeof cot === 'string' ? cot.length : 0
  const emit = (tag, data) => { try { runtime.trace?.(tag, data) } catch {} }
  const execute = async (transportSignal, flightId = null) => {
    const rounds = Math.max(1, cfg.maxAttempts)
    // 每一轮先带「关掉思考」试，被网关拒（4xx）再裸试一次。
    // 参数拒绝才沿用既有降级路径；实际请求与费用不能凭 4xx 推断。
    const modes = cfg.disableThinking ? [true, false] : [false]
    let lastErr
    for (let attempt = 1; attempt <= rounds; attempt++) {
      for (let i = 0; i < modes.length; i++) {
        try {
          if (transportSignal && transportSignal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true })
          // ★ 2026-09-21 观测型流式迁移：cfg.distillStream=true 时走 SSE。
          //   两者【同输入、同输出形状】，只有传输方式不同 ⇒ 可 A/B。
          const fn = cfg.distillStream ? distillOnceStream : distillOnce
          const requestId = crypto.randomUUID()
          emit('compiler-transport-started', { requestId, flightId, attempt, thinkingOff: modes[i], model: cfg.model, timeoutMs: cfg.timeoutMs,
            endpoint: ep ? ep.provider + '|' + ep.api : 'legacy|explicit', maxOutputTokens: cfg.maxOutputTokens,
            stream: !!cfg.distillStream, promptVersion: runtime.promptVersion || null })
          try {
            const r = await fn(key, prompt, cfg, modes[i], ep, transportSignal, inputChars)
            r.meta = { ...r.meta, requestId, flightId }
            emit('compiler-transport-settled', { ...settledTraceData(null, r.meta.totalMs, { ok: true, ...r }), requestId, flightId })
            return r
          } catch (e) {
            e.meta = { promptChars: prompt.length, inputChars, model: cfg.model, maxOutputTokens: cfg.maxOutputTokens,
              thinkingOff: modes[i], stream: !!cfg.distillStream, ...e.meta, requestId, flightId }
            emit('compiler-transport-settled', { ...settledTraceData(null, e.meta.totalMs, { ok: false, error: e.message, meta: e.meta }), requestId, flightId })
            throw e
          }
        } catch (e) {
          lastErr = e
          const canDowngrade = i < modes.length - 1 && isParamRejection(e)
          if (!canDowngrade) break
        }
      }
      if (attempt < rounds) {
        const delay = retryDelayMs(lastErr, attempt)
        if (delay == null) { emit('compiler-retry-skipped', { attempt, error: String((lastErr && lastErr.message) || lastErr) }); break }
        await new Promise((s) => setTimeout(s, delay))
      }
    }
    throw lastErr
  }
  if (!runtime.flights) return execute(signal)
  // Exact text, scope, effective endpoint/credential and all transport knobs.
  // Private ephemeral key; NEVER trace it or export a credential fingerprint.
  const identity = runtime.scope == null ? null : JSON.stringify([runtime.scope,
    ep?.url || endpointUrl(cfg.baseUrl, 'openai-completions'), ep?.api || 'openai-completions', ep?.provider || null,
    key, cfg.model, cfg.maxOutputTokens, cfg.timeoutMs, cfg.maxAttempts, cfg.disableThinking,
    cfg.distillStream, cfg.keepAlive, cfg.keepAliveMsecs]) + '\n' + prompt
  return runtime.flights.run(identity, execute, { signal, trace: runtime.trace })
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// ── 出生即提纯（mode: 'birth'）: At-Birth Interception ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 为什么需要它：0.1.5-rc.1 的 `dsh-session/lib/types/surface.js` 规定，一次
// `surfaceOp: replace` 必须携带覆盖全部被遮蔽节点的 `sourceEventSeqs`：
//    ·:207  `assistant/message` **禁止**携带 `sourceEventSeqs`（embeds its source stream）
//    ·:234  不带则 `missing` 非空 ⇒ :236 抛错
//  ⇒ 「事后用 replace 改写 assistant 消息」在该版本被架构性禁止，四条载体全封死。
//
// 破局点：把剪刀提前到「出生那一秒」。在 `llm/stream` 里改写 chunk，由宿主
// `dsh-agent-loop:1040 live.push(chunk)` 接收后装配成 assistant 消息 —— 这是一次
// **普通 append**，不需要 replace、不需要 sourceEventSeqs、不触发任何断言。
// 因为改写发生在 push 之前，accumulator / stream 字段 / replayState 全部自洽。
//
// 四条硬约束（每条都有源码出处，违反即坏）：
//   ① `block-start` 必须**立刻**透传。`dsh-llm/invariant.js:16` 要求 `reasoning-delta`
//      落在「已开」的 reasoning 块上 ⇒ 我们后发的 delta 只有在块已开时才合法。
//   ② `finish` 必须**押后到最后**。`invariant.js:53` 规定 finish 时不许有未关闭块。
//   ③ **归档先于压缩**。归档失败 ⇒ 原样透传。原始 CoT 绝不允许因压缩而丢失。
//   ④ 主流自己的错误必须原样抛出；我们内部的异常只许降级成「原样重放」。

/** 新建一个被扣住的 reasoning 块（等待结算）。 */
export function birthHoldNew(index) {
  return { index, text: '', end: null }
}

// ── 句柄纯函数推导（方案一 优化1：内存秒算，不占用任何 I/O）────────────────────
/**
 * 与 dsh-context-memory-bundle/store/dshb-store.js:582-587 **逐字一致**：
 *   'art://' + HMAC-SHA256(sessionId, sha256(text)).base64url.slice(0,22)
 * 无随机盐、无时间戳 ⇒ 同一 (session, content) 永远得到同一句柄，
 * 因此可以在 block-end 那一毫秒同步算好，让「CAS 写盘」与「模型提纯」同时起飞。
 * ⚠ sessionId 必须与后续 putText 传入的严格同源，否则 CMB resolve() 的所有权校验会拒发。
 */
export function deriveArtHandle(sessionId, text) {
  const sha = crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
  return 'art://' + crypto.createHmac('sha256', String(sessionId || ''))
    .update(sha).digest('base64url').slice(0, 22)
}

/** 到点即返回 null 的期限守卫。结算后立刻清定时器；**绝不 unref**（unref 会让事件循环当场排空）。 */
function birthDeadline(p, ms) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const settle = (v) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    if (ms > 0) timer = setTimeout(() => settle(null), ms)
    Promise.resolve(p).then(settle, () => settle(null))
  })
}

/** 把结算稿组装成下游该看到的 chunk 序列（live 模式只发改写后的 block-end）。 */
function birthEmitChunks(task, text, deps) {
  const chunks = []
  if (!deps.live) chunks.push({ type: 'reasoning-delta', index: task.index, text })
  if (task.end) {
    // ★★ 真机首跑抓出的关键 bug：BlockAssembler（dsh-llm/lib/index.js:936-940）在 block-end
    //   分支执行 `partial.block = chunk.block`，此后该块**以 block.text 为权威**
    //   （:924 `if (partial.block) return` 直接忽略后续 delta）。若把源流的 block-end 原样转发，
    //   压缩结果会被原文整体覆盖。故 block.text 必须一并改写。
    const b = task.end.block
    chunks.push(b && typeof b === 'object'
      ? { ...task.end, block: { ...b, text } }
      : { ...task.end, block: { type: 'reasoning', text } })
  }
  return chunks
}

/**
 * 阶段一（block-end 处）：**同步**起火，绝不 await。
 *   ① 内存秒算句柄（~0.05ms）
 *   ② diskP（CAS 写盘）与 distillP（宿主模型提纯）双向并发起飞
 * 低于门槛 / 无 store ⇒ belowFloor=true，调用方应立即原样放行（不必扣住）。
 * @returns 任务对象，finish 处交给 birthFinish 收口
 */
/**
 * ★★ 2026-09-21 证据采集（宿主集成层）★★
 *
 * 职责边界（刻意保持薄）：
 *   · 只**读** session，绝不改任何事件；
 *   · 来源按**原事件类型**判定，绝不用最终 role；
 *   · 先把宿主对象转成独立数据，再由 adaptEvidence 冻结 —— 杜绝共享引用破坏时间截面。
 *
 * @returns {{events:Array, inFlightIds:Set, cutSeq:number|null}}
 */
/**
 * ★★ 证据索引（2026-09-21 运行效率）★★
 *
 * 每个 reasoning block 都重扫全部 session 是真实成本。这里维护**只读轻量索引**：
 *   seq → 事件位置 ｜ toolCallId → { 调用, 结果 } ｜ 已确认来源的用户要求
 * 每块只装配相关证据。**少装配相关对象，比复制整段历史再冻结更有效。**
 *
 * 索引按 (session, 节点数) 失效重建；节点数不变即复用。
 */
// ════════════════════════════════════════════════════════════════════════
// ★★ 证据层（2026-09-21 收敛：唯一解释出口）★★
// ════════════════════════════════════════════════════════════════════════
//
// 曾经的问题：索引路径与回退扫描**各自解释「事件是什么」**，同一段会话在不同
// 运行条件下会形成不同证据（T28 就是这样抓到 tool/result 被漏掉的）。
//
// 现在：所有路径都必须经过 normalizeEvidenceEvent()，索引只负责「更快找到事件」。
//
// 缓存身份分两个概念（外部评审）：
//   · 原始事件索引 —— 按**日志追加位置**增量维护（append-only 允许只处理新增）
//   · 当前 surface 视图 —— 按宿主 surface 版本/长度单独判定
//     因为替换前后节点数可能相同，仅凭节点数无法识别 surface 内容变化。
const evidenceIndexCache = new WeakMap()

/**
 * 建立/复用规范事件索引。
 * @param {object} session
 * @returns {{events:Array, bySeq:Map, nodeKey:string, logLen:number}|null}
 */
export function evidenceIndex(session) {
  if (!session) return null
  let nodes = []
  try { nodes = Array.isArray(session.surface && session.surface.nodes) ? session.surface.nodes : [] } catch { nodes = [] }
  // ★ surface 视图身份：节点数 + 首尾节点 + 替换代数（若能拿到）
  const gen = (() => { try { return session.surface && session.surface.replaceGeneration != null ? session.surface.replaceGeneration : null } catch { return null } })()
  const nodeKey = JSON.stringify(nodes) + ':' + (gen == null ? '-' : gen)
  const prev = evidenceIndexCache.get(session)
  if (prev && prev.nodeKey === nodeKey) return prev
  const events = []
  const bySeq = new Map()
  for (const seq of nodes) {
    // Session events are append-only; reuse surviving normalized events instead
    // of parsing all historical tool bodies on every new block.
    let ev = prev && prev.bySeq.get(seq)
    if (!ev) {
      let raw = null
      try { raw = session.eventAt(seq) } catch { raw = null }
      if (!raw) continue
      ev = normalizeEvidenceEvent(raw, seq)
    }
    if (!ev) continue
    bySeq.set(seq, ev)
    events.push(ev)
  }
  const idx = { events, bySeq, nodeKey, nodeCount: nodes.length }
  evidenceIndexCache.set(session, idx)
  return idx
}

/**
 * 采集证据。索引与（无法建索引时的）回退扫描**共用同一个装配函数**，
 * 保证同样的事件得到同样的证据。
 */
// ════════════════════════════════════════════════════════════════════════
// ★★ 结构性上下文检索（2026-09-22，用户批准的 A 方案）★★
//
// 真机缺陷（176 节点会话，新构建 06:24 后实测）：
//   llm-stream 报 ledgerCount=3（三块看板确实在出站 payload 里）
//   但 state-envelope 报 priorMemory=0、cover=null
//   根因：collectEvidence 只取**最后 60 个节点**，看板早已滑出窗口
//         ⇒ 快照进不了输入 ⇒ 成对校验必然失败 ⇒ 过滤永不生效
//         ⇒ 全量 24.5k ⇒ 提纯超时 ⇒ 无新看板 ⇒ 自锁死循环。
//
// 修法：把采集拆成两路再合并 ——
//   路径一（本函数）：**跨窗口**找结构性节点（记忆快照／真实用户要求／运行时抬头）
//   路径二（下方 win）：沿用近期窗口，采 reasoning 与工具执行证据
//
// ⚠ 扫描范围扩大 ≠ 输入变多。路径一有**逐类上限**，且只取每类的**最新**若干条：
//   · 只取最新 1 份记忆快照 —— 绝不把全部历史看板捞回来（它们是全量快照，
//     最新那份已包含先前状态；将来若改为增量记忆，才需要额外取依赖链）。
//   · 只取最新 1 条运行时抬头 —— 旧运行状态不得重新挤进输入。
//   · 真实用户要求取最新若干条（要求及其后续修订都属于「目标与验收条件」）。
// ════════════════════════════════════════════════════════════════════════
const STRUCT_CAP = { ledger: 1, runtime: 1, user: 6 }
const STRUCT_LIMIT_DEFAULT = 12

/**
 * 判定一个规范事件是否属于「结构性上下文」。
 * 口径与 assembleEnvelopeParts 完全一致（human/generatedMemory/runtimeContext/runtime），
 * 来源未确认时再用结构化标头兜底 —— 绝不凭正文自称下结论。
 */
function structuralKindOf(e) {
  if (!e) return null
  const s = e.source
  const t = String(e.text || '')
  if (e.type === 'user/message') {
    if (s === SOURCE.human) return 'user'
    if (s === SOURCE.generatedMemory) return 'ledger'
    if (s === SOURCE.runtimeContext) return 'runtime'
    if (LEDGER_MARKERS.some((m) => t.includes(m))) return 'ledger'
    if (RUNTIME_MARKERS.some((m) => t.includes(m))) return 'runtime'
    return null
  }
  if (s === SOURCE.runtime) return 'runtime'
  return null
}
export function collectEvidence(session, opts = {}) {
  const empty = { events: [], inFlightIds: new Set(), cutSeq: null,
    coverage: { toolAssociation: 'unknown', userRequirements: 'unknown', omittedEvidence: true } }
  if (!session) return empty
  const limit = opts.limit == null ? 60 : opts.limit
  let nodes = []
  try { nodes = Array.isArray(session.surface && session.surface.nodes) ? session.surface.nodes : [] } catch { nodes = [] }
  if (!nodes.length) return empty
  const tail = nodes.slice(Math.max(0, nodes.length - limit))
  const inWindow = new Set(tail)
  // 路径一开关（回滚：stateStructuralFirst:false）
  // ⚠ 默认**关**（2026-09-22 用户裁定 A 暂不上线）：实测净负 +3711 字符。
  //   仅当显式传 { structural: true }（= cfg.stateStructuralFirst 打开）时才跨窗口取回。
  const structuralOn = opts.structural === true
  const structuralLimit = opts.structuralLimit == null ? STRUCT_LIMIT_DEFAULT : opts.structuralLimit
  // ① 取证据：优先走索引；索引不可用则**回退到同一规范化出口**（不是另一套解释）
  let all = null
  const idx = evidenceIndex(session)
  if (idx) all = idx.events
  if (!all) {
    all = []
    // ⚠ 路径一要跨窗口 ⇒ 无索引时也必须扫**全部节点**（倒序查找的等价物）。
    //   路径一关闭时保持旧行为（只扫窗口），不做无谓扫描。
    const scan = structuralOn ? nodes : tail
    for (const seq of scan) {
      let raw = null
      try { raw = session.eventAt(seq) } catch { raw = null }
      if (!raw) continue
      const ev = normalizeEvidenceEvent(raw, seq)
      if (ev) all.push(ev)
    }
  }
  // ② 路径二：窗口内事件（索引是全量的，回退本来就是窗口内的）
  const win = all.filter((e) => e.seq == null || inWindow.has(e.seq))
  // ②' 路径一：**跨窗口**结构性上下文（记忆快照／真实用户要求／运行时抬头）
  //     ⚠ 只从**窗口之外**取：窗口内本来就会带上，重复取没有意义。
  //     倒序遍历 = 优先取最新；逐类上限保证「扫描范围大」不等于「输入变多」。
  const structural = []
  if (structuralOn && structuralLimit > 0) {
    const used = { ledger: 0, runtime: 0, user: 0 }
    for (let i = all.length - 1; i >= 0 && structural.length < structuralLimit; i--) {
      const e = all[i]
      if (!e) continue
      if (e.seq != null && inWindow.has(e.seq)) continue
      const k = structuralKindOf(e)
      if (!k) continue
      if (used[k] >= (STRUCT_CAP[k] || 0)) continue
      used[k]++
      structural.push(e)
    }
    structural.reverse()   // 恢复时间顺序
  }
  // ③ 合并 + 按事件身份（seq）去重 ⇒ 再装配（唯一解释出口）
  const merged = []
  const seenSeq = new Set()
  for (const e of structural.concat(win)) {
    if (e.seq != null) { if (seenSeq.has(e.seq)) continue; seenSeq.add(e.seq) }
    merged.push(e)
  }
  const parts = assembleEvidence(merged, {})
  const evs = merged.slice()
  const cutSeq = tail.length ? tail[tail.length - 1] : null
  return {
    events: evs,
    inFlightIds: parts.inFlight,
    userAsks: parts.userAsks,
    tools: parts.tools,
    runtimeFacts: parts.runtimeFacts,
    unknownUserEvents: parts.unknownUserEvents,
    priorMemory: parts.priorMemory,
    cutSeq,
    // ★ 诊断：跨窗口取回了几条结构性节点（不进 coverage，避免被 adaptEvidence 收窄）
    structuralFetched: structural.length,
    structuralSeqs: structural.map((e) => e.seq),
    coverage: {
      toolAssociation: parts.inFlight.size === 0 ? 'complete' : 'partial',
      userRequirements: 'partial',
      windowEvents: merged.length,
      cutoff: cutSeq,
      omittedEvidence: nodes.length > tail.length,
    },
  }
}

const compileLanes = createCompileLanes()

/** A snapshot can replace old input only within the frozen evidence cut. */
export function rebaseCompileEnvelope(env, snapshot, cutSeq, enabled = true) {
  if (!enabled || !env || typeof env !== 'object' || !snapshot) return env
  if (!Number.isSafeInteger(cutSeq) || !Number.isSafeInteger(snapshot.sourceCutSeq) || snapshot.sourceCutSeq > cutSeq) return env
  if (env.stateSnapshot && snapshot.revision <= env.stateSnapshot.revision) return env
  const text = snapshotToText(snapshot)
  if (!text) return env
  const covered = coveredSeqSet(snapshot)
  if ([...covered].some(n => n > cutSeq)) return env
  const filtered = filterCoveredTools(env.tools, covered, COVER_TAIL_FLOOR)
  // Do not grow the prompt merely because a newer snapshot exists.
  if (!filtered.info) return env
  const candidate = buildEvidenceEnvelope({ ...env, tools: filtered.tools, stateSnapshot: {
    text, revision: snapshot.revision, entries: snapshot.entries.length,
    covered: covered.size, sourceCutSeq: snapshot.sourceCutSeq,
    snapshotId: snapshotIdOf(snapshot.sessionId, snapshot.branchId, snapshot.revision),
  } })
  return buildStateCompilePromptSafe(candidate).length < buildStateCompilePromptSafe(env).length ? candidate : env
}

/** Only a fully visible terminal result can acquire omission authority. */
export function fullyVisibleResultSeqs(tools) {
  return [...new Set((tools || []).filter(t => t && !t.resultTruncated && t.result != null &&
    ['completed', 'failed', 'cancelled'].includes(t.status) && Number.isSafeInteger(t.resultSeq) && t.resultSeq >= 0
  ).map(t => t.resultSeq))]
}

export function birthStart(entry, deps = {}) {
  const cfg = deps.cfg || {}
  const preparationStarted = performance.now()
  const taskId = crypto.randomUUID()
  const trace = (tag, data) => (deps.trace || (() => {}))(tag, { ...data, taskId })
  const raw = String(entry.text || '')
  const floor = cfg.birthMinChars == null ? 500 : cfg.birthMinChars
  const sessionId = typeof deps.sessionId === 'function' ? deps.sessionId() : (deps.sessionId || null)
  // ★ 分支键：宿主当前无分支概念 ⇒ normalizeBranchId 返回 'main'；一旦宿主提供则按分支隔离。
  const branchId = typeof deps.branchId === 'function'
    ? normalizeBranchId(deps.branchId())
    : normalizeBranchId(deps.branchId ?? deps.branch ?? null)
  const task = {
    taskId, index: entry.index, raw, end: entry.end || null,
    canDefer: sessionId != null && Buffer.byteLength(raw) <= 192 * 1024,
    handle: null, diskP: null, distillP: null,
    diskState: null, distillState: null,
    belowFloor: false, why: null,
    // ★ 2026-09-21 短路信号（外部审计第一批）：任一分支【终局不可用】⇒ 立刻唤醒收网，
    //   不再陪跑到 budgetMs。只停止"等待"，绝不取消 archive/distill 本身。
    shortP: null, shortReason: null, finishEnterAt: 0,
    abort: null,
  }
  let shortResolve = null
  task.shortP = new Promise((r) => { shortResolve = r })
  const noteShort = (why) => {
    if (!task.shortReason) task.shortReason = why
    if (shortResolve) { const r = shortResolve; shortResolve = null; r(why) }
  }
  if (cfg.enabled === false || cfg.mode === 'off' || cfg.dryRun === true) { task.belowFloor = true; task.why = cfg.dryRun ? 'dry-run' : 'disabled'; return task }
  if (!raw.trim() || raw.length < floor) { task.belowFloor = true; task.why = 'below-floor'; return task }
  if (cfg.birthArchive === false) { task.belowFloor = true; task.why = 'archive-off'; return task }
  task.compressMode = compileModeOf(cfg) === 'compress'
  const archive = deps.archive
  if (typeof archive !== 'function') { task.belowFloor = true; task.why = 'no-store'; return task }

  // ★ 2026-09-21：本任务的取消开关（外部审计 P0-2）。放弃应用时用它掐掉在飞的提纯。
  try {
    task.abort = new AbortController()
  } catch { task.abort = null }

  // ① 内存秒算句柄（纯函数；测试可注入 deriveHandle 以固定取值）
  const derive = typeof deps.deriveHandle === 'function' ? deps.deriveHandle : deriveArtHandle
  try { task.handle = derive(sessionId, raw) } catch { task.handle = null }

  // ② 并发起飞：写盘（独立超时护栏；卡住即当归档失败）
  const toMs = cfg.birthArchiveTimeoutMs == null ? 3000 : cfg.birthArchiveTimeoutMs
  task.diskP = birthDeadline(Promise.resolve().then(() => archive(raw, sessionId)), toMs)
    .then((h) => ({ ok: !!h, handle: h || null }))
    .catch((e) => {
      trace('birth-archive-error', { index: task.index, error: String((e && e.message) || e) })
      return { ok: false, handle: null }
    })
    .then((s) => {
      task.diskState = s
      trace('birth-archive-settled', { index: task.index, ok: s.ok, handle: s.handle, rawSha256: crypto.createHash('sha256').update(raw).digest('hex') })
      // 归档终局失败 ⇒ 拿不到句柄 ⇒ 提纯结果永远无法应用（铁律③）⇒ 立即短路
      if (!s.ok) {
        noteShort('archive-failed-early')
        // This consumer can never pass the mandatory archive gate, even if a
        // timed-out write eventually finishes. Do not cancel other consumers.
        task.abort?.abort()
        trace('compiler-consumer-unusable', { reason: 'archive-terminal-failure' })
      }
      return s
    })

  // ③ 并发起飞：提纯（100% 跟随宿主模型/provider；端点/钥匙由注入的 distill 决定，本模块不碰）
  const distill = deps.distill
  const dsignal = task.abort ? task.abort.signal : undefined
  // ★★ 2026-09-21 任务状态记忆：把"原始 reasoning"升格为"证据信封"。★★
  //   时间截面在**这里**固定：此后不再补入任何"后来才发生"的事实。
  //   信封纯数据、被冻结；构造失败一律回落裸 raw，绝不因为观测层出问题而碰坏主流。
  let distillInput = raw
  // ⚠ 作用域修复（2026-09-22）：这两个值在 settle 钩子（try 块**之外**）里要用。
  //   此前它们声明在 try 块内 ⇒ 钩子里引用必然 ReferenceError，又被 `catch {}` 吞掉
  //   ⇒ 覆盖水位一次都没真正推进过（这正是"过滤从未生效"的第二重原因）。
  let toolsForPrompt = null
  let adaptedCut = null
  let viewReceipts = []
  let preparationError = null
  let deterministicFrame = null
  let preparedJudgment = null
  // ★ 2026-09-22 切分：证据信封只在「状态记忆」模式构造。
  //   stateCompress（纯压缩）**不采集证据** —— 它只需要这段 reasoning，
  //   带上整窗工具正文正是实测 7.5x 放大的来源。
  if (compileModeOf(cfg) === 'memory' && typeof deps.buildEnvelope === 'function') {
    try {
      // ① 采集：只读 session；来源按**原事件类型**判定，绝不用最终 role
      const collected = typeof deps.collectEvidence === 'function'
        ? deps.collectEvidence({
            limit: cfg.stateEvidenceLimit == null ? 60 : cfg.stateEvidenceLimit,
            // ★ 结构性上下文跨窗口检索：看板/用户要求/运行时抬头不受 60 节点窗口限制
            structural: cfg.stateStructuralFirst === true,
          })
        : { events: [], inFlightIds: new Set(), cutSeq: null }
      // ② 适配：转独立数据 + 冻结快照（杜绝事后共享引用改动破坏时间截面）
      const adapted = adaptEvidence({
        events: collected.events, inFlightIds: collected.inFlightIds, cutSeq: collected.cutSeq,
        coverage: collected.coverage,
      })
      if (typeof deps.prepareEvidence === 'function') {
        try {
          deterministicFrame = deps.prepareEvidence({ sessionId, branchId, tools: adapted.tools,
            userAsks: adapted.userAsks, runtimeFacts: adapted.runtimeFacts, unknownUserEvents: adapted.unknownUserEvents, coverage: adapted.coverage, cutSeq: adapted.cut })
          task.deterministic = true
          trace(deterministicFrame.durable === false ? 'evidence-ledger-unavailable' : 'evidence-ledger-committed', { storageReason: deterministicFrame.storageReason, revision: deterministicFrame.revision,
            indexPath: deterministicFrame.indexPath, newObservations: deterministicFrame.newObservations, repeatedObservations: deterministicFrame.repeatedObservations,
            totalObservations: deterministicFrame.totalObservations })
        } catch (e) { preparationError = e; throw e }
      }
      // ★★ 快照持久化：编译输入止血（2026-09-22，用户批准路线）★★
      //   旧实现的两个根本缺陷（真机 + 会话日志逐条核对确认）：
      //     ① 覆盖判据依赖「本轮 priorMemory 里有一份更新的看板」，而看板是**渲染产物**，
      //        且会被宿主压缩整段删除（实测 seq=27097 替换掉 [26309,26733]，171 节点消失）
      //        ⇒ 判据恒为 false ⇒ 过滤一次都没生效；
      //     ② 水位线会连带跳过"未采集/迟到返回"的结果。
      //   现在改为：插件自己保存的**结构化快照**（不解析消息文本、不看 role、不认标记），
      //   覆盖判据 = 快照 coverage.coveredSeqs 的**精确成员判定**。
      //   ⚠ 没有快照 ⇒ 没有覆盖 ⇒ 全量发送（宁可多发，不可漏发）。
      let coverInfo = null
      toolsForPrompt = adapted.tools
      adaptedCut = adapted.cut == null ? null : adapted.cut
      let snapshot = null
      let snapInfo = null
      let snapText = ''
      try {
        snapshot = deterministicFrame || cfg.stateSnapshot === false ? null : loadSnapshot(sessionId, branchId)
        if (snapshot && Number.isSafeInteger(adaptedCut) && Number.isSafeInteger(snapshot.sourceCutSeq) && snapshot.sourceCutSeq > adaptedCut) {
          trace('state-snapshot-future-cut', { index: task.index, cutSeq: adaptedCut, snapshotCut: snapshot.sourceCutSeq })
          snapshot = null
        }
        if (snapshot) {
          snapInfo = snapshotStats(snapshot)
          snapText = snapshotToText(snapshot)
          if (!snapText) trace('state-snapshot-view-unavailable', { index: task.index, revision: snapshot.revision, reason: 'incomplete-or-oversize', filtering: false })
        }
      } catch (e) { trace('state-snapshot-error', { index: task.index, error: String((e && e.message) || e) }) }
      try {
        const covered = !cfg.stateEvidenceViews && cfg.stateCoveredEvidence !== false && snapshot && snapText
          ? coveredSeqSet(snapshot) : null
        if (covered && covered.size) {
          // ★ 过滤走**导出的纯函数**（与自测/重放同一份实现，杜绝「验证的是手抄副本」）
          const res = filterCoveredTools(adapted.tools, covered, COVER_TAIL_FLOOR)
          if (res.info) {
            toolsForPrompt = res.tools
            coverInfo = Object.assign({
              source: 'snapshot', revision: snapshot.revision, coveredSeqs: covered.size,
            }, res.info)
          }
        }
      } catch (e) { trace('state-cover-error', { index: task.index, error: String((e && e.message) || e) }) }
      if (!deterministicFrame && cfg.stateEvidenceViews === true) {
        const receipts = cfg.stateCoveredEvidence !== false && snapText ? snapshot.viewReceipts || [] : []
        const view = selectEvidenceViews(toolsForPrompt, receipts, { budget: cfg.stateEvidenceBodyBudget })
        toolsForPrompt = view.tools
        trace('state-evidence-view', { index: task.index, ...view.stats })
      }
      // ③ 构造信封（仍是**一次**模型调用；仍是纯数据）
      // ⚠ 这里**不**注入迟到结果：收网器一旦发射 ledger，assembleEvidence 会
      //   自动把它读回来当 priorMemory（同一条通路），此处再注入就是重复。
      distillInput = deps.buildEnvelope({
        cot: raw,
        userAsks: adapted.userAsks,
        // ⚠ 绝不能改 adapted（Object.freeze）—— 传过滤后的数组本身
        tools: deterministicFrame ? [] : toolsForPrompt,
        runtimeFacts: adapted.runtimeFacts,
        priorMemory: adapted.priorMemory,
        // ★ 结构化状态快照：**完整**注入（走独立字段，不经 priorMemory 的 1200 字符腰斩）
        stateSnapshot: snapText ? {
          text: snapText,
          revision: snapshot.revision,
          entries: (snapshot.entries || []).length,
          covered: (snapshot.coverage && snapshot.coverage.coveredSeqs) ? snapshot.coverage.coveredSeqs.length : 0,
          sourceCutSeq: snapshot.sourceCutSeq,
          snapshotId: snapshotIdOf(snapshot.sessionId, snapshot.branchId, snapshot.revision),
        } : null,
        unknownUserEvents: adapted.unknownUserEvents,
        coverage: cfg.stateEvidenceViews ? { ...adapted.coverage, omittedEvidence: true } : adapted.coverage,
        host: Object.assign({
          step: entry.step == null ? null : entry.step,
          blockIndex: task.index,
          archive: 'in-flight',
        }, entry.host || {}),
        at: Date.now(),
      })
      if (deterministicFrame) distillInput = Object.freeze({ ...distillInput, deterministicFrame })
      if (deterministicFrame) trace('compiler-input-prepared', { revision: deterministicFrame.revision, bodyChars: deterministicFrame.evidenceInput?.bodyChars || 0, receipts: deterministicFrame.evidenceInput?.receipts || [], meaning: 'input-prepared-not-proof-of-transmission-or-understanding' })
      toolsForPrompt = distillInput.tools
      viewReceipts = toolsForPrompt.filter(t => t.result != null && validReceipt(t.viewReceipt)).map(t => t.viewReceipt)
      // ★ 提示词体量画像（2026-09-21）：把「优化省了多少」变成可核对的生产数据。
      //   此前只能靠本地合成场景猜重复率，现在真实分布直接落 trace。
      let pstats = null
      try {
        if (deterministicFrame) preparedJudgment = prepareJudgmentPrompt(distillInput)
        pstats = preparedJudgment ? { totalChars: preparedJudgment.prompt.length, toolBodyChars: deterministicFrame.evidenceInput?.bodyChars || 0, compilerMode: 'grounded-judgment-v2', promptVersion: preparedJudgment.version, promptBuildMs: preparedJudgment.buildMs } : promptStats(distillInput)
      } catch { pstats = null }
      trace('state-envelope', {
        index: task.index, cotChars: raw.length,
        tools: distillInput.counts.tools, pending: distillInput.counts.pending,
        terminal: distillInput.counts.terminal, userAsks: distillInput.counts.userAsks,
        runtimeFacts: distillInput.counts.runtimeFacts, priorMemory: distillInput.counts.priorMemory,
        unknownUser: distillInput.counts.unknownUserEvents, coverageIncomplete: distillInput.counts.coverageIncomplete,
        coverage: distillInput.coverage, cutSeq: adapted.cut,
        // ★ 编译输入止血（2026-09-22）：本轮因「已覆盖」而少发了多少旧工具证据
        cover: coverInfo,
        // ★ 快照持久化诊断：本轮注入的是哪个 revision、覆盖了多少条、是否已应用到主请求面
        snapshot: snapInfo,
        snapshotChars: distillInput.counts.snapshotChars,
        // ★ 结构性上下文跨窗口取回了几条（A 方案；0 = 未启用或窗口外没有）
        structural: collected.structuralFetched == null ? null : collected.structuralFetched,
        structuralSeqs: collected.structuralSeqs || null,
        prompt: pstats,
      })
      // 缓存身份：**影响摘要结论的内容才进入**（同一 reasoning 在不同工具终局下不得共用摘要）
      if (cfg.stateCacheKeyTrace) trace('state-cache-identity', { index: task.index, hash: crypto.createHash('sha256').update(cacheIdentity(distillInput)).digest('hex').slice(0, 16) })
    } catch (e) {
      if (typeof deps.prepareEvidence === 'function') preparationError ||= e
      trace('state-envelope-error', { index: task.index, error: String((e && e.message) || e) })
      distillInput = raw
    }
  }
  trace('compiler-preparation-cost', { ms: performance.now() - preparationStarted, promptBuilt: !!preparedJudgment })
  const queued = !deterministicFrame && cfg.stateCompileQueue === true && compileModeOf(cfg) === 'memory' && cfg.stateSnapshot !== false &&
    cfg.stateCoveredEvidence !== false && sessionId != null && Number.isSafeInteger(adaptedCut) &&
    typeof distill === 'function' && typeof distillInput === 'object'
  // The existing transport budget now includes queue residence, not extra time.
  const queueBudget = Number(cfg.timeoutMs == null ? 8000 : cfg.timeoutMs)
  const deadline = Date.now() + (Number.isFinite(queueBudget) && queueBudget > 0 ? queueBudget : 8000)
  const ticket = queued ? compileLanes.reserve(JSON.stringify([sessionId, branchId]), { signal: dsignal, deadline }) : null
  let queueTimer = null
  if (queued && task.abort) queueTimer = setTimeout(() => task.abort.abort(), Math.max(1, deadline - Date.now()))
  task.distillP = (typeof distill === 'function'
    ? Promise.resolve().then(async () => {
        if (preparationError) throw preparationError
        if (ticket) {
          await ticket.ready
          if (dsignal?.aborted || Date.now() >= deadline) throw new Error('compile-queue-expired')
          const before = buildStateCompilePromptSafe(distillInput).length
          const snapshot = loadSnapshot(sessionId, branchId)
          if (!cfg.stateEvidenceViews) distillInput = rebaseCompileEnvelope(distillInput, snapshot, adaptedCut)
          toolsForPrompt = distillInput.tools
          trace('state-queue-dispatched', { index: task.index, remainingMs: deadline - Date.now(),
            beforeChars: before, afterChars: buildStateCompilePromptSafe(distillInput).length,
            revision: distillInput.stateSnapshot?.revision ?? null })
        }
        return distill(distillInput, dsignal, {
          ...(ticket ? { timeoutMs: Math.max(1, deadline - Date.now()) } : {}), preparedJudgment,
          taskId, trace, scope: sessionId != null && String(sessionId).length > 0 && Number.isSafeInteger(adaptedCut) && adaptedCut >= 0 ? [String(sessionId), branchId, adaptedCut] : null,
        })
      })
    : Promise.reject(new Error('no-distiller')))
    .then((r) => {
      const text = r && r.text != null ? String(r.text).trim() : ''
      if (!text) throw new Error('empty distillate')
      // ★ 状态记忆分支：把六栏对象与有效性一并带出去，供 trace 与后续 checkpoint 使用。
      //   注意此处**不**提交任何东西 —— 提交仍由 birthFinish + 现有 surface 通路决定。
      let entries = (r && r.entries) || null
      // ★ 2026-09-23 compress 接入迟到通路：纯压缩没有六栏，但摘要本身就是可认领的产物。
      //   包成一条最小 entry ⇒ pushLateMemory 的 entries 门禁放行；快照仍不提交（见下方 stateSnapshot 门）。
      if (!entries && compileModeOf(cfg) === 'compress') {
        entries = [{ id: 'compress:' + taskId.slice(0, 8), category: 'state', content: text, source: 'model', basis: 'compressed-reasoning' }]
      }
      return { ok: true, text, meta: (r && r.meta) || null, entries,
               checkpointText: (r && r.checkpointText) || text, parsed: (r && r.parsed) || null }
    })
    .catch((e) => {
      // ★ 2026-09-21 补漏：这里原本把 `e.meta` 丢了 ⇒ **超时/取消**这条最该诊断的路径
      //   一个阶段字段都落不了盘（真机首条 settled 就是这样：ok:false, reason:cancelled,
      //   无 ttfbMs / toFirstContentMs / chunks）。现在原样带出去。
      const em = (e && e.meta) || null
      trace('birth-distill-failed', Object.assign(
        { index: task.index, error: String((e && e.message) || e) },
        em ? {
          ttfbMs: em.ttfbMs, totalMs: em.totalMs, chunks: em.chunks, reused: em.reused,
          status: em.status, cancelled: em.cancelled, stream: em.stream === true ? true : undefined,
          toFirstEventMs: em.toFirstEventMs, toFirstContentMs: em.toFirstContentMs,
          contentSpanMs: em.contentSpanMs, eventCount: em.eventCount,
        } : {}))
      return { ok: false, error: String((e && e.message) || e), meta: em }
    })
    .then(async (s) => {
      task.distillState = s
      // 提纯终局失败 ⇒ 必定原文放行 ⇒ 没有理由再等（归档仍在后台继续）
      if (!s.ok) noteShort('distill-failed-early')
      // ★★ 方案二：这次结果没赶上自己那块（已放行原文）⇒ 暂存给下一轮。
      //   仅当：编译成功 && 带六栏 entries && 确实已放行 && 开关打开。
      //   失败/取消一律不存 —— 绝不把半成品当记忆。
      // ★★ 快照持久化：**只在编译成功时**提交（失败/取消一律不提交 ⇒ 下轮仍能看到这批证据）。
      //   覆盖集合 = 本轮**真正发给模型的**那些工具证据的 resultSeq（= toolsForPrompt）。
      //   为什么不是 cutSeq / maxSeq：cutSeq 可能指向 pending 调用，maxSeq 会跳过未采集
      //   与迟到返回的结果 —— 两者都会把"结果未返回"当成已知，违反时间截面。
      //   写入顺序由 commitSnapshot 保证：先归并 entries → 先写完整快照 → 再原子替换指针。
      // The archive is a prerequisite for both persistent and deferred memory.
      // Waiting here is background work; birthFinish retains its own deadline.
      const archived = s.ok && s.entries ? await task.diskP : null
      // ⚠ 快照只属于 memory 模式：compress 的最小 entry 是摘要，不是判断，绝不写进持久快照。
      if (s.ok && s.entries && archived && archived.ok && cfg.stateSnapshot !== false && compileModeOf(cfg) === 'memory') {
        try {
          const seqs = fullyVisibleResultSeqs(toolsForPrompt)
          const c = commitSnapshot({
            sessionId, branchId, entries: s.entries, coveredSeqs: seqs, viewReceipts,
            sourceCutSeq: adaptedCut, at: Date.now(),
          })
          if (c.ok) {
            if (cfg.stateSnapshotMirror && typeof deps.mirrorSnapshot === 'function') {
              const mirror = JSON.stringify(c.snapshot)
              setImmediate(() => Promise.resolve().then(() => deps.mirrorSnapshot(mirror, sessionId))
                .then(ref => trace('state-snapshot-mirrored', { revision: c.snapshot.revision, ok: !!(ref && ref.handle) }),
                  e => trace('state-snapshot-mirror-failed', { error: String(e.message || e) })))
            }
            trace('state-snapshot-committed', {
              index: task.index, revision: c.snapshot.revision, parentRevision: c.mergedFrom,
              entries: c.snapshot.entries.length, added: c.added,
              covered: c.snapshot.coverage.coveredSeqs.length, newSeqs: c.newSeqs,
              sourceCutSeq: c.snapshot.sourceCutSeq, locked: c.locked,
              snapshotId: snapshotIdOf(sessionId, branchId, c.snapshot.revision),
            })
          } else {
            trace('state-snapshot-commit-failed', { index: task.index, reason: c.reason })
          }
        } catch (e) { trace('state-snapshot-error', { index: task.index, where: 'commit', error: String((e && e.message) || e) }) }
      }
      if (s.ok && s.entries && archived && archived.ok && task.passedThrough && cfg.birthDeferredClaim !== false) {
        const worthStoring = !(task.deterministic || task.compressMode) || raw.length - String(s.checkpointText || s.text).length >= (cfg.birthMinSavedChars ?? 50)
        const stored = worthStoring && pushLateMemory(sessionId, raw, s.entries, s.checkpointText, { branchId, taskId })
        if (!stored) trace('birth-late-memory-refused', { index: task.index, reason: worthStoring ? 'invalid-or-capacity' : 'no-gain', branchId })
        if (stored) trace('birth-late-memory-stored', {
          index: task.index, entries: s.entries.length,
          chars: s.text ? s.text.length : 0,
          // ★ 真工期：这是回答「预算该给多少」的唯一直接证据
          distillMs: (s.meta && s.meta.toCompleteMs) || null,
          ttfbMs: (s.meta && s.meta.ttfbMs) || null,
          promptChars: (s.meta && s.meta.promptChars) || null,
        })
      }
      return s
    }).finally(() => {
      clearTimeout(queueTimer)
      ticket?.release() // Must be AFTER successful snapshot commit (or failure).
    })

    // ★ 真工期探针（2026-09-18）：收尾即使已熔断，伴生调用真正结束时也会落一条记录。
    //   纯观测，不改任何行为。用途：回答「finishWaitMs 该设多少」「这笔调用是否白付」。
    if (task.distillP && typeof task.distillP.then === "function") {
      const _t0 = Date.now()
      task.distillP.then((s) => {
        // ★ 2026-09-21：把请求指纹与阶段耗时一并落 trace（外部审计 P0-1）。
        //   connectMs=建连 / ttfbMs=响应头 / firstByteMs=首个正文字节 / totalMs=读完 / chunks=分片数。
        //   非流式下 firstByte≈ttfb；一旦上游 chunked，这两个数就能把「排队」与「生成」分开。
        // ★ 2026-09-21 补漏：流式阶段字段此前只写进 meta、**没进 trace 白名单**，
        //   导致第一次真机读数的 trace 里看不到它们（只能拿 ttfb/totalMs 反推）。
        //   现在记录体由纯函数 settledTraceData() 生成，并有端到端 trace 测试钉住。
        trace("birth-distill-settled", settledTraceData(task.index, Date.now() - _t0, s))
      }, () => {}).catch(() => {})
    }

  trace('birth-fired', { index: task.index, rawChars: raw.length, handle: task.handle })
  task.firedAt = Date.now()
  return task
}

/**
 * 阶段二（finish 处）：收网。硬上限 birthFinishWaitMs（终审 1500ms），到点立即熔断。
 * 判定：句柄已落盘 && 提纯成功 && 净省 ≥ birthMinSavedChars ⇒ 改写稿；否则 raw(+句柄)。
 * 失败一律原样放行 —— **零 rules 兜底**（方案一铁律 1）。
 */
export async function birthFinish(task, deps = {}) {
  const cfg = deps.cfg || {}
  const trace = (tag, data) => (deps.trace || (() => {}))(tag, { ...data, taskId: task.taskId || null })
  const handleInText = cfg.birthHandleInText !== false
  const raw = String(task.raw || '')
  // ★★ 2026-09-18 用户令：句柄标记从上下文中【彻底删除】，一个字符都不许出现。★★
  //   理由（血的教训）：模型对着一根裸指针无法思考。替换文本必须携带【语义内容】：
  //     A 态 → 宿主模型提纯出的语义摘要；B 态 → 原文逐字。
  //   句柄只用于 CAS 归档登记（磁盘上的证据索引），绝不写进模型可见的文本。
  const withHandle = (text, _handle) => text
  // ★★ 2026-09-18 终审（用户令）——兜底 = 原文逐字，句柄绝不进上下文 ★★
  //   事故复盘：曾把兜底改成「裸句柄指针」，导致模型失去自身思维链、
  //   对着一根指针无法思考。该做法已永久废除。
  //   现行语义：能提纯 ⇒ 语义摘要（A 态）；超时/失败/不划算 ⇒ 原文逐字（B 态）。
  //   句柄仅用于 CAS 归档登记与磁盘证据索引，绝不写进模型可见文本。
  // ★ 2026-09-21 放弃应用 ⇒ 掐掉仍在飞的提纯（外部审计 P0-2）。
  //   判据严格：只有【本任务确实起了提纯】且【它还没落地】时才取消 —— 已落地的结果
  //   绝不取消（那是已经付过的钱）。
  //
  // ★★ 2026-09-22 方案二：**有消费者就不取消** ★★
  //   上面这段注释自己预言了这一刻：「将来若接入『历史 checkpoint 回收』，
  //   这里必须改成『有消费者就不取消』」。现在消费者出现了 —— 暂存区（lateMemory）。
  //
  //   真机证据（2026-09-22T04:50:04，finishWaitMs 刚降到 1500）：
  //     [birth-finish-enter]      gapMs=15
  //     [birth-distill-cancelled] why=distill-timeout waitedMs=1506
  //     [birth-passthrough]       cancelled=true waitedMs=1501
  //     [birth-distill-failed]    error="cancelled"
  //     [birth-distill-settled]   ok=false reason="cancelled"
  //   ⇒ 放行时把仍在飞的提纯 abort 掉 ⇒ 暂存区永远拿不到迟到成功
  //   ⇒ 收网通路虽已接通，仍会**每轮空转**（birth-claim-idle）。
  //
  //   不取消 ≠ 无限等：提纯仍受自身 timeoutMs(8000) 约束，到点自然失败；
  //   暂存区另有容量上限与过期清理。放行本身仍是零等待。
  const cancelFlying = (why) => {
    if (!task.abort || task.distillState !== null) return false
    if (cfg.birthDeferredClaim !== false) return false
    if (cfg.birthCancelOnGiveUp === false) return false
    try { task.abort.abort() } catch { /* ignore */ }
    trace('birth-distill-cancelled', {
      index: task.index, why,
      waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0,
    })
    return true
  }

  const pass = (why, handle, extra) => {
    const text = withHandle(raw, handle)
    const waitedMs = task.finishEnterAt ? Date.now() - task.finishEnterAt : 0
    const cancelled = cancelFlying(why)
    // ★ 方案二：标记「本块已放行原文」⇒ 若 distill 稍后才成功，它的结果改走暂存给下一轮。
    task.passedThrough = true
    trace('birth-passthrough', { index: task.index, why, rawChars: raw.length, outChars: text.length, handle: handle || null, waitedMs, short: task.shortReason || null, cancelled, ...(extra || {}) })
    return { chunks: birthEmitChunks(task, text, deps), text, why, rawChars: raw.length, outChars: text.length, handle: handle || null }
  }

  if (task.belowFloor) return pass(task.why || 'below-floor', null)

  // ★ 2026-09-23：compress 也走 ready-only。它的迟到产物现在能进暂存区被下轮认领，
  //   没有理由再让用户在 finish 处等 finishWaitMs（线上 4000ms）却大概率拿不到结果。
  //   legacy（无迟到消费者）保持原预算等待语义。
  const lateCapable = task.deterministic || task.compressMode === true
  const readyOnly = lateCapable && cfg.birthDeferredClaim !== false && task.canDefer !== false
  task.finishEnterAt = Date.now()
  trace('birth-finish-enter', { index: task.index, gapMs: task.finishEnterAt - (task.firedAt || 0), waitPolicy: readyOnly ? 'ready-only' : 'budgeted' })
  if (readyOnly && (!task.diskState || !task.distillState)) {
    const why = task.distillState?.ok === false ? 'judgment-failed' : task.diskState?.ok === false ? 'archive-failed' : 'background-judgment-pending'
    return pass(why, null)
  }
  const budgetMs = readyOnly ? 0 : (cfg.birthFinishWaitMs == null ? 1500 : cfg.birthFinishWaitMs)
  // ★ 自然窗口探针（2026-09-18）：量出「block-end → finish」这段**免费**时间。
  //   α 的成败全看它：摘要在这一段里落地 = 白捡的 A 态；没落地 = 纯句柄（零等待）。
  // ★★ 终审 α（2026-09-18）：budgetMs <= 0 ⇒ 真零等待模式 ★★
  //   实测伴生提纯真工期 3.3~4.0s（探针 birth-distill-settled）。任何 0 < budget < 真工期的取值
  //   都是「白等一段还拿不到摘要」——2000ms 实测 0/2 命中，是被支配的选项。故：
  //     budgetMs  > 0 ：等 disk+distill（旧语义，命中则 A 态语义摘要）
  //     budgetMs <= 0 ：只等写盘落地（本地 I/O，护栏 400ms），绝不等提纯
  //                     ⇒ 真零等待，直接纯句柄放行（写盘未确认仍回吐原文，安全底线不变）
  //   ⚠ birthDeadline(p, 0) 的旧语义是「不设定时器 = 无限等」，零等待必须显式分支。
  if (!(budgetMs > 0)) {
    await birthDeadline(task.diskP, cfg.birthDiskWaitMs == null ? 400 : cfg.birthDiskWaitMs)
  } else {
    // ★ 2026-09-21：短路信号一响就收网，绝不为一个已经注定走原文的结果陪跑到 budget。
    //   实测可回收：archive-failed 52 次 + distill-failed 4 次（本机 trace.log）。
    const shortP = task.shortP || new Promise(() => {})
    await birthDeadline(Promise.race([Promise.all([task.diskP, task.distillP]), shortP]), budgetMs)
  }

  const disk = task.diskState
  const dist = task.distillState
  const handle = disk && disk.ok && typeof disk.handle === 'string' && disk.handle
    ? disk.handle
    : (disk && disk.ok ? (task.handle || null) : null)

  // 铁律③：拿不到句柄（或写盘未落地）⇒ 绝不替换原文
  if (!handle) return pass(task.shortReason || (disk === null ? 'archive-timeout' : 'archive-failed'), null)

  // 零 rules：只有宿主模型提纯成功且净省够本才替换
  if (dist && dist.ok) {
    const candidate = withHandle(dist.text, handle)
    const netSaved = raw.length - candidate.length
    const minSaved = cfg.birthMinSavedChars == null ? 50 : cfg.birthMinSavedChars
    if (netSaved >= minSaved) {
      trace('birth-condensed', { index: task.index, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, minSaved, handle, waitedMs: task.finishEnterAt ? Date.now() - task.finishEnterAt : 0 })
      return { chunks: birthEmitChunks(task, candidate, deps), text: candidate, why: 'condensed', rawChars: raw.length, outChars: candidate.length, netSaved, handle }
    }
    return pass('no-gain', handle, { netSaved, minSaved })
  }
  return pass(dist === null ? 'distill-timeout' : 'distill-failed', handle, { error: (dist && dist.error) || null })
}

// ════════════════════════════════════════════════════════════════════════════
// ★★ 方案二：迟到结果暂存（2026-09-21 用户令）★★
//
// 背景（实测）：`birth-fired → birth-finish-enter` 的 gapMs 只有 **4 / 5 / 23 ms**，
//   即「推理块结束」与「流结束」几乎同时发生 ⇒ **distill 没有任何预热余地**。
//   所以旧结构只有两种结局：在 finishWaitMs 内跑完（替换），或干等到底（原文）。
//   用户令：**不加预算，但要减少实际等待。**
//
// 做法：零等待放行原文（finishWaitMs<=0），distill 继续在后台跑完；
//   其结果**不再丢弃**，而是暂存，在**下一次请求**的信封里作为 priorMemory 进入模型输入。
//   ⇒ 实际等待 = 0；压缩从下一轮生效。
//
// ⚠ 铁律不变：只暂存**成功**的结果；失败/取消一律不存（绝不把半成品当记忆）。
// ⚠ 一旦被某个信封消费就移除，绝不重复注入（防止同一结论反复占位）。
// 按 sessionId + branchId 隔离；相同 raw 不证明相同源任务。
// ════════════════════════════════════════════════════════════════════════════
// ⚠ 按【原始推理文本】索引 —— 收网器只能从 assistant 事件里拿到 raw 文本，
//   没有可靠宿主消息 ID；raw 仅用于候选匹配，已知歧义必须拒绝。
const lateMemory = new Map()      // JSON([sessionId, branchId]) -> bounded records
const lateKey = (sid, opts = {}) => JSON.stringify([String(sid), normalizeBranchId(opts.branchId)])
const LATE_MEMORY_KEYS_MAX = 128
const LATE_MEMORY_BYTES_MAX = 8 * 1024 * 1024
const LATE_MEMORY_ITEM_BYTES_MAX = 256 * 1024
const LATE_MEMORY_MAX = 8         // 每个会话最多暂存 8 个块，防止无界增长
// ★ 过期清理：放行后继续跑的任务不等于无限保留。超过 TTL 的结果一律丢弃，
//   绝不把十分钟前的旧状态当成「当前记忆」注入。
const LATE_MEMORY_TTL_MS = 10 * 60 * 1000

/** 丢弃过期项。就地修改，纯本地。 */
function pruneLateMemory(q) {
  if (!q || !q.length) return
  const now = Date.now()
  for (let i = q.length - 1; i >= 0; i--) if (now - q[i].at > LATE_MEMORY_TTL_MS) q.splice(i, 1)
}

/** 暂存一个「没赶上自己那块」的编译结果。纯内存、绝不抛错。 */
export function pushLateMemory(sessionId, raw, entries, board, opts = {}) {
  try {
    if (sessionId == null || typeof raw !== 'string' || !raw) return false
    if (!Array.isArray(entries) || !entries.length) return false
    for (const [key, queue] of lateMemory) {
      pruneLateMemory(queue)
      if (!queue.length) lateMemory.delete(key)
    }
    const key = lateKey(sessionId, opts)
    let q = lateMemory.get(key)
    if (!q && lateMemory.size >= LATE_MEMORY_KEYS_MAX) return false
    if (!q) { q = []; lateMemory.set(key, q) }
    const taskId = opts.taskId == null ? null : String(opts.taskId)
    const at = taskId == null ? -1 : q.findIndex(x => x.taskId === taskId && x.raw === raw)
    const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
    const encoded = JSON.stringify(entries)
    const bytes = Buffer.byteLength(raw) + Buffer.byteLength(encoded) + Buffer.byteLength(String(board || ''))
    const used = [...lateMemory.values()].reduce((n, queue) => n + queue.reduce((m, x) => m + (x.bytes || 0), 0), 0)
    if (bytes > LATE_MEMORY_ITEM_BYTES_MAX || used - (at >= 0 ? q[at].bytes || 0 : 0) + bytes > LATE_MEMORY_BYTES_MAX) {
      if (!q.length) lateMemory.delete(key)
      return false
    }
    const safeEntries = freeze(JSON.parse(encoded))
    const item = { at: Date.now(), bytes, raw, taskId, entries: safeEntries, board: board == null ? null : String(board), chars: String(board || '').length }
    if (at >= 0) { item.ambiguous = q[at].ambiguous; q[at] = item }
    else {
      // Raw equality is not source identity. Keep a poison marker even if a
      // colliding candidate is later evicted by the capacity bound.
      for (const old of q) if (old.raw === raw) { old.ambiguous = true; item.ambiguous = true }
      q.push(item)
    }
    while (q.length > LATE_MEMORY_MAX) q.shift()
    return true
  } catch { return false }
}

// ════════════════════════════════════════════════════════════════════════════
// ★★ 编译输入止血（2026-09-22，用户批准的第一轮）★★
//
// 真机实测（trace state-envelope，近 30 次）：
//   priorMemory 最大 = 1（219 次里只有 30 次 >0）  ← 回灌不是主因
//   toolBlockChars = 25366~28383                  ← 主体，且每轮几乎不变
//   toolLines = 28~29                             ← 每轮**全量重发**同一批工具证据
//
// 所以「旧状态反复进入输入」的真实形态不是看板回灌，而是：
//   一份状态快照已经把 E1..E28 编译进去了，下一轮又把 E1..E28 原样再喂一遍。
//
// 止血规则（保守、可回滚）：
//   · 只在**编译成功**时推进覆盖水位（失败/取消绝不推进 ⇒ 下轮仍能看到这些证据）。
//   · 只跳过**已覆盖的旧工具证据**；用户原话、runtime、pending 调用一律照旧全发。
//   · 每轮至少保留最近 N 条工具证据（tail floor），避免丢上下文。
//   · 覆盖水位按会话记录，绝不跨会话。
const COVER_TAIL_FLOOR = 8      // 无论如何都保留的最近工具证据条数

/**
 * ★ 覆盖过滤（**纯函数**，导出以便自测与真机会话重放调用同一份实现）。
 *
 * 为什么必须导出：此前过滤逻辑内联在 birthStart 里，离线验证只能**手抄一份**，
 *   结果抄错了（改了 Object.freeze 的对象）而没被发现 —— 生产里一次都没生效。
 *   抽出纯函数后，验证与生产走的是同一份代码，这类错误不再可能。
 *
 * 规则：只跳过「结果已返回且**结果事件 seq** ≤ 水位」的旧证据；
 *   pending/running（无 resultSeq）一律保留；末尾 floor 条一律保留。
 * @returns {{tools:Array, info:{total,kept,dropped,savedChars}|null}}
 */
export function filterCoveredTools(tools, covered, floor) {
  const list = Array.isArray(tools) ? tools : []
  const f = floor == null ? COVER_TAIL_FLOOR : floor
  // 判据形态（2026-09-22 升级）：
  //   · Set / Array ⇒ **精确成员判定**（快照 coverage.coveredSeqs）。这是现在的生产形态。
  //     为什么必须用集合而不是水位线：水位线会连带跳过"没采集到"和"迟到返回"的结果，
  //     而它们的 resultSeq 根本不在集合里 ⇒ 集合判定天然只省略"确实已编译进去"的证据。
  //   · number ⇒ 旧水位线语义（s <= covered），保留以便回滚与既有自测继续有效。
  let has = null
  if (covered instanceof Set) has = (s) => covered.has(s)
  else if (Array.isArray(covered)) { const st = new Set(covered.map(Number)); has = (s) => st.has(s) }
  else if (typeof covered === 'number' && Number.isFinite(covered)) { const up = covered; has = (s) => s <= up }
  else return { tools: list, info: null }
  if (list.length <= f) return { tools: list, info: null }
  const keep = []
  let skipped = 0, saved = 0
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    // ⚠ 用 resultSeq 而非调用 seq：早先 pending 的调用后来返回结果时，
    //   其结果 seq 会大于调用 seq，用调用 seq 比较会把它误判成旧证据。
    const s = t && t.resultSeq != null ? Number(t.resultSeq) : null
    const isCovered = s != null && Number.isFinite(s) && has(s)
    const inFloor = i >= list.length - f
    if (isCovered && !inFloor) { skipped++; saved += String(t.result || '').length; continue }
    keep.push(t)
  }
  if (!skipped) return { tools: list, info: null }
  return { tools: Object.freeze(keep), info: { total: list.length, kept: keep.length, dropped: skipped, savedChars: saved } }
}

// ★★ 水位与快照必须成对（用户 2026-09-22 指出的缺陷）★★
//   旧实现只记「这个会话曾经编译成功」就过滤 ⇒ 三个漏洞：
//     ① 迟到结果尚未进入 priorMemory 时，旧证据仍被省略（模型看不到新状态）；
//     ② 快照过期/被替换后，水位还在 ⇒ 省略的依据已经不存在；
//     ③ 分支变化时水位串用。
//   修法：构建输入时先确认「本轮确实携带了一份覆盖该水位的快照」
//   （判据见 coverSnapshotOk），确认不了就**恢复全量发送**（宁可多发，不可漏发）。
//
//   持久化（用户第 3 点）：覆盖关系已可靠归档，TTL 只该清内存缓存，
//   不该等同于丢弃覆盖关系 ⇒ 落盘到 storages/cot-form-b/cover.json，重启可恢复。
const COVER_STORE_VERSION = 1
const coveredEvidence = new Map()  // sessionId -> { upTo, at, entries }
let coverStorePath = null
let coverStoreLoaded = false

function coverFile() {
  if (coverStorePath) return coverStorePath
  try {
    // ⚠ 本文件是 ESM（顶部 import）—— 不能用 require。fs/os/path 已导入。
    const dir = path.join(os.homedir(), '.dsh', 'storages', 'cot-form-b')
    fs.mkdirSync(dir, { recursive: true })
    coverStorePath = path.join(dir, 'cover.json')
  } catch { coverStorePath = null }
  return coverStorePath
}

/** 惰性载入覆盖关系（重启后恢复；损坏则当作空，绝不抛错）。 */
function loadCoverStore() {
  if (coverStoreLoaded) return
  coverStoreLoaded = true
  try {
    const f = coverFile()
    if (!f) return
    if (!fs.existsSync(f)) return
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!raw || raw.v !== COVER_STORE_VERSION || !raw.sessions) return
    for (const [k, v] of Object.entries(raw.sessions)) {
      if (v && v.upTo != null) coveredEvidence.set(k, {
        upTo: Number(v.upTo), at: Number(v.at) || 0, entries: Number(v.entries) || 0,
      })
    }
  } catch {}
}

/** 落盘（best-effort；失败绝不影响主流程）。 */
function saveCoverStore() {
  try {
    const f = coverFile()
    if (!f) return
    const sessions = {}
    for (const [k, v] of coveredEvidence.entries()) {
      if (v && v.upTo != null) sessions[k] = { upTo: v.upTo, at: v.at, entries: v.entries || 0 }
    }
    fs.writeFileSync(f, JSON.stringify({ v: COVER_STORE_VERSION, sessions }))
  } catch {}
}

/**
 * 读取某会话的覆盖水位。返回 {upTo, entries} 或 null。
 * 用**水位线**而不是 seq 集合：集合会随会话无界增长，水位线是常数空间。
 * ⚠ 拿到水位**不等于**可以省略证据 —— 调用方还必须通过下面的快照校验。
 */
export function coverWatermarkOf(sessionId) {
  try {
    loadCoverStore()
    const c = coveredEvidence.get(String(sessionId))
    if (!c) return null
    // ⚠ TTL 只清**内存**缓存；磁盘上仍有该关系，下次会重新载入。
    //   但本次一律按「无覆盖」处理 —— 宁可多发，不可漏发。
    if (Date.now() - c.at > LATE_MEMORY_TTL_MS) return null
    if (c.upTo == null) return null
    return { upTo: c.upTo, entries: c.entries || 0, at: c.at }
  } catch { return null }
}

/**
 * ★ 成对校验（用户第 1 点的可自证形式）。
 *
 * 为什么不需要额外记一个 memoryVersion：
 *   覆盖证据 W 的那份快照，是**在那些事件之后**才被创建并 append 到 surface 的
 *   ⇒ 它的 seq 必然 **严格大于** W。反过来，只要本轮携带的快照 seq > W，
 *   就证明「有一份覆盖 W 的快照此刻确实在输入里」。
 *
 * 三种失效场景因此自动恢复全量发送：
 *   · 迟到结果尚未进入 priorMemory ⇒ 携带的还是旧快照，seq ≤ W ⇒ 不发过滤；
 *   · 快照过期/收网失败 ⇒ priorMemory 里没有更新的快照 ⇒ 不发过滤；
 *   · 分支变化/水位串用 ⇒ 快照 seq 对不上 ⇒ 不发过滤。
 *
 * @returns {ok:boolean, snapSeq:number|null} ok=false ⇒ 调用方必须全量发送
 */
export function coverSnapshotOk(priorMemory, upTo) {
  try {
    if (upTo == null) return { ok: false, snapSeq: null }
    const list = Array.isArray(priorMemory) ? priorMemory : []
    let snapSeq = null
    for (const x of list) {
      const s = x && x.seq != null ? Number(x.seq) : null
      if (s != null && Number.isFinite(s) && (snapSeq == null || s > snapSeq)) snapSeq = s
    }
    return { ok: snapSeq != null && snapSeq > Number(upTo), snapSeq }
  } catch { return { ok: false, snapSeq: null } }
}

/**
 * 推进覆盖水位。**只在编译成功时调用**；失败/取消一律不推进（下轮仍能看到这些证据）。
 * 水位只增不减：乱序事件不得把水位往回拉。
 */
export function markCovered(sessionId, upTo, entries) {
  try {
    loadCoverStore()
    if (sessionId == null || upTo == null) return false
    const key = String(sessionId)
    const v = Number(upTo)
    if (!Number.isFinite(v)) return false
    let c = coveredEvidence.get(key)
    if (!c) { c = { upTo: null, at: 0, entries: 0 }; coveredEvidence.set(key, c) }
    if (c.upTo == null || v > c.upTo) c.upTo = v
    c.entries = Number(entries) || 0
    c.at = Date.now()
    saveCoverStore()
    return true
  } catch { return false }
}

/** 覆盖水位（进快照/诊断用）。 */
export function coverVersionOf(sessionId) {
  try { loadCoverStore(); const c = coveredEvidence.get(String(sessionId)); return c ? (c.upTo == null ? 0 : c.upTo) : 0 } catch { return 0 }
}
// ⚠ 键匹配的坑（2026-09-21 实测发现）：
//   起火处（birthStart）拿的是 entry.text —— **单个** reasoning 块的文本；
//   收网处（pre-step）拿的是 reasoningTextOf(message) —— 把**所有** reasoning 块
//   用 '\n' 拼起来。单块时两者逐字相同；**多块时永远对不上 ⇒ 收网静默永不触发**。
//   长度下限 64 字符：短文本互相包含的概率太高，宁可漏收也不许张冠李戴。
const LATE_MATCH_MIN = 64

/** needle 是否以【整段】形式出现在 hay 里（段 = 被 '\n' 分隔的连续区间）。 */
function segmentAligned(hay, needle) {
  let i = hay.indexOf(needle)
  while (i >= 0) {
    const before = i === 0 || hay.charCodeAt(i - 1) === 10
    const j = i + needle.length
    const after = j === hay.length || hay.charCodeAt(j) === 10
    if (before && after) return true
    i = hay.indexOf(needle, i + 1)
  }
  return false
}

/**
 * ★★ 全覆盖匹配（2026-09-22）★★
 *
 * 为什么必须要求「全覆盖」而不是「找到一条」：
 *   收网用一条 ledger 替换**整条** assistant 消息的推理。而暂存的是**块级**结果。
 *   若一条消息有多个推理块、只有部分块就绪，就贸然收网 ⇒ **未就绪块的推理凭空消失**。
 *   这正是 emitter.js 里那条「信息不丢硬闸」在推理侧的对偶要求。
 *
 * 判据（全部满足才算匹配）：
 *   ① 把命中的各条按其在 fullRaw 中的位置升序排列；
 *   ② 首条必须从位置 0 开始，且各条**首尾相接、互不重叠**（间隔恰好一个 '\n'）；
 *   ③ 拼起来必须与 fullRaw **逐字相等**。
 * 任一条不满足 ⇒ 返回 null（不认领、**也不消费**，留待下轮或过期）。
 *
 * 同文多个任务被显式标为 ambiguous，包含容量淘汰后的存活项；不取第一个。
 *
 * @returns { idxs } 命中下标（升序）或 null
 */
function coverageMatch(q, fullRaw) {
  if (typeof fullRaw !== 'string' || !fullRaw) return null
  const idxs = []
  const exact = q.map((x, i) => ({ x, i })).filter(({ x }) => x.raw === fullRaw)
  if (exact.length) return exact.length === 1 && !exact[0].x.ambiguous ? { idxs: [exact[0].i] } : null
  for (let i = 0; i < q.length; i++) {
    const a = q[i].raw
    // ① 逐字相同 ⇒ 单块即全覆盖（生产 583/583 都是这一支）
    if (a.length >= LATE_MATCH_MIN && segmentAligned(fullRaw, a)) {
      if (q[i].ambiguous) return null
      idxs.push(i)
    }
  }
  if (!idxs.length) return null
  // ② 按在 fullRaw 中的出现位置升序
  const withPos = idxs.map((i) => ({ i, p: fullRaw.indexOf(q[i].raw) }))
  withPos.sort((x, y) => x.p - y.p)
  // ③ 首尾相接校验（cursor 必须严格推进，且最终恰好覆盖 fullRaw）
  let cursor = 0
  for (const x of withPos) {
    if (x.p !== cursor) return null
    cursor += q[x.i].raw.length + 1
  }
  if (cursor - 1 !== fullRaw.length) return null
  return { idxs: withPos.map((x) => x.i) }
}

/**
 * 诊断：为什么这段 fullRaw 认领不了。纯只读，供 trace 用（"积压"与"丢弃"在漏斗里必须能区分）。
 * @returns 'empty' | 'no-candidate' | 'ambiguous' | 'partial-coverage' | 'ok'
 */
export function explainLateMiss(sessionId, fullRaw, opts = {}) {
  try {
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return 'empty'
    if (coverageMatch(q, fullRaw)) return 'ok'
    const cands = q.filter(x => x.raw === fullRaw || (x.raw.length >= LATE_MATCH_MIN && segmentAligned(fullRaw, x.raw)))
    if (!cands.length) return 'no-candidate'
    if (cands.some(x => x.ambiguous)) return 'ambiguous'
    return 'partial-coverage'
  } catch { return 'no-candidate' }
}

/**
 * ★ 混合认领（opt-in：cfg.lateClaimPartial=true）。全覆盖失败时，把 fullRaw 按 '\n' 切段，
 *   已就绪的块用其摘要、其余段**逐字保留原文**，拼成一份文本。
 *   保证：① 只用非歧义、整段对齐的候选；② 未命中的原文一个字不丢；③ 至少命中 1 块才返回；
 *        ④ 回执只包含真正用到的记录（ack 时只消费这些）。
 *   全覆盖可用时**不走这里**（调用方先 peek）。默认关闭，因为它改变了「绝不部分认领」的既有铁律。
 */
export function peekLateMemoryPartial(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null || typeof fullRaw !== 'string' || !fullRaw) return null
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const hits = []
    for (const x of q) {
      if (x.ambiguous || x.raw.length < LATE_MATCH_MIN || !segmentAligned(fullRaw, x.raw)) continue
      const p = fullRaw.indexOf(x.raw)
      if (p < 0) continue
      hits.push({ x, p, e: p + x.raw.length })
    }
    if (!hits.length) return null
    hits.sort((a, b) => a.p - b.p)
    // 去重叠：按位置贪心，只保留互不重叠的命中
    const used = []
    let cursor = 0
    for (const h of hits) { if (h.p >= cursor) { used.push(h); cursor = h.e } }
    let text = '', pos = 0, replacedChars = 0
    for (const h of used) {
      if (h.p > pos) text += fullRaw.slice(pos, h.p)
      const board = String(h.x.board || '').trim() || renderCheckpoint(h.x.entries)
      if (!board) { text += fullRaw.slice(h.p, h.e); pos = h.e; continue }
      text += board; replacedChars += h.x.raw.length; pos = h.e
    }
    if (pos < fullRaw.length) text += fullRaw.slice(pos)
    if (!replacedChars) return null
    const receipt = used.map(h => h.x)
    return { count: receipt.length, receipt, texts: [text], entries: receipt.reduce((a, x) => a.concat(x.entries), []),
      partial: true, replacedChars, keptChars: fullRaw.length - replacedChars }
  } catch { return null }
}

/** 只查不取。找到返回 { texts, count, entries }，否则 null。 */
export function peekLateMemory(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null) return null
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const m = coverageMatch(q, fullRaw)
    if (!m) return null
    return {
      count: m.idxs.length,
      receipt: m.idxs.map((i) => q[i]),
      texts: m.idxs.map((i) => q[i].board).filter((t) => t && String(t).trim()),
      entries: m.idxs.reduce((acc, i) => acc.concat(q[i].entries), []),
    }
  } catch { return null }
}

/**
 * ★★ 认领（消费即移除，绝不重复收网）★★
 * 只有【全覆盖】时才消费；否则原样保留、返回 null。
 */
export function claimLateMemory(sessionId, fullRaw, opts = {}) {
  try {
    if (sessionId == null) return null
    const key = lateKey(sessionId, opts)
    const q = lateMemory.get(key)
    if (!q || !q.length) return null
    pruneLateMemory(q)
    const m = coverageMatch(q, fullRaw)
    if (!m) return null
    const picked = m.idxs.map((i) => q[i])
    // 从后往前删，避免下标位移
    for (const i of [...m.idxs].sort((a, b) => b - a)) q.splice(i, 1)
    return {
      count: picked.length,
      texts: picked.map((x) => x.board).filter((t) => t && String(t).trim()),
      entries: picked.reduce((acc, x) => acc.concat(x.entries), []),
    }
  } catch { return null }
}

/** Acknowledge only the exact records that were successfully emitted.
 * New arrivals/replacements while archive awaits must never be consumed. */
export function lateReceiptValid(sessionId, receipt, opts = {}) {
  const q = lateMemory.get(lateKey(sessionId, opts))
  if (!q || !Array.isArray(receipt) || !receipt.length) return false
  pruneLateMemory(q)
  return receipt.every(item => q.includes(item) && !item.ambiguous)
}

export function acknowledgeLateMemory(sessionId, receipt, opts = {}) {
  const key = lateKey(sessionId, opts)
  const q = lateMemory.get(key)
  if (!q || !Array.isArray(receipt)) return 0
  const items = new Set(receipt)
  let removed = 0
  for (let i = q.length - 1; i >= 0; i--) {
    if (items.has(q[i])) { q.splice(i, 1); removed++ }
  }
  if (!q.length) lateMemory.delete(key)
  return removed
}

/** 兼容旧名：等价于 claimLateMemory，返回单条形状（自测与旧调用点用）。 */
export function takeLateMemory(sessionId, fullRaw, opts = {}) {
  const c = claimLateMemory(sessionId, fullRaw, opts)
  if (!c || !c.texts.length) return null
  return { board: c.texts.join('\n\n'), entries: c.entries, count: c.count }
}

/** 仅供自测/快速路径：观察暂存量，不消费（先清过期）。 */
export function lateMemorySize(sessionId, opts = {}) {
  try {
    const q = lateMemory.get(lateKey(sessionId, opts))
    if (!q) return 0
    pruneLateMemory(q)
    return q.length
  } catch { return 0 }
}
/**
 * 单次结算便捷入口（供单测/直调）：起火 + 立即收网。
 * 生产路径用两段式：block-end 处 birthStart，finish 处 birthFinish（中间留给 text/tool 流式）。
 */
export async function birthSettle(entry, deps = {}) {
  return birthFinish(birthStart(entry, deps), deps)
}

/**
 * 把一条模型流包成「出生即提纯」的流（方案一：流式双轨并发拦截器）。
 *   推理 delta 实时透传 → block-end 扣住并起火（写盘 ‖ 提纯）→ text/tool 实时透传
 *   → finish 扣住、等待收网 → 按 index 放行改写后的 block-end → 放行 finish
 * 四条硬约束见上方文件头注释。
 * @param inner 源流（必须已校验为 async iterable，调用方负责）
 * @param deps  { cfg, trace, archive, sessionId, distill, prewarm }
 */
export function birthTransform(inner, deps = {}) {
  const trace = deps.trace || (() => {})
  const cfg = deps.cfg || {}
  const settleDeps = { ...deps, live: true }
  return (async function* () {
    const held = new Map()   // index -> 累计中的 reasoning 块
    const pending = []       // 已起火、等 finish 收网的 task
    let sourceError = null
    let prewarmed = false
    const handleInText = cfg.birthHandleInText !== false

    // 立即降级放行（abort/异常路径，绝不等待）：无条件给出【原文逐字】（句柄不进上下文）
    const flushTask = function* (task) {
      const s = task.diskState
      const handle = s && s.ok ? (s.handle || task.handle || null) : null
      // 句柄不写进文本：降级放行时给出【原文逐字】
      const text = task.raw
      for (const c of birthEmitChunks(task, text, settleDeps)) yield c
    }

    try {
      for await (const chunk of inner) {
        const t = chunk && chunk.type
        // 约束①：block-start 必须立刻透传（不变式要求 delta 落在已开的块上）
        if (t === 'block-start' && chunk.blockType === 'reasoning') {
          held.set(chunk.index, birthHoldNew(chunk.index))
          // 优化2：思考一开始就捂热连接（HEAD，零 token；每次流只做一次）
          if (!prewarmed && typeof deps.prewarm === 'function') {
            prewarmed = true
            try { deps.prewarm('birth-reasoning-start') } catch { /* 预热失败绝不影响主流 */ }
          }
          yield chunk
          continue
        }
        if (t === 'reasoning-delta') {
          const h = held.get(chunk.index)
          // live：delta 实时透传（GUI 不卡顿），同时累积原文供 block-end 结算
          if (h) { h.text += (chunk.text || ''); yield chunk; continue }
          yield chunk
          continue
        }
        // ★ 流式双轨：block-end 处扣住（不 yield），起飞并发任务
        if (t === 'block-end') {
          const h = held.get(chunk.index)
          if (h) {
            h.end = chunk
            held.delete(chunk.index)
            const task = birthStart(h, settleDeps)
            if (task.belowFloor) {
              // 无需异步工作 ⇒ 立即放行，零延迟
              for (const c of birthEmitChunks(task, task.raw, settleDeps)) yield c
            } else {
              pending.push(task)
            }
            continue
          }
          yield chunk
          continue
        }
        if (t === 'finish') {
          const reason = (chunk && chunk.reason) || {}
          const hardStop = reason.kind === 'error' || reason.kind === 'aborted'
          if (pending.length) {
            if (hardStop) {
              // 异常/中断：绝不等待，立即降级放行
              for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task)) yield c
            } else {
              // 收网：多块**并行**兑现（总耗时 ≈ 单块），再按 index 升序放行
              // ★ 2026-09-21 共享绝对截止（外部审计 P0-2）：先把所有待收网任务的进入时刻
              //   钉成同一个值，保证多块并行收网共用【一个】budget，而不是每块各拿一份。
              //   （Promise.all 本已并发，这里把它变成显式不变量，防止将来改成串行时静默劣化。）
              const sharedEnterAt = Date.now()
              for (const t of pending) t.finishEnterAt = sharedEnterAt
              // ★ 2026-09-21 并行块的有序归并（外部评审）：蒸馏是并发的，
              //   「较早块→蒸馏较晚完成」完全可能。**出站与记忆都必须按源块顺序**，
              //   绝不能按 promise 完成顺序 —— 那会让旧状态压回新状态。
              const settled = await Promise.all(pending.map(async (task) => {
                try { return { sourceIndex: task.index, r: await birthFinish(task, settleDeps), task } }
                catch (e) {
                  trace('birth-settle-error', { index: task.index, error: String((e && e.message) || e) })
                  return { sourceIndex: task.index, r: null, task }
                }
              }))
              // ① 出站：按源块 index 升序（原有不变量，保持）
              const ordered = settled.slice().sort((a, b) => a.sourceIndex - b.sourceIndex)
              for (const s of ordered) if (s.r) for (const c of s.r.chunks) yield c
              // ② 记忆：同样按源块顺序归并；失败块被跳过，不污染记忆
              // ⚠ 关闭 stateMemory 时**绝不**归并或消费新格式记忆（回滚语义）
              if (compileModeOf(cfg) === 'memory') {
                try {
                  const merged = mergeOrdered(ordered.map((s) => ({
                    sourceIndex: s.sourceIndex,
                    ok: !!(s.task && s.task.distillState && s.task.distillState.ok && s.task.distillState.entries),
                    parsed: s.task && s.task.distillState && s.task.distillState.parsed ? s.task.distillState.parsed : null,
                    at: sharedEnterAt,
                  })).filter((x) => x.ok))
                  if (merged.entries.length) {
                    trace('state-memory-merged', {
                      blocks: merged.order,
                      entries: memoryStats(merged.entries),
                    })
                  }
                } catch (e) {
                  trace('state-memory-merge-error', { error: String((e && e.message) || e) })
                }
              }
            }
            pending.length = 0
          }
          // 源流没给 block-end 的块：绝不补造（源流没关就不许我们关）
          held.clear()
          yield chunk
          continue
        }
        yield chunk
      }
    } catch (e) {
      sourceError = e
    }
    // 源流结束/抛错时仍未收网的 task：立即降级放行（原文 + 句柄）
    for (const task of pending.sort((a, b) => a.index - b.index)) for (const c of flushTask(task)) yield c
    pending.length = 0
    held.clear()
    if (sourceError) throw sourceError
  })()
}

/**
 * trace writer 工厂（2026-09-21 导出以便端到端测试）。
 * 语义与原先内联版本逐字一致：trace 关闭 ⇒ 什么都不写；写失败 ⇒ 只吞证据，绝不阻断宿主。
 * @param {object} cfg 需要 cfg.trace 与 cfg.traceFile
 * @param {() => object} statsOf 返回当前 stats 快照（每行都会附上）
 */
export function makeTraceWriter(cfg, statsOf) {
  let dirReady = false
  return function trace(tag, data) {
    if (!cfg.trace) return null
    const stats = typeof statsOf === 'function' ? statsOf() : undefined
    const payload = Object.assign({}, data, stats === undefined ? {} : { stats })
    const line = '[' + new Date().toISOString() + '] [' + tag + '] ' + JSON.stringify(payload)
    try {
      if (!dirReady) { fs.mkdirSync(path.dirname(cfg.traceFile), { recursive: true }); dirReady = true }
      fs.appendFileSync(cfg.traceFile, line + '\n')
      return line
    } catch { return null /* evidence only */ }
  }
}

/**
 * `birth-distill-settled` 的记录体（2026-09-21 抽出为纯函数）。
 * 抽出的理由：这个对象就是"白名单"本身 —— 加字段必须同时改这里，
 * 否则字段只活在 meta 里、落不了盘（已发生过的真实事故）。
 */
export function settledTraceData(index, ms, s) {
  const m = (s && s.meta) || null
  return {
    index, ms, ok: !!(s && s.ok),
    chars: (s && s.text) ? s.text.length : 0,
    reason: (s && s.ok) ? null : ((s && s.error) || 'unknown-failure'),
    ...(m ? {
      model: m.model, endpoint: m.endpoint, style: m.style, thinkingOff: m.thinkingOff,
      compilerMode: m.compilerMode, deterministicRevision: m.deterministicRevision, evidenceBodyChars: m.evidenceBodyChars, evidencePolicy: m.evidencePolicy, duplicateBodyCharsAvoided: m.duplicateBodyCharsAvoided,
      // ★ 2026-09-22 切分验收字段：compress 模式的放大倍数 = promptChars / inputChars。
      //   设计预期 ≈ 1.x（输入≈本段推理）。实测 stateMemory 模式是 7.5x，这条字段就是判据。
      inputChars: m.inputChars, promptVersion: m.promptVersion,
      compressRatio: (typeof m.promptChars === 'number' && typeof m.inputChars === 'number' && m.inputChars > 0)
        ? Number((m.promptChars / m.inputChars).toFixed(2)) : undefined,
      promptChars: m.promptChars, maxOutputTokens: m.maxOutputTokens,
      connectMs: m.connectMs, ttfbMs: m.ttfbMs, firstByteMs: m.firstByteMs,
      totalMs: m.totalMs, chunks: m.chunks, reused: m.reused, status: m.status,
      bytes: m.bytes, cancelled: m.cancelled, finish: m.finish, reasoningChars: m.reasoningChars,
      stream: m.stream === true ? true : undefined,
      // ★ 失败阶段（2026-09-21）：区分「还没拿到响应头就超时」与「拿到了但生成太慢」
      stage: m.stage,
      providerReportedUsage: m.providerReportedUsage || null,
      requestId: m.requestId, flightId: m.flightId, sharedFlight: m.sharedFlight,
      promptBuildMs: m.promptBuildMs, promptBuildCount: m.promptBuildCount,
      parseRenderMs: m.parseRenderMs, promptVersion: m.promptVersion, staticPrefixChars: m.staticPrefixChars,
      afterContentMs: m.afterContentMs,
      // ★ 协议错配（2026-09-21）：响应实际协议与请求模式不一致时显式留痕
      protocolMismatch: m.protocolMismatch,
      eventCount: m.eventCount, badFrame: m.badFrame, outputChars: m.outputChars,
      toFirstEventMs: m.toFirstEventMs, toFirstContentMs: m.toFirstContentMs,
      contentSpanMs: m.contentSpanMs, toCompleteMs: m.toCompleteMs,
    } : {}),
  }
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const compilerFlights = createExactFlights()
  // 出生即提纯：本轮会话 id（在 agent/pre-step 捕获，供 CAS 归档登记）
  let birthSessionId = null
// ★ 2026-09-21 消息溯源（外部审计 P0-3）：同时持有 session 对象本身。
//   只用于【读】surface.nodes / eventAt(seq) 建立 seq 映射；绝不改任何事件。
//   寿命与 birthSessionId 相同（同一个 agent/pre-step 里捕获）。
let birthSession = null
/** 当前会话（供证据采集只读访问）。 */

  // ── 运行计数器（常驻内存；随每条 trace 快照落盘，零外部依赖）──
  const stats = { seen: 0, replaced: 0, rules: 0, distilled: 0, distFailed: 0, short: 0, hurdle: 0, charsRaw: 0, charsFinal: 0 }
  // 09-16 工具参数遥测（只读，零行为变化）：骨架化收益上界的唯一实测来源
  for (const k of ['argsSeen','argsOver500','argsChars','inspectCalls']) stats[k] = 0
  for (const k of ['skel','skelChars']) stats[k] = 0
  const ARGS_MIN = 500
  let pendingSkelPlan = null
  const bump = (k, by) => { stats[k] = (stats[k] || 0) + (by === undefined ? 1 : by) }

  // ★ 2026-09-18 公测可移植性：traceFile 现在由 harness home 推导，其父目录默认不存在。
  //   旧代码只 catch ⇒ 在别人机器上「trace 开着但一直没写」，把证据静默丢光。
  //   这里首次写之前递归建目录；建失败照样不阻断宿主，只吞掉证据。
  // ★ 2026-09-21：trace writer 抽成导出的工厂（makeTraceWriter），使"写入→读回"
  //   的**端到端**测试成为可能。只测 meta 里有字段，挡不住"字段没进白名单"这类问题
  //   —— 本文件刚刚就栽过一次（流式阶段字段写进 meta 却没落 trace）。
  const trace = makeTraceWriter(cfg, () => stats)
  const consumption = createConsumptionMeter(trace)

  trace('BOOT', {
    // ★ 回滚所需版本号：关闭功能时**停止新的状态编译**，不把新格式强塞给旧解析器，
    //   已合法出站的内容保持原样，CAS 与事件日志不受影响（回滚 = 停用，不是回写历史）。
    stateMemory: cfg.stateMemory === true,
    // ★ 2026-09-22 切分：把裁决结果落在 BOOT 里，避免"开了哪个开关却不知道跑的是哪条路"
    stateCompress: cfg.stateCompress === true,
    compileMode: cfg.compileMode,
    ...(cfg.compileModeConflict ? { compileModeConflict: cfg.compileModeConflict } : {}),
    compilerMode: cfg.compileMode === 'memory' ? 'grounded-judgment-v2'
      : cfg.compileMode === 'compress' ? 'compress-v1' : 'reasoning-distill',
    promptVersion: cfg.compileMode === 'memory' ? JUDGMENT_PROMPT_VERSION
      : cfg.compileMode === 'compress' ? 'compress-v1' : null,
    retiredOptions: cfg.retiredOptions,
    memoryPolicyVersion: MEMORY_POLICY_VERSION,
    stateSnapshot: cfg.stateSnapshot !== false,
    stateCoveredEvidence: cfg.stateCoveredEvidence !== false,
    stateStructuralFirst: cfg.stateStructuralFirst === true,
    birth: { finishWaitMs: cfg.birthFinishWaitMs, deferredClaim: cfg.birthDeferredClaim !== false },
    schemaVersion: SCHEMA_VERSION, compilerVersion: COMPILER_VERSION, rendererVersion: RENDERER_VERSION,
    // ★★ 复电上岗判据（模块改动必须重启网关才生效）★★
    //   ① emitting 是**手写常量**，只能说明版本意图，**不能**证明载入的是哪一份文件；
    //   ② selfId / deps 是**模块首次求值时从磁盘读到的** size@mtimeMs ——
    //      旧模块在内存里根本不含这段代码 ⇒ 不会打印这两个字段。
    //   复电前先确认本行出现 selfId，且与 `node -e` 现读值一致。
    emitting: 'step-aware@agent/request+birth@llm/stream+promptV2+ledgerImperativeMetric',
    selfId: SELF_ID,
    deps: DEP_ID,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    // ★ 2026-09-17 路线 A：活跃尾部宽度（最近多少条 assistant/message 逐字保留）。
    //   官方规范 dsh-compaction/README.md:145 —— "leaves the recent tail unchanged"。
    keepTail: Number.isInteger(cfg.keepTail) && cfg.keepTail >= 1 ? cfg.keepTail : 1,
    minRawChars: cfg.minRawChars,
    hurdleRounds: cfg.hurdleRounds,
    templateChars: cfg.templateChars,
    breakevenRaw: breakevenRaw(cfg.hurdleRounds, cfg),
    earlyFire: cfg.earlyFire,
    timeoutMs: cfg.timeoutMs,
    graceMs: cfg.graceMs,
    maxAttempts: cfg.maxAttempts,
    rulesEnabled: cfg.rulesEnabled,
    rulesFoldRuns: cfg.rulesFoldRuns,
    rulesMinSavedChars: cfg.rulesMinSavedChars,
    rulesRequireArchive: cfg.rulesRequireArchive,
    rulesMinSavingPctDeprecated: cfg.rulesMinSavingPctDeprecated,
    birthArchive: cfg.birthArchive,
    birthMinChars: cfg.birthMinChars,
    birthHandleInText: cfg.birthHandleInText,
    birthProducer: cfg.birthProducer,
    keepAlive: cfg.keepAlive,
    keepAliveMsecs: cfg.keepAliveMsecs,
    prewarm: cfg.prewarm,
    // ★ BOOT 时 cfg.model 还只是「patch 里显式写死的那个」，followHostModel 下它会在
    //   第一次 llm/stream 时被替换成宿主对话模型 ⇒ 这里记的只是初始值，不是最终值。
    model: cfg.model,
    modelAtBoot: cfg.model,
    followHostModel: cfg.followHostModel,
    disableThinking: cfg.disableThinking,
    maxOutputTokens: cfg.maxOutputTokens,
    invariant: 'H2 首次出站不变律：块只在「还没出站」时允许替换，否则永久放弃',
  })

  // ★ 传输层预热：启动时就把到网关的 TLS 通道捂热。
  //   实测冷连接 TTFB 676ms / 复用 265ms ⇒ 这一发能把「进程内第一次调用」
  //   从冷变成温热。**非阻塞、失败静默、零 token（HEAD，不产生 completion）。**
  const prewarm = makePrewarmer(cfg, trace)
  prewarm('boot')

  let n = 0

  // ── ★★ 宿主对话模型跟随（2026-09-15 用户拍板）★★ ─────────────────────────
  //   用户原话：「宿主用哪个模型对话，我们就用那个模型压缩。」
  //   机制：`llm/stream` 的 options 里带 `provider` / `model`（= 本次对话调用用的模型），
  //        每次看到就缓存下来；`followHostModel` 开着时把 `cfg.model` 改写成它。
  //   ⚠ 不猜：`explicitModel` 是 patch 里显式写的那个（可能为空串）。
  //     - 见过宿主模型 ⇒ cfg.model = 宿主模型（跟随成立）
  //     - 没见过但有显式配置 ⇒ cfg.model 仍是显式值（**这是用户的显式选择，不是猜**）
  //     - 都没 ⇒ cfg.model 为空 ⇒ generateDistillation 直接抛 `no model:` ⇒ 降级 rules
  //   ⚠ 我们的提纯调用走 `requestOnce`（node:https 直连），**不经过宿主 llm/stream**
  //     ⇒ 不存在自己污染自己（把提纯模型当成宿主模型）的风险。
  //   ⚠ 但宿主若有其他模型调用（子 agent / 标题生成）也会打这里 ⇒ 只取**最近一次**，
  //     并把 provider 一并落 trace，便于事后核对取到的是不是对话模型。
  const explicitModel = cfg.model
  let hostModel = null
  let hostProvider = null

  // ★★ H2 硬闸（2026-09-15 用户终审后落定）★
  //   一个块只有在「还没进过任何出站 payload」时才允许被替换。
  //   本模块认的时机只有一个：该块成为「最后一条 assistant 事件」的那个 pre-step ——
  //   因为本步 payload 正是它第一次出站的地方。
  //   ⇒ 在那个 pre-step 里，要么把替换做完，要么**永久上锁**，之后谁都不许再碰它。
  //   这条不是优化，是防止 suffix cascade invalidation（前缀哈希断裂 ⇒ 后缀全价重算）。
  //   ⚠ 「提前发起（early-fire）」**不违反**这条：提前发起只是把**结果准备好**，
  //     落盘仍然只发生在那一个 pre-step 里。违反它的是「事后落盘」，不是「提前准备」。
  const locked = new Set()

  // ★ 2026-09-17：会话级 df 已随角色状态机一并移除。新规则引擎不需要词频表——
  //   它只做字面去重和同构折叠，从不判断「哪个词稀有不稀有」（那正是事故的根源）。

  // ── 提前发起的结果槽（只留最近 3 个，按 reasoning 原文精确匹配）──
  const early = new Map()
  const EARLY_MAX = 3

  function fireEarly(raw) {
    if (!cfg.earlyFire || (cfg.mode !== 'distill' && cfg.mode !== 'checkpoint')) return
    if (!raw || raw.length < cfg.minRawChars) return
    // ★ 跟随宿主模型时，还没见过宿主模型就**不发起** —— 不猜模型名。
    //   直接跳过，让 pre-step 走 rules；比发一次注定失败的调用干净
    //   （不产生 `early-failed` 噪音，也不占 EARLY_MAX 槽位）。
    if (!cfg.model) {
      trace('early-no-model', { rawChars: raw.length, followHostModel: cfg.followHostModel, explicitModel })
      return
    }
    if (early.has(raw)) return
    const e = { raw, settled: false, ok: false, text: null, err: null, firedAt: Date.now(), readyAt: null, meta: null }
    e.promise = generateDistillation(raw, cfg).then((r) => {
      e.settled = true; e.ok = true; e.text = r.text; e.meta = r.meta; e.readyAt = Date.now()
      trace('early-ready', {
        rawChars: raw.length,
        tookMs: e.readyAt - e.firedAt,
        // ★ 实际用了哪个模型提纯（followHostModel 下应等于宿主对话模型）
        model: r.meta && r.meta.model,
        hostModel,
        modelSource: r.meta && r.meta.model === hostModel ? 'host' : 'config',
        thinkingOff: r.meta && r.meta.thinkingOff,
        // ★ 传输层证据：这次调用到底复用了没有、握手花了多少
        reused: r.meta && r.meta.reused,
        connectMs: r.meta && r.meta.connectMs,
        ttfbMs: r.meta && r.meta.ttfbMs,
        // ★ 模型侧证据：finish_reason 与 reasoning 长度（诊断"空提纯稿"的真因）
        finish: r.meta && r.meta.finish,
        reasoningChars: r.meta && r.meta.reasoningChars,
        endpoint: r.meta && r.meta.endpoint,
      })
    }).catch((err) => {
      e.settled = true; e.ok = false; e.err = String((err && err.message) || err)
      trace('early-failed', { rawChars: raw.length, tookMs: Date.now() - e.firedAt, error: e.err })
    })
    early.set(raw, e)
    while (early.size > EARLY_MAX) early.delete(early.keys().next().value)
    trace('early-fired', { rawChars: raw.length, minRawChars: cfg.minRawChars })
  }

  const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

  // ★ D4′ 相对宽限收网：后台提纯若已就绪 ⇒ 0 等待；未就绪 ⇒ 最多再给 graceMs。
  //   两种结局都只是「用提纯稿」或「保持原文」，绝不抛错、绝不阻断宿主。
  async function awaitDistilled(raw, graceMs) {
    const e = early.get(raw)
    if (!e) return null
    if (e.settled) return e
    const cfgMs = Number.isFinite(cfg.graceMs) ? cfg.graceMs : 1000
    const budget = Number.isFinite(graceMs) ? Math.max(0, graceMs) : cfgMs
    if (budget > 0) await Promise.race([e.promise, sleep(budget)])
    return e.settled ? e : null
  }

  // ── 落盘：**唯一**允许替换的地方（H2）──
  // ★ 20260916 Step-Aware Emitting。原来在这里直接 append，用的是【已经关闭的】aev.data.turn/step。
  //   dsh-token-meter 规定 assistant/message 必须落在与之匹配的、**已开启**的 step 内
  //   （lib/index.js:588-590），否则 `throw: token meter: assistant/message at seq N has no matching
  //   step/start event` —— 这正是 09-16 压缩死锁的成因。
  //   离线重放（deploy/probe/_meter-replay-proof.mjs）已证：把 surfaceOp 的 start/end 补上**不解决**
  //   ——错误只是从 "token surface: invalid current range" 那道闸门挪到 step 这道闸门。唯一可行解是
  //   **换时机**：等到下一个 step 开着再发。agent/request 在 agent-loop 的 this.step() 内部派发
  //   （:708，位于 :548 step/start 与 :558 step/end 之间）⇒ 那一刻 step 必然是开着的。
  //   所以这里只入队，真正的 append 交给 flushPendingEmit()。
  let pendingEmit = null
  function appendReplace(session, aev, orig, newReasoning, meta) {
    const plan = pendingSkelPlan; pendingSkelPlan = null
    pendingEmit = { session, aev, orig, newReasoning, plan, meta }
    trace('emit-queued', Object.assign({ n, seq: aev.seq }, meta))
  }

  // 日志层的"当前是否有开着的 step"——判据与计量器一致：最后一条 step 事件若是 step/start，即为开。
  // 这是**失败安全**闸门：拿不准就什么都不发（等价于今天的 mode:'off' 行为），绝不冒险写一条会让
  // 计量器在日后重放时抛错的事件进日志。
// ★ 0.1.5-rc.1 破坏性变更：宿主会话对象不再暴露 .log，只暴露 eventAt(seq) / get seq()。
//   实测：dsh-session 仅有 eventAt(:481,:1096) 与 get seq(:515,:1130)，全生态零处消费 session.log。
//   旧宿主回退 .log；新宿主按访问器重建并按 seq 缓存 —— 保证同一份逻辑在新旧宿主上都能拿到日志视图。
let _sLogCache = { key: null, seq: -1, log: null }
function readSessionLog(session) {
  if (!session) return null
  let legacy = null
  try { legacy = session.log } catch { /* 访问器可能抛错，忽略 */ }
  if (Array.isArray(legacy)) return legacy
  if (typeof session.eventAt !== 'function') return null
  const n = typeof session.seq === 'number' ? session.seq : 0
  if (_sLogCache.key === session && _sLogCache.seq === n) return _sLogCache.log
  const arr = new Array(n)
  for (let i = 0; i < n; i += 1) {
    try { arr[i] = session.eventAt(i) } catch { return null }
  }
  _sLogCache = { key: session, seq: n, log: arr }
  return arr
}

  function openStepOf(sLog) {
    if (!Array.isArray(sLog)) return null
    for (let i = sLog.length - 1; i >= 0; i--) {
      const t = sLog[i] && sLog[i].type
      if (t === 'step/end') return null
      if (t === 'step/start') {
        const d = sLog[i].data || {}
        return { turn: d.turn, step: d.step }
      }
    }
    return null
  }

  function flushPendingEmit(payload) {
    if (pendingEmit === null) return
    const item = pendingEmit; pendingEmit = null
    const meta = item.meta
    try {
      const session = item.session
      if (!session || typeof session.append !== 'function') { trace('emit-dropped-no-session', Object.assign({ n }, meta)); return }
      const open = openStepOf(readSessionLog(session))
      if (open === null) { trace('emit-skipped-no-open-step', Object.assign({ n, seq: item.aev.seq }, meta)); return }
      if (open.turn !== payload.turn || open.step !== payload.step) {
        trace('emit-skipped-step-mismatch', Object.assign({ n, seq: item.aev.seq, openTurn: open.turn, openStep: open.step, payTurn: payload.turn, payStep: payload.step }, meta))
        return
      }
      // ⛔⛔ 2026-09-21 外部审计第一批：这条路径【协议上永久非法】，已显式禁用 ⛔⛔
      //   dsh-session/lib/types/surface.js:207-208 硬抛：
      //     'assistant/message embeds its source stream and cannot carry sourceEventSeqs'
      //   即 assistant/message **永远不能当替换者**（H2）。此前这里照发不误，只因 appendReplace
      //   在生产配置下从未被调用（trace.log: emit-queued=0）才没炸；一旦有人打开旧模式开关，
      //   100% 抛错并被 :catch 吞成 replace-threw 静默失败 —— 是一颗哑弹，不是一条备用路径。
      //   ⇒ 改为显式拒绝 + 独立留痕。想压缩历史块，唯一合法通道是 emitter.js 的 user/message 看板。
      trace('replace-refused-h2', Object.assign({ n, seq: item.aev.seq, emitTurn: open.turn, emitStep: open.step,
        why: 'assistant/message cannot be a replacer (surface.js:207)' }, meta))
      return
    } catch (e) {
      trace('replace-threw', Object.assign({ n, seq: item.aev.seq }, meta, { error: String((e && e.message) || e) }))
    }
  }

  // ── 纯规则兜底（同步、零网络、零 await）──
  function applyRules(session, aev, orig, raw, why) {
    if (!cfg.rulesEnabled) { trace('rules-disabled', { n, seq: aev.seq, why }); return }
    let r
    try {
      r = compressByRules(raw, {
        foldRuns: cfg.rulesFoldRuns,
        dropDuplicateLines: cfg.rulesDropDuplicateLines,
      })
    } catch (e) {
      trace('rules-threw', { n, seq: aev.seq, why, error: String((e && e.message) || e) })
      return
    }
    // ⚠ finalChars 是补的：rules 路径原本只报 outChars/savedChars，
    //   与 distill 路径的 finalChars 不同名 ⇒ 两条路径的指标不可比（2026-09-15 统计时撞到）。
    //   这里统一成与 distill 路径同名的 finalChars，并补 waitMs=0（规则档同步执行，从不等待）。
    const meta = Object.assign({ why, path: 'rules', rawChars: raw.length, finalChars: r.out.length, waitMs: 0 }, r.stats)
    // ⛔ 判据与百分比解耦（2026-09-17 事故修正）。三条，缺一不放行：
    //   ① 零丢失受保护 token
    const lost = r.stats.lostTokens || 0
    if (lost !== 0) {
      trace('rules-lossy-refused', Object.assign(meta, { lostTokens: lost, lostSample: r.stats.candidateLostSample || [] }))
      return
    }
    //   ② 归档前置闸（约束⑤ 先存后压）。这条路（appendReplace → flushPendingEmit）
    //      **没有任何归档**：替换掉就等于在没有句柄的情况下物理销毁原始 CoT。
    //      给它接上 CAS 归档之前一律拒发。
    if (cfg.rulesRequireArchive !== false) {
      trace('rules-no-archive-refused', Object.assign(meta, {
        hint: 'appendReplace 路径未接 CAS 归档；接上归档后再放开 rulesRequireArchive',
      }))
      return
    }
    //   ③ 净省字符数（抵消协议开销）
    const minChars = cfg.rulesMinSavedChars == null ? 20 : cfg.rulesMinSavedChars
    if (raw.length - r.out.length < minChars) {
      trace('rules-below-min-saved-chars', Object.assign(meta, { savedChars: raw.length - r.out.length, floor: minChars }))
      return
    }
    if (cfg.dryRun) { trace('dry-run-would-replace', Object.assign(meta, { mode: 'rules' })); return }
    appendReplace(session, aev, orig, r.out, meta)
  }

  // ── 一个块的完整决策流（三级自适应）──
  async function handleBlock(session, sLog, aev) {
    const orig = aev.data && aev.data.message
    if (!orig) { trace('no-message', { n, seq: aev.seq }); return }

    const raw = reasoningTextOf(orig)
    const rawChars = raw.length
    if (!rawChars) { trace('no-reasoning-block', { n, seq: aev.seq }); return }

    bump('seen')
    { const tcs = toolCallsOf(orig)
      if (tcs.length) {
        const c = tcs.reduce((a, b) => a + JSON.stringify(b).length, 0)
        bump('argsSeen', tcs.length); bump('argsChars', c)
        if (c >= ARGS_MIN) bump('argsOver500')
        if (tcs.some((b) => String(b.name || '').includes('inspect'))) bump('inspectCalls')
      } }
    // ── 档 1：mode 'rules' —— 完全不走网络 ──
    bump('rules')
    if (cfg.mode === 'rules') { applyRules(session, aev, orig, raw, 'mode-rules'); return }

    // ── 档 2/3：mode 'distill' —— 低于门槛不调 API，但**仍然**走规则（规则档零成本）──
    if (rawChars < cfg.minRawChars) {
    bump('short')
      trace('skip-below-threshold', { n, seq: aev.seq, rawChars, minRawChars: cfg.minRawChars })
      applyRules(session, aev, orig, raw, 'below-threshold')
      return
    }

    // ── 取「提前发起」的结果。没就绪就只等 graceMs，绝不挂起 ──
    const t0 = Date.now()
    let distilled = null
    const e = early.get(raw)
    if (!e) {
      trace('no-early-result', { n, seq: aev.seq, rawChars })
    } else {
      if (!e.settled && cfg.graceMs > 0) await Promise.race([e.promise, sleep(cfg.graceMs)])
      if (e.settled && e.ok) distilled = e.text
    if (e.settled && e.ok) bump('distilled')
      else if (e.settled) trace('distill-failed', { n, seq: aev.seq, rawChars, error: e.err })
      else trace('distill-not-ready', { n, seq: aev.seq, rawChars, graceMs: cfg.graceMs, waitedMs: Date.now() - t0 })
    if (e.settled && !e.ok) bump('distFailed')
      early.delete(raw)
    }
    const waitMs = Date.now() - t0

    bump('rules')
    if (!distilled) { applyRules(session, aev, orig, raw, 'distill-unavailable'); return }

    // ── 防线④ 用户原话机械注入（字符串截取，不经过模型）──
    const hit = findLastUserMessage(sLog, aev.seq)
    const verbatim = sliceVerbatim(hit ? hit.text : '', cfg.maxVerbatimChars)
    const finalText = assembleCheckpoint(distilled, verbatim)
    const finalChars = finalText.length

    // 人工审查用：把提纯稿原文与注入的用户原话完整落盘（各自封顶 4000 字符）
    const audit = {
      distilledText: distilled.slice(0, 4000),
      verbatimText: verbatim.slice(0, 4000),
      verbatimFromSeq: hit ? hit.seq : null,
      verbatimFromKind: hit ? hit.kind : null,
    }

    // ── 防线③ 保本后验不等式（含防线② 防增肥）──
    const h = passesHurdle(rawChars, finalChars, cfg)
    const meta = Object.assign({
      rawChars, distilledChars: distilled.length, finalChars,
      saved: h.saved, lhs: h.lhs, rhs: h.rhs, hurdleRounds: cfg.hurdleRounds,
      waitMs, earlyTookMs: e && e.readyAt ? e.readyAt - e.firedAt : null,
      earlyReused: e && e.meta ? e.meta.reused : null,
      earlyConnectMs: e && e.meta ? e.meta.connectMs : null,
      earlyTtfbMs: e && e.meta ? e.meta.ttfbMs : null,
      // ★ 这一块到底是哪个模型提纯的、有没有关掉思考（followHostModel 生效证据）
      earlyModel: e && e.meta ? e.meta.model : null,
      earlyHostModel: hostModel,
      earlyThinkingOff: e && e.meta ? e.meta.thinkingOff : null,
      toolCallsKept: toolCallsOf(orig).length, verbatimChars: verbatim.length,
    }, audit)

    if (!h.pass) {
      trace('reject-hurdle', Object.assign(meta, {
        path: 'distill', reason: h.saved <= 0 ? 'expansion' : 'insufficient-saving',
      }))
    bump('hurdle')
      applyRules(session, aev, orig, raw, 'hurdle-rejected')
      return
    }

    if (cfg.dryRun) { trace('dry-run-would-replace', Object.assign(meta, { path: 'distill' })); return }
    if (cfg.skeletonizeArgs) {
      try {
        const cmb = (ctx.get && ctx.get('cmbStore', false)) || null
        if (cmb && typeof cmb.putText === 'function') {
          const sid = (session && (session.id || session.sessionId)) || ''
          const plan = await buildSkeletonPlan(orig, cfg, cmb, sid, trace)
          pendingSkelPlan = plan
          bump('skel', plan.length)
          bump('skelChars', plan.reduce((a, p) => a + p.fullChars, 0))
        } else trace('skel-no-store', { n })
      } catch (e) { trace('skel-failed', { n, error: String((e && e.message) || e) }) }
    }
    bump('replaced')
    bump('charsRaw', rawChars)
    bump('charsFinal', finalChars)
    appendReplace(session, aev, orig, finalText, Object.assign(meta, { path: 'distill' }))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    n++
    if (!cfg.enabled) { trace('skip-disabled', { n }); return decision }
    // ★ birth 模式也要先捕获 sessionId —— CAS 归档要用它登记会话归属
    try {
      const s = payload && payload.agent && payload.agent.session
      const sid = s && (s.id ?? s.sessionId)
      birthSessionId = sid == null ? null : String(sid)
      birthSession = sid == null ? null : s
    } catch { /* ignore */ }
    // ★ birth 模式的削减在「出生那一刻」已完成 ⇒ 事后替换路径必须全关，
    //   否则同一段推理会被二次削减（且会撞上面那堵 replace 墙）。
    // ════════════════════════════════════════════════════════════════════════
    // ★★ 2026-09-21 方案二：birth 模式的「下轮收网」（Deferred Claim）★★
    //
    // 旧行为（本行原文）：birth 在这里直接 return ⇒ 事后替换路径被整体旁路
    //   ⇒ trace 里 emit-queued / replaced / checkpoint-emitted 全是 0。
    //   后果：没赶上 finishWaitMs 的提纯结果**全部丢弃** —— 用户白等 6 秒，
    //   拿不到摘要，还要额外付一次上游调用。
    //
    // 新行为：出生即提纯照旧（快则同轮内联替换）；**没赶上的结果进暂存区**，
    //   在下一轮 pre-step 用官方 user/message + surfaceOp replace 收网 ——
    //   与 checkpoint 模式共用同一条已加固的通路（emitter.js runPreStepEmit）。
    //
    // ⚠ 实际等待 = 0：pre-step 时结果早已就绪（真工期被「用户阅读 / 工具执行」消化）。
    // ⚠ keepTail 最小为 1 ⇒ 收网天然有 1 轮滞后，这是官方规范，不是缺陷。
    // ⚠ 任何一步不满足 ⇒ 一律 no-op 保持原文，绝不抛错、绝不写坏表面。
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.mode === 'birth') {
      if (cfg.birthDeferredClaim === false) { trace('skip-mode-birth', { n }); return decision }
      try {
        const bpSession = payload && payload.agent && payload.agent.session
        const bpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
        const bpSid = bpSession && (bpSession.id || bpSession.sessionId)
        // ★ 快速路径：本会话没有任何「没赶上的结果」⇒ 直接返回，
        //   不做表面读取、不做区间选择（收网器只在真有东西可收时才启动）。
        if (!lateMemorySize(bpSid, { branchId: normalizeBranchId(bpSession) })) { trace('birth-claim-idle', { n }); return decision }
        const claimScope = { branchId: normalizeBranchId(bpSession) }
        trace('birth-claim-opportunity', { n, sessionId: bpSid, branchId: claimScope.branchId, taskIds: (lateMemory.get(lateKey(bpSid, claimScope)) || []).map(x => x.taskId).filter(Boolean) })
        let pendingClaim = null
        const r = await runPreStepEmit({
          session: bpSession,
          requireUniqueRaw: true,
          validatePending: () => lateReceiptValid(bpSid, pendingClaim, claimScope),
          ctx,
          cfg,
          trace,
          rawOf: async (ev) => {
            const msg = ev && ev.data && ev.data.message
            return msg ? reasoningTextOf(msg) : null
          },
          // ★ 这里必须交**原文**：buildLedger 会用它写 CAS 归档。
          //   清洗只允许发生在「模型输入视图」那一侧（buildLedger 内联时），
          //   绝不能让归档副本被洗 —— 那是原始证据，必须字节保真。
          toolTextOf: async (ev) => toolTextFromEvent(ev),
          // ★ 零等待探测：让发射器在缺省目标未就绪时回头找「更早但已就绪」的候选（机会饥饿修正）
          isReady: async (raw) => !!(peekLateMemory(bpSid, raw, claimScope) || (cfg.lateClaimPartial === true && peekLateMemoryPartial(bpSid, raw, claimScope))),
          archive: async (text) => {
            if (!bpCmb || typeof bpCmb.putText !== 'function') return null
            try {
              const ref = await bpCmb.putText(text, {
                producer: cfg.emitterProducer || 'cot-checkpoint',
                sessionId: bpSid || null,
                retention: 'session',
              })
              return (ref && ref.handle) || null
            } catch (e) { trace('birth-claim-archive-error', { error: String((e && e.message) || e) }); return null }
          },
          // ★ birth 专属：结果不是「等」来的，是从暂存区**认领**来的。
          //   认领要求【全覆盖】：本消息的每一个推理块都有就绪结果，且拼起来逐字等于原文。
          //   只部分就绪 ⇒ 不认领、不消费（否则未就绪块的推理会凭空消失）。
          //   先 peek，只有发射成功才 acknowledge；拒发/漂移/dry-run 不消费。
          awaitDistilled: async (raw) => {
            let c = peekLateMemory(bpSid, raw, claimScope)
            if (!c && cfg.lateClaimPartial === true) {
              c = peekLateMemoryPartial(bpSid, raw, claimScope)
              if (c) trace('birth-claim-partial', { n, blocks: c.count, replacedChars: c.replacedChars, keptChars: c.keptChars })
            }
            if (!c) { trace('birth-claim-miss', { n, why: explainLateMiss(bpSid, raw, claimScope), rawChars: raw.length }); return null }
            // 多块时按块序拼接（顺序由 coverageMatch 保证，绝不按 promise 完成序）
            const text = c.texts.join('\n\n') || renderCheckpoint(c.entries)
            if (!text || !String(text).trim()) return null
            pendingClaim = c.receipt
            trace('birth-claim-hit', { n, blocks: c.count, chars: String(text).length, taskIds: c.receipt.map(x => x.taskId).filter(Boolean) })
            return { ok: true, text: String(text) }
          },
        })
        trace(r && r.emitted ? 'birth-claim-emitted' : 'birth-claim-skip', {
          n, reason: r && r.reason, returnedSeq: r && r.returnedSeq, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean),
        })
        if (r && r.emitted) {
          const consumed = acknowledgeLateMemory(bpSid, pendingClaim, claimScope)
          trace('birth-claim-acknowledged', { n, consumed, seq: r.returnedSeq ?? null, taskIds: (pendingClaim || []).map(x => x.taskId).filter(Boolean), rawChars: (pendingClaim || []).reduce((n, x) => n + x.raw.length, 0), summaryChars: (pendingClaim || []).reduce((n, x) => n + String(x.board || '').length, 0), accounting: 'characters-not-tokens-or-money' })
          for (const item of pendingClaim || []) consumption.applied(item.taskId, item.board)
          // A block-level ledger is NOT the entire latest persistent snapshot.
          // Do not mark that unrelated revision as host-applied.
        }
      } catch (e) {
        trace('birth-claim-error', { n, error: String((e && e.message) || e) })
      }
      return decision
    }
    if (cfg.mode === 'off') { trace('skip-mode-off', { n }); return decision }

    // ★★ mode: 'checkpoint' —— 官方 user/message 检查点发射器（阶段二）★★
    //   全链路：感知水位 → D10 动态门槛 → D1′ 平衡整步 → D4′ 伴生提纯收网
    //           → D2′ 混合组装 → 官方合规 replace 发射（绕开 surface.js:207 / :234 两道断言）
    //   任何一步不满足 ⇒ runPreStepEmit 一律返回 no-op（保持原文），绝不抛错。
    if (cfg.mode === 'checkpoint') {
      try {
        const cpSession = payload && payload.agent && payload.agent.session
        const cpCmb = (ctx.get && ctx.get('cmbStore', false)) || null
        const r = await runPreStepEmit({
          session: cpSession,
          ctx,
          cfg,
          trace,
          rawOf: async (ev) => {
            const msg = ev && ev.data && ev.data.message
            return msg ? reasoningTextOf(msg) : null
          },
          // 复用 emitter.js 里的唯一实现（真机形状已实测 11,802/11,802 命中）
          toolTextOf: async (ev) => toolTextFromEvent(ev),
          archive: async (text) => {
            if (!cpCmb || typeof cpCmb.putText !== 'function') return null
            try {
              const ref = await cpCmb.putText(text, {
                producer: cfg.emitterProducer || 'cot-checkpoint',
                sessionId: (cpSession && (cpSession.id || cpSession.sessionId)) || null,
                retention: 'session',
              })
              return (ref && ref.handle) || null
            } catch (e) { trace('emitter-archive-error', { error: String((e && e.message) || e) }); return null }
          },
          awaitDistilled,
        })
        trace(r && r.emitted ? 'checkpoint-emitted' : 'checkpoint-skip', {
          n, reason: r && r.reason, returnedSeq: r && r.returnedSeq,
        })
      } catch (e) {
        trace('checkpoint-error', { n, error: String((e && e.message) || e) })
      }
      return decision
    }

    // ★ 每步之前补一次预热（非阻塞）。若池里已有热 socket 且未超最小间隔，内部会直接跳过。
    //   目的是保证 early-fire 真发生时 socket 是温的 —— 冷连接要多花 ~411ms。
    prewarm('pre-step')

    try {
      const session = payload && payload.agent && payload.agent.session
      if (!session || typeof session.append !== 'function') { trace('no-session', { n }); return decision }
      const sLog = readSessionLog(session)
      if (!Array.isArray(sLog)) { trace('no-log', { n }); return decision }

      const aev = findLastAssistantEvent(sLog)
      if (!aev) { trace('no-assistant-event', { n }); return decision }

      // ── H2 硬闸：已经处理过的块 = 已经随 payload 出站过 ⇒ 物理上永不可改 ──
      if (locked.has(aev.seq)) { trace('skip-locked-already-sent', { n, seq: aev.seq }); return decision }

      try {
        await handleBlock(session, sLog, aev)
      } finally {
        // ★★ 无论成功、被拒、超时还是异常，本步之后这条块都已经随 payload 出站
        //    ⇒ 立刻上锁，之后任何路径都不许再碰它（这就是 H2）。
        locked.add(aev.seq)
        // 有界：只会查询「最后一条 assistant 事件」，所以最老的键可以安全丢弃
        if (locked.size > 4096) {
          let drop = 1024
          for (const s of locked) { locked.delete(s); if (--drop <= 0) break }
        }
      }
    } catch (e) {
      trace('pre-step-error', { n, error: String((e && e.message) || e) })
    }
    return decision
  })

  // ── agent/request：★ 唯一被允许的发射时机（此刻 step 已开启）────────────────
  //   payload = { turn, step, signal }（agent-loop :708）——没有 agent 字段，所以 session 由入队时捕获。
  //   全程 try/catch：本插件任何异常都不许影响宿主发请求；next() 必须在所有路径上被调用并返回。
  ctx.on('agent/request', async (payload, next) => {
    try {
      if (cfg.enabled && cfg.mode !== 'off' && cfg.mode !== 'birth' && cfg.mode !== 'checkpoint') flushPendingEmit(payload || {})
    } catch (e) {
      trace('request-emit-error', { error: String((e && e.message) || e) })
    }
    return next()
  })

  // ── llm/stream：只读观测 + 提前发起（非阻塞）──────────────────────────────
  // ⚠ 包装流的写法照抄 `deploy/probe/index.mjs` —— 那是本项目已在真实会话里跑过的既有模式：
  //   任何**观察**异常都不许影响主流；主流自己抛错必须原样抛出，不许吞。
  ctx.on('llm/stream', (options, next) => {
    if (cfg.enabled && cfg.mode !== 'off') consumption.observe(options)
    if (!cfg.enabled || cfg.mode === 'off') return next()
    // ★★ 宿主对话模型捕获（必须在 fireEarly 之前）★★
    //   本次 llm/stream 就是「生成当前这条 assistant 消息」的那次调用
    //   ⇒ options.model 正是宿主此刻对话用的模型 ⇒ 拿它提纯，就是用户要的「跟着对话模型走」。
    try {
      const hm = options && options.model
      const hp = options && options.provider
      if ((hm && hm !== hostModel) || (hp && hp !== hostProvider)) {
        if (hm) hostModel = hm
        hostProvider = hp || hostProvider
        if (cfg.followHostModel && hm) cfg.model = hm
        // ★ 模型跟随之外，端点/钥匙也跟随宿主 provider（禁止硬编码）
        if (cfg.followHostProvider !== false) cfg.followProvider = hostProvider
        trace('distill-endpoint-target', { hostProvider, followProvider: cfg.followProvider || null })
        trace('host-model', {
          model: hm,
          provider: options && options.provider,
          followHostModel: cfg.followHostModel,
          effectiveModel: cfg.model,
          n,
        })
      }
    } catch (e) { trace('host-model-error', { error: String((e && e.message) || e) }) }

    try {
      const msgs = (options && options.messages) || []
      // ★ 2026-09-21 消息溯源（外部审计 P0-3）：只观测，绝不删/改/合并任何消息。
      //   判据是"来源与时间线"，不是"role 数了几个"。
      const prov = provenanceOf(msgs)
      // ★ 建立"出站消息 → 源事件 seq"的链条（只读；不改任何事件）
      const seqMap = mapMessagesToSeqs(birthSession, msgs.length)
      // ★ 2026-09-21 守住最危险的假阳性（外部审计）：**数量不一致时绝不按下标硬配** ——
      //   错位的 seq 比没有 seq 更糟，它会让人顺着错误的链条得出结论。
      //   只有 note==='aligned' 才写 seq；否则整批不写，只留 note 说明原因。
      if (seqMap.map && seqMap.note === 'aligned') {
        for (let i = 0; i < prov.items.length; i++) prov.items[i].seq = seqMap.map[i]
      }
      trace('llm-stream', {
        n,
        model: options && options.model,
        provider: options && options.provider,
        messageCount: msgs.length,
        roles: msgs.map((m) => m && m.role),
        reasoningChars: msgs.map((m) => reasoningTextOf(m).length),
        // 连续同 role 的游程（只报 n>1）
        runs: prov.runs,
        // 末尾若干条的溯源（看板 / 人类 user 开头 / 长度）
        tail: prov.items.slice(-8),
        // 开头一段（连续 user 游程所在），用于追溯注入来源
        head8: prov.items.slice(0, 8),
        seqMapNote: seqMap.note,
        seqMapCount: seqMap.count, seqMapExpected: seqMap.expected,
        ledgerCount: prov.items.filter((x) => x.isLedger).length,
        toolResultCount: prov.items.filter((x) => x.blockTypes && x.blockTypes.includes('tool-result')).length,
        userCount: prov.items.filter((x) => x.role === 'user').length,
        assistantCount: prov.items.filter((x) => x.role === 'assistant').length,
      })
    } catch (e) { trace('llm-stream-error', { error: String((e && e.message) || e) }) }

    const inner = next()
    // ★★ mode: 'birth' —— 出生即提纯（At-Birth Interception）★★
    //   在宿主 `live.push(chunk)` 之前改写推理 ⇒ 装配出的就是压缩后的 assistant 消息，
    //   走的是【普通 append】，不碰 surfaceOp:replace，故不触发任何表面断言。
    if (cfg.mode === 'birth') {
      if (!inner || typeof inner[Symbol.asyncIterator] !== "function") {
        // 拿到的不是 async iterable 就原样返回，绝不包装（包装不认识的形状会让主模型当场失败）
        trace("birth-no-async-iter", { n, kind: inner === null ? "null" : typeof inner })
        return inner
      }
      if (cfg.dryRun) { trace('birth-dry-run-stream', { n }); return inner }
      // Capture now: another pre-step/provider update may run before this stream
      // is consumed or before block-end. No mutable session/config lookup later.
      const streamSession = birthSession
      const streamSessionId = birthSessionId
      const streamBranchId = normalizeBranchId(streamSession)
      const streamCfg = { ...cfg }
      return birthTransform(inner, {
        cfg: streamCfg,
        trace,
        sessionId: streamSessionId,
        branchId: () => streamBranchId,
        // Mirror runs outside finish; nonblocking recovery is scheduled by pre-step.
        archive: async (text, sid) => {
          const store = (ctx.get && ctx.get("cmbStore", false)) || null
          if (!store || typeof store.putText !== "function") { trace("birth-no-store", { n }); return null }
          try {
            const ref = await store.putText(text, {
              producer: streamCfg.birthProducer || 'cot-birth',
              sessionId: sid || null,
              retention: 'session',
            })
            return (ref && ref.handle) || null
          } catch (e) {
            trace("birth-archive-error", { n, error: String((e && e.message) || e) })
            return null
          }
        },
        // ★ 方案一：唯一压缩器 = 宿主模型提纯（100% 跟随宿主 provider/model；本模块不碰端点与钥匙）
        // ★ 状态记忆打开时：输入是【证据信封】，产物是六栏状态渲染 + 记忆条目。
        //   两者共用同一条传输/重试/超时/取消机制（仍是**一次**模型调用）。
        // ★★ 2026-09-22 切分后：按 compileMode 三选一 ★★
        //   memory   → 证据信封 + 两栏判断（状态记忆）
        //   compress → 本段 reasoning 的摘要（纯压缩）★ 输入不背整窗证据
        //   legacy   → 旧的 generateDistillation 默认提示词
        distill: compileModeOf(streamCfg) === 'memory'
          ? async (env, signal, budget) => generateStateMemory(env, budget?.timeoutMs != null ? { ...streamCfg, timeoutMs: budget.timeoutMs } : streamCfg, signal, { ...budget, flights: compilerFlights })
          : compileModeOf(streamCfg) === 'compress'
            ? async (raw, signal) => (streamCfg.compressPrompt === 'v1'
                ? generateDistillation(raw, streamCfg, signal, buildDistillPrompt(raw), { promptVersion: 'compress-v1' })
                : generateDistillation(raw, streamCfg, signal, buildCompressPrompt(raw), { promptVersion: 'compress-v2' }))
            : async (raw, signal) => generateDistillation(raw, streamCfg, signal),
        prepareEvidence: (input) => {
          const started = performance.now()
          const frame = prepareCompilerEvidence(input, streamCfg.stateSnapshot)
          trace('evidence-prepare-cost', { ms: performance.now() - started, io: frame.ioStats || null })
          return frame
        },
        buildEnvelope: (o) => buildEvidenceEnvelope(o),
        collectEvidence: (o) => collectEvidence(streamSession, o),
        // ★ 优化1：句柄内存秒算（与 store.deriveHandle 同一公式，纯函数）
        deriveHandle: (sessionId, text) => deriveArtHandle(sessionId, text),
        // ★ 优化2：思考一开始就捂热连接（HEAD，零 token）
        prewarm: (why) => prewarm(why),
      })
    }
    if (!cfg.earlyFire || (cfg.mode !== 'distill' && cfg.mode !== 'checkpoint')) return inner

    // ★ 保险：拿到的不是 async iterable 就**原样返回，绝不包装**。
    //   包装一个不认识的形状会让 `for await` 直接抛错 ⇒ 主模型调用当场失败。
    //   宁可这一轮不提前发起，也绝不许碰坏主流。
    if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
      trace('early-no-async-iter', { n, kind: inner === null ? 'null' : typeof inner })
      return inner
    }

    return (async function* () {
      const blockType = new Map() // index → blockType
      const buf = new Map()       // index → reasoning 文本（按 index 升序拼，与 reasoningTextOf 同口径）
      let fired = false
      const joinBuf = () => [...buf.keys()].sort((a, b) => a - b).map((k) => buf.get(k)).join('\n')
      const maybeFire = (why) => {
        if (fired) return
        const text = joinBuf()
        if (!text.trim()) return
        fired = true
        trace('early-trigger', { n, why, reasoningChars: text.length })
        fireEarly(text)
      }
      try {
        for await (const chunk of inner) {
          try {
            const t = chunk && chunk.type
            const idx = chunk && chunk.index !== undefined ? chunk.index : 0
            if (t === 'block-start') {
              blockType.set(idx, chunk.blockType)
              // reasoning 之后紧接着 tool-call / text ⇒ reasoning 一定已经写完
              if (chunk.blockType === 'tool-call') maybeFire('tool-call-block-start')
              else if (chunk.blockType === 'text') maybeFire('text-block-start')
            } else if (t === 'text-delta') {
              if (blockType.get(idx) === 'reasoning') buf.set(idx, (buf.get(idx) || '') + String(chunk.text || ''))
            } else if (t === 'reasoning-delta') {
              buf.set(idx, (buf.get(idx) || '') + String(chunk.text || chunk.reasoning || ''))
            } else if (t === 'block-end') {
              const b = chunk.block
              if (b && b.type === 'reasoning') { buf.set(idx, String(b.text || buf.get(idx) || '')); maybeFire('reasoning-block-end') }
            } else if (t === 'tool-call-delta') {
              maybeFire('tool-call-delta')
            } else if (t === 'finish') {
              maybeFire('finish')
            }
          } catch { /* 观察失败绝不影响主流 */ }
          yield chunk
        }
      } catch (err) {
        trace('llm-stream-threw', { n, error: String((err && err.message) || err) })
        throw err
      }
    })()
  }, { prepend: true })
}
