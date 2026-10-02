# 闭环 v3（v14.3）：带生成层、留出闸门与任务池的训练环

> 现行设计。v2（`CLOSED-LOOP-V2.md`）的命令、计划格式、判定算术全部保留并仍可单独使用；v3 在它外面加了四件 v2 没有的东西：
> **任务池与留出题**、**A/A 仪器校准**、**提示词级策略空间 + LLM 提议器（生成层）**、**训练数据飞轮**。
> 与 v2 一样：本仓库里**没有一条命令会自己花钱**；每一笔付费都是「冻结计划 → 印出 scope / 请求数 / 预占上限 / 计划摘要 → 停 → 人显式 `run --live`」。

## 0. 为什么要 v3：对 v2 批评的逐条回应

v14.2 收到的外部批评（原文见对话记录）共七条。逐条态度：

| # | 批评 | 态度 | v3 的回答 |
| --- | --- | --- | --- |
| 1 | 5 道冻结题既做提议又做采纳，等于在训练集上交卷 | **接受** | 任务池按种子确定性切成 dev / holdout；提议器只看 dev 题证据，采纳只认留出题（§2、§4） |
| 2 | 同题重复不是独立样本，n=25 对是虚的 | **接受** | 判定按**不同任务数**计留出战绩，重复按 ICC=0.3 折算有效 n（§3） |
| 3 | 第一笔钱就测 kItems 这种结构性杠杆，风险错配 | **接受** | 首轮默认 A/A 校准；其后低风险在前（closing → deadEnd → selection → layout → kItems）（§3.3） |
| 4 | 没有生成器：只有 6 个旋钮的有限臂，不是「迭代优化」 | **接受** | 生成层：对 v4d9 提示词的受限补丁构成策略空间；LLM 提议器读失败证据给补丁（文本梯度）；三闸后成为可测假设（§4） |
| 5 | 评委仪器从未校准，不知道噪声多大 | **接受** | A/A（两臂同文）一轮 ≈ USD 0.13，得到平局率 / 偏置；可疑则标 `instrument-suspect`（§3.2） |
| 6 | 「一轮 USD 0.648」太贵 | **部分纠正** | 0.648 是 v8 收据的**预占上限**，不是实付；实付不可测，按 token 口径 ≈ 0.05–0.15。v3 生成请求另设 ≤ USD 0.3 / 次的闸（§6） |
| 7 | 不做权重训练就别叫「训练」 | **接受（有保留）** | 没有 GPU 不做权重；v3 把每个非平局配对存成偏好对（飞轮），GPU 到位时直接喂 DPO/ORPO——但在那之前，被训练的对象是**提示词策略 + 编译旋钮**，文档里就这么写 |

## 1. 一张图

```
                 ┌──────────────── 任务池（tasks.mjs）────────────────┐
                 │ 冻结 5 题 ∪ .cfb-offline/tasks/*.task.json         │
                 │ sha256(seed+id) 排序 → holdout = 前 ⌈0.4n⌉（≥2）   │
                 │ 每轮轮换 ≤5 题（留出题每轮 ≥2）                    │
                 └────────────┬───────────────────────┬───────────────┘
                              │ dev 题证据             │ 全部题（评测）
   ┌─────────── 生成层（generation.mjs）───────────┐    │
   │ propose-policy: LLM 读失败证据 → JSON 补丁    │    │
   │   三闸：预算(≤3 补丁/900 字) · 泄漏 · 可应用  │    │
   │ compile --policy: 按策略重压 side（≤5 题/次） │    │
   │ mint: u1→a1，人补 u2→a2，compile --mint r1/side│    │
   └──────────────┬───────────────────────────────┘    │
                  │ 策略 = 候选臂（lever=policy）        │
                  ▼                                    ▼
   ┌─────────── 评测环（cfb-cycle plan / ingest）────────────────────┐
   │ 首轮 A/A → calibration；然后 策略 > closing > deadEnd > … > kItems│
   │ 每题 1 对、13 请求、≤USD 1；decideV3：全体序贯 + 留出题闸门      │
   │ adopt ⇒ champion{knobs, policy}；非平局配对 → train/pairs.jsonl  │
   └──────────────────────────────────────────────────────────────────┘
                  │ propose：配置 diff / src 改动 / 提示词补丁（给人落生产）
```

## 2. 任务池（`tools/helpers/tasks.mjs`）

