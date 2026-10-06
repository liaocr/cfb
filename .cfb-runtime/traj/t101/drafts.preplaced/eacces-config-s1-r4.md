已落定的决定（原文逐字）：「So the fix: the test should use DSH_HOME (the temp dir) rather than the real one.」

落点：/home/u/.dsh/storages/cot-form-b/trace.log（只动这一处；其余路径原文已自证不必动：「But we can't fix that without sudo.」）

原文还悬着这句，但它不阻塞落 edit：「Wait, but the verify.mjs sets DSH_HOME to a temp dir, and makeTraceWriter prefers opts.home.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 /home/u/.dsh/storages/cot-form-b/trace.log 继续查，不要改测试聚合方式。
