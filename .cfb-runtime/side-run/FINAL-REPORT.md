# 副模型训练 + 真机采集 · 一次性交付报告（2026-10-06）

> 全程只走 `api.a6api.com/v1` / `deepseek-v4.1-flash`，**不带 `--require-fp`**（该渠道 `system_fingerprint` 恒 null）。
> 实付合计 ≈ **$0.45**（b14 4 发 + b15 6 发 + t102/t103/t104/t105 四个模式 3 单元 + 若干探针）。
> 生产权重 `transfer/models/v5-micro-weights.json` 未动（sha256 仍 `da949e63…`）。

## 1. 渠道判定（更正）

| 项 | 结果 |
|---|---|
| 思考 | ✅ `thinking:{type:"enabled"}` 与 `reasoning_effort` 两形状都回 `reasoning_content` |
| **拼接历史 reasoning** | ✅ **`traj-run` 预检实测：携带 Δ587 tokens / 1200 字 = 0.489 ≥ 0.3 ⇒ `carry-verified`**；埋雷 canary（把"真实端口 9371"藏进上一条思考）模型明确引用 ⇒ 上下文可见 |
| 指纹 | ❌ 恒 `null` ⇒ 关掉 `--require-fp`（用户批准） |

**我先前判"拼接=否"是错的**：错在拿 `usage.prompt_tokens` 的 Δ 当证据 —— 该中转对 prompt 计数不敏感（埋雷/对照都 357/357），Δ 口径在这渠道必然假阴性。承进口径是 `traj-run` 的 carry 比值 + canary 行为。

## 2. 训练好的副模型 = 策略 `p-56e56fcd9c`

`node tools/cfb-cycle.mjs synthesize-policy --contrastive`（parent=base，patches=1）：

```json
{"compressLocalModel":true,"continuationPath":"bounded","programParts":"compact","promptMode":"modular","birthAdaptiveFloor":true}
```

| 读数 | base | **p-56e56fcd9c** | 榜首要例 p-1490eefcdf |
|---|---|---|---|
| prescreen 金标过闸 | 7/13 | **12/13** | 12/13 |
| 金标净省 tok | 167 | **431** | 431 |
| 金标 dd（距极限） | 0.574[预估] | **0.724[实测]** | 0.724[实测] |
| 真值分 / 密度效率分 | 0.755 / 0.6729 | **0.781 / 0.7234** | 0.781 / 0.7234 |
| 提示词增量 | +0 | **−112 字** | −1037 字 |
| 状态 | 未实测 | **✓已实测** | ✓已实测 |

**真机模式 2 基准（b15，6 次压缩调用，dev 2 题）**：

| 策略 | n | 分 | 锚点精度 | 闸失败 | 判词 |
|---|---|---|---|---|---|
| base | 2 | 0.496 | 0.992 | 0 | **invented-anchors×1** partial×1 |
| **p-56e56fcd9c** | 2 | **0.500** | **1.000** | **0** | partial×2 |

配对 1胜 0负 1平 → `e=1.5`（阈 10）⇒ **undetermined，champion 仍是 base**。我没有动阈值/判据；要过采纳线需 ≥12 对同族配对（`simulate --p 0.7`：中位 12 对、p90 25 对），按 $0.10/对 ≈ $1.2 量级。

**真机模式 3（t102 flaky-timeout，policy 臂 vs raw）**：prompt tokens **2582 vs 5691（−55%）**、上下文 reasoning 字数 3267 vs 7276、压稿成功 2/4、程序部件/原文 中位 0.12（最大 0.3）；两臂都"未修好"（1 对样本，结局无差异）。t105 还量到一次 `闸拒 invented-identifier` ⇒ 生产闸在真环境咬住了稿子。

## 3. 我改了的一处代码（入库文件，1 行）

`tools/cfb-cycle.mjs:1829` 合成器 config 补 `compressLocalModel: true`。
**修前实测**：`synthesize-policy` 产出的"极限策略"不带这个键 ⇒ 本地部署通道 **G1 过闸 0/13、压缩后/原文 1.000、净省 0**（完全不压）；修后即上文 p-56e56fcd9c 的 12/13。`node --check` 通过；`npm run manifest` → 572 文件 / 漂移 0 / 缺失 0。

## 4. 攒到的数据（真机 4 单元）

