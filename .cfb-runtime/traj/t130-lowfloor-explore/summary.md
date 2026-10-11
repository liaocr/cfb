| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 50% | 5.8 | 6.0 | 12.1 | 0.9 | 0.1 | 20% | 0% | 100% | 13372 | 6565 | — |
| hand | 1 | 0% | — | 6.0 | 7.0 | 0.0 | 0.0 | — | 0% | 100% | 0 | 540 | 0% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | raw | 1 | 6 | 6 | 11 | 2 | 0 | · | none | ● | 14010 |
| eacces-config | raw | 0 | ✗ | 6 | 16 | 0 | 1 | · | none | ● | 13452 |
| flaky-timeout | raw | 1 | ✗ | 6 | 13 | 0 | 0 | · | none | ● | 13800 |
| perf-regression | raw | 0 | ✗ | 6 | 7 | 0 | 0 | · | none | ● | 6695 |
| perf-regression | hand | 0 | ✗ | 6 | 7 | 0 | 0 | · | none | ● | 0 |
| perf-regression | raw | 1 | ✗ | 6 | 10 | 0 | 0 | · | none | ● | 9539 |
| flaky-timeout | raw | 0 | ✗ | 6 | 12 | 1 | 0 | · | none | ● | 25674 |
| wrong-model | raw | 1 | 5 | 6 | 16 | 2 | 0 | ● | none | ● | 10220 |
| wrong-model | raw | 0 | 6 | 6 | 11 | 1 | 0 | · | none | ● | 12577 |
| sse-truncated | raw | 0 | 6 | 6 | 17 | 1 | 0 | · | none | ● | 12372 |
| sse-truncated | raw | 1 | 6 | 6 | 8 | 2 | 0 | · | none | ● | 15385 |

影子分叉：跟随臂 1 条，省下主调用 6 次；分歧轮 无；**未分歧 1 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

等待手写稿 9 条：eacces-config/hand #1 第 3 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/eacces-config-s1-r3.json）；eacces-config/hand #0 第 3 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/eacces-config-s0-r3.json）；flaky-timeout/hand #1 第 4 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/flaky-timeout-s1-r4.json）；perf-regression/hand #1 第 4 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/perf-regression-s1-r4.json）；flaky-timeout/hand #0 第 3 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/flaky-timeout-s0-r3.json）；wrong-model/hand #1 第 4 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/wrong-model-s1-r4.json）；wrong-model/hand #0 第 5 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/wrong-model-s0-r5.json）；sse-truncated/hand #0 第 5 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/sse-truncated-s0-r5.json）；sse-truncated/hand #1 第 4 轮（.cfb-runtime/traj/t130-lowfloor-explore/pending/sse-truncated-s1-r4.json）

压稿预算（F6）：hand: 压过 0 轮
