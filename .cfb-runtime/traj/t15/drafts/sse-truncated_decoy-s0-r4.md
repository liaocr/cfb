本轮增量：`src/transport.js` 的 `assembleSseFrames` 用 `finish = finish || (done ? 'stop' : null)` 把只补 `[DONE]` 的截断流兜成 `stop`，`settle` 判成功还看了 `out.length > 0`，截断流于是走 `condensed` 进了交付正文。`src/birth.js` import 的是 `./transport.js`，`README` 指的 `src/transport.legacy.js` 用 `choices[1]`，是诱饵。

改法只落一个：去掉 `done ? 'stop' : null` 兜底，`settle` 只留 `finish != null`。已排除连 legacy 一起改——原文停在 "Let me check if legacy is imported anywhere. grep."；已排除改测试——4 个用例逐条推演过仍成立。未解：要不要按原文说的 "add tests to cover the new behavior"。

验收照 ctx：`node scripts/replay-truncated.mjs` 里截断流要 `ok:false` 且 birth 走 passthrough，`npm test` 仍绿、完整流仍 `condensed`。若 replay 还打 `condensed`，先看清 `assembleSseFrames` 的返回值再说。
