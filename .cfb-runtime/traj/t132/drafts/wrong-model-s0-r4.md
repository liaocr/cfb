本轮增量：
原文读到的根因：`host-follow.js` 保留了模块级的 `lastModel`（module-level state, shared across sessions），而且在新宿主里从不用 `n.model` 更新它（原文原话：never updates from `n.model` in new hosts）。因此压缩那一跳沿用的是上一次会话记住的模型（原文的推断，尚未在 smoke 中复现）。
原文的修法思路：模型的来源优先取 n.model，其次 options.model（旧宿主），再次 cfg.model；状态放进 makeHostFollow 的闭包，不再是模块级（原文认为模块级状态会在插件实例之间共用，这也是问题）。原文的 callConfig 测试要求在不传 n 时仍能用 observe 记住的值。
未解：旧宿主中 `n.model` 与 `options.model` 是否一致，原文尚未核实。
排除：原文没有排除其它路线。
所以下一步工具调用是 bash `node scripts/smoke-session.mjs`，以及 bash `node test/host-follow.selftest.mjs`。这两条已经发出，回执不在输入中。
验收：ctx 的验收条款原文是：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model），旧宿主仍传 options.model 时也要对。验收命令是 `node scripts/smoke-session.mjs`，预期第二次会话的 compiler-transport-started 的 model 等于当前会话的 n.model。若仍是上一次会话的模型，那说明 lastModel 的跨会话共享还在，需要回到 host-follow.js 的 observe 与 callConfig。
回放过了之后还有两件原文已经定下的事：确认 test/host-follow.selftest.mjs 仍然通过；以及确认旧宿主（仍传 options.model）的那一跳也等于 n.model。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
