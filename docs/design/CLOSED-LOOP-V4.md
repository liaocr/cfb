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
- **v4.3（已落地，见 §13）**：Pareto 池（父代选择）、子状态续跑、到修好轮数 C 指数、有界续跑、实测 ICC、decoy 加难。原计划的「Spearman(L1, roundsToFix)」改为 Harrell C（右删失）；故障注入（合并 bug / 两段式）与台账 schema 旋钮顺延到 v4.4。
- **v4.4**：每场景新 `fixed()` 的合并 bug / 两段式故障（SWE-smith 式）→ 新家族；≥ 4 家族后题型路由表。
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

### 11.2 回溯效度：已付费的 29 条轨迹立刻变成数据（零 API）—— 管道就绪，效度未证
执行器代理可以从历史 transcript（calls + results + text）机械重算。**主口径（步级，按轨迹簇自助）：67 对 / 21 簇，AUC 0.70（95% CI 0.56–0.89）⇒ `suspect`**；只看第 2 轮：AUC 0.61 ⇒ unvalidated。旗标命中率 next 0.85、avoid 0.98、repeat 0、bump 0：**这些题上 L1 接近天花板，几乎不区分；真正区分的是到修好的轮数（3–6）**。

> 脚注：轨迹级 21 对的 AUC 点估计为 0.944，但它建立在**仅 3 条负例**上，方差大到不携带信息；`rulerValidity` 因此加了 `minPerClass=5`，状态为 unvalidated。**不要引用 0.944。**

结论只有两条：① 数据管道通了（n=0 → 111 步），**效度没有被证明**——按 v4 自己的规则，L1 此刻无资格单独采纳任何东西；② L2 的 roundsToFix 是主度量，L1 退为预筛**候选**（是否值得当预筛见 §12.1 的经济学判定）。口径说明：这是执行器代理（状态判）而非 v9 规格代理（d1/d2 判），账本分 source 记，两者是同一构念的两个估计量。

### 11.3 留出题的顺序依赖（评审第 1 条）
曝光退役 + 2 道留出题 ⇒ 第 4 轮起无留出可用——**在扩池之前不可开始按分搜索**。v4.1 的供给顺序：分叉轨迹的子状态（免费副产品，继承切分）→ 场景扰动（零 API 生成、付费跑）→ mint --auto（自铸）。在留出**家族** < 4 之前，`decideV4` 的留出闸门只是防自欺，不是泛化证据；写进 `ruler` 输出与放弃清单。

### 11.4 首次付费的正确顺序（评审修正采纳）
不是「A/A r1 + raw vs auto」。改为一次分叉轨迹：`--variants raw --policy base,base`？不——两臂同策略只能校准。首跑 = `--policy base --variants raw --fork --samples 2 --max-rounds 4`（raw vs policy:base，3 场景 × 2 样本，≈$0.5）：同一次付费得到 ① 执行器代理的在线效度配对（≈36 对，含更多未修好样本的机会）；② raw vs 压缩稿的 L2 对 6 个（现有 10 对 e=6.97，再加 6 对若同向即过阈）；③ 第一张真实收据校准 $0.0125/$0.0075 两个常数。等 L1 状态离开 unvalidated，再谈 v9 L1 轮。

### 11.5 仍然诚实的部分
- 生产 episode 记录器是**产品决策**：要改默认行为（opt-in、脱敏、本地落盘），脱敏不彻底的风险（路径、密钥、用户文本）必须由产品侧拍板；在拍板之前，供题只能来自假仓库与扰动。
- GEPA 式反思为什么能找到人类九版没找到的东西：没有新论据。能说的只有：人类九版优化的是「稿子读起来对不对」，反思器优化的是「稿子导致的下一步与结局」——目标函数变了，搜索空间同样大小下最优点未必相同；这是假设，要用 L2 证伪。
- $0.0125 / $0.0075 是算术不是收据；分叉轨迹首跑会给出真实值。
- `policy:<id>` 路径跳过了生产 birth 的 v4 闸（gate: null），两臂同路径所以对比公平，但与生产 `auto` 不完全同口径；要比「生产 auto」就用 `--variants auto`。

## 12. v4.2（v14.6）：L1 还值不值得存在、被测对象 = 目标对象、付费单位预注册

