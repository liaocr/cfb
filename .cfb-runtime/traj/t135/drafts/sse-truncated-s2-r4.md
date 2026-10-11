本轮增量：原生推理确认根因：`done ? 'stop'` 合成了 finish，settle 的 `r.finish != null || r.out.length > 0` 让有内容的截断流成为 ok:true。原生指出：即使没有 [DONE]，只要有内容，`r.out.length > 0` 也会判成功，所以“没有任何结束信号但有内容”的流同样会被误判。原生结论：ok 只能由显式 finish 决定，即 finish 不为空；空内容但正常结束的流（finish='stop'）仍然 ok；完整流（finish_reason=length）仍然 condensed。原生的修法是 `assembleSseFrames` 直接返回 finish（不再回退到 'stop'），`done` 变量不再使用。
所以下一步工具调用是 edit_file，修改 src/transport.js，本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；没有任何结束信号的流同样 ok:false；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
