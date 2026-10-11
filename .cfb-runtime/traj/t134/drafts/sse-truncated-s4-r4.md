本轮增量：原生推理确认根因：`settle` 的 `ok = r.finish != null || r.out.length > 0`，与 `assembleSseFrames` 的 `finish: finish || (done ? 'stop' : null)` 一起，让只补 [DONE] 的截断流被记成成功；即使没有 [DONE]，只要 `r.out.length > 0` 也判成功。网关说明：连接被切断时只补 [DONE]、没有 finish_reason，内容不完整。修法：finish 只取显式 finish_reason，不由 [DONE] 合成；ok 只由显式 finish 决定。完整流（finish_reason=length）仍然 condensed。原生还说现有 npm test 没覆盖这个情况，要补一条回归测试。
所以下一步工具调用是 bash，包含 `ls -la`、`npm test` 与 `node scripts/replay-truncated.mjs`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
