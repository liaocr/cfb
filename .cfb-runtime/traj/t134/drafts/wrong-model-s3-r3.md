本轮增量：原生推理确认根因：host-follow.js 的模块级 `lastModel` 是共享状态；`observe(options)` 只在 options.model 为真时更新，新宿主下 options.model 恒为 undefined，所以 lastModel 永远停在旧会话的模型（deepseek-v3.1），callConfig 返回它。原生结论：当前会话的模型以 `n.model` 为准，`options.model` 只是旧宿主的回退。修法：`observe(options, n)` 优先取 `n.model`，回退 `options.model`；`lastModel` 挪进 makeHostFollow 的闭包，避免跨实例串味。原生还说 selftest 只覆盖旧宿主，要补一个新宿主用例。
所以下一步工具调用是 bash，包含 `node scripts/smoke-session.mjs`、`ls -la` 与 `ls verify.mjs`，这一条本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`；旧宿主那一跳也等于 `n.model`。`node scripts/smoke-session.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
