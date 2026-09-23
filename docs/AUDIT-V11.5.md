# dsh-cot-form-b v11.5 审计（2026-09-23）

> 依据：`main@1134ed7` 源码 + 用户提供的真机 trace 汇总。仓库不含 trace.log，未能运行 analyze-efficiency.mjs。
> 行号均为 `1134ed7` 的 `index.js`。「已证实」= 可指到代码行或你给的 trace 数字；「推测」= 需要真机验证。

## 摘要

1. **最重要的一件事**：压缩是否回本只取决于一个没测过的量——birth 模式下宿主主请求的真实缓存折扣 `d_eff`。净收益 = `(R−1)·d·(B−B′) − T − 5·B′`：d≈0.02 时要 150 轮才回本，d≈1 时 4 轮即回本（正是现有门槛）。代码里的 0.022 是 checkpoint 时代测的。**先用一行 trace 把它测出来**，再决定是加压力门控还是维持现状。
2. 3 秒 TTFB 在代码侧确实已无可挤（已证实），但**有一个未被利用的免费窗口**：`gapMs p50 = 4ms` 说明 reasoning 的 `block-end` 几乎和 `finish` 同时到达——起火点可以从 block-end 提前到「第一个非 reasoning 块出现」（推测，需 1 个 trace 字段验证）。
3. 缺陷 C/D 是两个 10 行的修复，今天就能落。
4. 缺陷 B 在 `birthDeferredClaim:false` 下是**休眠的**，不要为它花时间；要么删掉整条 late-claim 路径，要么按块匹配修——不要两条都留。

---

## 一、压缩的收益判据（问题 2 + 缺陷 E）—— ROI 最高

**结论：压缩是否回本，完全取决于一个当前没有实测值的量——birth 模式下宿主主请求的真实缓存命中折扣 `d_eff`。代码里的 0.022~0.032 是 checkpoint 时代测的。必须先补测它；在它出来之前，birth 路径应加上下文压力门控作为保底。**

**逐轮记账（用户 2026-09-23 订正后的口径）**
设 B = 原思维链，B′ = 压缩稿，T = 提示词模板（≈600 字符），d = 缓存命中价/全价，R = 该块之后还会出现在前缀里的轮数。

| | 不压缩 | 压缩 |
|---|---|---|
| 压缩调用 | — | 输入 `T + B` 全价；输出 `B′` 按 4× 价 |
| 第 N+1 轮 | 预填 `B` 全价 | 预填 `B′` 全价 |
| 第 N+2 … N+R 轮 | 每轮 `B·d` | 每轮 `B′·d` |

`B` 的那次全价预填两边都要付（只是从主请求挪到了压缩请求），相互抵消。相减得：

```
净收益 = (R−1)·d·(B − B′)  −  T  −  5·B′
```
`5·B′` = 压缩稿按输出价生成一次（4×）+ 按全价进一次上下文（1×）。**大头不是输入，是压缩稿自己的生成费。**

代入 v11.5 实测均值 `B=1610, B′=555`（12,879→4,436 / 8）：
- `d = 0.022`（L36-39 记录值）：每轮省 23，一次性付 3,375 ⇒ **R−1 > 147**，必亏。
- `d = 0.3`：每轮省 317 ⇒ R−1 > 10.6。
- `d = 1`（前缀从不命中）：每轮省 1,055 ⇒ R−1 > 3.2，即 **R > 4，正是现有 `hurdleRounds=4` 门槛的来源**（L22, L135）。

**证据（已证实）**
- L36-39：`输入:输出:缓存 = 1:4:0.02`，`d_hit=0.0223`，`d_eff≈0.032`，注明来自 09-18 账单差分（docs/d-eff-result.md，仓库里不存在该文件）。那是 checkpoint 时代的会话形态。
- L731-735 `passesHurdle` 的 `(raw−final)×R > T+raw+final` 隐含 `d=1`，且没有 `4×` 输出价项。它与 L36-39 的参数不一致——**但只要 birth 模式下真实 d_eff 接近 1，它就是对的。**
- birth 路径不看压力：`birthStart` 只有 `birthMinChars=500` 固定门槛（L2080, L2104）；`emitter.js:283-286` 的 `readPressure/minRawCharsFor` 只在 checkpoint 路径生效。

**推测（决定性、必须先测）**：birth 模式下前缀命中率可能远低于 checkpoint 时代——原因是 birth 在**每条** assistant 消息出站前改写它，若同一条消息在流式装配期间已被宿主以原文形态发过任何一次（例如 GUI 中间态、子 agent、标题生成），前缀就断了。此外 DSH 若在系统提示或首条 user 消息里放了随轮变化的内容（时间戳、token 计数），d 也会趋向 1。这两点代码里看不出来，只有 trace 能回答。

