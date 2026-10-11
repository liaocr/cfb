| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 9 | 67% | 4.8 | 5.9 | 11.7 | 1.2 | 0.0 | 83% | 11% | 100% | 15396 | 10522 | — |
| hand | 9 | 56% | 4.4 | 6.0 | 11.4 | 0.9 | 0.0 | 100% | 0% | 100% | 10333 | 9782 | 64% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 0 | ✗ | 6 | 10 | 0 | 0 | · | none | ● | 16007 |
| flaky-timeout | raw | 1 | ✗ | 6 | 9 | 0 | 0 | · | none | ● | 16671 |
| flaky-timeout | raw | 2 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 19107 |
| sse-truncated | raw | 0 | 4 | 6 | 10 | 1 | 0 | ● | none | ● | 16094 |
| sse-truncated | raw | 1 | 6 | 6 | 13 | 2 | 0 | · | none | ● | 16563 |
| sse-truncated | raw | 2 | 5 | 6 | 10 | 3 | 0 | ● | none | ● | 19188 |
| wrong-model | raw | 0 | 5 | 6 | 16 | 2 | 0 | ● | none | ● | 12748 |
| wrong-model | raw | 1 | 5 | 6 | 14 | 2 | 0 | ● | none | ● | 13836 |
| wrong-model | raw | 2 | 4 | 5 | 11 | 1 | 0 | ● | fixed | ● | 8349 |
| flaky-timeout | hand | 0 | ✗ | 6 | 8 | 0 | 0 | · | none | ● | 17215 |
| flaky-timeout | hand | 1 | ✗ | 6 | 10 | 0 | 0 | · | none | ● | 9063 |
| flaky-timeout | hand | 2 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 13199 |
| sse-truncated | hand | 0 | 4 | 6 | 10 | 1 | 0 | ● | none | ● | 8363 |
| sse-truncated | hand | 1 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 10973 |
| sse-truncated | hand | 2 | 4 | 6 | 8 | 2 | 0 | ● | none | ● | 12126 |
| wrong-model | hand | 0 | 5 | 6 | 16 | 2 | 0 | ● | none | ● | 6871 |
| wrong-model | hand | 1 | 5 | 6 | 14 | 2 | 0 | ● | none | ● | 8228 |
| wrong-model | hand | 2 | 4 | 6 | 13 | 1 | 0 | ● | none | ● | 6957 |

影子分叉：跟随臂 9 条，省下主调用 34 次；分歧轮 3,4,4,4,4,3,4,4,4；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 9 轮，程序部件/原文 中位 0.35 最大 0.65
