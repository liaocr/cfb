# 微模型训练失效：根因专项复核（2026-10-07）

> **范围**：只检查微模型训练目标、数据标签、生产推理路径、评测与血缘。此前文档/回执卫生事项不作为本报告结论。  
> **状态**：用户已选择生成式路线作为修复方向。已对一个确认的数据标签缺陷实施 fail-closed 保护并通过回归测试；未改训练目标或生产推理、未重新训练、未覆盖任何权重。

## 结论先行

目前的问题不是单纯“训练轮数不够”或“超参数没调好”。仓库称为 micro model 的生产系统，实际更接近**小型特征排序器 + 规则选句器 + 五种已知任务模板/通用模板渲染器**，并没有在生产 JS 路径中运行一个能开放域生成、压缩和改写语义的微型语言模型。

训练目标主要教模型预测规则/审核得到的槽位与价值、排序已构造的偏好对，以及模仿结构化草稿评分；它没有以源文档的事实保留率、关键条件/否定/数值保留或无依据断言为主损失。并且当前标签器会将“没有发现 cue 或 gold anchor”默认为低价值 `NOISE`，其中有未经人工复核的句子被直接用作负例。于是“看起来像已见任务的排序拟合”及“漏掉没与金标字面锚点对齐的信息”是当前设计能预期产生的失败，不是只靠继续调权重就能消掉的现象。

## 1. 生产架构与目标错位（根因级）

- `src/compile-v5-local.js:907-943` 对原文拆分单元、计算特征与分数，再按五种 archetype 进入硬编码编译器；其他输入走 `compileGeneralDiscourseGraph`。模板分支不是由训练模型生成的。
- 主入口对观察用的 `selectedOps` 最多选择 10 个单元；通用分支另按规则选材（上限 24、预算与槽位限制，见 `src/compile-v5-local.js:800-852`）。选取器先过滤 `slot === NOISE` 的单元（`src/compile-v5-local.js:385-404`）。一旦重要内容被误标为 NOISE，后续生成器没有办法把该单元选回来。
- 当前生产权重 `transfer/models/v5-micro-weights.json` 是 `cfb.v5-micro-weights/2-neural-65m`，只有 **19 维手工特征**，没有 `textHashBuckets`；生产 JS 因而不消费完整 97M 编码器表示。它记录的旧训练集是 1,538 units、2,452 unit pairs。`v5-micro-weights.judge-4764fd2.json` 虽由 Granite 97M 教师蒸馏而来，自己的 `runtimePath` 仍注明是 19 维 symbolic student，完整 encoder ONNX 是另一个资产。另一个 `v5-micro-weights.candidate.json` 也是 65M/19 维，但记录的是 4 gold + 27 trajectories + 93 flywheel pairs、3,805 units，pair accuracy 0.6344；它同样不是 10-06 的 97M 三折候选。不同训练代际的权重/报告不能拼成同一个结果。
- `extractDraftPrefFeatures` 的 12 个整稿特征包括槽位话术、锚点是否全对齐、甜点字数区间、超长惩罚、列表/散文结构等（`src/compile-v5-local.js:350-384` 附近）。它们可以奖励已知草稿形状，却不是“源文档事实是否完整”的测量。

**含义**：如果目标是开放域的抽象式通用压缩，当前部署架构本身表达能力不足；改变训练损失不能让 19 维 JS ranker 变成通用生成器。若必须维持极小、同步、纯 JS 的运行限制，就应把产品定义为高召回的抽取/选择式压缩，而不是让模板排序器承担通用语义生成。

## 2. 可复现的标签缺陷：无证据被当作负标签

`tools/build-micro-dataset.mjs:173-247` 的规则先以槽位 cue 与和 hand gold 的锚点重叠赋标签。没有命中时，默认值为 `slot=NOISE, yVal=0.05`；但“没有 cue/anchor”本身不会添加 review flag，因此会以 `trainingEligible=true` 进入 SFT。`buildDocUnitPairs` 随后把 `NOISE && yVal <= 0.10` 的单元当负例，和正单元构造偏好对（同文件约 443-520 行）。

