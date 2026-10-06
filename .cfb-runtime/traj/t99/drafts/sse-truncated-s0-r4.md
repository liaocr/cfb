已落定的决定（原文逐字）：「So settle ok = r.finish != null.」——把 `|| r.out.length > 0` 这个兜底一起去掉，否则只有正文、没有结束信号的截断流仍会被判 ok。落点是 transport.js 的 assembleSseFrames 与 settle：finish 继续取 finish || null，done 只作为信息暴露，不再参与 ok 判定。

关于 npm test 会不会收集新用例这件事，原文此刻还悬着，但它不改变上面的判定：改完跑一次就看得境。

验收：跑 `npm test`。若合计行是 0 失败 ⇒ 说明 settle 收紧没破坏既有用例，判已修好，可写结论；若截断相关的用例仍判 ok 或出现失败 ⇒ 说明结束信号还在别处被当成 ok（比如 done 分支），要回到 settle 的判定继续查。
