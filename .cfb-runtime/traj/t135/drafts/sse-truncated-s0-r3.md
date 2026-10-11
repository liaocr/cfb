本轮增量：原生推理确认根因：`assembleSseFrames` 里 `finish: finish || (done ? 'stop' : null)`，只有 [DONE] 没有 finish_reason 时会把 finish 记成 'stop'；settle 的 `const ok = r.finish != null || r.out.length > 0` 于是给出 ok:true。原生还指出 `r.out.length > 0` 本身也会让有内容的截断流成功。原生结论：成功必须有显式的 finish_reason，[DONE] 单独不够（原生引用的网关说明：部分上游只补发 [DONE]、没有 finish_reason）。修法：finish 只取显式 finish_reason；ok 不再依赖 out 的长度。完整流（finish_reason=length）仍然 condensed。原生还说先跑一次 replay 确认当前行为。
所以下一步工具调用是 bash，包含 `node scripts/replay-truncated.mjs` 与 `npm test`，这一条本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
