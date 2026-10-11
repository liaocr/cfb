归因：`src/transport.js` 的 `assembleSseFrames` 看到 `[DONE]` 就合成 `finish = 'stop'`，上游没给 `finish_reason` 也算；`settle` 又按 `ok = finish != null || out.length > 0` 判成功——两处叠起来，只补 `[DONE]` 的断流就成了 ok=true 的 condensed，这就是截断被当成功写进会话的通路。

当前决定（第 4 轮原话）：只认真实 `finish_reason`，去掉 `done ? 'stop' : null`；`settle` 收成 `ok = finish != null`。两处改动都还没落到文件里。

已排除：`transport.legacy.js` 不是这次要改的地方——README 让先看它，但 `birth.js` import 的是 `./transport.js`；legacy 错在 `choices[1]` 下标，与本题无关。
已排除：拿 `npm test` 当验收不成立，任务写明「npm test 目前是绿的（测试没覆盖这个情况）」。

这一格没有待读的取证读数：第 4 轮说「Let me do edits and grep.」，两样都没发 ⇒ 欠的是把已定改法写出去，grep 只决定要不要顺带 legacy，不改上面的归因。

验收（第 4 轮推演过 4 条）：`[d('a'),d('b'),fin('stop'),'[DONE]']` 仍 ok true、`finish='length'` 仍 condensed、`[fin('stop'),'[DONE]']` 时 out='' 而 ok true、eventCount 仍 2；断流两条用例（只补 `[DONE]` → ok false、`birth.js` passthrough）还没写。

还没定：legacy 要不要一起修（第 4 轮的 grep 没发）。落地后再跑 `scripts/replay-truncated.mjs`；第 1–3 轮那 11 条不重走。
