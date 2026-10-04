# 统一科学训练闭环与官方基准指南（v14.18 合一版）

> 本文档整合了原先分散的 `CLOSED-LOOP-V2/V3/V4.md`、`CONTINUOUS-TRAINING-ARCHITECTURE.md`、`OFFLINE-ARCHITECTURE.md` 与 `RUNBOOK-*.md`，是 **训练压缩器、运行官方基准与执行省钱评测** 的唯一权威操作指南。

---

## 1. 训练架构核心理念：把压缩器训练到极致

在编码 Agent 多轮排障中，原生思维链存在四大顽疾：**跨轮上下文指数膨胀、死路失忆重走、只看不改内耗、未验证即伪称完成**。
`cfb` 的训练闭环不是盲目调参，而是通过 **四维全空间策略搜索 + 双轨（代码规则 × LLM 语义）裁判 + 五大国际官方基准尺子**，以最低 API 成本持续逼近压缩器理论极限。

### 1.1 四维全空间策略基因（`src/policy.js`）

每一条候选策略（`policy:<id>`）由 4 个正交维度的基因唯一确定（带 SHA-256 指纹）：

| 维度 | 策略键 | 作用与极限突破点 |
|---|---|---|
| **① 提示词层 (`patches` + `modularPromptPrune`)** | `rules.anchor` / `rules.closure` / `rules.triad` / `modularPromptPrune: true` | **反稀释动态裁剪**：当轮有【在手】代码时剥离取证分支废话，有【已排除】死路时强化禁重走疫苗；将提示词从 ~1,930 字瘦身至 ~893 字（`-53.7%`），消除指令注意力稀释 |
| **② 程序部件层 (`config`)** | `continuationPath: 'bounded'` + `statePartsMode: 'compact'` | **有界延续 + 紧致状态**：将 O(轮数) 增长的已走路径截断为最近 2 条并在【台账】保留曾涉文件出处（消除 `invented-identifier` 误杀）；剔除【已排除】/【未解】中已被正文覆盖的重复句子，净省 token 提升 **`+83.8%`** |
| **③ 生产制度层 (`regime`)** | `birthAdaptiveFloor: true` / `birthMinChars` / `birthTrigger` | **自适应 $\lambda$ 控制器**：早期轮次（`round ≤ 2`）抬高门槛至 `4200` 保护原生探索；深轮次（`round ≥ 4`）降至 `1800` 及时清理膨胀；连续只读停滞（`stagnantRounds ≥ 2`）降至 `1200` 强制注入死路疫苗 |
| **④ 少样本对齐层 (`exemplars`)** | `exemplars: [{ family, chosen, rejected, ... }]` | **In-Context DPO 自动注入**：从飞轮 `pairs.jsonl` 按跨家族隔离原则自动挑选高分 `chosen` vs 低分 `rejected` 对比锚点注入副模型，无需 GPU 重训权重即获 DPO 级对齐收益 |

---

## 2. 三模式科学训练闭环（`tools/cfb-cycle.mjs`）

```
Mode 1: 手写探顶 (ceiling)
   验证在真实多轮任务上手写理想压缩稿能否击败或打平 raw (hand.fixed && hand.rounds <= raw.rounds)
   ↓ 晋升入库 transfer/gold/
Mode 2: 金标基准与正交析因 (prescreen → plan-bench → bench-run → bench-report)
   在零污染金标 + 8 轮历史池上跑副模型压缩，跨计划 CAS 缓存复用，双轨裁判打分，飞轮自动采集偏好对
   ↓ 选出 Pareto 冠军策略
Mode 3: 影子分叉多轮轨迹验证 (plan-traj → traj-run → review → confirm)
   在 5 主池 + 5 留出池真实沙箱上跑主模型多轮排障，分歧前零主调用（Shadow-Forking），序贯 e-value 门禁晋升
```

### 2.1 零 API 离线飞轮四步曲（日常迭代首选，`$0` 成本）

