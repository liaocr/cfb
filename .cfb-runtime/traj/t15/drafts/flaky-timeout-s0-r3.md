前几轮已把根因坐实：CI 2 核上偶发 expected hedgeStartedAt=null, got 1712（另一次 1698），根因是 test/hedge.selftest.mjs 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 之间只有 100ms 裕量——两个互相独立的墙钟 setTimeout 在 2 核事件循环与调度抖动下竞态越界；产品代码没错。
已排除：改 src/distill.js 里 primarySettled 与 primary.then 的路线——失败时该标志位确实还是假，逻辑自洽。
已排除：等待 listening 与 server.address() 的路线——URL 失败会让 fetch 立刻 reject，打不出 1712。
已排除：再写临时脚本、压测脚本或探针复现的路线——ci/last5.log 已有 run 2/run 5 两条现成失败记录，重复复现不新增信息。

改法只落一个：改 test/hedge.selftest.mjs，把 hedgedDistill 调用行里的 `{ hedgeAfterMs: 1600 }` 改成 `{ hedgeAfterMs: 5000 }`——只改调用行，注释行留着不动；hedgedDistill 在主请求结算后立刻 clearTimeout(timer) 返回，调大 hedgeAfterMs 不会拖慢测试。

紧接的那一轮在同一回复里按顺序连发两条调用：第一条 edit_file 改 test/hedge.selftest.mjs（old_text `{ hedgeAfterMs: 1600 }`，new_text `{ hedgeAfterMs: 5000 }`），第二条紧跟 bash 跑 `taskset -c 0 node test/hedge.selftest.mjs` 完成改后验收。若 edit_file 报 old_text 找不到，说明改动已落地，直接跑验收即可。

验收预期打出 PASS 全部通过；单次不绑核跑 node test/hedge.selftest.mjs 不算证据。若验收仍报 expected hedgeStartedAt=null：第一步确认改的是调用行而不是注释行，此时 src/distill.js 与 test/helpers.mjs 都不是改法。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。

收工要三件事都在手：test/hedge.selftest.mjs 改动落地的回执、taskset 跑验收通过的观察、这条观察是改后产生的；三件齐了就直接输出根因与改法收工。
