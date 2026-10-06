已落定的决定（原文逐字）：「So by 1500ms primarySettled=true and timer cleared at ~1500ms.」

落点：verify.mjs（只动这一处；其余路径原文已自证不必动：「But that window is microtasks, not macrotasks, so timer can't interleave...」）

原文还悬着这句，但它不阻塞落 edit：「Timer set for 1600ms.」

验收：跑 `node verify.mjs which doesn`。若不再报 「expected 1600. That's just timer jitter; the timer fired at all means clearTimeout didn't clear it.」 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 verify.mjs 继续查，不要改测试聚合方式。