当前 2026-10-06 数据集有 542 个 unit 样本。要精确区分原始规则和最终标签：152 条的 `labelRule` 是 `no-slot-cue-or-gold-anchor`；其中 130 条后来经过盲审改标/确认，**不能**说 152 条全部是未审伪标签。真正仍无复核、但继续以 `NOISE` 进入训练的有 **22 条**；它们在 unit-pair 中共充当 **87 次负端点**（大多达到 4 次 endpoint cap）。例如：

- `pool:flaky-timeout`：`测试的目的是：主请求 200 之后不得再发对冲。` 被标为 `NOISE / 0.05`，并在 4 对中输给调整 hedge 参数等单元。
- `pool:sse-truncated`：`确保对象闭合后停止。` 被标为 `NOISE / 0.05`，也进入 4 个负例对。
- 同一批中也有真正的碎片/噪声（如 `but no.`、`= null.`）。问题不是每个无 cue 句子都重要，而是数据管线把**未知/未判定**和**确认无信息**折叠成同一个负标签。

这些 22 条既参与 SFT 的 NOISE 分类，也进入 pairwise 负例池。单元选取器排除 NOISE，因此这是直接可能造成信息遗漏的监督路径。安全的短期数据修正是：**无 cue、无 gold overlap 的单元默认标为 unknown / 不可训练；只有明确的盲审标签可以晋升**。

该 fail-closed 修正现已落入 `tools/build-micro-dataset.mjs`，并在 `test/micro-ruler.selftest.mjs` 增加回归断言。回归测试 `node --test test/micro-ruler.selftest.mjs` 通过（7 项内部断言，0 fail）。另用修复后的 builder 在仓库外生成并随后删除了一份临时快照：542 个 unit 中 516 个可训练，22 个无直接监督且未审核的 unit 全部不可训练、0 个出现在 unit pair 端点；生成 452 个 unit pair，全部端点有效。Draft pair 仍为 303 个（其中 200 个可训练），此修正没有增加语义金标。该快照没有覆盖检入的数据集或权重。本轮最终的 `npm run watermark:record` 重跑完整 online 与 isolated 自测，两条 lane 均 42/42 套件通过、0 fail（online 1241 passed / 2 skips；isolated 1242 passed / 1 skip；设计性跳过均保留）；manifest 在本轮收尾时重新校验。此修正只封住一个已证实的数据缺陷，并不会把现有模型变成通用压缩器。

## 3. 损失与 checkpoint 在优化什么

`tools/kaggle-train-micro.py` 的训练目标包括：

- SFT：槽位交叉熵、value/temptation 回归、negative-priming、少量 target-file / old-new-text / verify-command span loss（约 638-657 行）。没有面向整篇文档的事实覆盖或蕴含损失。
- Unit student：分类/蒸馏 + unit preference 的 listwise/ranking loss（约 912-974、1001-1029 行）；compact checkpoint 主要按验证集 unit pair accuracy 选择（约 1043-1056 行）。
- Draft preference head：蒸馏整稿分数并排序 chosen/rejected；保存目标仍是偏好对 accuracy，而非摘要对输入事实的覆盖（约 1060-1138 行）。

现有 preference pairs 中有规则构造的反事实稿、hand-gold 与反事实稿、少量飞轮稿对比。它们可以教会模型偏好某类输出结构/规则，但不能替代对“这份压缩稿是否保住源文所有关键事实”的监督。长度匹配 pair accuracy 也仍是排序准确率，不是语义完整性。

## 4. 评测显示弱泛化，且当前血缘不能直接复现

### 2026-10-06 三折文件（历史、探索性）

`python3 tools/collect-micro-folds.py --lineage-from-first-report` 将三份同批 fold 报告按其自身血缘并读，得到：

| 留出家族 | matched unit pair 候选 | matched production | 草稿 pair 候选 |
|---|---:|---:|---:|
| flaky-timeout | 0.7576 | 0.7273 | 0.5000 |
| perf-regression | 0.8462 | 0.5128 | 0.6875 |
| sse-truncated | 0.6907 | 0.2784 | 0.6364 |
| 均值 / 最差 | **0.7648 / 0.6907** | — | **0.6027（132/219）** |

matched unit 指标的均值虽过当时的 0.75 描述性门槛，但最差折 0.6907 未过 0.70；flaky-timeout 相比 production 只高 0.0303；draft pair 只有 132/219 正确。fold 报告的 `freshIndependentNewFamilyTestPassed=false`。而且 `tools/micro_cv.py:3-5` 明确说明 v2 阈值是在 2026-10-04 结果之后选出的，不能当确认性结论。

