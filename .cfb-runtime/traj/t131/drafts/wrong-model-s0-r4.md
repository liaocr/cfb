本轮增量：
- 推理链读到的根因：`lastModel` 是模块级变量，所有插件实例共用（推理链读到的 src/host-follow.js，未在工具回显中逐字核对）。
- 推理链的推断：压缩那一跳沿用的是 host-follow 记住的模型，因此上一次会话的模型可能被沿用。
- 未解：旧宿主中 `n.model` 与 `options.model` 是否一致，尚未核实。
- 闭合判读（读数 ⇒ 结论）：若 `node scripts/smoke-session.mjs` 在第二次会话里，trace 的 compiler-transport-started 仍显示第一次会话的模型，则说明 lastModel 的跨会话共享是原因。若显示当前会话的模型，则说明原因在 makeHostFollow 之外。
- 验收：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model）。修改后运行 `node scripts/smoke-session.mjs`，核对 trace 最后几行，即算完。
