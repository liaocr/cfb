已落定的决定（原文逐字）：「The fix: observe should use n.model (current session's normalized request model), falling back to options.model for old hosts.」

落点：host-follow.js（只动这一处；其余路径原文已自证不必动：「But within the same plugin instance across sessions it's also wrong because observe ignores n.」）

原文还悬着这句，但它不阻塞落 edit：「Also callConfig(options) should maybe accept n.」

验收：跑 `node scripts/smoke-session.mjs`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 host-follow.js 继续查，不要改测试聚合方式。
