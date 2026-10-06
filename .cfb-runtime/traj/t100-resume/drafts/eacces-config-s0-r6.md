已落定的决定（原文逐字）：「The test should use DSH_HOME (the isolated temp dir), not CFB_REAL_DSH_HOME.」

落点：test/birth.selftest.mjs（只动这一处；其余路径原文已自证不必动：「We can't chown without sudo, and shouldn't rely on that.」）

原文还悬着这句，但它不阻塞落 edit：「But wait — is that the "right" fix or should we also harden trace.js?」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 test/birth.selftest.mjs 继续查，不要改测试聚合方式。
