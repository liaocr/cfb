本轮增量：
- 线上 trace 读数：「[compiler-transport-settled] {"ok":true,"finish":"stop","stream":true,"outputChars":212,"eventCount":9}」（延续段第 1 轮 trace/last.log）。这行显示 finish 为 stop，所以它本身不能证明流被截断。
- 推理链读到：finish 字段由 `finish || (done ? 'stop' : null)` 派生，[DONE] 会被记成 stop（推理链的阅读，尚未在 src/transport.js 中逐行核对）。
- 未解：docs/gateway.md 中"正常结束"的定义尚未在工具回显中逐字确认；是否存在 finish 为 null 而内容完整的合法情况，未验证。
- 闭合判读（读数 ⇒ 结论）：若 `node scripts/replay-truncated.mjs` 对一条被切断的流打印 finish 为 stop，则说明 done 派生是问题来源。若打印 finish 为 null 而 ok 仍为 true，则说明 settle 的 ok 判定还有另一条路径，需回到 src/transport.js。
- 验收：修改后运行 `node scripts/replay-truncated.mjs` 与 `npm test`，看到 replay 对截断流打印 ok:false、npm test 全部通过，即算完。
