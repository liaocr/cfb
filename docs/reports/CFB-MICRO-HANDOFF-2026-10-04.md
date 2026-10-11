# CFB-Micro 实验交接

**日期：** 2026-10-04（Asia/Shanghai）  
**GitHub：** `liaocr/cfb`, `main`  
**Kaggle 实验结果提交：** `3f258c5`  
**训练代码冻结提交：** `47e15c0`

## 结论

本轮已经在 Kaggle 免费 **2×Tesla T4** 实际完成一次训练。新增的 compact student Unit pairwise 目标显著提高了实际 JS Unit-pair 排序，但未达到晋级阈值；**candidate-only，生产权重没有替换**。没有新独立 family，最终盲测门仍关闭。

## 实验配置与可复现标识

- 教师底座：`ibm-granite/granite-embedding-97m-multilingual-r2`，revision `835ad14087e140460703cf0fae09f97d469d65c2`，Apache-2.0。
- 训练设备：Kaggle 2×Tesla T4；训练耗时 `128.76s`；SFT 有 3 个 AMP overflow skip，SimPO 0 个。
- 参数：`97,899,414 / 100,000,000`，余量 `2,100,586`。
- 训练数据 SHA-256：`400080ef45537e76a64cd3d4020092742cf9b5b9f35918d36fc3e48ee213767d`。
- 候选评分权重 SHA-256：`26375f701b86feddfd4962b62ffedeb85932506d15d23408d1d990815df6c8fa`。
- 生产评分权重 SHA-256（未更换）：`a3ddacc67139db0508e40eac59888c9acebbef04d8c8d1ee833a2fdf27f05bd7`。
- 训练目标包含 compact student 的 JS 对齐 Unit rank score、`gammaStep` margin pair loss；`beta=0.85`、loss weight `1.0`。这是 SimPO-inspired margin pair loss，不是完整原论文 SimPO。
- Checkpoint 使用 `sse-truncated` grouped validation 选择；该 family 已参与 checkpoint 选择，**不是 blind set**。

## 主要结果（实际生产 JS scorer、候选 JSON 序列化后）

| 指标 | 当前 production | Kaggle candidate | 变化 |
|---|---:|---:|---:|
| Unit pair train | 150/268 = 55.97% | 206/268 = 76.87% | +20.90 pp |
| Unit pair validation (`sse-truncated`) | 78/138 = 56.52% | 119/138 = 86.23% | +29.71 pp |
| Draft pair train | 74/88 = 84.09% | 74/88 = 84.09% | 无变化 |
| Draft pair validation | 35/40 = 87.50% | 35/40 = 87.50% | 无变化 |

- Unit 验证到理论 100% 上限还差 `13.77 pp`；要达到 `>=90%`，138 对中至少需 125 对正确，当前 119 对，差 6 对（门槛对应 `90.58%`）。
- Draft 验证到 100% 上限差 `12.50 pp`；36/40 才达到 90%，当前差 1 对。
- Teacher validation 仍是 Unit `78/138=56.52%`、Draft `35/40=87.50%`，均未达 90%。
- 按训练 family：`flaky-timeout` Unit `141/240=58.75% → 183/240=76.25%`；`perf-regression` `9/28=32.14% → 23/28=82.14%`。
- **需关注的副作用/质量风险：** compact student validation slot accuracy `43.56%`、macro-F1 `16.10%`；JS scorer audit 显示 163 个 validation endpoints 中 139 个被判为 `NOISE`。Pair rank 有提升，但不能据此宣称槽位分类或实际选取质量也已解决。

## 数值一致性、Mode 2 与 ONNX

- PyTorch→JSON→实际 JS parity：**passed**，容差 `0.001`；569 个 Unit / 256 个 Draft 实际特征行；最大误差分别 `0.00005044` / `0.00004974`；slot mismatch 0，EXCLUDED gate mismatch 0。
- Mode 2：G1 `11/11`、G2 `11/11`；dev、既有 holdout 均值均为 `1.0`，平均字符缩减 `58.81%`。这 4 个 Gold holdout 已被此前评测过，只是 Mode 2 安全门，**不是新泛化证据**。
- Full INT8 ONNX smoke：passed；`98,688,445` bytes（报告约 `98.69 MB`）；CPU batch=2、seq=256 延迟 `179.451 ms`。GitHub prerelease artifact：<https://github.com/liaocr/cfb/releases/download/cfb-micro-97m-candidate-20261004081525/cfb-micro-97m-multilingual.int8.onnx>。
- Compact student ONNX：`12,002` bytes；CPU batch=36 延迟 `0.0956 ms`。

## 晋级状态与产物位置

- `accepted=false`、`promoted=false`。未过：Teacher Unit/Draft >=90%、compact student JS Unit/Draft >=90%、fresh independent new-family test。
- 已通过：`under01B`、strict dev-only、Mode 2 G1/G2、full ONNX smoke、PyTorch→JSON→JS parity。
- 候选权重：`transfer/models/v5-micro-weights.candidate.json`。
- Compact ONNX candidate：`transfer/models/cfb-micro-neural.candidate.onnx`。
- 完整机器报告：`transfer/models/cfb-micro-97m-report.json`。
- 候选没有复制到 `transfer/models/v5-micro-weights.json`；生产权重保持原样。

## 数据口径与未完成项

- 本次 Kaggle 构建：Gold `7`、Pool `3`；Unit `1,538`，eligible `569`，needs-review `969`；Unit pairs `406`；唯一 endpoints `529`、引用 `812`、最大度数 `2`。
- Draft pairs `155`，本次 run 标记 eligible `128`、needs-review `27`。
- **数据统计差异必须保留：**此前本地 readiness 报告是 Draft eligible `118` / needs-review `37`，本次 Kaggle 是 `128/27`。本次 report/data SHA 以上述 Kaggle run 为准；不要把两个口径合并成同一结果，也不要无记录地覆盖差异。
- 标签仍为确定性规则筛选，LLM/人工语义复核没有执行。只有 3 个 dev families；没有新的、逐条语义审核的独立 family；final-family evaluator 未运行，ledger 未消费。

## 接手模型的当前边界

1. 先将本次 candidate-only 实验作为研究结果；**不要晋级或替换 production weights**。
2. 分析 Pair accuracy 上升与 `NOISE` 槽位占优之间的权衡；按 family/label slice 检查错例，不要只追 Unit pair aggregate。
3. 核对 `118/37` 与 `128/27` 的数据口径差异，并以各 run 的固定 SHA 记录。
4. 如继续晋级验证，必须新增真实独立 family 并逐条做来源/依据/质量语义审核；`sse-truncated` 不得冒充 blind set。最终 test 只能在代码、目标、权重、数据和 split 冻结后执行一次。
5. 安全：GitHub PAT 曾误出现在工具输出。旧 token 应撤销/轮换；不得把新 token 写入报告或聊天。当前 remote URL 已清理为无凭据 URL。

**固定 report 的 checkpoint freeze：** `2026-10-04T08:15:25Z`，code commit `47e15c0994c35a1fa4f00fe4dfb37ae4683fe057`。固定 source hashes 与 dataset hash 见 `transfer/models/cfb-micro-97m-report.json` 的 `dataset.finalEvaluationFreeze`。
