本轮增量：
读数仍是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log）。
原文的推理：test/hedge.selftest.mjs 只在 2 核 CI 上失败，本地 16 核不失败。原文的推断是调度延迟（未在 CI 日志中找到直接证据）。服务端的 setTimeout(1500) 与客户端的 hedge 计时器（1600ms）在同一个事件循环里。原文写道：same event loop。如果 1500 计时器触发后，res.end 排出的数据因为 I/O 延迟没被客户端及时读到，那么 1600 的 hedge 计时器会先触发（原文原话：the hedge timer fires first）。这是原文的推断，尚未复现。
排除：原文确认 `primary.then(() => { primarySettled = true })` 在正常的 200 响应路径上会先于 hedge 计时器置位，所以本次 200 响应的情况不是置位逻辑的问题。
未解：原文提出 fetch 被拒绝时 primarySettled 不会被置位（原文原话：what if the fetch rejects? Then primarySettled never becomes true），这条路径对本次 200 响应不相关，尚未核实 src/distill.js 中所有路径的置位情况。
所以下一步工具调用是 bash `cd /home/u/work/repo && node --version && time node test/hedge.selftest.mjs`，以及 bash `cd /home/u/work/repo && nproc && cat ci/last5.log`。两条都已发出，回执不在输入中。
验收命令待定：需要看到 time 给出的耗时，以及 nproc 的核数与 ci/last5.log 中失败的那一行，才能定验收。
回放过了之后还有两件原文已经定下的事：确认本地 16 核下 hedge 测试的耗时与失败次数（原文的对照）；以及在 2 核条件下复现一次（原文尚未做）。能说修好要三件事都在手：改动落地的证据（有 / 缺）、原症状在同等条件下消失（有 / 缺）、这条观察是改后产生的（有 / 缺）；现在能说的：尚未改动，不能说修好。
