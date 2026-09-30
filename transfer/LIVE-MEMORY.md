# LIVE-MEMORY（实时记忆；上下文压缩后**先读这个**）

> 用途：一个人跑长任务时的工作记忆。只记「下一步要用到的」：状态、决定、坑、下一步。不记过程流水（那些在 CHANGELOG / EFFECT-EVAL 里）。
> 每到一个里程碑就改写本文件（覆盖旧状态，不追加流水）。读它的成本要 < 1 分钟。

## 0. 用户给的流程（铁律）
理论 → 实现 → 出问题先归因（理论问题 / 实现问题）→ 理论问题先修理论、实现问题直接改 → 继续。每次测试少一点。留痕但不堆垃圾。
用户很久不在：一个人把 2a + 2b + 2c 做完；多轮先手写压缩稿到我认为的多轮上限，再训练副模型达到手写水平。
其余铁律：秘密在 /home/user/.secrets/keys.env；改代码后 manifest + verify 全绿再 commit；作者 cfb-cleanup <cleanup@local>；只 ff push 到 arena/01a0eba2-cfb；副模型 = 主模型关思考；评测一律 --require-fp。

## 1. 现在的状态（2026-09-29 晚，第五会话末段）
- 仓库 /home/user/cfb @ 31dcdf0（已推）。单步稿 v4d6 两份独立自动稿 8.5 / 8.6（oracle ≈ 8.3–8.9）⇒ **单步这条线到头，不再调**。
- 目标：多轮。四个弊端 = 边写边猜前后脱节 / 技术能跑掩盖全错 / 盲目归因死锁内耗 / 言过其实眼高手低。单轮尺子测不到它们。
- 计划：2a（真机到位率复测 + 台账程序块 + 理论 S10）→ 2b（8 题加第 3 轮：改完给 canned 结果，测四弊端；raw vs 手写 oracle vs 自动稿）→ 2c（假仓库全轨迹 3 题 × 2 变体 × 2 样本）。

## 2. 本阶段的决定（已定，不再反复）
- 多轮的评测链：同一可见动作（第 2 轮的 edit 取自 effect-23 d9a 样本），只换 reasoning：raw = 原始 CoT；oracle = oI D1 + 手写 D2；auto = v4d6 D1 + 自动 D2。
- 第 3 轮 canned 观察每题两种：绿（改对了 → 看是否言过其实 / 用绿灯当证据）、不绿（假设错 → 看是否死锁 / 盲目归因）。
- 先手写 oracle D2 按理论 S10 写，跑一轮证明理论；再做副模型 v4d7。
- 钱：每轮 2 样本；主模型每次调用前先算清次数写在这里。

## 3. 已知的坑
- **写 canned 观察前先把代码语义跑一遍**：sse 红题我把 rawFinish="stop" 当失败，其实是正常流；主模型答对被我判 0。
- ASK 措辞会和主模型的调用协议冲突（要文字就不能调工具）——问法要二选一。
- 手写 oracle 含预见（CoT 里没有的），忠实压缩不允许发明；副模型的目标是层 B 形态闭合，不是 oracle 分数。
- **2026-09-30 用户换了渠道（同 base a6api、新 key）实测**：主模型请求几乎全落到后端 `cb/deepseek-v4.1-flash`（fp=null，usage 带 cache_creation_input_tokens）——**丢弃历史 reasoning_content**（1 字 vs 1000 字 prompt_tokens 339=339 / 44=44，埋暗号 0/16 看见），DeepSeek 式 `thinking:{type:'enabled'}` 被忽略（0 字思考，`reasoning_effort` 才有 ~100 字）。首批 channel-check 6 次曾落到另一后端（372 vs 911 有拼接，但 0 字思考）。⇒ 这条渠道**只能当副模型通道**（compile-direct 2/2 成稿、闸 ok、闭合 2/2、单次 ≈19.6 s）；主模型评测 / 真机效果在它上面全是噪声，`--require-fp` 0% 通过。换回可信通道再跑任何 effect-*/traj-run。
- 中转抖动：副模型单次 5–90 s，偶发 150 s 超时；可信后端按请求内容黏住、带 tools 字段时更少（有时 0/6）⇒ traj-run 用 --text-tools + max_tokens:1 探针 + 零宽空格打散；effect-eval 未改。
- 稿长均值 ≈ 1630；熔断 2000；真机 6 s 窗口到位率 v4d6 **未复测**（2a 第一件事）。
- flash 抄样例不读规则；样例里的名字会被抄进稿里（已禁）。
- effect-eval 的 results.jsonl 是累计的；新目录 cp 旧目录再跑。

