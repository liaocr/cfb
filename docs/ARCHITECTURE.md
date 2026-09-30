# 架构（v13，开发者视角）

> 面向改代码的人：模块怎么分、数据怎么流、哪些不变式不能碰、加东西该改哪里。
> 使用与配置见根目录 [`README.md`](../README.md)；设计沿革见 [`CHANGELOG.md`](../CHANGELOG.md)；v12.0 之前的文件可从 git `cfba57b` 取回。
>
> 默认生产压稿仍只有**一条路径**：`mode: 'birth'` + compress 编译。checkpoint 模式、迟到认领（deferred claim / late-memory）、
> memory 模式（证据账本 / 快照 / 状态记忆）、legacy v1 提示词及其全部支撑模块已删除（src 8,990 → 约 3,100 行）。

## 1. 模块地图

包入口 `index.js` 只做导出；宿主拿到 `name` / `inject` / `apply`，其余导出供自测与离线工具使用
（`package.json` 的 `exports` 只开放 `.`，深层路径对外不可导入，内部文件可以自由搬迁）。

依赖从上往下，**无环**：

```
plugin.js ─────────────────────────────── 组合根：apply() 注册两个钩子、接线
  ├─ boot-record.js       BOOT 行内容（生效配置与版本号）
  ├─ host-follow.js       调用级模型 / provider（共享 cfg 不变）
  ├─ session-tracker.js   流归属（交错 ⇒ 不可证）
  ├─ handle-probe.js      句柄读回探针
  ├─ birth.js ─────────── 出生即压缩（唯一生产路径）+ 成本模型 + 水位读数 readPressure
  │    ├─ fidelity.js       逐字标识符召回率（观测）+ 发明标识符闸（判定）
  │    ├─ tokens.js         token 粗估（token 闸门）
  │    └─ trace.js          settled 字段白名单
  ├─ distill.js ───────── 副模型调用（重试降级 / 对冲 / 传输 trace）+ makeBirthCompiler（compress-only）
  │    ├─ prompts.js ─ config.js
  │    ├─ compile-v4.js     v12.2 compress-v4-ops 确定性编译器（parse → validate → select → render）→ fidelity.js, tokens.js
  │    ├─ segment-v4.js     v12.3 v4 流式增量编译（分段器）→ compile-v4.js, prompts.js
  │    └─ transport.js ─ provider.js ─ config.js
  └─ messages.js         出站消息溯源（只观测）
```

规模：以 `wc -l src/*.js` 为准（当前最大是 `compile-v4.js`）；证据程序为独立宿主模块，不改变默认压稿链。

## 2. 钩子与数据流

`apply(ctx, config)`（`plugin.js`）先 `normalizeConfig`，写一行 `BOOT`（内容在 `boot-record.js`），然后注册：

| 钩子 | 做什么 |
|---|---|
| `agent/pre-step` | 只捕获当前会话（`session-tracker.js`，供 CAS 归档登记会话归属与流归属判定），原样返回宿主的 decision |
| `llm/stream`（`prepend`） | 只读观测：宿主模型/provider 跟随（`host-follow.js` 派生**本次调用专属**配置）、`llm-stream` 溯源 trace；判定流归属（交错 ⇒ 不可证）；`birth` 模式用 `birthTransform` 包装主流 |

任何观测或内部异常都被 `try/catch` 吞成 trace；**主流自己的错误原样抛出**。拿到的流不是 async iterable 就原样返回、绝不包装。

### 2.1 birth：一个 reasoning 块的一生（`birth.js`）