### 12.1 L1 的角色由数据判，不由设计定
规格代理（transfer/mr/run1–4，162 个带旗标的真实样本）：结构分 = 2（天花板）占 **82.7%**；raw vs 压缩稿同题同样本 30 对 = **8 胜 / 4 负 / 18 平，平局率 0.60**。于是一轮 v9 L1（$0.126）期望只买到 **≈2 个非平局对**，而尺子未验时这 2 对**一个都不计入采纳**。`rulerEconomics`：
- `diagnostic`（现在）：尺子 unvalidated/suspect ⇒ L1 采纳级产出 = 0/美元；v9 轮只配做 A/A 校准与诊断，**不是预筛尺**；预算给分叉轨迹（每 $1 ≈ 6.8 个采纳级 L2 对 + 51 个效度对）。
- `prescreen`：尺子 valid 且 L1 每个非平局对（$0.063）比 L2（$0.157）便宜 ⇒ 值得当淘汰用预筛，采纳仍要 L2。
- `redundant`：valid 但不更便宜 ⇒ 直接用 L2。
`plan`（v9 单位）现在每次打印当前角色；角色为 diagnostic 时明说这一轮不计入采纳、推荐 `plan-traj`。

### 12.2 被测对象必须等于目标对象（路径等价闸）
`policy:` 直连路径现在**过生产同一道闸**（`compileV4Direct`：长度包络 / 无发明标识符 / 三元组保留；闸不过 ⇒ 与生产 birth 一样原文放行，记 `gateFail`）。剩下的差异只有传输层。即便如此，策略 champion 的 L2 确认仍要求一次**路径等价校准**：`confirm --parity`（auto 生产路径 vs policy:base 直连路径，≥4 对、L2 分不出、闸通过率差 ≤0.2）写入 `offline/ruler/parity.json`；没有它，`confirm` 只给 `pending-parity`，不 confirmed。旋钮型 champion（无提示词改动）不需要。

### 12.3 付费单位预注册：`plan-traj`
`cfb-cycle plan-traj` 冻结 `runtime/tN/plan.json`（臂、场景、样本、轮数、分叉、max_tokens 8000、目的、产出估计、**期望实付与上界**、digest、可直接复制的命令）；`traj-run --plan FILE` 核对运行参数与计划一致否则拒绝，跑完写 `receipt.json`（主调用 / 压缩调用 / prompt tokens / 闸失败数）。默认计划 raw vs policy:base，3 场景 × 2 样本 × ≤4 轮：主调用 42 + 压缩 24，**期望 ≈ $0.705，上界 ≈ $1.79**。目的写死在计划里：*第一次用真实数据检验尺子有效性；若效度仍 suspect / unvalidated，接受本机目前只能当记录仪，不开始按分搜索。*

### 12.4 生成器侧第一件新东西：样例槽（零 API 生成）
`op: exemplar` 把【风格样例】正文换成飞轮里赢过的稿（≤1200 字，过补丁预算与泄漏闸）；`policy-from-flywheel` 零 API 从飞轮挑结构分差最大的非留出赢稿落为策略（status proposed），之后与任何策略一样走 compile / traj 臂 / L2 确认。这是「数据直接变成策略」的第一条通路；它为什么可能超过人类九版，仍只有 §11.5 那条待证伪的假设。

### 12.5 仍然诚实的部分
- 一分钱没花；$0.0125 / $0.0075 常数未经回执校准（首跑的任务之一）。
- 效度账本 n=0（前瞻）；回溯效度 suspect。**L1 此刻是诊断，不是尺子。**
- 留出家族 3（假仓库场景）< 4：所有分叉轨迹结果只用于效度与校准，不用于按分搜索。
- 生成器侧除样例槽外没有新论据。

## 13. v4.3（v14.7）：第五轮评审的 9 个方向 —— 文献对照后的取舍（仍零花费）

评审给的是**方向**，不是答案。每个方向先查文献，再对照 `transfer/` 四份理论文档的铁规矩（留出家族数是泛化的分母、不按分搜索、尺子必须绑真实结局）决定做什么、不做什么。

