| 变体 | n | 上下文思考字数 | 综合 | 下一步正确 | 事实 | 专注 | 死路率 | 直接改 | 改对 | 规则命中 | 本轮思考字数 | prompt tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 20 | 7857 | 5.4 | 5.3 | 5.8 | 5.5 | 25% | 40% | 40% | 40% | 4456 | 4440 |
| v4p | 10 | 774 | 4.6 | 4.6 | 4.8 | 4.8 | 20% | 30% | 30% | 40% | 1305 | 1744 |

逐任务「综合」分（均值，括号内 = 本轮思考字数）：

| 任务 | raw | v4p |
|---|---|---|
| eacces-config | 7.5 (3850) | 6.0 (1893) |
| flaky-timeout | 4.3 (10634) | 2.0 (1882) |
| wrong-model | 7.4 (3215) | 5.0 (2104) |
| sse-truncated | 3.3 (3094) | 2.5 (313) |
| perf-regression | 4.5 (1487) | 7.5 (333) |

与 raw 的同任务配对差（综合分，Δ>0 = 比原文好）：

- v4p：Δ均值 -0.8（5 个任务：-1.5 -2.3 -2.4 -0.8 +3.0）

错误 3 条：perf-regression/tail#2: HTTP 502: <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><；perf-regression/tail#1: HTTP 502: <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><；perf-regression/tail#0: HTTP 502: <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><