```
birthTransform(inner, deps)
  block-start(reasoning) → birthHoldNew + 立即透传
  reasoning-delta        → 累积 + 实时透传（live）
  block-end(reasoning)   → birthStart(entry, deps)   ← 同步返回 task，绝不 await
                              belowFloor 判定：dryRun / disabled / 短于 birthMinChars（或 birthMinTokens）/ archive-off / no-store
                              handle   = deriveArtHandle(sessionId, raw)（与 CMB store 同一公式，内存秒算）
                              diskP    = deps.archive(raw)          （CAS 写盘，birthArchiveTimeoutMs 护栏）
                              distillP = deps.distill(raw, signal, { onHeaders, taskId, trace })
  finish                 → birthFinish(task, deps)   ← 押后到最后
                              等 min(finishWaitMs, 真工期)；到点但已收到 200 响应头 ⇒ 再宽限 finishHeadersGraceMs（一次）
                              判定顺序：归档 → 压缩成功 → 非空白 → 无发明标识符 → 净省字符 → token 不增
                              结局：condensed | condensed-partial（v4 增量）| below-floor/dry-run/… | archive-failed(-early)/archive-timeout |
                                    distill-failed(-early)/distill-timeout | empty-candidate | invented-identifier |
                                    no-gain | no-token-gain
                              任何放行 ⇒ birthCancelFlying 取消仍在飞的提纯
```

`deps.distill` 由 `distill.js` 的 `makeBirthCompiler(streamCfg)` 构造：按 `compressPromptFor(cfg, raw)` 选提示词
（缺省 v3；只有显式 `compressPrompt: 'v2'` 走 v2），`compressSystemPrompt` 打开时拆成 system + user（字节等价），
再调 `generateDistillation`。`promptVersion` 由 `compressPromptVersion` 唯一裁决，BOOT / 每次编译 / trace 共用。

`compressPrompt: 'v4'`（v12.2）时同一个闭包多走一步：

```
generateDistillation(raw, { maxOutputTokens: max(cfg, compressV4MaxOutputTokens) }, …, buildCompressPromptV4(raw))
  → 副模型输出 JSON ops
compileV4(output, raw, cfg, v4Budget(cfg))                       （src/compile-v4.js，纯函数、同步）
  parseOps     容错解析（围栏 / 前后废话 / 裸数组 / JSON Lines）
  validateOps  I1 锚点逐字 · I2 标识符有出处 · I3 证伪带替代 · I4 无观测否定→搁置 · I5 工具来源不写「我决定」
               · I7 同 key 留最新 · I8 无第二人称 · schema / 去重；INCUMBENT/COMPUTED 编造 ⇒ fatal
  selectOps    必留（INCUMBENT / REFUTED / OPEN）→ 剔除 restate / verify 冗余 → 价值/字符贪心装预算 → 依赖闭包
  renderOps    证据定粘性 · 替代先行 + 否定就近 · 过去时计划 · 分组顺序 · 尾段（结论 + 未决问句）· 语言跟随原文
  → ok ⇒ { text: 渲染稿, meta.v4 }；否则抛 Error(reason)，meta.v4 带统计 ⇒ birth 原文放行（distill-failed）
trace: compiler-v4-compiled（每次）；birth-distill-settled / birth-distill-failed 的 v4 字段
```

与理论规格的差异登记在 `compile-v4.js` 文件头：λ 控制器（需要跨轮传感器）以固定预算代替；渲染按组而非纯贪心顺序。

#### 2.1.1 v4 流式增量编译（v12.3，`segment-v4.js`；`compressV4Incremental` 缺省开）

```
reasoning-delta  → h.seg ??= deps.segmenter(index)；h.seg.feed(累积全文)
                     攒够 segChars ⇒ 在 [0.6,1.0]×segChars 找最后一个边界（空行 > 换行 > 句末），
                     否则 (1.0,1.5]× 找第一个，否则硬切 ⇒ fire(段)：
                       prior = 已 ok 段的 kept 条目（priorLines，≤30 行；不等待在飞的段）
                       compileSegment(段, prior, signal) = makeV4SegmentCompiler：buildCompressPromptV4Segment → generateDistillation → parseOps
                       本段 validateOps（锚点必须在本段）⇒ ok / failed(reason)
block-end        → birthStart(entry{seg})：distill = seg.finish（送出尾段，等全部落定）；task.partial = seg.partial
                     低于门槛 / 停用 / 归档关 / 无 store ⇒ seg.cancel
seg.finish       → L = 最后一个 ok 段；L 之前没编成的段 = 原文空洞（逐字放渲染稿前面）；L 之后 = 原文尾巴
                     compileOpsV4(ok 段条目, raw, …, { rawPrefix, rawSuffix, segmented: true })
                       全文校验（retracts / id 形态的 supersedes 生效）→ freshenState（状态后写者胜）→ 选取 → 渲染（有尾巴则不出尾段）
                     没有 ok 段 ⇒ throw v4-no-compiled-segment（原文放行）
finish 到点      → dist === null 且 task.partial() 非空 ⇒ 同一组闸 ⇒ condensed-partial；birthCancelFlying('partial-used')
```

