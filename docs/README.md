# 文档索引（v13）

v12.0 是一次「干净的开始」：删掉已否决路线的代码与历史归档，文档按用途分三层。
v12.1 再收一步：**只剩一条路径**（birth + compress，缺省 v3），实验模式与参考原型全部删除，删除清单见 §5。
v12.2 把理论第五卷的 v4 规格落成生产代码：`compressPrompt: 'v4'`（`src/compile-v4.js`，opt-in），说明见根目录 README「compress-v4-ops」。
**被删的东西都在 git 里**：v12.0 删的用 `git show cfba57b:<路径>`；v12.1 删的用 `git show <v12.0 提交>:<路径>`（`git log --oneline` 里标题以 `v12.0.0` 开头的那条）。

## 1. 现行（使用 / 部署 / 改代码 / 操作）

| 文件 | 读者 | 内容 |
|---|---|---|
| [`../README.md`](../README.md) | 使用者 | 做什么、快速开始、模式与配置、回滚开关、观测、当前状态 |
| [`EVIDENCE-PROGRAM.md`](EVIDENCE-PROGRAM.md) | 接口/宿主接入者 | v13 完整设计、预注册、类型化制品/检查/档案/联合恢复、权衡与启用/回退 |
| [`analysis/EVIDENCE-VALIDATION-2026-09-30.md`](analysis/EVIDENCE-VALIDATION-2026-09-30.md) | 验收者 | 零调用工程自测、历史回放数字、预测与证据边界 |
| [`analysis/LOCAL-ITERATIONS-2026-09-30.md`](analysis/LOCAL-ITERATIONS-2026-09-30.md) | 两轮验收者 | 原生真实IO强基线、冻结诊断/路由四臂、断网实测与范围边界 |
| [`analysis/REPAIR-HARDENING-2026-09-30.md`](analysis/REPAIR-HARDENING-2026-09-30.md) | 增量验收者 | 安全取消、按重试需要停止诊断、固定已知开发回归，不复用盲测 |
| [`analysis/BOUNDED-API-2026-09-30.md`](analysis/BOUNDED-API-2026-09-30.md) | API评测/验收者 | USD2/13次冻结预算、响应型号/指纹/canary、崩溃不重发；当前缺配置blocked |
| [`analysis/LIVE-REASONING-REPLAY-2026-10-02.md`](analysis/LIVE-REASONING-REPLAY-2026-10-02.md) | API评测/验收者 | **现行**：v8 reasoning 回放协议首次真实运行——探针逐字回显证拼接、两臂仅 reasoning 不同、结论「不劣但未证更优」；含 `--v8` 静默降级缺陷与回归 |
| [`RUNBOOK-ONLINE-READY.md`](RUNBOOK-ONLINE-READY.md) | 后续接网/搬机器操作者 | prepare/doctor/live/report、公开水位与私有仓、加密迁移与自动检查点、故障处理 |
| [`analysis/OFFLINE-READY-2026-09-30.md`](analysis/OFFLINE-READY-2026-09-30.md) | 架构/验收者 | 离线优先预注册、跨轮预算保护、整链本机HTTP演练与未证事项 |
| [`RUNBOOK-TRAINING-READY.md`](RUNBOOK-TRAINING-READY.md) | 后续训练操作者 | SFT/偏好数据、审核/族隔离、LoRA/远程任务、新训练批准、候选发布与加密搬迁 |
| [`analysis/TRAINING-READY-2026-09-30.md`](analysis/TRAINING-READY-2026-09-30.md) | 训练架构/验收者 | 训练预注册、真实参考模型梯度、远程替身/缓存/搬迁与LoRA未证事项 |
| [`analysis/TRAINING-ITERATION-2026-10-01.md`](analysis/TRAINING-ITERATION-2026-10-01.md) | 恢复/迭代验收者 | worker ACK/完整见证与累计预算，有限候选独立评测/一次性test；真实HF未证 |
| [`design/CLOSED-LOOP-V3.md`](design/CLOSED-LOOP-V3.md) | 迭代/实验设计者、下一个模型 | **现行**：闭环 v3——任务池与留出闸门、A/A 校准、提示词策略生成层（LLM 提议器三闸）、铸造协议、偏好对飞轮；对 v2 七条批评的逐条回应 |
| [`design/CLOSED-LOOP-V2.md`](design/CLOSED-LOOP-V2.md) | 迭代/实验设计者、下一个模型 | v2 基座（v3 的判定 / 计划 / 命令全部在它之上）：闭环 v2「按比特买证据」——生产等价候选、任务真值维、序贯配对（运行特性表）、v9 预注册、`plan → live → ingest → propose`、放弃清单、怎么加杠杆 |
| [`design/CONTINUOUS-TRAINING-ARCHITECTURE.md`](design/CONTINUOUS-TRAINING-ARCHITECTURE.md) | 迭代/训练设计者 | v14.0 持续训练架构（判断层维度定义仍有效）；环路部分已被 v14.2 更正与替换，顶部有更正块 |
| [`design/OFFLINE-ARCHITECTURE.md`](design/OFFLINE-ARCHITECTURE.md) | 迭代/实验设计者 | 离线层分层（语料/判据/候选/标注/驱动）、生产漏斗 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 改代码的人 | 模块地图、钩子与数据流、持久化位置、不变式、「改哪里」、测试布局 |
| [`INSTALL.md`](INSTALL.md) | 部署的人 | 注册机制、两层 patch 形态铁律、改完源码如何生效、排错 |
| [`RUNBOOK-PHASE0.md`](RUNBOOK-PHASE0.md) | 操作的人（零基础） | 阶段 0 纯观测的逐步操作手册（与 x1 无关，仍有效） |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 所有人 | 版本沿革（最新在上；旧条目按当时事实保留） |

