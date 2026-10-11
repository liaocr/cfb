| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 60% | 5.3 | 6.0 | 13.1 | 0.8 | 0.3 | 50% | 0% | 100% | 14823 | 8182 | — |
| hand | 10 | 40% | 5.3 | 6.0 | 13.6 | 0.5 | 0.3 | 75% | 10% | 100% | 6973 | 8196 | 44% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | raw | 1 | ✗ | 6 | 15 | 0 | 0 | · | none | ● | 10351 |
| eacces-config | hand | 1 | ✗ | 6 | 15 | 0 | 0 | · | none | ● | 0 |
| eacces-config | raw | 0 | 6 | 6 | 14 | 1 | 0 | · | none | ● | 14517 |
| eacces-config | hand | 0 | 6 | 6 | 15 | 1 | 0 | ● | none | ● | 4839 |
| flaky-timeout | raw | 1 | ✗ | 6 | 11 | 0 | 0 | · | none | ● | 23765 |
| flaky-timeout | hand | 1 | ✗ | 6 | 11 | 0 | 0 | · | none | ● | 12694 |
| flaky-timeout | raw | 0 | 6 | 6 | 11 | 1 | 0 | · | none | ● | 21145 |
| flaky-timeout | hand | 0 | ✗ | 6 | 16 | 0 | 0 | · | none | ● | 14034 |
| perf-regression | raw | 1 | ✗ | 6 | 16 | 0 | 1 | · | none | ● | 8021 |
| perf-regression | hand | 1 | ✗ | 6 | 16 | 0 | 1 | · | none | ● | 0 |
| perf-regression | raw | 0 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 8884 |
| perf-regression | hand | 0 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 2806 |
| wrong-model | raw | 1 | 6 | 6 | 14 | 1 | 2 | · | none | ● | 12276 |
| wrong-model | hand | 1 | ✗ | 6 | 15 | 0 | 2 | · | none | ● | 4262 |
| wrong-model | raw | 0 | 4 | 6 | 14 | 2 | 0 | ● | none | ● | 15280 |
| wrong-model | hand | 0 | 4 | 6 | 13 | 1 | 0 | ● | fixed | ● | 8387 |
| sse-truncated | raw | 0 | 5 | 6 | 14 | 2 | 0 | ● | none | ● | 16283 |
| sse-truncated | hand | 0 | 5 | 6 | 15 | 2 | 0 | ● | none | ● | 9369 |
| sse-truncated | raw | 1 | 5 | 6 | 10 | 1 | 0 | ● | none | ● | 17709 |
| sse-truncated | hand | 1 | 6 | 6 | 8 | 1 | 0 | · | none | ● | 13336 |

影子分叉：跟随臂 10 条，省下主调用 44 次；分歧轮 无,5,3,3,无,5,5,4,4,3；**未分歧 2 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 10 轮，程序部件/原文 中位 0.31 最大 0.97，闸拒 invented-identifier×2
