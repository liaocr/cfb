# 统一科学训练闭环与官方基准指南（v14.20 合一版）

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

### 2.0 金标回收：改稿 → 离线重测 → 换稿（`tools/cfb-gold-repair.mjs`，v14.20.1）

金标被装置话术（越界）审计判死时，**正确动作是改稿，不是丢数据**：条目里真正值钱的是 `raw`/`ctx`/`calls` 与真机 `outcome`，越界只是稿子里的几句话。

```bash
node tools/cfb-gold-repair.mjs audit                    # active + 隔离区全量复算（$0）
#   RESTORABLE（稿子本就干净）→ 字节级放回，digest 不变 ⇒ 冻结的基准计划照旧可用
node tools/cfb-gold-repair.mjs restore --id A,B --apply
#   NEEDS-REWRITE → 只删越界句、保留归因/已排除/验收/未解槽位，然后 $0 复跑生产同一条闸链
node tools/cfb-gold-repair.mjs replay --id X --draft transfer/gold-repair/drafts-proposed/X.md
node tools/cfb-gold-repair.mjs stage  --id X --draft ...   # 全绿才暂存并登记 pending-retest.json
node tools/cfb-gold-repair.mjs next-cmds                   # 打印每条待复测的确切真机命令
# 真机复测过了才入库：node tools/cfb-cycle.mjs gold add --plan N --replace（旧条目自动归档 transfer/gold-history/）
```

定罪口径：`auditMode1Gold` = `draft ∪ stored`，但只定**作者自己写的主张**的罪；命中片段若整句、或「…」/`…` 定界引用内原样出现在 `raw ∪ ctx` ⇒ 判为报告观测、免检（记在 `qualityAudit.exempted[]`）。铁律不变：**离线全绿 ≠ 金标**，`outcome` 只能由模式 1 真机轨迹决定。

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
| **5. LiveBench / LiveCodeBench** | **零污染客观防刷分规则 (`dd/2`)** + **Thresholdout 留出集休眠保护** | 6 项确定性机械特征（锚点精确率、排除召回、落点命中、三元组闭合、零死路复活、未解召回）+ 留出集防过拟合 |

### 3.1 标尺口径 dd/2（v14.20.1 起；`DRAFT_DISTANCE_VERSION` 一改，旧计划按 `metric-mismatch` 拒跑）

`bench-run` 拿压缩器的稿与金标稿比六个槽位。dd/2 相对 dd/1 改了三件事，全是为了「分数别再混进非性能的东西」：

| 情形 | dd/1 | dd/2 |
|---|---|---|
| 过不了生产闸（`no-gain` / `no-token-gain` / `empty-candidate`） | 拿 `text = raw` 去比，白捡「决定 + 锚点」两项（实测 base 因此虚高到 0.519） | **记 0 分**，`verdict = refused:<why>`；原文那次的分数留在 `distanceOnRaw` 里可回看 |
| 调用失败（超时 / 异常，`distill-failed`） | 同上，跟"压不出"混在一起 | **不计分**（`distance = null`）、不进缓存、下次自动重试；回执单列 `errors` |
| 同一句内容换写法（「已排除：」↔「排除了：」、并句 ↔ 拆句） | 掉分（实测最多掉 0.35，因台账按 220 字上限丢长句） | **不掉分**：剥掉引导词后逐字命中即算召回，比对范围限「槽位内 + 其前后一段」，不是正文任意角落 |
| 只写引导词不写内容（空壳模板） | 未定义 | **三项判 0**（`A41d` 钉）；模板本身照旧受奖励 —— 配上内容仍是 1.000 |

固定句式（`本轮增量 / 改法只落一个 / 已排除 / 验收 / 未解`）是**协议**而不是风格：读者（主模型）按标签跳读，程序按标签抽台账，所给它继续受奖励，标尺不负责惩罚它。
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

## 6. `< 0.1B` CFB-Micro 出生压缩模型训练指南

