# 文档总目录与阅读路线图

> 本索引**不写版本号、不写规模数**：当前版本与套件/模块/金标条数以 [`../README.md`](../README.md) 文首的水位块为准（由 `node tools/doc-watermark.mjs --record && --write` 生成，`npm run watermark:check` 核对）。
> 各篇文档标题里带的 `（vX.Y）` 是**该篇写作时的版本戳**，属于内容的一部分，不是本索引维护的字段。

为了让人类开发者与 AI 模型都能在 **1 分钟内**掌握全局并顺畅操作，本仓库把分散的设计稿、运行手册、审计报告与交接笔记按职责分层归档：核心文档讲"现在是怎么运作的"，专题文档讲"怎么操作"，`reports/` 与交接备忘是**当时当地**的读数快照（不回改，只追加）。

---

## 1. 核心文档一览（按阅读优先级排序）

| 文档路径 | 适用读者 | 核心内容 |
|---|---|---|
| [`../README.md`](../README.md) | 所有人（入口） | 30 秒极速上手、常用命令速查表、目录地图、生产工作流、当前实测基线，以及**文首水位块**（规模/自测读数的唯一来源） |
| [`../transfer/HANDOFF.md`](../transfer/HANDOFF.md) | 接手的新模型 / 开发者 | **一页交接卡**：环境恢复三步法、当前榜首策略与实测读数、省钱评测三档菜单、工程铁律 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 改代码的开发者 / 模型 | 生产插件与认知编译器（`src/` 模块 + `tools/` CLI）数据流、**六道收网门**、12 条核心不变式、「改哪里」指南、全量自检矩阵 |
| [`TRAINING-AND-BENCHMARK.md`](TRAINING-AND-BENCHMARK.md) | 训练与评测操作者 | **闭环、基准与 `<0.1B` 微模型训练指南**：三模式训练闭环（手写探顶→金标基准→影子分叉轨迹）、`<0.1B` 预训练双向编码器 + 紧凑学生出生压缩微模型完整训练流水线、规则×LLM 双轨裁判与五大国际官方基准 |
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
| [`EVIDENCE-PROGRAM.md`](EVIDENCE-PROGRAM.md) | 宿主显式类型化证据程序（`src/evidence-program.js` + `src/evidence-store.js`，默认关闭、opt-in）接口规范；可运行入口见该文档 §7（与 `package.json` 的 scripts 逐字对齐） |
| [`INSTALL.md`](INSTALL.md) | Cordis 插件注册机制、两层 patch 铁律、部署体检（`npm run onboard`）与故障排查 |
| [`HANDOFF-2026-10-06.md`](HANDOFF-2026-10-06.md) | **沙箱迁移交接备忘**：五分钟上手顺序、用户"宪法"、环境坑表、流程经验、量纲决策记录、待办与"别做"清单 |
| [`reports/CFB-MICRO-READINESS-2026-10-04.md`](reports/CFB-MICRO-READINESS-2026-10-04.md) | 2026-10-04 微模型就绪度快照（读数快照，不回改） |
| [`reports/CFB-MICRO-HANDOFF-2026-10-04.md`](reports/CFB-MICRO-HANDOFF-2026-10-04.md) | 同日微模型交接件：候选权重、闸门状态、下一步（读数快照，不回改） |
| [`proposals/`](proposals/) | 预注册策略补丁 JSON（`p1-multi-site.json`、`p-f6-bounded-path.json`、`p-regime-augment.json`，供闭环自测 `A21`/`A33` 与离线复现使用） |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 逐版本演进记录（最新在上）。**历史读数只在这里保留**：文档正文里的数字若与 CHANGELOG 冲突，以"正文=当前、CHANGELOG=当时"为准 |

## 3. 数据与证据目录

| 路径 | 说明 |
|---|---|
| [`../transfer/gold/`](../transfer/gold/) | 经真实多轮轨迹验证（`hand.fixed && (!raw.fixed \|\| hand.rounds < raw.rounds)`）的金标库；条数见 `../README.md` 文首水位块 |
| [`../transfer/gold-rejected/`](../transfer/gold-rejected/) | 被装置话术审计隔离的条目原文件（字节不变的历史副本）+ `audit.json` 台账 + `audit-amendments.json` 复算与放回记录 |
| [`../transfer/gold-repair/`](../transfer/gold-repair/) | 金标「改稿 → $0 离线重测 → 换稿」通道的工作区：`drafts-proposed/`（修订稿）、`drafts/`+`staged/`（过闸暂存）、`pending-retest.json`（等真机复测的账） |
| [`../transfer/gold-history/`](../transfer/gold-history/) | `gold add --replace` 换稿时被归档的旧条目（带 `supersededBy`） |
| [`../transfer/models/`](../transfer/models/) | 微模型产物与判决账本：`v5-micro-weights.json`（**生产权重，任何一轮都不得覆盖**）、`v5-micro-weights.candidate.json`（候选）、`cfb-micro-97m-report*.json`（闸门）、`cfb-micro-final-test-ledger.json`（**一次性盲测消耗记录，不许重跑**）、`micro-gap-map.json`（原型命中 vs 真实用户路径） |
| [`../transfer/watermark.json`](../transfer/watermark.json) | 文档水位的记账文件（结构计数 + 隔离内/联网两态自测读数）；由 `node tools/doc-watermark.mjs --record` 生成，`test/doc-watermark.selftest.mjs` 钉住 |
