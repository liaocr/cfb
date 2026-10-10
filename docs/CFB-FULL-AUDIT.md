# CFB 全仓文档审计 · 总报告

> 写入时间：本轮会话 · 审计者：AI · 范围：仓库 D:\cfb 全部 .md（530 个文件 / 316 份唯一内容 / 1.7 MB）+ 判据代码
> 读法：**本报告只陈述事实与原文引用**。凡我未亲手复核的数字都标了来源与等级。
> 目的：用户要求「全读一遍，整理到一个文档」，终结反反复复。

---

## 〇、先给结论

**这个项目的全部问题可以归到一句话：**

> **「信息保真」在提示词里是硬规则（Never lose a fact），在判据里从来没有被实现过 —— 一条都没有。**

不是阈值定松了，是**根本没有这条判据**。三处落点全部只查「不许编」，没有一处查「不许丢」：

| 落点 | 查什么 | 不查什么 |
|---|---|---|
| 生产六道收网门 `src/birth.js` | 归档成功 · 编译非空 · **无发明标识符** · 字符净省 · token 下降 · 替换成功 | **一个字都没查「丢了什么」** |
| 金标 12 轴 `tools/helpers/gold-standard.mjs` | M5 接地精度 = 1.000（**精确率**） | **没有任何一轴是召回率** |
| 生成式尺子七道门 `tools/gen-ruler.mjs` | G1 凭空 · G2 落点 · G3 **路径布尔 / 标识符 0.5 地板** · G4 动手 · G5 因果 · G6 照抄 · G7 下架 | G3 的标识符分支是全仓**唯一**碰到「丢」的地方，而它是**软阈值** |

**最刺眼的一条（本轮新查实，代码级铁证）**：

`tools/helpers/gold-standard.mjs:153-155`

```js
const denom = localAnchors.length + cited.length
const prec = denom === 0 ? 1 : +(1 - (localAnchors.length + badCited.length) / denom).toFixed(4)
put('M5', prec, prec === 1, { ... note: denom === 0 ? '稿里没有需核实的符号/引用 ⇒ 无可核项' : ... })
```

⇒ **一份空稿：denom = 0 ⇒ prec = 1 ⇒ M5 满分通过。**

金标 12 轴里**唯一**那条保真轴，**空稿能拿满分**。这和 `KAGGLE-RWKV7-SMOKE-FINDINGS.md:238-249` 记录的那个 bug 是**同一个病**（当时空稿 89 条里过了 16 条 = 18%，补了 G0 才堵住）—— 补丁只补在生成式尺子上，**金标尺子这边一直没补**。

---

## 一、这个项目实际是什么

**不是**文档常说的「认知编译器」。实际是**两层东西**：

**第一层（生产，`src/` 24 个模块，零依赖）**
主模型每轮 reasoning 块**出生时**拦截，调副模型（DeepSeek-V4-Flash）压缩成短稿，过六道门后原位替换；任一不过 ⇒ **100% 无损回退原文**。
- 安全模型：**永不劣于原文**，靠回退保证，不是靠模型质量。
- 六道门**全是否定式/长度式**，没有一条要求「内容必须活下来」。
- `src/birth.js:618`：发明一个标识符 ⇒ **整份稿作废**（代价：9.6% 单元零压缩，为平均 5.7 字的改动）。这条是**布尔**的、**有效**的。

**第二层（微模型路线，本轮焦点）**
训一个 191M 的小模型（RWKV7）替代副模型，把「任意 CoT → 压缩稿」这件事本地化。
- 底座 `fla-hub/rwkv7-0.1B-g1`（191M，其中 embedding+LM head 占 100.7M = 52.7%，**可用容量仅 ≈90M**）。
- 学生已训出 v9 / v10 两版，**均未接进生产**（`src/` 里 grep 不到任何 rwkv 引用）。

---

## 二、全流程（7 步，③ 是唯一花钱处）

