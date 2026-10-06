本轮增量：`hedgedDistill` 的实现已读到实处——`primarySettled` 只在 `primary.then` 的微任务里置真，`timer` 到 `cfg.hedgeAfterMs` 时读这个标志位；我们看到的测试窗口是主请求 1500ms、对冲 1600ms，中间只有 100ms 裕量，而失败样本打出的正是 `hedgeStartedAt` 非 null（got 1712）。所以这轮的判断是：能解释失败的机制只有一个——timer 回调跑起来的时候 `primarySettled` 还是假。

已排除：timer 晚发这条路。机器忙时 `setTimeout(1600)` 可能晚到（比如 1800ms 才跑），可那时候 primary 早就结算、标志位已是真，打不出这个失败。已排除：`fetch` 拒绝导致标志位永不置真这条路——本轮 fakeServer 回的是 status 200，而且 `await primary.catch(() => {})` 已把拒绝吞掉，`clearTimeout(timer)` 照常执行。

还没坐实的只有一件事：究竟是连接建立与调度开销把 primary 推到 1600ms 之后，还是 2 核上事件循环把 timer 回调排在了 fetch 回调前面。原文自己也写了 "That's flaky regardless of core count"，所以「CI 2 核 vs 本地 16 核」这条差异目前没有任何一次观察支撑，不能拿它当结论。

原文提过两条方向、都还没选定：不依赖微任务里的标志位、让 primary 与 timer 直接赛跑，或者在能同步的地方置标志位。这一轮不动 `src/distill.js`，先把复现结果拿到再定改法，否则是把原文没下的决定替它下了。

下一步工具调用是看复现：`node --version; nproc` 与 8 次重复跑的那条命令本轮已经发出，等它们的输出回来算失败率。验收就是这条复现本身——打出 `hedgeStartedAt=` 非 null 才算坐实；8 次全打不出失败不算证据，因为本地 16 核原本就不失败。如果重复跑打出失败，就回到标志位与计时器的先后关系上定改法；如果一次都打不出，先别改代码，把复现条件（绑核、负载）看清再动。

现在能说的：机理收窄到「timer 先到而 `primarySettled` 仍假」这一条，两条排除项已落地；还不能说修好，修好要三件事都在手——改动落地的回执、改后跑同一条自测的观察、以及这条观察确实是改后产生的。