## 4. 下一步（做完一项就改这里）
1. [x] v4-live 复测：6 s 窗口 **0/5 到位**（全 distill-timeout）；12 s 窗口 3/5（副模型 5.3 / 6.3 / 11.9 s，两次 >12 s）。今天中转慢（昨天 4/5）。⇒ 到位率 = 窗口 × 中转速度，需要工程决定（窗口自适应 / 抬缺省），先记着，不阻塞 2b。
2. [x] 理论 S10 写入（CFB-THEORY-COMPLETE.md「### S10」，含预注册预测 P1–P4）
3. [x] 台账：src/messages.js buildLedger / ledgerBlock，进 buildCompressCtx（user 之后、工具结果之前）；自测 5u1
4. [x] tools/effect-mr.mjs（--build / --run / --summarize）+ tools/effect-mr-specs.json（5 题 × 绿/红，flaky 绿 = 不限核通过 = 无信息量）；链在 /home/user/mr/chains.json（flaky CoT_2 重生成 4495 字，其余用 effect-23 d9a 样本）
5. [x] 2b 跑完三轮（run1 全 / run2 红 / run3 sse 红 + flaky 红 auto）：oracle 红题 8.6–9.5 vs raw 5.8（假完成 0 vs 25%）；理论修订 S10.3′（推翻路单命令 / 验收观察自证新鲜 / 看原症状不看单元测试）；**基准错误已修**（sse 红 rawFinish 语义）；ASK3 措辞修（协议冲突假象）。理论 S10.9 / S10.10 已写。
6. [x] v4d7 已实现（台账在手时追加第 10 条四段 + 第 2 轮样例；【本轮已发出的调用】进 ctx；样例整句抄写剥离 parrotedExample；selfClosed 扩到「所以」句）。auto D2 红题 6.9（形态齐、验收命令不再发明；差距 = 预见，见 S10.10）。auto 绿题**未跑**（眼高手低风险：状态声明会不会让它不敢收工——2c 里看）。
7. [x] 2c 跑完：traj1（生产门槛 ⇒ 0/9 轮压缩）、traj2 + traj3 合并（无门槛）raw 5/6·4.0 轮·16.8k / auto-all 5/5·3.4 轮·13.2k / ledger 5/6·4.0 轮·19.1k ⇒ 理论 S10.12：H-ledger 不成立；压稿价值 = 效率；言过其实 = 宿主策略。EFFECT-EVAL §18 已写全。
8. [x] 全部文档收口并 push（见 git log 最新一条）。**阶段 2 收官陈述在理论 S10.12 末**。下一步不在稿上、在宿主接口（门槛策略 / 收工前强制验收 / 窗口自适应）——等用户决定。

## 5. 费用台账（本阶段）
- 2b：副模型 ≈ 25 · 主模型有效 ≈ 110 · 盲评 ≈ 100 · 作废重发 ≈ ×1.7
- 2c：主模型有效 ≈ 90（traj1 ≈ 30、traj2 ≈ 40、traj3 ≈ 20 进行中）+ 作废 / 探针（探针只花 prefill）· 副模型 ≈ 40

