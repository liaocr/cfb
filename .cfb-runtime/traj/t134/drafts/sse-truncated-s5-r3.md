本轮增量：原生推理确认根因：`assembleSseFrames` 在 [DONE] 存在且没有 finish_reason 时合成 finish='stop'（`finish || (done ? 'stop' : null)`），settle 的 `ok = r.finish != null || r.out.length > 0` 于是把截断流判为 ok:true。原生结论：[DONE] 本身不是完整信号，只有 finish_reason 算完整；`r.out.length > 0` 也不能作为成功依据，因为有内容但没有 finish_reason 的流就是被切断的流。修法：去掉 [DONE] 的 'stop' 合成，ok 只由 `r.finish != null` 决定。完整流（finish_reason=length）仍然 condensed。原生还说要补测试，因为 npm test 没有覆盖截断情况。
所以下一步工具调用是 bash，包含 `node scripts/replay-truncated.mjs` 与 `npm test`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
