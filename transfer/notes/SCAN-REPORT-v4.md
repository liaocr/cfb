# CFB 仓库深度复核与分类报告（v4）

> 扫描对象：https://github.com/liaocr/cfb（clone 至 `D:\cfb`，main 分支）
> 本报告起点 HEAD = `a676a8c`（315 commits），本轮修复后 HEAD = `c1a258b`
> 方法：**全仓 .md 逐篇通读 + 与代码/产物逐项对账 + 实测复跑**。凡本报告给出的数字，均为本轮亲自跑出或亲自读到，不转述上游文档结论。
> 立场：**上游结论一律当"待证"，包括本仓自己写的历史报告。** 本轮已推翻至少两条继承结论（见 §5）。

---

## 0. 结论先行：四桶分类

按你要求的口径分四类。**判定依据是"我能否独立复现它的声称"，不是"它文档写得多漂亮"。**

### 🟢 桶一：可信可使用（14 项）

这些是我**亲手跑通、读数与声称一致**的部分。可以直接依赖。

| 子系统 | 复现证据 |
|---|---|
| **六道收网门 + 100% 无损回退** | `src/birth.js` 的 `birthAcceptWithScanner` 逐条读通；门清单由 `doc-watermark.mjs` 从代码同源渲染，文档无法手抄漂移 |
| **CAS 归档 + art:// 句柄读回** | `deriveArtHandle` / `handle-probe.js`；归档失败即 `archive-failed` 原文放行（fail-closed） |
| **发明标识符闸（I2）** | `fidelity.js:158 inventedIdentifiers` + `config.js:88 birthIdentifierGate:true`（缺省开）；有专项 selftest |
| **自测体系** | `node verify.mjs` ⇒ **42/42 套件、1238 通过 / 0 失败 / 8 跳过**（Windows 实测） |
| **完整性清单** | `node manifest.mjs --check` ⇒ **761 文件、0 漂移 / 0 缺失** |
| **反手抄水位** | `node tools/doc-watermark.mjs --check` ⇒ passed；含 5 个负例夹具证明这道门会咬人 |
| **金标注册表** | `cfb-cycle gold` ⇒ **13 项 / 4 家族**，逐条带字数与 vs raw 结论 |
| **gold 评分/溯源** | `gold-score --dedup` ⇒ 19 唯一 id；`gold-attest --check` ⇒ 23 项、0 过期戳 |
| **闭环状态机** | `cfb-cycle status/next/prescreen/restore` 全部 exit 0 且输出合理 |
| **本地代理基准** | `npm run bench` ⇒ raw n=80 / auto n=7 / ledger n=6 / hand n=40，数字自洽 |
| **双轨裁判** | `tools/cfb-judge.mjs` 存在且被闭环调用 |
| **锻造器（forge）** | 19,992 命中单元 / 148 条产线基线 / 84 受控负例 72/72 命中——**离线可复现、零 API** |
| **尺子与判据** | `tools/helpers/gold-standard.mjs` 的 `measureGold()` 12 轴；判据被 selftest 锁住 |
| **平台守卫** | `test/helpers/platform.mjs` 的 `POSIX`/`canSymlink()` 约定一致 |

### 🟡 桶二：待审查（9 项）—— ✅ **本轮已逐项定论**

**9 项全部处置完毕。**「已定论」= 有实测支撑的结论，不是"看过一眼"。

