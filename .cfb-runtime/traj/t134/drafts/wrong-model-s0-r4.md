本轮增量：原生推理确认根因：`observe` 只接受 options 一个参数，只看 options.model，不读 `n`。新宿主下 options.model 为 undefined，所以 lastModel 停在上一次会话的模型（deepseek-v3.1），callConfig 返回 `lastModel || cfg.model`，压缩那一跳沿用了旧模型，而当前会话的模型在 `n.model`（deepseek-v3.2）。原生结论：压缩那一跳应等于 `n.model`，旧宿主仍传 options.model 时也要对。修法：`observe(options, n)` 里优先取 `n.model`，没有才回退到 `options.model`；保持单参调用可用，因为原生说 selftest 只调用 `host.observe` 的单参形式。原生还说要在 selftest 里补一个新宿主用例。
所以下一步工具调用是 bash，内容是 `node scripts/smoke-session.mjs`，这一条本轮已经发出，结果不在输入中。
验收：压缩那一跳的 model 等于 `n.model`；旧宿主那一跳也等于 `n.model`；selftest 仍然通过。`node scripts/smoke-session.mjs` 的输出与 trace 作为证据。
能说修好需要三件事都在手：改动落地、原症状在同等条件下消失、这条观察是改后产生的。现在只能说已改未验证。
