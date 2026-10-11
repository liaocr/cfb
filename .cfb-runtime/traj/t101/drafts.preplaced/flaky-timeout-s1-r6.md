已落定的决定（原文逐字）：「So at 1500ms, both microtasks run: then sets primarySettled=true, await resumes, clearTimeout(timer).」

落点：test/hedge.selftest.mjs（只动这一处；其余路径原文已自证不必动：「The startHedge only sets meta; it doesn't actually send a hedge request.」）

原文还悬着这句，但它不阻塞落 edit：「But await primary.catch(() => {}) — the await resumes also in a microtask.」

验收：跑 `node version`。若不再报 「expected fix is in the test (make margin bigger) OR in source.」 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 test/hedge.selftest.mjs 继续查，不要改测试聚合方式。
