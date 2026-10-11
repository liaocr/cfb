| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 12 | 100% | 4.7 | 6.0 | 12.2 | 1.4 | 0.2 | 83% | 8% | 100% | 14240 | 5021 | — |
| hand | 12 | 83% | 4.7 | 6.0 | 12.8 | 1.6 | 0.0 | 80% | 8% | 100% | 8319 | 4109 | 80% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sse-truncated | raw | 1 | 4 | 6 | 12 | 1 | 0 | ● | none | ● | 14540 |
| sse-truncated | hand | 1 | ✗ | 6 | 12 | 0 | 0 | · | none | ● | 10777 |
| sse-truncated | raw | 0 | 6 | 6 | 14 | 1 | 0 | · | none | ● | 15547 |
| sse-truncated | hand | 0 | 6 | 6 | 15 | 2 | 0 | · | none | ● | 4653 |
| sse-truncated | raw | 2 | 5 | 6 | 13 | 1 | 0 | ● | none | ● | 17383 |
| sse-truncated | hand | 2 | 4 | 6 | 13 | 2 | 0 | ● | none | ● | 12699 |
| sse-truncated | raw | 3 | 5 | 6 | 9 | 3 | 0 | · | none | ● | 16033 |
| sse-truncated | hand | 3 | 5 | 6 | 10 | 2 | 0 | ● | none | ● | 8700 |
| sse-truncated | raw | 4 | 5 | 6 | 12 | 1 | 0 | ● | none | ● | 14010 |
| sse-truncated | hand | 4 | ✗ | 6 | 13 | 0 | 0 | · | none | ● | 7355 |
| sse-truncated | raw | 5 | 4 | 6 | 10 | 2 | 0 | ● | none | ● | 15319 |
| sse-truncated | hand | 5 | 4 | 6 | 13 | 4 | 0 | ● | none | ● | 10646 |
| wrong-model | raw | 0 | 5 | 6 | 12 | 1 | 0 | ● | none | ● | 12549 |
| wrong-model | hand | 0 | 5 | 6 | 13 | 1 | 0 | ● | none | ● | 7176 |
| wrong-model | raw | 2 | 4 | 6 | 13 | 1 | 0 | ● | fixed | ● | 12504 |
| wrong-model | hand | 2 | 4 | 6 | 13 | 1 | 0 | ● | fixed | ● | 7547 |
| wrong-model | raw | 3 | 4 | 6 | 9 | 2 | 0 | ● | none | ● | 15746 |
| wrong-model | hand | 3 | 4 | 6 | 9 | 2 | 0 | ● | none | ● | 11055 |
| wrong-model | raw | 4 | 5 | 6 | 13 | 1 | 2 | ● | none | ● | 10468 |
| wrong-model | hand | 4 | 6 | 6 | 11 | 1 | 0 | · | none | ● | 7883 |
| wrong-model | raw | 5 | 4 | 6 | 14 | 2 | 0 | ● | none | ● | 15334 |
| wrong-model | hand | 5 | 4 | 6 | 15 | 3 | 0 | ● | none | ● | 7608 |
| wrong-model | raw | 1 | 5 | 6 | 15 | 1 | 0 | ● | none | ● | 11452 |
| wrong-model | hand | 1 | 5 | 6 | 16 | 1 | 0 | ● | none | ● | 3725 |

影子分叉：跟随臂 12 条，省下主调用 46 次；分歧轮 3,5,3,4,4,3,4,4,3,4,4,5；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 13 轮，程序部件/原文 中位 0.54 最大 1.79，闸拒 no-gain×1
