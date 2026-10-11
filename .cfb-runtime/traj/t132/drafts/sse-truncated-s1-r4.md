本轮增量：
线上现象（ctx）：压缩结果被截断却被当成成功写进了会话。延续段的 trace/last.log 读数仍是 finish 为 stop 的那一行。
原文读出的两处缺陷。第一处（原文原话：The bug is clear）：`finish || (done ? 'stop' : null)` 在 assembleSseFrames 的返回里伪造了 finish='stop'，只补了 [DONE] 的截断流因此被当成正常结束；原文写道：This makes `settle` return ok:true（原文的推断，尚未逐行核对）。第二处：`r.out.length > 0` 让有内容的截断流也被判为成功（原文认为 [DONE] 是传输层的终止符，不是完成的证据）。
未解：`out.length > 0` 是否为别的传输模式而设，原文尚未查到证据，这是原文自己提出的疑问。
排除：原文认为只看 finish_reason 才能证明完成，所以 [DONE] 不能合成 finish。原文没有排除其它路线。
所以下一步工具调用是 bash `ls -la; echo '---'; find . -name '*.mjs' -o -name '*.js' | grep -v node_modules; echo '---git---'; git log --oneline -10 2>/dev/null`，以及对 settle 与 finish 的 grep。这条命令已经发出，回执不在输入中。
验收：ctx 的验收条款原文是：被切断的流（只补 [DONE]、或没有任何结束信号）必须 settled ok:false 且 birth 走 passthrough；完整流（含 finish_reason=length）仍要 condensed。ctx 还写了 `npm test` 目前是绿的（测试没覆盖这个情况）。验收命令待定：需要先看到 grep 的结果，确认 out.length 分支是否有别的用途，才能定 replay 的期望读数。
回放过了之后还有两件原文已经定下的事：确认 verify.mjs 的来源（原文读到它不存在，而 npm test 仍显示通过，原文待查）；以及确认 `npm test` 的输出是否真的覆盖了截断流。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