| 步 | 做什么 | 工具 | 规模 | 成本 |
|---|---|---|---|---|
| ① | 语料普查 | census | 10,558 行 | $0 |
| ② | 资格筛 | `tools/screen-raw-mine.mjs` | 10,558 → **4,687**（1,075 仓库） | $0 / 6.2s |
| ③ | **教师生成** | `.cfb-offline/teacher/batch.py` + DeepSeek-V4-Flash | **2,484 已完成（53%）** | **$1.11** |
| ④ | 建数据集 | `tools/build-sft.mjs` | **1,461 训 / 89 冻结 dev** | $0 |
| ⑤ | 训练 | `deploy/kaggle/start-rwkv7.py` · T4×2 | v10: 410 行 / 288 步 / 64 min | Kaggle 免费 |
| ⑥ | 生成 | `infer_rwkv7.py` | 89 条贪心 | Kaggle |
| ⑦ | 打分 | `tools/eval-sft.mjs` + `gen-ruler.mjs` | 学生 vs 教师配对 | $0 |
| ⑧ | **接进生产** | —— | **不存在** | —— |

---

## 三、★ 核心发现：被降级的不变量

### 3.1 信息保真：提示词里的硬规则 → 判据里的软分数

**硬规则原文**（`MICRO-GENERATOR-TRAINING-SYNTHESIS.md:24` 逐字引 `micro-format.py:20-26`）：

> keep every fact-bearing sentence verbatim — identifiers, file paths, numbers, verdict lines (test results) and commands must survive unchanged. Drop only hesitation, restatement and filler. Never invent an identifier that is not in CONTEXT or RAW. **Never lose a fact.**

**文档侧同一口径**（`MICRO-GENERATOR-TRAINING-SYNTHESIS.md:165`）：`M5 接地 = 1.000`；:244「锚点覆盖 1.0 由构造保证」。

**实际实现**：
- 金标 M5 = **精确率**（1 − 无据标识符/需核项），**空稿满分**（见 §〇）。
- 生成式 G3 = 路径布尔 + **标识符 `ANCHOR_FLOOR = 0.5`**。
- 生产六门 = **没有这条**。

### 3.2 `ANCHOR_FLOOR = 0.5` 的来历（代码注释原文，`tools/gen-ruler.mjs:101-110`）

```
// 承重**标识符**保留率下限（承重路径另算，一个都不许丢）。
// 实测依据（61 条真手稿，.cfb-offline/ruler/report-hand.json）：
//   标识符保留率 [min,q25,med,q75,max] = [0, 1, 1, 1, 1]，55/61 是满分 1.0，6 条是 0。
//   也就是**双峰**，中间没有样本：0.34 / 0.5 / 0.75 / 1.0 任何一条线，
//   影响的都是同样那 6 条。
// 所以这个常数不是敏感参数 —— 它落在两个峰之间的空谷里，这个事实本身就说明
// 「保留率」这个量在当前数据上是有判别力的，不是靠调阈值调出来的。
// 不设成 1.0 是留出余量：回归集一变大，中间地带必然会有人。
export const ANCHOR_FLOOR = 0.5
```

**这段论证的毛病**：它证明的是「这条线取多少都一样」，**恰恰因此它从来没有回答过「这条线应该是多少」**。
而 0.5 **低于教师均值 0.568** —— 门是照着教师的行为反推出来的，不是照着「什么算合格」定的。
用户口径是「把金标里**好的共性品质**提炼成标尺」；这里提炼的是**教师的平均行为，连它丢信息一起**。

### 3.3 同一门内的不一致

`tools/gen-ruler.mjs:581-582`（注释原文）：

> 路径 —— 失败陈述点到的那个文件就是这条 CoT 的承重结构，**一个都不许丢**；
> 标识符 —— 用保留率下限（丢一两个还是丢一片，是程度问题）。

**路径=布尔，标识符=程度。** 但文件路径和标识符在排障任务里是**同一类东西**（都是承重锚点），没有理由一个布尔一个 0.5。

