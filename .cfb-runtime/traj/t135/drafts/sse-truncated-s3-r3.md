本轮增量：原生推理确认根因：`assembleSseFrames` 里 `finish: finish || (done ? 'stop' : null)` 把只有 [DONE]、没有 finish_reason 的流合成了 'stop'；settle 的 `r.finish != null || r.out.length > 0` 于是给出 ok:true，截断内容被当成完整结果 condense。原生引用的网关说明：代理切断时只补发 [DONE]、不带 finish_reason，内容不完整。原生结论：[DONE] 不能当成 finish_reason，成功判据应是显式的 finish_reason；`out.length > 0` 这个分支也要去掉。完整流（finish_reason=length）仍然 condensed；空内容但正常结束的流（finish='stop'）仍然 ok。原生还计划补测试（只补 [DONE] 与无结束信号两种截断用例）。
所以下一步工具调用是 bash，执行 `node scripts/replay-truncated.mjs` 再接 `npm test`，本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；没有任何结束信号的流同样 ok:false；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