**怎么测 d_eff（不改插件、不发请求）**
宿主主请求的 usage 不经过本插件，但压缩请求的经过：`birth-distill-settled.providerReportedUsage`（L3234）带 `prompt_cache_hit_tokens`。它对 d_eff 没有直接意义（压缩 prompt 每次都新）。真正需要的是**宿主主请求**的 `prompt_cache_hit_tokens / prompt_tokens`，需在 `llm/stream` 钩子里读宿主响应 usage——`birthTransform` 已透传 `usage` chunk（selftest-birth T12「tool-call/usage 原样透传」），加一行 trace 即可：在 L3116 `finish` 分支前，若 `chunk.type==='usage'` 则 `trace('host-usage', chunk.usage)`。跑 20 轮，算 `1 − Σhit/Σprompt` 的加权值就是 d_eff 的上界。

**建议方案（按测出的 d_eff 分叉）**
- `d_eff < 0.1`：压缩在费用上必亏，只能以上下文余量立项 ⇒ birth 接压力门控（`ratio < 0.5` 不压），并把 `passesHurdle` 改成上式或删掉，只留 `birthMinSavedChars`。
- `d_eff > 0.3`：现有 R=4 门槛基本合理，第一节降级为「补上 4× 输出价项」的小修，优先级回到第二节 TTFB。
- 无论哪种：BOOT trace 里输出 `d_eff` 实测值与采样轮数，以后每次改价格模型都有依据。

**还有一个前置问题（推测）**：DeepSeek 兼容 API 多轮对话默认**不回传历史 `reasoning_content`**。若宿主出站 payload 里不含旧 reasoning，则 `B−B′` 对上游为 0，压缩只影响本地 surface / compaction 阈值。探针已在：L3909 `llm-stream.reasoningChars`。**看历史 assistant 消息（非最后一条）是否 >0**，这一个数决定整条链路对上游 token 有没有影响。

**还有一个前置问题必须先查（推测）**：DeepSeek 兼容 API 在多轮对话里**默认不回传历史 `reasoning_content`**。若宿主出站 payload 里根本不含旧 reasoning，则 `raw−out` 的节省为 0，压缩只影响本地 surface。代码已埋了探针：L3909 `llm-stream.reasoningChars: msgs.map(reasoningTextOf(m).length)`。**请在 trace 里看 `llm-stream` 事件：除最后一条 assistant 外，历史消息的 reasoningChars 是否 >0。** 若全为 0，整条压缩链路对上游 token 零影响，只剩「宿主本地 compaction 阈值」这一个收益。

**建议方案**
1. birth 路径接入压力门控：在 `birthStart` 增加 `deps.pressure()`（复用 `emitter.js readPressure` 的 `usedTokens/contextWindow`），`ratio < birthPressureFloor（建议 0.5）` 时 `belowFloor=true, why='no-pressure'`，零调用零等待。
2. `passesHurdle` 改为上式，或干脆删掉字符保本判定，只保留 `birthMinSavedChars`（它只防"越压越长"，语义正确）。
3. 在 BOOT trace 里输出 `llm-stream` 历史 reasoningChars 的汇总，把「上游是否重发 reasoning」变成可核事实。

**最坏情况**：门控打开后大多数轮不压缩 = 退回宿主原生行为，这是已知安全态。门控只能减少调用，不会引入新的替换路径。

---

## 二、缺陷 A：TTFB 3 秒

**结论**：请求侧确实干净（已证实），3 秒来自上游首 token 之前；**代码里无法确定是什么**，但可以用两组 A/B 一次分清；同时有一个与 TTFB 无关、能白捡时间的窗口。

**证据（已证实）**
- 请求形状 L1401-1408：`temperature:0, max_tokens:1200, stream:true, thinking:{type:'disabled'}`，单条 user 消息；头部 L1415-1421 无压缩、`Content-Length` 明确。
- `ttfbMs` 定义 L1078-1079 = 响应头到达时间；SSE 下响应头通常在首 token 前才被网关放出，所以它就是「上游首 token 前」。
- 09-15 关思考实验（L250-256）：`thinking disabled` 总时长 3,746ms，content 401；09-21 三组预热对照（L216-220）总 p50 1,827ms。⇒ **同一端点、同一请求形状，不同日期 1.8s ~ 3.7s**，是上游侧波动，不是我们端的常数。

**推测（需 A/B）**
- H1：商户网关把 `thinking:{type:'disabled'}` 或 `temperature:0` 的请求路由到不同的上游池（L291 注释已记录过「按模型名路由错配 ⇒ 40 次全超时」，说明该网关**确实按请求参数路由**）。
- H2：宿主自己的请求首 token 快，是因为宿主请求前缀命中缓存（`prompt_cache_hit_tokens` 大），我们的每次全新 ⇒ 排队优先级不同。

