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
- 中转抖动：副模型单次 5–90 s，偶发 150 s 超时；主模型 --require-fp 作废率 ≈ 1/3。
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
7. [~] 2c：tools/traj-fixtures.mjs（3 题真文件 + canned）+ tools/traj-run.mjs（raw / auto / ledger 变体；--min-chars = 生产门槛 3100）。第一批（traj1）发现：循环里每轮思考中位数 ≈ 600–1000 字 ⇒ 生产门槛下 auto 0/9 轮压缩 = raw；无门槛时 15 字被压成 1181 字台账稿。理论 S10.11 立假设 H-ledger（程序台账零副模型成本）。**正在跑 traj2**：raw / auto-all（min-chars 0）/ ledger × 3 题 × 1 样本（≈ 54 主 + 18 副）。中转黏后端 ⇒ 重发加零宽空格打散。
8. [ ] 文档 / commit / push（每个里程碑都 commit）

## 5. 费用台账（本阶段）
- 副模型：≈ 25 · 主模型有效 ≈ 110（含建链 5、run1 40、oracle2 20、run2 30、run3 10+2）· 盲评 ≈ 100 · 作废重发 ≈ ×1.7（中转可信 50%）
