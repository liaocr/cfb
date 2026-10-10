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

### 🟡 桶二：待审查（9 项）

**能用，但有一处已知不实或未验证，依赖前必须知道边界。**

| 项 | 问题（实测） | 风险 |
|---|---|---|
| **`transfer/models/v5-micro-weights.json` 的 `architecture` 块** | 自称 `CFB-Micro-65M` / 60,854,837 参数 / 8 层 Transformer；**文件里真实可学习参数只有 1,029 个**（19+114+896），`src/compile-v5-local.js` **从不读该字段**（零命中） | **高**。任何按 `architecture` 估算显存/算力的人都会错 5 万倍。生产实际是"19 维符号特征 + 浅头"，不是 Transformer |
| **`schema` 版本分歧** | 生产权重 `cfb.v5-micro-weights/2-neural-65m`；冻结裁判 `judge-4764fd2` 是 `/3-distilled-pretrained`；训练器写 3 | 中。两代 schema 并存，语义不同 |
| **`birthAdaptiveFloor` 控制器** | 代码实测 **3720 / 3100 / 2015（下限 1600）**；文档曾写 4200/1800/1200（**1200 在代码中不存在**）⇒ 本轮已修文档 | 中。默认 `false`（未启用），启用前应先看真实曲线 |
| **`docs/TRAINING-AND-BENCHMARK.md`** | 是 v14.20 历史快照，但 README §5 引用其数字 | 中。读数有时效性 |
| **`transfer/probes-2026-10-07/*`** | 10 个文件含 **19 处硬编码 `/home/user/cfb`** | 中。**换环境不可复现**（文档已自认） |
| **`src/universal-select.js`** | **129 行死代码**：零 import、零测试、不在 `verify.mjs` | 低。无害但误导（标着 v14.26 原型） |
| **微模型泛化读数** | `accepted:false` / `promoted:false`；唯一失败门 `freshIndependentNewFamilyTestPassed`；`rulerValidity: suspect (n=304)` | **高**。**不许据此声称已泛化** |
| **理论卷（248 KB / 3010 行）** | 六卷中**仅卷五 S8 与卷六 S10 是实测**，其余全为推导；证据文件 `docs/analysis/EFFECT-EVAL-2026-09-28.md` 已随 v14.18.0 删除 | 中。理论可用，但**不能当实证引用** |
| **`tokenizer-zh-seed.txt`** | 196 KB / 2523 行，是**全仓中文文档提取**（theory 51.2%、GOLD-STANDARD 30.8%、ARCHITECTURE 23.0%） | 低。仅作词表种子、不入训练语料；但"用自家文档当语料"值得知情 |

### 🔵 桶三：不可使用但修一修能用（7 项）

**缺陷明确、边界清楚、修复路径已验证。**

| 项 | 缺陷 | 修法 |
|---|---|---|
| **Windows 跨平台** | `new URL(import.meta.url).pathname` 在 Windows 产生 `\D:\cfb\...` ⇒ 策略加载失败（`closed-loop-v4` A33 实测报 `policy-not-found:p-67620ded4d（\D:\cfb\...）`） | ✅ **本轮已修**（11 个工具文件改 `fileURLToPath`） |
| **bash 依赖套件** | `closed-loop-v4` A18/A19/A34、A38-C3、`mode1-quality-parity` 在 Windows 全挂 | ✅ **本轮已修**（平台守卫 + python 探测 + UTF-8 重配） |
| **MANIFEST 漂移** | 7 个提交加了文件却没重算 ⇒ 97 项漂移 | ✅ **本轮已修**（761 文件、0 漂移） |
| **文档-代码不符（地板值）** | 4200/1800/1200 vs 实际 3720/2015/1600 | ✅ **本轮已修**（4 处文档） |
| **文档-代码不符（函数名）** | `effectiveBirthMinChars` 全仓 0 命中，实为 `computeAdaptiveBirthControl` | ✅ **本轮已修** |
| **跨文档矛盾/结构错乱** | KAGGLE-MICRO-RUN 章节 5→6→5.1→5.2→7；标题「已知未修」下首条是「已修」；MODEL-RUN 词表 24,576 vs 16k、参数 37.8M vs 33.6M | ✅ **本轮已修** |
| **理论卷断链** | `acon-optimize.mjs`（v12.0.0 删）、`docs/analysis/`（v14.18.0 删）、`git cfba57b`（不含 value.js） | ✅ **本轮已加就地更正** |

