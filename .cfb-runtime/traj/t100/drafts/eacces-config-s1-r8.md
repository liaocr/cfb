已落定的决定（原文逐字）：「The fix: the test should use the isolated DSH_HOME provided by the harness, i.e.」

落点：/home/u/.dsh/storages/cot-form-b/trace.log（只动这一处；其余路径原文已自证不必动：「No wait: opts.home || process.env.DSH_HOME.」）

原文还悬着这句，但它不阻塞落 edit：「If that env var is undefined, makeTraceWriter falls back to process.env.DSH_HOME?」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 /home/u/.dsh/storages/cot-form-b/trace.log 继续查，不要改测试聚合方式。