## 2. 理论（下一步做什么的依据）

| 文件 | 内容 |
|---|---|
| [`theory/CFB-THEORY-COMPLETE.md`](theory/CFB-THEORY-COMPLETE.md) | 完整理论（原六卷合订 + 附录）：认知编译器与 T1–T7、优化方向全景、交互与前沿、价值函数 v(i;λ) 与 λ 控制器、未决问题与 v4 规格、疫苗记忆与宿主协议（C0–C3）；附录 A 为 v4a/v4b 评审，附录 B 为参考实现 `value.js` / `value-demo.mjs` 的**唯一留存**（v12.1 已从仓库删除；其 I2 判定已并入主路径的发明标识符闸） |

## 3. 分析（历史审计与调研，每篇开头有「v12.0 / v12.1 状态」说明）

| 文件 | 现在还有什么用 |
|---|---|
| [`analysis/AUDIT-V11.5.md`](analysis/AUDIT-V11.5.md) | `birthMinChars` 3100 的来历（§一）、保真观测（§六）；源码注释引用（§四迟到认领缺陷随功能删除失效） |
| [`analysis/ECONOMICS-V11.11.md`](analysis/ECONOMICS-V11.11.md) | 现行成本模型（「别亏本」约束）；取代 AUDIT-V11.5 的成本部分 |
| [`analysis/AUDIT-2026-09-27.md`](analysis/AUDIT-2026-09-27.md) | F1–F11 缺陷与回归钉（F7 随 x1 删除） |
| [`analysis/DECISION-2026-09-27.md`](analysis/DECISION-2026-09-27.md) | **x1 主干部分已作废**；阶段 0 观测部分仍有效 |
| [`analysis/RESEARCH-COT-SHAPING.md`](analysis/RESEARCH-COT-SHAPING.md) | 前三轮文献调研（§10 的 x1 实现已删） |
| [`analysis/RESEARCH-PERFORMANCE.md`](analysis/RESEARCH-PERFORMANCE.md) | 第四轮调研；P5/P6 观测与评测仍在用 |
| [`analysis/V4-LIVE-2026-09-28.md`](analysis/V4-LIVE-2026-09-28.md) | v4 真机记录（第 1–6 轮：超时、增量、8 s 窗口、防劫持） |
| [`analysis/EFFECT-EVAL-2026-09-28.md`](analysis/EFFECT-EVAL-2026-09-28.md) | **效果评测**：压缩稿 vs 原文 vs 无思考，主模型下一步质量；READY 的来历 |

