已落定的决定（原文逐字）：「Fix: host-follow should observe the current normalized request n.model as the source of truth, using options.model only as fallback for old hosts.」

落点：host-follow.js（只动这一处；其余路径原文已自证不必动：「Better design: make callConfig accept (options, n) so it doesn't depend on order, but plugin calls with options only.」）

原文还悬着这句，但它不阻塞落 edit：「For session 2: observe(options={stream:true}, n={seq:12,model:'deepseek-v3.2'}) -> lastModel='deepseek-v3.2'.」

验收：跑 `node scripts/smoke-session.mjs`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 host-follow.js 继续查，不要改测试聚合方式。
