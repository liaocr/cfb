# 架构（v11.11，开发者视角）

> 面向改代码的人：模块怎么分、数据怎么流、哪些不变式不能碰、加东西该改哪里。
> 使用与配置见根目录 [`README.md`](../README.md)；设计沿革见 [`CHANGELOG.md`](../CHANGELOG.md) 与 [`archive/`](archive/README.md)。

## 1. 模块地图

包入口 `index.js` 只做导出；宿主拿到 `name` / `inject` / `apply`，其余导出供自测与离线工具使用
（`package.json` 的 `exports` 只开放 `.`，深层路径对外不可导入，内部文件可以自由搬迁）。

依赖从上往下，**无环**：

```
plugin.js ─────────────────────────────────────────────── 组合根：apply() 注册钩子、接线（v11.11 只剩接线）
  ├─ boot-record.js       BOOT 行内容
  ├─ host-follow.js       调用级模型 / provider（共享 cfg 不变）
  ├─ session-tracker.js   流归属（交错 ⇒ 不可证）
  ├─ handle-probe.js      句柄读回探针
  ├─ birth-claim.js ───── 下轮收网（实验）→ emitter.js, late-memory.js
  ├─ checkpoint.js ────── checkpoint 模式 → distill.js, emitter.js
  ├─ birth.js ─────────── 出生即压缩（生产路径）
  │    ├─ late-memory.js    迟到结果暂存区（实验）
  │    ├─ evidence.js       会话证据采集（memory 模式）
  │    ├─ snapshot-store.js 结构化快照持久化
  │    ├─ fidelity.js       逐字标识符召回率
  │    └─ trace.js          settled 字段白名单
  ├─ distill.js ───────── 副模型调用（重试降级 / 对冲 / 传输 trace / memory 编译 / makeBirthCompiler 工厂）
  │    ├─ prompts.js ─ config.js
  │    ├─ transport.js ─ provider.js ─ config.js
  │    └─ evidence-ledger.js ─ evidence-input.js, evidence-storage.js
  ├─ emitter.js ───────── pre-step 看板发射器（迟到认领 / checkpoint）
  │    └─ balanced-span.js, headroom.js, imperative.js
  ├─ messages.js         出站消息溯源（只观测）
  ├─ consumption.js      认领消费计量
  └─ exact-flights.js    相同在途请求精确共享（memory 模式）
state-memory.js          纯函数底座（信封 / 编译提示词 / 解析 / 投影 / 渲染 / 来源判定），被多数模块引用
```

规模：最大的是 `state-memory.js`（约 1757 行，纯函数）、`birth.js`（约 859 行）。
（行数只是量级提示，以 `wc -l src/*.js` 为准。）

v11.11 起 `plugin.js` 只做接线（约 190 行）：`boot-record.js`（BOOT 内容）、`host-follow.js`（调用级模型/provider）、
`session-tracker.js`（流归属）、`birth-claim.js`（下轮收网）、`checkpoint.js`（checkpoint 模式）、`handle-probe.js`（句柄读回探针）。

横切小模块（v11.10）：`tokens.js`（token 粗估，被 birth 引用）、`fs-lock.js`（独占锁 + 死锁接管，被
`snapshot-store` / `evidence-ledger` / `evidence-storage` 引用）。

## 2. 钩子与数据流

`apply(ctx, config)`（`plugin.js`，v11.11 起只做接线）先 `normalizeConfig`，写一行 `BOOT`（内容在 `boot-record.js`），然后注册：

| 钩子 | 做什么 |
|---|---|
| `agent/pre-step` | 捕获当前会话（`session-tracker.js`，供归档登记与证据采集）；`birth + birthDeferredClaim:true` 时尝试认领暂存区里的迟到结果（`birth-claim.js`）；`checkpoint` 模式发射看板（`checkpoint.js`） |
| `llm/stream`（`prepend`） | 只读观测：消费计量、宿主模型/provider 跟随（`host-follow.js` 派生**本次调用专属**配置）、`llm-stream` 溯源 trace；判定流归属（交错 ⇒ 不可证）；`birth` 模式用 `birthTransform` 包装主流；`checkpoint` 模式在 reasoning 结束时 early-fire |

