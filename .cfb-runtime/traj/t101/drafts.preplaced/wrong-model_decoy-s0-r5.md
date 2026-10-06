已落定的决定（原文逐字）：「Fix: use current session model n.model preferentially, and make state per-instance (avoid leaking across plugin instances).」

落点：./host-follow.js（只动这一处；其余路径原文已自证不必动：「Also verify.mjs referenced in package.json doesn't exist?」）

原文还悬着这句，但它不阻塞落 edit：「Keep legacy behavior for old host that passes options.model.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 ./host-follow.js 继续查，不要改测试聚合方式。