### 🔴 桶四：不可使用、修后也不行 —— 建议完全废弃（4 项）

| 项 | 为什么修不了 |
|---|---|
| **`transfer/probes-2026-10-07/*` 的复现性** | 硬编码 `/home/user/cfb`（19 处）+ 依赖已不存在的宿主环境。**不是"修路径"能救的**——它记录的是当时那台沙箱的观测，路径改了也不是同一实验。建议：降级为"历史观测记录"，明确标注不可复现 |
| **`06g` 折叠实验的报告链** | fold 报告从未提交，**fold 不可恢复**。数据没了就是没了，重跑不等于复现 |
| **一次性盲测账本** | `case-fold-collision` 已消耗 ⇒ **不许重跑**。这条是**设计上的不可再生资源**，用掉就是用掉了 |
| **`06c` 时代的候选权重** | 与现行 `compile-v5-local.js` 的 19 维特征契约脱钩，**加载即 schema 校验失败**。留着只会误导 |

---

## 1. 项目本体（30 秒）

**`dsh-cot-form-b`（`cfb`）v14.25.4** —— Cordis 协议外部插件，做**思维链「出生即压缩」**：主模型每写完一段 `reasoning`，在进入会话历史**之前**，同步完成 CAS 原文归档 + 认知编译压缩，带六道收网门保真闸，任一步不达标即 **100% 无损回退原文**。

**规模（实测）**：`src/` 24 个零依赖模块 · `tools/` 103 个脚本（含 29 helpers）· `test/` 42 套自测 · `docs/` 30 篇 · 零第三方依赖（`dependencies: {}`）。

**关键默认值（`src/config.js`，实测）**：
- `dryRun: true` —— **开箱不改写任何东西**，只落观测 trace。这是刻意的安全默认，文档写明"必须先跑金丝雀观察，再由 patch 显式设 false 才合闸"
- `mode: 'birth'` · `compressPrompt: 'v3'` · `birthMinChars: 3100`
- `birthAdaptiveFloor: false` · `compressLocalModel: false` —— 两个高级路径**默认关闭**

---

## 2. 本轮实际修复（3 个提交）

| 提交 | 内容 |
|---|---|
| `0132a2c` | Windows 跨平台缺陷 **11 个工具文件**（`traj-run` + `bench-run`/`effect-mr`/`probe-carry`/`review-unit-labels`/`review-unit-labels-manual` + `cfb-corpus`/`cfb-criteria`/`cfb-judge`/`cfb-lab`/`cfb-labels`）+ 3 个测试的平台守卫 + 重建清单（17 files, +301/-51） |
| `c63d579` | 文档-代码不符与跨文档矛盾（13 files, +62/-50） |
| `c1a258b` | README 水位块机制说明（2 files） |

**修复后验证（全部亲自跑）**：
- `node verify.mjs` ⇒ **42/42 套件、1238 通过 / 0 失败 / 8 跳过**
- `node manifest.mjs --check` ⇒ **761 文件、0 漂移 / 0 缺失**
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

## 5. 给你的行动建议

**可以立刻用的**：把 `cfb` 当插件部署（`dryRun:true` 起步，跑金丝雀观察）。六道门 + 无损回退 + 自测体系是可信的，最坏情况就是"没压缩，原文照过"。

**不要信的**：
- 任何基于 `v5-micro-weights.json` 的 `architecture` 字段做的资源估算
- 任何"微模型已泛化"的声称（`accepted:false`）
- 理论卷里的数字（除卷五 S8 / 卷六 S10 两处实测外，其余是推导）

**要解锁天花板，只有一条路**：搞到 DeepSeek-V4.1-Flash 端点跑 E1/E2。**没有端点，这条线就停在这里**——不是能力问题，是物理上缺一个测量。仓库对此的判断（"未测就是未测，不判读、不调模型、不加语料"）是正确的，不该被绕过。

---

*报告生成：2026-10-07 · 全部读数均为本轮实测 · 修复提交 `0132a2c` / `c63d579` / `c1a258b`*
