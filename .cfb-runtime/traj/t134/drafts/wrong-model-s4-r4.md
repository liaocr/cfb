本轮增量：原生推理确认根因：`lastModel` 是模块级状态，跨会话保留；`observe` 只在 `options.model` 存在时更新它，宿主 0.9 下它是 undefined，所以压缩那一跳沿用上一次会话的模型。原生修法：`observe(options, n)` 优先取 `n.model`，没有才回退到 `options.model`。
所以下一步工具调用是 bash，内容是 `node scripts/smoke-session.mjs`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`。