```bash
# Step 1: 查看当前策略池、Pareto 前沿、排序器精度与下一步建议
node tools/cfb-cycle.mjs status
node tools/cfb-cycle.mjs next

# Step 2: 零 API 预筛全部候选策略 + 四维正交因子归因（主效应 ΔsavedTokens / Δtruth）
node tools/cfb-cycle.mjs prescreen

# Step 3: 双轨裁判（规则 × LLM 语义）交叉验证与 130 样本 L2 岭回归校准
node tools/cfb-judge.mjs capacity
node tools/cfb-judge.mjs calibrate

# Step 4: 飞轮自动采集胜负偏好对并导出 5 家族严格组隔离 SFT / DPO 数据集
node tools/cfb-cycle.mjs flywheel --harvest
node tools/cfb-cycle.mjs export-train
```

---

## 3. 五大国际官方基准融合（`npm run bench`）

我们将 2026 年国际公认的五大 AI 与编码 Agent 评测标准直接内置进 `tools/helpers/ruler.mjs` 与 `node tools/cfb-cycle.mjs benchmark`：

| 官方基准体系 | 融合进 `cfb` 的核心指标 | 评测意义 |
|---|---|---|
| **1. SWE-bench Pro / Verified** | **严苛解决率 (`F2P ∧ P2P ∧ !falseDone`)** + **伪修好水分 (`False-Done Gap`)** + **`pass@1` 无偏估计** | 揭穿「改了代码没跑测试就宣称修好」的刷分假象（实测揭露出 `ledger` 臂存在 **`16.7%` 伪修好水分**，而 `auto` 出生即压缩臂为 **`0.0%`**） |
| **2. TAU-bench ($\tau$-bench)** | **`pass^2` / `pass^k` 多轮连续可靠度** | 衡量压缩器介入后是否引入随机抖动（实测 `auto` 与 `raw` 均保持 `pass^2 = 0.778` 零退化） |
| **3. LMArena (Chatbot Arena)** | **Bradley-Terry MLE Elo 等级分 + 200 次 Bootstrap 95% CI** | 同题配对盲测：先比严苛解决，同解比步数，同步数比 token 成本（实测 **`auto = 1110`** vs **`raw = 1000`** vs **`ledger = 951`**） |
| **4. Artificial Analysis (AA Index)** | **智能-成本帕累托前沿 (`Cost/Verified-Fix`)** + **AA 密度效率 (`truth × savedTok / 1000`)** | 拒绝用高昂 token 堆砌分数，直接度量「每成功修好 1 题的真实美元成本」与「单位 token 节省的有效信息密度」 |
| **5. LiveBench / LiveCodeBench** | **零污染客观防刷分规则 (`dd/1`)** + **Thresholdout 留出集休眠保护** | 6 项确定性机械特征（锚点精确率、排除召回、落点命中、三元组闭合、零死路复活、未解召回）+ 留出集防过拟合 |

---

## 4. 个人开发者省钱评测三档菜单（`--lite` 极简预算模式）

针对个人开发者预算有限的场景，`cfb` 提供三档阶梯式验证，**95% 的日常迭代只需第 0 档（$0）和第 1 档（¥0.03）**：

### 第 0 档：零成本官方基准总表（`$0.00`，耗时 1 秒）
```bash
npm run bench
# 或：node tools/cfb-cycle.mjs benchmark
```
- 直接在已入库的 21 条真实多轮轨迹（`transfer/traj1..3`）与 8 轮金标基准（`b1/b2`）上计算全套五大官方指标。

### 第 1 档：极简金标基准测试（`≈ $0.004` / 约 ¥0.03，仅 1 次副模型调用）
```bash
npm run bench:lite
# 或指定候选策略：node tools/cfb-cycle.mjs plan-bench --lite --policies p-e62a037097
```
- **省钱机制**：自动锁定唯一轨迹验证金标 `g-sse-truncated-r3`，自动从 `b1` 缓存复用 `base` 臂结果（0 调用），**只对新候选策略发 1 次副模型请求**，立出与 `base` 的配对对比。
- 跑完预注册后执行真机调用：
  ```bash
  source ~/.secrets/keys.env
  node tools/bench-run.mjs --plan .cfb-offline/bench/bN.json
  node tools/cfb-cycle.mjs bench-report --plan N
  ```