本流程用**预训练双向编码器作教师模型**，再把任务信号蒸馏到当前同步 JavaScript 编译器使用的轻量特征头。教师模型不是从 1,538 条样本随机初始化训练：底座选用 [IBM Granite Embedding 97M Multilingual R2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)，Apache-2.0，约 97M 参数，覆盖中文、英文与代码；仓库把 HF revision 固定在 `835ad14087e140460703cf0fae09f97d469d65c2`。任务头也计入总参数，代码在训练前硬性检查 `totalParameters < 100,000,000`，超限就退出。

### 6.1 两条明确分开的推理路径

1. **完整教师编码器（高能力、可选部署）**：双向 ModernBERT 编码 + 槽位、价值/诱惑度、跨度和草稿偏好头；导出完整 INT8 ONNX。它支持跨语种和代码语义表示。当前训练把输入截到 `256` 个 tokenizer tokens；不要把模型卡的长上下文上限误报为本次训练/验收长度。
2. **紧凑学生（当前生产快速路径）**：将教师在 `dev` 上的信号蒸馏到 19 维符号特征 MLP 和偏好小头。同步、无外部运行时依赖的 `compileV5Local` 从唯一生产文件 `transfer/models/v5-micro-weights.json` 加载并校验权重，不保留第二份手写常量；`meta.promptVersion` 与 `meta.weightsDigest` 标识实际计分权重。**它不会在 JS 调用中执行完整 97M Transformer**。紧凑 ONNX 延迟仅代表学生，不代表完整编码器。`test/micro-runtime.selftest.mjs` 覆盖 JSON 加载、schema/特征顺序、token 惩罚、EXCLUDED 门控和默认编译路径；`test/micro-ruler.selftest.mjs` 覆盖长度分层读数自洽、Wilson 边界关系、去 token 惩罚指标、飞轮对非退化与构建器端点上限声明。

这样保留插件已有的低开销、可审计和原文落点守门路径，同时把完整神经编码器作为独立候选产物；不以固定 Gold 得分冒充教师模型的泛化证据。

### 6.2 严格隔离的数据与真实规模

运行 `node tools/build-micro-dataset.mjs` 会写出临时文件 `transfer/models/micro-dev-dataset.json`，训练脚本结束后删除。2026-10-04 的生成结果如下；今后以每次构建器实际 JSON 报告为准：

| 数据/审核项 | 当前计数 | 说明 |
|---|---:|---|
| dev Gold / dev Pool | 7 / 3 | 话语单元、跨度、反事实来源 |
| Unit 原始样本 | 1,538 | 全量分母；三个 family：`flaky-timeout`、`perf-regression`、`sse-truncated` |
| Unit 可训练 / needs-review | 569 / 969 | 可训练 37.0%；仅确定性规则筛选，未做 LLM/人工语义仲裁 |
| 跨度指针 | 57 | 文件、代码片段和验收命令 |
| Unit pair | 609 对 | 仅由可训练端点构成；端点度数上限 **3**，每个正例最多 3 对 |
| Unit pair 端点 | 569 个唯一端点 / 1,218 次引用 | 396 个端点被复用，占唯一端点 69.6%；实测最大度数 3 = 声明上限 |
| Unit pair 长度匹配率 | 308/609 = 50.6% | `|Δtoken| <= 3` 的对；困难负例挖掘见 6.2.1 |
| Draft pair 原始 / 可训练 / needs-review | 71 / 38 / 33 | 可训练 = 32 条真实飞轮对 + 6 条 Gold 对确定性反事实；其余 33 条不参与拟合 |
| 原保留 Gold holdout | 4 | `eacces-config`、`wrong-model` 不进训练；已在此前评测，不是全新盲测 |

标签审计当前是**规则支持筛选，不是语义审核完成**。Unit 的 969 条待审样本主要包含 `mechanism-heuristic-no-direct-gold-slot` 817、`competing-slot-overlap` 411、`noise-label-has-gold-overlap` 33、`noise-label-has-actionable-cue` 22（旗标可以重叠）；37 条 Draft pair 也被排除。训练脚本只使用 `trainingEligible=true` 的标签与 pair，并在数据文件保留逐条来源、依据、旗标和分母。

Unit 标签生成规则计数（“eligible”列是实际可训练数）：