| # | 评审方向 | 文献 | v4.3 的取舍 | 落点 |
|---|---|---|---|---|
| 1 | 尺子天花板来自题太简单，要更难更长的题 | SWE-smith（arXiv 2504.21798）：注入 / **合并多个函数级 bug** 可靠地造出需多处修改的难题；R2E-Gym、SWE-Playground 同类 | 同意前提。先做零 API 的通用加难算子 `perturbTask(task,'decoy')`：诱饵同名源文件 + README 误导 ⇒ 正确下一步不再唯一，考压缩稿能否保住**排除项与证据**（这正是 v4d9 的论点）；`--max-rounds` 可到 12。"合并 bug"/两段式故障需要每个场景的新 `fixed()` ⇒ 只设计不实现 | `traj-run --perturb decoy` / `--only id:decoy`、`plan-traj --perturb decoy`、A15 |
| 2 | 生成器在「下一步正确」上饱和，目标换成 roundsToFix / token，L1 效度用 Spearman | Pocock 2012 胜比、Buyse 2010 GPC、Finkelstein–Schoenfeld 分层成对；Harrell C 指数（右删失的 AUC 推广，Uno IPCW 为重删失修正） | 主结局 = **到修好的轮数，未修好右删失于总轮数**（不是把未修好扔掉）。L2 配对本来就是分层 GPC（修好 > 轮数 > 假宣称 > 验证）—— 现在明名并报 **胜比 / 净获益**。L1 效度不用 Spearman（处理不了删失、同轨迹对会灌水）而用 **跨轨迹 Harrell C + 簇自助**。**实测：29 条轨迹 67 步，C = 0.523（0.464–0.584）⇒ invalid** —— 六旗标对「还要几轮」没有信号；这比 0.70 suspect 更坏，也更诚实 | `ruler.concordanceIndex / rulerValidityTTF`、`outcomeComparison.winRatio/netBenefit`、`ruler` 打印、A13 |
| 3 | 留出家族 3 < 4，用 29 条轨迹的轮次状态派生 100+ 题当主供给 | Math-Shepherd（2312.08935）/ OmegaPRM：步价值 = 从该状态蒙特卡洛续跑的成功率；Unsupervised PRM 同理 | 做，但**改口径**：子状态 = 同一家族内的续跑起点，扩的是**配对数（功效）**，不是家族数（泛化）；留出家族仍 3，这一点评审的「留出 3→10+」不成立。实得 **59 个可重放状态 / 3 家族**（修好后的轮不成题；旧 transcript 参数截 400 字 ⇒ 2 个不可重放；无思维链 ⇒ 只能做 L2 起点，`--store-text` 之后的新轨迹才兼做 L1 题）。两臂在同一状态续跑的修好率 / 轮数之差 = 压缩稿价值的原则性定义（六旗标只是预测它的特征） | `helpers/child-states.mjs`、`cfb-cycle states`、`traj-run --from-state / --store-text`（确定性重放 + 消息前缀）、`valueTable`、A12/A14 |
| 4 | e 值接到分叉上：一次批准内有界续跑 | 任意时刻有效推断 / e-process：提前停不损失保证 | 做：`plan.stop = {alpha, minPairs, compare, capUsd}`，每组跑完算 `outcomeComparison` 的 e 值，任一方向过阈或 token 估算花费到上界即停；回执记 `stoppedEarly / estimatedUsd` | `plan-traj --stop [--cap-usd]`、`traj-run` 组后检查、`--dry-run`、A14 |
| 5 | 排序器用 162 个 mr 样本冷启动；ICC 用已有数据估 | — | **冷启动不可能**：mr 行只有旗标与字数，没有压缩稿正文（排序器特征要正文）—— 明说。**ICC 可估**：单因素 ICC(1)，mr 同题同臂重复 56 组 ⇒ **0.366**（接近原先拍的 0.3，但现在有来源）；traj 结局分 9 组 ⇒ 0（样本太少）。`ruler --write-design` 写 `offline/ruler/design.json`，`decideV4` 经 `loadDesign()` 读 | `ruler.iccOneWay`、`loadDesign`、A14 |
| 6 | 泄漏闸是字符串启发式，要用 dev 对半 / dev-留出增益相关检测过拟合 | Blum–Hardt 2015 **Ladder**（1502.04585）：榜只在显著优于前最佳时更新 ⇒ 自适应过拟合 O(log k)；Dwork 2015 Thresholdout | 不做 3 道 dev 题的对半（无功效）。现有采纳规则（只有留出 e 值显著才采纳 / 否决，留出只通过这一比特泄漏）**就是 Ladder**，这才是主防线；补 `generalizationGap`（dev 净胜率 − 留出净胜率 ≥ 0.5 且留出 ≥ 4 对 ⇒ `suspected-overfit`）作诊断；字符串泄漏闸降为次要 | `ruler.generalizationGap`、`ingest` 报告行、A16 |
| 7 | 单一擂主 → Pareto 池 | GEPA（2507.19457）§3.3：按题前沿抽父代，概率 ∝ 上榜题数，避免「永远选最好」一轮就卡局部最优 | 做：`scoreMatrix(history)`（候选 / 对照按题均分；对照记到当时的 `championPolicy`）→ `paretoFront`（按题并列最高 + 支配关系）→ `pickParent`；`propose-policy --parent auto`。擂主仍只有一个（生产只能挂一个策略），池只管**父代选择** | `helpers/pareto.mjs`、`ruler` 打印前沿、A16 |
| 8 | 六旗标权重从真实结局学 / 当搜索对象 | RHB（2605.02964）等：步奖励与结局错位时结局是锚；Math-Shepherd 的 MC 价值 | 原则性目标是 **MC 状态价值**（方向 3），不是在 6 个 ±1 上搜权重。权重回归只做诊断：逻辑回归 + 簇留一 —— **实测 cvAUC 0.14 vs 手工 ±1 的 0.70 ⇒ 保留 ±1**（21 簇上学权重就是过拟合）。学到的权重要替换手工，须在新家族上复验 | `ruler.fitFlagWeights`、A13/A17 |
| 9 | 按题型路由策略表 | — | 只设计：路由表需要每个题型 ≥ 1 个留出家族，现在总共 3 家族。等 ≥ 4 家族后在 `champion.json` 加 `routes:{family→policy}`，`tasksForRound` 按家族取策略 | 文档 |

