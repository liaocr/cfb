# dsh-cot-form-b v11.5 审计（2026-09-23）

> 依据：`main@1134ed7` 源码 + 用户提供的真机 trace 汇总。仓库不含 trace.log，未能运行 analyze-efficiency.mjs。
> 行号均为 `1134ed7` 的 `index.js`。「已证实」= 可指到代码行或你给的 trace 数字；「推测」= 需要真机验证。

## 摘要

1. **最重要的一件事**：按缓存记账 `净收益 = (R−1)·d·(B−B′) − T − 5·B′`，在真实工程工况（95% 冗余）下压缩是正收益，但保本原长在 0.6K~43K 之间随 (d,R) 变化，而现行门槛只有 500/800 字符——**短块几乎都在亏，长块才该压**。建议先把 `birthMinChars` 提到 3K，并用一行 trace 补测 d。
2. 3 秒 TTFB 在代码侧确实已无可挤（已证实），但**有一个未被利用的免费窗口**：`gapMs p50 = 4ms` 说明 reasoning 的 `block-end` 几乎和 `finish` 同时到达——起火点可以从 block-end 提前到「第一个非 reasoning 块出现」（推测，需 1 个 trace 字段验证）。
3. 缺陷 C/D 是两个 10 行的修复，今天就能落。
4. 缺陷 B 在 `birthDeferredClaim:false` 下是**休眠的**，不要为它花时间；要么删掉整条 late-claim 路径，要么按块匹配修——不要两条都留。

---

## 一、压缩的收益判据（问题 2 + 缺陷 E）—— ROI 最高

**结论：压缩在真实工程工况（长思维链、~95% 冗余）下是正收益，但当前触发门槛（500/800 字符）远低于保本线——短块几乎都是亏的，长块才是该压的对象。门槛应由缓存折扣 d 与后续轮数 R 反解，并需补测 d。**

⚠ 数据口径：v11.5 的 `1610→555`（65.6%）来自当前「修改+测试+工具」短链工况，**不能**作为 ROI 基线；用户早期在真实工程会话上的实测是 **95% 冗余**（B′≈0.05·B）。当前 trace.log 全是短链，无法复核该数。

**逐轮记账（用户 2026-09-23 订正口径）**
B = 原思维链，B′ = 压缩稿，T ≈ 600 = 提示词模板，d = 缓存价/全价，R = 该块之后还在前缀里出现的轮数。
B 的那次全价预填两边都要付（只是从主请求挪到压缩请求），抵消。剩下：

```
净收益 = (R−1)·d·(B − B′)  −  T  −  5·B′
```
`5·B′` = 压缩稿按输出价生成一次（4×）+ 按全价进一次上下文（1×）。

**代入 B′ = 0.05·B（真实工况）**：`(R−1)·d·0.95·B − T − 0.25·B` ⇒ 回本条件 `(R−1)·d > 0.26 + T/B`

| d | 回本所需 R−1 |
|---|---|
| 0.022（L36-39 记录值） | 15 |
| 0.1 | 3.3 |
| 1 | <1 |

**反解保本原长**（v3 绝对目标把 B′ 钉在 ≈450，L297-298）：`B > 450 + 2850 / ((R−1)·d)`

| | d=0.022 | d=0.1 | d=1 |
|---|---|---|---|
| R=4 | 43K | 9.9K | 1.4K |
| R=16 | 9.1K | 2.4K | 0.64K |

**证据（已证实）**
- L36-39：`输入:输出:缓存 = 1:4:0.02`，`d_hit=0.0223`，`d_eff≈0.032`，注明来自 09-18 账单差分（checkpoint 时代）。
- L731-735 `passesHurdle`：`(raw−final)×R > T+raw+final` 隐含 d=1 且缺 4× 输出价项；L22 `R=4 保本原长 774` 由此而来。按上表它只在 d≈1 时成立。
- 现行门槛 `birthMinChars=500`（L2080）、`minRawChars=800`（L133）在表中**所有** (d,R) 组合下都低于保本线 ⇒ 当前短链工况下的大部分压缩调用是净亏的。
- 长块恰好也是缺陷 A/C 最集中的群体（timeout / finish=length 都随输入增长）。

**推测（需测）**
- birth 模式下的真实 d 可能与 checkpoint 时代不同（birth 逐条改写出站前的 assistant 消息；若 DSH 系统提示含随轮变化内容，d→1）。
- 95% 冗余在 v3 提示词下是否仍成立（v3 是 09-23 新上的，早期实测用的是 v1/legacy）。

