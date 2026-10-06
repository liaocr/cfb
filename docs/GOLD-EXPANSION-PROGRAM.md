# 金标扩标方案（$0 起草，v14.20.1 立项）

> **现状更新（v14.25.1，2026-10-06）**：本文的判据、预算档与"不改判分公式"铁律照旧有效；**规模数以现场为准** —— `transfer/gold/` 现 **13 条 / 4 家族**（`dev 6 + holdout 7`），尺子判词 **4 `gold` / 9 `not-gold`**，`use` 分布 **7 `ruler` / 6 `train`**（后 6 条是 `goldCeiling` fail-closed 降级，不是人为放行），`pending-retest.json` 6 条待复测。逐条复算：`node tools/gold-ceiling-audit.mjs`（$0）与 `node tools/gold-score.mjs`。本文写于 7 条在册时期，文中"7 项/3 家族"一类数只作当时快照看。

> 这份文档定"什么叫金标够了"，以及怎么把它做够。它不改判分公式、不改固定句式模板（模板是接口协议，见 `TRAINING-AND-BENCHMARK.md` §3.1）。
> 现状：`transfer/gold/` 活跃 **7 项 / 3 家族**（`dev 3 + holdout 4`），全部 `[clean]` + 修好 + 自比 `dd=1.000`；隔离区 6 条（4 条是本通道测不出，不是稿子坏）。

---

## 0. 「够了」的判据（每条都可机检，不写感觉）

| # | 判据 | 现值 | 目标 | 谁来判 |
|---|---|---|---|---|
| K1 | active 金标条数 | 7 | **≥40**（其中标尺 ≤12，其余进训练料库，见 §1） | `gold status` |
| K2 | 家族覆盖 | 3 | **≥5 家族**（现池 `tools/traj-fixtures.mjs` 正好 5 条：`eacces-config` / `flaky-timeout` / `perf-regression` / `wrong-model` / `sse-truncated`），且新增 ≥2 条**新家族题**必须过仓里既有的盲测闸 | `eval-micro-js-pairs` 的 final-blind 闸 |
| K3 | 每家族条数 | 1–3 | **≥8**（其中 `vsRaw win` ≥4 才能出训练正例） | `gold status`（已按家族打印） |
| K4 | 双作者覆盖 | 0 | **每家族 ≥2 位作者写同一轮同一真值**，且给出作者间一致率 | `gold agreement`（待建，§2） |
| K5 | 轮位覆盖 | 集中在 r3–r5 | 早(≤2) / 中(3–5) / 晚(≥6) **每档 ≥5 项** | 计划器 `plan-traj --round-band`（待建，§3） |
| K6 | 原文长度覆盖 | 1.5k–5.2k | **<2k / 2–5k / >5k 三档各 ≥5 项**（压不出主要发生在短轮，必须单独量） | 同上 |
| K7 | 统计功效 | 3 对，e 最高 2.333 | 见 §5：**≥12 对非平手、≥2 家族、按 `winsNeeded` 至少要 5 胜 0 负** | `ceiling` / `bench-report` |
| K8 | 自洽 | 7/7 | 每条 active 金标自比 `dd=1.000`（已由 `A41` 钉） | `A41` |

**为什么是 40**：`tools/helpers/ruler.mjs::rulerValidity` 的自身闸写死了 `minPairs = 12`、`minPerClass = 5`；`eValueWins` 要 `e ≥ 10` 最少得 **5 胜 0 负**（`e=10.5`；3 胜 0 负只有 3.75）。要在 5 个家族上都拿得出手，按 K2/K3 展开就是 40 条量级——不是我拍脑袋定的数。

---

## 1. 先分家：标尺 ≠ 训练料（这条最要紧，不做后面全白干）

`transfer/gold/` 一个目录过去同时当两件事用：模式 2 用它选策略、训练拿它当标签。**同一批数据既当选择题的选项又当答案，就是泄漏**，之后任何「微模型追上金标」的读数都不作数。

**v14.21.0 已落地（$0，本节从「计划」改成「事实 + 记录」）**：不新建第二份目录，改为条目级用途字段 —— 避免两处真相漂移。