### 3.4 生产侧同一个病，代价更大（`docs/RULER-V4-AND-G1-GUARD.md` §14）

`src/birth.js:618` `invented-identifier` ⇒ 整份稿作废。实测（722 条教师稿当代理）：

```
命中 G1 的单元           69 / 722 = 9.6%
生产现状：整份拒稿        69
改成"摘掉那处引用"后能压缩 63   （救回 91.3%）
摘除总字符               391   （平均每处 5.7 字）
```

**9.6% 的单元，为平均 5.7 字的改动被整份扔掉。** 该文档明确标注「**我没有动 `src/birth.js`，等指示**」—— 至今未动。

### 3.5 被降级的不变量 · 汇总表

| 不变量 | 声明出处 | 降级成 | 降级位置 |
|---|---|---|---|
| 信息保真 / 不许丢事实 | 提示词 `Never lose a fact`；M5 = 1.000 | **空稿满分 / 标识符 0.5 地板 / 生产无此门** | `gold-standard.mjs:154` · `gen-ruler.mjs:110` · `birth.js` |
| 压缩比 | 提示词写「目标 10%~20%」 | 教师实际 ~50%；尺子容忍 55% → 最终 `COMPRESSION_HARD_MAX = null`（**不设门**） | `gen-ruler.mjs:99` |
| 空稿必须判死 | 隐含 | 89 条里 16 条过门（18%）后才补 G0 | `gen-ruler.mjs:600-614` |
| 绝对 ≥90% 门槛 | `CFB-MICRO-READINESS-2026-10-04.md:7`「缺少任一门槛都不晋级」 | `KAGGLE-MICRO-RUN.md:55`「**不阻塞**」 | 两份文档直接冲突 |
| 飞轮 margin ≥0.05 | `HANDOFF-2026-10-06.md:19`「闸门不许放宽」 | 被计数尺度**平凡满足**（拿计数当判分） | `build-micro-dataset.mjs:684` |
| NOISE 负标签 | 默认 `slot=NOISE, yVal=0.05` 且 `trainingEligible=true` 进 SFT | 修成 `unknown`（**这是修复不是放宽**） | `MICRO-MODEL-TRAINING-ROOT-CAUSE:23,31` |
| R2 样本数 | n=1 曾被写成 `provisional` | 统一改 `not-gold`（**方向相反：收紧**） | `AUDIT-REPORT-2026-10-07.md:20` |

---

## 四、全部阈值清单（位置 · 值 · 依据 · 性质）

| 阈值 | 值 | 位置 | 依据 | 性质 |
|---|---|---|---|---|
| `ANCHOR_FLOOR` | **0.5** | `gen-ruler.mjs:110` | 61 条真手稿双峰分布 | 实测校准，但**只校准到「不敏感」**；低于教师均值 |
| G6 not-copy | 0.5（16-gram 覆盖率） | `gen-ruler.mjs` | 61 条手稿 | 拍保守值 |
| G7 compressed | 0.55 → **null** | `gen-ruler.mjs:99` | 阈值扫描：放宽后师生差距**从 15.1 扩大到 41.1 点** ⇒ 下架 | **已撤销** |
| `COMPRESSION_TARGET` | 0.5 | `gen-ruler.mjs:98` | **用户定的目标** | 软标准，只记账 |
| `COMPRESSION_HARD_MAX` | **null** | `gen-ruler.mjs:99` | 「以后再装上」 | **未装** |
| M1 压缩力度 | ≤ 0.60 | `GOLD-STANDARD.md:42` | C1 | 硬门 |
| M5 接地精度 | = 1.000 | `GOLD-STANDARD.md:46` | 生产 invented-identifier 同口径 | 硬门（**空稿满分**） |
| criticalCoverage | ≥0.95 / ≥0.8 | `KAGGLE-GENERATIVE-COMPRESSOR-RUN.md:61` | **未给任何校准来源** | 判读线 |
| ratioMean | 0.35–0.7 | 同上 :63 | 教师中位 0.41 | 判读线 |
| 三折 CV | +20pp / ≥0.75 / 最差 ≥0.70 | `KAGGLE-MICRO-RUN.md:51` | `micro_cv.py:3-5` **自认「阈值是在 2026-10-04 结果之后选出的」** | **事后拟合，却被当晋级判据** |
| 绝对 ≥90% | 90% | `CFB-MICRO-READINESS:7` vs `KAGGLE-MICRO-RUN:55` | —— | **两份文档冲突** |

