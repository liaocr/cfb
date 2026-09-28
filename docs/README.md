# 文档索引（v12.0）

v12.0 是一次「干净的开始」：删掉已否决路线的代码与历史归档，文档按用途分三层。
**被删的东西都在 git 里**：`git show cfba57b:<路径>` 看单个文件，`git checkout cfba57b -- docs/archive` 整目录取回。

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
| [`theory/CFB-THEORY-COMPLETE.md`](theory/CFB-THEORY-COMPLETE.md) | 完整理论（原六卷合订 + 附录）：认知编译器与 T1–T7、优化方向全景、交互与前沿、价值函数 v(i;λ) 与 λ 控制器、未决问题与 v4 规格、疫苗记忆与宿主协议（C0–C3）；附录 A 为 v4a/v4b 评审，附录 B 为参考实现源码。参考实现本体：[`../src/value.js`](../src/value.js)、[`../tools/value-demo.mjs`](../tools/value-demo.mjs)，自测 `test/v12.selftest.mjs` |

## 3. 分析（历史审计与调研，每篇开头有「v12.0 状态」说明）

| 文件 | 现在还有什么用 |
|---|---|
| [`analysis/AUDIT-V11.5.md`](analysis/AUDIT-V11.5.md) | `birthMinChars` 3100 的来历（§一）、迟到认领缺陷 B（§四）；源码注释引用 |
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