### 13.1 评审自己的 top-3，与我们的 top-3
评审：子状态扩题、roundsToFix + Spearman、Pareto 池，"做完再花 $0.7"。我们：① 子状态（已做，但它是功效不是泛化）；② 到修好轮数 + C 指数（已做，**结论是 invalid**，这才是第一次付费最该验的东西）；③ 有界续跑（已做，一次批准把 $0.7 花到判定或上界为止）。Pareto 池已做但目前没有第二个策略可比，先空转。

### 13.2 第一次付费怎么花（仍需用户批准）
`plan-traj --stop`（默认单位，期望 ≈ $0.705 / 上界 ≈ $1.79）或 `plan-traj --from-states offline/states/eacces-config.json --samples 1 --max-rounds 6 --stop --cap-usd 1`（14 个留出家族状态 × 2 臂，续跑轮数少，单位更便宜；`--dry-run` 已验证 28 条全部可重放）。两者都先 `traj-run … --dry-run` 核对再批。目的不变：先验尺子（在线 C 指数 / AUC），不是搜索。

### 13.3 仍未验证
- 子状态续跑一条也没跑过：重放后模型是否顺着前缀继续（而不是从头重来）要看首跑。
- `estimatedUsd` 用 TRAJ_UNIT 常数估，不是回执。
- decoy 只验证了结构（文件 / README / fixed 不变），没验证它真的更难。
- Pareto 池、泛化差距、ICC 的 design.json 都只在模拟历史上跑过。

### 13.4 第六轮评审的回应（v14.8，仍零花费）
评审接受了 §13 的三处反驳（Spearman→C 指数、子状态是功效不是泛化、排序器冷启动不可能），并指出三件未解：留出家族仍 3、decoy 未验证更难、`--from-state` 未验证模型能续跑；另问 `policy:` 路径闸是否已关。逐条：

