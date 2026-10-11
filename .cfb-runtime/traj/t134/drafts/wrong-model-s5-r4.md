本轮增量：原生推理确认根因：`host-follow.js` 的 `lastModel` 是模块级变量，跨会话保留；`observe` 忽略了 `n.model`，`callConfig` 也忽略了当前会话的 `n.model`。原生结论：当前会话的模型以 `n.model` 为准，旧宿主仍传 options.model 时也要对。原生还指出 lastModel 在模块顶层，多个插件实例共享它，这也是串味的一部分。修法：把 lastModel 挪进 makeHostFollow 的闭包，`observe(options, n)` 优先取 `n.model`，回退到 `options.model`。
所以下一步工具调用是 edit_file，修改 src/host-follow.js，old_text 为 `let lastModel = null`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`；旧宿主那一跳也等于 `n.model`。`node scripts/smoke-session.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