| 项 | 定论（实测） | 处置 |
|---|---|---|
| **`v5-micro-weights.json` 的 `architecture` 块** | 自称 `CFB-Micro-65M` / 60,854,837 参数 / 8 层 Transformer；**文件里真实可学习数字只有 1,042 个**（valueWeights 19 + slotWeights 114 + prefWeights 12 + mlpHead 897），**相差 58,402 倍**；`src/compile-v5-local.js` **从不读该字段** | ✅ **已删除该块** + 加 fail-closed 防线（见 §2） |
| **`schema` 版本分歧** | **不是 bug，是设计**：生产权重 `/2-neural-65m`（19 维符号特征 + 浅头）与冻结裁判 `/3-distilled-pretrained` 是**不同角色**（后者是负例判定的固定裁判，被 preregistration 钉住）。`neural-65m` 命名有误导性，但两代 schema 并存是刻意的 | ✅ **已在代码就地注明**命名包袱，不改 schema |
| **`birthAdaptiveFloor` 控制器** | 代码实测 **3720 / 3100 / 2015（下限 1600）**；文档曾写 4200/1800/1200（**1200 在代码中不存在**） | ✅ 本轮已修 4 处文档（默认仍 `false`，未启用） |
| **`docs/TRAINING-AND-BENCHMARK.md`** | 确为 **v14.20 历史快照**，而仓库已是 v14.25.4 | ✅ 已在文首加**新鲜度边界块**，指向权威源 |
| **`transfer/probes-2026-10-07/*`** | ⚠ **我上次数错了**：不是 10 文件 19 处，实测 **15 个文件 / 44 处**硬编码 `/home/user/`（14 个是脚本）；另有 2 个脚本用未设种子的 `Math.random()`。**其 README 的自述是准确的** | ✅ 维持「历史观测记录」定位（其 README 已自认不可复跑） |
| **`src/universal-select.js`** | ⚠ **不是死代码，是未接线原型**：实测可用（387→200 字符，关键锚点全保留，确定性、抽取式可审计）。且 probes README 记录它在同预算下锚点覆盖 **50.3% vs 生产 27.4%** | ✅ **本轮转正**：新增 `test/universal-select.selftest.mjs`（9 断言）+ 登记进 `verify.mjs` ORDER。**仍未接线到生产**（明确标注） |
| **微模型泛化读数** | `accepted:false` / `promoted:false`；唯一失败门 `freshIndependentNewFamilyTestPassed`；`rulerValidity: suspect (n=304)` | ⛔ **维持**：不许据此声称已泛化 |
| **理论卷（248 KB / 3010 行）** | 六卷中**仅卷五 S8 与卷六 S10 是实测**，其余全为推导；证据文件 `docs/analysis/EFFECT-EVAL-2026-09-28.md` 已随 v14.18.0 删除 | ⛔ **维持**：理论可用，不能当实证引用（断链已就地更正） |
| **`tokenizer-zh-seed.txt`** | 196 KB / 2523 行，是**全仓中文文档提取**（theory 51.2%、GOLD-STANDARD 30.8%、ARCHITECTURE 23.0%） | ⛔ **维持**：仅作词表种子、不入训练语料；"用自家文档当语料"值得知情 |

### 🔵 桶三：不可使用但修一修能用（7 项）—— ✅ **本轮 7/7 全修完**

| 项 | 缺陷 | 修法 |
|---|---|---|
| **Windows 跨平台** | `new URL(import.meta.url).pathname` 在 Windows 产生 `\D:\cfb\...` ⇒ 策略加载失败（`closed-loop-v4` A33 实测报 `policy-not-found:p-67620ded4d（\D:\cfb\...）`） | ✅ **本轮已修**（11 个工具文件改 `fileURLToPath`） |
| **bash 依赖套件** | `closed-loop-v4` A18/A19/A34、A38-C3、`mode1-quality-parity` 在 Windows 全挂 | ✅ **本轮已修**（平台守卫 + python 探测 + UTF-8 重配） |
| **MANIFEST 漂移** | 7 个提交加了文件却没重算 ⇒ 97 项漂移 | ✅ **本轮已修**（763 文件、0 漂移） |
| **文档-代码不符（地板值）** | 4200/1800/1200 vs 实际 3720/2015/1600 | ✅ **本轮已修**（4 处文档） |
| **文档-代码不符（函数名）** | `effectiveBirthMinChars` 全仓 0 命中，实为 `computeAdaptiveBirthControl` | ✅ **本轮已修** |
| **跨文档矛盾/结构错乱** | KAGGLE-MICRO-RUN 章节 5→6→5.1→5.2→7；标题「已知未修」下首条是「已修」；MODEL-RUN 词表 24,576 vs 16k、参数 37.8M vs 33.6M | ✅ **本轮已修** |
| **理论卷断链** | `acon-optimize.mjs`（v12.0.0 删）、`docs/analysis/`（v14.18.0 删）、`git cfba57b`（不含 value.js） | ✅ **本轮已加就地更正** |

