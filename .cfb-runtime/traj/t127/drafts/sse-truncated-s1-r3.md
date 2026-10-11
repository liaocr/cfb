已观察事实：
- 线上现象（任务原文）：压缩结果被截断却被当成成功写进了会话。验收：被切断的流（只补 [DONE]，或没有任何结束信号）必须 settled ok:false，且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。
- 任务原文：npm test 目前是绿的，测试没覆盖这个情况。
- 任务原文给出的复现方式：node scripts/replay-truncated.mjs（回放一条被切断的流，打印 trace）；trace 片段在 trace/last.log，网关说明在 docs/gateway.md。
- 第 1 轮读取 trace/last.log 的回显，本段只摘录「ok」字段出现在该 trace 中（具体数值未在 ctx 中逐字出现，待核）。
- 第 2 轮读到 src/transport.js 与 src/birth.js 的内容，两者均在 ctx 中有摘录（待核内容见下）。
推理链所读、工具回显中未逐字核对的内容（待核）：
- docs/gateway.md 说明 [DONE] 可能在连接被切断后仍被补发，因此 [DONE] 不是可靠的结束信号；finish_reason 才是（推理链转述，未逐字核实）。
- 推理链认为 src/transport.js 在只见 [DONE] 时仍给出了正常结束的结论（未逐行核实）。
未解：
- 上面这一点是否就是 trace 中 ok 为真的来源，尚未用 node scripts/replay-truncated.mjs 复现确认。
- test/transport.selftest.mjs 的断言内容只摘录到 node:assert/strict 的导入行，覆盖范围未核。
下一步方向：运行 node scripts/replay-truncated.mjs，比对 trace 中 ok 字段与 finish_reason 的有无；读 docs/gateway.md 全文，核对 [DONE] 的定义；核对 npm test 实际执行的命令与其结果。
