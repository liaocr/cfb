本轮增量：
原文读到两处缺陷。第一处：`finish: finish || (done ? 'stop' : null)` 把 [DONE] 记成 finish='stop'，只补 [DONE] 的截断流因此被当成正常结束（原文的推断，尚未在 src/transport.js 中逐行核对，但原文确实给出了这一行）。第二处：`ok = r.finish != null || r.out.length > 0`，只要有内容就判为成功（原文的阅读，尚未逐字核实）。
原文引用的网关规则是：[DONE] 而没有 finish_reason 即为截断（来自 docs/gateway.md，原文标注未在工具回显中逐字确认）。
未解：finish 的派生方式（原文已读到第一处，但标注未逐字核实）。
排除：原文认为完整流的标志是 finish_reason，[DONE] 本身不够，所以不能保留 done 到 stop 的映射。原文没有排除其它路线。
方向：原文的修法是删掉 `(done ? 'stop' : null)` 的映射，并把 ok 改为只看 finish 是否存在。这是原文定下的，尚未在工具回显中确认已落地。
所以下一步工具调用是 bash，内容包含 `ls -la`、`npm test 2>&1 | head -30` 与 `node scripts/replay-truncated.mjs`。这条命令已经发出，回执不在输入中。
验收：ctx 的验收条款原文是：被切断的流（只补 [DONE]、或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。验收命令是 `node scripts/replay-truncated.mjs` 与 `npm test`，预期 replay 对只有 [DONE] 的截断流打印 ok:false，npm test 通过。若 replay 仍打印 ok:true，那说明还有第二条路径，需要回到 src/transport.js 的 settle，而不是改 birth。
回放过了之后还有一件原文已经定下的事：确认完整流（finish_reason=length）仍走 condensed。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
