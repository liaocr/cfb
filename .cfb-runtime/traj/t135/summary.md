| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 12 | 100% | 4.3 | 6.0 | 11.2 | 1.9 | 0.4 | 92% | 0% | 100% | 16217 | 4779 | — |
| hand | 12 | 100% | 4.3 | 6.0 | 11.5 | 2.0 | 0.4 | 92% | 0% | 100% | 10170 | 3212 | 92% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sse-truncated | raw | 0 | 4 | 6 | 9 | 2 | 0 | ● | none | ● | 18168 |
| sse-truncated | hand | 0 | 4 | 6 | 10 | 3 | 0 | ● | none | ● | 13679 |
| sse-truncated | raw | 1 | 4 | 6 | 10 | 2 | 0 | · | none | ● | 19000 |
| sse-truncated | hand | 1 | 4 | 6 | 9 | 1 | 0 | ● | none | ● | 8632 |
| sse-truncated | raw | 2 | 4 | 6 | 7 | 2 | 0 | ● | none | ● | 14914 |
| sse-truncated | hand | 2 | 4 | 6 | 8 | 1 | 0 | ● | none | ● | 8422 |
| sse-truncated | raw | 3 | 4 | 6 | 10 | 2 | 0 | ● | none | ● | 17692 |
| sse-truncated | hand | 3 | 4 | 6 | 8 | 2 | 0 | ● | none | ● | 10902 |
| sse-truncated | raw | 4 | 3 | 6 | 9 | 2 | 0 | ● | none | ● | 19596 |
| sse-truncated | hand | 4 | 3 | 6 | 13 | 2 | 0 | ● | none | ● | 13999 |
| sse-truncated | raw | 5 | 4 | 6 | 11 | 3 | 0 | ● | none | ● | 15941 |
| sse-truncated | hand | 5 | 4 | 6 | 13 | 4 | 0 | ● | none | ● | 12141 |
| wrong-model | raw | 0 | 4 | 6 | 9 | 2 | 0 | ● | none | ● | 15380 |
| wrong-model | hand | 0 | 5 | 6 | 9 | 2 | 0 | ● | none | ● | 11075 |
| wrong-model | raw | 2 | 5 | 6 | 19 | 2 | 5 | ● | none | ● | 17062 |
| wrong-model | hand | 2 | 5 | 6 | 19 | 2 | 5 | ● | none | ● | 10233 |
| wrong-model | raw | 1 | 4 | 6 | 8 | 2 | 0 | ● | none | ● | 12875 |
| wrong-model | hand | 1 | 4 | 6 | 8 | 1 | 0 | ● | none | ● | 7164 |
| wrong-model | raw | 4 | 5 | 6 | 21 | 1 | 0 | ● | none | ● | 17902 |
| wrong-model | hand | 4 | 5 | 6 | 20 | 1 | 0 | ● | none | ● | 11031 |
| wrong-model | raw | 5 | 5 | 6 | 9 | 1 | 0 | ● | none | ● | 13281 |
| wrong-model | hand | 5 | 5 | 6 | 10 | 2 | 0 | ● | none | ● | 6819 |
| wrong-model | raw | 3 | 5 | 6 | 12 | 2 | 0 | ● | none | ● | 12796 |
| wrong-model | hand | 3 | 5 | 6 | 11 | 3 | 0 | · | none | ● | 7942 |

影子分叉：跟随臂 12 条，省下主调用 43 次；分歧轮 3,4,4,3,3,3,3,4,4,4,4,4；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

压稿预算（F6）：hand: 压过 12 轮，程序部件/原文 中位 0.42 最大 0.87
