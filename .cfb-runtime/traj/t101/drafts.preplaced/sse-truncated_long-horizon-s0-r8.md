已落定的决定（原文逐字）：「So the fix: finish should be finish (the real finish_reason) possibly null.」

落点：src/transport.legacy.js（只动这一处；其余路径原文已自证不必动：「- Truncated stream (only [DONE], or no ending signal at all) → settled ok:false and birth passthrough.」）

原文还悬着这句，但它不阻塞落 edit：「return { out, finish: finish || (done ?」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 src/transport.legacy.js 继续查，不要改测试聚合方式。
