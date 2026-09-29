| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 规则命中 | 规则避坑 | 本轮思考字数 | prompt tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 15 | 7857 | 5.8 | 5.7 | 6.0 | 6.0 | 27% | 47% | 100% | 4712 | 4447 |
| empty | 15 | 0 | 3.7 | 3.6 | 4.5 | 4.0 | 40% | 47% | 100% | 2671 | 1395 |
| v3h | 13 | 714 | 4.2 | 4.2 | 3.8 | 4.4 | 38% | 23% | 100% | 2072 | 1722 |
| v4h | 11 | 600 | 2.4 | 1.8 | 3.6 | 2.5 | 36% | 9% | 100% | 2408 | 1643 |

逐任务「综合」分（均值，括号内 = 本轮思考字数）：

| 任务 | raw | empty | v3h | v4h |
|---|---|---|---|---|
| eacces-config | 9.3 (4381) | 4.3 (4598) | 7.5 (1517) | 3.0 (506) |
| flaky-timeout | 5.0 (12709) | 4.0 (5501) | 2.3 (2494) | 2.0 (5628) |
| wrong-model | 6.8 (2813) | 2.0 (553) | 5.5 (2159) | 2.7 (928) |
| sse-truncated | 2.7 (2689) | 2.3 (1558) | 2.0 (2990) | 1.7 (1889) |
| perf-regression | 5.0 (966) | 6.0 (1145) | 5.0 (1046) | 4.0 (645) |

与 raw 的同任务配对差（综合分，Δ>0 = 比原文好）：

- empty：Δ均值 -2.0（5 个任务：-5.0 -1.0 -4.8 -0.3 +1.0）
- v3h：Δ均值 -1.3（5 个任务：-1.8 -2.7 -1.3 -0.7 +0.0）
- v4h：Δ均值 -3.1（5 个任务：-6.3 -3.0 -4.2 -1.0 -1.0）

错误 6 条：eacces-config/v4h#0: judge-unparseable: {"correct":9,"deadEnd":false,"facts":9,"focus":9,"overall":9,；eacces-config/v3h#0: 通道始终未送入思考：claude-shape,claude-shape,claude-shape,prompt=1340,claude-shape；eacces-config/v4h#2: 通道始终未送入思考：prompt=1043,claude-shape,claude-shape,claude-shape,claude-shape；wrong-model/v3h#0: 通道始终未送入思考：claude-shape,claude-shape,claude-shape,prompt=1017,claude-shape；perf-regression/v4h#2: HTTP 502: <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><；perf-regression/v4h#0: HTTP 502: <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><
