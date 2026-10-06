已落定的决定（原文逐字）：「So the birth test deliberately uses CFB_REAL_DSH_HOME instead of the isolated DSH_HOME.」

落点：/home/u/.dsh/storages/cot-form-b/trace.log（只动这一处；其余路径原文已自证不必动：「But the actual EACCES is permission denied on the trace.log owned by root (created by root, mode 0644, so user u can't append).」）

原文还悬着这句，但它不阻塞落 edit：「But birth.selftest.mjs calls makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME }).」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 /home/u/.dsh/storages/cot-form-b/trace.log 继续查，不要改测试聚合方式。
