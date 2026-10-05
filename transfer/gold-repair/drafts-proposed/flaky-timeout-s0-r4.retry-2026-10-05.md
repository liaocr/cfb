第 4 轮只做了取证，没有把实现怎么动定下来，本稿不替它定。

已观察到的事实：`src/distill.js` 里 `hedgedDistill` 用 `primarySettled` 当门闩——置位发生在 `primary.then` 的微任务里，`setTimeout` 到 `cfg.hedgeAfterMs` 时若门闩仍是 false 就走 `startHedge`，`hedgeStartedAt` 于是记成非空。这次用例是主请求 1500ms 回 200、`hedgeAfterMs` 1600，名义余量只有 100ms。`ci/last5.log` 里 5 次跑 2 次 FAIL，两次的报错都是「§4 对冲在主请求 200 之后不得再发  expected hedgeStartedAt=null, got 1712」。

已排除：定时器提前触发这条不成立。负载重的机器上 1600ms 的定时器只会迟到，而它迟到时主请求早已 settled、门闩已经是 true，`hedgeStartedAt` 该是 null——和 CI 上的 got 1712 正好相反，所以"定时器早于主请求"不能解释症状。
已排除：`fetch` rejects 时 `primary.then` 不执行、留下一条未处理的 rejection 这条与本症状无关，因为回包状态是 200，第 4 轮读到的失败信息里也只有 hedgeStartedAt 一项断言不过。
已排除：拿核数差（16 核 vs 2 核）直接定罪这条也不成立，第 4 轮还没拿到能区分两者的读数。

还站得住但没验证的怀疑：连接建立本身要时间，请求晚到一步，服务端那 1500ms 就整体往后挪，100ms 的余量被吃掉就翻。它能解释"偶发"，代价是第 4 轮没量过 connect 那一段，所以只能当怀疑带着。

本轮增量：第 4 轮发出的两条 bash 还没回显——一条查 node 版本与核数并把 `src/distill.js` 打出来，一条把同一个用例连跑 8 次、看每次 `hedgeStartedAt=` 打的是什么。这两条的回显是下一轮的第一手依据：8 次里出现非空值，说明本地就量得出来，事情就往"置位与定时器之间的先后不能靠微任务"上想；8 次全是 null，说明本地这台机器量不出来，得换成能把事件循环压住的方式再试，此时无论看什么都还不够动手。

写法上的坑（已排除，不重走）：第 2 轮两次用 shell 循环拼命令都没读到内容，回显是「bash: 该沙箱不支持 shell 循环，请直接跑单条命令」，所以 `for f in src/*` 这类拼法排除掉，看文件用单条命令。第 1 轮的 `ls -la` 与 `cat ci/last5.log 2>/dev/null | head -200`、第 3 轮的 `cat package.json`、`cat test/hedge.selftest.mjs` 都拿过结果了，不重跑。

还没定：`test/hedge.selftest.mjs` 里那句注释（主请求 200 之后不得再发）与 `hedgeAfterMs` 取 1600 的关系——是测试把余量贴得太脸，还是实现真有时序依赖——第 4 轮没定下来；`src/distill.js` 与 `test/hedge.selftest.mjs` 两处一个都没动过。