---

## 五、文档互相矛盾（逐条）

1. **best-of-k 是不是解药** —— **最硬的一条，且是我本轮新引入的错**
   - `docs/RULER-V4-AND-G1-GUARD.md:593-604`：标题即「**⚠ best-of-k 是解药吗 —— 不是，我的假设被否掉了**」。实测组内相关 `rho = 0.5604`，「**失败是单元内在的，不是掷骰子**」「花钱重采样买不到多少东西 —— 这个结论**直接改变了钱该往哪花**」。Beta-二项预测 k=1 65.6% → k=4 82.9%，**边际递减**。
   - `docs/V10-ROOT-CAUSE.md:156-167`（**我本轮写的**）：「best-of-k 教师稿 —— **最高性价比**，$8.86」「这是**唯一一条能直接抬高学生天花板**的杠杆」。
   - **底层数字其实一致**（V10 测 +12.9 点，RULER-V4 测 0.650→0.750 = +10 点），**结论方向相反**。我写 V10 时**没有引用同仓已有的这个实测否定**。这是我的错，必须记下。

2. **阈值有没有「自然断点」**
   - `gen-ruler.mjs:105-108` + `GENERATIVE-RULER-v1.md:132-135`：「双峰，中间没有样本…它落在两个峰之间的**空谷**里」。
   - `RULER-V4-AND-G1-GUARD.md:42`：「0.55 落在分布**内部**，那里**没有自然断点**」。
   - 两处谈的不是同一个量（前者 G3 标识符保留率，后者 G7 token 比），但**都被用作「阈值有自然依据」的论据**，措辞互相拆台。

3. **绝对 ≥90% 阻塞还是不阻塞** —— `CFB-MICRO-READINESS-2026-10-04.md:7`（阻塞）vs `KAGGLE-MICRO-RUN.md:55`（不阻塞）。

4. **「不构成训练数据准入」vs「今天就能跑」** —— `KAGGLE-GENERATIVE-COMPRESSOR-RUN.md:6`（trainingReady=false）vs 同文件 :4（今天就能跑）；`MICRO-GENERATOR-TRAINING-SYNTHESIS.md:255`「fineTuneNow=false 是当前正确结果」。

5. **架构判决：抽取式 vs 生成式** —— `MICRO-MODEL-TRAINING-ROOT-CAUSE:19`「就应把产品定义为高召回的**抽取/选择式**压缩」vs 同文件 :70「路线已定为**生成式**」。

6. **语料规模** —— `KAGGLE-MICRO-MODEL-RUN.md` 同文件内 937（:184 风险栏）与 6,001（:170）并存，未说明取舍。

7. **指标说会 vs 交付物说不会** —— `MICRO-GENERATOR-BLANK-PREDICTIONS-ROOT-CAUSE:5-6`：dev CE 降到 2.4021，**但 139 条补预测全是空白行**。

8. **「59 → 17」是进步还是倒退** —— 三处对「59」的构成说法不一（单位错配垃圾行 / 13 行被平凡放行 / 垃圾放行）。

9. **三折 CV 读数不一致** —— `MICRO-MODEL-TRAINING-ROOT-CAUSE:56`（0.7648/0.6907）vs `TRAINING-SYNTHESIS:157`（0.7683/0.7010），都称「三折」，未标代际。

10. **「加数据没用」vs 仍把加数据列为杠杆** —— `V10-ROOT-CAUSE:118,121`（254→410 零变化，「再补 1000 条大概率也没用」）vs `RWKV7-V9-FIRST-RESULTS.md:142`（把「加数据」列为第 3 杠杆）。

