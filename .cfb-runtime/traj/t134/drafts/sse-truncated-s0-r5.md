本轮增量：原生推理已确认根因：`assembleSseFrames` 里 `finish || (done ? 'stop' : null)` 把只有 [DONE] 的截断流记成 'stop'，settle 因此给出 ok:true，birth 把截断输出压缩了。原生也确认 `out.length > 0` 不能作为成功依据。原生给出的修法是：finish 只取显式的 finish_reason，`ok` 只由显式 finish 决定，只补 [DONE] 的流与没有任何结束信号的流都判为 ok:false，完整流（finish_reason=length）仍然 condensed。原生还说要补测试，因为 npm test 没有覆盖截断情况。
原生推理同时注意到 npm test 能跑却找不到 verify.mjs，原生的下一步是再核对一次 verify.mjs。
所以下一步工具调用是 bash，包含 `ls -la`、`node -v` 与 `cat -A package.json`，这些命令本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 与 `npm test` 的结果作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
