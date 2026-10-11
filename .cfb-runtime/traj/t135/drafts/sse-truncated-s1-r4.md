本轮增量：原生推理确认根因：`assembleSseFrames` 把 [DONE] 当成 finish='stop'（`return { out, finish: finish || (done ? 'stop' : null), eventCount: frames.length }`）。原生还指出 settle 的 out 长度判断会让截断流（有 212 字内容）也成功。原生结论：finish 只取真正的 finish_reason，[DONE] 本身只是终止标记；ok 只由显式 finish 决定；完整流（finish_reason=length）仍然 condensed。原生还计划补测试：在 test/transport.selftest.mjs 里加只补 [DONE] 的用例，并新增一个 birth 的 selftest，覆盖完整流 condensed、只补 [DONE] 与无结束信号 passthrough 三种情况。
所以下一步工具调用是 edit_file，修改 src/transport.js，old_text 为 `return { out, finish: finish || (done ? 'stop' : null), eventCount: frames.length }`，本轮已经发出，结果不在输入中。
验收：只补 [DONE] 的截断流 settle 为 ok:false，birth 走 passthrough；完整流 finish_reason=length 仍 condensed。`node scripts/replay-truncated.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
