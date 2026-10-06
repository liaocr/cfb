本轮增量：`src/transport.js` 的 `assembleSseFrames` 用 `finish = finish || (done ? 'stop' : null)` 把只补 `[DONE]` 的截断流兜成 `stop`，`settle` 判成功还看了 `out.length > 0`，截断流于是走 `condensed` 进了交付正文。`src/birth.js` import 的是 `./transport.js`，`README` 指的 `src/transport.legacy.js` 用 `choices[1]`，是诱饵。

改法只落一个：去掉 `done ? 'stop' : null` 兜底，`settle` 只留 `finish != null`。已排除连 legacy 一起改——原文停在 "Let me check if legacy is imported anywhere. grep."；已排除动现有测试——原文逐条推演了 4 个用例仍成立。未解：要不要按原文说的 "add tests to cover the new behavior"。

验收看这条：`node scripts/replay-truncated.mjs` 回放被切断的流要 `ok:false`、birth 走 passthrough，`npm test` 仍绿、完整流仍 `condensed`。若 replay 还打 `condensed`，先看清 `assembleSseFrames` 的返回值再说。
验收：跑 `src/transport.js` 看读数——若按上面这处改完它变绿 ⇒ 说明原因就在这处，可以收工；若它仍不绿 ⇒ 说明还有别处在起作用，先别声称修好。
