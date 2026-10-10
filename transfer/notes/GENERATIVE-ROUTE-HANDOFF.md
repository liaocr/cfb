
# 对话记录 · 生成式压缩微模型路线（交接文档）

- 写入时间：本轮会话（记忆压缩前）
- 写入者：AI 审计 agent
- 仓库：https://github.com/liaocr/cfb （本地 D:/cfb，分支 main，HEAD 5b01250）
- 用途：**防止记忆压缩丢失上下文**。下一轮接手（人或 AI）请先完整读本文件，再读 transfer/notes/SCAN-REPORT-v4.md。

## 读我须知：证据分级

本文所有数字都带标记，请勿混用：

- ✅ = 我本轮**亲手跑出来或亲手读文件读到**的
- ⚠️ = **来自仓库文档/报告的自述**，未经我独立复现，按用户要求一律存疑
- ❌ = 我**曾经断言、后来被用户纠正或自己推翻**的（保留在此，防止重犯）

用户核心认识论指令（原话）：**"你要带着审视的视角"**、**"你要带着审视的视角"**（对全部文档数字）。不要拿文档叙述当证据。

---

## 1. 用户指令的演化（原话，按时间序）

1. "你好，我的仓库是 https://github.com/liaocr/cfb，请你拉取并全面扫描理解"
2. "因为我这个仓库几经ai转手，他现在已经破烂不堪，十分混乱，我要求你全面扫描后，向我汇报"
3. "全面修理，一次性跑完" —— 并要求我**亲自读完所有 .md**、独立重新推理，把架构分成**恰好四桶**：
   可信可使用 / 待审查 / 不可使用但修一修能用 / 不可使用修理后也不行完全废弃
4. **更正一**："不不不，你现在完全错了，你觉得他本地几秒能跑一个模型？不可能！这个js完全是在乱搞…第一版训练的完全是过拟合机器…还有自称 60,854,837 参数，那是kaggle上训练的…你要带着审视的视角"
5. **更正二（重大改向）**："滚蛋！我是怎么养你做审计的？你读完文档不知道只有生成式的才有出路吗？不要去有任何动作，你先和我对话"
6. 明确**拒绝** deploy/kaggle/train_gen.py（"没用的、冗余的包袱太多"）；train_micro.py 路线对，但"我不认可现在可以"。
7. **最终裁决**：**从 0 训练一个通用压缩器** —— 输入任意 CoT，输出压缩稿。
8. **尺子的定义（关键）**："我们要自己找出什么样的压缩稿是好的…找出一个科学的可量化成标准的尺子…金标其实不是尺子，金标是一段确定的很好稿子，而把金标里面那种好的共性品质提炼成科学可量化的标尺，这个才是尺子"
9. **范围收缩**："我们目前没有那么远大…我只要不退步就行，先训练出来一个，我等不及了" / "我快到deadline了"
10. **交付物**："哪怕效果一般的通用面对任何思维链都可以的压缩微模型"
11. **数据策略**："之前的数据能用就用，要新的就想办法自己按照最小成本造"
12. **本轮指令**："你先做清点，把能用的数据，能用的工具，能用的一切都整理出来"

---

## 2. 硬约束（已裁决，不可回退）

### 2.1 抽取式全废

用户：**"只有生成式的才有出路"**。以下路线**全部废弃**，不要再提：

- ❌ src/compile-v5-local.js（生产本地微编译器）
- ❌ transfer/models/v5-micro-weights.json 的 1,042 权重符号打分器
- ❌ tools/train-v5-micro.mjs（本地纯 JS 训练器）
- ❌ 我的"保留率闸门（100% 锚点必留）"
- ❌ 我的"把 97M 教师蒸馏进 1,042 符号权重"的想法

**用户的机理（务必理解）**：抽取式**只能选/排序/重排，永远不能"改写"**。CoT 的冗余存在于**探索过程**里，而抽取式**不敢删**，因为删了就丢掉"承重标识符"。所以抽取式训练"只能训练出来过拟合数据的东西"。

### 2.2 "不劣于原稿"是**回归集**，不是科学公理

用户：**"没有证明吗？没有，但他就是平均不弱"**。
机制：跑批次 → 找出比原稿更差的稿子 → 归因 → 修复 → **该案例永久留在集合里** → 集合只增不减 → "平均不弱"变成可测的量。

### 2.3 用户的迭代飞轮

**"当前稿子去测试，看哪里不行，科学归因，找到原因后，修改成新稿，这是一次流程"**
每轮自然产出 (坏稿, 好稿) 对；**归因步骤本身就是天然的质量判据**。用户自认这个飞轮低效。

### 2.4 反捷径目标

**"抄不动背不动拟合不动，只能被迫模仿内涵"**（来自早前 Kaggle 训练，方法已失传）。
可表达为尺子必须拒绝的三类负样本：**照抄稿 / 训练集内稿 / 表面流畅但改事实的稿**。

### 2.5 尺子 = 两层

用户 Q1 答复：**硬布尔闸门 + 软排序分**，两层。
用户 Q5 答复：**质量与压缩率不正交** —— 性能优先，"同等质量下更短"是**软**判据。

### 2.6 ✅ 不从 0 训练（2026-10-10 裁决）