不变式：原文尾巴 / 空洞逐字；最新状态总在最后（空洞放前、尾巴放后）；在飞段在任何放行 / 中断 / 提前退出路径上都被取消（`dropSeg` / `dropHeldSegs`）。

### 2.2 副模型调用（`distill.js`）

`generateDistillation`：解析端点与钥匙（跟随宿主 provider，解析不出来就抛错、上层原文放行）→
每轮先带「关思考」试，被 4xx 参数拒绝再裸试 → `hedgedDistill`（`hedgeAfterMs>0` 且 `maxAttempts≤1` 才对冲）→
`distillOnce` / `distillOnceStream`（同输入同输出形状）→ 每次请求落 `compiler-transport-started/settled`。
终止闸：没有 `finish_reason=stop`（或 Responses 的完成事件）就是失败，截断输出绝不当成功。

对冲纪律：只有 **200** 响应头才算胜出；同一时刻至多 1 份对冲在飞；主请求已结算（成功或失败）后计时器不再发对冲，
主请求失败时立即按主错误结算。

## 3. 持久化位置

全部在 `$DSH_HOME/storages/cot-form-b/`（`$DSH_HOME` 缺省 `~/.dsh`，解析规则见 `config.js` 的 `dshHome`）：

| 路径 | 写入者 | 何时 |
|---|---|---|
| `trace.log`（+ `trace.log.1`） | `trace.js` | `trace: true` 时每个事件一行；超过 `traceMaxBytes`（64 MiB）轮转一次 |

默认插件自己**不写状态文件**（旧 memory 模式的快照/账本/锁已删除）。v13 的显式宿主证据 API 使用独立、会话隔离的签名块仓；不恢复旧看板路径，详见下节。
CAS（原文归档）是宿主注入的 `cmbStore` 服务（`ctx.get('cmbStore')`），本插件只调用 `putText`（与读回探针的只读 API）。

## 4. 不变式（违反即坏）

1. **H2 首次出站不变律**：一个块只能在「还没出站」时被替换。birth 在装配前改写，天然满足；
   事后改写 `assistant/message` 被宿主 `surface.js:207` 永久禁止（这也是 distill/rules 模式退役的原因）。
2. **归档先于压缩**：拿不到 CAS 句柄就绝不替换原文。
3. **观测不碰主流**：溯源、水位读数、trace 写入等任何失败都只降级为「原文放行」或「丢一条观测」，绝不抛给宿主。
4. **不猜**：模型名、端点、钥匙都跟随宿主；解析不出来就不发起，绝不回落到写死的值。
5. **标识符必须有出处**（v12.1）：摘要里的路径 / URL / 反引号代码 / camelCase / snake_case / `file.ext`
   必须逐字出现在原文里（斜杠方向可互换），否则原文放行。压缩稿会被主模型当成「自己想过的事实」读回，
   编造的标识符是定向误导。判据在 `fidelity.inventedIdentifiers`，只拒绝、不改写。
6. **字符 ≠ 钱**：trace 里的字符数只描述上下文余量，不得当作费用节省汇报。
7. **评估态零副作用**：`dryRun` 下 birth 直接原样返回主流（不包装、不写 CAS、不调副模型），只落观测。
8. **地址必须可读回**：birth 的内存预推句柄只在读回验证通过后才可当作句柄用；不可证即按归档失败处理（原文放行）。
9. **放弃即取消**：凡是决定「这块用原文」的路径（finish 到点、硬停、源流无 finish、源流抛错、消费者提前退出、
   任何 passthrough），都经由唯一实现 `birthCancelFlying` 取消仍在飞的提纯。v12.1 起没有「留给下一轮」的例外。
