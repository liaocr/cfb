# CFB-Micro 闭环就绪与本地基线报告（2026-10-04）

## 结论

本轮已完成 JS 权重加载/版本指纹、Unit/Draft 实际运行时 pair evaluator、数据审核筛选、compact student Python→JSON→JS 数值 parity 流程和新 family 最终盲测门禁的代码实现；**没有在本地训练，也没有运行 Kaggle 训练或新 family 最终盲测**。因此本报告里的当前 pair 分数是生产 JS 权重的开发集基线，不是新 checkpoint 的成绩，也不能用于晋级。

保留严格标准：总参数 `<100,000,000`；Teacher Unit/Draft 与 Compact Student JS Unit/Draft 验证各 `>=90%`；Mode 2 G1/G2 全通过；完整 INT8 ONNX 导出/ORT smoke 成功；PyTorch→序列化 JSON→JS 数值 parity 通过；冻结后一个此前未见、逐条语义审核的新 family 最终评估通过。缺少任一门槛都不晋级、不替换生产权重。

## 本轮实现

- `src/compile-v5-local.js` 唯一从 `transfer/models/v5-micro-weights.json` 加载生产权重，校验 schema、19 维 Unit 特征顺序及权重形状；运行 trace 中 `promptVersion` / `weightsDigest` 指向实际 scoring 权重。指纹只覆盖评分参数，不会因 `trainingStats` 等报告元数据变化。
- 新增 `test/micro-runtime.selftest.mjs`，检查真实默认加载路径、schema 校验、生产 JS Unit/Draft scorer、token 长度惩罚、EXCLUDED 门控与 `compileV5Local` 默认权重一致性。
- 新增 `tools/eval-micro-js-pairs.mjs`：通过 `scoreUnitWithWeights` 和 `scoreDraftPreferenceFeatures` 评估 train/validation，可按 family 报告分母、平局、端点复用、token 惩罚与 EXCLUDED 门控；可验证 PyTorch parity fixtures；最终盲测模式会拒绝旧 family、未审核标签或已消费 family。
- `tools/kaggle-train-micro.py` 将 compact student Unit-pair train/validation 指标改为**候选权重序列化后经实际 JS scorer**计算，和 Teacher 指标分列；增加基于真实可训练 feature rows 的 PyTorch→JSON→JS 数值 parity 检查（容差 `0.001`，并校验 slot 与 EXCLUDED 门控）。ONNX 随机/合成输入 smoke 与数值 parity 分开报告。
- 新增 `--final-test-dataset`：只在 checkpoint、训练数据/split、评分权重字段和训练目标冻结后调用。要求单一新 family、完整逐条语义审核、端点上限 `<=2`；`lineageReview` 必须覆盖训练 family/sourceId，且新 sourceId 不与训练集重叠、Unit pair 不跨 source。新 family Unit/Draft pair 都须达到 `>=90%`。`transfer/models/cfb-micro-final-test-ledger.json` 记录已消费 family/hash，防止重复盲测。

## 数据与审核审计（本次生成器输出）

| 项目 | 数量 | 说明 |
|---|---:|---|
| dev Gold / dev Pool | 7 / 3 | 不含原有 Gold holdout |
| Unit 全量 / 可训练 / 待审 | 1,538 / 569 / 969 | 可训练 36.996%；待审标签全部排除 |
| Unit pair | 406 | 仅由合格端点生成；相对旧构造 2,452 对减少 `83.44%` |
| 唯一 Unit pair 端点 / 引用数 | 529 / 812 | 度数最多 2；283 个端点出现 2 次，复用端点占 53.497% |
| Draft pair 全量 / 可训练 / 待审 | 155 / 118 / 37 | 可训练飞轮偏好要求真实成对分数、margin `>=0.05` |
| 跨度指针 | 57 | 文件、代码片段及验收命令 |
| 原有 holdout Gold | 4 项 / 2 families | `eacces-config`、`wrong-model`，不参与训练；此前已用于评测，不是盲测 |

待审 Unit 标签旗标计数（可重叠）：`mechanism-heuristic-no-direct-gold-slot=817`、`competing-slot-overlap=411`、`noise-label-has-gold-overlap=33`、`noise-label-has-actionable-cue=22`。逐类 `labelRule` 的全量/可训练数为：`gold-overlap-decided 150/91`、`gold-overlap-excluded 89/75`、`gold-overlap-acceptance 50/35`、`gold-overlap-open 30/29`、`decision-cue-plus-gold-overlap 14/12`、`excluded-cue-plus-gold-overlap 14/7`、`no-slot-cue-or-gold-anchor 374/320`、`mechanism-heuristic-only 817/0`。Draft 可训练 pair 为 112 条已存真实飞轮评分 + 6 条 Gold 对确定性反事实；待审 37 条的依据分别是 margin `<0.05`（10）、被拒稿仍通过硬门（26）、无正向距离 margin（1）。筛选器只做确定性规则审核；**本轮未执行 LLM 或人工语义仲裁**。这不是把 1,538 行都宣称为人工核验标签。