### 第 2 档：IRT 最大信息量单题真机轨迹测试（`≈ $0.068` / 约 ¥0.50，硬顶 `$0.08`）
```bash
npm run traj:lite
# 或指定候选策略：node tools/cfb-cycle.mjs plan-traj --lite --arms raw,policy:p-e62a037097
```
- **省钱机制**：
  1. **IRT 自适应选题**：自动挑选当前区分度最高、最能暴露模型「只看不改」瓶颈的 1 道代表题（默认 `perf-regression`）；
  2. **4 轮硬上限（`--max-rounds 4`）**：实测好策略在前 4 轮内必定分出高下，砍掉第 5–8 轮无效空转；
  3. **影子分叉（Shadow-Forking）**：压缩首次生效前完全复用 `raw` 主模型调用（分歧前零双倍计费）；
  4. **单次预算硬锁（`$0.08`）**：一旦达到 `$0.08` 立即安全熔断。
- 执行真机轨迹与入账：
  ```bash
  source ~/.secrets/keys.env
  node tools/traj-run.mjs --plan .cfb-runtime/traj/tN/plan.json --store-text --variants raw,policy:p-e62a037097 --samples 1 --max-rounds 4 --fork --require-fp --only perf-regression
  node tools/cfb-cycle.mjs review --plan N && node tools/cfb-cycle.mjs confirm --plan N
  ```

---

## 5. 双轨裁判（Code × LLM Semantic Judge）使用详解

纯规则无法理解深层语义转折，纯 LLM 容易给啰嗦的长文打高分。`tools/cfb-judge.mjs` 将两条轨道融合并互相校准：

| 子命令 | 用途 | API 成本 |
|---|---|---:|
| `node tools/cfb-judge.mjs capacity` | 审计全部历史轨迹（`traj1..3` + `mr`）中模型的容量瓶颈与失真模式 | `$0` |
| `node tools/cfb-judge.mjs audit-draft` | 对指定压缩稿同时跑确定性规则（`draftDistance`）与语义诊断 | `$0`（加 `--llm` 调副模型） |
| `node tools/cfb-judge.mjs audit-bench --plan 2` | 扫描基准测试计划中的全部分数，自动标记规则轨与语义轨分歧项 | `$0`（加 `--llm` 调副模型） |
| `node tools/cfb-judge.mjs calibrate` | 在 `transfer/mr` 130 条真实多轮下游结果上做 L2 岭回归校准，输出最优特征权重与 LOO-RMSE | `$0` |

---

## 6. `< 0.1B`（`CFB-Micro-65M`）专用出生压缩微模型训练完整指南

由于出生即压缩器（Birth-Time Cognitive Compiler）**不需要通用世界知识或闲聊能力**，它的唯一使命是在 `8ms~20ms` 内将主模型冗长的原生思考链（`raw CoT`）无损编译为高信噪比、零幻觉、强行动导向的四段式认知状态。因此，我们将微模型严格控制在 **`≤ 0.1B`（推荐 `~65M` 参数，`0.065B`）**，彻底摒弃缓慢且易幻觉的自回归生成（Causal LM），采用 **「长窗口双向编码器 + 并行跨度指针 + 次模拟阵拼装」** 架构。

### 6.1 五大前沿学术支撑（为什么 `< 0.1B` 非自回归架构是理论最优解）

| 核心方法 | 文献来源 | 解决的核心工程与理论问题 |
|---|---|---|
| **1. 双向编码器分类替代自回归生成** | **LLMLingua-2** (Pan et al., ACL 2024) | 因果语言模型算单向熵会漏掉后文才揭晓的结论，且生成式压缩易产生幻觉并拖慢延迟。重定义为**双向 Transformer Encoder 的保留/丢弃与槽位分类任务**后，从结构上保证 100% 忠实于原文，速度提升 `3x~6x`，显存降低 `8x`。 |
| **2. 并行跨度指针网络（Span Pointer）** | **GLiNER / GLiNER2** (Zaratiana et al., NAACL 2024 / EMNLP 2025) | `50M~90M` 参数的双向编码器通过**并行跨度打分 `FFN(h_start, h_end)`** 将槽位标签与原文区间 $(i, j)$ 在统一隐空间内匹配，无需逐 token 解码即可击败数十亿参数 LLM，且原生支持导出 **ONNX 在纯 CPU 上毫秒级推理**。 |
| **3. 8K 长上下文去填充编码器底座** | **ModernBERT** (Warner et al., 2024/2025) | 引入 **RoPE（旋转位置编码）**、**局部/全局交替注意力（每 3 层 1 次全局注意力）**、**GeGLU** 与 **Unpadding（去填充序列拼接）**，使轻量编码器原生支持 **`8,192+` tokens** 超长思考链（如 `28,000` 字 `flaky-timeout`），消除二次方填充浪费。 |
| **4. 可控压缩比与关键捷径学习** | **TokenSkip & C3oT** (Xia et al., EMNLP 2025; Kang et al., 2025) | 先按执行结果正确性过滤轨迹，再在多档目标压缩预算 $\gamma \in \{0.20, 0.30, 0.45\}$ 下蒸馏关键因果步骤，仅需 `5K~7.5K` 样本即可砍掉 `40%~50%` 冗余思考且不伤推理准确率。 |
| **5. 步级无参考模型间隔偏好对齐** | **Step-DPO + SimPO** (Lai et al., 2024; Meng et al., NeurIPS 2024) | **Step-DPO** 证明在**单个推理步/认知槽位**粒度上构造正负偏好对仅需 `5K~10K` 对即可精准抑制死路；**SimPO** 用**长度归一化平均对数概率**作为隐式奖励并引入**显式目标间隔 $\gamma_{\text{dd}} > 0$**，砍掉参考模型（省 `50%` 显存）并彻底消除短稿长度偏置。 |

