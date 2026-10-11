已观察事实：
- 线上现象（任务原文）：压缩结果被截断却被当成成功写进了会话。验收：被切断的流（只补 [DONE]，或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。
- 任务原文：npm test 目前是绿的，测试没覆盖这个情况。
- trace/last.log 的回显逐字为「[compiler-transport-settled] {"ok":true,"finish":"stop","stream":true,"outputChars":212,"eventCount":9}」（ctx 已摘录）。
- src/transport.js 的注释逐字为「// SSE 帧拼装：把 data: 行拼成文本，并给出这次流式输出的结束原因」（ctx 已摘录）。
- verify.mjs 的读取失败回显为「read_file 失败: ENOENT: no such file or directory, open '/tmp/traj-YYjcpy/verify.mjs'」（ctx 已摘录）。
推理链所读、工具回显中未逐字核对的内容（待核）：
- docs/gateway.md 的说明：[DONE] 不带 finish_reason 时应视为不完整（推理链转述，未逐字核实）。
- src/transport.js 在只见 [DONE] 时补出了 finish 为 stop（推理链读到，未逐行核实）。
未解：
- 上面两点是否就是 trace 中 ok:true、finish:"stop" 的来源，尚未用 node scripts/replay-truncated.mjs 复现确认。
- verify.mjs 不存在，而 package.json 的 test 脚本指向它；任务原文所说的 npm test 通过，与 verify.mjs 缺失的说法相矛盾，未核。
下一步方向：运行 node scripts/replay-truncated.mjs，比对 trace 中 settled 的 ok 与 finish 字段；读 docs/gateway.md 全文，核对 [DONE] 的定义；核对 npm test 实际执行的是什么。
