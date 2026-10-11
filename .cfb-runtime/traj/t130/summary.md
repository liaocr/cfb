| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 9 | 67% | 4.8 | 5.9 | 11.7 | 1.2 | 0.0 | 83% | 11% | 100% | 15396 | 10522 | — |
| policy:base | 9 | 67% | 4.8 | 5.9 | 11.8 | 1.2 | 0.0 | 50% | 11% | 100% | 4049 | 8499 | 42% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 1 | ✗ | 6 | 10 | 0 | 0 | · | none | ● | 16007 |
| flaky-timeout | raw | 0 | ✗ | 6 | 9 | 0 | 0 | · | none | ● | 16671 |
| flaky-timeout | policy:base | 1 | ✗ | 6 | 10 | 0 | 0 | · | none | ● | 0 |
| flaky-timeout | policy:base | 0 | ✗ | 6 | 9 | 0 | 0 | · | none | ● | 0 |
| sse-truncated | raw | 0 | 4 | 6 | 10 | 1 | 0 | ● | none | ● | 16094 |
| sse-truncated | policy:base | 0 | 4 | 6 | 10 | 1 | 0 | ● | none | ● | 0 |
| sse-truncated | raw | 1 | 6 | 6 | 13 | 2 | 0 | · | none | ● | 16563 |
| sse-truncated | policy:base | 1 | 6 | 6 | 13 | 2 | 0 | · | none | ● | 0 |
| flaky-timeout | raw | 2 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 19107 |
| sse-truncated | raw | 2 | 5 | 6 | 10 | 3 | 0 | ● | none | ● | 19188 |
| sse-truncated | policy:base | 2 | 4 | 6 | 10 | 3 | 0 | ● | none | ● | 13975 |
| flaky-timeout | policy:base | 2 | ✗ | 6 | 14 | 0 | 0 | · | none | ● | 7171 |
| wrong-model | raw | 1 | 5 | 6 | 16 | 2 | 0 | ● | none | ● | 12748 |
| wrong-model | raw | 0 | 5 | 6 | 14 | 2 | 0 | ● | none | ● | 13836 |
| wrong-model | policy:base | 1 | 5 | 6 | 14 | 2 | 0 | · | none | ● | 7580 |
| wrong-model | raw | 2 | 4 | 5 | 11 | 1 | 0 | ● | fixed | ● | 8349 |
| wrong-model | policy:base | 2 | 4 | 5 | 11 | 1 | 0 | ● | fixed | ● | 0 |
| wrong-model | policy:base | 0 | 6 | 6 | 15 | 2 | 0 | · | none | ● | 7712 |

影子分叉：跟随臂 9 条，省下主调用 45 次；分歧轮 无,无,无,无,3,5,4,无,4；**未分歧 5 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：policy:base: 压过 12 轮，程序部件/原文 中位 0.26 最大 0.86，闸拒 invented-identifier×6、no-token-gain×1
