本轮增量：原生推理确认：`lastModel` 是模块级全局变量，跨会话泄漏；宿主 0.9 不再传 options.model，所以 observe 不更新，`lastModel` 保留上一次会话的值。原生看到 trace/last.log 中 compiler-transport-started 的 model 仍是 'deepseek-v3.1'，应为 'deepseek-v3.2'。原生的修法：observe 里 `n.model` 优先，`options.model` 作为旧宿主回退；状态移入 makeHostFollow 闭包，每个插件实例各自持有；callConfig 继续返回记住的模型。原生还计划加一条 selftest，覆盖新宿主（只有 n.model）的场景。
所以下一步工具调用是 edit_file，修改 src/host-follow.js，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。trace/last.log 中 compiler-transport-started 的 model 记录，以及修改后重跑的同一条记录作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
