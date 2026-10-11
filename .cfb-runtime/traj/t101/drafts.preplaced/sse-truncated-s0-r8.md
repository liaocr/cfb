已落定的决定（原文逐字）：「Fix: finish should only reflect a real finish_reason.」

落点：transport.selftest.mjs（只动这一处；其余路径原文已自证不必动：「Now, what about the case "没有任何结束信号" (no DONE at all, just cut mid-stream)?」）

原文还悬着这句，但它不阻塞落 edit：「npm test runs a harness that globs test/*.selftest.mjs (there's a verify.mjs somewhere, maybe hidden — but it works).」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 transport.selftest.mjs 继续查，不要改测试聚合方式。