- **来源**：冻结 5 题（`frozen`）∪ `.cfb-offline/tasks/<id>.task.json`（`minted` 付费铸造 / `mined` 从生产痕迹挖 / `authored` 人写）。`validateTaskFile` 要求完整两轮链（u1 / a1.raw / a1Call / u2 / a2.raw）、r1、side、spec.obs.red.followup；坏文件只警告不进池。
- **切分**：`splitTasks(ids, {seed:'cfb-holdout-2026-10-02'})` 按 `sha256(seed + id)` 排序取前 `max(2, ⌈0.4n⌉)` 为 holdout。确定性、与人无关、新题进池不改旧题归属。5 题池：holdout = `eacces-config, wrong-model`；dev = `flaky-timeout, perf-regression, sse-truncated`。
- **轮换**：`rotateTasks(pool, round, 5)`：≤5 题恒等；更多时按轮次滑窗，保证每轮 ≥2 道留出题，所有题在 ⌈n/5⌉·k 轮内都轮到。
- **冻结进计划**：v9 计划新增 `pool`（id → {digest, source, split}）与 `hypothesis.split`；审计 `auditApiPlan` 只接受「冻结 5 题 ∪ 计划登记的池题」，池题 digest 必须是 16 位 hex，来源 ∈ {frozen, minted, mined, authored}。
- **铸造协议**（§5）：一道新题 4 个付费请求（a1、a2、r1、side）+ 一次人工（写 u2 与 followup/next/avoid）。

## 3. 判定（`decideV3`，`tools/helpers/experiment.mjs`）

### 3.1 规则

对同一假设累计的全部配对 `pairs[{task, outcome, split}]`：

1. `all = sequentialPaired(全部)`：v2 的 Beta(1,1) 序贯（P(p>0.5) ≥ 0.95 / ≤ 0.10 / 25 对上限）。**否决**与**到上限停**沿用它——dev 题可以否决。
2. **采纳**额外要求留出题闸门全部成立：
   - 留出配对数 ≥ `minHoldoutPairs = 4`；
   - 不同留出任务数 ≥ `minHoldoutTasks = 2`，且**按任务净胜负**（每题 wins−losses）没有净负的留出题；
   - 留出配对单独的 P(p>0.5) ≥ 0.95。
3. `nEff = effectiveN(pairs, icc=0.3)`：同一任务的 m 次重复按 `m / (1 + (m−1)·icc)` 折算，报告里与原 n 并列。
4. 决策 ∈ {`adopt`, `reject`, `continue`, `stop-undecided`, `calibrated`}。

5 题池 × 每题 1 对的现实含义：**一个假设至少两轮**（第 1 轮留出 2 对 → continue；第 2 轮留出累计 4 对，全胜则 0.9687 ≥ 0.95 → adopt）。v2 的「5 胜即采纳」在 v3 里不成立——这是故意的。

### 3.2 A/A 校准

`plan` 在 `history.calibration` 为空时默认出 A/A（两臂同文，`hypothesis.lever='A/A'`；审计只在这个 lever 下允许同文）。`ingest` 走 `decideV3({aa:true})`：

- 记 `tieRate`、`winRate`（candidate 位胜率）；若 n ≥ 4 且 winRate ∉ [0.1, 0.9] ⇒ `instrument-suspect`（通道漂移 / 顺序效应 / 判据偏置），否则 `ok`；
- 决策恒为 `calibrated`，**不采纳任何东西、不进飞轮**；结果写 `history.calibration`，`status` / `doctor` 显示。
- `--skip-aa` 跳过；`--lever A/A` 可随时重校。

### 3.3 假设顺序

`A/A`（仅首轮）→ 已编译未判定的**策略**（文件顺序）→ 旋钮按 `LEVER_ORDER_V3 = closing, deadEnd, selection, layout, kItems, bind`（低风险呈现类在前、结构性在后；bind 在冻结语料上惰性，只是可见）。已判定的 `lever=value` 不自动重测；`--lever k=v | policy=ID | A/A` 可覆盖。

## 4. 生成层（`tools/helpers/generation.mjs`）

### 4.1 策略空间

策略 = 对生产提示词 `buildCompressPromptV4Direct`（v4d9）的受限补丁列表：

- `append:rules`（插入「【补充规则】」段，位于【风格样例】之前）、`append:tail`（末尾）、`replace`（`from` 必须在提示词里**唯一命中**）；
- 预算：≤ 3 个补丁、累计新增 ≤ 900 字、单个 replace ≤ 400 字；
- `id = 'p-' + sha256(parent, patches)[:10]`：只看内容，不看谁、何时提的；`parent` 形成谱系；`base` = 原提示词。
- 策略文件 `.cfb-offline/policies/<id>.json`：`status ∈ proposed → partial/compiled → adopted | rejected | rejected-leak`，`sides[task] = {text, gate, gen}`。

### 4.2 提议器（文本梯度）

`cfb-cycle propose-policy`：

- 输入 = **提示词头**（指令 + 规则 + 样例，不含当前任务上下文与思维链）+ 父策略补丁 + `failureEvidence`（只取 **dev 题**的 loss/tie 配对：两臂稿开头各 500 字、主模型下一步动作、判据旗标、followup 片段，≤ 6 条）+ dev 题 id 列表；
- 输出合同：严格 JSON `{patches, rationale, prediction}`，temperature 0.7，1 个主请求 + 3 探针 = 4 请求，预占 ≈ USD 0.05；
- `ingest-gen` 三闸：`validatePatches`（预算 / 形状）→ `leakCheck`（补丁里出现任何**题目特有**标识符——含 `/ . _` 的路径符号、驼峰名、或只在一道题里出现的词——即拒；多题共有的领域词如 fail / error 放行）→ `applyPolicyToPrompt` 可应用。违约整份作废不重试，记 `rejected`。
- 留出题 id **从不**进入提议器请求体（自测 E2 逐字节检查）。

