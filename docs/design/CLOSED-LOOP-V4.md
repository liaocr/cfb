# 闭环 v4 —— 结局锚定的选育训练器（v14.4，2026-10-02）

> 读者：下一个模型、实验设计者。前置：`CLOSED-LOOP-V3.md`（任务池 / 留出闸门 / 策略生成层 / 飞轮）。
> v4 不推翻 v3，只换掉 v3 里**没有科学依据的三处**：尺子只证对称不证有效；固定阈值 Beta 在反复看数据时没有误采纳保证；留出题 2 道且无限复用。
> 全部新代码零 API；本次会话 API 实付 $0。

## 0. 结论先行

1. **尺子分三层，效度可算**。L1（下一步结构分，13 请求/轮）只是**代理**；L2（`tools/traj-run.mjs` 全轨迹端到端结局：修好 / 到修好的轮数 / 假宣称 / 重复 / 修好后验收）才是理论 §−2 S9 的**终局度量**。每个既被 L1 打过分又跑到 L2 结局的样本构成一对 (proxy, outcome)，`rulerValidity` 算 AUC + 自助 95% CI；状态 `unvalidated → valid | suspect | invalid`，直接决定 L1 有没有资格采纳。**A/A 校准只回答「尺子偏不偏」，效度账本才回答「尺子量没量对东西」**。
2. **采纳统计换成 e 值**（testing by betting，任意停时有效）。留出 e ≥ 10（α=0.1）且全部 e ≥ 10 才 `adopt-provisional`；v3 的「4 对留出全胜 P=0.969」在 v4 只是 e=6.2 ⇒ continue——那正是评审算出的 6% 误采纳来源。要 5 场留出连胜（零效应下 3.1%；含任意偷看的上界 10%/假设）。
3. **采纳分两级**：`provisional`（只过 L1）→ `confirmed`（L2 续跑 champion vs previous，配对 e ≥ 10）。`propose` 对 provisional champion **拒绝出生产 diff**（`--allow-provisional` 明示风险才放行）；L2 若证伪（「更差」e ≥ 10）自动**回滚**到 previous，并把这次写进效度账本——尺子失效时第一时间可见。
4. **留出题会消耗**。每参与一次采纳/否决判定曝光 +1，≥3 次应退役为 dev、换新题进留出（`ruler`/`status` 给警告）。配合 v3 的 mint 与 v4 的自铸协议，池子不再是「人写 u2」。
5. **开始训练权重（CPU，小，诚实）**：`ranker.mjs` 在飞轮偏好对上训 20 维 Bradley–Terry 逻辑回归（留一 CV 门槛 0.6），只用于**付费前**给候选稿排序（赛马把预算投给最可能赢的臂），不替代评委、不改压缩器。它是「数据 → 模型 → 更省的实验」的第一个真闭环，20 对起跑。
6. **钱**：一轮 L1 13 请求实付 ≈ $0.13（下表）；一次 L2 确认 ≤ 40 请求 ≈ $0.5；一个假设从提议到 confirmed ≈ $1.0–1.5；被淘汰的候选 ≈ $0.05–0.3。全部预注册、审批门控，和 v3 一样一分钱都不会自动花。

## 1. 第二轮评审 → v4 的回应

| # | 评审 | v4 |
| --- | --- | --- |
| 1 | A/A 证对称不证有效；next+avoid−falseDone−… 从未与端到端结局对齐（指标级 Goodhart） | 三层尺子 + 效度账本（§2）；`adoptionPolicy`：`unvalidated/suspect` ⇒ L1 只能 provisional、每次都要 L2 确认；`invalid` ⇒ L1 退为预筛；`valid` ⇒ L1 可采纳、每 3 次抽检 1 次 L2 |
| 2 | 留出 = 2 道固定题反复自适应使用，单假设 ≈6%、6 个假设 ≈30% 误采纳 | e 值替代固定阈值（§3）；曝光退役（§4）；Thresholdout 在 n=2 时无意义——写明，不假装；真正的解是扩池（§5） |
| 3 | 扩池要人补 u2 | 自铸协议：用 `traj-run` 的执行器替代人——u2 = 模型自己第一步动作的真实观察（§5.1）；生产 episode 记录器规格（§5.3） |
| 4 | 生成器上限：提示词补丁人已探索 9 版 | GEPA 式反思 + Pareto 池（§6.1，设计）；策略空间加样例槽与台账 schema（§6.2）；CPU 排序器已落地（§6.3） |
| 5 | 「实付 ≈$0.05–0.15」是断言 | §7 给逐项 token 算术：预占 $0.50 vs 期望实付 $0.127，96% 是输出 token |
| 6 | ICC 0.3 任意 | 承认；§8 给出从 A/A 轮与同题重复样本估 ICC 的公式与落点，估出来之前 0.3 只是保守占位 |

