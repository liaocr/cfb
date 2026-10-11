本轮增量：
- 失败读数是「expected hedgeStartedAt=null, got 1712」（延续段第 1 轮 ci/last5.log 的回显）。
- 推理链读到：主请求在 1500ms 结算，hedge 计时器在 1600ms 触发。1712 说明计时器到 1712 才触发，那时主请求仍未结算（推理链的推断，未在工具回显中核对 src/distill.js 的完整逻辑）。
- 未解：src/distill.js 的实现细节，以及 CI 只在 2 核时失败的原因，均未验证。
- 闭合判读（读数 ⇒ 结论）：若在 2 核或加压条件下重跑，hedgeStartedAt 不为 null，则说明失败由计时器延迟造成，而不是实现逻辑。若重跑时 hedgeStartedAt 始终为 null，则说明失败原因在别处，需要回到 ci/last5.log 的其他运行。
- 验收：在 2 核或加压条件下，分开多次运行 `node test/hedge.selftest.mjs`，看到全部通过且 hedgeStartedAt 始终为 null，即算完。