### 4.3 编译与成为假设

`cfb-cycle compile --policy ID`：按策略改写后的提示词重压每道池题的 side（与生产同体：单 user 消息、temperature 0、max_tokens 2048），≤5 题 / 次、预占 ≈ USD 0.2。`ingest-gen` 把 side 写回策略文件，闸门打在「用该 side 走生产编译后的候选稿」上（side 是中间件，生产闸门只认成稿）。覆盖全部池题 ⇒ `compiled`；之后 `plan` 自动把它当 `lever=policy` 的假设（candidate = 策略 side 的生产重编译，control = champion）。

采纳后：`champion.json` 升为 `cfb.champion/2 {knobs, policy}`；下一轮 control 自动换成策略稿；`propose-policy` 的父策略变为它（谱系前进）；`propose` 产出「需要改提示词」段（补丁、落点 `src/prompts.js`、证据、版本号提醒）。**本文件不写 src/**。

## 5. 铸造新题（付费，默认不跑）

```
mint --step a --scenario FILE     # {id, u1, followup, next?, avoid?, u2?}：u1 → a1（要求有 reasoning 与首个工具调用，否则铸不成）
# 人工：在 .cfb-offline/tasks/<id>.partial.json 的 chain.u2 写第 2 轮用户话（观察 + 追问）
mint --step b --id ID             # a1(回放 reasoning) + u2 → a2
compile --mint ID                 # 第 1 次压 r1，第 2 次压 side（都是生产口径的 ctx）
```

每步 1 主请求 + 3 探针（≈ USD 0.01–0.06）；完成即 `validateTaskFile` → `<id>.task.json` 进池，按种子自动落 dev / holdout。free 路线（从生产痕迹挖题 `mined`）只需把痕迹整理成同一文件格式，零 API。

## 6. 钱（全部为预占上限；实付按 token 口径约为其 1/4）

| 动作 | 请求 | 预占上限 | 备注 |
| --- | --- | --- | --- |
| A/A 一轮 | 13 | ≈ 0.50（cap 1） | 实付 ≈ 0.13 |
| 假设一轮 | 13 | ≈ 0.50（cap 1） | 一个假设至少 2 轮 |
| propose-policy | 4 | ≈ 0.05（cap 0.3） | |
| compile --policy（5 题） | 8 | ≈ 0.20（cap 0.3） | |
| mint 一题（4 步） | 16 | ≈ 0.20（cap 0.3/步） | |

「校准 + 一个策略从提议到采纳」≈ 13+4+8+26 = 51 请求、预占 ≈ 1.75、实付 ≈ 0.45。几美元 ≈ 一次校准 + 2–3 个策略 / 旋钮假设出结论。

## 7. 没做 / 做不到（照实写）

- **权重训练**：没有 GPU 不做；`train/pairs.jsonl`（`cfb.pref-pair/1`）是给未来 DPO/ORPO 的原料，现在不是训练。
- **泛化声明**：留出题只有 2 道（池扩到 ≥10 题前都只是「不在提议集上」而非统计意义的泛化）。
- **提议器质量**：可能平庸；每次 ≈ 0.05，失败只损失这点钱和一次人工看结果。
- **铸造**：一道题仍需人写 u2 / followup；没有人在环，池扩不了。
- **仪器**：A/A 只估平局率与偏置；评委 LLM 的判据本身（next / avoid / falseDone 正则）没变。

## 8. 命令总表

```
node tools/cfb-cycle.mjs doctor
node tools/cfb-cycle.mjs plan [--round N] [--lever k=v|A/A|policy=ID] [--skip-aa] [--pricing FILE] [--force]
node tools/effect-ready.mjs doctor|run --live --v9 --round N          # 唯一花钱的评测命令
node tools/cfb-cycle.mjs ingest --round N [--report FILE]
node tools/cfb-cycle.mjs propose-policy [--gen N] [--parent ID] [--note 文字]
node tools/cfb-cycle.mjs compile --policy ID [--tasks a,b] | --mint ID [--gen N]
node tools/cfb-cycle.mjs mint --step a --scenario FILE | --step b --id ID [--gen N]
node tools/effect-ready.mjs doctor|run --live --gen --round N          # 唯一花钱的生成命令
node tools/cfb-cycle.mjs ingest-gen --gen N [--report FILE]
node tools/cfb-cycle.mjs policies | status | propose | simulate
```

自测：`test/closed-loop-v3.selftest.mjs`（16 项：判定 / 池 / 策略三闸 / 生成计划审计 / 三条端到端）与 `test/closed-loop.selftest.mjs`（25 项，F1/F2 已按 v3 语义改）。