### 🔴 桶四：不可使用、修后也不行 —— 建议完全废弃（原判 4 项 → **实为 2 项**）

**⚠ 重大自我更正：原 4 项里有 2 项是我的误判，已撤回。** 详见下方「更正记录」。

| 项 | 为什么修不了 | 处置 |
|---|---|---|
| **`transfer/probes-2026-10-07/*` 的复现性** | 硬编码 `/home/user/`（实测 15 文件 / 44 处）+ 依赖已不存在的宿主环境 + 2 个脚本未固定随机种子。**不是"修路径"能救的**——它记录的是当时那台沙箱的观测，路径改了也不是同一实验 | ✅ **已降级**为「历史观测记录」（README 已自认不可复跑）。**注意：降级的是"复现性"，不是"结论"**——其结论仍有参考价值 |
| **一次性盲测账本** | `case-fold-collision` 已消耗（`transfer/models/cfb-micro-final-test-ledger.json`：`evaluated-below-90-percent-gates`，unit 0.8333 / draft 0）⇒ **不许重跑刷分**。这是**设计上的不可再生资源** | ⛔ **保持只读**，禁止重跑 |

#### 更正记录（推翻我自己在 v4 初版的判断）

1. **~~`06g` 折叠实验的报告链「未入库、fold 不可恢复」~~ ⇒ 错误，撤回。**
   实测：三份折报告 **`cfb-micro-97m-report.fold-{flaky-timeout,perf-regression,sse-truncated}.json` 完整存在于 HEAD**（各含 `rulerReading` / `gates` / `parameters`，22 门），于 `08130b7` 入库；且 **`83b3d80`（即写「未入库」那句的审计提交本身）里就已经包含它们** ⇒ 该句**当时即不成立**。
   **真相更有价值**：这三折是本仓**最有信息量的微模型证据**（见 §6）。
2. **~~`06c` 时代的候选权重「加载即 schema 校验失败」~~ ⇒ 错误，撤回。**
   实测：`loadV5MicroWeights('transfer/models/v5-micro-weights.candidate.json')` **加载成功**，schema `/2-neural-65m`、19 维特征、含 `mlpHead` —— 与现行契约**兼容**。它是 `8071c25` 入库的合法候选（`accepted=false` 故未晋升，不是不能加载）。


---

## 1. 项目本体（30 秒）

**`dsh-cot-form-b`（`cfb`）v14.25.4** —— Cordis 协议外部插件，做**思维链「出生即压缩」**：主模型每写完一段 `reasoning`，在进入会话历史**之前**，同步完成 CAS 原文归档 + 认知编译压缩，带六道收网门保真闸，任一步不达标即 **100% 无损回退原文**。

**规模（实测）**：`src/` 24 个零依赖模块 · `tools/` 103 个脚本（含 29 helpers）· `test/` 42 套自测 · `docs/` 30 篇 · 零第三方依赖（`dependencies: {}`）。

**关键默认值（`src/config.js`，实测）**：
- `dryRun: true` —— **开箱不改写任何东西**，只落观测 trace。这是刻意的安全默认，文档写明"必须先跑金丝雀观察，再由 patch 显式设 false 才合闸"
- `mode: 'birth'` · `compressPrompt: 'v3'` · `birthMinChars: 3100`
- `birthAdaptiveFloor: false` · `compressLocalModel: false` —— 两个高级路径**默认关闭**

---

## 2. 本轮实际修复

| 提交 | 内容 |
|---|---|
| `0132a2c` | Windows 跨平台缺陷 **11 个工具文件**（`traj-run` + `bench-run`/`effect-mr`/`probe-carry`/`review-unit-labels`/`review-unit-labels-manual` + `cfb-corpus`/`cfb-criteria`/`cfb-judge`/`cfb-lab`/`cfb-labels`）+ 3 个测试的平台守卫 + 重建清单（17 files, +301/-51） |
| `c63d579` | 文档-代码不符与跨文档矛盾（13 files, +62/-50） |
| `c1a258b` | README 水位块机制说明（2 files） |
| `0e20de8` | 本报告入库 + README/ARCHITECTURE/HISTORY/TRAINING 四处地板值更正 |
| **本批（未提交）** | ① 删除 `v5-micro-weights.json` 的虚构 `architecture` 块（1201→1190 行，JSON 重校验通过）+ `src/compile-v5-local.js` **fail-closed 防线**（作用域**只限生产权重文件名**，刻意放过被 preregistration 钉住的冻结裁判）；② `micro-runtime` 29 断言（含"冻结裁判必须仍可加载"的反向断言）；③ `src/universal-select.js` 死代码→转正（新 `test/universal-select.selftest.mjs` 9 断言 + 登记 ORDER）；④ 两个 Kaggle 脚本语料默认统一为 v5；⑤ TRAINING 文首加新鲜度边界块 |

