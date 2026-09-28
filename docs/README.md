# 文档索引（v12.2）

v12.0 是一次「干净的开始」：删掉已否决路线的代码与历史归档，文档按用途分三层。
v12.1 再收一步：**只剩一条路径**（birth + compress，缺省 v3），实验模式与参考原型全部删除，删除清单见 §5。
v12.2 把理论第五卷的 v4 规格落成生产代码：`compressPrompt: 'v4'`（`src/compile-v4.js`，opt-in），说明见根目录 README「compress-v4-ops」。
**被删的东西都在 git 里**：v12.0 删的用 `git show cfba57b:<路径>`；v12.1 删的用 `git show <v12.0 提交>:<路径>`（`git log --oneline` 里标题以 `v12.0.0` 开头的那条）。

## 1. 现行（使用 / 部署 / 改代码 / 操作）

| 文件 | 读者 | 内容 |
|---|---|---|
| [`../README.md`](../README.md) | 使用者 | 做什么、快速开始、模式与配置、回滚开关、观测、当前状态 |
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