任何观测或内部异常都被 `try/catch` 吞成 trace；**主流自己的错误原样抛出**。拿到的流不是 async iterable 就原样返回、绝不包装。

### 2.1 birth：一个 reasoning 块的一生（`birth.js`）

```
birthTransform(inner, deps)
  block-start(reasoning) → birthHoldNew + 立即透传
  reasoning-delta        → 累积 + 实时透传（live）
  block-end(reasoning)   → birthStart(entry, deps)   ← 同步返回 task，绝不 await
                              belowFloor 判定：dryRun / disabled / 短于 birthMinChars / archive-off / no-store
                              handle   = deriveArtHandle(sessionId, raw)（与 CMB store 同一公式，内存秒算）
                              diskP    = deps.archive(raw)          （CAS 写盘，birthArchiveTimeoutMs 护栏）
                              distillP = deps.distill(input, signal, budget)
                                         budget = { onHeaders, trace, taskId, scope, preparedJudgment }
  finish                 → birthFinish(task, deps)   ← 押后到最后
                              readyOnly（仅 deferredClaim）⇒ 不等待，只取已就绪结果
                              否则等 min(finishWaitMs, 真工期)；到点但已收到 200 响应头 ⇒ 再宽限 finishHeadersGraceMs（一次）
                              结局：condensed | below-floor/dry-run/… | archive-failed(-early)/archive-timeout |
                                    distill-failed(-early)/distill-timeout | empty-candidate | no-gain |
                                    background-judgment-pending/judgment-failed（readyOnly）
```

`deps.distill` 由 `distill.js` 的 `makeBirthCompiler(streamCfg, { flights })` 按编译模式三选一构造（v11.10 前是 `plugin.js` 里的内联三元，无法单测）：

| 编译模式 | distill 闭包 | runtime（传输观测） |
|---|---|---|
| `memory` | `generateStateMemory(env, cfg, signal, { ...budget, flights })` | trace + scope + 精确在途共享 |
| `compress` | 按 `compressPromptVersion` 选提示词 → `generateDistillation(raw, cfg, signal, prompt, …)` | 只透传 trace（无 scope，共享永不命中；不改取消语义） |
| `legacy` | `generateDistillation(raw, cfg, signal)`（旧蒸馏提示词） | 只透传 trace |

### 2.2 副模型调用（`distill.js`）

`generateDistillation`：解析端点与钥匙（跟随宿主 provider，解析不出来就抛错、上层原文放行）→
每轮先带「关思考」试，被 4xx 参数拒绝再裸试 → `hedgedDistill`（`hedgeAfterMs>0` 且 `maxAttempts≤1` 才对冲）→
`distillOnce` / `distillOnceStream`（同输入同输出形状）→ 每次请求落 `compiler-transport-started/settled`。

对冲纪律：只有 **200** 响应头才算胜出；同一时刻至多 1 份对冲在飞；主请求已结算（成功或失败）后计时器不再发对冲，
主请求失败时立即按主错误结算。

### 2.3 迟到认领（实验，`late-memory.js` + `emitter.js`）

仅 `birthDeferredClaim: true`：birthFinish 没等到的结果在后台成功后 `pushLateMemory`（进程内，按会话+分支隔离，容量/TTL 有界）；
下一轮 pre-step 由 `runPreStepEmit` 选平衡区间、要求**全覆盖**（本消息每个推理块都有就绪结果且逐字拼回原文），
先 `peek`，只有发射成功才 `acknowledge`。已知缺陷 B（多块匹配）见 `AUDIT-V11.5.md` §四。

## 3. 持久化位置

全部在 `$DSH_HOME/storages/cot-form-b/`（`$DSH_HOME` 缺省 `~/.dsh`，解析规则见 `config.js` 的 `dshHome`）：

