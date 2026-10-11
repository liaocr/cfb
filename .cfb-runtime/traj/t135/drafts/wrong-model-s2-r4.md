本轮增量：原生推理定位到 host-follow.js 的 `lastModel` 只在 options.model 存在时更新；宿主 0.9 的 options.model 为空，所以 observe 忽略了 n.model，`lastModel` 停留在会话 1 的模型，而 callConfig 没有接收 n。原生的修法：当前模型以 n.model 为准，options.model 只在 n.model 缺失时回退（旧宿主）；状态放在每个插件实例内部，避免跨会话泄漏。原生还计划保留 selftest 的旧用法（只传 options、不传 n 时 callConfig 仍返回之前记住的模型）。
所以下一步工具调用是 bash（`node scripts/smoke-session.mjs` 并输出 trace/trace.log，`npm test`），本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。`node scripts/smoke-session.mjs` 的 trace 与 `npm test` 的输出作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