## 2. 尺子：三层 + 效度账本

| 层 | 量什么 | 成本 | 角色 |
| --- | --- | --- | --- |
| L0 | 离线真值维度（`truth-dims.mjs`）、生产闸门、泄漏 | 0 | 安全过滤，不排序 |
| L1 | 真模型读稿后的**下一步动作**：next / avoid / falseDone / bump / reEdit / repeat（`structuralScore`） | 13 请求 ≈ $0.13 | 代理尺：便宜、快，**效度待证** |
| L2 | `traj-run` 从 v9 的两轮状态继续跑 ≤4 轮：fixedAtRound / rounds / repeats / claim∧¬fixed（假宣称）/ verifiedAfterFix / promptTokens | ≤40 请求 ≈ $0.5 | 锚：理论 S9 的度量，不可被提示词补丁 Goodhart（结局由假仓库的文件状态决定） |

**效度账本** `.cfb-offline/ruler/validity.jsonl`：`confirm --results` 喂进来的每一行若带 `proxyScore`（该样本的 L1 结构分），就追加一对 `{proxy, outcome: solved∈{0,1}, roundsToFix}`。`rulerValidity(pairs)`：AUC（Mann–Whitney）+ 1000 次自助 95% CI（种子固定）；n<12 ⇒ `unvalidated`；CI 下界 ≥0.6 ⇒ `valid`；AUC ≤0.55 ⇒ `invalid`；其余 `suspect`。
为什么 AUC：L1 是有序分，L2 主结局是二值；AUC = 随机一个修好样本的 L1 分高于随机一个没修好样本的概率，正是「代理尺会不会把结局好的排到前面」。次要：Spearman(L1, roundsToFix) 留给 v4.1。

**现有 L2 数据**（`ruler` 零 API 可看）：transfer/traj1–3 共 29 条真实轨迹，raw 修好率 0.636（n=11）、auto 0.900（n=10）、同题同样本配对 10、e=6.97（方向支持 auto，未过阈 10）。这说明：终局度量已经能算、方向是对的，但**我们从未在 L2 上证明过任何提示词改动**——这就是 v3 评审说的「代理与结局从未对齐」的量化版本。

## 3. 统计：e 值（任意停时有效）

设配对结果 i.i.d.，胜概率 p，H0: p ≤ 0.5。先验 q ~ Uniform(0.5, 1)，胜 w 负 l（平局不计）：

E = 2^{n+1} · B(w+1, l+1) · [1 − I_{0.5}(w+1, l+1)]

它是 H0 边界 p=0.5 下的似然比混合，是非负上鞅，Ville 不等式给出 **P_H0(∃n: E_n ≥ 1/α) ≤ α**——不管看多少次、什么时候停。（复合零 p<0.5 下 w 随机占优更小，单调似然比保证不等式仍成立。）

| 规则 | 留出 4 胜 0 负 | 5 胜 | 6 胜 | 7 胜 | 5 胜 1 负 |
| --- | --- | --- | --- | --- | --- |
| v3 Beta 尾 P(p>0.5) | 0.969 ⇒ adopt | 0.984 | 0.992 | 0.996 | 0.938 |
| v4 e 值 | 6.2 ⇒ continue | **10.5 ⇒ adopt（α=0.1）** | 18.1 | **31.9 ⇒ adopt（α=0.05）** | 2.9 ⇒ continue |

`decideV4`（`tools/helpers/ruler.mjs`）：`reject` 当「更差」e ≥ 10；`adopt-provisional` 当 ≥2 道不同留出题、无净负留出题、留出 e ≥ 10、全部 e ≥ 10；30 对仍未判 ⇒ `stop-undecided`；A/A ⇒ `calibrated`（永不采纳）。每轮 2 道留出题 ⇒ 最快 **3 轮**（α=0.1）/ 4 轮（α=0.05）采纳；扩池到 4 道留出题后 2 轮。

