本轮增量：原生推理确认根因：`lastModel` 是模块级全局，不是按实例分的；`observe(options)` 不读 `n.model`。新宿主下 options.model 为 undefined，所以 lastModel 停在上一次会话的模型（deepseek-v3.1），压缩那一跳沿用了它。原生结论：应当跟随当前会话的模型，即优先 `n.model`，只有旧宿主才回退到 `options.model`；并且 lastModel 要挪到实例内，避免跨实例串味。
所以下一步工具调用是 edit_file，修改 src/host-follow.js，old_text 为 `observe(options) { if (options && options.model) lastModel = options.model }`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`（当前会话的模型）；旧宿主那一跳也等于 `n.model`。`node scripts/smoke-session.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
