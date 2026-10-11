已落定的决定（原文逐字）：「The correct implementation should ensure that once the primary response is received, no hedge is started.」

落点：test/hedge.selftest.mjs（只动这一处；其余路径原文已自证不必动：「The test is simulating: primary returns at 1500ms, hedgeAfterMs=1600, so expected no hedge.」）

原文还悬着这句，但它不阻塞落 edit：「But the timer is a setTimeout for 1600ms.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 test/hedge.selftest.mjs 继续查，不要改测试聚合方式。