| 规则 | 全量 | eligible |
|---|---:|---:|
| `gold-overlap-decided` | 150 | 91 |
| `gold-overlap-excluded` | 89 | 75 |
| `gold-overlap-acceptance` | 50 | 35 |
| `gold-overlap-open` | 30 | 29 |
| `decision-cue-plus-gold-overlap` | 14 | 12 |
| `excluded-cue-plus-gold-overlap` | 14 | 7 |
| `no-slot-cue-or-gold-anchor` | 374 | 320 |
| `mechanism-heuristic-only` | 817 | 0 |

Draft 33 条待审原因为被拒稿仍通过硬门（26）、配对分数 margin `<0.05`（6）、无正向距离 margin（1）。

#### 6.2.1 v14.20 数据构造与判定修复

1. **困难负例 = 长度匹配优先 + 模型最难优先**（`CFB_MICRO_NEG_STRATEGY=hardened`，默认）：候选负例先按 `|Δtoken| <= CFB_MICRO_NEAR_LENGTH_TOKENS`（默认 3）是否长度匹配排序，再按**当前生产打分最高的负例**（对模型最难）排序，最后才是旧的词面 hardness。旧行为等价于 `legacy`，保留为可选值以复现历史结论。端点上限与每正例对数可用 `CFB_MICRO_PAIR_DEGREE_CAP` / `CFB_MICRO_PAIR_PER_POSITIVE` 覆盖（默认 3 / 3）。
2. **常数占位分数不再被当成监督**：若飞轮来源里所有 pair 共享 ≤2 种分数对（历史版本是 122 条全部 `0.92 / 0.45`），整批降级为 `needs-review` 且不进入拟合，判定写入 `stats.flywheelScoresDegenerate`。
3. **真实飞轮对落库**：`tools/promote-flywheel-pairs.mjs` 把本地采集的 `.cfb-offline/train/pairs.jsonl` 过滤 holdout、保留分数与文本哈希来源后写成 `transfer/models/dev-flywheel-pairs.json`（schema `cfb.dev-flywheel-pairs/2`，当前 38 条 dev、6 种分数对）。Kaggle checkout 没有 gitignored 的 jsonl，过去只能读到常数占位文件，于是出现**本机 71/38 与 Kaggle 155/118 两套口径**；落库后两条路径都得到同一批 38 条真实对。这表明规则只保留有直接锚点/真实偏好依据的子集；需人工/LLM 逐条确认后才能称作语义审校完成。

SFT 和两类偏好数据采用**按 family 分组**的确定性 dev train/validation 切分；`_decoy` / `_long-horizon` 只归并到源 family，不能制造独立样本族。验证 family 仅按可训练 Unit 数量选择，尽量接近预设 20%，SHA-256 用作平局决胜，不按标签或分数挑选。当前可训练 Unit family 分母为 `flaky-timeout=367`、`perf-regression=39`、`sse-truncated=163`；实际选中 `sse-truncated`，占可训练 Unit `163/569=28.65%`（占全部 Unit `163/1538=10.60%`）。它已用于旧 checkpoint 选择，**绝不是最终盲测**。

### 6.3 Kaggle 免费 GPU 操作

需要 Kaggle Notebook 的 Internet 开启，以下载固定版本的公开模型；不需要付费 GPU。Notebook Secrets 添加 `GITHUB_PAT`，然后运行：

```python
%cd /kaggle/working
import os
from kaggle_secrets import UserSecretsClient

pat = UserSecretsClient().get_secret("GITHUB_PAT")
os.environ["GITHUB_PAT"] = pat
repo_url = f"https://x-access-token:{pat}@github.com/liaocr/cfb.git"

!rm -rf /kaggle/working/cfb
!git clone --depth 1 -b main {repo_url} /kaggle/working/cfb
!pip install -q "transformers==4.56.2" safetensors onnx onnxruntime requests

%cd /kaggle/working/cfb
# 若尚无新 family 盲测文件，省略 --final-test-dataset；脚本会报告 blocked 且绝不晋级生产权重。
# 新 family 文件需先独立语义审核，并作为 Kaggle Dataset 输入挂载：
!python3 tools/kaggle-train-micro.py --epochs-sft 12 --epochs-simpo 12 \
  --student-pair-objective listwise --dataset-neg-strategy hardened \
  --unit-pair-degree-cap 3 --unit-pairs-per-positive 3 --near-length-tokens 3 \
  --push-back
# 已有审核完成的独立新 family 时才追加：
#   --final-test-dataset /kaggle/input/cfb-final-family/micro-final-test.json
```