## 4. 留出题：曝光、退役、Thresholdout 的真实位置

- `offline/ruler/exposure.json`：留出题每参与一次 **非 continue** 判定（采纳 / 否决 / 到上限）曝光 +1；≥3 ⇒ `ruler`/`status`/`ingest` 输出「应退役为 dev，换新题进留出」。退役后它成为训练材料（提议器证据、飞轮），不再裁决。
- Thresholdout（Dwork 2015）：只有当 |dev 均值 − 留出均值| > T + 噪声时才释放留出答案并扣预算 B。它的保证随留出规模 n 指数生效；**n=2 时任何 T、σ 都是摆设**。所以 v4 不实现它来装样子；待池子 ≥ 12 道留出题时按 T=0.1、σ=0.03、B=20 次接入（放在 `decideV4` 之前作为「要不要看留出」的闸）。
- 同题重复的 ICC：`effectiveN` 仍用 0.3。可估：A/A 轮里同题两样本的结构分做单因素方差分析，ICC = (MS_between − MS_within)/(MS_between + MS_within)；每轮 5 题 × 2 样本，3 轮 A/A 后有 30 个点，够给一位小数。

## 5. 任务供给自动化（不再依赖人补 u2）

### 5.1 自铸（traj-run 执行器替代人）
v3 的 mint 需要人写 u2，是因为 v3 没有执行器。`tools/traj-run.mjs` 已有：假仓库物化（`traj-fixtures.mjs materialize`）、真 read_file / edit_file、白名单 bash、按文件状态给出的测试 / trace / CI 结果。自铸协议：
1. 场景 = 基线场景（eacces-config / flaky-timeout / perf-regression / …）× **扰动**（换文件名、换错误码、换失败测试、把正确修复点挪位）—— 零 API；
2. 第 1 轮：u1（场景文案）→ 模型 a1 + 工具调用 → 执行器给**真实观察** u2；第 2 轮：a2 → 执行器给 followup；
3. 得到完整 chain {u1, a1, a1Call, u2, a2} + followup + d1/d2（结构真值从执行器状态直接读出：哪个文件被改、测试是否通过、是否重复），进 `validateTaskFile` 入池；
4. 成本 ≈ 2 主请求 + 侧稿编译 1 ≈ 3–5 请求 ≈ $0.05–0.07/题，**全程无人工**；留出题标签由切分种子决定。
落点：`cfb-cycle mint --auto --scenario base:perturb`（v4.1；复用 `GEN_ROLES` mint-a/b 的预算与泄漏闸）。

### 5.2 故障注入（SWE-smith 式，设计）
在物化的假仓库里对一处真实可运行的代码做「让现有测试失败」的注入（改常量 / 翻比较符 / 删一行），执行器跑真实 `node --test` 得到可验证结局 ⇒ 任务与奖励同时产生。现在的 canned 结果按手写文件状态查表，要先把 fixture 的测试改成真跑；预计一个场景能派生 10–30 个变体。

### 5.3 生产 episode 记录器（规格，产品决策）
`src/trace.js` 只存预览（`tracePreviewChars`），所以**现在不能从生产免费挖题**。规格：opt-in `CFB_EPISODE_DIR`，每个 session 写 `cfb.episode/1 {turns:[{user, assistant, calls, results}], outcome: {testsPassedLater, userRepeated, sessionEnded}}`，默认关闭、本地落盘、脱敏（路径哈希、秘密正则）。有它之后：L2 结局免费、任务供给无限、分布是真实分布。

## 6. 生成器：从单父链到反思 + Pareto 池

### 6.1 GEPA 式（设计，v4.1）
- 候选策略保存**按题的分向量**（每题 L1 分、L2 结局），不是标量均值；
- 父代选择：按候选在各题 Pareto 前沿上出现的次数抽样（在 A 题赢的和在 B 题赢的都留，而不是只留均值最高的）；
- 反思提示器喂的是**失败轨迹全文**（dev 题的两臂动作、结构旗标、模型回复尾 300 字），要求输出「这一类失败的规则」而非泛化口号；一次请求产出 ≤3 条候选补丁；
- 合并：两个互补赢家的补丁并集作为新候选（仍受 ≤3 条 / 900 字限制）。
GEPA 论文的数字（比 GRPO 少 35× rollouts、比 MIPROv2 高 10%+）是别人任务上的，不当承诺；我们能借的是「少量 rollout + 自然语言反思 + 前沿池」三件事。

