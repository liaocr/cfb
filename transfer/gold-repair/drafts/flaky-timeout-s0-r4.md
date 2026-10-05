根因：`expected hedgeStartedAt=null, got 1712` 是 2 核竞态——`test/hedge.selftest.mjs` 里 `primaryDelayMs: 1500` 与 `hedgeAfterMs: 1600` 只差 100ms，client 的 hedge timer 在 1712 赢了 server 的 1500；断言要求 `hedgeStartedAt must be null`。

已排除：`server.listen(0)` 端口为空——URL 失败时 fetch 立刻 reject，`await primary.catch(() => {})` 随即 `clearTimeout(timer)`，`hedgeStartedAt` 仍为 null，打不出 1712。
已排除：改 `src/distill.js`——`startHedge` 只写 metadata，决定权在测试那两个 timer，不动裕量仍是竞态。

改法只落一个：`test/hedge.selftest.mjs` 中 `old_text` 取 `{ hedgeAfterMs: 1600 }` 改成 `{ hedgeAfterMs: 5000 }`，只改 `hedgedDistill` 调用行那一处、别碰注释行。

验收（闭合判读）：同一轮跑 `node test/hedge.selftest.mjs`。若不再报 `expected hedgeStartedAt=null` ⇒ 说明裕量已修好，要停在这里。若仍报 `hedgeStartedAt must be null` ⇒ 说明没修好，要重发上面那条 edit_file，而不是改别的。上一轮的 `repro.tmp.mjs` 复跑一次 ⇒ 只有 `fails` 计数为 0 才说明竞态消失；仍打 `FAIL iter` 就回报，不要扩大调查面。
