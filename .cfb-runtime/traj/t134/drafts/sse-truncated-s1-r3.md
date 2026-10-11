本轮增量：原生推理确认根因：`assembleSseFrames` 的 `finish || (done ? 'stop' : null)` 让只补 [DONE] 的流被记成 finish='stop'，settle 于是给出 ok:true。原生还指出 settle 里按内容长度判成功，会让没有任何结束信号、只有部分内容的流也成功。原生结论：只有上游明确给出 finish_reason 才算完整，[DONE] 本身不足以证明完整；原文引用的网关说明是：连接被切断时只补 [DONE]、没有 finish_reason，内容不完整。修法：finish 只取显式的 finish_reason；`ok` 只由 `finish != null` 决定。完整流（finish_reason=length）仍然 condensed。
所以下一步工具调用是 bash，包含 `node scripts/replay-truncated.mjs` 与 `npm test`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