- `use: 'ruler' | 'train' | 'both'`（`tools/helpers/three-mode.mjs` 的 `goldUse` / `filterGoldByUse`）；**缺省 = `ruler`**：没登记的条目一律只当标尺，绝不因为漏登记就溜进训练侧。
- 改 `use` **不会作废既有基准计划**：`goldDigest` 只 hash `raw/ctx/draft`（`three-mode.mjs:50`），实测 7 条加字段后 digest 全部逐字不变。
- 五个读取口全部接线（逐个核实过行号，别再漏）：
  | 读取口 | 侧 | 过滤 |
  |---|---|---|
  | `tools/helpers/three-mode.mjs` `buildBenchPlan` | 标尺计划生成 | `goldUse(g) !== 'train'` |
  | `tools/bench-run.mjs` | 打分 | 命中 train 条目 ⇒ 抛 `gold-use-mismatch:<id>` |
  | `tools/cfb-judge.mjs` | 评审 | `goldUse(g) !== 'train'` |
  | `tools/build-micro-dataset.mjs` / `tools/train-v5-micro.mjs` | 拟合 | `goldUse(g) !== 'ruler'` |
  | `tools/build-change-dataset.mjs` / `tools/label-change-directions.mjs` | 判读头料 | 同上 |
- 训练料改由新通道供给：`tools/helpers/traj-corpus.mjs` 读 `.cfb-runtime/traj/*/hand-samples.jsonl`，只收 `trainingEligible === true` 且 `qualityAudit.status === 'clean'`；同 id 多版取最新当标签、旧版进 `pairs`（现成的 rejected/chosen）。命中标尺 id ⇒ **整条剔除并报出 id**（`onRulerId:'throw'` 可升级成硬失败）。剔除而非抛，是因为金标本来就是 `goldItemsFromTraj` 从这些轨迹里 add 进去的，两通道必然有 id 交集：抛 = 永远跑不动，静默丢 = 看不见漏了多少。兜底是 `train-v5-micro` 训练前的结果级断言 `ruler-leakage-into-train`。
- 验收：`test/gold-use-split.selftest.mjs`（PASS=39，含 b13 实测稿逐分逐位复算 9/9 一致 ⇒ 证明分家没动尺子）。

实测基线（`node tools/train-v5-micro.mjs`，$0）：分家前 `devGoldCount: 3 / devUnitSamples: 236 / devPairwiseAccuracy: 0.4`；分家后 `devGoldCount: 0（7 条全归标尺）+ traj:train 4 / devUnitSamples: 381 / devPairwiseAccuracy: 0.7`。**训练料不降反升**，且标尺侧 7 条读数的每一项、每一位都不变。

遗留一条（本轮只报不改，因为改它会移动训练结果）：`train-v5-micro.mjs:66` 读 `pack.pool?.tasks`，而 `.cfb-offline/gen-2.pack.json` 顶层是 `devTasks` / `trajEvidence` / `evidence`，**没有 `pool` 键** ⇒ `devPoolCount` 恒为 0，是结构错配被 `?.` 吞成空，不是数据为空。现已改成显式打印告警；要真正修得先决定 `devTasks`（无 split 字段）怎么并入拟合，属于重训范畴，留待批准后单独做。

## 2. 第二作者与一致率（没有它，dd 差值都是自欺）

同轮同真值让两个作者各写一稿 ⇒ 双向槽位召回取小值 = **作者间一致率**，它是标尺的噪声底：`dd` 差小于噪声底的策略差距，一律不得当结论。

- 作者 A：现流程（我，按当轮 `pending` 的 `raw + ctx` 写）。
- 作者 B，两条路一起用最省：
  - **B-离线（$0）**：作者 A 换一次盲写——不看旧稿、只用当轮 `raw + ctx` 重写一遍。它量的是**同一作者的自一致**，是噪声底的保守下界，必须标注 `sameAuthorResample: true`；
  - **B-异源（≈$0.002/稿）**：换另一个 model id 在同一 `pending` 上出稿，再由人核对是否可用。真作者间偏差只能这么量。
- 复用仓里**已有的独立性协议**，不另造概念：`tools/build-micro-dataset.mjs` 的标签审计已经区分 `blind-unit-label-v3`（`independence: blind-independent`）与 `rule-hints-visible-v1`（`…not-independent`）。金标侧照同一语义打标即可：`qualityAudit.reviewProtocol: 'blind-unit-label-v3'` + `reviewer` + `reviewedAt`，B-离线那一遍必须声明 `blindTo: <A 稿的 digest>`。
- 待建（$0，一个子命令 + 一处打标）：
  - `gold stage --reviewer <id> [--blind-to <digest>]`：登记作者与盲写依据，落 `author`/`reviewProtocol` 到条目；
  - `gold agreement --family X`：打印同轮两稿的逐槽一致率 + 差异句（复用 `draftDistance`，不做新公式）；
  - `pending-retest.json` 增加 `author` 字段，避免把 A 的复测算到 B 头上。