新增/变更的开关（可省略，省略即默认值）：`--student-pair-objective listwise|ranknet`（默认 `listwise`：对每个正例的负例组做 softmax 交叉熵，γ 仍按对保留；`ranknet` 为旧的成对 sigmoid）、`--dataset-neg-strategy hardened|legacy`、`--unit-pair-degree-cap`、`--unit-pairs-per-positive`、`--near-length-tokens`。后四个数据开关会作为 `CFB_MICRO_*` 环境变量传给 `tools/build-micro-dataset.mjs`，构造成果（策略、上限、长度匹配率、飞轮是否退化、数据集 SHA-256）都写进报告的 `data` 段。

训练使用低 encoder 学习率、warmup + cosine scheduler、梯度裁剪 `1.0`、按分组验证早停；双卡时启用 `DataParallel([0, 1])`。为避免 ModernBERT 内部 `torch.compile` 与 DataParallel 的 FX tracing 冲突，显式设 `reference_compile=False`；AMP 溢出跳过的优化器步会计数，scheduler 只在优化器实际更新后前进。日志只说明双卡并行已配置，不宣称 GPU 一直满载。

### 6.4 机器可读验收与晋级规则

- Teacher 与 compact student 指标分列；紧凑学生 Unit/Draft pair 指标在候选权重序列化后，通过 `tools/eval-micro-js-pairs.mjs` 调用 `src/compile-v5-local.js` 的实际 JS scorer 计算。Unit pair 比较 `scoreUnitWithWeights(...).v`（含 `lambda × tokenCount` 惩罚）；同一 scorer 同时执行 EXCLUDED 门控并报告门控审计数。**v14.20 起报告 schema 为 `cfb.micro-js-pair-eval/4`**，在历史口径（并列计 0 的严格点估计）之外还给出：① 并列半分口径；② 每个比例的二项 Wilson 95% 区间与 95% 下界；③ **长度分层**（`matched` = `|Δtoken| <= 3`、`near`、`far`）与**长度匹配子集**的准确率及下界；④ 把 `lambda × tokenCount` 加回后的**去长度惩罚分数**准确率，证明结论不是长度捷径；⑤ 「胜者更长 / 更短 / 等长」三组准确率。特征向量来自数据构建器调用的生产 `extractUnitFeatures`，端点、family 和复用上限在 evaluator 再校验。
- 训练脚本另外在可训练真实 Unit 与 Draft 特征上比较 PyTorch compact student、六位小数候选 JSON 和实际 JS scorer：最大绝对数值误差 `<=0.001`，并要求 Unit slot 与 EXCLUDED 门控判定一致。随机 ONNX 输入 smoke 只证明导出文件可运行，**不算 Python/JS 数值 parity**。
- 每轮都在**完整 train 与 family-held-out validation** 上重新计算 pair win rate，不再累计更新前的训练批次分数。报告分别列 Teacher、PyTorch compact head 和部署 JS 权重的分数与精确分母。
- `tools/train-v5-micro.mjs --eval-json <path>` 把实际 11 条 Mode 2 逐项结果和汇总写成 JSON；报告不再把 `1.0` 或 `11/11` 写死。
- **盲测集预检**：`tools/eval-micro-js-pairs.mjs --validate-dataset-only`（配合 `--final-blind-test --must-be-new-family --known-families ... --known-source-ids ...`）只跑一次性的结构/血缘/逐条审核校验，**不打任何分数、不写报告**：盲测集可以在启用前做结构预检，而预检过程不可能把分数泄露给调参者。
- **闸门读数**：90% 闸门仍按历史严格点估计判定（保持可比），但 val 集只有两三百对、draft 只有十余对，点估计自带几个 pp 的区间；`report.rulerReading.*.lengthMatchedAccuracy` 及其 Wilson 下界才是承重读数——在那里长度惩罚无法决定胜负。只在 `far` 层过线、`matched` 层不过线的候选，不能声称具备排序能力。
- 最终盲测只能在 checkpoint、代码、生产 JS 权重字段、训练目标、dev 数据和 split 冻结后，用 `--final-test-dataset <独立文件>` 对**一个此前未见、语义审核完成的新 family**执行一次。文件必须是 `cfb.micro-dev-dataset/3`，声明 `finalBlind: true`、`holdoutTouched: false`、`semanticReview.status: "completed"` 和逐类审核分母；每条 Unit/pair 的 `labelAudit` 必须保留来源/规则，并有 `semanticReview: { status: "confirmed", reviewer, rationale }`。顶层 `lineageReview` 要记录审核人/时间/新 family 理由；`knownFamiliesReviewed` 和 `knownSourceIdsReviewed` 必须与全部训练 lineage 精确匹配，`independentSourceIds` 必须与文件中的新 `sourceId` 完全一致且不与训练 source 重叠。Unit/pair 的每条 `sourceId` 都须能追溯到该新 family，Unit pair 不可跨 source；端点上限必须 `<=2`。`_decoy` / `_long-horizon` 变体和旧 `sse-truncated` validation 均会被拒绝。最终 Unit 与 Draft pair 也都要求 `>=90%`，结果只用于评估，不用于调参。
- 闸门口径 v2（2026-10-04 批准）：阻塞判据 = **三折家族交叉验证**（`report.threeFoldCv`，匹配桶 VS 生产同折：每折 ≥ 生产 + 20pp；均值 ≥ 0.75、最差折 ≥ 0.70；相对上一候选不回退超过 3pp；draft 合计 ≥ 0.85 且每折不低于生产）+ 部署路径检查（Mode 2 G1/G2、PyTorch→JSON→JS parity、INT8 ONNX smoke、总参数 `<100M`、dev-only 纪律）+ 一次性新 family（按 v2 判据：匹配桶 ≥ 0.75 且 ≥ 同族生产 + 20pp；draft ≥ max(0.85, 生产同族)）。
- 绝对 `>=90%` 点估计线（教师/学生、Unit/Draft）逐轮照常计算并展示在 `report.gates`、`report.gatePolicy`、`report.ceilingDistances`，但**不再阻塞**：同一模型三折匹配桶极差实测 22.9pp、最难族线性文本天花板实测 0.79，单族绝对线无法区分模型优劣。
- 其余原有条件不变：独立新 family 缺失时 gate 明确为 blocked，不降低阈值、不拿旧 holdout 冒充；未通过则只发布候选报告/权重/紧凑学生 ONNX，**不会覆盖**当前生产权重。缺少新 family 时 gate 明确为 blocked，不降低阈值、不拿旧 holdout 冒充；否则只发布候选报告/权重/紧凑学生 ONNX，**不会覆盖**当前生产权重。
- Teacher（全编码器）的 Unit/Draft preference validation 逐轮照常报告（`report.gates`、`report.ceilingDistances`、`report.gatePolicy`），但**不作为晋升阻塞项**：它是可选参考产物（INT8 约 98.7MB、CPU 单次约 280ms），无法服务同步 JS 运行时；部署打分器的等价保障由 compact student 与 JS runtime 两组 blocking 闸门承担。
- 产物报告：`transfer/models/cfb-micro-97m-report.json`。报告分别记录完整编码器 ONNX 与紧凑学生 ONNX 的尺寸、实测延迟、train/validation 胜率、Gold dev/holdout 分数及精确参数余量。完整 ONNX 大于普通 Git blob 安全阈值时，训练脚本会改发 GitHub prerelease asset；具体 URL 写入报告。推送需要 Notebook Secret `GITHUB_PAT`；大文件 release 还需要该 token 有创建 release/上传 asset 的权限。

快速本地复核已晋级的 JS 学生权重：

```bash
node tools/train-v5-micro.mjs --eval-only \
  --weights-path transfer/models/v5-micro-weights.json \
  --eval-json /tmp/cfb-micro-mode2.json
```

