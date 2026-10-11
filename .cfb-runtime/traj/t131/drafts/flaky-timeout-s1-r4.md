本轮增量：
- 读数仍是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log）。
- 推理链读到：客户端在计时器触发时仍未收到响应，因此按定义 hedge 的启动并不算错。断言只在客户端于 100ms 内处理完响应时才成立（推理链的推断）。
- 未解：package.json 的 test 脚本指向 verify.mjs，而推理链读到该文件不存在，这一点未核实；src/distill.js 的完整实现也未核实。
- 闭合判读（读数 ⇒ 结论）：若把主请求的延迟改为远小于 1600ms，并在 2 核下重跑，hedgeStartedAt 仍不为 null，则说明测试假设（固定 100ms 余量）本身有误。若 hedgeStartedAt 变为 null，则说明失败只来自余量太小。
- 验收：分开运行 `node test/hedge.selftest.mjs` 三次，看到三次全部通过且 hedgeStartedAt 始终为 null，即算完。