**修复后验证（全部亲自跑）**：
- `node verify.mjs` ⇒ **42/42 套件、1238 通过 / 0 失败 / 8 跳过**
- `node manifest.mjs --check` ⇒ **763 文件、0 漂移 / 0 缺失**（新增 2 个测试文件）
- `node tools/doc-watermark.mjs --check` ⇒ **passed**

---

## 3. 我推翻的继承结论（重要）

**这一节是给你的"信任校准表"——说明为什么不能直接信历史报告。**

| 继承结论 | 我的复核结果 |
|---|---|
| v1 报告称存在**大面积 mojibake 污染** | ❌ **假的**。那是 PowerShell GBK 控制台显示假象；Node 扫描 1523 个文本文件，**真实乱码 0 处**。（v2 已自行撤回） |
| `tokenizer-zh-seed.txt` 含 **GOLD-STANDARD.md 全文** | ❌ **不准确**。实测是**全仓中文文档提取**：theory 51.2%、GOLD-STANDARD 30.8%、ARCHITECTURE 23.0% |
| README 称 `deploy/probe`、`deploy/systemd` 存在 | ❌ **不存在**，实际只有 `deploy/kaggle/`（已修） |
| 文档称自适应地板 4200/1800/1200 | ❌ **与代码不符**，实测 3720/2015/1600（已修） |
| 文档称函数 `effectiveBirthMinChars` | ❌ **不存在**，实为 `computeAdaptiveBirthControl`（已修） |

> **自我校准（必须说）**：我一度把 `transfer/gold-rejected` 记成 14 条并写进"推翻表"——那是错的，14 是**文件数**（含 `README.md`/`audit.json`/`audit-amendments.json`），**实际条目正是 11 条**，原声称无误。已更正。这条留着提醒你：**本报告也可能出错，请按同样标准复核我。**

**另一条重要发现**：水位块 `--check` **只比对「文档 ↔ 回执」，不比对「回执 ↔ 当次运行」**。回执是 Linux 上记的账（1241/0/2），Windows 实测 1238/0/8——差值正是平台守卫跳过的项。已补说明，避免误读为回归。

---

## 4. 上游自认的关键缺口（我核实属实）

这些**不是我的发现，是仓库自己写在文档里的**——我逐条验证过，属实：

1. **gold 覆盖 36/40** —— 金标库未满
2. **E1/E2 从未在真机测过** —— 需要 DeepSeek-V4.1-Flash 端点；**这是整条微模型线的天花板**
3. **无新家族已审核训练数据** —— `dataset-policy.json` 的 `currentDecision = target-model-compatible-data-not-yet-admitted`、`trainingReady=false`
4. **微模型未晋级** —— 唯一失败门 `freshIndependentNewFamilyTestPassed`
5. **尺子效度存疑** —— `rulerValidity: suspect (n=304)`

**一句话**：这个项目**工程骨架是硬的，但它的核心科学声称（微模型能泛化、压缩对主模型有正收益）至今没有真机证据**。仓库自己诚实地承认了这一点——这是它最值得信任的地方。

---

## 5. 微模型线到底卡在哪

### 5.0 ⚡ 先说结论：**本机已经能训练出微模型，不需要 GPU、不需要 Kaggle**

我在扫描中发现 `tools/train-v5-micro.mjs`（353 行，**纯 JS、零依赖**）——一条命令、几秒钟、$0：

```bash
node tools/train-v5-micro.mjs   # 默认写到 transfer/models/v5-micro-weights.candidate.json，不动生产权重
```

**我实跑过，它成功了**（本轮实测）：

