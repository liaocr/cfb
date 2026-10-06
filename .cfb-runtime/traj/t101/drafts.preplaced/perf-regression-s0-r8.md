已落定的决定（原文逐字）：「So the fix: revert compressTargetMax to 450, keep maxOutputTokens 4096 (since outputTokens 1150 < 4096 and finishReason stop, no truncation issue).」

落点：package.js（只动这一处；其余路径原文已自证不必动：「Hmm, but the repo is tiny and there's no code that actually uses these.」）

原文还悬着这句，但它不阻塞落 edit：「Now, is the cause maxOutputTokens or compressTargetMax?」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 package.js 继续查，不要改测试聚合方式。