## 6. 第六会话（2026-09-30）v12.9.1 / compress-v4d8——多轮稿「可推导的预见」（用户裁定：多轮没到上限 ⇒ 实现层修 + 理论层搜文献补；给的东西必须在任何情况下都是优化）
- 理论：S10.13 归因修正 → S10.14 六条 K（K1 验收自证新鲜 / K2 条件等价 / K3 参数跟随 ⇒ 取证事件先后、取证前不动实现 / K4 新出现者优先 / K5 收工三问 / K6 零效应 ⇒ 消费点）+ 不变性论证 → S10.16 评委修订 → S10.17 预注册 → S10.18 run4 对账。文献列在 S10.14 脚注。
- 实现：`verifyHints(ctx)` 程序算提示（只在 ctx 有【本轮已发出的调用】时；单步 / 第 1 轮提示词不变）；V4D_MR 四段体 + 第 2 轮样例；提示片段并入核真集合；多轮熔断 2600；`parrotedFragment` 片段级剥离；effect-mr 评委记忆 / 3 票 / `--rejudge` / 动作类 / `instrument` 类；compile-mr `mrFormCheck` + `--recompile`。
- 数字（run4，新评委，每格 n = 2）：红 raw 4.9 / v4d7 6.5 / oracle 7.8 / **v4d8 8.0**；绿 raw 9.2 / oracle 9.6 / **v4d8 9.8**；假完成 0/20；再调数字 0。两次归因修理论：flaky 1.5 → 5.0（K3 措辞），perf 6.5 → 9.0（补 K6）。
- 最终稿文件：`transfer/mr/auto-d2d.json`（eacces / wrong-model / sse 来自 auto-d2c-r，flaky / perf 来自 auto-d2d-part-r）；结果 `transfer/mr/run4/`（results.jsonl 含变体 raw / auto / oracle / oracle2 / oracle3 重评行 + auto8 + auto8b；`results.contaminated.jsonl` 未拷贝——那是 run2 的 sse 旧规范回答被错判到新规范的第一次重评，作废）。
- 踩坑：重评时 run2 的 sse 红行是旧规范（改前的观察），不能与 run3 混；`--rejudge` 的去重是「先到先得」，顺序与 `--only` 要按规范版本分开跑。
- 剩余（诚实）：稿长 1400–2400；副模型仍会把已排除项写回 fallback（perf 稿的 maxOutputTokens）；只发调用的回答评委看不到意图（flaky #0 票 8/2/1）；n = 2；生产门槛 birthMinChars 3100 / 6 s 窗口没动——那是宿主决定，不是稿的事。
- 费用：副模型 7 · 主模型 24（含作废 ≈ ×1.5）· 评委 ≈ 300（含重评，记忆命中零成本）。

## 7. 第七会话（2026-09-30）v12.9.2 / compress-v4d9——用户只批了方向 1 / 2 / 4（「1，2，4 你先做了，然后回来汇报」）；方向 3 与付费泛化跑未批
- 稿层：延续段（`continuationText` → ctx【延续段】）/ 通用验收条款（`verifyHints` 稿口吻）/ 收工三问（`closingQuestions`，漏写才补、有改法在场才补）由程序写并由闸门拼进稿（`spliceProgramParts`）；已排除候选写回后路剥掉（`stripExcludedFallback`）；提示词 V4D_MR → v4d9（不再附【验收提示】块）。理论 S10.19。
- 生产缺口（重要）：生产 ctx 从没有过【本轮已发出的调用】（ctx 在流开始构造、birth 在 reasoning 结束起火）⇒ K 提示此前只在评测里出现。修：`birthTransform` 累积 tool-call-delta，`birthFinish` 拼提示（T35）。
- 评委：缺省 1 票 + 条件补票（`needsEscalation`：首票 ≤ 7 / 与规则指标打架 / reread）、`--judge-mode none`、记忆按规范哈希记票池、评委看思考尾。run4 回放 237 → 117（−51%），偏差 ≥ 2 的 1/79。
- 审计：`node tools/audit-noninferiority.mjs`（零调用）267 份稿 N1–N7 全零；首轮抓到 2 处真 bug（DSH_HOME 重名 ⇒ 落定三元组被删；豁免句边界到分号）。**以后每次改闸门先跑它。**
- 探针（2 次副模型）：`transfer/mr/auto-d2e-probe*.json` flaky 1141 → 2714、perf 1370 → 2088，形态 9/9；暴露并修了括号否定误判、三问被砍。
- 费用：副模型 2 · 主模型 0 · 评委 0。
- 下一步（需用户批）：① run5：v4d9 vs v4d8 主模型对比（≈ 20 主 + ≈ 25 评委）；② 方向 3（程序比差【本轮新出现】、K7–K11）；③ 泛化：3–5 道新红题（先合成 ctx 零成本核形态）。
- 第八会话（2026-09-30）**能力层文献侦察**（用户：只找能力瓶颈的突破，不要触发/观测）：`docs/analysis/CAPABILITY-SWEEP-2026-09-30.md`。六面墙（文本通道 / token 记忆 / 模仿好摘要 / CoT 剧场 / 陈述不能取证 / 生成≠验证）+ 四块理论拼图（双模拟、Wyner-Ziv 侧信息、任务导向率失真、多描述）。五个可落地动作按序：B 分层多描述 → C 编译期充分性自检（QAEval 式）→ A 剧场判别（forced answering）→ D 探针回填（host 协议）→ E 状态住进稳定前缀。先离线零成本做 B/C。

