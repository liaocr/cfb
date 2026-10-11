本轮增量：原生推理确认根因：`assembleSseFrames` 的 `finish: finish || (done ? 'stop' : null)` 在只有 [DONE] 时合成了 'stop'，settle 的 `r.finish != null || r.out.length > 0` 又让有内容但无 finish_reason 的流成功，所以截断流被 condense。原生结论：[DONE] 不是完成信号，只有 finish_reason 才是；修法是 finish 不做 'stop' 回退，ok 改为只由 finish 决定；完整流（finish_reason=length）仍然 condensed，空内容但正常结束（finish='stop'）仍然 ok。原生还计划补测试，覆盖 birth 层的截断 passthrough 与完整流 condensed。
所以下一步工具调用是 bash，执行 `node scripts/replay-truncated.mjs`，本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；没有任何结束信号的流同样 ok:false；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