用户："**你说真的从0开始，是不是真的有点不必要了，我们其实可以找一个有基础语言底座的微小模型，不要从0开始训练了**"

⇒ 路线改为：**在预训练小底座上做 SFT / LoRA**。此前"从 0 训一个通用压缩器"的方案作废。

用户同时指出的成本约束："**你其实也要花钱，花我 api 费用**" ⇒ 任何需要我/subagent 生成数据的方案，**必须批处理摊薄**，不能一条一调。

用户对原料规模的意见："**可以吧，但是不是有点太多了**" ⇒ 不要 21 GB 级公开集，用小而精切片。

### 2.7 安全来自闸门，不来自模型

微模型只买**接受率/省 token**；六道收网门 + 100% 无损回退到 raw，保证**永不劣于 raw**。这是整个架构的安全底座。

---

## 3. 我犯的错（审计校准表，防止重犯）

| # | 我的错误断言 | 纠正来源 | 真相 | 教训 |
|---|---|---|---|---|
| 1 | "本机已能训练出微模型，不需要 GPU、不需要 Kaggle" | 用户："这个js完全是在乱搞" | 退出码 0 + 打印了看似合理的数字 ≠ 实验成功 | **"脚本跑通了"不等于"实验成功了"** |
| 2 | 把 60,854,837 参数称为"虚构" | 用户："那是kaggle上训练的" | ✅ 真实存在。git log -S 60854837 → commit b3d5c59 "feat(micro-65m): train <0.1B (0.0609B) CFB-Micro-65M model & export ONNX (Tesla T4 x2)" (2026-10-04T06:12:47Z) | 数字真实，但**放错了文件** |
| 3 | "权重从未导出" | 我自己复核 | 97M 那次**真跑了**：release 资产 cfb-micro-97m-multilingual.int8.onnx，**98,742,284 bytes**，digest sha256:84947d95…，与报告 fullOnnxBytes 逐字节吻合 | 先查 release，再下结论 |
| 4 | "三折全部干净通过，均值 0.9032" | 我自己复核 | ❌ 那是 accuracy 头条数。预注册用的是 **lengthMatchedAccuracy**：flaky-timeout 75.8% vs 需 ≥92.7% ⇒ **FAIL**；门3 min=0.6907 ≥0.70 ⇒ **FAIL**。**单元头没通过** | 必须读**预注册里指定的那个指标**，不是头条指标 |
| 5 | "06g 折报告从未提交" | 我自己复核 | 存在 | — |
| 6 | "06c 候选权重过不了 schema" | 我自己复核 | 能正常加载 | — |
| 7 | 把"生产微编译器"放进第 1 桶（可信可使用） | 用户改向 | **我最大的审计失败**：我只回答了"这东西坏没坏"，从没回答"这条路能不能到目标" | 审计必须问**可达性**，不只是**完好性** |

### 3.1 我实测出的、支撑用户判断的硬证据

- ✅ 在真实 micro-dev-dataset.json 542 单元上：多数类 24.9% / 生产未训练权重 **32.7%** / "训练"后权重 **29.7%** ⇒ **-2.95pp**（训练**有害**）
- ✅ 预测坍缩：MECHANISM 380/542 (70%)，EXCLUDED 0，OPEN 0
- ✅ 在原始启发式标签上，一条单行规则 (len>=18 && anchors>=2) 得 **85.1%**，而"训练"出的模型只有 63.7%
- ✅ src/ 里 onnx 引用数 = **0**；onnxruntime = **0**；cfb-micro-neural = **0** ⇒ 97M 模型**运行时根本不加载**
- ✅ 三折的 trainingDataFingerprint **完全相同** (56a211c27cec8eead5176baf2de184ebcb18324ebf33a211615ee2e6ccb5e38a) ⇒ **三折不是独立的**；fold-sse-truncated 的 validationUnitFractionActual=0.6022（目标 20%）⇒ 近乎退化
- ✅ micro-dev-dataset.json 当前 sha256 = 366045ef8ce7e88e5db121ef19bf08c4b3eca9a833bf6dc8c3f8f252a5a6bca7，与**两个** review 文件都不匹配。按摘要：blind-v3 覆盖 348/542=64.2%，另两个 8.5% / 0% ⇒ **194 单元 (35.8%) 从未被审**
- ✅ tools/build-micro-dataset.mjs:1030 的 reviewStatus 是**硬编码字面量**，不读任何 review 文件
- ✅ tools/train-v5-micro.mjs:36-60 的 labelUnitByGoldSlots = 手写正则 + 手写 yVal 常数（1.0/0.88/0.85/0.80/0.92/0.82/0.80/0.75/0.55/0.05）⇒ **实测有害，勿用**

---

## 4. 清点结果

### 4.1 仓库规模 ✅

- 总计 **1,677 文件 / 127.22 MB**
- src/ 24 模块；tools/ 61 脚本（29 helpers）；test/ 43 套件；docs/ 30 个 .md
- package.json 24 个 script；**dependencies: {}**（零第三方依赖，纯 Node ESM）
- 最大目录：transfer/models **98.42 MB**（110 文件）

### 4.2 ★ 可用的生成式数据（这是清点的核心产出）

#### (A) v5 生成式语料 —— 6001 train / 139 dev

位置：transfer/models/micro-generator-gen-v5/