11. **「没有一条是推演」vs 承认关键归因不可分离** —— `V10-ROOT-CAUSE:5` vs 同文件 :189（「学生收敛到条件均值」与「191M 容量不够」**不可分离**）。

12. **教师/学生判读线** —— M5 = 1.000（布尔）vs `criticalCoverageMean ≥0.95`（均值），同一路线内两个口径，文档未解释。

13. **数据准入** —— `MICRO-GENERATOR-DATA-SOURCING:38`「No admission decision yet」vs `TARGET-MODEL-SOURCE-SURVEY:51`「remains the strongest auxiliary source」。

**文档自我更正（原文承认先前结论错）共 5 处**：`RWKV7-V9-FIRST-RESULTS:100`（把「加数据」排第 1 是错的）、同 :146-150（中文稿不是 G7 挂掉的原因）、`KAGGLE-RWKV7-SMOKE-FINDINGS:160-163`（「2 卡」是错的）、`TARGET-MODEL-SOURCE-SURVEY:47`（「model-agnostic」是错的）、`KAGGLE-MICRO-RUN:76`（「已压进 matched 层」是过度声称）。

---

## 六、实测 vs 推演被当结论用

**明确标注真机/实测的**（可信）：`CFB-MICRO-HANDOFF`（Kaggle 真机）、`KAGGLE-MICRO-MODEL-RUN`（词表/语料计数）、`MICRO-GENERATOR-COT-PORTABILITY`（公开语料采样）、`MICRO-GENERATOR-FORGE`（本地锻造）、`V10-ROOT-CAUSE`（真机产物+本地重算）、`KAGGLE-RWKV7-SMOKE-FINDINGS`（原样日志）、`RWKV7-V9-FIRST-RESULTS`（89 条真机产物）、`AUDIT-REPORT-2026-10-07`。

**推演被当结论用的**（逐条）：
- `V10-ROOT-CAUSE:166-167`：best-of-2 目标 +12.9 点 ⇒ 学生上限就 +12.9 点 —— **外推**（同文件 :192-198 才提出分辨实验，未跑）。
- `V10-ROOT-CAUSE:120-121`：「更多采样点不会降低条件熵 ⇒ 再补 1000 条没用」—— 理论推演，无对应实验。
- `MICRO-MODEL-TRAINING-ROOT-CAUSE:58`：v2 阈值事后选出（工具注释自认），却当晋级判据用。
- `MICRO-GENERATOR-TRAINING-SYNTHESIS:167`：`evaluation-gates.template.json` 全部初始为 null、status `draft-not-frozen`，但同文件 :169 已给出判读线。
- `KAGGLE-RWKV7-SMOKE-FINDINGS:291-295`：教师 token 比 p50 0.501 vs 提示词要求 10~20% ⇒「压缩目标从来没达成过」—— 分布对比推出的结论。
- `MICRO-GENERATOR-COT-PORTABILITY:68`：「A reasoning trace is model-specific supervision」—— 推断，非迁移实验（:74 自认 transfer test 未跑）。

---

## 七、文档自认的「未测」清单（原样抄出，这是全仓最诚实的一部分）

