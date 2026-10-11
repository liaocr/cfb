本轮增量：原生推理确认：`lastModel` 是模块级状态，跨会话共享；会话 1 的 options.model 设置了它，会话 2（宿主 0.9）options.model 为空，于是 callConfig 返回会话 1 的 'deepseek-v3.1'，而当前会话的 n.model 是 'deepseek-v3.2'。原生的修法：callConfig 接收 n，优先取 n.model，其次取 options.model（旧宿主），最后才是 cfg.model；`lastModel` 收进 makeHostFollow 内部，每个插件实例独立。原生还注意到 selftest 只传 options、不传 n，所以 callConfig 不带 n 时仍要返回之前记住的模型。原生计划同时改 plugin.js，把 n 传给 callConfig。
所以下一步工具调用是 bash，执行 `node scripts/smoke-session.mjs` 与 `npm test`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。`node scripts/smoke-session.mjs` 的输出作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