- **新家族题的验收照旧走盲测闸**（`tools/eval-micro-js-pairs.mjs`）：`mustBeNewFamily` + `dataset.finalBlind:true` + `semanticReview{completed, reviewer, reviewedAt}` + `lineageReview{completed, newFamilyRationale, knownFamiliesReviewed/knownSourceIdsReviewed 必须精确覆盖全部训练家族与来源}`，任缺一条即 `final-test-requires-completed-family-lineage-audit`。注意：`test/evidence-program.selftest.mjs` 里那批 **R3 宿主协议合成夹具**（`docs/EVIDENCE-PROGRAM.md` 自己写明"不是未来 S0 的主模型任务集"），**不能**拿来当新家族。（旧版本此处写的 `test/helpers/evidence-fixtures.mjs` 从未入库。）

## 3. 覆盖矩阵（先把格子排出来，再往里灌真机单元）

| 家族 | 早(≤r2) | 中(r3–5) | 晚(≥r6) | <2k | 2–5k | >5k | 目标条数 |
|---|---|---|---|---|---|---|---|
| `sse-truncated`（已有 3） | 1 | 2 | 1 | 1 | 2 | 1 | 8 |
| `eacces-config`（已有 2） | 1 | 2 | 1 | 1 | 2 | 1 | 8 |
| `wrong-model`（已有 2） | 1 | 2 | 1 | 1 | 2 | 1 | 8 |
| `flaky-timeout`（已有 0，本通道常压不出） | 1 | 2 | 2 | 1 | 2 | 2 | 8 |
| `perf-regression`（已有 0） | 1 | 2 | 2 | 1 | 2 | 2 | 8 |
| **合计** | | | | | | | **40** |

- 落法：每家族一个预注册单元（`plan-traj --arms raw,hand --scenarios <fam> --samples 1 --max-rounds 9 --stop --cap-usd`），跑完 `ceiling --plan N` → `gold add --plan N`。轮次不由人选，由 fork 的 `pick` 决定 ⇒ 需要**小改一处**才能填满轮位/长度格子：`plan-traj` 加 `--round-band early|mid|late` 与 `--min-raw-chars N`（只影响挑哪一轮要稿，不改闸的判据）。这条也 $0。
- 新家族先补 2 个（K2）：在 `tools/traj-fixtures.mjs` 里加题（仓库自带 `materialize` + `--dry` 预算），$0 造题与预检，真机只跑过闸的稿；出稿后要过上面那道 lineage 盲测闸才算独立。

## 4. 每批的固定流程（写死，免得上次那种乱来重演）

```
1  node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios <fam> --samples 1 --max-rounds 9 --stop --cap-usd 0.22 [--round-band mid]
2  （pass 1：raw 臂跑完，hand 臂在要压的那轮暂停，落 pending/<id>.json）
3  作者 A 照当轮 raw+ctx 写 drafts/<id>.md      ← 禁止搬旧轨迹结论（G2 判 invented-decision）
4  node tools/hand-preflight.mjs <plan>           ← $0：G2 ∧ lint ∧ compile ∧ birthAccept ∧ stored-lint ∧ 自比 dd
5  重跑第 1 步那条命令（自动续跑，接受稿子）
6  作者 B：B-离线重写一遍 / B-异源出稿 → gold agreement（先算噪声底）  ← ⏸ T0.2 按裁决未开工，此步暂无工具，跳过
7  node tools/cfb-cycle.mjs ceiling --plan N
8  node tools/cfb-cycle.mjs gold add --plan N [--replace]     ← 自动挡 vsRaw loss；入册条目默认 use=ruler（只当标尺）
   8b node tools/cfb-cycle.mjs gold use --id A,B --set train [--dry-run]  ← 显式放行成训练料才进拟合；v14.21.0
9  node tools/cfb-cycle.mjs plan-bench && node tools/bench-run.mjs --plan ... --timeout-ms 150000   ← 见 §6
```

**不许跳的三条**：第 4 步没全绿不许花钱；第 6 步没算噪声底不许宣称某策略"更好"；第 8 步被 `vsRaw loss` 挡下的稿**不删**（进训练料，它是"这样写会慢一轮"的负样本）。

## 5. 统计口径（扩标期间也照这个读）

- 判定阈值不动：`e ≥ 10` 且 `families ≥ 2`（`decideV4`）。要拿到 5 胜 0 负，`tie` 不加分 ⇒ 每格要真赢。
- `ceiling`/`bench-report` 里 `undetermined` 只有一个含义：**配对不够**，不是"手稿没用"。当前 dev 3 项最多 e=2.333，本来就量不到 10——别再把它读成失败。
- 因为通道在 `temperature 0` 下已不再逐字可复现（§6），所有"分数变化"必须按**同格重复 2 次取保守值**来读：优先复用 `results.jsonl` 缓存（同一文本 ⇒ 同分，免付也稳定）；要重跑就 2 次取均值并给极差，极差 > 0.05 的格子不进结论。

