# 文档总目录与阅读路线图（v14.18）

为了让人类开发者与 AI 模型都能在 **1 分钟内**掌握全局并顺畅操作，本仓库将原先分散的 38 篇设计稿、运行手册、审计报告与交接笔记整合为 **6 篇核心文档**，按职责严格分层、零重复、零过期指令。

---

## 1. 核心文档一览（按阅读优先级排序）

| 文档路径 | 适用读者 | 核心内容 |
|---|---|---|
| [`../README.md`](../README.md) | 所有人（入口） | 30 秒极速上手、常用命令速查表、目录地图、生产工作流与当前官方基准总表 |
| [`../transfer/HANDOFF.md`](../transfer/HANDOFF.md) | 接手的新模型 / 开发者 | **一页交接卡**：环境恢复三步法、当前最优策略（`p-e62a037097`）、省钱评测三档菜单与工程铁律 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 改代码的开发者 / 模型 | 生产插件与认知编译器（`src/` 22 模块 + `tools/` CLI）数据流、12 条核心不变式、「改哪里」指南与 31 套自检矩阵 |
| [`TRAINING-AND-BENCHMARK.md`](TRAINING-AND-BENCHMARK.md) | 训练与评测操作者 | **闭环、基准与 `<0.1B` 微模型训练指南**：三模式训练闭环（手写探顶→金标基准→影子分叉轨迹）、`<0.1B` 预训练双向编码器 + 紧凑学生出生压缩微模型完整训练流水线、规则×LLM 双轨裁判与五大国际官方基准 |
| [`HISTORY-AND-EXPERIMENTS.md`](HISTORY-AND-EXPERIMENTS.md) | 审计者 / 研究者 | **历史实验与审计合一**：`birthMinChars=3100` 成本定律、`v11.5–v14.18` 关键里程碑、`effect-1..23` / `mr/run1..4` / `traj1..3` 实证结论、两制度分离定理与历史淘汰清单 |
| [`theory/CFB-THEORY-COMPLETE.md`](theory/CFB-THEORY-COMPLETE.md) | 理论研究者 | **认知编译器六卷完整理论**：T1–T7 信息论基础、价值函数 $v(i;\lambda)$ 与 $\lambda$ 控制器、疫苗记忆（REFUTED）与宿主协议（C0–C3） |

---

## 2. 专题参考与数据目录

| 路径 | 说明 |
|---|---|
| [`EVIDENCE-PROGRAM.md`](EVIDENCE-PROGRAM.md) | 宿主显式类型化证据程序（`src/evidence-program.js` + `src/evidence-store.js`，默认关闭、opt-in）接口规范 |
| [`INSTALL.md`](INSTALL.md) | Cordis 插件注册机制、两层 patch 铁律、部署体检（`npm run onboard`）与故障排查 |
| [`proposals/`](proposals/) | 预注册策略补丁 JSON（`p1-multi-site.json`、`p-f6-bounded-path.json`、`p-regime-augment.json`，供闭环自测 `A21`/`A33` 与离线复现使用） |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 逐版本演进记录（最新在上） |
| [`../transfer/gold/`](../transfer/gold/) | 经真实多轮轨迹验证（`hand.fixed && (!raw.fixed || hand.rounds < raw.rounds)`）的金标库 |
