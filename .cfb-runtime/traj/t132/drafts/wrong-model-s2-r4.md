本轮增量：
原文读到的缺陷：`lastModel` 存在模块级，状态跨会话泄漏。`observe(options)` 只读 `options.model`（原文原话：observe(options) only reads options.model），新宿主不传它，所以 lastModel 停在上一次会话的值（原文的推断，尚未在 smoke 中复现）。原文的 bug 描述里还包括：observe 忽略 n.model。
原文的改法：把 lastModel 移入 makeHostFollow 的闭包，每个实例各自持有；observe 同时读取 n.model 与 options.model，取到的值记入 lastModel；callConfig 在没有记录时回退到 cfg.model。原文认为旧宿主里 options.model 与 n.model 应该一致（原文未核实）。
未解：改动后 test/host-follow.selftest.mjs 是否仍然通过，尚未核实。
排除：原文没有排除其它路线。
状态：原文的改法已经以 edit_file 形式发出，修改 src/host-follow.js（回执不在输入中，尚不知道是否落地）。
所以下一步工具调用是 bash `node scripts/smoke-session.mjs && echo --- && cat trace/trace.log && echo --- && npm test` 的前半部分，即 `node scripts/smoke-session.mjs`。这条命令已经发出，回执不在输入中。
验收：ctx 的验收条款原文是：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model），旧宿主仍传 options.model 时也要对。预期 smoke 的第二次会话 model 等于 n.model。若仍是上一次会话的模型，那说明改动未落地，或还有别的来源，需要先核对 src/host-follow.js 的内容，而不是再改。
回放过了之后还有两件原文已经定下的事：确认 test/host-follow.selftest.mjs 仍然通过；以及确认旧宿主那一跳也等于 n.model。能说修好要三件事都在手：改动落地的证据（有 / 缺：靠 grep 补）、原症状在同等条件下消失（有 / 缺：靠 smoke 补）、这条观察是改后产生的（有 / 缺）；现在能说的：已改未验证。