---

### 6.2 `CFB-Micro-65M` 六层混合架构设计（总参数量 `~65M < 0.1B`）

1. **输入层（Unpadded RoPE + 18 维符号特征，`~18M`）**
   - 输入 `[SLOT_PROMPTS] ⊕ ctx ⊕ raw`（支持 `8,192` tokens）；在每个话语单元（Discourse Unit）边界直接拼接 `src/compile-v5-local.js` 提取的 18 维确定性符号特征（复访次数、探查努力度、代码块标记、台账重合度等）。
2. **骨干编码器（8 层交替注意力 Transformer，`~42M`）**
   - `d_model = 512`，`n_heads = 8`，GeGLU 激活；每 3 层 1 次全局注意力、其余局部滑窗注意力，一次性看全首尾跨段依赖（如第 1 段怀疑某文件、最后 1 段证伪它）。
3. **Head A：话语单元槽位与保留概率头（LLMLingua-2 式，`~1.5M`）**
   - 对每个话语单元 $u_k$ 预测 6 类认知槽位分布 $P(s \mid u_k) \in \Delta^6$（`机理 / 决定 / 排除 / 验收 / 未解 / 噪音`）及条件预算 $\gamma$ 下的保留概率。
4. **Head B：反事实价值 $V(i)$ 与死路诱惑度 $T(i)$ 门控头（`~1.0M`）**
   - 双标量回归头预测信息价值 $\hat{V}(i) \in [0,1]$ 与诱惑度 $\hat{T}(i) \in [0,1]$，执行硬门控：**仅当 $\hat{T}(i) > \tau_{\text{tempt}}$ 时才允许进入 `已排除：`**，从根源上杜绝主模型未动念头的低诱惑项引发**反激活（Negative Priming）**。
5. **Head C：并行跨度指针头（GLiNER 式，`~2.5M`）**
   - 计算候选原文区间 $(i, j)$ 的跨度表征 $S_{i,j}$ 并与槽位向量做点积匹配，直接抽取 `target_file`、`old_text`、`new_text`、`verify_cmd` 的起止下标——**100% 为原文子串切片，从数学上根除编造标识符幻觉（G1 恒为 `1.0`）**。
6. **确定性闭合渲染器（`0` 参数代码层）**
   - 次模 + 划分拟阵贪心选取（见 `src/compile-v5-local.js`）$\to$ 填入中文四段式骨架 $\to$ 自动绑定同轮 `edit_file + bash` 指令 $\to$ `compileV4Direct` + `birthAccept` 双闸守门。

---

### 6.3 三级金字塔训练数据构建与自动清洗流水线

1. **L2 真机金标锚点池（权重 $5\times$）**
   - 直接采用 `transfer/gold/` 的 **11 条 Mode 1 真机满分金标**（`7 dev + 4 holdout`，Mode 1 `ceiling-9` 达成 `7W-0L-2T`、`e = 31.875 >= 10.0`、解决率 `100% vs 66.7%`、Prompt Token 净省 `-49.3%`）+ `transfer/oracle/M.json` + `.cfb-offline/train/pairs.jsonl` 的偏好对。
   - **严格物理隔离**：`holdout` 家族（`wrong-model`、`eacces-config`）严禁进入任何训练或超参搜索。