| 项 | 前 | 后 |
|---|---|---|
| 飞轮偏好对 `.cfb-offline/train/pairs.jsonl` | 80 | **85**（sse-truncated 43→48） |
| CPU 排序器 留一 CV | 0.762 | **0.800** |
| dataset `stepSimpoPairs` | 55 | **60** |
| dataset `trainEligibleStepSimpoPairs` | **17** | **21** |
| 金标 / `handSamples` | 13 / 32 | **13 / 32（+0）** |
| 效度账本（L1↔L2） | — | **+5 对** |
| 微模型 `devUnitSamples` / `devPreferencePairs` | 308 / 80 | **3716 / 85** |
| `devPairwiseAccuracy` | 0.6625 | 0.6353（+5 对且更难） |

## 5. 微模型现状（不粉饰）

- 候选权重：`.cfb-runtime/micro-candidate/weights-r2.json`，`trainedOn: dev-only (4 gold:dev + 26 traj:train + 0 pool:dev + 85 flywheel:dev)`
- general 臂（权重唯一进字节的通道，13 条金标）：生产 **0.4140** → 新训 **0.4123**（−0.0017），但 **12/13 条产出字节确实被权重改变** ⇒ 在动，净为零
- 4 题尺子：0.6665 / closeCount 0/4 不变（结构断路：4/4 命中 5 个硬编码模板，模板编译器不吃权重）
- 距 draft 闸（`≥0.85` 且 Wilson 下界 ≥0.75 需 n≥80）：可用对 **21**，缺 59；其中 `draftPairReviewStatusCounts.needs-review = 38` 是 $0 盲审可回收的
- `devPoolCount` 仍 **0**（`gen-2.pack.json` 无 `pool` 键，结构错配，未动）
- JS 侧 `mlpHead` 仍是抄生产的 ⇒ 真正要动头，得走 `kaggle-train-micro.py`
- 晋级：`kaggle-train-micro.py` 的 `--production` 覆盖通道未使用；生产权重保持原样

## 6. 建议的下一步（按性价比）

1. **$0**：把 38 条 `needs-review` draft pair 盲审掉 ⇒ `trainEligibleStepSimpoPairs` 17→~55，先让 draft 侧有可判的下界；
2. **≈$1.2**：连跑 ~12 个 `plan-traj --lite` 单元攒同族配对，把模式 2 的 `e` 从 1.5 推到 ≥10 ⇒ 才有资格采纳 champion；
3. 金标 +0 的原因是 hand 臂这几轮没有"过闸且修好"的稿 ⇒ 想要金标就得跑模式 1（`gold-campaign`），这既是金标也是 micro 的 `handSamples` 通道。


---

# 追加：全面开跑（6 个真机模式 3 单元 t106–t111，2026-10-06 当日第二轮）

## A. 真机结局（raw vs policy:p-1490eefcdf，每单元 1 组 × ≤4 轮，$0.08 硬顶）

| 单元 | 场景 | raw prompt tok | policy 臂 prompt tok | 上下文 reasoning 字 | 结局 |
|---|---|---|---|---|---|
| t102 | flaky-timeout | 5691 | **2582** | 7276 → 3267 | 平（都未修好） |
| t106 | flaky-timeout | 10713 | **2770** | 24791 → 3509 | 平 |
| **t107** | flaky-timeout | 6170 | **2548** | 6587 → 3563 | **胜：policy 臂 r4 修好、edit 1、修后验收 100%；raw 未修好** |
| t108 | flaky-timeout | 5518 | 0（全程影子，未分歧） | 8130 → 3079 | 平（按平手计） |
| t109 | flaky-timeout | 8498 | **3066** | 10873 → 3666 | 平 |
| t110 | flaky-timeout | 6314 | **2716** | 26842 → 3550 | 平 |
| t111 | flaky-timeout | 8331 | **2767** | 11426 → 3345 | 平 |

可比 6 臂均值：**policy 2742 tok vs raw 7319 tok = −62.6%**，压稿成功率 **100%（t108 闸拒 invented-identifier×1 在 t105）**。

## B. 采纳判定（没动任何阈值）

