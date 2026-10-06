已落定的决定（原文逐字）：「So the root cause: the test uses CFB_REAL_DSH_HOME which points to a root-owned real home, bypassing the isolated temp DSH_HOME.」

落点：birth.selftest.mjs（只动这一处；其余路径原文已自证不必动：「Wait but /home/u doesn't exist in the sandbox...」）

原文还悬着这句，但它不阻塞落 edit：「But birth.selftest.mjs uses process.env.CFB_REAL_DSH_HOME instead of DSH_HOME.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 birth.selftest.mjs 继续查，不要改测试聚合方式。
