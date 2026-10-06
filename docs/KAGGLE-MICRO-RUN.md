# Kaggle 微模型训练可粘贴单元（v14.24.2 数据状态下）

> 前提：`transfer/models/unit-label-review-blind-v3.json` 已入库（348 条盲审，可训练 Unit 295→538）。
> 本轮**没有**新盲测家族 ⇒ 闸门必然是 `blocked`，脚本只出候选报告，**不会覆盖生产权重**（这是设计，不是失败）。

## 1. Notebook 设置

Kernel：Python 3 + GPU T4 ×2（免费档够）；**Internet 必须开**（要拉固定 revision 的 Granite 97M 底座）；Add Input → Dataset 可留空（无盲测集时不挂）。

```python
%cd /kaggle/working
import os
from kaggle_secrets import UserSecretsClient
pat = UserSecretsClient().get_secret("GITHUB_PAT")     # Secrets 里加 GITHUB_PAT（只读代码 + 写 release 视需要）
os.environ["GITHUB_PAT"] = pat
!rm -rf /kaggle/working/cfb
!git clone --depth 1 -b main https://x-access-token:{pat}@github.com/liaocr/cfb.git /kaggle/working/cfb
!pip install -q "transformers==4.56.2" safetensors onnx onnxruntime requests
```

## 2. 训练（只推报告，不推权重）

```python
%cd /kaggle/working/cfb
!python3 tools/kaggle-train-micro.py --epochs-sft 12 --epochs-simpo 12 \
  --student-pair-objective listwise --dataset-neg-strategy hardened \
  --unit-pair-degree-cap 3 --unit-pairs-per-positive 3 --near-length-tokens 3
```

- **不要加 `--push-back`**（本轮决定只推报告；训练产物留在 notebook 输出，报告手工回传）。
- **不要加 `--final-test-dataset`**：缺合法新家族时它本就应 blocked；加了只会得到一次被拒的"伪盲测"。

## 3. 跑完取回报告

```bash
# 本地：把 notebook 输出里的报告拖下来后
cp ~/Downloads/cfb-micro-97m-report.json transfer/models/ && node -e '
const r=require("./transfer/models/cfb-micro-97m-report.json");
console.log("gate:",r.gate,"| threeFold 均值:",r.threeFoldCv?.meanMatched,"最差折:",r.threeFoldCv?.worstMatched);
console.log("parity:",r.parity?.maxAbsError,"| 总参数:",r.totalParameters,"| data:",JSON.stringify(r.data?.stats||r.data).slice(0,160));'
```

## 4. 承重读数怎么读（三组阻塞闸门，缺一不晋级）

| 闸门 | 判据（不可放宽） | 现在能否判 |
|---|---|---|
| 三折家族 CV | 每折匹配桶 ≥ 同折生产 +20pp；均值 ≥0.75；最差折 ≥0.70；相对上一候选回退 ≤3pp；draft 合计 ≥0.85 且每折不低于生产 | ✅ 可判 |
| 部署路径 | PyTorch→JSON→JS parity ≤0.001；EXCLUDED 门控一致；INT8 ONNX smoke；总参数 <100,000,000；dev-only 纪律 | ✅ 可判 |
| 一次性新 family 盲测 | 匹配桶 ≥0.75 且 ≥同族生产 +20pp；draft ≥ max(0.85, 生产同族) | ❌ 缺盲测集 ⇒ **blocked** |

- 绝对 `>=90%` 点估计线照常展示在 `report.gates` / `report.ceilingDistances`，但**不阻塞**（三折匹配桶极差实测 22.9pp、最难族线性文本天花板 0.79）。
- 只看 `report.rulerReading.*.lengthMatchedAccuracy` 与其 Wilson 下界；**只在 `far` 层过线、`matched` 层不过线的候选，不许声称具备排序能力**。
- 教师（97M，INT8 约 98.7MB / CPU 280ms）指标逐轮报告，但不作为晋升阻塞项（进不了同步 JS 运行时）。

## 5. 解锁第 3 组闸门需要做的事（下一步）

新家族盲测集：`.cfb-offline/tasks/<id>.task.json`（schema `cfb.task/1`，`source: authored`，链形状 `u1/a1/a1Call/u2/a2/a2Edit/verifyCmd` + `r1 ≥50 字`）⇒ 造 `encoding-mojibake`、`lock-contention` 两个**可执行 fixture**，标签由运行时事实派生（require-hook 记录测试真正加载的文件；引用未加载的 decoy ⇒ 判 EXCLUDED；含 verifyCmd ⇒ 判 ACCEPT），文件带 `finalBlind:true`、`holdoutTouched:false`、`authorIsReviewer:true`、逐条 `semanticReview:{status:"confirmed",reviewer,rationale}`、`lineageReview`（`knownFamiliesReviewed` 精确等于训练三族、`knownSourceIdsReviewed` 精确等于训练 sourceId 全集、`independentSourceIds` 与数据完全一致且不重叠）、端点上限 ≤2、pair `split:"final-blind"`。