**E1/E2 —— 唯一外部终验，从未跑过（教师也没跑过）**
- `MICRO-GENERATOR-FORGE:32`「未测就是未测：M2 / E1 / E2 / R1 / R2 全部记 未测，不折算成通过。本语料天花板 = provisional-gold，不是 gold。」
- `MICRO-GENERATOR-FORGE:109`「E1/E2 需要把压缩块喂回目标模型真跑——需要端点。没有端点，本语料全部标签的上限就是 provisional-gold。」
- `KAGGLE-GENERATIVE-COMPRESSOR-RUN:15`「之后量学生 = **同源测量**：能测「学没学到形状」，**不构成对尺子本身的验证**。E1/E2 仍是唯一外部终验（未测就是未测）。」
- `KAGGLE-GENERATIVE-COMPRESSOR-RUN:82`「没跑真机就不写 E1/E2；没有人工审核就记 humanReviewerCount=0；**机器生成的目标不叫金标**。」
- `MICRO-GENERATOR-TRAINING-SYNTHESIS:242`「任何评测必须以目标模型为读者（E1/E2 真机是唯一外部终验，未测就是未测）」；:160「未测≠通过」。
- `KAGGLE-MICRO-MODEL-RUN:160`「E1/E2 仍是未测：同源测量能量「学没学到形状」，不构成对尺子的验证。」
- `MICRO-GENERATOR-TARGET-MODEL-SOURCE-SURVEY:51`「drafts built from it stay 未测 on E1/E2 (provisional at best) until the real-machine A/B is run with the target model.」

**尺子自己的诚实清单**（`GENERATIVE-RULER-v1.md:225-246`）
- 「阈值只在 **n=3** 的真机读数上校准过。`ANCHOR_FLOOR = 0.5`、G6 的 0.5、G7 的 0.55 都是从 61 条手稿的分布里挑的**保守值，不是拟合出来的最优值**。」
- 「尺子没在「任意思维链」上测过。目前所有测例都是修 bug 型 CoT…纯数学/纯推理型 CoT 上 G2/G4 会退化成场景门不激活，**未测**。」
- 「`teachScore` **完全未校准**。」
- 「预检阈值只在这一个语料上量过，**没有被真正检验过**。」
- 「**没有第二种分布。** 泛化到别的思维链形态（数学推理、长链规划、中文思维）上完全没有测过。用户要的是「面对任何思维链都可以」，而这批数据只覆盖一种。」

**其它**
- `AUDIT-REPORT-2026-10-07:58`「仍缺真实宿主/外部效度验证。本轮没有连接 Cordis/DSH 真实宿主，没有付费 API 试验，也没有参加外部官方 benchmark；隔离自测不能替代这些验证。」
- `AUDIT-REPORT:8`「没有产生新的随机化盲测或付费模型实验…不是新采样证据」；:21「06g 折报告/候选权重未入库，**不能独立复算或据快照晋升**」。
- `MICRO-MODEL-TRAINING-ROOT-CAUSE:84`「没有人工事实/参考答案裁定、真实 GGUF/HF 推理、模型训练、Kaggle 运行或盲测；**因此没有可报告的模型质量通过结论**。」
- `KAGGLE-RWKV7-SMOKE-FINDINGS:120-125`「6144 窗口对 RWKV 固定状态容量的挤压…g1 的预训练上下文长度未公开，**6144 是外推** —— 「跑得动」≠「质量不掉」」。
- `RWKV7-V9-FIRST-RESULTS:94-96`「它现在不如教师（软分 0.5638 vs 0.6957）。这是一个起点基线，**不是能交的东西**。」
- `CFB-MICRO-HANDOFF:67`「GitHub PAT 曾误出现在工具输出。**旧 token 应撤销/轮换**；不得把新 token 写入报告或聊天。」

---

## 八、教师质量（回答「你要确定教师是没问题的」）

**结论：教师能用，但不是确定性函数，且尺子有两个实测缺陷。**

| 量 | 读数 | 出处 |
|---|---|---|
| 同一输入两次，逐字相同 | **0 / 100** | `RULER-V4 §16.2` |
| 过门结论翻转 | **20 / 100 = 20%**（过→不过 9，不过→过 11，**对称 ⇒ 噪声非偏置**） | 同上 |
| Cohen kappa | **0.561** | 同上 |
| 语言判定翻转 | **31 / 100 = 31%** | 同上 |
| 软分差 p50 / p90 | 0.0417 / 0.1376 | 同上 |
| 换一批（85 单元）软分相关 | **r = 0.574**，过门翻转 **24%** | `V10-ROOT-CAUSE` |
| 同输入 10-gram 重合 | 0.086（**不同输入基线 0.000**） | 同上 |
| 教师自身过尺率 | 第一批 16/20 = 80.0%，第二批 78/100 = **78.0%** | `GENERATIVE-RULER-v1 §11` |
| 教师 token 比 | p50 **0.501**（提示词要求 10~20%，**差 2.5~5 倍**） | `KAGGLE-RWKV7-SMOKE-FINDINGS:291` |
| 教师 raw 锚点保留率 | **56.8%** | `V10-ROOT-CAUSE:81` |