- train.jsonl.gz ✅ 解压实测 **6001 行**；dev.jsonl.gz 139 行
- 由 tools/micro-generator/merge-corpora.py 合并 4 个源：gen-v3 (937) + batch3 (844) + batch4 (2491) + batch5 (3985)
- provenance trainAdded 合计 5914（去重后 6001）
- 字段：unitId, repo, license, rawChars, targetChars, ratio, axes, axesAllPass, failedAxes, **messages**, teacherMeta
- messages = [system, user, assistant]，**标准 SFT 格式**
- system 提示词（原文）："You are the CFB birth-compressor. You receive the CONTEXT visible at the moment a model produced a long reasoning block (RAW), and you output the compressed version of that block."
- user = "【CONTEXT】\n[task]\n…" + raw
- ⚠️ train.medianRatio = 0.4146；⚠️ 各源 medianRatio ≈ 0.4129–0.4149

#### (B) ★★★ 但见第 5 节：这个语料的"教师"是**规则抽取器**，不是生成模型

#### (C) 飞轮偏好对

.cfb-offline/train/pairs.jsonl ✅ **93 行 / 1229 KB**，schema cfb.flywheel-pair/1
字段：schema, at, round, task, split, source, chosenArm, rejectedArm, chosenText, rejectedText, contentAudit, scores
样本：round:16, task:"flaky-timeout", split:"dev", chosenArm:"raw", rejectedArm:"hand", chosenText 7,447 字符, rejectedText 1,562 字符, scores:{candidate:93, control:92}
⚠️ **注意 chosenArm 常常是 "raw"** ⇒ 在这些轮次里 **raw 打败了压缩稿**

#### (D) SFT 导出集

.cfb-offline/train/export/ ✅
- train.jsonl **17 行 / 227 KB**（messages 格式，实测第 0 条：user 7924 字符，assistant 1236 字符）
- test.jsonl **53 行 / 504 KB**（同格式）
- selection.jsonl **27 行 / 482 KB**（{prompt, chosen, rejected} role/content 数组）
- split.json 8 KB（assignment: sha256 -> train/test/selection）

#### (E) 原始 CoT 供给（尚未量化，待办）

- transfer/models/micro-generator-v4flash-scenarios/birth-units-census-batch1..5.jsonl.gz ✅ 存在，解压前 359KB / 3048KB / 2788KB / 6923KB / 10695KB（**最大的一块原始 CoT 矿**）
- transfer/traj3/, .cfb-runtime/traj/ (746 文件 / 11.62 MB), transfer/recordings.json (0.68 MB)
- ⚠️ **待办：统计到底有多少条真实 raw CoT、多少字符、什么分布**

#### (F) 其它语料资产

- micro-generator-forge/：forge-drafts-batch0/1/2.jsonl、forge-negatives.jsonl (54KB)、forge-line-baseline.jsonl (199KB)、forge-ruler-corpus.manifest.json、forge-scores-batch*
- micro-generator-ai-reviewed-dev-candidates.jsonl (248KB) + dispositions.jsonl (17KB) + workbook.xlsx
- micro-generator-fact-draft-suggestions.jsonl (254KB)
- micro-generator-review-queue.jsonl (218KB)
- micro-generator-open-swe-seed/：annotations.jsonl (55KB)、family-splits.json、source-manifest.jsonl
- micro-generator-gen-v3/tokenizer-zh-seed.txt (426KB)

### 4.3 可用的工具 ✅

- **tools/gold-vs-line.mjs** —— 现成的生产本地路径 harness。LOCAL_POLICY 里 compressLocalModel:true, continuationPath:'bounded', programParts:'compact'；输出 .cfb-offline/ruler/gold-vs-line.json
- **tools/helpers/hand-draft.mjs** —— handDraftGate() 在 143 行；只查 invented-triple / invented-decision / ungrounded:<slot>，**全是"别加"，没有一条"别丢"**（这是 75.3% 保留率的根因）。另导出 slotsOf / anchorsOf / draftDistance / hasFixIntentIn / stripSlotLead / HAND_PROTOCOL
- **tools/micro-generator/teach-shape.mjs** —— 教师 v0.3（**纯规则，零 API，见第 5 节**）
- **tools/micro-generator/forge-birth-units.mjs** —— 提供 scoreBirthDraft（生产判据的逐字副本）
- **tools/micro-generator/merge-corpora.py** —— 语料合并器
- tools/kaggle-train-micro.py、tools/micro-selection-benchmark.py、tools/micro_cv.py、tools/prepare-micro-generator-data.mjs、tools/collect-micro-folds.py、tools/eval-micro-js-pairs.mjs
- verify.mjs / manifest.mjs / tools/doc-watermark.mjs
- tools/kaggle-train-micro.py 默认值（⚠️ 自述）：--draft-every 3, --pref-lr 5e-4, --epochs-sft 12, --epochs-simpo 12, --student-epochs 260, --micro-mlp-hidden 96

### 4.4 环境 ✅（2026-10-10 全面更正）

**⚠️ 本节此前写错三条，已更正。教训：curl 的 TLS 失败 ≠ 没有网络。**