| 路径 | 写入者 | 何时 |
|---|---|---|
| `trace.log`（+ `trace.log.1`） | `trace.js` | `trace: true` 时每个事件一行；超过 `traceMaxBytes`（64 MiB）轮转一次 |
| `snapshots/` | `snapshot-store.js` | memory 模式编译成功（且 `stateSnapshot !== false`） |
| `evidence-v1/` | `evidence-storage.js` | memory 模式的确定性证据账本 |

CAS（原文归档）不在这里：它是宿主注入的 `cmbStore` 服务（`ctx.get('cmbStore')`），本插件只调用 `putText`。

## 4. 不变式（违反即坏）

1. **H2 首次出站不变律**：一个块只能在「还没出站」时被替换。birth 在装配前改写，天然满足；
   事后改写 `assistant/message` 被宿主 `surface.js:207` 永久禁止（这也是 distill/rules 模式退役的原因）。
2. **归档先于压缩**：拿不到 CAS 句柄就绝不替换原文。
3. **观测不碰主流**：信封构造、过滤、快照读写、trace 写入等任何失败都只降级为「原文全量」或「丢一条证据」，绝不抛给宿主。
4. **不猜**：模型名、端点、钥匙都跟随宿主；解析不出来就不发起，绝不回落到写死的值。
5. **时间截面冻结**：证据信封在 block-end 那一刻固定（`adaptEvidence` 冻结对象），之后不补入后来才发生的事实。
6. **字符 ≠ 钱**：trace 里的字符数只描述上下文余量，不得当作费用节省汇报。
7. **评估态零副作用**（v11.9）：`dryRun` 下不写 CAS、不改表面。组装先出计划
   （`buildLedger({planOnly:true})`，占位句柄与真机同长），净收益/stale/评估三道闸门全跑在**任何一次写入之前**。
8. **地址必须可读回**（v11.9）：`art://` 句柄只在「有正面证据能按句柄取回」时才允许进模型可见文本。
   emitter 发射前抽样验证（`verifyHandles`，正面证伪 ⇒ 拒发保持原文）；birth 的内存预推句柄须先验证，
   不可证即按归档失败处理（原文放行）。
9. **放弃即取消**（v11.10）：凡是决定「这块用原文」的路径（finish 到点、硬停、源流无 finish、源流抛错、消费者提前退出），
   都经由唯一实现 `birthCancelFlying` 取消仍在飞的提纯；迟到认领打开时尊重它（消费者提前退出除外 —— 块从未出站，不可能被认领）。
10. **token 不降不替换**（v11.10）：字符净省达标但估算 token 不降 ⇒ 原文放行（`no-token-gain`）。估算只用于**拒绝**，不用于宣称节省。
11. **锁只在可证明时接管**（v11.10）：`fs-lock.js` 只接管「同机且 pid 已不存在」的锁；任何不可证的情况照旧 fail-closed，永不按年龄抢锁。
12. **共享配置不可变**（v11.11）：`apply()` 里归一化出的 `cfg` 在运行期永不改写；随调用变化的量（宿主模型、provider）
   由 `host-follow.js` 派生到调用级副本里。凡是「稍后才读配置」的地方（early-fire、预热）都必须拿调用级副本。
13. **流归属不可证不归档**（v11.11）：多个会话交错进入 pre-step 时，这条流属于谁无法证明 ⇒ 缺省原文放行，
   不写 CAS、不采集证据（挂错会话的归档与跨会话证据泄漏都比少压一块更糟）。

## 5. 改哪里

