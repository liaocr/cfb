已观察事实：
- CI 失败记录是「expected hedgeStartedAt=null, got 1712」（第 1 轮 ci/last5.log 回显，ctx 中已摘录）。
- 测试断言的文字是「§4 对冲在主请求 200 之后不得再发」（ctx 原文）。
- 任务原文：CI 为 2 核，本地为 16 核；本地从不失败，CI 约每 5 次失败 1 次。
- 思维链读到的测试参数是 primaryDelayMs 1500、hedgeAfterMs 1600；这两个数只来自推理链的阅读，未在工具回显中逐字出现，出处待核。
- 第 1 轮读到的测试开头是「import assert from 'node:assert/strict'」（ctx 已摘录）。
未解（仅为推理链假设，未被工具输出证实）：
- hedge 计时器是否可能先于主请求的完成回调执行。
- 1600 与 1500 之间的余量是否过窄。
- 实现里 primarySettled 的置位时机，尚未逐行核对。
下一步方向：在接近 CI 的负载下复现，记录 hedgeStartedAt 的分布；并核对 src/distill.js 里的对冲逻辑与 test/helpers.mjs。
