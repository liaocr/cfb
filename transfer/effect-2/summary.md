| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 规则命中 | 规则避坑 | 本轮思考字数 | prompt tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 10 | 7857 | 5.8 | 5.7 | 6.0 | 6.2 | 30% | 50% | 100% | 4842 | 4457 |
| empty | 9 | 0 | 4.1 | 3.9 | 5.3 | 4.3 | 44% | 56% | 100% | 2166 | 1392 |
| v3 | 5 | 535 | 2.8 | 2.6 | 4.0 | 2.4 | 40% | 0% | 100% | 2074 | 1556 |
| v4 | 7 | 679 | 3.4 | 3.4 | 4.1 | 3.0 | 43% | 14% | 86% | 1024 | 1728 |
| v4inc | 7 | 1319 | 2.4 | 2.4 | 2.9 | 2.9 | 43% | 0% | 100% | 1760 | 1904 |

逐任务「综合」分（均值，括号内 = 本轮思考字数）：

| 任务 | raw | empty | v3 | v4 | v4inc |
|---|---|---|---|---|---|
| eacces-config | 9.5 (4450) | 2.0 (1208) | 2.0 (1541) | 2.5 (878) | 2.0 (1776) |
| flaky-timeout | 6.0 (13724) | 5.0 (6509) | 4.0 (3287) | — | — |
| wrong-model | 5.5 (2646) | 2.5 (720) | 2.0 (1127) | 1.0 (444) | 2.0 (1259) |
| sse-truncated | 2.5 (2653) | 2.5 (1335) | — | 2.5 (1649) | 2.5 (2266) |
| perf-regression | 5.5 (736) | 7.5 (581) | — | 6.5 (836) | 4.0 (1716) |

与 raw 的同任务配对差（综合分，Δ>0 = 比原文好）：

- empty：Δ均值 -1.9（5 个任务：-7.5 -1.0 -3.0 +0.0 +2.0）
- v3：Δ均值 -4.3（3 个任务：-7.5 -2.0 -3.5）
- v4：Δ均值 -2.6（4 个任务：-7.0 -4.5 +0.0 +1.0）
- v4inc：Δ均值 -3.1（4 个任务：-7.5 -3.5 +0.0 -1.5）

错误 8 条：eacces-config/empty#1: 通道始终未送入思考：claude-shape,claude-shape,claude-shape,claude-shape,claude-shape；eacces-config/v3#0: 通道始终未送入思考：claude-shape,claude-shape,claude-shape,claude-shape,claude-shape；flaky-timeout/v4#0: 通道始终未送入思考：claude-shape,prompt=1042,prompt=1042,prompt=1042,prompt=1042；flaky-timeout/v4#1: 通道始终未送入思考：claude-shape,prompt=924,prompt=1317,prompt=1317,prompt=1317；flaky-timeout/v4inc#1: 通道始终未送入思考：prompt=1042,prompt=1042,prompt=1042,claude-shape,claude-shape；wrong-model/v4#1: judge-unparseable: {"correct":4,"deadEnd":false,"facts":5,"focus":5,"overall":5,；flaky-timeout/v4inc#0: 通道始终未送入思考：prompt=1033,prompt=1179,prompt=1042,claude-shape,claude-shape；perf-regression/v4inc#0: 通道始终未送入思考：claude-shape,claude-shape,claude-shape,claude-shape,claude-shape
