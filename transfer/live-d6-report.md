# v4 真机测试报告

模型：deepseek-v4.1-flash（主模型 thinking enabled；副模型同一模型关思考）· 生成时间：2026-09-29T14:23:35.890Z

## 录音

| 任务 | 推理字符 | 正文字符 | 主模型总耗时 ms |
|---|---|---|---|
| eacces-config | 10074 | 345 | 22090 |
| flaky-timeout | 9053 | 478 | 24162 |
| wrong-model | 3414 | 472 | 8717 |
| sse-truncated | 5424 | 644 | 13513 |
| perf-regression | 11322 | 1446 | 18919 |
| session-mixup | 1897 | 1118 | 8739 |

## 汇总（按模式）

| 模式 | 块 | 够门槛 | 替换成功 | 命中率 | 结局分布 | 产物/原文 p50 | 产物字符 p50 | finish 多扣 ms p50 / max |
|---|---|---|---|---|---|---|---|---|
| v4 | 6 | 5 | 0 | 0 | distill-timeout×4 distill-failed×1 below-floor×1 | null | null | 6005 / 6545 |

## 逐块

| 任务 | 模式 | 结局 | 原文 | 产物 | 比例 | block-end→finish ms | finish 多扣 ms | 副模型 ms | 分段 | v4 拒绝 |
|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | v4 | distill-timeout | 10074 | 10074 | 1 | 677 | 6136 |  |  |  |
| flaky-timeout | v4 | distill-timeout | 9053 | 9053 | 1 | 1184 | 6005 |  |  |  |
| wrong-model | v4 | distill-timeout | 3414 | 3414 | 1 | 929 | 6003 |  |  |  |
| sse-truncated | v4 | distill-timeout | 5424 | 5424 | 1 | 1355 | 6004 |  |  |  |
| perf-regression | v4 | distill-failed | 11322 | 11322 | 1 | 2977 | 6545 |  |  |  |
| session-mixup | v4 | below-floor | 1897 | 1897 | 1 | 2280 | 0 |  |  |  |

## 产物全文（替换成功的块）
