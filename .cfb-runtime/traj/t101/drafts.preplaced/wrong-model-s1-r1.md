已落定的决定（原文逐字）：「The fix: use n.model (current session model) as the primary source, falling back to options.model only for old hosts.」

落点：host-follow.js（只动这一处；其余路径不动）

原文还悬着这句，但它不阻塞落 edit：「The fix: use n.model (current session model) as the primary source, falling back to options.model only for old hosts.」

验收：跑 `node scripts/smoke-session.mjs`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 host-follow.js 继续查，不要改测试聚合方式。
