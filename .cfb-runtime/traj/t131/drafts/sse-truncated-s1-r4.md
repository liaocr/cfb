本轮增量：
- 线上现象：压缩结果被截断却被当成成功写进了会话（延续段 HEAD 的描述）。
- 推理链读到的条件：`r.out.length > 0` 让有内容的截断流也被判为成功（推理链的阅读，未在工具回显中逐字核对）。
- 未解：`out.length > 0` 是否为别的传输模式而设，尚未查到证据，这是推理链自己提出的疑问。
- 闭合判读（读数 ⇒ 结论）：若 `node scripts/replay-truncated.mjs` 对截断流仍打印 ok:true，则说明 `out.length > 0` 这一分支仍在起作用，需要删除或限定。若打印 ok:false，则说明问题已由这一分支解决。
- 验收：运行 `npm test` 与 `node scripts/replay-truncated.mjs`，看到 npm test 全部通过且 replay 打印 ok:false，即算完。