10. **token 不降不替换**：字符净省达标但估算 token 不降 ⇒ 原文放行（`no-token-gain`）。估算只用于**拒绝**，不用于宣称节省。
11. **共享配置不可变**：`apply()` 里归一化出的 `cfg` 在运行期永不改写；随调用变化的量（宿主模型、provider）
    由 `host-follow.js` 派生到调用级副本里。凡是「稍后才读配置」的地方（压缩、预热）都必须拿调用级副本。
12. **流归属不可证不归档**：多个会话交错进入 pre-step 时，这条流属于谁无法证明 ⇒ 缺省原文放行，不写 CAS。

## 5. 改哪里

| 想做的事 | 要改的地方 |
|---|---|
| 加一个配置键 | `config.js` 的 `DEFAULTS`（写清来历）；若允许嵌套写法，加进 `NESTED_*_KEYS`；`index.d.ts`；`core.selftest.mjs` §10 |
| 退役一个配置键 | 从 `DEFAULTS` 删除，加进 `RETIRED_OPTIONS`（配置里出现时进 `retiredOptions` 并被删除，BOOT 可见）；`v12.selftest.mjs` 加兼容用例 |
| 给 `birth-distill-settled` / `compiler-transport-settled` 加字段 | `trace.js` 的 `settledTraceData` 白名单（只写进 meta 不会落盘，出过真实事故） |
| 改 v4 的判定 / 渲染 | `compile-v4.js`（纯函数，全部可单测）；新拒绝规则走 `validateOps` 的 `reject(rule)`，统计自动进 `stats.rejected`；改模板要同步 `v4.selftest.mjs` §5 |
| 改提示词 | `prompts.js`；版本号必须从 `compressPromptVersion` 同一次裁决里取；v3 与 v2 的保真规则 1~6 必须逐字共享（`compress.selftest.mjs` §1b 钉住） |
| 加一道放行判定 | `birth.js` 的 `birthFinish`，走 `pass(why, handle, extra)`（自动取消在飞提纯、落 `birth-passthrough`）；`analyze-efficiency` 的 `outcomes` 会自动按 `why` 分桶 |
| 加一个模块 | 放进 `src/` 即可；`DEP_ID` 自动枚举，BOOT 会带上它 |
| 加一个测试套件 | `test/<名字>.selftest.mjs`，末尾打印 `PASS=n FAIL=m`；把名字加进 `verify.mjs` 的 `ORDER`（不加也会被自动纳入，但会提示）。套件会**并发**运行，不得依赖其他套件的副作用；特别慢的套件加进 `SLOW_FIRST` |
| 改了任何文件 | `npm run manifest` 重新生成清单（CI 会 `--check`） |
| 在钩子里需要「随调用变化」的配置 | 用 `host.callConfig(options)` 的返回值，**不要**改写共享 `cfg`（不变式 11） |
| 需要知道这条流属于哪个会话 | `sessions.forStream()`；`ambiguous` 为真时不得归档（不变式 12） |
| 测试里需要写盘 | 不用管隔离：`verify.mjs` 已为每个套件设临时 `DSH_HOME`；单独运行时请自己设 |

## 6. 测试布局

`verify.mjs` 并发运行（缺省 `max(6, CPU 数)`，`--serial` / `-j N` 可调；慢套件先起跑），结果按 `ORDER` 顺序打印。
每个套件独立进程、独立临时 `DSH_HOME`：