`confirm --plan 107 --map champion=policy:p-1490eefcdf,previous=raw` → `配对 1（flaky-timeout:win）；e=1.5，「更差」e=0.5，阈 10` ⇒ **undetermined，champion 仍是 base**。
数学：1 胜只把 e 推到 1.5，要 ≥10 需 ~7 场净胜；按本轮命中率（7 单元 1 胜 6 平）≈ **45–50 个单元 ≈ $5**。平局不计证据 —— 这是判据的设计（不许拿平手当优势）。

## C. 数据与训练增量（真机 6 单元）

| 项 | 前 | 后 |
|---|---|---|
| `.cfb-offline/train/pairs.jsonl` | 85 | **87**（flaky-timeout 23→25） |
| `dev-flywheel-pairs.json`（入库回退，promote 后） | 67 常数占位 | **72 对、15 种不同分差、contaminatedRows 0** |
| dataset `stepSimpoPairs` / **trainEligible** | 60 / 21 | **62 / 23** |
| 效度账本（L1↔L2） | — | **+12 对** |
| 金标 / handSamples | 13 / 32 | **13 / 32（+0）** |
| 微模型 `devPreferencePairs` / `devPairwiseAccuracy` | 85 / 0.6353 | **87 / 0.6437** |
| `devUnitSamples` | 3716 | 3716（unit 只来自金标，真机单元不加 unit） |
| ranker 留一 CV | 0.800 | 0.770（+2 对更难） |

微模型候选 `.cfb-runtime/micro-candidate/weights-r3.json`：general 臂 13 条 生产 0.4140 → r3 0.4123，**12/13 条产出字节被权重改变、r3 更优 1/13、更差 1/13** ⇒ 线性头仍在噪声带内。

## D. 渠道状态（重要）

`t106` 的预检耗时 **226 秒**（`t102` 是 4.4 秒）⇒ 上游延迟恶化 ~50×，但**每次都判 `carry-verified`（Δ587/1200 = 0.489）**，拼接稳定。整轮 6 单元未出现 `upstream-no-reasoning`。

## E. 收口

`npm run manifest` → **572 文件 / 漂移 0 / 缺失 0**；本轮共 33 个跟踪文件变更（含 `tools/cfb-cycle.mjs` 的一行合成器修复、`.cfb-offline/train/pairs.jsonl`、`transfer/models/dev-flywheel-pairs.json`、`transfer/models/micro-dev-dataset.json` 与 4 个文档/CHANGELOG 水印项）。**生产权重仍 `da949e63…` 未覆盖。**


---

# 追加二：模式 1 锻金标战役 + v9 采纳通道（同日第三轮，真机）

## 战役（真机，模式 1 hand 臂）

| 单元 | 配置 | 结果 |
|---|---|---|
| t112 | eacces-config, wrong-model, sse-truncated × decoy × ≤8 轮 × 3 投放 | **修好率 67%（2/3）· 到修好 6.5 轮 · edit 1.7 · 修后验收 100% · 声明相称 100% · 压稿成功 100% · 19921 tok · 新 hand 样本 +3 · 停机/错误 0** |
| t113 | perf-regression, flaky-timeout × long-horizon × 2 投放 | 4 行 · **新 hand 样本 0** |

## 金标轴通过率（`gold-score --dedup`，19 唯一 id）

`M1 19/19 · M2 19/19 · M3 13/19 · M4 11/19 · M5 16/19 · M6 13/19 · M7 19/19 · **M8 7/19** · **E1 7/19** · E2 18/19 · **R1 8/19** · R2 14/19`
⇒ `gold 4 · provisional-gold 0 · not-gold 15`；可当标尺仍只有 `sse-truncated-s0-r4, sse-truncated-s1-r3, wrong-model-s0-r6, wrong-model-s1-r5`。
不达标的原因被复算逐条写明，**全是证据轴**：`R2 独立趟数 n=1 ⇒ provisional`、`R1 缺 逐字对齐`、`E1 漂移：draft≠台账所发(1288/494 字) ⇒ 这轮的分数是旧稿挣的`。

## 产线 vs 金标（`tools/gold-vs-line.mjs`，13 条，$0）

**12/13 过 G1**；线长比 `0.29 – 0.72`（多数 0.41–0.52）；唯一失败 `sse-truncated_decoy-s0-r4` 线长比 **1.303 ⇒ `no-gain`**（稿比原文长）。

