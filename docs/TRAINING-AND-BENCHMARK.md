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

## 6. `< 0.1B` CFB-Micro 出生压缩模型训练指南

本流程用**预训练双向编码器作教师模型**，再把任务信号蒸馏到当前同步 JavaScript 编译器使用的轻量特征头。教师模型不是从 1,538 条样本随机初始化训练：底座选用 [IBM Granite Embedding 97M Multilingual R2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)，Apache-2.0，约 97M 参数，覆盖中文、英文与代码；仓库把 HF revision 固定在 `835ad14087e140460703cf0fae09f97d469d65c2`。任务头也计入总参数，代码在训练前硬性检查 `totalParameters < 100,000,000`，超限就退出。

### 6.1 两条明确分开的推理路径

1. **完整教师编码器（高能力、可选部署）**：双向 ModernBERT 编码 + 槽位、价值/诱惑度、跨度和草稿偏好头；导出完整 INT8 ONNX。它支持跨语种和代码语义表示。当前训练把输入截到 `256` 个 tokenizer tokens；不要把模型卡的长上下文上限误报为本次训练/验收长度。
2. **紧凑学生（当前生产快速路径）**：将教师在 `dev` 上的信号蒸馏到 19 维符号特征 MLP 和偏好小头。同步、无外部运行时依赖的 `compileV5Local` 使用这个学生权重；**它不会在 JS 调用中执行完整 97M Transformer**。紧凑 ONNX 延迟仅代表学生，不代表完整编码器。

这样保留插件已有的低开销、可审计和原文落点守门路径，同时把完整神经编码器作为独立候选产物；不以固定 Gold 得分冒充教师模型的泛化证据。

### 6.2 严格隔离的数据与真实规模

运行 `node tools/build-micro-dataset.mjs` 会写出临时文件 `transfer/models/micro-dev-dataset.json`，训练脚本结束后删除。当前数据规模以生成器输出为准：

| 数据 | 当前计数 | 用途 |
|---|---:|---|
| dev Gold | 7 | 话语单元、跨度、反事实样本 |
| dev Pool | 3 | 补充单元与反事实样本 |
| 单元样本 | 1,538 | Head A/B/C 监督 |
| 跨度指针 | 57 | 文件、代码片段和验收命令 |
| Unit Step-SimPO | 2,452 对 | 单元级正负偏好 |
| Draft Step-SimPO | 155 对 | 反事实 + 过滤后的 dev 飞轮偏好 |
| 原保留 Gold holdout | 4 | `eacces-config`、`wrong-model` 不进训练数据；这 4 条已在此前运行中评测过，因此后续报告按固定安全门禁处理，不冒称全新盲测 |

SFT 和两类偏好数据采用**按 family 分组**的确定性 dev train/validation 切分；同一 family 不跨两边。验证 family 仅按样本数选择，尽量接近预先设定的 20% 验证比例，不按标签或得分挑选；每次报告会写出实际 `validationFamily`、样本比例、样本数和训练/验证胜率。验证集规模有限，因此它是分组 dev 验证，不替代更多任务家族上的外部泛化测试。

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
!python3 tools/kaggle-train-micro.py --epochs-sft 12 --epochs-simpo 12 --push-back
```

训练使用低 encoder 学习率、warmup + cosine scheduler、梯度裁剪 `1.0`、按分组验证早停；双卡时启用 `DataParallel([0, 1])`。为避免 ModernBERT 内部 `torch.compile` 与 DataParallel 的 FX tracing 冲突，显式设 `reference_compile=False`；AMP 溢出跳过的优化器步会计数，scheduler 只在优化器实际更新后前进。日志只说明双卡并行已配置，不宣称 GPU 一直满载。

### 6.4 机器可读验收与晋级规则

- 每轮都在**完整 train 与 family-held-out validation** 上重新计算 pair win rate，不再累计更新前的训练批次分数。
- `tools/train-v5-micro.mjs --eval-json <path>` 把实际 11 条 Mode 2 逐项结果和汇总写成 JSON；报告不再把 `1.0` 或 `11/11` 写死。
- 只有以下条件全部满足，才将 candidate 晋级为生产权重：总参数 `<100M`、Unit validation `>=90%`、紧凑学生 Draft validation `>=90%`、Mode 2 的 G1/G2 全通过、完整 INT8 ONNX 导出及 ORT smoke test 成功。否则只发布候选报告/权重/紧凑学生 ONNX；成功导出的完整编码器 ONNX 仍会持久化为候选文件或 GitHub prerelease asset，**不会覆盖**当前生产权重。
- 产物报告：`transfer/models/cfb-micro-97m-report.json`。报告分别记录完整编码器 ONNX 与紧凑学生 ONNX 的尺寸、实测延迟、train/validation 胜率、Gold dev/holdout 分数及精确参数余量。完整 ONNX 大于普通 Git blob 安全阈值时，训练脚本会改发 GitHub prerelease asset；具体 URL 写入报告。推送需要 Notebook Secret `GITHUB_PAT`；大文件 release 还需要该 token 有创建 release/上传 asset 的权限。

快速本地复核已晋级的 JS 学生权重：

```bash
node tools/train-v5-micro.mjs --eval-only \
  --weights-path transfer/models/v5-micro-weights.json \
  --eval-json /tmp/cfb-micro-mode2.json
```

