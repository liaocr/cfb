原文落定「maxOutputTokens 850→4096」，落点在 `config.js`。
这条线只有一处：先确认收网等待由这些参数决定。
验收：跑 `analyze-trace` 比对两版 birth 的 finishWaitMs——
若 p50 回到 900ms 量级 ⇒ 说明参数就是原因；若仍停在 2400 ⇒ 说明原因不在这处配置，别急着改。
