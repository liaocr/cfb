# 文档总目录与阅读路线图

> 本索引**不写版本号、不写规模数**：当前版本与套件/模块/金标条数以 [`../README.md`](../README.md) 文首的水位块为准；`node tools/doc-watermark.mjs --record` 会先实跑两条自测车道并记账/同步文档，已有回执只需同步文本时用 `node tools/doc-watermark.mjs --write`，`npm run watermark:check` 核对。
> 各篇文档标题里带的 `（vX.Y）` 是**该篇写作时的版本戳**，属于内容的一部分，不是本索引维护的字段。

为了让人类开发者与 AI 模型都能在 **1 分钟内**掌握全局并顺畅操作，本仓库把分散的设计稿、运行手册、审计报告与交接笔记按职责分层归档：核心文档讲"现在是怎么运作的"，专题文档讲"怎么操作"，`reports/` 与交接备忘是**当时当地**的读数快照（不回改，只追加）。

---

## 1. 核心文档一览（按阅读优先级排序）

| 文档路径 | 适用读者 | 核心内容 |
|---|---|---|
| [`../README.md`](../README.md) | 所有人（入口） | 30 秒极速上手、常用命令速查表、目录地图、生产工作流、当前实测基线，以及**文首水位块**（规模/自测读数的唯一来源） |
| [`../transfer/HANDOFF.md`](../transfer/HANDOFF.md) | 接手的新模型 / 开发者 | **一页交接卡**：环境恢复三步法、当前榜首策略与实测读数、省钱评测三档菜单、工程铁律 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 改代码的开发者 / 模型 | 生产插件与认知编译器（`src/` 模块 + `tools/` CLI）数据流、**六道收网门**、12 条核心不变式、「改哪里」指南、全量自检矩阵 |
| [`TRAINING-AND-BENCHMARK.md`](TRAINING-AND-BENCHMARK.md) | 训练/评测读者（历史指南） | **v14.20 训练闭环与本地代理基准设计快照**；其中外部 benchmark 名称仅为借鉴口径、旧数字不可当当前实测。当前基线见根 README §5，具体命令以当前 `package.json` 为准 |
| [`HISTORY-AND-EXPERIMENTS.md`](HISTORY-AND-EXPERIMENTS.md) | 审计者 / 研究者 | **历史实验与审计合一**：`birthMinChars=3100` 成本定律、关键里程碑、`effect-1..23` / `mr/run1..4` / `traj1..3` 实证结论、两制度分离定理与历史淘汰清单 |
| [`theory/CFB-THEORY-COMPLETE.md`](theory/CFB-THEORY-COMPLETE.md) | 理论研究者 | **认知编译器六卷完整理论**：T1–T7 信息论基础、价值函数 $v(i;\lambda)$ 与 $\lambda$ 控制器、疫苗记忆（REFUTED）与宿主协议（C0–C3） |
| [`GOLD-STANDARD.md`](GOLD-STANDARD.md) | 要给条目定级的人 / 模型 | **「什么算金标」的唯一权威判据**：`cfb.gold-standard/1` 十二轴定义、`--record`/`--replay` 复算入口、只降不升与 `stampDigest` 过期规则 |
| [`GOLD-WRITING-GUIDE.md`](GOLD-WRITING-GUIDE.md) | 要写金标稿的人 / 模型 | **金标撰写的标准流程与要求**：第 1 步就是读真机 transcript（跳步＝拿钱换猜测）→ 病根一句话 → 六段形状 → $0 复验 → 预置全部过地板轮 → 真机单元 → 反证一起登记；附归因到位三问、十条真机死法、提交前清单 |

---

## 2. 专题操作与计划

