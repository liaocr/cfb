本轮增量：
- 推理链读到的调用链：birthTransform 写入 compressedWith 的值来自 callCfg.model，trace 的 compiler-transport-started 也用 callCfg.model（推理链读到的 src/birth.js，未在工具回显中逐字核对）。
- 推理链的推断：问题出在 callConfig 返回的 model，而不在 birth.js 本身。
- 未解：selftest 只调用 callConfig({}) 而不传 n，因此它无法覆盖"第二次会话"的情形，这一点尚未用 smoke 验证。
- 闭合判读（读数 ⇒ 结论）：若 `node scripts/smoke-session.mjs` 的第二次会话中，compiler-transport-started 的 model 仍是上一次会话的模型，则说明 callConfig 的回退逻辑是原因。若等于当前会话的模型，则说明原因不在该处。
- 验收：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model）。修改后运行 `node scripts/smoke-session.mjs`，核对该行的 model，即算完。
