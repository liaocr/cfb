# 文档入口：现行契约与历史记录分开

只把下列入口当成当前状态，不让数百份历史 Markdown 各自宣布“唯一主线”。

## 当前必须先读

| 文件 | 用途 |
|---|---|
| [PROJECT.json](../PROJECT.json) | 机器可检查的目标、唯一路线、未就绪状态与证据路径 |
| [AGENTS.md](../AGENTS.md) | 接手者的证据/授权/预算纪律 |
| [根 README](../README.md) | 安全命令、技术水位和保障边界 |
| [PROJECT-PLAN.md](PROJECT-PLAN.md) | 任务/真实读回 → 参考稿效用 → 新尺子/覆盖监督 → 能力/CPU → 诊断SFT的唯一顺序 |
| [CONTINUATION-PROGRAM-2026-10-12.md](CONTINUATION-PROGRAM-2026-10-12.md) | 用户要求全面推进后实际实现、开发产物、验证及未完成边界 |
| [COVERAGE-AND-COLLECTION.md](COVERAGE-AND-COLLECTION.md) | 数据能力空白、下一批合法真实目标来源与采集预算 |
| [AUDIT-2026-10-11.md](AUDIT-2026-10-11.md) | 本轮实做修复、证据、回归、范围和剩余问题 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 兼容插件、生成式学生和证据平面；哪些尚未实现 |
| [HANDOFF.md](../transfer/HANDOFF.md) | 下一位接手者的一页卡 |

## 证据入口

- [参考稿优先 programme](../transfer/program-2026-10-12/)：source registry、完整AI开发审查、显式标签校准/fixture观测、blocked reader计划与正式拒绝回执；不是准入corpus/VALID尺子。

- [前阶段审计证据目录](../transfer/audit-2026-10-11/)：修复前普通/隔离日志、原清单/旧入口、冻结 v9 独立重放、固定模型元数据、缺失恢复 ledger、范围和覆盖。
- [FILE-INDEX.json](../transfer/audit-2026-10-11/FILE-INDEX.json)：基线全路径与有效角色；分类不是逐条内容质量盖章。
- [HISTORICAL-INDEX.md](HISTORICAL-INDEX.md)：基线所有非当前权威 Markdown 的路径、原标题与类型，不删改历史正文。
- [data-v9](../data-v9/) 与 [PREREG-v9](../transfer/route-2026-10-11/PREREG-v9.md)：不可修改的历史实验，结论 INVALID。
- [dataset-policy](../tools/micro-generator/dataset-policy.json)：target compatibility、来源 span、AI 单审与 family split 的既有约束；旧建议混料不能绕过。
- [精确找回历史资产](../transfer/archive-2026-10-11/recovered/)：只作归档，不自动进入数据发现/训练。

## 如何读过去记录

`HISTORY-AND-EXPERIMENTS`、理论总稿、旧审计、V10 根因、SFT/LoRA/Qwen/Kaggle 手册、gold 写作与旧冠军等仍保留，均需先确认其时间、代码版本、数据与测量范围。

- 文件名含“生成式”不证明教师或实现是语言模型。
- 本地假仓库 scorecard 不等于国际官方基准实测。
- 旧测试、伪造夹具、当时摘要与真正来源要分开。
- `gold/lint/ceiling/pass` 不能替代完整事实审查和原目标模型读回。
- `CFB-STATE-2026-10-11.md` 的旧更正引用没有在本轮两个固定树里找到；不编造缺文，不拿它当现行入口。
- 旧恢复/付费/盲测命令不属于本轮授权，不能为了让文档“可执行”直接开跑。

历史原文不再承担当前数字维护；技术水位来自事务式实跑，完整性清单另按完整/稀疏范围记账。