### 6.2 策略空间扩展
- **样例槽**：`【风格样例】` 段可替换为飞轮里赢的 `chosenText`（DSPy 式 bootstrapped demos）——数据直接变成策略，不经人手；
- **台账 schema**：HANDOFF-V12.8 §5d 的四段台账字段集作为可实验的旋钮（S10 的杠杆）；
- 旋钮层（v2）与补丁层（v3）照旧。

### 6.3 CPU 排序器（已落地）
`tools/helpers/ranker.mjs`：20 维可解释特征（路径数、`old_text` 出现、下一步动词、含糊词、完成宣称、错误 token、文件后缀……）；Bradley–Terry 逻辑回归 σ(w·(f_chosen − f_rejected))，L2 正则、固定 300 步、确定性；`trainRanker` 要求 ≥20 对且留一 CV ≥0.6 才 `ready`，否则 `untrained/weak` 自动失效。`plan` 在非 A/A 轮打印「candidate − control 预判差」；`ruler` 显示状态与 top 权重。用途只有一个：**赛马预筛**——多候选时把钱先投给预判高的臂；预判为负时考虑换假设。它会随飞轮变大而变准，是真正的 CPU 权重训练，但训练的是**选择器**，不是压缩器——GPU 没到位前不说后者。

## 7. 经济学：token 算术与赛马

**冻结 A/A r1 计划（13 请求）的算术**（`inputTokenBound` / `costEstimate`，单价 $1/M 入、$4/M 出）：

| 项 | 请求 | 输入 token | 输出 token | USD |
| --- | --- | --- | --- | --- |
| 预占上界：探针 | 3 | 4,577 各 | 512 各 | 0.020 |
| 预占上界：主请求 | 10 | 13.8k–16.1k 各（JSON 字节上界） | 8,192 各（max_tokens） | 0.485 |
| **预占合计** | 13 | 170,877 | 83,456 | **0.505** |
| 期望实付：探针 | 3 | ≈89 各 | ≈64 各 | 0.001 |
| 期望实付：主请求 | 10 | 2,181–2,888 各（CJK 0.6 tok/字、ASCII 0.3） | 2,500 各（历史收据中位） | 0.126 |
| **期望合计** | 13 | ≈26k | ≈25k | **≈0.127** |

96% 的实付是输出 token；完成长度中位 1,500 ⇒ ≈$0.08，4,000 ⇒ ≈$0.19；预占/实付 ≈ 4×。所以「≈$0.13/轮」是算出来的，不是断言；真实收据回来后 `ingest` 记录 reservedUsd，`costEstimate` 的中位数应随收据更新。

**每个假设的赛马预算**（候选 k 个）：
1. 零 API：L0 闸门 + 排序器排序；
2. 预筛（可选）：候选臂只跑 3 道 dev 题、对照用上一轮 champion 样本缓存 ⇒ 3 请求 ≈ $0.04/候选（缓存对照有通道漂移混杂，只用于淘汰，不用于采纳）；
3. 配对轮：13 请求 ≈ $0.13/轮，α=0.1 下最快 3 轮 ⇒ ≈ $0.4；
4. L2 确认：2 臂 × 留出题 × 2 样本 × ≤4 轮 ≤ 40 请求 ≈ $0.5（scope `cfb.outcome/1`，预占上界 ≈ $1.5）；
5. **confirmed 一个假设 ≈ $1.0–1.5；淘汰一个 ≈ $0.05–0.3**。用户的「几块钱」够走完 2–3 个假设到 confirmed，或淘汰 10 个。

## 8. 状态机、命令、文件

