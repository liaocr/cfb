本轮增量：
- 推理链读到的缺陷：`lastModel` 存在模块级，状态跨会话泄漏（推理链读到的 src/host-follow.js，未在工具回显中逐字核对）。
- 推理链提出的改法：把 lastModel 移入 makeHostFollow 的闭包，每个实例各自持有；observe 同时读取 n.model 与 options.model，callConfig 在没有记录时回退到 cfg.model（推理链的方案，尚未落地）。
- 未解：改动后 test/host-follow.selftest.mjs 是否仍然通过，尚未核实。
- 闭合判读（读数 ⇒ 结论）：若改动后 `node scripts/smoke-session.mjs` 的第二次会话中，compiler-transport-started 的 model 等于当前会话的模型，则说明跨会话泄漏是原因，修法有效。若仍是上一次会话的模型，则说明还有别的来源。
- 验收：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model）。运行 `node scripts/smoke-session.mjs`，核对 trace 最后几行，即算完。