## 4. v12.0 删除清单（均可从 `cfba57b` 取回）

| 路径 | 为什么删 |
|---|---|
| `src/extractive.js`、`test/extractive.selftest.mjs`、`tools/acon-optimize.mjs` | compress-x1 抽取式路线：实测句子保留率 80–92%，路线否决；缺省本就关闭。旧配置里的 `extractive*` 键进 `retiredOptions`，`compressPrompt: 'x1'` 自动回落 `v2`（BOOT 的 `configAdjusted` 可见） |
| `docs/archive/`（55 个文件） | v1–v10 版本详报、设计稿、简报、作废状态卡、原始证据；描述的开关与行号均已不是现状，现行代码与文档不依赖它们 |
| `docs/CORRECTNESS-V11.md` | 留在顶层只因 archive 里有文件链接它；archive 删除后理由消失；CHANGELOG v11 条目保留一句摘要，详版用 git 取回 |
| `fidelity.hasProtected`、`snapshot-store.parseSnapshotJson` / `snapshotStoreInfo` | 死代码：导出但全仓库无调用 |

## 5. v12.1 删除清单（均可从 v12.0 提交取回）

原则：先问「为什么留着」，有真实优点的先并入主路径（birth + compress）再删；确定无用的直接删。

| 删除项 | 为什么曾经留着 | 并入主路径的部分 | 为什么可以删 |
|---|---|---|---|
| checkpoint 模式：`src/checkpoint.js`、`emitter.js`、`balanced-span.js`、`headroom.js`、`imperative.js`；`test/checkpoint-hooks`、`emitter`、`balanced-span`、`headroom`、`imperative` | 块已出站后再在 pre-step 用看板替换（绕过 H2 的另一条路） | 水位读数 → `birth.readPressure`；祈使句检测**不并入**（v3 规则 5 已禁止写指令，且拦截会误伤引用原文的句子） | 已冻结、缺省关；与 birth 双路并存让取消语义、句柄验证、测试都翻倍 |
| 迟到认领：`src/birth-claim.js`、`late-memory.js`；`birthDeferredClaim` 等键；`test/late-identity` | birth 等不到的结果留给下一轮再用 | 无（`birthCancelFlying` 改为无条件取消） | 已知缺陷 B（多块匹配）未修；依赖 emitter 看板通道；与「放弃即取消」冲突（须留在飞请求） |
| memory 模式 / 状态记忆：`src/state-memory.js`、`evidence*.js`、`snapshot-store.js`、`fs-lock.js`、`exact-flights.js`、`consumption.js`；`stateMemory` 等键；`test/state-memory`、`memory-quality`、`snapshot-invariants`、`evidence-sharing`、`grounding`、`hybrid`、`coverage-provenance`、`optimization`、`efficiency` | 把推理编译成结构化状态快照 + 证据账本 | 发明标识符判据的思路（证据必须有出处）经 value.js I2 落为 `fidelity.inventedIdentifiers`；`stateMemory:true` 自动转 compress（`configAdjusted` 可见） | 约 3,200 行，缺省关；主路径不依赖；带锁、带盘上状态，是最大的维护面 |
| legacy v1 提示词（「三栏结算单」） | 老配置兼容 | 无 | v4a 评审已确认它是被批评问题的根源；`compressPrompt:'v1'` 自动回落 v3 |
| `tools/benchmark-index.mjs`、`replay.mjs`、`analyze-consumption.mjs` | 离线基准 / 回放 / 认领消费统计 | trace 行解析搬进 `analyze-efficiency.mjs` | 依赖已删模块 |
| `src/value.js`、`tools/value-demo.mjs` | v4 编译器纯函数原型 | **I2：摘要标识符必须逐字出现在原文** → `birthIdentifierGate`（缺省开）+ `invented-identifier` 放行 | 从未接入 birth；源码完整留存在理论全集附录 B |
| 零散回收（测试） | —— | onboard 漂移检测、传输终止闸、`retryDelayMs` 退避、4MiB 上限、`inputAmplificationRatio` → `test/compress.selftest.mjs` | 原所在套件整体删除 |

