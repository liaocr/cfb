本轮增量：
- 读数仍是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log）。
- 推理链读到：test/hedge.selftest.mjs 的失败只在 2 核 CI 上出现，本地 16 核从不失败。该差异与调度延迟一致（推理链的推断，未在 CI 日志中找到直接证据）。
- 未解：src/distill.js 的 primarySettled 标记是否在所有路径上都被置位，尚未核实。
- 闭合判读（读数 ⇒ 结论）：若在 2 核条件下单独运行 `node test/hedge.selftest.mjs`，每次都得到 hedgeStartedAt 为 null，则说明失败由 CI 的负载造成。若出现非 null，则说明 primarySettled 的置位存在缺口，需要回到 src/distill.js。
- 验收：分开运行 `node test/hedge.selftest.mjs` 多次（每次一条单独命令），看到全部通过且 hedgeStartedAt 始终为 null，即算完。
