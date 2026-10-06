| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 1 | 0% | — | 4.0 | 6.0 | 0.0 | 0.0 | — | 0% | 100% | 9729 | 18244 | — |
| policy:p-1490eefcdf | 1 | 0% | — | 4.0 | 7.0 | 0.0 | 0.0 | — | 0% | 100% | 2846 | 3948 | 100% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 0 | ✗ | 4 | 6 | 0 | 0 | · | none | ● | 9729 |
| flaky-timeout | policy:p-1490eefcdf | 0 | ✗ | 4 | 7 | 0 | 0 | · | none | ● | 2846 |

影子分叉：跟随臂 1 条，省下主调用 3 次；分歧轮 3；**未分歧 0 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

等待手写稿 3 条：wrong-model:decoy/hand #0 第 5 轮（.cfb-runtime/traj/t114/pending/wrong-model_decoy-s0-r5.json）；sse-truncated:decoy/hand #0 第 3 轮（.cfb-runtime/traj/t114/pending/sse-truncated_decoy-s0-r3.json）；eacces-config:decoy/hand #0 第 5 轮（.cfb-runtime/traj/t114/pending/eacces-config_decoy-s0-r5.json）

压稿预算（F6）：hand: 压过 0 轮；policy:p-1490eefcdf: 压过 2 轮，程序部件/原文 中位 0.04 最大 0.24