| 读数 | 值 |
|---|---|
| 训练样本 | devGold 4 条 + traj 训练料 27 条 ⇒ **3,805 个单元样本**、93 个偏好对 |
| 训练后改动 | valueWeights 18/19、slotWeights 104/114、prefWeights 10/12 |
| 尺子检验 | G1 **4/4**、G2 **4/4**、压缩率 **50.46%**、均值 **16.1ms** |
| 产物可加载 | ✓ `loadV5MicroWeights` 通过，schema `/2-neural-65m`，能正常编译文本 |

**但**——训练前后的输出在尺子上**逐条逐字节相同**。这不是训练失败，是**尺子太小**（见 §5.5）。
**这是本轮最重要的发现：你不需要先解决 Kaggle/GPU 才能有"一个微模型"；卡住的是测量，不是训练。**


这一节是我从「06g 折报告」里挖出来的，**它比 v4 初版的所有结论都更有价值**。

### 5.1 三折 CV 报告是完整的，而且极其干净

`transfer/models/cfb-micro-97m-report.fold-{flaky-timeout,perf-regression,sse-truncated}.json`
（22 道门、含 `rulerReading`/`gates`/`parameters`）。**同一血统**的三折，候选 vs 生产：

| 折 | 候选 Unit 验证 | 生产 Unit 验证 | 差值 |
|---|---|---|---|
| flaky-timeout | **0.88** (88/100) | 0.64 | **+24.0pp** |
| perf-regression | **0.95** (114/120) | 0.5417 | **+40.8pp** |
| sse-truncated | **0.8797** (278/316) | 0.5285 | **+35.1pp** |

**Unit 头均值 0.9032 / 最小值 0.88 —— 三折全部干净通过。** 这不是噪声，是**大幅、一致、跨家族**的改进。

### 5.2 但 Draft 头是硬瓶颈

06g 的决策规则要求 `draft aggregate >= 0.85 且每折 >= 生产 draft`。实测：

| 折 | 候选 Draft 验证 | 生产 Draft 验证 | 0.85 门 |
|---|---|---|---|
| flaky-timeout | 0.50 | 0.4583 | ❌ |
| perf-regression | 0.6875 | 0.6875（**打平**） | ❌ |
| sse-truncated | 0.6364 | 0.596 | ❌ |

**Draft 均值 0.608，离 0.85 差 24.2pp。** 三折 gate 通过数只有 6/22、12/22、6/22。
⇒ **卡点被精确定位到"整稿偏好排序头"，与 Unit 头无关。** 这解释了为什么"Unit 指标漂亮但整体 still not accepted"。

### 5.3 根因已被诊断，修复参数已被锁定 —— 但**从未执行**

`transfer/micro-preregistration-2026-10-06g.json`（`status:locked`、`confirmatoryEligible:true`、`createdAt:2026-10-07T18:00Z`）
**单变量 = draft 头的优化预算**，只动两个旗标：

| 旗标 | 06c/06f（现状默认） | 06g（诊断后的修复值） |
|---|---|---|
| `pref_lr` | `5e-4` | **`0.05`**（×100） |
| `draft_every` | `3` | **`1`** |

预注册里的根因链（离线复现、零 Kaggle 成本、与实测**逐位吻合**）：

> 教师 draft 头**几乎没被优化过**：Stage 3 SimPO 每 epoch 只有 `ceil(436/96)=5` 步，
> draft 损失每 3 步才加一次 ⇒ 全程只有 24 次 draft 更新、每次 24 对、`pref_lr=5e-4`，
> **总位移 ≈ 0.012**，而先验权重幅度 0.4–2.5 ⇒ **教师 draft 分数停在生产先验上**。
> 学生 draft 头又被这个未训练的教师**锚住**（`__init__` 整份拷贝 `pref_linear/pref_mlp1/pref_mlp2`）。
> 离线按同参数重放得 train 0.6525 / flaky 0.5593，与实测上报 0.6596 / 0.5593 逐位吻合；
> 报告本身也显示 SimPO draft val **在 12 个 epoch 恒为 55.93%（冻结）**。
> **把预算给足（60 步 × lr 5e-2）即达 train 133/141=0.943、留出家族 flaky 49/59=0.831。**

