已落定的决定（原文逐字）：「The fix: the test should use the isolated temp home.」

落点：test/birth.selftest.mjs（只动这一处；其余路径原文已自证不必动：「The bug is the test passing the wrong env var.」）

原文还悬着这句，但它不阻塞落 edit：「Wait, the ls -la /home/u/.dsh output shows the content of storages?」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 test/birth.selftest.mjs 继续查，不要改测试聚合方式。
