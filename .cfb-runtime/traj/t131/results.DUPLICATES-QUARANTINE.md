# t131 results.jsonl 重复行隔离清单（2026-10-11，$0）

原文件 `results.jsonl` 未改动。以下 9 组 hand 行同一 task|variant|sample 出现多次，且时间戳相同（同一秒写入），结局不一致。无法确定哪一行为准，因此全部隔离，不做去重。

| 组 | 行号 | at | fixedAtRound | rounds | mainCalls | promptTokens | completionTokens |
|---|---|---|---|---|---|---|---|
| flaky-timeout|hand|0 | 10 | 2026-10-11T11:31:23.356Z | null | 3 | — | 0 | 0 |
| flaky-timeout|hand|0 | 26 | 2026-10-11T11:31:23.356Z | null | 6 | 3 | 17215 | 5764 |
| flaky-timeout|hand|1 | 11 | 2026-10-11T11:31:23.420Z | null | 4 | — | 0 | 0 |
| flaky-timeout|hand|1 | 19 | 2026-10-11T11:31:23.420Z | null | 6 | 2 | 9063 | 3546 |
| flaky-timeout|hand|2 | 12 | 2026-10-11T11:31:23.501Z | null | 4 | — | 0 | 0 |
| flaky-timeout|hand|2 | 20 | 2026-10-11T11:31:23.501Z | null | 4 | — | 0 | 0 |
| flaky-timeout|hand|2 | 28 | 2026-10-11T11:31:23.501Z | null | 6 | 2 | 8473 | 3219 |
| flaky-timeout|hand|2 | 29 | 2026-10-11T11:31:23.501Z | null | 6 | 2 | 13199 | 7459 |
| sse-truncated|hand|0 | 13 | 2026-10-11T11:31:23.576Z | null | 4 | — | 0 | 0 |
| sse-truncated|hand|0 | 21 | 2026-10-11T11:31:23.576Z | 4 | 6 | 2 | 8363 | 557 |
| sse-truncated|hand|1 | 14 | 2026-10-11T11:31:23.941Z | null | 4 | — | 0 | 0 |
| sse-truncated|hand|1 | 22 | 2026-10-11T11:31:23.941Z | null | 6 | 2 | 10973 | 2372 |
| sse-truncated|hand|2 | 15 | 2026-10-11T11:31:24.265Z | null | 3 | — | 0 | 0 |
| sse-truncated|hand|2 | 23 | 2026-10-11T11:31:24.265Z | 4 | 6 | 3 | 12126 | 1375 |
| wrong-model|hand|0 | 16 | 2026-10-11T11:31:24.474Z | null | 4 | — | 0 | 0 |
| wrong-model|hand|0 | 24 | 2026-10-11T11:31:24.474Z | 5 | 6 | 2 | 6871 | 1238 |
| wrong-model|hand|1 | 17 | 2026-10-11T11:31:24.735Z | null | 4 | — | 0 | 0 |
| wrong-model|hand|1 | 25 | 2026-10-11T11:31:24.735Z | 5 | 6 | 2 | 8228 | 2531 |
| wrong-model|hand|2 | 18 | 2026-10-11T11:31:24.919Z | null | 4 | — | 0 | 0 |
| wrong-model|hand|2 | 27 | 2026-10-11T11:31:24.919Z | 4 | 6 | 2 | 6957 | 650 |

共 9 组，20 行。

影响：t131 的 hand 臂汇总若按全部行计算，会把同一样本算多次。t131 报告（RESULTS §10.x）中的 hand 数字需以去重后的结果为准；在确定哪一行为准之前，t131 的 hand 数字不作为证据。

**观察（待验证的假设，不是结论）**：多数重复组里，一行是 0 token、无 mainCalls 的占位行，另一行带真实 token 与 mainCalls。若占位行是某次运行开始前写下的桩，那么只保留带 token 的行才对应真实轨迹。这一假设需要检查 traj-run 的写入时机后才能确认，在此之前两行都不删除。
