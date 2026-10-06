已落定的决定（原文逐字）：「The fix: observe should also consider n.model (the current session's model), and callConfig should use the current session's model.」

落点：host-follow.legacy.js（只动这一处；其余路径原文已自证不必动：「The bug is that it's a module-level variable that persists across sessions and doesn't get updated when options.model is absent.」）

原文还悬着这句，但它不阻塞落 edit：「In host 0.9, options.model is undefined, so lastModel never updates for the new session.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 host-follow.legacy.js 继续查，不要改测试聚合方式。