**判别实验（各 5 次，在 `deploy/` 下写一个 probe 即可，不改插件）**：
① 同一 prompt，`thinking disabled` vs 不带 thinking 字段（用 `max_tokens` 大一点防 length）；② 同一 prompt 连发两次看第二次 `prompt_cache_hit_tokens>0` 时 TTFB 是否骤降；③ 把 prompt 前缀固定为一段 1K 的常量文字（人为制造缓存命中）。任一组差 >1s 即定位。

**与 TTFB 无关的免费窗口（推测，ROI 高）**
`gapMs p50 = 4ms`（docs/brief-why-we-wait §1.2，n=293）意味着 reasoning 的 `block-end` 到 `finish` 只有 4ms。但一次带工具调用的回复里，reasoning 之后还要生成 tool-call 参数，通常几百毫秒到几秒。**两者只能有一个成立**：要么宿主 `dsh-llm` 的 BlockAssembler 把 reasoning 的 `block-end` 延迟到 finish 才发，要么这些回复几乎没有后续块。若是前者，`birthTransform` 在 L3080-3103 只在 `block-end` 起火就浪费了整段 tool-call 生成时间——而 earlyFire 路径（L4018-4021）早就知道「tool-call/text 的 block-start 一到，reasoning 必定已写完」。
- 验证字段：在 `birthTransform` 里记录「第一个非 reasoning 块的 `block-start` 时间 → 该 reasoning 的 `block-end` 时间」差值。**> 1s 即成立。**
- 若成立：在收到第一个其它类型 `block-start` 时，用 `held` 里已累积的 `h.text` 提前 `birthStart`（block-end 到达时只补 `task.end`）。多块回复里替换点仍在 block-end，出站顺序不变。
- 最坏情况：提前起火后 reasoning 又来了 delta（协议上不应发生）⇒ 文本不一致 ⇒ 必须走「原文放行」并 trace。用 `h.text === task.raw` 在 block-end 处硬校验即可。

---

## 三、缺陷 C + D：两个 10 行修复

### C. `empty distillate (finish=length)`
- 已证实：`maxOutputTokens: 1200` 固定（L232）；v3 第 8 条「宁可超出目标，不得删除」（L556）在 15K 输入下直接鼓励超长；`requireCompleteDistill`（L1375-1387）把 length 判为失败——**判定是对的，预算是错的**。
- 方案：`maxOutputTokens = clamp(600, 1200 + ceil(inputChars/4), 4000)`，在 `generateDistillation` 里按 `inputChars` 派生；同时在 `birth-distill-settled` 已有 `outputChars` 字段可监控。
- 最坏情况：输出更长 ⇒ 被 `birthMinSavedChars` 拦下原文放行；费用上限可控（4000 tokens）。

### D. `timeoutMs` 与 `finishWaitMs` 脱钩
- 已证实：`normalizeConfig` L376 只做字段映射，没有关系校验；`requestOnce/requestStream` 用 `cfg.timeoutMs` 硬杀（L843, L960）；`birthFinish` 用 `birthFinishWaitMs`（L2512）。两者互不知晓 ⇒ 23.1% 命中率对 finishWaitMs 完全不敏感。
- 方案：`normalizeConfig` 里若 `timeoutMs < birthFinishWaitMs + 500` 则自动抬高 `timeoutMs` 并在 BOOT 里打 `configAdjusted`。不改任何语义，只消灭一个必踩的坑。

---

## 四、缺陷 B / G 与终点架构（问题 5）

**结论：两条路只能留一条。按你的硬约束（正确性 > 速度），留「当轮阻塞」，冻结或删除 late-claim。**

**证据**
- B 已证实：L2349-2353 注释、`coverageMatch` L2388-2410、`reasoningTextOf` L586-589。修法我上轮已给（`rawOf` 回调能拿到 `msg.content` 块数组，按块精确匹配，不切 `'\n'`）。
- 但 `birthDeferredClaim:false` 时：`readyOnly=false`（L2505）、`pushLateMemory` 不调用（L2399 条件）、pre-step 直接 `skip-mode-birth`（L3694 上方）。**B 与 G 全部休眠。**
- late-claim 路径自带的额外复杂度：`lateMemory`+`peekLateMemoryPartial`+`claimScope`+`ack`+`birthCancelOnGiveUp` 分支（L2477-2486）+ keepTail 一轮滞后 + 替换已出站块的缓存断裂争议（docs/brief-late-claim §4，至今无定论）。
- 当轮阻塞的最坏情况是**确定的**：等满 `finishWaitMs` 后原文放行；late-claim 的最坏情况是「部分认领 / 歧义匹配 / 重启丢失」，都需要额外守卫。