```
plan ──(13 req)──▶ ingest ──decideV4──▶ continue | reject | stop-undecided | calibrated
                                      └▶ adopt-provisional ──▶ champion{adoption: provisional, previous}
confirm --results (traj-run 行) ──outcomeComparison──▶ confirmed（propose 放行）| rolled-back（恢复 previous）| pending
ruler ──▶ 效度状态 / 采纳规则 / e 值预算 / 曝光 / 排序器 / L2 基线
```
- `offline/champion.json` 升为 `cfb.champion/3`：`adoption ∈ {provisional, confirmed}`、`previous`、`confirmation`、`rolledBack[]`；旧 `cfb.champion/2` 文件被读作 legacy（无 adoption 字段 ⇒ 不拦 propose，向后兼容）。
- `offline/ruler/{validity.jsonl, exposure.json, confirm-N.json}`。
- `propose [--allow-provisional]`；`confirm --results FILE [--map champion=auto,previous=raw]`（接受 traj-run 的 results.jsonl 或 JSON 数组；行字段：task, variant|arm, sample, fixed, fixedAtRound, rounds, claim, verifiedAfterFix, repeats, proxyScore?）。
- 自测：`test/closed-loop-v4.selftest.mjs`（e 值闭式解、decideV4 边界、效度状态机、L2 配对、排序器、29 条真实轨迹基线、端到端 provisional→回滚）。

## 9. 诚实边界（没验证的就是没验证）

- **没有任何付费运行**。v4 的每一条规则都在合成报告与 29 条历史轨迹上验证过算术与流程，没有在真模型上跑过一轮；L1 的效度账本现在 n=0。
- **L2 执行器还没接 policy**：`traj-run.mjs` 的 variant 只有 raw/auto/ledger，跑「champion 策略 vs previous 策略」需要给它加 `--policy ID` 让 auto 走 `applyPolicyToPrompt`，并从 v9 两轮状态续跑而不是从头跑（v4.1 的第一件事，零 API 可写可测）。
- **自铸 / 故障注入 / episode 记录器**是规格，不是代码。
- **GPU 仍然没有**：排序器是选择器权重，压缩器权重一个没动。
- e 值用的是 i.i.d. 配对假设；同题重复相关会让它偏乐观，所以 `nEff` 仍一并报告；复合零假设的论证靠单调似然比，严格证明见 Ramdas 等的 e-process 文献。
- α=0.1 是在「几块钱」预算下的选择：6 个假设全是零效应时至少 1 次误采纳的上界 47%（而非 v3 的「实际约 30%、无理论保证」）；要 27% 就用 α=0.05 多付 1 轮。L2 确认是第二道独立的门，两道都过才进生产，是 v4 真正把误采纳压下去的地方。

## 10. 路线图

- **v4.1（零 API）**：`traj-run --policy ID --continue-from runtime/rN`；`mint --auto`（自铸）；Spearman(L1, roundsToFix) 进效度账本；ICC 从 A/A 轮估计。
- **v4.2（首次付费，≈$0.6）**：A/A r1（13 请求）+ 一次 L2 续跑 raw vs auto 留出 2 题（≤16 请求）——同时得到仪器校准、首批 12+ 效度配对、第一张真实 token 收据。
- **v4.3**：GEPA 式反思 + Pareto 池；故障注入；台账 schema 旋钮。
- **放弃清单（不变）**：抽取式压缩、原文尾巴、第 N 条 K 规则、更短稿、Likert 当训练信号、无留出按分搜索；加一条：**L1 没过效度就不许 L1 单独进生产**。

## 11. v4.1（v14.5）：把每一次付费的信息榨干 —— 分叉全轨迹 + 执行器代理 + 回溯效度

第三轮评审的结论是「设计通过审计，实现未完成」：L2 执行器接不上 policy ⇒ 效度账本 n=0 ⇒ L1 永远 unvalidated；留出 2 题会在扩池之前先被曝光退役耗尽；首次付费若跑 raw vs auto，产出的配对喂不进效度账本。v4.1 三件事全部零 API 落地，并把「每美元买到多少信息」写成可算的表。

### 11.1 一次付费同时喂五本账：分叉全轨迹
`traj-run --fork --policy base,<champion>`：同题同样本只跑一次第 1 轮，各臂从**同一条第 1 轮回复**分叉（执行器确定性重放第 1 轮调用）。于是
- 第 2 轮 = v9 的 L1 测量（两臂从同一状态出发、只差压缩稿）—— **L1 对**；
- 跑到修好 / 封顶 = **L2 对**（`outcomeComparison`：修得更快赢、假宣称罚）；
- 每轮由执行器状态机械算六旗标（`traj-proxy.mjs stepFlags`：next / avoid / falseDone / bump / reEdit / repeat，与 `structuralScore` 同式）⇒ 每轮一对 **效度配对**（proxy ↔ 最终修好）；
- 两臂对同一段第 1 轮思维链的两份压缩稿 + L2 结局差 ⇒ **飞轮偏好对**（排序器的训练数据）；
- 第 k≥2 轮的状态（真实 u2 = 工具观察）⇒ **子状态任务**，继承父题的 dev/holdout 标签（不跨切分泄漏；家族内相关按簇处理）。

