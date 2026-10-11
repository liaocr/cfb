本轮增量：原生推理确认：host-follow.js 的模块级 `lastModel` 跨会话保留。会话 2（宿主 0.9）options.model 为空，observe 不更新，于是保留会话 1 的 'deepseek-v3.1'，而当前会话的 n.model 是 'deepseek-v3.2'。原生的修法：observe(options, n) 以 n.model 为当前会话模型，缺失时回退到 options.model（旧宿主）；`lastModel` 收进实例闭包。原生还指出，光做实例化还不够，应当优先使用每次请求的 n.model，而不是依赖上次存下来的值。原生计划保留 selftest 只传 options 的老路径。
所以下一步工具调用是 bash，执行 `node scripts/smoke-session.mjs`，再执行 `node verify.mjs`，本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于当前会话的模型（n.model）；旧宿主仍传 options.model 时也要对。`node scripts/smoke-session.mjs` 与 `node verify.mjs` 的输出作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