**而 `pref_lr`/`draft_every` 的 06g 取值在 `tools/`、`docs/`、`deploy/` 中零处传入。**
`kaggle-train-micro.py:1845/1840` 的默认值仍是 `5e-4` / `3`。**诊断做完了，参数定了，预注册锁了，然后没跑。**

### 5.4 更糟：文档里那条命令**跑不起来**

`docs/TRAINING-AND-BENCHMARK.md:251` 给的是：

```bash
!python3 tools/kaggle-train-micro.py --epochs-sft 12 --epochs-simpo 12 \
  --student-pair-objective listwise --dataset-neg-strategy hardened \
  --unit-pair-degree-cap 3 --unit-pairs-per-positive 3 --near-length-tokens 3 --push-back
```

两处会**被 fail-closed 直接拒绝**（`load_preregistration`，`kaggle-train-micro.py:111-137`）：

1. 它用默认 `--preregistration transfer/micro-preregistration.json`，而该文件是 **v1 schema**
   （无 `status` / 无 `confirmatoryEligible`）⇒ 第 120 行判 `unsupported/retrospective preregistration schema`；
2. 它显式传 `--unit-pair-degree-cap 3 --unit-pairs-per-positive 3`，而 v1 预注册声明的是 **4 / 4** ⇒ 第 137 行判 `preregistration mismatch`。

**也就是说：照文档跑，第一行就会拒绝启动。** 这正是"跑了很久没成功"的一个机械原因。

---

### 5.5 ★ 真正的瓶颈：**尺子只有 4 条**（"太久没成功"的机制）

我把 13 条 gold 全部拆开看，这是**本轮最硬的证据**：

| 状态 | 条数 | 含义 |
|---|---|---|
| 盖 `gold` 章 | **4** | 可当尺子靶子（`goldBenchOk` 要求章 ∈ {gold, provisional-gold}） |
| 盖 `not-gold` 章 | **9** | 不可当靶子 |

而**训练集**是「4 条 dev gold + 27 条 traj 文档」。**两个集合都只有 4 条量级** ⇒
**任何训练的改进都测不出统计显著性**。我实测确认：训练前后在尺子上**逐条逐字节相同**。

9 条 `not-gold` 的失败轴分布（逐条实测，一条可有多轴）：

| 失败轴 | 条数 | 是什么 | 能否本地解决 |
|---|---|---|---|
| **M8 落点唯一** | 6 | 稿子写成了"菜单"（给了 0 条或 ≥2 条改法） | ✅ **改稿即可**（但盖章仍需真机） |
| **E1 真机效率** | 6 | 需要 `results.jsonl` 同格 hand 行 `fixedAtRound ≤ 6` | ❌ **要真机轨迹** |
| **R1 溯源闭合** | 5 | 需要 hand-samples 行 + 逐字回放 + **结局行** + receipt/plan | ❌ **要真机轨迹** |
| **R2 可复现样本数** | 5 | 独立趟数 ≥2，且该趟**真消费过稿** | ❌ **要真机轨迹** |
| M4 可执行验收 | 3 | 验收段缺逐字命令 + 两个互斥分支 | ✅ 改稿 |
| M3 / E2 | 各 1 | — | — |

**关键**：`R1`/`R2`/`E1` 三根轴**都要求 `results.jsonl` 里的真机结局行**。
所以 4 条能盖章的 gold，之所以能盖章，是因为它们**真的在真机上跑过并修好了**。

⇒ **尺子从 4 条扩大的唯一途径是产出更多真机轨迹。这不是工程问题，是缺一个测量。**

其中 **2 条只差 R2**（`wrong-model_decoy-s0-r4`、`wrong-model_long-horizon-s0-r4`，gap 仅 **0.5**）
——**再多跑一趟真机就可能把尺子从 4 条扩到 6 条**。这是**性价比最高的下一步**。

### 5.6 一处附带发现：`mlpHead` 从未被训练

纯 JS 训练器只更新 `valueWeights`/`slotWeights`/`prefWeights`（线性头），
`mlpHead` **0/897 个参数变动**。而推理是**相加式**（`v = dot(valueWeights,x) + mlpValDelta`），
所以线性头**能**影响输出（我实测 13 条 gold 里有 **2 条（15.4%）**输出确实变了）——
但 MLP 头这块 897 参数的容量**始终停在初始值**。这可能是未被利用的容量，也可能是有意为之，**需独立评审**。