2. **银标蒸馏池（Teacher 蒸馏 + LLMLingua-2 双指标硬过滤，`3,000 ~ 5,000` 条）**
   - 在 20+ 类多轮排障长思考链上按 3 档预算 $\gamma \in \{0.20, 0.30, 0.45\}$ 蒸馏，执行三道自动化入库过滤：
     - **变异率过滤（Variation Rate $= 0$）**：通过 `inventedIdentifiers` 检查，凡含未在 `raw ∪ ctx` 出现的标识符一律拒绝或剥离；
     - **对齐间隙过滤（Alignment Gap $\le 0.05$）**：将蒸馏稿反向对齐回原文话语单元 $u_k$ 与跨度下标 $[i, j]$；
     - **G1 + G2 双闸过滤**：必须同时通过 `birthAccept` 与 `handDraftGate`。
3. **Step-DPO 步级反事实困难负例池（`10,000` 对）**
   - 对每条金标/银标自动通过局部单槽位破坏构造 5 类困难负例：
     1. **反激活负例**：往 `已排除：` 塞入 `ctx` 存在但 `raw` 未深入怀疑的低诱惑文件（训练 Head B 压低 $T(i)$）；
     2. **漏排除负例**：删掉 `raw` 反复证伪的高诱惑死路（训练 Head B 抬高 $T(i)$）；
     3. **三元组边界偏移负例**：将 `old_text` / `new_text` 跨度边界偏移 1~2 个 token（训练 Head C 指针锐度）；
     4. **机械提示污染负例**：在改代码前混入伪验收机械提示（训练模型拒绝伪提示）；
     5. **拆轮负例**：把同轮 `edit_file + bash` 拆成“本轮只改代码、下一轮再测”。

---

### 6.4 三步训练法与 ONNX INT8 部署准入

1. **阶段 1：多任务监督微调（StableAdamW Multi-Task SFT）**
   - 联合优化槽位分类（Head A）、跨度指针（Head C）与价值/诱惑度回归（Head B）：
     $$\mathcal{L}_{\text{SFT}} = \mathcal{L}_{\text{CE}}^{\text{slot}}(\text{Head A}) + \lambda_1 \mathcal{L}_{\text{BCE}}^{\text{span}}(\text{Head C}) + \lambda_2 \mathcal{L}_{\text{Huber}}^{V, T}(\text{Head B})$$
   - `65M` 参数在单张消费级 GPU 上跑 `5,000` 条样本仅需 **15~25 分钟**。
2. **阶段 2：步级无参考模型间隔偏好对齐（Step-SimPO）**
   - 无需加载参考模型，直接优化长度归一化隐式奖励与目标间隔 $\gamma_{\text{dd}}$：
     $$\mathcal{L}_{\text{Step-SimPO}}(\theta) = -\mathbb{E}_{(x, s_w, s_l)}\left[\log \sigma\left(\beta \left(\frac{1}{|s_w|}\log \pi_\theta(s_w \mid x) - \frac{1}{|s_l|}\log \pi_\theta(s_l \mid x) - \gamma_{\text{dd}}\right)\right)\right]$$
   - **超参护栏**：$\beta \in [0.5, 1.5]$（防过早饱和刷分），目标间隔 $\gamma_{\text{dd}} \in [0.5, 1.2]$ 按正负样本真实 `dd/1` 分差动态设定。
3. **阶段 3：次模拟阵配额校准与 ONNX INT8 导出**
   - 在 `dev` 集校准拟阵槽位配额（对应线性原型 `node tools/train-v5-micro.mjs` 与 `transfer/models/v5-micro-weights.json`），导出为动态 INT8 量化的 `model.onnx`（体积 **`~65MB`**，纯 CPU 推理 **`8ms~20ms`**）。
   - **三关准入考核**：① Mode 2 `holdout` 盲测 `G1=100%, G2=100%, dd/1 >= 0.90`；② Mode 3 `--fork` 真机轨迹解决率 $\ge \text{raw}$、平均轮数更少、$e \ge 10.0$；③ 生产收网超时或拒收时 100% 毫秒级无损回退 `passthrough`。

