已落定的决定（原文逐字）：「So it appears settled ok:true with finish 'stop', and content is truncated but treated as success.」

原文已自证不必动：「For a truncated stream with only [DONE] and no finish_reason, assembleSseFrames sets finish = 'stop' because done is true.」

原文还悬着这句，但它不阻塞落 edit：「So it appears settled ok:true with finish 'stop', and content is truncated but treated as success.」

验收：跑 `npm test`。若不再报 原判定失败 ⇒ 说明改动已生效，判这条修好；若仍报 ⇒ 说明兜底或旁路还在，要回到 上面的落点 继续查，不要改测试聚合方式。
