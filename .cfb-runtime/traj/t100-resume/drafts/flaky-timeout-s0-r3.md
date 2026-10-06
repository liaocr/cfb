已落定的决定（原文逐字）：「So the timer fired at ~1700ms and primarySettled was still false at that point.」

落点：test/helpers.mjs（只动这一处；其余路径原文已自证不必动：「Hmm the output shows after helpers: $ cat verify.mjs 2>/dev/null — no wait that's the tool result formatting.」）

原文还悬着这句，但它不阻塞落 edit：「But the timer callback checks primarySettled.」

验收：跑 `node verify.mjs`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 test/helpers.mjs 继续查，不要改测试聚合方式。