**尺子的两个实测缺陷**（`RULER-V4 §16.4` 退化阶梯，60 条过门教师稿）：
- **缺陷一：打乱句序完全测不出**（L4：60/60 全过，软分 0.6993 vs 基线 0.7006）。机理确认：六个软分项**全是集合型**，逐项差 0.0000 / −0.0016 / 0.0000 / +0.0016 / 0.0000 / −0.0243。→ v5 补了 S7 orderPreserved。
- **缺陷二：软分奖励删内容**（L1 删末 25% 句，软分**反而升高** 0.7006 → 0.7121；L2 删一半只降到 0.6898 = −1.5%）。→ v5 改了 S4/S3。

**关键事实：稿子是存盘的，重过滤免费。** 钱的风险**只有一个来源：提示词变更**。而提示词在 `build-sft.mjs` / `train_rwkv7.py` / `infer_rwkv7.py` 三处逐字一致，v5 提示词已被实测否掉（18/23 vs 21/23）⇒ **「434 条不用删，剩下 3942 条也不会白花」**（`RULER-V4 §16.6`）。

---

## 九、v9 / v10 实测（同一 89 条冻结 dev，`gen-ruler/5`）

| | v9 学生 | v10 学生 | 教师 |
|---|---|---|---|
| 过门（有受力点 73） | 45 = 61.6% | 42 = 57.5% | **55 = 75.3%** |
| 软分 | 0.5453 | 0.4874 | **0.7069** |
| S3 决策覆盖 | 0.606 | 0.387 | 0.866 |
| 稿长 p50（token） | 350 | 225 | 440 |
| **raw 锚点保留率** | **35.8%** | **31.2%** | **56.8%** |

**v10 全面劣于 v9。** v10 的 train loss 0.0003（困惑度 1.0003）、dev loss 2.84 → 3.59（**单调恶化**）。

**五个确定的配方缺陷**（全部免费）：① dev loss 每个快照都算了却丢掉，**发的是最差的那个**；② **全程无 shuffle**（按长度排序、同样 12 个批重复 24 遍）；③ `--gen-max-new 768` 截断（学生 token max **恰好 768**，v9 10/89、v10 4/89 撞顶；教师 max 750、训练目标 max 1927）；④ `lr_at` 用 `total_steps` ⇒ `--epochs` 同时改数据遍数与日程长度；⑤ eos 定义矛盾（`tokenizer_config` 说 `eos_token = "\n\n"` id 65530，`generation_config` 说 `eos_token_id: 0`）。

---

## 十、我的错误（本轮 + 前几轮，防重犯）

