前 4 轮已读完整份 test/hedge.selftest.mjs 与 src/distill.js，且本轮 `taskset -c 0 node test/hedge.selftest.mjs` 已复现出 expected hedgeStartedAt=null, got 1712：根因是 test/hedge.selftest.mjs 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 只有 100ms 裕量，在 2 核事件循环抖动下竞态越界。
已排除：改 src/distill.js 里 `!primarySettled` 或 `primary.then(() => { primarySettled = true })` 的路线，因为产品代码逻辑自洽，不改 src/distill.js。
已排除：再读一遍 test/hedge.selftest.mjs 的路线，因为第 3 轮已经拿到了完整文件且 `{ hedgeAfterMs: 1600 }` 在代码行里唯一，重读不新增信息。

改法只落一个：改 test/hedge.selftest.mjs，old_text 是 `{ hedgeAfterMs: 1600 }` 改成 new_text 是 `{ hedgeAfterMs: 5000 }`。只改 hedgedDistill 调用行里的那处，上面注释行留着不动；hedgedDistill 在 primary 结算后立刻 clearTimeout(timer) 返回，调大 hedgeAfterMs 不会拖慢测试。
下一步在同一轮按顺序直接发出两条调用：第一条直接 edit_file 修改 test/hedge.selftest.mjs（old_text `{ hedgeAfterMs: 1600 }` 改为 new_text `{ hedgeAfterMs: 5000 }`），第二条紧跟 bash 跑 `taskset -c 0 node test/hedge.selftest.mjs` 完成改后验收；若 edit_file 报 old_text 找不到，说明已改过，直接跑验收即可。

验收是 bash `taskset -c 0 node test/hedge.selftest.mjs`，预期打出 test/hedge.selftest.mjs PASS 全部通过；单次 16 核不绑核跑 `node test/hedge.selftest.mjs` 不算证据，因为本地 16 核原本就不失败。若验收仍报 expected hedgeStartedAt=null：第一步确认 test/hedge.selftest.mjs 代码行 `{ hedgeAfterMs: 5000 }` 已落地而非只改了注释行；此时 src/distill.js 与 test/helpers.mjs 都不是改法。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。

回放过了之后还有两件原文已经定下的事：确认 taskset 跑 test/hedge.selftest.mjs 改后稳定通过且未动 src/distill.js；以及核对 test/hedge.selftest.mjs 改动落盘后直接汇总根因与改法收工。能说修好要三件事都在手：test/hedge.selftest.mjs 改动落地的回执、taskset 跑 test/hedge.selftest.mjs 验收通过的观察、这条观察是改后产生的；现在能说的：taskset 复现已坐实，下一步第一条调用直接 edit_file test/hedge.selftest.mjs 并同轮跑 taskset 验收。