## 模式 2 重测（b16，真机 6 次压缩调用）

`p-56e56fcd9c` dev **0.500 · 锚点精度 1.000 · 闸失败 0** vs `base` 0.496 · 0.992 · `invented-anchors×1`；
配对 1胜 0负 1平 ⇒ **e=1.5，阈 10 ⇒ undetermined**。dev 标尺侧只有 2 题 ⇒ 单轮 e 的上限就是这么低。

## v9 采纳通道（`plan → prepare → run --live → ingest`）实况

我先试了正道：`compile --policy p-56e56fcd9c --gen 3` 冻结成功（8 请求 / $0.3 上限），但 `effect-ready doctor` 四条 blocked：

| 检查 | 状态 | 我的处置 |
|---|---|---|
| `model-key-present` | blocked | 可解：doctor 不读 `keys.env`，要进程环境里有 key（我漏 source 了） |
| `source-current` | blocked | 可解：我修 `cfb-cycle.mjs` 后源码摘要变了 ⇒ 重新 `compile`+`prepare` 即可 |
| `api-pricing-required` | blocked | **要你给**：真实中转价表（输入/输出 $/M、每请求固定费） |
| `pricing-current-not-example` | blocked | **要你给**：7 日内核对记录；样例/上游价不行 |

我试过**用渠道自己的 `usage.cost` 反解价格**（3 发实测）：这个上游 `usage.cost` **不返回**（`prompt/completion/cost = 33/1/None, 33/278/None, 2929/1/None`）⇒ 无法诚实填价，**我不会编一个数去让闸变绿**，所以 v9 轮次开不了。

## 数据侧的净效应（要认）

`pairs 87 → 87（+0）`；dataset `stepSimpo 62 → 57`、`trainEligible 23 → 19` —— **新 hand 样本按同格规则顶掉了旧的合格行**（`supersededRevisions`），而新行尚未合格 ⇒ 微模型可用对子净减 4；微模型 `devPairwiseAccuracy` 停在 **0.6437**，尺子仍 0.6665 / closeCount 0/4。

## 现在把副模型推到"稳定金标质量"只差两样（都不是再写补丁）

1. **a6api 的实际价表** ⇒ 打开 v9 采纳通道：每轮 ≤5 对+3 探针 ≈$0.13，累计 ~7 场净胜 ⇒ e≥10 ⇒ champion 采纳（我不会降阈）。
2. **同格第二趟真机（R2 独立趟数 ≥2）+ 逐字对齐（R1）** ⇒ 尺子侧从 4 条扩起来（dev 从 2 题 → 6+ 题）⇒ e 才有增长空间，`gold add` 也能真转正。

给我价表（三行数字）我立刻把 v9 轮次开下去；或者让我继续烧模式 1 单元攒 R2 趟数（每个 ≈$0.07–0.11），两条我都能自己跑完。


---

# 追加三：价表落地 → 采纳通道打开到运行期，卡在一个**渠道保真事实**上（同日第四轮）

## 1 · 价表已录入并过闸（你给的 1 / 4 / 0.02）

`.cfb-runtime/pricing.a6api.json` = `{inputUsdPerMillion:1, outputUsdPerMillion:4, requestFeeUsd:0.02, source:"https://api.a6api.com/pricing", verifiedAt:"2026-10-06"}`
⇒ `api-budget.mjs:47-50` 的三条校验（字段集必须恰好这 5 个 / source 是无凭据无 query 的 https / 日期自洽且 ≤7 天）全过 ⇒ `pricing-current-not-example` **由 blocked 转 pass**。

## 2 · 修掉一个真 repo bug（`--gen` 轮此前永远开不了）

`tools/helpers/generation.mjs` 的 `buildGenerationPlan` **不写** `sourceHashes/sourceDigest`，而 `sourceDifferences(plan)` 拿 `plan.sourceHashes` 比对 ⇒ 62 个源文件全被判漂移 ⇒ `source-current` 对任何生成轮恒 blocked。
补齐 4 行（只加记录，**没动任何判据**）后：`compile --gen 6` 冻结 → `effect-ready doctor --gen --round 6` = **`live-preflight-ready`，13 项全绿**（含 `source-current / pricing-and-matrix / pricing-current-not-example / model-key-present`）。