1. **家族（地基）：3 → 5 场景家族，零 API。** `tools/traj-fixtures-v2.mjs` 把 v9 冻结题 `wrong-model`（池里留出）与 `sse-truncated`（dev）落成可执行场景，与 v1 三题同一故障故事 ⇒ L1 冻结题与 L2 场景同家族。两点设计不同于 v1：① `fixed()` 不再正则猜代码形状，而是跑一份**隐藏语义 oracle**（临时写入 `.oracle/`，只 import `src/`，跑完即删）—— 任何位置的正确修法都算，改复现脚本 / 改可见测试不算；② 可见测试故意是绿的（和线上一样），复现脚本（`node scripts/*.mjs`）真跑并写 trace，Agent 的验收路径是「复现 → 改 → 再复现」。`sse-truncated` 的正确修法需要两处（`[DONE]` 不得推断 stop + `ok` 必须要求真实 `finish_reason`），只改一处不算 —— 这就是 SWE-smith 「合并 bug」式的多处修改题（§13 方向 1 原本只设计，现在有了一道）。**诚实边界**：留出家族 1 → 2，仍 < 4；新家族一条轨迹都没有，基线要靠首跑。默认 `plan-traj` 单位因此从 3×2（≈$0.705）变为 5×2（主 70 + 压缩 40，**≈$1.175 / 上界 $2.98**）；`--samples 1` ≈ $0.59；`--scenarios` 可限定旧 3 题回到 $0.705。
2. **decoy 是否「活的」（零 API，`perturb-check`）**：把 21 条真实轨迹的调用原样重放到原仓库与 decoy 仓库 —— **21/21 在修好前会看到不同输出，19/21（90%）的排查类调用（grep / cat / find / README）输出里直接出现诱饵** ⇒ active，不是惰性改动（bind=off 的教训）。**但可见 ≠ 更难**：评审要的「用已有轨迹跑 decoy 版比 roundsToFix」做不到 —— 轨迹是模型对所见的反应，所见变了后面的动作就不是旧轨迹了；「更难」只能由模型在 decoy 题上的到修好轮数回答（付费小探针，见下）。
3. **续跑探针**：`traj-run` 对 `--from-state` 的轨迹在接上前缀后的第一轮记 `continuation = {firstRoundCalls, prefixRepeats, verdict}`（≥ 一半调用在重做前缀 ⇒ `restarted`；0 重做 ⇒ `continued`），`summary.md` 给总判。探针计划：`states --family eacces-config --start-round 3 --parent-variant raw --limit 1` → `plan-traj --from-states … --arms raw --samples 1 --max-rounds 5 --stop` ⇒ **3 次主调用，≈$0.038 / 上界 $0.105**（两臂版 ≈$0.085）；`--dry-run` 已核对可重放。
4. **`policy:` 路径闸：v4.2 已关。** `tools/traj-run.mjs` 策略路径过生产 `compileV4Direct`（不过 ⇒ 原文放行并记 `gateFail`）；策略 champion 没有 `offline/ruler/parity.json` 时 `confirm` 给 `pending-parity`；自测 A11 覆盖。

**付费顺序（都需批准，从小到大）**：P1 续跑探针 raw 单臂 ≈$0.04 → P2 decoy 难度探针 `plan-traj --scenarios perf-regression --perturb decoy --arms raw --samples 2 --max-rounds 6`（≈$0.15；与 perf-regression 已有 raw 基线 roundsToFix 比）→ P3 验尺子（含新家族的首跑，`--samples 1` ≈$0.59 或默认 ≈$1.18）。

## 14. v4.4（v14.9）：用户规则 —— 只用 deepseek-v4.1-flash 的两个实战角色，其余大模型工作由助手代工

**规则（2026-10-02，用户原话的归纳，`tools/helpers/llm-roles.mjs` 是它的代码形态）**：这个插件是为 deepseek-v4.1-flash 设计的；付费调用只许出现在实战里真实存在的两个位置 —— **主模型**（Agent，思考开）和**副模型**（压缩器 = 同一模型关思考）。提议器、评委、打标、写场景、分析这些生产里不存在的调用，一律由助手代工，零 API。不换模型、不做别家模型的试点。

这不只是省钱：**被测对象 = 目标对象**。之前的 `compile` / `policy:` 压缩请求体是 `thinking:enabled、max_tokens 2048`（"开着以过通道身份闸"），而生产 `distillOnce` 是 `thinking:{type:'disabled'}、max_tokens 850`（`config.disableThinking=true / maxOutputTokens 850`）—— 开思考的压缩器写出的稿子不是生产会写出的稿子，测出的差别迁移不回去。v14.9 起两处都改成生产同形（`generation.PRODUCTION_COMPRESSOR`），`api-budget` 对 `compile` 角色不再要求 reasoning_content（通道身份由同一计划里思考开着的主调用 + 指纹锚定负责），`TRAJ_UNIT.compressCapUsd` 按 850 算。`traj-run --compress-thinking` 保留旧形态仅作诊断。