| # | 我的错误 | 真相 | 教训 |
|---|---|---|---|
| 1 | **本轮**：写 `V10-ROOT-CAUSE.md` 时把 best-of-k 称为「最高性价比 / 唯一能抬高天花板的杠杆」，**没引用同仓 `RULER-V4 §16.3` 已有的实测否定** | 那份文档标题就是「best-of-k 是解药吗 —— 不是，我的假设被否掉了」 | 写新结论前**必须检索同仓已有实测**，不能只信自己这轮的数据 |
| 2 | **本轮**：改了 `gen-ruler/5` 的 S3/S4/S7、调了权重、写了两页 rationale，**却没发现 G3 的 `ANCHOR_FLOOR = 0.5` 把布尔不变量降级成了软阈值** | 我拿着这把尺子跑训练、汇报数字、写归因，就该看出来 | 改一把尺子之前，**先把它的每一条判据逐条审一遍「这是布尔还是程度」** |
| 3 | 前轮：把「生产微编译器」放进「可信可使用」桶 | 用户改向 | 审计必须问**可达性**，不只是**完好性** |
| 4 | 前轮：断言「本机已能训练出微模型」 | 用户：「这个js完全是在乱搞」 | **「脚本跑通了」≠「实验成功了」** |
| 5 | 前轮：把 v5「生成式」语料当数据基础 | 它的教师是**规则抽取器**（`teach-shape.mjs` 零 API 调用，输出是逐句摘抄加前缀） | 格式是 SFT 的 ≠ 教师是生成的 |
| 6 | 前轮：说「权重从未导出」 | 97M 真跑了，release 资产 98,742,284 字节，digest 与报告逐字节吻合 | 先查 release 再下结论 |
| 7 | 前轮：说「三折全部干净通过，均值 0.9032」 | 那是 accuracy 头条数；预注册指定的是 `lengthMatchedAccuracy`：flaky 75.8% vs 需 92.7% ⇒ **FAIL** | 必须读**预注册里指定的那个指标** |

---

## 十一、证据分级（我建议此后全仓统一用）

- ✅ **亲手跑出 / 亲手读到**：`V10-ROOT-CAUSE` 的真机产物、`KAGGLE-RWKV7-SMOKE-FINDINGS` 的原样日志、`RWKV7-V9-FIRST-RESULTS` 的 89 条产物、`RULER-V4` 的退化阶梯与教师审计、`GENERATIVE-RULER-v1` 的语料统计。
- ⚠️ **仓库文档自述，未经独立复现**：`TRAINING-AND-BENCHMARK` 的 06g 数字、`STATUS-2026-10-07`（基于 `8c918cc`，当前已前进到 `7a5a863`）、三折 CV 全部读数（指纹不匹配，不可复现）。
- ❌ **曾断言、后被推翻**：见 §十。

**唯一显式做了这个分级的文档是 `transfer/notes/GENERATIVE-ROUTE-HANDOFF.md`（✅/⚠️/❌）** —— 建议作为全仓范式。

---

## 十二、我的判断（明确标为判断，不是事实）

1. **在「不许丢」这条判据装回去之前，跑任何测量都没有意义** —— 包括我刚建好的 `effect-eval` 接入。被测对象（教师稿丢 43% 承重锚点）和判据（不查丢）都没定义对。
2. **当前最该做的一件事不是训练，是把「承重锚点零丢失」做成布尔闸**，然后拿它去量**教师**。如果教师的稿子过不了这道布尔闸 ⇒ **整个目标定义要重做**，191M 不是瓶颈。
3. **E1/E2 至今未跑**，所以「能不能用」这个问题**从未被回答过**，对教师和对学生都没有。这是全仓最大的空白。
4. **v9/v10 的对比是在比较「两个都违反保真不变量的东西谁更接近一个没验证过的标准」**，结论不可用于决策。

---

## 十三、待你裁决

1. **先做哪一件**：(a) 把「承重锚点零丢失」做成布尔闸，拿它量教师；(b) 跑 E1/E2（要端点，几毛钱 DeepSeek）；(c) 先修 `ANCHOR_FLOOR` 这条口径并重算全部历史结论。
2. **口径**：路径布尔、标识符 0.5 —— 标识符要不要也改布尔？（Python 点号模块名 → 文件路径 那 8 条「口径待定」样本还挂着，`GENERATIVE-RULER-v1 §11` 明确写「这是一个必须由人来定的口径」。）
3. **`src/birth.js:618` 那个 9.6% 整份丢弃**要不要改成「摘除不发明」（数学上不可能更差）。
4. 我建的 `deploy/kaggle/start-infer.py` + `tools/rwkv7-report.mjs` + `deploy/kaggle/data/effect-pairs.jsonl` 要不要继续推（数据集 730 MB 上传中）。
