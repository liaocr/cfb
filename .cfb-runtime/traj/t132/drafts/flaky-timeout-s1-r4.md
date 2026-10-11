本轮增量：
读数仍是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log）。
原文的推理链：主请求 1500ms 返回，hedge 在 1600ms 启动，二者只差 100ms 余量。`primary.then(() => { primarySettled = true })` 的置位原文认为没有问题（置位先于 await 之后的 clearTimeout）。
机理（原文的推断，尚未复现）：服务端 setTimeout(1500) 与客户端 hedge 的 1600ms 计时器在同一个进程、同一个事件循环里。原文写道：Both are in the same phase.，并且 Node's timer phase vs poll phase ordering matters。服务端的 res.end 只安排网络写入，客户端 fetch 的结算要等到 poll 阶段。如果两个计时器在同一个 timer 阶段内都已到期，hedge 会在主请求结算之前启动。这就是 2 核 CI 偶发、16 核本地不发生的原因（原文的推断）。原文承认 by that definition：客户端在计时器触发时还没收到响应，所以 hedge 的启动在定义上并不算错。
排除：原文没有排除其它路线。
未核实：package.json 的 test 脚本指向 verify.mjs，而原文读到该文件不存在（这一点原文自己标为待查，未核实）。
所以下一步工具调用是 bash，内容以 `node -v; git log --oneline -20 2>&1 | head` 开头，并包含 `ls -la` 与 `find . -name '*.mjs'`；另一条是循环 20 次运行 `node test/hedge.selftest.mjs` 的命令。两条都已发出，回执不在输入中。
验收命令待定：需要看到 20 次循环里 F 与 . 的分布，以及 hedgeStartedAt 的取值，才能定验收。
回放过了之后还有两件原文已经定下的事：确认 verify.mjs 缺失的情况（原文待查）；以及确认 100ms 余量在负载下是否真的被打穿（原文的推断）。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
