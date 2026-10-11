本轮增量：
- 失败记录是「expected hedgeStartedAt=null, got 1712」（延续段中第 2 轮 ci/last5.log 的回显）。
- 推理链读到：主请求延迟与 hedge 触发时间只差约 100ms（推理链的阅读，未在工具回显中逐字核对）。
- 未解：计时竞争是否真由事件循环延迟造成，尚未复现。
- 闭合判读（读数 ⇒ 结论）：若在 2 核负载下复现时 hedgeStartedAt 不为 null，则说明对冲计时器先于主请求完成，100ms 的余量不足以保证顺序。若复现时 hedgeStartedAt 始终为 null，则说明失败需要更高负载，或另有来源。
- 验收：在 2 核或加压条件下多次运行 `node test/hedge.selftest.mjs`，看到全部通过且 hedgeStartedAt 始终为 null，即算完。
