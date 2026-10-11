本轮增量：原生推理定位到 `lastModel` 是模块级变量，跨会话共享；会话 2（宿主 0.9）传入的 options 不带 model，所以 `lastModel` 停留在会话 1 的 'deepseek-v3.1'，而当前会话的 n.model 是 'deepseek-v3.2'。原生结论：压缩那一跳的模型必须取当前会话的 n.model，options.model 只作为旧宿主（0.8）不带 n.model 时的回退；同时把状态改为插件实例内部持有，不再是模块级。原生计划让 callConfig 也接收 n，并在 plugin.js 里把 n 传过去。原生还注意到 selftest 的 `observe({model:'deepseek-v3.1'})` 不传 n 时仍应通过，所以回退路径要保留。
所以下一步工具调用是 bash，执行 `node scripts/smoke-session.mjs` 与 `node verify.mjs`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。`node scripts/smoke-session.mjs` 的 trace 与 `node verify.mjs` 的输出作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