### 14.1 代码形态
- `freezeGen` 对 `role:'propose'` 直接拒（`rule:assistant-role:propose`）；`propose-policy` 不再冻结 API 计划，改为写**提议证据包** `offline/gen-N.pack.{json,md}`：父策略与补丁、dev 题首段、v9 轮失败证据、真实轨迹 / L1 规格样本里的失败（`trajFailureEvidence`，只含 dev 家族；留出家族的一切内容不进包）、补丁预算、**版本提醒**（每条证据来自哪一版压缩器；base 自己的结局数据有几条）。
- `policy-from-proposal FILE [--gen N]`：助手写的 proposal JSON 走与 API 提议**完全相同**的三道闸 —— `parseProposal`/`validatePatches`（预算）→ `leakCheck`（只在 dev 题出现、不在基础提示词里的强记号 ⇒ 拒）→ `applyPolicyToPrompt` 可应用（replace 的 from 恰出现一次）→ `makePolicy`（`origin:{by:'assistant', gen, pack, file}`，status=proposed）。闸不因为提议者是助手而放松。
- 评委：`effect-mr --judge-mode none` 是规则下唯一允许的形态；评委维本来就不是选择信号（v14.2 起），需要语义判断时助手读稿。

### 14.2 第一次代工的发现：v4d9 没有任何结局数据
证据包的版本提醒把事实摆出来了：历史失败证据（4 条 L1 红题假完成、2 条未修好轨迹）全部来自 **v4d7 / 手写稿 / ledger 变体**；v4d8 已把红题假完成压到 0/10（CHANGELOG v12.9.1），v4d9 又加了程序部件（收工三问、验收条款、延续段）—— 它们正是针对这些失败设计的，但 v4d9 自身只花过 2 次副模型调用、**0 次主模型结局**。所以提议器此刻没有"v4d9 的失败"可修；按 理论→实现→实测→归因 的顺序，第一付费单元必须先是取证，而不是改稿。

### 14.3 候选 #1（助手代工，机理假设，已过三闸，不进第一单元）
`docs/proposals/p1-multi-site.json` → 策略 `p-5d92393440`（parent base，+276 字符）。假设：v4d9 规则 3 把「要动多处」列为排除理由、规则 5 只给一个三元组、样例只示范单点改值 ⇒ **单点修复偏置**；当修复真的需要两处（同一个值的产生处与消费处各一行，`traj-fixtures-v2` 的 sse-truncated 家族如此；SWE-smith 报告组合式多处缺陷显著更难），压缩稿会把第二处写进排除段，Agent 改完一处看症状仍在就走"假设不成立"或回头重读。补丁：replace 排除理由（去掉"要动多处"）、新增规则 10「分 N 处落地：① ②…，改完一处症状仍在不算推翻」、尾注保留 N 个三元组。预注册预测写在文件里；若多处家族上不优于 base ⇒ 假设作废，不出第二版。

### 14.4 规则下的付费单元（都已冻结为计划、未发请求、需批准）
| 计划 | 臂 | 规模 | 期望 / 上界 | 得到什么 |
|---|---|---|---|---|
| **t2（推荐）** | raw / auto / policy:base | 5 家族 × 1 样本 ≤4 轮，分叉 | **≈$0.925 / $2.09** | v4d9 生产压缩器的 L2 基线；auto≈policy:base 的 parity（之后任何候选采纳的前提）；第一批 v4d9 自己的失败证据；效度配对 ≈45 |
| t3（备选） | raw / policy:base / policy:p-5d92393440 | 同上 | ≈$0.925 / $2.09 | 候选 #1 直接对照；但没有 auto 臂 ⇒ parity 悬置，候选赢了也只能 pending-parity |
| 最小 | raw / policy:base | 5 × 1 | ≈$0.59 | 只有基线 + 证据，无 parity |

执行：`DEEPSEEK_API_KEY=… node tools/traj-run.mjs --plan .cfb-runtime/traj/t2/plan.json --store-text --variants raw,auto --policy base --only … --samples 1 --max-rounds 4 --fork --max-tokens 8000 --require-fp --base-url https://api.a6api.com/v1 --model deepseek-v4.1-flash --out .cfb-runtime/traj/t2`（`--dry-run` 已通过）；回灌 `confirm --plan 2 --parity` 与 `confirm --plan 2 --map champion=policy:base,previous=raw`，然后 `propose-policy --gen 3` 让助手读 v4d9 自己的失败再写候选 #2。
