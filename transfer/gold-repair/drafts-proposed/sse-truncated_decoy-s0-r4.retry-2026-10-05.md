第 4 轮定了诊断与改法，edits 一条没发。

归因：`src/transport.js` 的 `assembleSseFrames` 看到 `[DONE]` 就合成 `finish = 'stop'`，上游没给 `finish_reason` 也算；`settle` 又按 `ok = finish != null || out.length > 0` 判成功。两处叠起来，只补 `[DONE]` 的断流就成了 ok=true 的 condensed——这就是截断被当成成功写进会话的通路。

当前决定（第 4 轮原话）只认真实的 `finish_reason`，去掉 `done ? 'stop' : null` 兜底；`settle` 收成 `ok = finish != null`，去掉 `|| out.length > 0`。两处都还没落到 `src/transport.js`。

已排除：`transport.legacy.js` 不是这次要改的地方——README 让先看它，但 `birth.js` 实际 import 的是 `./transport.js`；legacy 的毛病是 `choices[1]` 取错下标，与本题不是一件事。
已排除：拿 `npm test` 当验收不成立，任务里写明「npm test 目前是绿的（测试没覆盖这个情况）」。

验收（第 4 轮推演的 4 条）：`[d('a'),d('b'),fin('stop'),'[DONE]']` 仍 ok true；`finish='length'` 仍 condensed；`[fin('stop'),'[DONE]']` 时 out='' 而 ok true；eventCount 仍 2。断流两条用例（只补 `[DONE]` → ok false、`birth.js` 走 passthrough）还没写。

还没定：legacy 要不要一起修——第 4 轮说先 grep 看它被谁引用，这个 grep 没发。落地后再跑一次 `scripts/replay-truncated.mjs`；第 1–3 轮那 11 条不重走。