| 想做的事 | 要改的地方 |
|---|---|
| 加一个配置键 | `config.js` 的 `DEFAULTS`（写清来历）；若允许嵌套写法，加进 `NESTED_*_KEYS`；`index.d.ts`；`core.selftest.mjs` §10 |
| 退役一个配置键 | 从 `DEFAULTS` 删除，加进 `RETIRED_OPTIONS`（配置里出现时进 `retiredOptions` 并被删除，BOOT 可见） |
| 给 `birth-distill-settled` / `compiler-transport-settled` 加字段 | `trace.js` 的 `settledTraceData` 白名单（只写进 meta 不会落盘，出过真实事故） |
| 改提示词 | `prompts.js`；版本号必须从 `compressPromptVersion` 同一次裁决里取 |
| 加一个模块 | 放进 `src/` 即可；`DEP_ID` 自动枚举，BOOT 会带上它 |
| 加一个测试套件 | `test/<名字>.selftest.mjs`，末尾打印 `PASS=n FAIL=m`；把名字加进 `verify.mjs` 的 `ORDER`（不加也会被自动纳入，但会提示）。套件会**并发**运行，不得依赖其他套件的副作用；特别慢的套件加进 `SLOW_FIRST` |
| 改了任何文件 | `npm run manifest` 重新生成清单（CI 会 `--check`） |
| 在钩子里需要「随调用变化」的配置 | 用 `host.callConfig(options)` 的返回值，**不要**改写共享 `cfg`（不变式 12） |
| 需要知道这条流属于哪个会话 | `sessions.forStream()`；`ambiguous` 为真时不得归档或采集证据（不变式 13） |
| 测试里需要写盘 | 不用管隔离：`verify.mjs` 已为每个套件设临时 `DSH_HOME`；单独运行时请自己设 |

## 6. 测试布局

`verify.mjs` 并发运行（缺省 `max(6, CPU 数)`，`--serial` / `-j N` 可调；慢套件先起跑），结果按 `ORDER` 顺序打印（纯函数层 → 核心 → birth → 持久化/证据 → 集成与观测 → 钩子级端到端）。每个套件独立进程、独立临时 `DSH_HOME`：

| 套件 | 覆盖 |
|---|---|
| balanced-span / headroom / imperative / emitter | 看板发射器的纯函数层 |
| state-memory | 信封、编译提示词、解析、投影、渲染、来源判定 |
| provider-endpoint | 端点解析 |
| core | 配置归一化、提示词、传输层、副模型调用、迟到暂存、回归钉子 |
| birth | birth 主路径（含真实 dsh-llm 不变式校验，找不到宿主安装时用替身并 WARN）、句柄可归因（T34） |
| optimization / memory-quality / snapshot-invariants | 快照与记忆质量、覆盖不变式 |
| robustness | 失败语义、CAS 读取与恢复、退役开关不生效、传输层错误形态、trace 审计器、句柄读回探针契约 |
| checkpoint-hooks | **钩子级端到端**（真实 HTTP + 真实钩子入口）：early-fire → pre-step 收网 → 合规 replace；工具配对平衡、活跃尾部、评估态零副作用、句柄读回闭环、拒发语义 |
| hook-wiring | 只剩出错才会走到的接线：服务获取抛错、坏形状不包装、CAS 写入抛错、**主流抛错原样抛出** |
| late-identity / hybrid / grounding / evidence-sharing / efficiency / coverage-provenance | 迟到认领身份、确定性账本、证据共享、效率观测、覆盖与来源 |
| hedge | 对冲与响应头宽限（本机 HTTP 可控延迟） |
| concurrency | v11.11：调用级配置（共享 cfg 不变）、checkpoint early-fire 用自己那次调用的模型（v11.10 复现失败）、流归属交错检测与处置 |
| protocol | v11.11：OpenAI Responses 端点（非流式 / 流式 / 协议错配 / 完成判据 / 降级重试）、token 估算校准链路 |
| branches | v11.11：跨窗口结构性证据、索引失败回退、覆盖判据四形态、预热（节流 / 停用 / 调用级 provider）、消费计量 |
| hardening | v11.10：取消泄漏四条路径、配置登记/退役/显式化、token 估算与闸门、死锁接管（三处锁）、trace 轮转、provider 缓存、编译器工厂（真实 HTTP）、analyze-trace 的 birth 等待依据 |
