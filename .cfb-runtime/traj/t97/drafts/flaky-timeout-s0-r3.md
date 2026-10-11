别再比较事件循环相位了，原文已经推到尽头：`clearTimeout(timer)` 跑在 fetch resolve 之后的微任务里，正常机器远在 1600 之前完成；只有循环被连续阻塞（原文「blocked from ~1400 to ~1700」）才会让 1600 的 timer 抢先，而 `distill.js` 没有更早的钩子能把已经过期的 timer 收回来（原文自己写了「we can't un-fire it」）。⇒ 这不是源码侧能用顺序修掉的毛病。

「加大裕量算不算掩盖」取决于断言测什么：`assert.equal(meta.hedgeStartedAt, null)` 要保的是「primary 在 deadline 之前结算 ⇒ 不发对冲」这条语义；而题面写明 CI 每 5 次失败 1 次、本地 16 核从不失败 ⇒ 2 核上 100ms 的余量测到的是调度抖动。⇒ 把余量拉到远大于抖动，测的才是语义本身，不是藏问题。

改法只落一个：`test/hedge.selftest.mjs` 里 `old_text` 取 `{ hedgeAfterMs: 1600 }` 改成 `{ hedgeAfterMs: 5000 }`，只改 `hedgedDistill` 调用行那一处。

验收（闭合判读）：单独跑 `node test/hedge.selftest.mjs` 本地必过 ⇒ 不携带信息；依据要来自 2 核复现——用上面那条按原文提过的 `taskset -c 0,1` 绑核，连续跑五次看退出码。若五次全部退出码 0 ⇒ 说明余量盖过抖动，判已修好，停手写结论；若任何一次非 0 ⇒ 说明「100ms 余量不够」这个假设不成立，要回到 `distill.js` 里 `primarySettled` 的置位时机继续查，而不是继续加大测试参数。
