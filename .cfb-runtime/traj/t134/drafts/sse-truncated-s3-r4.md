本轮增量：原生推理确认根因：`assembleSseFrames` 在只看到 [DONE]、没有 finish_reason 时合成 finish='stop'，而 settle 把 `out.length>0` 当成成功，所以只补 [DONE] 的截断流被判 ok:true，birth 把不完整的输出压缩进了会话。原生结论：只有真正的 finish_reason 算完整信号，[DONE] 不是。修法：`assembleSseFrames` 只记录显式的 finish_reason，不由 [DONE] 合成；settle 的 ok 只由 `ok = r.finish != null` 决定。完整流（finish_reason=length）仍然 condensed。
原生推理同时说 npm test 绿但找不到 verify.mjs，原生的下一步是重新读 package.json 并查找 verify 文件。
所以下一步工具调用是 bash，包含 `cat package.json`、`ls -la` 与 `find . -name 'verify*'`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
