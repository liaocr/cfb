本轮增量：
读数仍是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log 的回显）。原文的推理是：主请求在 1500ms 返回，hedge 计时器设在 1600ms，两者之间只有 100ms 余量。1712 说明计时器在 1712 左右才触发，那时 primarySettled 仍是 false，所以 hedge 启动了。这一步是原文的推断，尚未在工具回显中复现。
看起来 `primary.then(() => { primarySettled = true })` 的置位逻辑本身没有错（原文认为它先于 await 之后的 clearTimeout 执行）。问题在测试的时序假设：主请求要在 1600ms 之前返回。负载下这个假设会被破坏，此时 hedge 启动是正确行为（原文原话：the hedge starting is correct behavior given the primary didn't return in time）。这就是 CI 偶发失败的原因：测试本身按构造不稳定。原文自己也写了 The margin is 100ms，这个 100ms 就是脆弱处。
排除：原文没有给出第二条被排除的路线。原文认为源码路径正确，所以改 hedge 实现不是它的方向。
方向：原文最后倾向放宽测试余量（Let me widen the margin），主请求的延迟远小于 hedge 阈值。原文提过的数值是 primary 100ms、hedge 5000ms，但原文没有定下，具体的 old_text 也没有在原文里出现，这里不写。
所以下一步工具调用是 bash `nproc; node -v; cat ci/last5.log`。这条命令已经发出，它的回执不在输入中。
验收命令待定：需要看到在 2 核或加压条件下，hedgeStartedAt 是否仍非 null 的那一行读数，之后才能定验收。
回放过了之后还有两件原文已经定下的事：确认测试在放宽余量后不再依赖 100ms 的主请求与 hedge 时序；以及找出 CI 2 核与本地 16 核的差异来源（原文认为是调度，未验证）。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，三件都缺，不能说修好。