| 套件 | 覆盖 |
|---|---|
| provider-endpoint | 端点解析 |
| core | 默认值、配置归一化、传输层、副模型调用、宿主模型跟随（birth 全链路，本机 HTTP 收包验证）、成本模型、回归钉子 |
| compress | **v12.1 主线**：v2/v3 提示词与版本号裁决（v3 缺省）、退避、4MiB 上限、终止闸、promptVersion 贯通、**发明标识符闸**（判据 + birthFinish 端到端 + 开关 + analyze-efficiency 分布）、onboard 漂移检测 |
| v4-live | **v12.3** `tools/v4-live.mjs` 离线端到端：本地假 DeepSeek（主模型流 + 副模型），录制 → 三模式回放（v4 整块超时 / v4 增量替换成功）、钥匙不落盘、`--replay` |
| v4 | **v12.2 compress-v4-ops** + **v12.3 §9 流式增量**（切点、分段合并 / retracts、到点部分结果、失败不跳段、取消、birthTransform 端到端）：提示词 / 版本号 / 配置、容错解析、每条硬不变量、选取（必留 / 冗余 / 预算 / 闭包）、渲染（替代先行、证据定粘性、分组、尾段、中英）、整块回退的每条原因、本机 HTTP → makeBirthCompiler → birth 全链路（成功替换 / 失败原文放行）、cf-eval v4 变体 |
| birth | birth 主路径（含真实 dsh-llm 不变式校验，找不到宿主安装时用替身并 WARN）、放弃即取消、句柄可归因（T34） |
| robustness | 退役开关不生效、pre-step 不被拖垮、trace 审计器、taskId 贯通、传输层错误形态、句柄读回探针契约 |
| hedge | 对冲与响应头宽限（本机 HTTP 可控延迟） |
| hook-wiring | 只有出错才会走到的接线：服务获取抛错、坏形状不包装、CAS 写入抛错、**主流抛错原样抛出**、评估态零介入 |
| hardening | 取消泄漏各路径、配置登记/退役/显式化、token 估算与闸门、trace 轮转、provider 缓存、编译器工厂（真实 HTTP）、analyze-trace 的 birth 等待依据 |
| concurrency | 调用级配置（共享 cfg 不变）、birth 压缩用自己那次调用的模型、流归属交错检测与处置 |
| protocol | OpenAI Responses 端点（非流式 / 流式 / 协议错配 / 完成判据 / 降级重试）、token 估算校准链路 |
| branches | 预热（节流 / 停用 / 调用级 provider）、token 估算非字符串输入 |
| audit-2026-09-27 | 外部审计 F1–F11 的回归钉（F7 随 x1、G 随在途共享删除） |
| v12 | 退役配置兼容：x1 / v1 回落 v3、checkpoint ⇒ off、memory / 迟到认领 / emitter 键进 retiredOptions、BOOT 单一路径 |


## 7. v13 宿主证据程序模块与边界

完整接口/决策/不采用方案/预测/部署见 [`EVIDENCE-PROGRAM.md`](EVIDENCE-PROGRAM.md)。

| 模块 | 职责 |
|---|---|
| evidence-program.js | 纯 JSON/三值谓词、冻结契约、类型化步骤、提议/授权分离、逐阶段签名回执闸 |
| evidence-host.js | 安全本地文件/进程检查、私有 HMAC 回执权、验证器依赖文件固定与漂移检查 |
| active-checks.js | 完整条件熵 EIG、贝叶斯更新、预算内主动查询，诊断不能替代验收 |
| effect-archive.js | 逐项正/零/负/未知效果、三切分严格提升门、盲测消耗、拒绝/退役/k≤1 检索、签名仓持久化 |
| evidence-store.js | RAW/EXPLANATION/STEP 无损块、会话隔离、持久 HMAC、显式回取/容量预算 |
| evidence-checkpoint.js | 受管文件字节/权限/存在性 + JSON 上下文/条件、冲突拒绝、事务恢复、验证峰值 |
| evidence-runtime.js | 三阶段检查执行、有界轮次与修复/检查预算、主动诊断、联合恢复、错误历史隔离；会话服务组合根 |

`compileV4Evidence` 是 `compileV4Direct` 的新侧车包装，不改旧闸门/渲染。`birthFinish` 在显式 `evidenceProgram:true` 且原生 `createEvidenceHost` 服务匹配会话时发布制品；不把块仓句柄写进 reasoning，不改 chunks，不自动执行。宿主只有显式 `runRound/runLatest` 才使用新动作链；DSH 工具拦截/完整环境恢复不是既有 stream 钩子提供的能力。

存储默认由宿主选择 `$DSH_HOME/storages/cot-form-b/evidence/`，运行目录也可用 `.cfb-runtime/`（Git/manifest 忽略）。所有新模块无初始化 IO；只创建宿主仓/适配器时才写盘。HMAC 不是 OS 沙箱；宿主须独占资源并保护独立评价器、私钥与留出集。

