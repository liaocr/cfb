本轮增量：原生推理确认根因：`return { out, finish: finish || (done ? 'stop' : null), eventCount: frames.length }` 在只收到 [DONE] 时合成了 finish='stop'，于是 settle 的 `r.finish != null` 判为 ok:true。原生还指出：即使去掉这个合成，settle 里 `r.out.length > 0` 也会让有 212 字内容的截断流成功。原生结论：finish 只反映真正的 finish_reason，[DONE] 只是终止标记；成功判据改为 finish 不为空；完整流（finish_reason=length）仍然 condensed。原生的修法是删除 done 合成的 'stop'，把 settle 的 ok 只由 finish 决定，并补测试：只补 [DONE] 与无结束信号两种截断用例（transport 层），以及对应的 birth passthrough 用例。
所以下一步工具调用是 edit_file，修改 src/transport.js，本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；没有任何结束信号的流同样 ok:false；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