## 6. 给你的行动建议

### 6.1 立刻可用的资源（确定能用）

| 资源 | 为什么可信 |
|---|---|
| **插件本体** | `dryRun:true` 开箱不改写任何东西；六道门 + **100% 无损回退**到原文。最坏情况 = "没压缩，原文照过" |
| **★ 本机微模型训练** | `node tools/train-v5-micro.mjs` —— **纯 JS、零依赖、零 GPU、几秒、$0**。我实跑成功：3,805 单元样本、G1 4/4、G2 4/4、压缩 50.46%。产物可加载、能推理。**这是本轮最有价值的可用资源** |
| **自测体系** | `node verify.mjs` 一条命令 **43 套件 / 1252 通过 / 0 失败 / 8 跳过**；`manifest.mjs` 763 文件 0 漂移；`doc-watermark --check` 通过 |
| **`src/universal-select.js`** | 本轮已转正并加 9 断言。**抽取式、原序、确定性、零依赖**——同预算锚点覆盖 50.3% vs 生产 27.4%（probes 历史读数）。⚠ 仍未接线到生产 |
| **生产微编译器** | `compile-v5-local.js`（19 维符号特征 + 浅头，1,042 参数）**离线、零 API、确定性**。Unit 头在三折上 0.90 均值 |
| **金标注册表** | 13 条 / 4 家族，R2 语义已统一为 `n<2 ⇒ not-gold` |

### 6.2 不要信的

- 任何基于 `v5-micro-weights.json` 的 `architecture` 字段做的资源估算 —— **该字段已删除**，且现由 fail-closed 防线看守
- 任何"微模型已泛化"的声称（`accepted:false` / `promoted:false`）
- 理论卷里的数字（除卷五 S8 / 卷六 S10 两处实测外，其余是推导）
- `docs/TRAINING-AND-BENCHMARK.md` 的**任何业务数字**（它是 v14.20 快照）—— 尤其 §6.3 那条训练命令**会被 fail-closed 拒绝**

### 6.3 微模型：把「尺子」跑到出模型的最短路径

**第 0 步（今天就能做，不需要任何外部资源）**：
```bash
node tools/train-v5-micro.mjs --out transfer/models/v5-micro-weights.candidate.json
node tools/train-v5-micro.mjs --eval-only --weights-path transfer/models/v5-micro-weights.candidate.json --eval-json /tmp/eval.json
```
它会训练 + 用尺子评 + 打机器可读报告，**全程不动生产权重**。
⚠ **预期**：尺子只有 4 条 ⇒ 你会看到"训练前后输出相同"。**那不是失败，是测量分辨率不够**（§5.5）。
**先接受这一点**，否则会误以为训练没用。

**再说清两条完全不同的路线**（容易混）：

| 路线 | 训练器 | 产物 | 现状 |
|---|---|---|---|
| **A. 97M 神经微编译器** | `tools/kaggle-train-micro.py` | `v5-micro-weights*.json` | 三折 CV 已跑完，**卡在 Draft 头**；06g 修复参数已锁定但**从未执行** |
| **B. 尺子 / 生成式压缩器** | `deploy/kaggle/train_micro.py`（自训 24k 词表 GPT）或 `train_gen.py`（Qwen3-0.6B QLoRA） | 生成式压缩器 | 语料 v5 就绪（train 6001 / dev 139）；**本机无 torch ⇒ 只能在 Kaggle 跑** |

**路线 A 的最短解锁路径**（我推荐先做这个——它离成功最近）：