顺带量到预算形状：`APPROVED_API_LIMITS_GEN = {8 请求, USD 0.3}` 是**最坏预占**口径（`inputTokenBound×$1/M + max_tokens×$4/M + $0.02`）⇒ 5 题 8 请求会被 `api-budget-plan-exceeds-approved-usd` 拒；**每个 gen 轮只能带 ≤3 题**（6 请求 / 预占 USD 0.249146）。

## 3 · 真机跑了，停在探针上（这轮的硬事实）

| 试的 | 结果 |
|---|---|
| `run --live --gen --round 4` | 第 1 发 `probe` ⇒ **`response-incomplete`** ⇒ 整计划 halt；`requestsReserved 1 / 预留 USD 0.026625` 已计费，**0 个主请求发出**；`transfer/api-budget-approval-gen-g4.watermark.json` 已封存（一轮一签） |
| 手动复现探针 cap=2048 | `finish: length`、`completion_thinking_tokens 2048`（思考烧满）、可见内容 `""`、**`usage.credit = 0.24`**（这渠道不给 `usage.cost`，但给 `usage.credit` ⇒ 以后能拿它对账价表） |
| 手动复现探针 cap=8192 | `finish: stop`、`model` 回显 `deepseek-v4.1-flash` 精确相等、`fp: null`、思考 5619 字，**可见答案只有 1 个字「无」**、canary 未命中、**`prompt_tokens = 66`** |

**判读**：探针要模型逐字回显的是**注入在上一轮 `reasoning_content` 里的 69 字标记**；可见三段文本本身就 ≈60 tokens，而 `prompt_tokens` 只有 66 ⇒ **这段 reasoning 没有被拼进 prompt**，答「无」是正确答案。加大 `max_tokens` 也救不了（8192 实测已过 `finish: stop`）。
⇒ `api-budget.mjs:195` 的 `api-probe-required` 是硬序（主请求必须在探针被接受之后），所以 **v9 / gen 的真机轮在这条渠道上过不了运行期闸**。
（更正一处我自己的噪声：中途出现的 `channel-model-mismatch` 是我手搓调用把整份 plan 当 `expectedModel` 传给 `channelIssue(r, expectedModel, …)` 造成的，**与渠道无关**。）

同期通道本身还在抖：`GET /models → 504 Gateway Time-out`（10.9 s）、一次 `fetch failed` ⇒ 这段时间不宜继续烧。

## 4 · A 计划（同格第二趟）实测：没长成，且我知道为什么

`gold-campaign --attempts 1` ⇒ `.cfb-runtime/traj/t114` 落 3 行、**新 hand 样本 0 条**；注册表仍 `active 13 · 隔离 6`，`gold-score --dedup` 一字未动：
`合计 19 行 / 19 唯一 id：gold 4 · provisional-gold 0 · not-gold 15`；`M1 19/19 · M2 19/19 · M3 13/19 · M4 11/19 · M5 16/19 · M6 13/19 · M7 19/19 · M8 7/19 · E1 7/19 · E2 18/19 · R1 8/19 · R2 14/19`。
⇒ **战役造的是"新格"，不是给同一格补第二趟**；要攒 `R2 独立趟数 ≥2` 必须拿**原计划续跑**：`node tools/traj-run.mjs --plan .cfb-runtime/traj/t112/plan.json`（同格同 id 再消费一遍那份稿）。我没再花第三遍钱试。
`gold audit` 顺带报出：隔离区 6 项全部「要改稿」（`environment-permission-assertion / experiment-round-or-budget-control / executor-tool-or-check-prohibition`），可直接恢复 0；另有 1 条量过但不够格当天花板（vsRaw loss）躺在 `transfer/gold-repair/measured/`，可当模式 2 素材。
数据侧本轮无变化：`dataset unit 542 · simpo 57 · trainEligible 19 · hand 32`；微模型 `devPairwiseAccuracy 0.6437`、尺子 `0.6665 / close 0/4`。

## 5 · 本轮花费与完整性

真机合计 **≈$0.05**（g4 探针预留 0.0266 + 2 发诊断）+ t114 战役 ≈$0.07；`g5 / g6` **无收据 ⇒ 预算未动**。
`npm run manifest` → **573 个文件 / 漂移 0 / 缺失 0**；生产权重 `da949e63…` 未覆盖；`tools/helpers/generation.mjs` 净改动就是第 2 节那 4 行。

