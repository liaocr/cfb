| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 60% | 5.8 | 8.0 | 16.8 | 1.5 | 0.2 | 100% | 20% | 100% | 27036 | 13158 | — |
| hand | 10 | 60% | 6.0 | 8.0 | 16.3 | 1.4 | 0.2 | 83% | 20% | 100% | 17520 | 12723 | 59% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | raw | 1 | 7 | 8 | 18 | 1 | 0 | ● | none | ● | 24291 |
| eacces-config | hand | 1 | 8 | 8 | 17 | 1 | 0 | · | none | ● | 12066 |
| eacces-config | raw | 0 | 7 | 8 | 17 | 2 | 0 | ● | none | ● | 23330 |
| eacces-config | hand | 0 | ✗ | 8 | 20 | 0 | 1 | · | none | ● | 10015 |
| flaky-timeout | raw | 1 | ✗ | 8 | 16 | 1 | 0 | · | none | ● | 41589 |
| flaky-timeout | hand | 1 | ✗ | 8 | 18 | 1 | 0 | · | none | ● | 27984 |
| perf-regression | raw | 0 | ✗ | 8 | 16 | 0 | 0 | · | none | ● | 15487 |
| perf-regression | hand | 0 | ✗ | 8 | 16 | 0 | 0 | · | none | ● | 3865 |
| flaky-timeout | raw | 0 | ✗ | 8 | 17 | 0 | 0 | · | none | ● | 43077 |
| flaky-timeout | hand | 0 | ✗ | 8 | 15 | 0 | 0 | · | none | ● | 47033 |
| perf-regression | raw | 1 | ✗ | 8 | 21 | 0 | 1 | · | none | ● | 15186 |
| perf-regression | hand | 1 | 8 | 8 | 21 | 1 | 0 | ● | none | ● | 4208 |
| sse-truncated | raw | 0 | 4 | 8 | 17 | 4 | 0 | ● | none | ● | 32978 |
| sse-truncated | hand | 0 | 4 | 8 | 15 | 4 | 0 | ● | none | ● | 24758 |
| sse-truncated | raw | 1 | 5 | 8 | 13 | 4 | 0 | ● | fixed | ● | 34495 |
| sse-truncated | hand | 1 | 4 | 8 | 12 | 4 | 0 | ● | none | ● | 24115 |
| wrong-model | raw | 0 | 6 | 8 | 12 | 2 | 0 | ● | fixed | ● | 18540 |
| wrong-model | hand | 0 | 6 | 8 | 10 | 2 | 0 | ● | fixed | ● | 8007 |
| wrong-model | raw | 1 | 6 | 8 | 21 | 1 | 1 | ● | none | ● | 21383 |
| wrong-model | hand | 1 | 6 | 8 | 19 | 1 | 1 | ● | fixed | ● | 13145 |

影子分叉：跟随臂 10 条，省下主调用 50 次；分歧轮 5,6,4,7,3,7,4,3,6,5；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 10 轮，程序部件/原文 中位 0.37 最大 0.68