`ruler` 的「信息产出/美元」（估，主调用 ≈$0.0125、压缩 ≈$0.0075）：

| 单位 | ≈USD | L1 对 | L2 对 | 效度对 | 飞轮对 | 子状态 |
| --- | --- | --- | --- | --- | --- | --- |
| v9 L1 轮（13 请求） | 0.126 | 5 | 0 | 0 | 5 | 0 |
| 分叉全轨迹（2 臂 × 3 场景 × 2 样本 × ≤4 轮） | 0.66 | 6 | 6 | 36 | 36 | 24 |

每美元：v9 轮 L1 40 对；分叉轨迹 L1 9 + L2 9 + 效度 55。**在尺子未验之前，v9 L1 轮是信息效率最低的花法**；它只在 L1 被判 valid 之后作为便宜的预筛才划算。

### 11.2 回溯效度：已付费的 29 条轨迹立刻变成数据（零 API）
执行器代理可以从历史 transcript（calls + results + text）机械重算。结果（`ruler`）：111 步；轨迹级 21 对，AUC 0.944 **但负例只有 3 条 ⇒ `unvalidated`（功效不足），不判 valid**；步级 67 对 / 21 簇，簇自助 AUC 0.70（0.56–0.89）⇒ suspect；只看第 2 轮 AUC 0.61。旗标命中率 next 0.85、avoid 0.98、repeat 0、bump 0：**这些题上 L1 接近天花板，几乎不区分；真正区分的是到修好的轮数（3–6）**。两个诚实结论：① 方向对、功效不够，需要更多未修好的轨迹（更难的场景或更低的轮数封顶）；② L2 的 roundsToFix 应是主度量，L1 退为预筛——这和 v4 的采纳规则一致。口径说明：这是执行器代理（状态判）而非 v9 规格代理（d1/d2 判），账本分 source 记，两者是同一构念的两个估计量。

### 11.3 留出题的顺序依赖（评审第 1 条）
曝光退役 + 2 道留出题 ⇒ 第 4 轮起无留出可用——**在扩池之前不可开始按分搜索**。v4.1 的供给顺序：分叉轨迹的子状态（免费副产品，继承切分）→ 场景扰动（零 API 生成、付费跑）→ mint --auto（自铸）。在留出**家族** < 4 之前，`decideV4` 的留出闸门只是防自欺，不是泛化证据；写进 `ruler` 输出与放弃清单。

### 11.4 首次付费的正确顺序（评审修正采纳）
不是「A/A r1 + raw vs auto」。改为一次分叉轨迹：`--variants raw --policy base,base`？不——两臂同策略只能校准。首跑 = `--policy base --variants raw --fork --samples 2 --max-rounds 4`（raw vs policy:base，3 场景 × 2 样本，≈$0.5）：同一次付费得到 ① 执行器代理的在线效度配对（≈36 对，含更多未修好样本的机会）；② raw vs 压缩稿的 L2 对 6 个（现有 10 对 e=6.97，再加 6 对若同向即过阈）；③ 第一张真实收据校准 $0.0125/$0.0075 两个常数。等 L1 状态离开 unvalidated，再谈 v9 L1 轮。

### 11.5 仍然诚实的部分
- 生产 episode 记录器是**产品决策**：要改默认行为（opt-in、脱敏、本地落盘），脱敏不彻底的风险（路径、密钥、用户文本）必须由产品侧拍板；在拍板之前，供题只能来自假仓库与扰动。
- GEPA 式反思为什么能找到人类九版没找到的东西：没有新论据。能说的只有：人类九版优化的是「稿子读起来对不对」，反思器优化的是「稿子导致的下一步与结局」——目标函数变了，搜索空间同样大小下最优点未必相同；这是假设，要用 L2 证伪。
- $0.0125 / $0.0075 是算术不是收据；分叉轨迹首跑会给出真实值。
- `policy:<id>` 路径跳过了生产 birth 的 v4 闸（gate: null），两臂同路径所以对比公平，但与生产 `auto` 不完全同口径；要比「生产 auto」就用 `--variants auto`。