## 6 · 三条可选下一步（都很快，我等你点一条）

1. **换渠道**：只要它真把 `reasoning_content` 拼进上下文，我直接 `run --live --gen --round 6`（≤6 请求 / ≤USD 0.25）→ `ingest-gen --gen 6` → `plan --round 2 --lever policy=p-56e56fcd9c --pricing …` → v9 轮跑到 e≥10（估 ≈$1.2，现在价表生效，预留/实付都会进账本）。
2. **换保真口径**（要你点头，因为是判据代码）：把 live 轮的探针判定从「canary 逐字回显」换成 traj/bench 一直在用的 `carry-verified`（`prompt_tokens` 随历史 reasoning 线性增长）。你早前定过「不用改」，所以我不擅自改。
3. **就此收口**：`p-56e56fcd9c`（12/13 金标过闸 · 净省 431 tok · dd 0.724[实测] · dev 0.500/锚点 1.000/0 闸）+ `weights-r4`（0.6437）就是当前已测结果；我把待提交的 33 项按两个 commit 收口（fix(cycle) 一行 + 合成器修复 / data(assets) 轨迹与金标与 dataset），要点头。


---

# 追加四：换渠道后 v9 闭环第一次真转起来（同日第五轮，真机）

## 1 · 渠道复测（一发定性）

同一枚 g6 冻结探针：`prompt_tokens 112 / completion 168 / finish:stop / model 回显精确相等 / fp:null / 2.76 秒`，**canary 逐字命中 true**。对比换渠道前（`prompt_tokens 66`、可见答案「无」、20–27 秒、504）⇒ **这条渠道真把 `reasoning_content` 拼进上下文**，v9/gen 的 `api-probe-required` 硬序从此可过。

## 2 · 为跑通而做的三处修改（都不是判据）

| 位置 | 症状（实测） | 改法 |
|---|---|---|
| `tools/helpers/generation.mjs` `PRODUCTION_COMPRESSOR` | gen compile 主请求按生产体 `max_tokens 1600 + thinking:disabled` 发出 ⇒ 本渠道思考关不掉，g6 两发 `response-incomplete` 后 halt | 编译作业输出预算改为可注入 `CFB_GEN_COMPILE_MAX_TOKENS`（默认 5120；g10/g11 用 8000）；预算闸按最坏预占重算仍 ≤USD0.3 |
| 探针 `max_tokens 512`（gen + v9） | g8 实测 512 会被思考烧满 ⇒ 探针被拒、整轮 halt、收据白烧 | 512 → **1024**（只改 gen 与 v9 两处；v1/v2/v3 老 scope 保持 512 字节不变）⇒ g9/g10/g11 探针全 `accepted` |
| `tools/cfb-cycle.mjs:341` | `plan --force` 打印阶段 `TypeError: r.plan.variants undefined` | 加空值保护 `(r.pairs || [])` / `r.plan?.variants?.[...]`，只防崩不改判定 |

## 3 · 策略 `p-56e56fcd9c` 首次达到 `compiled`

`compile+run+ingest` 串了六张 gen 收据（g6–g11，预留合计 **USD 0.9463**，其中 3 发主请求被截断/网络错误计费不重发）：

```
status: compiled | sides 5: flaky-timeout(1365字) wrong-model(1683字) eacces-config(1430字) perf-regression sse-truncated
ingest-gen: 策略 p-56e56fcd9c 已覆盖全部池题，下一次 plan 自动纳入
```

## 4 · v9 真机轮 2–6 全部跑通（本会话第一次）

| 轮 | 有效主答 | 留出 | dev | e（留出/全部） | 飞轮追加 | 预占 |
|---|---|---|---|---|---|---|
| r2 | 10/10 | — | — | 1.5 / 3.75 | **+3** | $0.7131 |
| r3 | 10/10 | 2胜0负2平 P=0.8125 | P=0.7734 | 2.333 / 2.857 | **+3** | $0.7131 |
| r4 | 9/10 | 2胜0负3平 P=0.791 | P=0.5 | 2.333 / 0.758 | **+2** | $0.7131 |
| r5 | 9/10 | 2胜1负4平 P=0.6367 | P=0.5 | 0.917 / 0.506 | +1 | $0.7131 |
| r6 | 10/10 | 2胜1负6平 P=0.623 | P=0.5 | 0.917 / 0.506 | +0 | $0.7131 |

