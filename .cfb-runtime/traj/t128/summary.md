| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 50% | 5.0 | 6.0 | 11.7 | 1.1 | 0.0 | 20% | 0% | 100% | 14515 | 9374 | — |
| policy:base | 10 | 60% | 5.0 | 6.0 | 11.8 | 1.2 | 0.0 | 33% | 0% | 100% | 1736 | 5823 | 43% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | raw | 0 | ✗ | 6 | 17 | 0 | 0 | · | none | ● | 10594 |
| eacces-config | policy:base | 0 | ✗ | 6 | 17 | 0 | 0 | · | none | ● | 0 |
| eacces-config | raw | 1 | 6 | 6 | 12 | 1 | 0 | · | none | ● | 15883 |
| eacces-config | policy:base | 1 | 6 | 6 | 12 | 1 | 0 | · | none | ● | 0 |
| flaky-timeout | raw | 0 | ✗ | 6 | 8 | 0 | 0 | · | none | ● | 14177 |
| flaky-timeout | policy:base | 0 | ✗ | 6 | 8 | 0 | 0 | · | none | ● | 0 |
| flaky-timeout | raw | 1 | ✗ | 6 | 11 | 0 | 0 | · | none | ● | 28293 |
| perf-regression | raw | 0 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 9703 |
| perf-regression | policy:base | 0 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 0 |
| perf-regression | raw | 1 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 8217 |
| perf-regression | policy:base | 1 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 0 |
| wrong-model | raw | 0 | 5 | 6 | 15 | 2 | 0 | · | none | ● | 10702 |
| wrong-model | policy:base | 0 | 5 | 6 | 15 | 2 | 0 | · | none | ● | 0 |
| flaky-timeout | policy:base | 1 | 5 | 6 | 12 | 1 | 0 | ● | none | ● | 17356 |
| wrong-model | raw | 1 | 5 | 6 | 10 | 2 | 0 | · | none | ● | 11949 |
| wrong-model | policy:base | 1 | 5 | 6 | 10 | 2 | 0 | · | none | ● | 0 |
| sse-truncated | raw | 0 | 4 | 6 | 10 | 4 | 0 | · | none | ● | 18701 |
| sse-truncated | raw | 1 | 5 | 6 | 10 | 2 | 0 | ● | none | ● | 16930 |
| sse-truncated | policy:base | 1 | 5 | 6 | 10 | 2 | 0 | ● | none | ● | 0 |
| sse-truncated | policy:base | 0 | 4 | 6 | 10 | 4 | 0 | · | none | ● | 0 |

影子分叉：跟随臂 10 条，省下主调用 57 次；分歧轮 无,无,无,无,无,无,3,无,无,无；**未分歧 9 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：policy:base: 压过 7 轮，程序部件/原文 中位 0.31 最大 0.63，闸拒 distill-failed×3、no-token-gain×1