| 项 | 旧（错） | 新（实测） |
|---|---|---|
| 网络 | "pwsh 无外网，只有 harness 有网" | ❌ **错**。curl 对 huggingface.co/raw.githubusercontent 返回 000/35（TLS 被拦），但 **python urllib 直连全部 200**：hf-mirror.com ✅ / raw.githubusercontent.com ✅ / pypi.org ✅；curl 对 github.com、pypi.org、export.arxiv.org、www.kaggle.com 也 200。**本机能下载数据、能装包、能 push** |
| 训练平台 | "本机没 torch ⇒ 必须去 Kaggle" | ❌ **前提不成立**。pypi 可达，torch 2.14.1+cpu 已实测装上（后又按用户指示卸载）。但**本机确实不适合训练**，见下 |
| git | "7 个 commit 没推" | ❌ 实为**分叉**：origin/main 曾到 a676a8c5，本地 5b01250，rev-list = 7/0。**2026-10-10 已 push 成功**（a676a8c..5b01250），现 0/0 同步 |

**硬件（硬约束，绕不过）**

- CPU：**Intel Core i5-8250U @1.60GHz，4 核 8 线程**（2017 超极本）
- GPU：**Intel UHD Graphics 620 集显 1GB —— 无 NVIDIA、无 CUDA**
- 磁盘：C: 可用 15.7 GB / 77.9 GB；D: 可用 173.2 GB / 215.1 GB
- ⇒ 本机训不动像样的模型，**训练必须去 Kaggle**（用户已确认有 Kaggle 空间）

**凭据：全空（2026-10-10 实测）**

- DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / OPENAI_API_KEY / HF_TOKEN / KAGGLE_USERNAME / KAGGLE_KEY **全部未设置**
- 仓库内无 .env；用户目录无 .kaggle/kaggle.json；`kaggle` CLI 未安装
- ⇒ **当前没有任何"教师 LLM"通路，也没有 Kaggle 上传通路**。这两条是造数据的瓶颈

**其它**

- Windows；**无 bash**；python 3.12.8 + numpy 2.5.2
- 文件策略 danger-full-access；**审批提示已禁用** ⇒ 永远不要设 sandbox_permissions
- run_code 是唯一可直接调用的工具；只能用可擦除语法（无 enum）
- 控制台是 GBK：python 打印中文/emoji 会 UnicodeEncodeError ⇒ **一律写 UTF-8 文件再用 read 工具读**
### 4.5 已知天花板（仓库自认，我复核为真）⚠️

- E1/E2 从未在真实 DeepSeek-V4.1-Flash 上测过
- dataset-policy.json: currentDecision = target-model-compatible-data-not-yet-admitted, trainingReady=false
- 微模型 accepted:false / promoted:false
- rulerValidity: suspect (n=304)
- gold 覆盖 36/40
- ✅ **尺子的可评目标极小**：13 个 gold item 里只有 **4** 个带 gold 章（9 个是 not-gold）；goldBenchOk 只接受 {gold, provisional-gold} ⇒ 只有 4 个可评
- 9 个失败轴分布：M8 落点唯一 x6, E1 x6, R1 x5, R2 x5, M4 x3, M3 x1, E2 x1。R1/R2/E1 都要求真机 results.jsonl

### 4.6 gold 集 ✅

- transfer/gold：14 文件（13 item + README），只有 **4** 个带 gold 章
- transfer/gold-rejected：14 文件 = **11 item** + README/audit/audit-amendments
- ⚠️ **待验证假设**：gold-rejected 可能就是"压缩稿不如原稿"的案例集 = **现成的回归集**
- 注册表：13 item / 4 family（eacces-config 3, perf-regression 1, sse-truncated 5, wrong-model 4），全部 validated=true, qualityAudit.status=clean

### 4.7 当前生产本地路径实测（路线已废，留作参照）✅

node tools/gold-vs-line.mjs 跑 13 个 gold：G1 12/13, G2 13/13, mean ratio **0.5153**（省 48.5%）, 18.7 ms/item, $0
但**承重标识符保留率只有 201/267 = 75.3%**（丢 66 个）；最差 sse-truncated-s0-r4 **3/15 = 20%**
根因：handDraftGate 只禁"加"，从不禁"丢"

### 4.8 验证基线（我修复后）✅

- node verify.mjs ⇒ **43/43 套件, 1252 pass / 0 fail / 8 skip**
- node manifest.mjs --check ⇒ 764 文件, 0 drift / 0 missing
- node tools/doc-watermark.mjs --check ⇒ check passed
- Windows 与 Linux 隔离回执 (1242/0/1) 的差额是平台守卫，不是回归

---

## 5. ★★★ 决定性发现：v5"生成式"语料的教师是**规则抽取器**

**这是本轮最重要的发现，直接冲击"从 0 训练生成式压缩器"的数据前提。**