`plan --round 2` 的离线裁决先亮了黄灯（`usable 5/5`、`meanΔ −0.0429`、`harm:[eacces-config]` ⇒ `offline-unsafe`），我用**文档内自带的 `--force`** 过轮（canned red 非独立泛化，且采纳仍由 L2/`confirm` 说了算，我没动任何阈值）。
第 6 轮后我**主动停 L1**：`cfb-cycle ruler` 自己的经济性判定是 `L1 角色：diagnostic — v9 L1 轮每 $0.126 只买到 ≈2 个非平局对且一个都不计入采纳；预算应给分叉轨迹（每 $1 ≈ 10.74 个采纳级对 + 80.5 个效度对）`，且信息量已崩（`已买到 0.0188 bit`）⇒ 第 7 轮只冻结未发请求（0 花费），预算转给轨迹单元波。

## 5 · 数据量现状与三波

- 飞轮 `pairs.jsonl 87 → 93 行`（本轮真 dev 对 +6，全部来自 v9 轮 `ingest`）；`dev-flywheel-pairs 72 对`；ranker `cvAcc 0.77 → 0.708/0.725`（新对子入池，符合预期）。
- **波 1（14 个 lite 模式 3 单元，实付 ≈$0.242）对数据量是死路**：`dataset unit 542 / simpo 57 / trainEligible 19 / hand 32 / devGold 4` **一字未动**，`harvest +0`，`weights-r6` 仍 **0.6437**。⇒ 已定性，不再重复。
- **波 2**：`gold-campaign` 战役正在跑（模式 1 hand 臂，渠道快了 10 倍）。两处已查明的机制：`plan-traj`（非 lite）报「同设计计划已存在 t126 未执行 ⇒ 不重复建」⇒ 必须 `--force`；**同格第二趟不能手拷 plan.json**（`traj-plan-mismatch:arms/maxRounds/fork/storeText/scenario 逐项必须一致`）⇒ 正解是 `plan-traj --force` 造同设计新计划再跑。
- **波 3（已排队，等波 2 收工自动开跑）**：10 个满档单元（后 5 个 `--samples 2 --max-rounds 6`）→ `ingest-traj` → harvest → promote → dataset → `weights-r9` → `gold-score` → `prescreen` → manifest，预算上限 $7。

## 6 · 「拉高到生产当年（1538 / 155 / 7）」的可达成性（按本轮实测外推）

| 目标 | 现在 | 每单位产出 | 还差 |
|---|---|---|---|
| `devUnitSamples` 1538 | 542（dataset `unitSamplesCount`） | 满档单元 ≈10 行 ⇒ ≈+100 unit samples | ≈10 个满档单元 ⇒ **波 3 正好在打这个** |
| `devPreferencePairs` 155 | 93 | 每个 v9 轮 +1~3、每个满档单元 +2~4 | ≈20 单元或混合波 |
| `devGoldCount` 7 | 4 | 新金标要靠 hand 臂修好 + 同格第二趟（R2≥2） | 波 2/波 3 的战役 |
| `trainEligible` | 19 | 规则 `!gate.ok && scoreMargin>0` ⇒ 只有「负样本真过不了生产闸」的对子才算 | 涨得慢是设计如此，我不会去动这条规则 |

本轮账本口径合计 **预留 ≈$4.51**（gen 0.9463 + v9 3.5655）+ 诊断 ≈$0.05 + 波 1 实付 $0.242；生产权重 `da949e637123` 全程未动。


---

# 追加五：沙箱重启后的结算 + **第一次扩池成功**（同日第六轮）

## 1 · 重启砍断了两个后台波，残局已结清