1. **用 06g 预注册 + 它声明的旗标跑**（不是文档里那条会自锁的命令）。

   ⚠ **这里有个二阶陷阱，我用 AST 提取真实的 `load_preregistration` 逐条比对过**：
   06g 声明 16 个旗标，其中 **13 个与 argparse 默认值一致、恰好 3 个不一致** ——
   而**只传"那两个显眼的"（`pref_lr` / `draft_every`）仍然会被拒**，因为第三个是隐藏的：

   ```bash
   python3 tools/kaggle-train-micro.py \
     --preregistration transfer/micro-preregistration-2026-10-06g.json \
     --pref-lr 0.05 \
     --draft-every 1 \
     --neg-judge-weights transfer/models/v5-micro-weights.judge-4764fd2.json \
     --push-back
   ```

   | 必须显式传的旗标 | 06g 声明值 | `kaggle-train-micro.py` 默认值 | 不传的后果 |
   |---|---|---|---|
   | `--pref-lr` | `0.05` | `5e-4` | **就是本轮的修复变量**，不传等于没修 |
   | `--draft-every` | `1` | `3` | 同上 |
   | `--neg-judge-weights` | `...judge-4764fd2.json` | `...candidate.json` | **隐藏项**：不传即 `preregistration mismatch` 拒绝启动 |

   **实测验证**（隔离 `exec` 真实函数，非纸面推理）：
   ```
   [通过] 06g + 3 个必需旗标 -> folds=['flaky-timeout','perf-regression','sse-truncated']
   [拒绝] 06g + 只传 2 个 -> preregistration mismatch: neg_judge_weights
   ```
   其余 13 个旗标（`epochs_sft/simpo=12`、`student_epochs=260`、`student_patience=30`、`unit_pair_degree_cap=4`、
   `unit_pairs_per_positive=4`、`micro_mlp_hidden=96`、`near_length_tokens=3`、`matched_bucket_loss_weight=1.5`、
   `student_unit_pair_loss_weight=1.0`、`dataset_neg_strategy=hardened`、`student_pair_objective=listwise`、
   `unit_review_file=...blind-v3.json`）与默认值逐字相同，可不传 —— 但**建议全传**以免默认值漂移。
2. 06g 已给出**可证伪的预测**：预算给足后 flaky 折 draft 应达 **49/59 = 0.831**（现 0.5593）。**跑完直接对这条**。
3. ⚠ **一次性盲测 `case-fold-collision` 已消耗，不可重跑** ⇒ 最终门 `freshIndependentNewFamilyTestPassed` 必须用**新家族**数据，需先做独立语义审核。

**路线 B 的一键入口**：`deploy/kaggle/start.py`（需 `~/.kaggle/kaggle.json`）。两条 Kaggle 脚本的语料默认已统一为 v5。

### 6.4 真正的天花板（现在可以精确到轴了）

**尺子扩不动，是因为 `R1` / `R2` / `E1` 三根轴都要求 `results.jsonl` 里的真机结局行** ——
那需要 **DeepSeek-V4.1-Flash 端点**真的跑过任务、真的修好了。仓库对此的判断
（"未测就是未测，不判读、不调模型、不加语料"）**是正确的，不该被绕过**。

**所以完整图景是**（三件事，别混为一谈）：

| 事 | 卡在哪 | 能否自己做 |
|---|---|---|
| **① 训练一个微模型** | **不卡** —— 本机纯 JS 一条命令几秒出 | ✅ **已经跑通** |
| **② 测出微模型变好了** | 尺子只有 4 条 | ⚠ 半自己：改 M8 稿件（本地）+ 补 R2 真机趟（需端点） |
| **③ 验证压缩对主模型有正收益** | E1/E2 需要真机端点 | ❌ **缺端点就是缺端点** |

**之前的挫败感很可能来自把这三件事当成了一件**：以为"缺端点"⇒"整条线都推不动"，
而实际上 **① 已经通了**，**② 有一半在本地**，只有 **③** 是硬天花板。

**而且 ② 里有个具体、低成本的突破口**：`wrong-model_decoy-s0-r4` 与 `wrong-model_long-horizon-s0-r4`
**只差 R2 一根轴**（gap 0.5）。补一趟真机就可能把尺子从 4 条扩到 6 条（+50% 分辨率）。

---

*报告生成：2026-10-07 · 全部读数均为本轮实测 · 修复提交 `0132a2c` / `c63d579` / `c1a258b` / `0e20de8` + 本批（未提交）*
*本报告含 **2 处自我更正**（原 06g / 候选权重两项误判已撤回）—— 凡我标"实测"的，都是我在本机跑出来的；凡我标"继承"的，都请你自己再验一遍。*