**怎么测 d（不改行为）**：`birthTransform` 已透传宿主 `usage` chunk（selftest-birth T12）。在 L3116 `finish` 分支前加 `if (chunk.type==='usage') trace('host-usage', chunk.usage)`，跑 20 轮，`Σprompt_cache_hit / Σprompt_tokens` 即 1−d 的估计。

**建议方案**
1. `birthMinChars` 从 500 提到 **3000**（对应 d≈0.1、R≈16 一档，保守），把上表写进 DEFAULTS 注释；实测 d 出来后照表调。
2. `passesHurdle` 补上 `5·B′` 与 d 项，或删掉只留 `birthMinSavedChars`（它只防"越压越长"，语义正确）。birth 路径实际不调用 passesHurdle（只在 L3626 legacy 路径），所以主要是门槛 1。
3. 用一段真实工程会话的 trace 复核 95%：`birth-condensed.rawChars/outChars` 按 rawChars 分桶。
4. 上下文压力门控降级为可选保底（`d<0.05` 时才需要），不是主线。

**最坏情况**：门槛提高 = 短块不再压缩 = 退回宿主原生行为（已知安全态）；长块行为不变。

**前置问题（推测，一个数即可判定）**：DeepSeek 兼容 API 多轮默认不回传历史 `reasoning_content`。若宿主出站 payload 不含旧 reasoning，则 B−B′ 对上游为 0。看 L3909 `llm-stream.reasoningChars`：历史 assistant 消息（非最后一条）是否 >0。

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
`gapMs p50 = 4ms`（docs/archive/brief-cot-form-b-why-we-wait §1.2，n=293）意味着 reasoning 的 `block-end` 到 `finish` 只有 4ms。但一次带工具调用的回复里，reasoning 之后还要生成 tool-call 参数，通常几百毫秒到几秒。**两者只能有一个成立**：要么宿主 `dsh-llm` 的 BlockAssembler 把 reasoning 的 `block-end` 延迟到 finish 才发，要么这些回复几乎没有后续块。若是前者，`birthTransform` 在 L3080-3103 只在 `block-end` 起火就浪费了整段 tool-call 生成时间——而 earlyFire 路径（L4018-4021）早就知道「tool-call/text 的 block-start 一到，reasoning 必定已写完」。
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

- 已证实：事故机理在 docs/archive/phase2-settler-design.md:115-125——`tool-pairing.js` 对 `tool/result` 计 −1，对含 tool-call 的 assistant 计 +n；用 `user/message` 替换一个区间若切开了配对 ⇒ `corrupt surface`。这是 **surfaceOp replace + 换节点类型**才有的问题。
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

---

## 附：v11.6 第一批落地记录（2026-09-23，同分支提交）

审计后经三轮订正（`T/B` 项、绝对下界、滞回、`maxOutputTokens` 恒定、免费窗口双时刻、自适应缓做、工具结果已有工具层、分段压缩否决），第一批只做**已定且最坏情况明确**的项：

| 改动 | 位置 | 性质 | 最坏情况 |
|---|---|---|---|
| `birthMinChars` 500 → 3100 | `DEFAULTS` | 判定变化 | 短块不压 = 宿主原生行为 |
| `maxOutputTokens` 1200 → 850 恒定 | `DEFAULTS` | 判定变化 | 长块更易 `finish=length` ⇒ 原文放行（已有闸） |
| `timeoutMs ≥ finishWaitMs+2000` | `normalizeConfig`，仅 `mode:'birth' && birthDeferredClaim===false` | 只抬不降 | 线上 20000/12000 零变化 |
| 空白候选硬断言 | `birthFinish` → `pass('empty-candidate')` | 新增安全闸 | 无（只会更保守） |
| `birth-window-probe` | `birthTransform` | 纯观测 | 无 |
| `birth-econ`（`birthEconomics` 纯函数） | `birthStart`，`deps.pressure` 接 `emitter.readPressure` | 纯观测，**不判定** | 无；`econCharsPerTurn` 未配 ⇒ R 回落 60（2026-09-24 用户拍板） |
| `birth-condensed.fidelity` | `birthFinish`，复用 `rules.fidelity()` | 纯观测，**不拦截** | 无 |
| `analyze-efficiency.mjs` `windowProbe/economics/fidelity` | 离线 | 诊断 | 无 |

