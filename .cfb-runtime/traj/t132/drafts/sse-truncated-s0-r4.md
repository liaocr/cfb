本轮增量：
线上 trace 读数是「[compiler-transport-settled] {"ok":true,"finish":"stop","stream":true,"outputChars":212,"eventCount":9}」（延续段第 1 轮 trace/last.log）。这行的 finish 是 stop，所以它本身不能证明流被截断。
原文的推理有两处缺陷。第一处：`finish: finish || (done ? 'stop' : null)` 把 [DONE] 记成了 finish='stop'，也就是说只补了 [DONE] 的截断流会被伪造成正常结束（原文的推断，尚未在 src/transport.js 中逐行核对）。第二处：`ok = r.finish != null || r.out.length > 0` 让有内容的截断流即使没有任何结束信号也判为成功（原文原话：That's the second bug）。
排除：原文认为完整流（含 finish_reason=length）仍应判为成功，所以 finish 只能来自真实的 finish_reason，而不是 [DONE]。原文没有排除其它路线。
未解：docs/gateway.md 中「正常结束」的定义尚未在工具回显中逐字确认；是否存在 finish 为 null 而内容完整的合法情况，未验证。
方向：原文的修法是 finish 只取 finish_reason；ok 只看 finish 是否存在。这是原文定下的，已经在 src/transport.js 上发出了 edit_file（回执不在输入中）。
验收：运行 `node scripts/replay-truncated.mjs` 与 `npm test`。ctx 的验收条款原文是：被切断的流（只补 [DONE]、或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。预期 replay 对截断流打印 ok:false，npm test 通过。若 replay 仍打印 ok:true，那说明第二条路径仍在起作用，需要回到 src/transport.js 的 settle，而不是改 birth。
所以下一步工具调用是 edit_file src/transport.js（已经发出，见上）。
回放过了之后还有两件原文已经定下的事：确认 `npm test` 在改动后仍然全部通过；以及确认完整流（finish_reason=length）仍走 condensed。能说修好要三件事都在手：改动落地的证据（有 / 缺：靠 grep 补）、原症状在同等条件下消失（有 / 缺：靠 replay 补）、这条观察是改后产生的（有 / 缺）；现在能说的：已改未验证。
