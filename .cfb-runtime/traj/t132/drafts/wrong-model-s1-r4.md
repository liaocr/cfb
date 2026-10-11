本轮增量：
原文读到的根因：`observe(options)` 只读 `options.model`，而 lastModel 是模块级变量，跨会话保留（原文原话：in session 2 options.model is undefined, so lastModel stays 'deepseek-v3.1'）。第二次会话（宿主 0.9）不传 options.model，所以压缩那一跳用的是第一次会话记住的模型，trace 里 compiler-transport-started 的 model 因此与 n.model 不同（原文的推断，尚未在 smoke 中复现）。
原文认为 birth.js 中 compressedWith 的值来自 callCfg.model，trace 的 compiler-transport-started 也用 callCfg.model，所以问题出在 callConfig 返回的 model，而不是 birth.js 本身（原文的阅读，尚未逐行核对）。
排除：原文认为 birth.js 本身不是问题。原文没有排除其它路线。
方向：原文的修法是优先取 n.model；observe 同时接收 n，callConfig 接收 n；回退到 options.model 与 cfg.model。原文提醒 test/host-follow.selftest.mjs 只调用 callConfig({})，不传 n，所以 lastModel 必须保留。这是原文定下的思路。
未解：selftest 不覆盖「第二次会话」的情形，这一点原文只读出，尚未用 smoke 验证。
所以下一步工具调用是 bash `node scripts/smoke-session.mjs; echo '--- selftest ---'; node test/host-follow.selftest.mjs; echo '--- npm test ---'; npm test 2>&1 | tail -5; ls`。这条命令已经发出，回执不在输入中。
验收：ctx 的验收条款原文是：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model），旧宿主仍传 options.model 时也要对。预期 smoke 的第二次会话 model 等于 n.model。若仍是上一次会话的模型，那说明 callConfig 的回退逻辑仍在起作用，需要回到 host-follow.js。
回放过了之后还有两件原文已经定下的事：确认 test/host-follow.selftest.mjs 仍然通过；以及确认旧宿主那一跳也等于 n.model。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