## 6. 本通道今天实测到的变化（2026-10-05，换上游后）

| 现象 | 数字 | 对策 |
|---|---|---|
| 单调用快了一个量级 | 400 tok 出稿 **2.0–2.2 s**（此前压缩调用常在 22 s 上超时） | 保留 `--timeout-ms 150000`；b10/b11 的"8 行超时"作废，别再当模型能力读 |
| `temperature: 0` **不再逐字确定** | 同 prompt 同参数两次：127 字 / 133 字，指纹不同 | 见 §5：重复 2 次或走缓存；`pass^2` 语义照旧可用 |
| 小 `max_tokens` 会被思考吃满 | 64 tok 预算 ⇒ `content:""`、`reasoning_tokens:64`、`finish:length` | 压缩调用 `max_tokens` 下限设 **600**，并在回执里显式记 |
| `thinking:{type:'disabled'}` 仍被遵守 | 生产同构调用思考 0 字、正文正常 | 生产路径没坏，不用改 |
| 网关开始自带计费/缓存字段 | `cost:0.00001`、`credit:0`、`prompt_cache_miss_tokens:101` 与 `prompt_tokens:42` 不一致 | 预算闸的单价（$0.0075/压缩调用）改为**读网关 `cost` 复核**；无 `system_fingerprint` ⇒ `--require-fp` 仍不可用 |

## 7. 预算（按仓库自己的单价估）

| 档 | 做什么 | 花费 | 产出 |
|---|---|---|---|
| **T0** | §1/§2/§3 的四处代码与闸（`inRuler` 隔离、`gold agreement`、`--round-band/--min-raw-chars`、preflight 已含自比）+ B-离线重写 + 全部离线复算 | **$0** | 格子排好、噪声底有定义、训练与标尺分家 |
| **T1** | 5 个家族 × 各 1 个真机单元（每单元 ≤9 轮，影子分叉） | ≈$0.55（≈$0.11/单元） | +20～30 条真机稿；`flaky-timeout`/`perf-regression` 若本通道两臂同败 ⇒ 如实记 `blocked-on-this-channel`，不硬凑 |
| **T2** | T1 + 作者 B-异源（每家族 4 稿）+ 每格重复 2 次 | ≈$0.9 | K4 满足；dd 有噪声底可比 |
| **T3** | T2 + 标尺重建（`plan-bench` 5 策略 × 12 项）+ 模式 2 配对到 e 可判 | ≈$1.6 | 才第一次有资格谈"侧模型追上金标没有" |

不含微模型正式训练本身（那是 `train-v5-micro` 的 Kaggle 侧，另算）。

## 8. T0 的收支（v14.21.0 已执行，按用户裁决收口）

| 步骤 | 内容 | 状态 |
|---|---|---|
| T0.1 | §1 用途隔离 + 读料断言 + 训练料换通道 | ✅ 已落地（`use` 字段 / 5 个读取口 / `traj-corpus` / 自测 39 断言 / `gold use` 子命令） |
| T0.3 | §3 `--round-band` / `--min-raw-chars` + 覆盖矩阵对账 | ✅ 已落地（`tools/coverage-plan.mjs` → `transfer/gold-repair/gold-coverage/matrix.{md,json}`，30 格 / 目标 40 / 当前缺口 33，并直接输出每家族的下一批预注册命令） |
| T0.2 | §2 第二作者与一致率 | ⏸ **按用户裁决不做**：「t0.2 我上哪给你找双作者，先不要」。一致率仍是 K4 硬判据，缺它则 dd 差值只能当方向性参考，不得对外称噪声可控。恢复条件：真出现第二位起草者。 |
| T0.4 | §6 通道适配（`max_tokens` 地板、回执记网关 `cost`、探针转正） | ⏸ **按用户裁决不做**：「没必要，没啥用，能训练就行」。已知风险照此承担：`max_tokens` 过小会被 thinking 吃空 ⇒ 空 body 记成可重试 `error`；预算对账只能继续用 `estimatedUsd`，不采信网关 `cost`。 |

T0.2 不做带来的直接后果要记在账上：**噪声底没有实测值**，所以 §5 的「配对差 > 一致率噪声」这条判据暂时只能用 A41c 的 ≥0.95 措辞相似度兜着。这不影响 T1 起草（仍是 $0），但影响 T3 敢不敢用 dd 差值下结论。

这两项做完，T1 才值得花钱——否则补回来的金标还是同一把没分家的尺子。（分家已完成，所以 T1 的前置已满足。）
