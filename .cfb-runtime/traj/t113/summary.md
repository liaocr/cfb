| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 1 | 0% | — | 4.0 | 8.0 | 0.0 | 0.0 | — | 0% | 100% | 8476 | 14196 | — |
| policy:p-1490eefcdf | 1 | 0% | — | 4.0 | 8.0 | 0.0 | 0.0 | — | 0% | 100% | 2662 | 3303 | 100% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 0 | ✗ | 4 | 8 | 0 | 0 | · | none | ● | 8476 |
| flaky-timeout | policy:p-1490eefcdf | 0 | ✗ | 4 | 8 | 0 | 0 | · | none | ● | 2662 |

影子分叉：跟随臂 1 条，省下主调用 3 次；分歧轮 3；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

等待手写稿 2 条：perf-regression:long-horizon/hand #0 第 5 轮（.cfb-runtime/traj/t113/pending/perf-regression_long-horizon-s0-r5.json）；flaky-timeout:long-horizon/hand #0 第 4 轮（.cfb-runtime/traj/t113/pending/flaky-timeout_long-horizon-s0-r4.json）

压稿预算（F6）：hand: 压过 0 轮；policy:p-1490eefcdf: 压过 2 轮，程序部件/原文 中位 0.06 最大 0.17
