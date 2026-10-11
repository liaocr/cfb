本轮增量：原生推理确认根因：`makeHostFollow` 用的 `lastModel` 是模块级变量，被多个插件实例共享；`observe` 只看 options.model，宿主 0.9 下它是 undefined，所以第二次会话不更新 lastModel，沿用第一次会话的 deepseek-v3.1。原生结论：`observe` 应当优先用 `n.model`，`options.model` 只作为旧宿主的回退；状态要放进 makeHostFollow 的闭包，每个实例独立。原生还决定保留 observe/callConfig 的接口形式，因为 selftest 用的是 `observe({model})` 再 `callConfig({})` 的调用方式。
所以下一步工具调用是 edit_file，修改 src/host-follow.js，old_text 为 `let lastModel = null`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`；旧宿主那一跳也等于 `n.model`。`node scripts/smoke-session.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
