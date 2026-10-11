第 1–3 轮看清了 ci/last5.log、src/distill.js、test/helpers.mjs 与 test/hedge.selftest.mjs：CI 2 核偶发 expected hedgeStartedAt=null, got 1712（及 1698），根因是 test/hedge.selftest.mjs 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 只有 100ms 裕量，两个独立 setTimeout 在 2 核事件循环抖动下竞态越界。
已排除：server.listen(0) 后 server.address().port 为空的路线，因为若 URL 失败 fetch 会立刻 reject、await primary.catch(() => {}) 随即 clearTimeout(timer)，hedgeStartedAt 仍为 null 不会打出 1712。
已排除：改 src/distill.js，或在改代码前先单独跑 node test/hedge.selftest.mjs 试探沙箱的路线，因为 `taskset -c 0 node test/hedge.selftest.mjs` 已知必然可用且 ci/last5.log 已有现成失败记录。
改法只落一个：直接修改 test/hedge.selftest.mjs，old_text 是 `{ hedgeAfterMs: 1600 }` 改成 new_text 是 `{ hedgeAfterMs: 5000 }`。
注意只改 hedgedDistill 调用行里的 `{ hedgeAfterMs: 1600 }`，不要改上面注释行，hedgedDistill 在 primary 结算后立刻 clearTimeout(timer) 返回，调大 hedgeAfterMs 不会拖慢测试。
