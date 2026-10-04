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