### 证据一：teach-shape.mjs 自述（第 1–15 行原文）

    // teach-shape.mjs —— 教师 v0.3：把「只看稿子就能判」的尺子装进目标生成器。
    //
    // 尺子集合（= GOLD-STANDARD 里的 draft-only 轴，E1/E2/R1/R2/M2 全部剔除）：
    //   M1 压缩力度 <=0.60 · M3 闭合判读 · M4 可执行验收 · M5 接地精度
    //   M6 无装置话术 · M7 决策不变 G2 · M8 落点唯一
    // 生成规则（全部机械、零 API、零训练）：
    //   1) 从 raw 抽「信息句」：判定行｜命令｜围栏代码｜路径｜强结论句｜带在手引用的非探索句；
    //   2) 过滤会顶掉形状轴的句子：旁白／改法词行／菜单词／装置话术／含「验收·看到」等标记词；
    //   3) 组装：在手要点 + 唯一落点行 + 验收行；
    //   4) 预算：总量 <=0.60xraw（关键锚点句必留，超预算则丢弃低优先句并如实记账）；
    //   5) 产出前用 scoreBirthDraft（= 生产判据的逐字副本）自检，报每轴通过率。
    //
    // 诚实边界：教师 = 尺子的执行器。学生学的是"尺子定义的好形状"，因此之后再用同一把尺子
    // 量学生 = 同源测量（能量出学没学到形状），**不构成对尺子本身的验证**；E1/E2 仍是唯一外部终验。

### 证据二：代码里**没有任何** LLM/fetch/api 调用 ✅