**未接管、等数据**：动态门槛（需 `econCharsPerTurn` 标定 + 滞回）、保真放行门槛（需离线分布 + 白付成本）、提前起火（需 `windowProbe.verdict==='window-exists'`）、hedged request / 缓存友好前缀（第二批）。

**自测**：新增 `selftest.mjs §23`（16 项）与 `selftest-birth.mjs T33`（10 项）；全量 1207 通过 / 0 失败 / 1 跳过。
受影响的既有夹具（`hybrid/grounding/efficiency/replay`）显式传 `birthMinChars: 100/1`，因为它们的原文不足 3100 字符且测的是别的东西。

**部署提醒**：真正加载点是 `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-cot-form-b`，需同步并重启。线上 profile 若显式写了 `birth.minChars: 500` 或 `maxOutputTokens: 1200`，会覆盖新默认值——请核对 `cordis.patch.yml`。

---

## 附录 B：v11.7 第二批落地记录（2026-09-23）

围绕缺陷 A（TTFB p50 3,109ms，排队型）的三条**请求侧无法挤、只能绕**的处置。全部缺省保守、可关、trace 可核。

| # | 变更 | 代码位置 | 缺省 | 期望收益 | 最坏情况 |
|---|---|---|---|---|---|
| 2a | 对冲请求 `hedgedDistill` | `index.js` `hedgedDistill`（`generateDistillation` 之前）；`execute` 里 `fn(...)` 改为 `hedgedDistill(fn,...)`；`requestOnce/requestStream` 新增 `onHeaders` | `distill.hedgeAfterMs = 0`（关） | 两次独立排队抽样取 min：若 TTFB 分布近似独立，p90 6~8s 段被砍到接近 p50；hedge 只在 > p50 时触发 ⇒ 约一半请求多发一份，但**头一到即 abort 另一份**，输出只付一份 | 触发那一半请求多付一次输入（≈0.3~1.5K tokens，0.02 价外的全价）；并发上限 +1（进程级计数器 `hedgeInFlight`） |
| 2b | 收尾宽限 `finishHeadersGraceMs` | `birthStart` 注册 `task.headersP/headersAt`（trace `birth-distill-headers`）；`birthFinish` 在 budget 到点后若 `headersAt !== null` 再等一次（trace `birth-finish-headers-grace`） | `birth.finishHeadersGraceMs = 1500` | 已证实 contentSpanMs 137~1,267ms：头到了以后放弃是最亏的一刻；宽限把「差 0.5s」的那批从 `distill-timeout` 拉回 `condensed` | 单次 finish 多阻塞 ≤1.5s 且仍失败；没收到头时**零**额外等待 |
| 2c | 缓存友好拆分 `compressSystemPrompt` | `splitCompressPrompt`；compress 包装器把 `{system,user}` 放进 `cfg._promptMessages`；`distillOnce/Stream` 用它组 messages；`compressPromptVersion` 追加 `:sys` | `false` | DeepSeek 官方 kv_cache 文档：缓存以「前缀单元」整段匹配，system+user 形状是 Example 1 的标准命中形；规则段 ≈288 tok 每次按 0.02 价 ⇒ T 从 ≈460 tok 降 ≈180 tok，`ρ_max`/`B_min` 随之下移（约 −25%） | 模型对 system/user 拆分的输出可能与单段略有差异 ⇒ 必须走 `:sys` 分桶 A/B（fidelity.byPromptVersion 已自动分桶）后再决定常开 |

**为什么 4xx/5xx 的响应头不算**：自测抓出——对冲份瞬时 503 若算「回头」，会掐掉健康的主份。故 `onHeaders` 只在 `status === 200` 时宣布胜出/上报。

**真机核验清单**（打开 `hedgeAfterMs: 3000` 后跑一天）：
1. `analyze-efficiency.mjs` 新增 `hedge`（fired / hedgeWon / ttfb 分布）与 `headersGrace`（rescued / waitedMs / headersSinceFiredMs）。
2. 目标：`hedge.hedgeWon / hedge.fired ≥ 0.3` 且 `birth-distill-settled` 的 ttfb p90 明显下移；否则关掉（说明排队不独立，对冲无效）。
3. `headersGrace.rescued / samples` 即宽限净救回率；若 ≈0 说明 budget 到点时几乎都还没收到头 —— 那就是纯排队问题，宽限无害但无用。
4. 打开 `compressSystemPrompt: true` 后看 `usage.prompt_cache_hit_tokens` 是否从 0 变为 ≈规则段 token 数，且 `fidelity.byPromptVersion['…:sys']` 不低于原桶。
