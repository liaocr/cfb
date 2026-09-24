# docs/archive — 历史文档归档（只进不出）

2026-09-24 整理：把已被后续版本取代、或本身标注作废的材料**移动**到这里，
**不删除任何内容**。现行文档留在 `docs/` 顶层；版本时间线见根目录 [`CHANGELOG.md`](../../CHANGELOG.md)。

## 版本详报（按版本号）

| 文件 | 版本 | 一句话 |
|---|---|---|
| `OPTIMIZATION-REPORT.md` | 第一批 | 源码扫描与第一批优化 |
| `OPTIMIZATION-PHASE2.md` | 第二批 | 记忆可信度、身份隔离、安全停用 |
| `OPTIMIZATION-PHASE3.md` | 第三批 | 增量编译通道实验（`stateCompileQueue`） |
| `OPTIMIZATION-INTEGRATED.md` | v4 统一 | 范围回执、输入工作集、快照镜像、故障门禁 |
| `LATE-CLAIM-HARDENING.md` | v5 | 迟到记忆身份隔离、发射复检、容量约束 |
| `HYBRID-COMPILER.md` | v6 | 确定性证据记录＋两栏判断编译 |
| `GROUNDED-COMPILER-V7.md` | v7 | 恢复判断所需证据，验证认领到消费 |
| `EVIDENCE-SHARING-V8.md` | v8 | 共享重复证据展示，不减少核对材料 |
| `COMPILER-EFFICIENCY-V9.md` | v9 | 减少无效编译，拆清实际耗时 |
| `COMPRESS-MEMORY-SPLIT.md` | v10 | 压缩与状态记忆开关切分 |

## 简报 / 设计稿 / 状态卡

| 文件 | 性质 |
|---|---|
| `brief-cot-form-b-late-claim.md` | 迟到结果回收的对外简报 |
| `brief-cot-form-b-why-we-wait.md` | 「为什么硬等」的对外简报（含真机数字） |
| `phase2-settler-design.md` | 阶段二架构设计（v2 修订版，已被实现超越） |
| `phase2-go-live-runbook.md` | 阶段二上线手册 |
| `next-stage-spec.md` | 可逆上下文分层 v8 下一阶段规格 |
| `PROJECT-REPORT.md` | 早期项目大全（详细总结版） |
| `PRODUCTION-EVIDENCE-RECONCILIATION.md` | 真机材料交叉核验与使用边界 |
| `STATE.md` | ⛔ 已作废状态卡（2026-09-15 作废，留作「数长得像数据」反例） |

## 证据目录

`optimization-evidence/` 与 `optimization-evidence-v2/` … `-v9/`：
各批优化随附的 mutations / verification / benchmark 原始文件。
归档后内部相对路径未改；从仓库根引用时请带 `docs/archive/` 前缀。

---

> 规则：本目录**只追加、不回写、不删除**。若某份文档被证明仍有现行效力，
> 复制（或移回）到 `docs/` 顶层并在 CHANGELOG 记一笔，原件保留。
