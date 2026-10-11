| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 1 | 0% | — | 5.0 | 9.0 | 0.0 | 0.0 | — | 0% | 100% | 14391 | 14716 | — |
| policy:base | 1 | 0% | — | 5.0 | 9.0 | 0.0 | 0.0 | — | 0% | 100% | 0 | 14716 | 0% |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 0 | ✗ | 5 | 9 | 0 | 0 | · | none | ● | 14391 |
| flaky-timeout | policy:base | 0 | ✗ | 5 | 9 | 0 | 0 | · | none | ● | 0 |

影子分叉：跟随臂 1 条，省下主调用 5 次；分歧轮 无；**未分歧 1 条（压缩器整条没触发 ⇒ 与 raw 结局相同，按平手计、不是证据）**

等待手写稿 3 条：wrong-model:decoy/hand #0 第 5 轮（.cfb-runtime/traj/t126/pending/wrong-model_decoy-s0-r5.json）；eacces-config:decoy/hand #0 第 5 轮（.cfb-runtime/traj/t126/pending/eacces-config_decoy-s0-r5.json）；sse-truncated:decoy/hand #0 第 6 轮（.cfb-runtime/traj/t126/pending/sse-truncated_decoy-s0-r6.json）

压稿预算（F6）：hand: 压过 0 轮；policy:base: 压过 1 轮，程序部件/原文 中位 0.07 最大 0.07，闸拒 distill-failed×1