对 teach-shape.mjs 搜索 fetch\(|api|openai|a6api|model:|LLM ⇒ **0 命中**。

### 证据三：语料产物确实是"抽句子拼装" ✅

实测 v5 train.jsonl.gz 第 1 条的 assistant 输出（1068 字符）开头：

    在手要点：also consider: what if the content type is something like application/vnd.api+json?
    also make sure that the base64 encoding/decoding is correct by checking that the body can be round-tripped through the API Gateway response format.
    All edge case tests pass.
    The issue mentions that the library should check Content-Encoding header.
    This contains "json" but doesn't start with "application/json".
    But with my change, if it also has Content-Encoding: gzip, it would still be treated as binary (which is correct).
    What about text/event-stream?
    ...

这是**逐句摘出来的原句**，加了一个"在手要点："前缀 —— 正是抽取式。

### 证据四：语料报告自己承认同源

micro-generator-gen-v5/corpus-report.json 里（teach-shape.mjs:447）：
"the teacher executes the same rulers it is scored with ⇒ later student numbers are same-source measurements of shape acquisition"

### 结论与影响

1. 这 6001 行**不是"生成式"语料**，它是**一个规则执行器的输出**。
2. 用它训练 = **让学生学那条规则** = 抽取式换了个马甲。用户说"抽取式只能训练出过拟合数据的东西"，正是这个。
3. 教师被"与评分同一把尺子"约束 ⇒ 语料 100% 过轴（axesAllPass 6001/6001）⇒ **零负样本、零信息量**：一个 100% 通过的训练集不教任何判别力。
4. 因此 **v5 语料不能直接当作"从 0 训练生成式压缩器"的训练集**。要么改造，要么另造。
5. 这也解释了为什么 train_nonconforming 单独存在（axesAllPass=0 的那批），但 medianRatio 0.65 且 overBudget —— 它们是被"预算"刷下来的，不是语义负样本。

### 这与我此前"生成式路线可行"的判断的关系

我此前把"teach-shape.mjs -> messages SFT 格式语料"当成生成式路线的**数据基础**。**该判断需要降级**：格式是 SFT 的，**教师不是生成的**。这是我在这条路线上的第 8 个错误（见第 3 节表）。

---

## 6. 未决问题（2026-10-10 更新：2/3/9 已裁决）

1. **v5 语料的处置**：废弃？改造（补负样本）？还是仅用作"形状先验"预训练？
2. ✅ **已裁决 —— 教师从哪来**：用户明确"你其实也要花钱，花我 api 费用"。⇒ 教师 = 我/subagent 生成，但**必须批处理摊薄成本**（一次 prompt 压 N 条）。零 API key 通路已确认不存在。
3. ✅ **已裁决 —— 不从 0 训**：用户"从0开始，是不是真的有点不必要了，我们其实可以找一个有基础语言底座的微小模型"。⇒ **改为在预训练小底座上做 SFT/LoRA**。
4. **gold-rejected 是不是现成的回归集**（11 item）—— 未验证。
5. **原始 raw CoT 到底有多少**（census batch1-5 + traj + recordings.json）—— 未量化。
6. **train_micro.py 的 24k 词表**是预建还是每次训练 —— 未确认。
7. **生成式尺子怎么设计**（不能含抽取式元素）—— 未设计。
8. **5b01250 的处置**：该 commit 是我建的 MICRO-MODEL-PLAN.md，**整个建立在已废弃的抽取式前提上**，文件仍在，未改。
9. ✅ **已裁决 —— 推送**：用户"本地 7 个 commit 直接推"。**2026-10-10 已推送成功**。

### 6.1 2026-10-10 新增未决

10. ✅ **已裁决（2026-10-10，用户授权我定）—— 底座 = `fla-hub/rwkv7-0.1B-g1`（191M）**，备胎 `Qwen/Qwen2.5-0.5B-Instruct`。用户原话："0.6b 是不是太大了，我们之前也实测过，0.6b 中 80% 都是我们完全用不到的……现在选择权在你"。⇒ **Qwen3-0.6B 出局**。裁决依据与实测证据见 §10.6。
11. **Kaggle 通路怎么建**：无 CLI、无凭据。需要用户提供 kaggle.json，或用户手动上传 notebook。
12. **原料规模**：用户说"可以吧，但是不是有点太多了"。⇒ 不要 21 GB 的 big-reasoning-traces，改用小而精的切片。


## 7. 我提出、用户尚未裁决的加速方案

- **(A) 把归因批处理**：按失败类型聚类，人只看簇心
- **(B) 主动制造退化样本**来"构造"尺子而不是"归纳"尺子：删一个决策 / 编一个事实 / 打乱因果 / 过度压缩 / 原样照抄 —— 每条退化轴直接变成一条判据，绕开 13 项循环论证风险
- **(C) 把"抄不动背不动拟合不动"落成三类强制拒绝的负样本**：照抄稿 / 训练集内稿 / 表面流畅但改事实的稿
- **自举数据方案**：先训一个很差的 v0 → 本地 $0 推理跑遍全部 raw → 用回归集过滤 → 得到新训练材料 → 再训

---

## 8. 本轮我改动过的文件

- transfer/notes/SCAN-REPORT-v4.md —— 大幅重写（554 行），第 5 节含 4 处自我更正，页脚声称 7 处自我更正
- transfer/notes/MICRO-MODEL-PLAN.md —— 我新建（commit 5b01250），**前提已被推翻，文件仍在，处置未定**
- src/compile-v5-local.js —— 改过 PRODUCTION_WEIGHTS_RE 上方的注释（**整个模块已废**）
- test/micro-runtime.selftest.mjs —— 改过断言措辞（29 条断言）
- transfer/models/v5-micro-weights.json —— 我早前删掉的 architecture 块（删除理由错了，但该块确实是放错的元数据）
- deploy/kaggle/train_gen.py —— 早前改过 corpus 默认 v3->v5（**用户已拒绝该脚本**）
- .cfb-offline/ruler/gold-vs-line.json —— 我的 harness 跑出过仅时间戳变化，已 git checkout -- 回滚

## 9. 环境事实备忘

- HEAD = 5b01250（**2026-10-10 已 push 到 origin/main**，现本地与远端 0/0 同步）；此前 777b255, 750e231, 0e20de8, c1a258b, c63d579, 0132a2c
- Kaggle 的 start.py 从 raw.githubusercontent.com/liaocr/cfb/main 拉取；train_gen.py 是 git clone main ⇒ **本地 commit 对 Kaggle 不可见，除非 push**
- .cfb-offline/ 在 .gitignore:42，但 gold-vs-line.json 被跟踪（既有异常）
- 测试契约：每个 test/*.selftest.mjs 独立进程；状态 = (code===0 && fail===0) ? PASS : FAIL
- 两个第 4 桶（完全废弃）：transfer/probes-2026-10-07/（15 文件、44 处硬编码 /home/user/、2 个脚本用未播种 Math.random，不可复现）；transfer/models/cfb-micro-final-test-ledger.json（单条 case-fold-collision，status: evaluated-below-90-percent-gates，**绝不能再跑来刷分**）

---

## 10. 2026-10-10 追加：外部检索 + 用户指定的 9 个链接

### 10.1 学术现状（arXiv 实测，非文档自述）

| 论文 | 一句话 | 对我们的用处 |
|---|---|---|
| **2609.36526 PAIR** | 用**反事实续跑**（同一 agent 状态，有/无压缩各跑一次）定位"哪一次压缩损害了后续执行"，再改压缩模板 | ★★★ **用户"归因飞轮"的学术版**，且给出了把归因做干净的方法（隔离单次压缩、消除 agent 随机性） |
| **2605.08776 MPD** | 观察到大模型解同题时 trace 更简洁 ⇒ 把"简洁"作为**行为**从大教师蒸馏给小模型，而非用长度约束硬压 | ★★★ "训练压缩器"的正统做法 |
| **2609.29875 ICLR** | 长程 agent 何时可安全遗忘推理（保留 actions/tool calls/observations） | ★★ 闸门设计参考 |
| **2609.31430 ACD/LOHA** | 老 observation 压成 soft token，agent 自己的 turn 与最近 K 条 observation 保留为文本 | ★★ "承重信息不压"的分层思路 |
| 2609.32852 ARSM / 2609.37590 FOCUS / 2609.27298 StateComp / 2609.27276 DRSR | 训练-free 或学习式的历史压缩/删除风险 | ★ |
| 2604.03679 LightThinker++ | 中间思考压成紧凑语义表示；峰值 token -70% | ★ |
| 2608.31066 MIST | 用模型内部残差流显著性选 token | ★（抽取式，路线已废） |

### 10.2 公开模型/数据集：找到候选，但**实测全部不可用**

| 候选 | 实测结论 |
|---|---|
| `homerquan/mn-context-compression-dataset-v1` | 151,515 条预算条件化压缩 SFT + 偏好对，形态最同构（target_tokens + protected fact ledger）。❌ **实测坏**：按字节偏移抽 4 条，response 全退化成 `evidence: 1 - 2 - 3 … 538 - EXPRESSION of` 原样倒账本 |
| `mithulaartigala/reasoning-summarizer-qwen3.5-0.8b-preview` | ❌ 输出 JSON 元数据（title/sub_title/summary/cur_task），不是可续读的压缩正文 |
| `Qyrou/reasoning-summaries-61k`（上者训练数据） | ❌ 401 gated |
| `zeju-0727/SFT_cot_compression` | ❌ 是 mask_thinking token 标记，不是配对压缩 |
| `allenai/big-reasoning-traces` | ⚠️ 676,665 条 / 21.2 GB，**只有 raw 无压缩配对** |
| `lambda/hermes-agent-reasoning-traces` | ⚠️ 14,701 条真实 agent 轨迹（think 块 + 工具结果），只有 raw |
| `XXMiner/soma-cot-compression` | ⚠️ 只有报告 json，无权重 |

**⇒ 结论：公开集里不存在可用的 (任意 CoT → 压缩稿) 配对。必须自己造。**

### 10.3 用户指定的 9 个链接 —— 逐条核实

| # | 链接 | 核实结果 | 判定 |
|---|---|---|---|
| 1 | cloud.tencent.com/.../2625378 | **OpenDoc-0.1B**（复旦，0.1B，OmniDocBench v1.5 90.57%），讲的是**文档解析/OCR** | 与 CoT 压缩**无关**；是"0.1B 也能干大事"的**存在性证明** |
| 2 | modelscope topdktu/unirec-0.1b | **UniRec-0.1B**，架构 `VLMOCRForConditionalGenerationNew`，是**视觉 OCR 模型** | **无关**（同 1 的姊妹项目） |
| 3 | lyxyxyxlx/LLM-From-Scratch-0.1B | 0.1B LLaMA-style 中文，15k 词表，hidden 768 / 12 层 / GQA，权重 188MB，MIT。**4 star，个人项目** | ⚠️ 可作底座但质量存疑 |
| 4 | HF fla-hub/rwkv7-0.1B-g1 | **191M，RWKV7，多语(en/zh/ja/ko/fr/ar/es/pt)，词表 65,536，训练 5T+ token(World v3.5)，原生 enable_thinking，Apache-2.0** | ★★★ **已选为底座**（见 §10.6）。"Kaggle 有风险"已部分排除：`flash-linear-attention` **在 PyPI 上有 0.5.2**，不需要 git 安装 |
| 5 | charent/ChatLM-mini-Chinese | **0.2B T5 编解码**，1736 star，数据/清洗/tokenizer/预训练/SFT/DPO 全开源，ModelScope 可达 | ★★ **形态最贴合"改写"任务**（seq2seq）；但 2024 老模型、中文单语 |
| 6 | zhihu p/2066564289712894830 | **403 Forbidden，取不到** | — |
| 7 | jingyaogong/minimind | **63,453 star**。minimind-3 = **64M**，架构对齐 Qwen3，全链路（Pretrain/SFT/LoRA/DPO/PPO/GRPO/CISPO/ToolUse/AgenticRL/蒸馏），tokenizer 支持 `<think>`，单卡 3090 跑 1 epoch SFT 约 2 小时 | ★★ 生态最成熟、最便宜；但 64M 中文能力弱 |
| 8 | huangxiaoye6/LLM-tuning | **Qwen3-0.6B** 的 LoRA / P-tuning / 增量预训练 / GPTQ/AWQ 教程 | ★★ **微调配方参考**（正好用 Qwen3-0.6B） |
| 9 | Tongyun1/from-minimind-to-more | minimind 深度教材（Tokenizer/架构/PreTrain/SFT/DPO/PPO/GRPO/SPO 源码解析） | ★ 学习材料 |

### 10.4 底座候选实测可用性（hf-mirror）

| 模型 | 下载量 | likes | 权重 |
|---|---|---|---|
| **Qwen/Qwen3-0.6B** | **30,889,504** | 1761 | model.safetensors |
| Qwen/Qwen3-1.7B | 3,269,803 | 567 | 2 shards |
| Qwen/Qwen2.5-0.5B | 1,424,114 | 464 | model.safetensors |
| Qwen/Qwen3-0.6B-Base | 718,776 | 202 | model.safetensors |
| google/gemma-3-270m-it | 79,528 | 659 | model.safetensors |
| fla-hub/rwkv7-0.1B-g1 | 1,838 | 6 | model.safetensors |
| jingyaogong/minimind-3 | 1,730 | 16 | model.safetensors |

### 10.5 由此确定的方向

1. **不从 0 训**，在预训练小底座上 SFT/LoRA（用户裁决）。
2. **底座 = `fla-hub/rwkv7-0.1B-g1`（191M）**，备胎 `Qwen/Qwen2.5-0.5B-Instruct`。Qwen3-0.6B 出局（用户：太大，80% 用不到）。理由见 §10.6。
3. **数据不从网上搬**（21 GB 太大且无配对）。改用：
   - **仓库自有、已付过费的真实配对**：`.cfb-offline/train/pairs.jsonl` 93 条偏好对 + `export/train.jsonl` 17 + `test.jsonl` 53 + `selection.jsonl` 27 ≈ **190 条**；
   - **我/subagent 批量生成**新配对（一次 prompt 压 N 条，摊薄成本）；
   - **主动制造退化样本**做负例（删决策/编事实/打乱因果/过度压缩/照抄）。
4. **训练放 Kaggle**（本机无 GPU）。**但 Kaggle 通路尚未建立**（无 CLI、无凭据）—— 这是当前最硬的堵点。

### 10.6 2026-10-10 底座裁决（实测证据，非文档自述）

#### (a) 读源码的直接结论 —— RWKV7 没有"纯 PyTorch 回退路径"

我下载了 `fla-hub/rwkv7-0.1B-g1` 的 `modeling_rwkv7.py`，**全文只有 157 字节 / 4 行**，内容是：

```python
from fla.models.rwkv7 import RWKV7ForCausalLM, RWKV7Model, RWKV7Config
```

⇒ 仓库里**没有**任何 CUDA 回退分支、没有 `try/except`、没有 triton 探测。全部实现都在外部 `fla` 包里。

**但是**：`flash-linear-attention` **在 PyPI 上存在（latest 0.5.2，requires_python >=3.10，另有等价包 `fla-core` 0.5.2）**。所以"必须 `pip install git+...`"这个风险不存在，普通 pip 即可。真正的剩余风险是 **Triton kernel 与 Kaggle 镜像里 torch/transformers 的版本兼容**，只能在 Kaggle 上跑一次才知道。

`config.json` 实测：

| 字段 | 值 |
|---|---|
| num_hidden_layers | 12 |
| hidden_size | 768 |
| intermediate_size | 3072 |
| vocab_size | 65536 |
| head_dim / num_heads | 64 / 32 |
| max_position_embeddings | 2048 |
| **tie_word_embeddings** | **false** |
| torch_dtype | **float32** |
| attn_mode | chunk |
| fuse_cross_entropy | true |

**参数结构的关键推论**：embedding + LM head = 2 × 65536 × 768 = **100.7M，占 191M 的 52.7%**。⇒ **真正可用的 transformer 容量只有约 90M**。这一点必须写进预期，不能拿 191M 当 191M 用。

#### (b) 三个候选的实测 config（hf-mirror）

| 模型 | 架构 | 词表 | hidden | 层 | 非 embedding 容量 | 上下文 | 结论 |
|---|---|---|---|---|---|---|---|
| **fla-hub/rwkv7-0.1B-g1** | rwkv7 | 65536 | 768 | 12 | **≈90M** | 2048 | **选中** |
| Qwen/Qwen2.5-0.5B-Instruct | qwen2 | 151936 | 896 | 24 | ≈358M | 32768 | 备胎（中文强、标准） |
| HuggingFaceTB/SmolLM2-360M-Instruct | llama | 49152 | 960 | 32 | ≈315M | 8192 | ❌ **英文中心，中文差** |
| google/gemma-3-270m-it | — | — | — | — | — | — | ❌ **config 返回 401 gated，无 HF_TOKEN，直接不可用** |

#### (c) 决定性的语言事实（我实测，不是猜的）

读 `.cfb-offline/train/export/train.jsonl`(17) 与 `test.jsonl`(53) 的 assistant 正文，**输出是"中文散文 + 英文标识符"**，例如：

> 第 7 轮已经把因与果定完，只欠一个动作没落地：`src/config.js` 那一行。原话就是 So the fix: revert compressTargetMax to 450……

⇒ **中文流畅度是硬要求**，这一条直接淘汰 SmolLM2-360M 和所有英文中心底座。

`pairs.jsonl` 93 条实测：chosenText 中文字符占比均值 **0.244**；长度中位 **1621** / p90 **2989** / max **7447**。
臂配对统计显示它**是成对偏好数据**：`('oracle-d2.json','compress-v4d5:ctx')` 7 对、`('oracle-d2b.json','compress-v4d5:ctx')` 4 对、`('compress-v4d7:mr','compress-v4d6:ctx')` 5 对……**以及 `('raw','hand')` 7 对 / `('hand','raw')` 6 对**（再次印证 raw 常常不输手写稿）。

#### (d) 为什么是 RWKV7 而不是 Qwen2.5-0.5B

1. **体积**：191M vs 494M。用户已明确否掉 0.6B。
2. **★ 本地可跑**：RWKV7 是线性注意力/循环结构，**推理是 O(1) 显存、O(n) 时间的 RNN**。用户本机是 **i5-8250U 4核8线程、Intel UHD 620 集显、无 CUDA**。一个 0.5B transformer 在 8k 上下文下本地 CPU 推理基本不可用；191M 的 RWKV7 可以。**这正是用户最开始那句"你觉得他本地几秒能跑一个模型？不可能！"的正解。**
3. **语言**：多语含 zh，World v3.5 5T+ token，词表 65536 对"中文 + 代码标识符"混合比中文单语词表好。
4. **原生 `enable_thinking`**，与我们处理的 CoT 域同构。
5. **长度够用**：实测 raw 中位 1621 字符 ≈ 1100 token < 2048。p90 2989 需靠 RWKV 的循环外推能力。

#### (e) 这条裁决里我**还没验证**的东西（不许当成已验证）

- fla 的 RWKV7 Triton kernel 在 Kaggle 镜像上能否一次跑通 —— **本机已按用户指令卸载 torch，无法本地验证**。⇒ Kaggle 第一步必须是 30 分钟内的 smoke test；失败就切 Qwen2.5-0.5B-Instruct。
- ≈90M 容量是否够做"任意 CoT → 压缩稿" —— 未验证。这是选小底座的代价，用户已表态"能力弱我们可以补"。
- `max_position_embeddings=2048` 的超长外推质量 —— 未验证。
