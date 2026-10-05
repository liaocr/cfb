第 1–3 轮看清了 ci/last5.log、src/distill.js、test/helpers.mjs 与 test/hedge.selftest.mjs：CI 2 核偶发 expected hedgeStartedAt=null, got 1712（及 1698），根因是 test/hedge.selftest.mjs 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 只有 100ms 裕量，两个独立 setTimeout 在 2 核事件循环抖动下竞态越界。本轮第 4 轮尝试的 node -e 与 `cat > repro.tmp.mjs` 被拒，回显逐字是「该沙箱不支持 shell 循环」，所以验收命令沿用 `taskset -c 0 node test/hedge.selftest.mjs`。
已排除：server.listen(0) 后 server.address().port 为空的路线，因为若 URL 失败 fetch 会立刻 reject、await primary.catch(() => {}) 随即 clearTimeout(timer)，hedgeStartedAt 仍为 null 不会打出 1712。
已排除：改 src/distill.js 的路线，因为产品代码在 primary 结算后立刻 clearTimeout(timer)，逻辑自洽。
已排除：另写复现脚本再复现一遍的路线，因为 ci/last5.log 已有 run 2/run 5 两条现成失败记录，重复复现不新增信息。

改法只落一个：直接修改 test/hedge.selftest.mjs，old_text 是 `{ hedgeAfterMs: 1600 }` 改成 new_text 是 `{ hedgeAfterMs: 5000 }`。只改 hedgedDistill 调用行里的那处，上面注释行留着不动；hedgedDistill 在 primary 结算后立刻 clearTimeout(timer) 返回，调大 hedgeAfterMs 不会拖慢测试。
下一步在同一轮内按顺序同时发出两条调用：第一条直接 edit_file 修改 test/hedge.selftest.mjs（old_text `{ hedgeAfterMs: 1600 }` 改为 new_text `{ hedgeAfterMs: 5000 }`），同一轮第二条紧跟 bash 跑 `taskset -c 0 node test/hedge.selftest.mjs` 完成改后验收；若 edit_file 报 old_text 找不到，说明已改过，直接跑验收即可。

未解：确认同轮发出的 edit_file 修改 test/hedge.selftest.mjs 与 bash `taskset -c 0 node test/hedge.selftest.mjs` 打出 hedge.selftest ok；拿到这条观察后直接汇总根因与改法收工。
