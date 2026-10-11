本轮增量：原生推理确认：`lastModel` 是模块级全局，跨会话泄漏；`observe(options)` 只在 options.model 存在时更新，会话 2（宿主 0.9）不带 options.model，所以保留了会话 1 的模型，而当前会话的 n.model 是 'deepseek-v3.2'。原生指出 observe 收到了 n 却没有用。原生的修法：observe 里以 n.model 为准，options.model 作为旧宿主回退；状态移入 makeHostFollow 内部，每个插件实例各自持有。原生还注意到 host-follow.selftest 只传 options 不传 n，修改后仍要通过；原生计划保留这条路径。
所以下一步工具调用是 bash，执行 `node scripts/smoke-session.mjs` 并接着运行 npm test，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。`node scripts/smoke-session.mjs` 的输出作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
