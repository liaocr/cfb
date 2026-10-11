| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 直接改 | 改对 | 错改 | 回头read | 规则命中 | 本轮思考字数 | prompt tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| subV4 | 14 | 1514 | 5.1 | 5.4 | 4.7 | 5.5 | 14% | 71% | 57% | 14% | 14% | 71% | 3225 | 2060 |

逐任务「综合」分（均值，括号内 = 本轮思考字数）：

| 任务 | subV4 |
|---|---|
| eacces-config | 2.0 (406) |
| flaky-timeout | 4.5 (2027) |
| wrong-model | 8.5 (966) |
| perf-regression | 9.5 (589) |
| sse-truncated | 5.5 (6709) |
| perf-regression~refute | 0.0 (4068) |
| wrong-model~refute | 6.0 (5288) |
| flaky-timeout~refute | 5.0 (10332) |

与 raw 的同任务配对差（综合分，Δ>0 = 比原文好）：

- subV4：Δ均值 —（0 个任务：）

错误 2 条：flaky-timeout~refute/subV4#1: 通道始终未送入思考：prompt=1829,prompt=1829,prompt=1043,prompt=1829,prompt=1829,prompt=182；wrong-model~refute/subV4#0: 通道始终未送入思考：claude-shape,prompt=1077,prompt=1068,prompt=1068,prompt=1710,prompt=11