当前三个、且仅三个可用 dev families：

| family | 全量 Unit | 可训练 Unit |
|---|---:|---:|
| `flaky-timeout` | 1,073 | 367 |
| `perf-regression` | 104 | 39 |
| `sse-truncated` | 361 | 163 |

split 仅按可训练 Unit family 数量接近 20% 选择，SHA-256 作平局决胜，不按标签或分数选组。当前 validation 为 `sse-truncated`，占可训练 Unit `163/569=28.647%`，占全量 `163/1538=10.598%`；train 为其余两个 family。`_decoy` / `_long-horizon` 会归并到源 family，不计作新 family。`sse-truncated` 曾参与旧 checkpoint 选择，所以本次和以后任何复用它的结果都不是最终盲测。

## 实际 JS 运行时开发集基线

本次通过 `tools/eval-micro-js-pairs.mjs`，在同一 `sse-truncated` 已使用 validation family 上评估当前生产权重。生产与 candidate 指向同一权重文件，所以两列完全相同；这不是候选训练对比。

| 运行时指标 | 结果 | 分母 | 距理论上限 100% |
|---|---:|---:|---:|
| JS Unit pair（production） | `78/138 = 56.52%` | 138 对，0 平局 | **43.48 pp** |
| JS Draft pair（production） | `35/40 = 87.50%` | 40 对，1 平局 | **12.50 pp** |

权重 schema 为 `cfb.v5-micro-weights/2-neural-65m`，评分指纹 `a3ddacc67139db0508e40eac59888c9acebbef04d8c8d1ee833a2fdf27f05bd7`。Unit rank 比较 `.v`，包含 `lambda × tokenCount` 惩罚；validation 的 163 个端点中 39 个触发 EXCLUDED 门控计算，token 惩罚均值 `0.0456`、范围 `0.0076–0.1444`。门控对 slot 概率/选择生效；pair accuracy 仍按运行时 `.v` 定义，报告不把门控误称为另一个独立胜率指标。

当前 JS 基线到 Unit `>=90%` 门槛差 `33.48 pp`，到 Draft `>=90%` 差 `2.50 pp`。在单一已有 validation family 上测得的 87.5% Draft 结果仍不足以证明泛化。

## 既有训练结果（仅作历史对照，不是本轮新训练）

仓库旧 `cfb-micro-97m-report.json`（schema `/2`）记录：总参数 `97,899,414`，距 100M 余量 `2,100,586`；Teacher Unit validation `0.5185`（812 对，距上限 `48.15 pp`）；compact student PyTorch Draft validation `0.8461539`（52 对，距上限 `15.38 pp`）；compact student Unit **slot 分类** validation `0.4654`（361 行，距 `100%` 为 `53.46 pp`，它不是 Unit pair accuracy）。Mode 2 G1/G2 为 `11/11`，但 Unit/Draft 门槛未过、`accepted=false`。旧报告没有 compact student 的实际 JS Unit pair 指标，也没有本轮新增的 Python→JSON→JS parity。旧报告的 ONNX smoke 只证明导出/运行，不等价于上述 parity。

## 尚未完成 / 需要用户操作

1. **训练未执行。** 本地没有 PyTorch（`ModuleNotFoundError: torch`）；按约定使用免费的 Kaggle Notebook T4/P100，不在本机或付费云上替代训练。
2. **没有新独立 family。** 当前只有三个 dev family；最终评估门禁保持 blocked。需要新增真实任务家族、完成逐条来源/依据/质量语义审核后，制作独立 `cfb.micro-dev-dataset/3` 文件，并作为 Kaggle Dataset 输入挂载。禁止将旧 holdout 或 `_decoy` / `_long-horizon` 变体改名顶替。
3. **parity 新流程未实跑。** 本地只运行了 JS loader/scorer selftest；PyTorch→JSON→JS 的真实训练态 parity 必须由 Kaggle 训练脚本执行，没跑前不得报告 passed。
4. **Mode 2、完整 INT8 ONNX export/ORT smoke、最终 blind family 尚未完成。** 最终评估只能在候选权重和代码冻结后跑一次；其 family/hash 会写入一次性 ledger。
5. 本地 `npm run verify:offline` 在 Linux user network namespace 中执行通过：`30/30` 套件、`909 pass / 0 fail / 1 skip`；后续 non-inferiority audit 的 N1–N7 违反数均为 0。由于有 1 个跳过项，项目脚本明确标注“非完整宿主验证”，不把它宣称为完整宿主验收。

Kaggle Notebook 的执行入口见 [`TRAINING-AND-BENCHMARK.md §6.3–6.4`](../TRAINING-AND-BENCHMARK.md)。准备好新 family 文件后，在 notebook 以 `--final-test-dataset /kaggle/input/<dataset>/micro-final-test.json` 传入并启用 `--push-back`；不提供文件时脚本会如实记录 blocked，绝不会用旧 validation 晋级。
