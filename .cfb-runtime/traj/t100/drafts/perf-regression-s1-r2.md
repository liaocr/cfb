原文落定「The v11.10 change raised maxOutputTokens 850→4096」，且 compressTargetMax: 1800 与 birthFinishWaitMs: 1500 都在 `config.js`。
这条线只有一处：落点就在 config.js。
验收：`analyze-trace` 比对两版 birth 的 finishWaitMs，若 p50 回落到 900ms 量级 ⇒ 说明等待由这两个参数决定；若仍是 2400 ⇒ 说明原因不在配置。