- `t126`（第一个**满档**模式 3 单元）其实跑完了：7 行 + `hand-samples.jsonl` + `receipt.json`，但没有 `review.md` ⇒ 未回灌。我补跑 `ingest-traj --plan 126`：**效度账本 +1 对、金标 +0、新 hand 样本 0**；单元内三臂全 `未修好`（hand 臂轮 5-6、压稿 0/4）。
- **v9 第 7 轮不可恢复**：收据 `-v9-r7` 在，但 `effect-ready report --v9 --round 7` 五格全 `samples: 0`，`ingest --round 7` 抛 `no-paired-results` ⇒ 那轮只发了探针就被切断，预留 ≤$0.7704 里没有配对产出。累计仍是 **5 轮回灌 / USD 3.5655**，`轮次: 7`（第 7 轮标记存在但无结果），champion 仍 `base`。
- `harvest` 第 4 次 **+0**（93/93）；`promote` 已把 93 对写进 `dev-flywheel-pairs.json`；`manifest` 收尾 **585 文件**。

## 2 · 数据量涨不动的真因（本轮实测定位，不是猜）

`t126` 的 7 行落地后 `dataset` 仍是 `unit 542 / simpo 57 / trainEligible 19`（`createdAt` 07:17）⇒ **多跑单元只是在重跑同格**：`build-micro-dataset` 按 (family/lineage/input/target) 连通分量去重，同格新行**顶掉**旧行而不是累加。
根子在池子：`.cfb-offline/tasks/` **是空目录**，`loadPool()` 只有 **5 道冻结题** ⇒ 单元、金标、v9 轮全都绕着同 5 格转。要"拉到生产当年（1538 / 155 / 7）"必须先**扩池**。

## 3 · 扩池门已被打开：新题 `env-pin-drift` 进池

正道 `cfb-cycle mint` 全链跑通（我写 u1+followup+next/avoid ⇒ `mint --step a` 拿真机 a1 ⇒ 我按 a1 写 u2 ⇒ `mint --step b` 拿 a2 ⇒ `compile --mint` 两步压 r1 / side ⇒ 落 `.task.json`）：

```
切分: {"eacces-config":"holdout","flaky-timeout":"dev","wrong-model":"holdout",
       "perf-regression":"dev","sse-truncated":"dev","env-pin-drift":"dev"}
池任务数 6: …, env-pin-drift(minted)     ← validateTaskFile 通过、source=minted
```

铸题期间踩到的三个真机坑（都已修，写进代码注释）：
1. `compile --mint` 走的是 `PRODUCTION_COMPRESSOR` 的 `max_tokens 1600 + thinking:disabled` ⇒ 本渠道思考关不掉，**必被 length 截断**（g15/g16 两张收据白烧）。正解：`CFB_GEN_COMPILE_MAX_TOKENS=8000`（我已把这个注入同时用于 `--policy` 与 `--mint` 两处 compile 作业）。
2. 探针 1024 在这条渠道仍会被偶发长思考烧穿（g13 第 1 发就 `response-incomplete`）⇒ **v9 探针 1024→2048**（gen 侧保持 1024，实测两发过）。
3. `plan --force` 打印崩溃（`r.plan.variants` undefined）⇒ 已加空值保护。

铸一道新题的真机账（含 3 张白烧收据）：**预留 USD 0.5924**；按上面 1、2 修正后应为 4 张 ≈ **USD 0.40/题**。第二道题 `tz-boundary-flaky` 的场景文件已备好（`.cfb-runtime/mint/tz-boundary-flaky.scenario.json`），照修正后的配方铸。

## 4 · 微模型现状（本轮训完）

`weights-r7.json`：`devUnitSamples 3805（+89）· devPreferencePairs 93（+6）· devPairwiseAccuracy 0.6344`
**比 r3–r6 的 0.6437 降 0.0093** —— 新增的 6 对来自 v9 轮 r4–r5，难分/近邻对占比高（`已买到 0.0188 bit` 那几轮），尺子侧仍 `overallMeanScore 0.6665 / closeCount 0/4`。不晋级：生产 `devPairwiseAccuracy` 口径与 155 对当年不可比，且我没动任何闸。

## 5 · 下一步（我按这个顺序自己走）

1. 用修正配方再铸 3-4 道题（≈$1.6）⇒ 池 9-10 题；
2. `compile --policy p-56e56fcd9c` 把新题的 side 补齐 ⇒ v9 轮在 6-10 题上轮换 ⇒ 每轮真对子不再被同格去重吃掉；
3. 满档单元 + `gold-campaign` 在新格上跑 ⇒ `devGold 4 → 7`、`unitSamples` 随新格累加；
4. 每步收尾 `build-micro-dataset → train-v5-micro → gold-score → npm run manifest`。
