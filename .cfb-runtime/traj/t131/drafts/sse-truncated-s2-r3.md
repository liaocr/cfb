本轮增量：
- 推理链读到的条件：`ok = r.finish != null || r.out.length > 0`，内容存在即判为成功（推理链的阅读，尚未在 src/transport.js 中逐行核对）。
- 推理链引用的网关规则：[DONE] 而没有 finish_reason 即为截断（推理链读到的 docs/gateway.md 说明，未在工具回显中逐字确认）。
- 未解：docs/gateway.md 的原文，以及 `finish` 的派生方式，尚未逐字核实。
- 闭合判读（读数 ⇒ 结论）：若 `node scripts/replay-truncated.mjs` 对只有 [DONE]、没有 finish_reason 的截断流打印 ok:true，则说明 `r.out.length > 0` 这一条件是问题的来源，需要删除。若打印 ok:false，则说明该条件已不起作用。
- 验收：修改后运行 `node scripts/replay-truncated.mjs`，看到截断流打印 ok:false，并运行 `npm test` 全部通过，即算完。