**建议**：① 做第一节的压力门控后，阻塞只发生在真正需要压缩的少数轮；② 把 `birthDeferredClaim` 默认改为 `false`，与线上一致（现在 DEFAULTS L184 是 `true`，README 与线上配置相反）；③ late-claim 代码保留但在 BOOT 标记 `experimental`，不再修 B，直到有人真的要重新启用它。

---

## 五、压推理还是压工具结果（问题 3）

**结论：09-18 事故的根因是「替换手段」不是「替换对象」；用 birth 式（出站前、同节点类型）改写工具结果不会触发那个不变式。但工具结果**首次**必须让模型看全文，所以只能在第二次出站前压——那就又回到了「改已出站内容」的缓存/一致性问题。当前不建议动。**

- 已证实：事故机理在 docs/phase2-settler-design.md:115-125——`tool-pairing.js` 对 `tool/result` 计 −1，对含 tool-call 的 assistant 计 +n；用 `user/message` 替换一个区间若切开了配对 ⇒ `corrupt surface`。这是 **surfaceOp replace + 换节点类型**才有的问题。
- 已证实：L2631 `toolBlockChars 25~28K 每轮几乎不变` 这句话本身就说明它们**是前缀缓存的最佳受益者**（不变 ⇒ 命中 ⇒ 0.022 价）。按第一节的判据，压它们的费用收益同样 ≈ 0，收益仍只是余量。
- 推测：如果要做，正确形态是「tool/result → 更短的 tool/result（同 toolCallId）」的同类型替换，配对计数不变；但需要在 `dsh-compaction` 里确认 replace 后 shadowed 节点是否仍参与计数。这是一个独立项目，不该在 cfb 里做。

---

## 六、保真度怎么测（问题 4）

**结论：有一个可自动化、可复现、不依赖模型的必要条件度量——「逐字标识符召回率」，它直接对应提示词第 3 条；「待定标记出现率」只能做第二指标。**

- 已证实：v2/v3 规则 3（L495）要求路径、文件名、命令、变量名、数字、错误信息**逐字保留**；原文在 CAS（`archive` L2xx），压缩稿在 `birth-distill-settled.distilledText`（L3619，截 4000）。两端都有。
- 度量：从 raw 抽取 `路径/文件名(含扩展名)/反引号内容/连续数字≥3位/以 Error|错误 开头的行`，统计在 out 中逐字出现的比例；再对 `尚未确定|待验证|两种可能|备选|未采用` 统计 raw 与 out 的计数比。两者都可离线在 `analyze-efficiency.mjs` 里加一个 `fidelity` 段，按 promptVersion 分桶。
- 够不够：**不够**——它测不出「结论被升级/推理链断裂」。那一层只能用 replay（同一会话开/关压缩比较下游动作），`replay.mjs` 头注释已经写明它做不到主 agent 重放。所以标识符召回率是**放行门槛**（<95% 直接判失败、原文放行），不是质量证明。

---

## 七、我不建议做的事

1. **不建议为把 TTFB 压到几百毫秒而重构传输层**（换 fetch、HTTP/2、预热）。L216-220 三组对照已经证明预热是负收益；请求侧已无可挤。先做第二节的 A/B，没定位前任何传输改动都是盲改。
2. **不建议现在修缺陷 B。** 它休眠，修了没有生产收益，还会给一条准备冻结的路径加代码。
3. **不建议压工具结果。**（第五节）
4. **不建议把 v3 目标改成更小的绝对值来提高压缩率。** 收益模型（第一节）说明压缩率再高 30% 也回不了本；保真规则第 8 条是对的，别碰。
5. **不建议拆 `index.js`** 作为这一轮的事。4,051 行是维护问题不是正确性问题；在收益判据没定之前拆分只会让 diff 无法审。
6. **不建议继续以字符数汇报「节省」。** L41-44 自己已写明「字符不是钱」。建议 trace 里加一个字段直接说明 `accounting: 'context-headroom-not-cost'`（`birth-claim-acknowledged` 已有类似写法 L3762）。

---

## 需要你从 trace.log 补的 3 个数（我拿不到文件）

1. `llm-stream` 事件里 `reasoningChars` 数组：**历史 assistant 消息（非最后一条）是否 >0**？决定第一节的前提。
2. 任意 5 次带 tool-call 的回复：reasoning `block-end` 时间戳与该流第一个 `tool-call` block-start 的时间差（需临时加一行 trace，或从 `birth-fired` 与 `llm-stream` 的时间粗算）。决定第二节的免费窗口是否存在。
3. `birth-distill-settled` 里 `ok=true` 样本的 `providerReportedUsage.prompt_cache_hit_tokens` 是否恒为 0，以及 `ttfbMs` 与 `promptChars` 的相关性（若无关 ⇒ 排队，支持 H1/H2）。

有这 3 个数，第一、二节的「推测」就能全部落成「已证实」或被否掉。