先跑**结构预检**（不打分数 ⇒ 不泄露给调参）：

```bash
node tools/eval-micro-js-pairs.mjs --validate-dataset-only \
  --dataset /tmp/micro-final-test.json --final-blind-test --must-be-new-family \
  --known-families flaky-timeout,perf-regression,sse-truncated \
  --known-source-ids "$(node -e 'const j=require("./transfer/models/micro-dev-dataset.json");console.log([...new Set(j.unitSamples.map(u=>u.sourceId))].join(","))')"
```

## 6. 已知未修（本轮上下文耗尽，别当成已完成）

1. **飞轮分数量纲 —— 已修（v14.24.5）**：现按 `scoreKind` 分派阈值（`judge-01` 走 0.05、`structural-tally` 走 ≥2 旗标差），promote 侧越界行不入库。实测：入库 67/80、丢弃 13、`distinctScorePairs 13`、draft pair 55（可训练 17）；**修前基线 105/59 里的 59 含 13 行单位错配垃圾**，别把 17 看成倒退。下面这段保留作决策记录。：`tools/helpers/experiment.mjs:75-77` 的 `structuralScore` 返回的是**旗标计数之和**（`v('next') + v('avoid') - v('falseDone') - v('bump') - v('reEdit') - v('repeat')`），而 `pairResults`（`:95`）把它塞进 `scores.candidate/control`，`cfb-cycle.mjs:390` 原样写盘 ⇒ `pairs.jsonl` 里出现 `93|0` 这类**不是 0–1 判分**的值。后果有两侧：
   - 构建器的可训练判据是 `chosenScore - rejectedScore >= 0.05`（`build-micro-dataset.mjs:684`），拿计数当判分 ⇒ 该闸门被计数尺度**平凡满足**；
   - 同时 `distinctScorePairs <= 2` 的退化判定（`:663`）又因重复计数值把整批降级 ⇒ 实测 draft pair 105/59 → 42/4。
   两条可选修法（**都需要你点头，因为会动冻结裁判/闸门语义**）：a) 在 harvest 侧把 tally 名次化（rank→[0,1] 线性映射）后再写 `chosenScore/rejectedScore`，并在行内标 `scoreKind:'tally-rank'`；b) 让构建器按 `scoreKind` 分派阈值（tally 走 `margin>=2`，judge 走 `>=0.05`）。**不建议**第三种：把 `0.05` 改成按分数自适应——那是给闸门松绑。
2. 本轮已把 `transfer/models/dev-flywheel-pairs.json` 与 `.cfb-offline/train/pairs.jsonl` 还原到提交态（`git checkout`），不把没解释清楚的倒退留在主干；`micro-dev-dataset.json` 未被改动。

## 5.1 复核（2026-10-06）：盲测集够格当结构闸，不够格单独撑晋级

独立审计脚本逐条对磁盘重测：18 项通过、每族 3 项失败。
1. **每族 32 单元里只有 11 种不同正文** —— 4 个任务共用同一份故障载荷 ⇒ 按 32 计样本量会低估方差（已写进 `stats.uniqueUnitTexts`）。
2. **12 对里只有 8 对落在 matched 层**（最大 |Δtok|=21）⇒ 匹配桶只在 8 对上说话；pair 的 rationale 已改为如实标注 `matched/near`（原先那句"已压进 matched 层"与数据不符，是我的过度声称）。
3. **EXCLUDED 单元 `cueExcluded` 特征实测 0（4/4）** ⇒ 本集测「有锚 vs 无锚」+ `excludedGateActive` 兜底路径，**不测**线索驱动的排除判定。

复核确认干净的：与训练 sourceId 零重叠；`micro-dev-dataset.json` 未混入 blind 内容（家族仍是训练三族）；构建器与任务池对 `micro-blind` 的静态引用为 0（不会自动进训练）；fixture 测试从不 require `loader.alt.cjs`；每对 win 的 yVal 严格大于 lose（违反 0）；端点度实算 max=2；语义审核分母自洽；manifest 覆盖 42 个盲测文件；`f671134` 未夹带 `.cfb-offline/`。

**两条正解（都要动闸门口径，等你签字）**：a) 每任务换成真不同载荷（我试过：标点级填充的粒度与 `tok` 度量交互，个别对压不进 NEAR=3 ⇒ 会留 near 冒充 matched，已回滚未入库）；b) 判据改为"按唯一正文计 + 只用 matched 层的对"。第三种"把 NEAR 放宽"是给闸门松绑，不做。