| 路径 | 说明 |
|---|---|
| [`GOLD-EXPANSION-PROGRAM.md`](GOLD-EXPANSION-PROGRAM.md) | 金标扩标方案：什么叫"够了"、$0 起草通道、盲写与一致率协议、不许改判据的铁律 |
| [`ROADMAP-GOLD.md`](ROADMAP-GOLD.md) | 后续路线（按依赖排序，每段带判据/成本/回退）——**计划文档**，里面的"待补"路径允许指向尚未创建的文件 |
| [`KAGGLE-MICRO-RUN.md`](KAGGLE-MICRO-RUN.md) | Kaggle 微模型训练可粘贴单元：克隆 → 训练 → 两次盲测 → 三组闸门判决，命令逐字可跑 |
| [`MICRO-GENERATOR-REFERENCE-REVIEW-2026-10-07.md`](MICRO-GENERATOR-REFERENCE-REVIEW-2026-10-07.md) | 用户提供的 9 个小模型/训练参考逐项审读、可迁移经验与数据/许可证/指标限制；不代表导入数据、模型或开始训练 |
| [`EVIDENCE-PROGRAM.md`](EVIDENCE-PROGRAM.md) | 宿主显式类型化证据程序（`src/evidence-program.js` + `src/evidence-store.js`，默认关闭、opt-in）设计/历史记录；当前可执行契约为 `node verify.mjs evidence-program`，文中已标出缺失的旧报告与旧命令 |
| [`INSTALL.md`](INSTALL.md) | Cordis 插件注册机制、两层 patch 铁律、部署体检（`npm run onboard`）与故障排查 |
| [`HANDOFF-2026-10-06.md`](HANDOFF-2026-10-06.md) | **沙箱迁移交接备忘**：五分钟上手顺序、用户"宪法"、环境坑表、流程经验、量纲决策记录、待办与"别做"清单 |
| [`STATUS-2026-10-07.md`](STATUS-2026-10-07.md) | **2026-10-07 全仓现状总结（只读快照，基于提交 `8c918cc`）**：保留当时的三线现状与问题清单；其中 P7/P8/P9/P16 等状态须对照后续审计报告，不能直接当当前事实 |
| [`AUDIT-REPORT-2026-10-07.md`](AUDIT-REPORT-2026-10-07.md) | 当前 checkout 深度审计与回归修复：命令实测、文档/代码矛盾、实验可复现性、已定决策与未决风险 |
| [`reports/CFB-MICRO-READINESS-2026-10-04.md`](reports/CFB-MICRO-READINESS-2026-10-04.md) | 2026-10-04 微模型就绪度快照（读数快照，不回改） |
| [`reports/CFB-MICRO-HANDOFF-2026-10-04.md`](reports/CFB-MICRO-HANDOFF-2026-10-04.md) | 同日微模型交接件：候选权重、闸门状态、下一步（读数快照，不回改） |
| [`proposals/`](proposals/) | 预注册策略补丁 JSON（`p1-multi-site.json`、`p-f6-bounded-path.json`、`p-regime-augment.json`，供闭环自测 `A21`/`A33` 与离线复现使用） |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 逐版本演进记录（最新在上）。CHANGELOG 是提交时记录，不自动代表当前；正文只有在带有明确来源/日期且经现场命令复核后才视为当前。若证据新鲜度不明，以最新审计报告与可运行命令输出为准 |

## 3. 数据与证据目录

| 路径 | 说明 |
|---|---|
| [`../transfer/gold/`](../transfer/gold/) | 经真实多轮轨迹验证（`hand.fixed && (!raw.fixed \|\| hand.rounds < raw.rounds)`）的金标库；条数见 `../README.md` 文首水位块 |
| [`../transfer/gold-rejected/`](../transfer/gold-rejected/) | 被装置话术审计隔离的条目原文件（字节不变的历史副本）+ `audit.json` 台账 + `audit-amendments.json` 复算与放回记录 |
| [`../transfer/gold-repair/`](../transfer/gold-repair/) | 金标「改稿 → $0 离线重测 → 换稿」通道的工作区：`drafts-proposed/`（修订稿）、`drafts/`+`staged/`（过闸暂存）、`pending-retest.json`（等真机复测的账） |
| [`../transfer/gold-history/`](../transfer/gold-history/) | `gold add --replace` 换稿时被归档的旧条目（带 `supersededBy`） |
| [`../transfer/models/`](../transfer/models/) | 微模型产物与判决账本：`v5-micro-weights.json`（**生产权重，任何一轮都不得覆盖**）、`v5-micro-weights.candidate.json`（候选）、`cfb-micro-97m-report*.json`（闸门）、`cfb-micro-final-test-ledger.json`（**一次性盲测消耗记录，不许重跑**）、`micro-gap-map.json`（原型命中 vs 真实用户路径） |
| [`../transfer/probes-2026-10-07/`](../transfer/probes-2026-10-07/) | 通用压缩器历史探针资产：92 篇对打与标注金标；脚本含绝对路径、随机对照未固定种子，当前 checkout 未复现，详情见资产 README；仅作历史证据，不作当前晋级依据 |
| [`../transfer/watermark.json`](../transfer/watermark.json) | 文档水位的记账文件（结构计数 + 隔离内/联网两态自测读数）；由 `node tools/doc-watermark.mjs --record` 生成，`test/doc-watermark.selftest.mjs` 钉住 |
