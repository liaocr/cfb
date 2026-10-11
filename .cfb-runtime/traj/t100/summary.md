| 变体 | n | 修好 | 到修好的轮数 | 总轮数 | 工具调用 | edit 次数 | 重复命令 | 修好后验收 | 最终声明 fixed | 声明相称 | prompt tokens 合计 | 上下文 reasoning 字数 | 压稿成功 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 60% | 5.2 | 7.7 | 16.3 | 1.3 | 0.6 | 100% | 40% | 100% | 23291 | 10308 | — |

逐条：

| 任务 | 变体 | # | 修好@轮 | 轮 | 调用 | edit | 重复 | 验收 | 声明 | 相称 | tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | raw | 0 | 7 | 8 | 20 | 1 | 1 | ● | none | ● | 26357 |
| eacces-config | raw | 1 | 7 | 8 | 26 | 1 | 5 | ● | fixed | ● | 34719 |
| sse-truncated | raw | 0 | 5 | 8 | 11 | 3 | 0 | ● | none | ● | 27182 |
| sse-truncated | raw | 1 | 4 | 8 | 11 | 3 | 0 | ● | fixed | ● | 26585 |
| perf-regression | raw | 0 | ✗ | 8 | 23 | 0 | 0 | · | none | ● | 16350 |
| perf-regression | raw | 1 | ✗ | 8 | 16 | 0 | 0 | · | none | ● | 15908 |
| flaky-timeout | raw | 1 | ✗ | 8 | 16 | 1 | 0 | · | none | ● | 26237 |
| wrong-model | raw | 0 | 4 | 7 | 12 | 2 | 0 | ● | fixed | ● | 15836 |
| flaky-timeout | raw | 0 | ✗ | 8 | 17 | 1 | 0 | · | none | ● | 30278 |
| wrong-model | raw | 1 | 4 | 6 | 11 | 1 | 0 | ● | fixed | ● | 13453 |

等待手写稿 10 条：eacces-config/hand #0 第 5 轮（.cfb-runtime/traj/t100/pending/eacces-config-s0-r5.json）；eacces-config/hand #1 第 5 轮（.cfb-runtime/traj/t100/pending/eacces-config-s1-r5.json）；sse-truncated/hand #0 第 4 轮（.cfb-runtime/traj/t100/pending/sse-truncated-s0-r4.json）；sse-truncated/hand #1 第 3 轮（.cfb-runtime/traj/t100/pending/sse-truncated-s1-r3.json）；perf-regression/hand #0 第 7 轮（.cfb-runtime/traj/t100/pending/perf-regression-s0-r7.json）；perf-regression/hand #1 第 7 轮（.cfb-runtime/traj/t100/pending/perf-regression-s1-r7.json）；flaky-timeout/hand #1 第 5 轮（.cfb-runtime/traj/t100/pending/flaky-timeout-s1-r5.json）；wrong-model/hand #0 第 4 轮（.cfb-runtime/traj/t100/pending/wrong-model-s0-r4.json）；flaky-timeout/hand #0 第 4 轮（.cfb-runtime/traj/t100/pending/flaky-timeout-s0-r4.json）；wrong-model/hand #1 第 4 轮（.cfb-runtime/traj/t100/pending/wrong-model-s1-r4.json）

压稿预算（F6）：hand: 压过 0 轮