更重要的是，按当前检出运行默认的只读收集器 `python3 tools/collect-micro-folds.py` 会排除 **3/3** folds：锁定/报告的数据指纹为 `56a211c27cec…`，当前数据指纹为 `cf380bbb6b82…`（fingerprint 忽略 `createdAt`，差异不是单纯时间戳）；报告训练时有 219 个 trainable draft pair，当前数据集只有 200 个（其中 19 个退化特征对已被排除）；当前训练脚本 SHA 前缀 `60f5e456ee0f…` 与报告冻结的 `34bf49793203…` 不同。因而三折数字只能描述当时那次训练，不能冒充当前数据/源码下的结果。

### 不能混用的旧读数

- `transfer/models/cfb-micro-97m-report.json` 是 2026-10-04、1,538 units 的报告，不是 2026-10-06 的 542-unit 数据集训练结果。
- 该旧报告的候选 unit pair 总准确率 91.55% 看起来很高，但长度差明显的 far 桶是 137/147=93.2%；长度匹配桶只有 83/98=84.69%（Wilson 95% 下界 0.7627）。这既是“可学到长度/结构代理”的迹象，也不是内容保留测验。
- `transfer/models/micro-gap-map.json` 标记 `measuredAt=2026-10-04`，仅 7 例。在 W1 对照里 general candidate `keepCoverage=0.2276 / distanceScore=0.3619`，production 为 `0.1248 / 0.1631`；known-archetype candidate 与 production 完全相同。它证明通用 fallback 有改进空间，不能证明一般语义完整性或新任务泛化。

## 5. 应按以下顺序修，不要先重调超参

1. **路线已定为生成式**：按你的选择，不再把纯 JS scorer/template runtime 当最终方案；生成模型负责理解与压缩，旧 JS 路径最多保留为安全回退/对照基线。
2. **修标签语义**：`unknown` 独立于 `NOISE`；无字面锚点不是负证据。用盲审/人工标注事实重要性，未经审的单元不进入负例池；对关系、否定、条件、数值、时间、责任主体做独立核对。
3. **先做事实保留数据集**：每篇原文标出原子事实及其来源跨度、重要性、极性/条件；允许语义等价改写，不要求复刻 gold 的固定模板。构造“删除一个关键事实、翻转否定、丢掉条件/阈值、把排除项复活”等难负例。
4. **把文档级保真设为主目标**：例如按重要性加权的事实召回、无依据事实/矛盾惩罚、冗余惩罚与压缩长度的 rate-distortion 目标；偏好排序作为辅目标。对关键事实可设置必须保留/不满足就 abstain 或放宽压缩率的硬约束。
5. **建立新任务评测后再训练**：按独立文档/项目/家族切分；保留真正未见过的新家族盲测；报告按家族聚合的事实召回、关键事实漏失、unsupported/contradictory claims、同预算压缩率及最差家族，而非把相关 pair 当作独立样本。所有阈值在解盲前冻结。
6. **重建完整血缘**：新标签、新目标或架构确定后，重新生成数据 fingerprint 和 preregistration，再跑训练与盲测；候选与生产权重、报告和推理代码必须属于同一冻结版本。当前报告和当前数据不能拼成一个“通过”的训练结果。

## 6. 按已选生成式路线的第一步