新增套件 `evidence-program`（15）、`active-checks`（11）、`effect-archive`（12）、`evidence-runtime`（26）；共 20 套件，verify 700/0/1。协议合成夹具不是主模型泛化评测，唯一跳过仍是原有宿主兄弟包等价探针。


## v13.2 离线优先评测平面（不接管默认插件）

- `tools/effect-ready.mjs`：统一prepare/doctor/simulate/run/report/export/import；只有明确live才发请求；`bounded-ab.mjs`为兼容别名。
- `tools/helpers/eval-plan.mjs`：生产零成本重编译、完整冻结消息/工具/规则、源码指纹、先后平衡、唯一配对；参考不进模型。
- `api-budget.mjs` + `api-watermark.mjs`：有界13/USD2、严格通道/usage/工具门；私有HMAC+CAS与非ignored公开水位绑定，缺仓/回滚/鉴权变更拒绝重开。不退款/重发未知。
- `eval-workflow.mjs`：安全公开配置、纯本地体检、信号与缓存续跑、离线报告；真实账单未知不造0。
- `eval-bundle.mjs` + `eval-files.mjs`：受限文件IO、AES-GCM+scrypt加密迁移、拒绝旧水位与非空覆盖；可选每次预占/回复同步单调备份，失败不伪造provider失败。
- `eval-simulate.mjs`：真实loopback但固定替身；完整矩阵/断点/丢仓恢复/9故障，外部调用0，不执行shell，不证明LLM质量。

公开小watermark保存于transfer、私有数据在ignored `.cfb-runtime`或显式持久卷；AES包包含本地authority，不能作为明文制品进入Git。源码完整性manifest不代替预算收据，也不包含私有仓。两平面存储故障停止，不自动修补；同权限宿主同时抹去全部副本或服务商违背价格/token限制仍不可由本地代码物理保证。


## v13.3 训练平面（与生产编译/执行权限分离）

- `src/training-core.js`：完整数据IR、fingerprint连通组切分、训练字段导出、冻结全项评测suite、逐项严格发布纯门；不联网、不训练、不授予权限。
- `tools/helpers/training-data.mjs`：流式两遍构建、HMAC专家/目标审核、撤销/隔离/已消费族、私有test custody、provider导出等价与内容清单。
- `training-plan/IO/state/governance`（IO模块`training-io.mjs`）：数据/配方/源/基模型缓存指纹、独立训练批准、双平面CAS步骤/HTTP水位、候选与发布簿；不能靠路径变重置。
- `training-reference.mjs`：无依赖真正SGD测试模型；`training-remote.mjs`：显式能力/训练价的files/job/poll/cancel适配器；`training/lora_trainer.py`：可选缓存/助手mask/LoRA SFT/DPO/optimizer+RNG续训worker，当前无ML依赖未验证实际权重。
- `training-transfer.mjs`：AES-GCM+scrypt私有workspace搬迁/旧水位拒绝，`executionPaths`重定位核对内容、逻辑planDigest不变；大基模型用独立持久缓存。
- `train-ready.mjs`统一入口，simulation/fixture永不成真实release。模型完成只candidate；默认插件/提示词/旧说明稿/chunks/动作授权无变化。


## v13.3.1 恢复与迭代接线

`training-local-worker.mjs`统一生产与仅断网fixture的品牌adapter，逐步ACK/租约/串行事件验证；`training-local-checkpoint.mjs`完整文件指纹、宿主HMAC见证、PID/start-token/异机退出边界、显式reconcile。Python worker不能独立开始监督梯度，token cache跨attempt复用，checkpoint带尝试/源/数据绑定。逻辑trainedStep与累计steps/墙钟/HTTP分开，回滚仅有恢复证据，默认旧插件不变。

`training-iteration.mjs`冻结有限计划空间/总预算/effect suite，宿主callback训练与认证观察、开发逐项符号/严格incumbent替换、持久一次性test与公共消费水位；未知不重试，闭合report认证cache。`training-iteration-demo.mjs`实际reference模型接线，原目标拒绝与工程goal通路分别保留，不伪称HF/LLM质量提升。
