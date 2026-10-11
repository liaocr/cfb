| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 80% | 6.1 | 8.0 | 14.3 | 1.8 | 0.1 | 63% | 20% | 100% | 29014 | 9091 | — |
| hand | 10 | 70% | 6.3 | 7.5 | 13.6 | 1.2 | 0.0 | 71% | 20% | 100% | 15673 | 8588 | 70% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config:decoy | raw | 0 | 7 | 8 | 16 | 1 | 0 | ● | none | ● | 22261 |
| eacces-config:decoy | hand | 0 | ✗ | 8 | 19 | 0 | 0 | · | none | ● | 9492 |
| eacces-config:long-horizon | raw | 0 | 6 | 8 | 14 | 2 | 0 | ● | fixed | ● | 33383 |
| flaky-timeout | raw | 0 | ✗ | 8 | 12 | 2 | 0 | · | none | ● | 34257 |
| flaky-timeout:long-horizon | raw | 0 | ✗ | 8 | 15 | 1 | 0 | · | none | ● | 35405 |
| flaky-timeout:long-horizon | hand | 0 | ✗ | 6 | 9 | 0 | 0 | · | none | ● | 9082 |
| perf-regression | raw | 0 | 8 | 8 | 16 | 1 | 0 | · | none | ● | 14655 |
| perf-regression | hand | 0 | ✗ | 8 | 16 | 0 | 0 | · | none | ● | 3370 |
| sse-truncated | raw | 0 | 4 | 8 | 15 | 5 | 0 | ● | none | ● | 38646 |
| flaky-timeout | hand | 0 | 7 | 8 | 14 | 1 | 0 | ● | none | ● | 19836 |
| sse-truncated:decoy | raw | 0 | 8 | 8 | 14 | 1 | 0 | · | none | ● | 25518 |
| sse-truncated:decoy | hand | 0 | 7 | 8 | 11 | 2 | 0 | · | none | ● | 15880 |
| sse-truncated:long-horizon | raw | 0 | 7 | 8 | 18 | 1 | 0 | · | none | ● | 30118 |
| wrong-model:decoy | raw | 0 | 4 | 8 | 12 | 3 | 1 | ● | none | ● | 27124 |
| wrong-model:decoy | hand | 0 | 4 | 6 | 7 | 1 | 0 | ● | fixed | ● | 8609 |
| wrong-model:long-horizon | raw | 0 | 5 | 8 | 11 | 1 | 0 | ● | fixed | ● | 28775 |
| sse-truncated:long-horizon | hand | 0 | 8 | 8 | 20 | 2 | 0 | · | none | ● | 19096 |
| eacces-config:long-horizon | hand | 0 | 6 | 8 | 14 | 1 | 0 | ● | none | ● | 19824 |
| sse-truncated | hand | 0 | 7 | 8 | 17 | 4 | 0 | ● | none | ● | 37244 |
| wrong-model:long-horizon | hand | 0 | 5 | 7 | 9 | 1 | 0 | ● | fixed | ● | 14296 |

影子分叉：跟随臂 10 条，省下主调用 46 次；分歧轮 6,4,7,3,5,4,5,5,3,4；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 18 轮，程序部件/原文 中位 0.4 最大 0.69，闸拒 invented-identifier×2