- 先以真正的 decoder language model 做零样本/提示式压缩基线，再决定是否微调；候选 smoke-test 可从 `Qwen/Qwen3-0.6B` 开始。其模型卡说明它是 0.6B causal language model、32,768-token context，支持 100+ languages，并支持关闭 thinking mode；这只是候选，不是质量结论或已锁定权重。[1](https://huggingface.co/Qwen/Qwen3-0.6B)
- **不要直接在当前数据上微调**：严格筛选 `split=dev && use=train`、排除 `_decoy`/`_long-horizon` 后，只有 **2 条** canonical 序列级 hand-reference，来自 2 个家族。当前 18 条 accepted capture 只来自 3 个 dev 家族；按输入/目标去重后为 15 个三元组、14 个不同输入，其中 1 个输入有多个目标，且这些 capture 均没有独立事实完整性复核。拿这点数据做 SFT/DPO 很容易记住已见任务格式，无法证明新任务泛化。两个现有 holdout 家族可以用于开发期检错，但不能替代新的盲测家族。
- 已生成准备清单 `transfer/models/micro-generator-preparation.json`，由 `node tools/prepare-micro-generator-data.mjs --write` 重建。它只保存来源与内容哈希，不复制原文；将 capture 放入语义复核队列、排除 holdout，并明确 `fineTuneNow=false`。生成式训练数据采用 `raw + ctx -> draft`，还需附独立原子事实清单/源跨度；同家族整体切分。当前 hand draft 只作参考答案，不应是唯一效用信号。
- 当前执行沙箱没有 `torch`、`transformers`、`peft`、`trl`、`onnxruntime`，也没有生成模型权重或 `llama.cpp`/`ollama`；因此本轮不能诚实地训练或做生成模型实测。环境就绪后先跑 zero-shot 基线，再比较微调前后事实召回/遗漏，而不是先导入旧的 pair-accuracy gate。

### 本次未做

- 没有人工事实/参考答案裁定、真实 GGUF/HF 推理、模型训练、Kaggle 运行或盲测；因此没有可报告的模型质量通过结论。

### 本轮工程准备与边界

- 在 `tools/micro-generator/` 新建了事实标注/预测/训练样本 schema、事实复核指南、family split 与质量门槛模板、冻结门槛工具、review-queue 构建器、context-only fact-review starter 生成器、人工 review workbook 构建器、fail-closed 训练集导出器、人工裁定评测器、最小通过模型选择器、GGUF/HF 推理 runner、盲测 gate 授权器，以及 Qwen3-0.6B QLoRA 训练脚本和 Kaggle notebook。
- 已生成 `transfer/models/micro-generator-review-queue.jsonl`：17 个去重后的 input-target 条目、3 个已知 dev 家族；每条原始队列记录均未审核、无最终 family split、不可训练。另生成 `transfer/models/micro-generator-fact-draft-suggestions.jsonl`：70 条只摘自明确 task/context 前言的候选事实，全部为 `partial/draft`、0 位 reviewer、`trainingEligible=false`；它们只是人工复核起点，不是金标或完整覆盖。另生成 Excel 人工复核工作簿 `transfer/models/micro-generator-human-review-workbook.xlsx`，含 Cases、Fact Proposals、Target Conflicts、Family Split 表；所有人工决策格保持空白。另发现一组完全相同的 raw+ctx 对应两个不同 reference draft；导出与 QLoRA 双重预检现在会 fail-closed，要求先人工选定/归并一个 canonical target。导出预检拒绝生成 train/dev 文件，这是预期结果。门槛仍为空且未冻结，没有虚构盲测家族。
- `node --test test/micro-generator.selftest.mjs` 通过（16 项内部断言）；Draft 2020-12 Schema 将强制 raw/context/reference 哈希、训练样本审核字段，以及 blind prediction 的冻结 gate 血缘。17 条 review queue 与 17 条 context-only 建议均通过 annotation Schema；合成 train/dev/prediction 样本通过 schema/preflight 验证。QLoRA preflight 接受 family-disjoint 已审核样本，并拒绝未审核/冲突目标样本。GGUF runner 仅用 mock backend 验证普通与带冻结 gate 的盲测流程，**没有加载真实模型或得到生成质量结果**。
- 当前沙箱检测为 2 CPU 核、约 1.9 GiB RAM，未发现 GPU/训练依赖。公开 Qwen3-0.6B GGUF 候选的仓库 API 列出 Q8_0、639,446,688 字节；同一文件的扫描元数据带 `PAIT-GGUF-100` 警告，因此本轮没有下载或加载它。若要做本地 CPU smoke test，需先检查实际 GGUF 内嵌 chat template 的安全性；Kaggle notebook 也尚未在 Kaggle 上运行。
- 没有覆盖检入的旧数据集/权重，没有改生产推理路径，没有重新训练。当前仍是工程与人工复核准备阶段，不是生成模型质量通过；下一阶段应先完成原子事实和 reference 的独立审核、家族 split 与盲测注册，再使用 Kaggle/GPU 训练与确认性评估。