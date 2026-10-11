本轮增量：原生推理确认：`settle` 里的 `ok = r.finish != null || r.out.length > 0`，配合 `assembleSseFrames` 里的 `finish = done ? 'stop' : null`，让只补 [DONE] 的截断流成为 ok:true。原生认为 [DONE] 本身不是结束的证据（网关说明：连接被切断时只补 [DONE]，没有 finish_reason，内容不完整），所以要去掉这个兜底，并让 ok 只由显式 finish 决定。原生还指出，finish 为 null 而输出非空的流，会因为输出长度被判 ok，这一项也要去掉。完整流（finish_reason=length）仍然 condensed。
原生推理同时说 npm test 是绿的，但找不到 verify.mjs，原生的下一步是再查一次。
所以下一步工具调用是 bash，包含 `ls -la`、`ls verify.mjs`、`npm test` 与 `node scripts/replay-truncated.mjs`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
