# 能力瓶颈突破点侦察（2026-09-30）

> 用户指定：只查**能力**层瓶颈（不是触发、不是观测）。目标：找**突破**，不是修改。
> 方法：16 次文献检索（arXiv / 会议 / 综述），全部 2024–2026；每条结论标注出处；对照我们自己的实测数字做归因。
> 本文只做侦察与排序，不改任何代码。

---

## 0. 先把「能力瓶颈」定义死

我们当前形态的完整定义（这是瓶颈的边界）：

```
主模型 CoT_t + 观察 O_t  ──(廉价副模型，一次调用)──▶  一段**文本**草稿 D_t  ──▶  进 assistant 消息  ──▶  主模型下一轮读
```

三条硬约束：**只能产出文本**；**不能取新证据**；**不能改读者**。

实测到的能力上限（自证）：

| 事实 | 数字 |
|---|---|
| 自动稿 vs 手写稿（同一形态） | 单步 8.5/8.6 vs 8.3–8.9；多轮 8.0 vs 7.8 |
| 文本救不了的一类失败 | flaky：raw 3.0 / 手写 2–3 / auto 5.0（n 小，但三个变体同档） |
| 稿是原文的**子集**（信息更少）却打得更准 | 红题 raw 4.9 → auto 8.0，假完成 13%→0 |

⇒ 结论：**我们摸到的不是「写得不够好」，是「这个形态能表达的东西用完了」。** 后文所有条目都必须回答同一个问题：它让系统**多会做什么**（不是「写得更好」）。

---

## 1. 六面墙（机制 / 证据 / 对 cfb 的含义）

### 墙 1 · 通道：文本是两个模型之间最差的介质

- **C2C（Cache-to-Cache，ICLR 2026，[arXiv:2510.03215](https://arxiv.org/pdf/2510.03215)）**：用一个神经融合器把 Sharer 的 KV cache 投影进 Receiver。比同规模单模型高 6.4–14.2% 准确率，比文本往返快 2.5×。作者原话：文本通道「既要逐 token 解码内部表示、又要在接收端重新编码」。
- **LCF（Latent Cache Flow，ICML 2026，[arXiv:2605.22863](https://arxiv.org/abs/2605.22863)）**：在 C2C 基础上做跨上下文（两模型看的东西不同）——把发送方 KV 池化成固定大小的「上下文摘要」。13 MB 适配器 > 956 MB 的 C2C；跨上下文 HotpotQA EM +23%，比文本通信快 8.5×。
- **Cartridges（ICLR 2026，[arXiv:2506.06266](https://www.alphaxiv.org/abs/2506.06266v1)）**：离线把语料蒸馏成一个小 KV 前缀。38.6× 内存、26.4× 吞吐、NIAH 上最高 648× 压缩而近乎无损；关键一句：**prompt/KV 剪枝类方法在 ~2× 压缩后就撞「质量墙」，而训练出来的 Cartridge 不会**。

⇒ **含义**：我们一直在优化的「文本压缩比」，在文献里是被判过死刑的那一半（>2× 就撞墙）。真正的压缩比来自「换介质」，不是「写短一点」。
⇒ **可达性**：需要白盒（两个模型的开权重 + 训练适配器）→ **对我们是天花板，不是路线**。但它给出一个可做的近亲：**让状态成为一个稳定的前缀块**（prefix cache 命中），而不是每轮重写的中段文本（见 §4-E）。

### 墙 2 · 记忆：token 记忆是被训练过的对象，不是被写出来的字符串

- **Titans（NeurIPS 2025，[arXiv:2501.00663](https://proceedings.neurips.cc/paper_files/paper/2025/file/a4ca07aa108036f80cbb5b82285fd4b1-Paper-Conference.pdf)）**：一个神经长期记忆模块，在**推理时**按「意外度」更新自己的权重；超过 2M token 的针检索里仍稳。
- **MemAgent（[arXiv:2507.02259](https://www.emergentmind.com/papers/2507.02259)）**：把「写记忆」当成 RL 动作（DAPO / GRPO），**覆盖式**更新固定长度内存；8K 训练 → 3.5M token QA 掉点 <5%。消融：**同一套记忆机制，没有 RL 就退化**。
- **Letta sleep-time compute（2025.04 白皮书）**：把「整理记忆」挪到空闲时间，测试时算力 −5×、准确率 +13–18%。MemFS（2026）把记忆变成 git 版本化的文件系统。

⇒ **含义**：我们「让副模型写一段更好的稿」本质是**模仿人在写摘要**；文献里胜出的那一路是**用一个学出来的策略决定写什么**，并且**覆盖而非累积**（我们的延续段已经在做这件事）。另一条被忽略的杠杆：**空闲时间**——编译可以发生在没有人等它的时刻（我们已经是 prefill-only，等于免费算力，只是没把「多余算力」用起来）。

### 墙 3 · 目标：不要模仿「好摘要」，要对下游结果负责

- **CORE-RAG（ICML 2026）**：小压缩器（1.5B）对着**冻结的黑盒下游大模型**做 GRPO，奖励就是下游 EM/F1。作者的原话式表述：**gold summary 不存在**——只有「让下游答对的摘要」。副产物非常关键：蒸馏阶段按下游准确率**过滤教师摘要，并允许模型输出空串**（把有害上下文直接删掉）。
- **LLMLingua / LLMLingua-2 / gist tokens / PCC（ACL 2025）**：LLMLingua-2 把压缩变成 token 分类（数据蒸馏自 GPT-4）；gist tokens 最高 26× 压缩而输出质量不变；PCC 推荐 4×–16×，更高压缩率会掉信息。

⇒ **含义（这是对我们整个方法论最重的一击）**：我们所有「写好稿」的规则（K1–K6、四段体、目标字数）都是**人工先验**；文献里被证明有效的做法是**用一个可验证的下游信号去搜/练这个策略**。我们已经有那个信号（确定性闸门 + 规则门 + 任务是否修好），但我们**只拿它当判据，没拿它当目标函数**。

### 墙 4 · 输入：CoT 有一半是剧场，忠实压缩它在理论上是错的

- **Reasoning Theater（Goodfire × Harvard，2026-03，[goodfire.ai](https://www.goodfire.ai/research/reasoning-theater)）**：在 MMLU 这类偏记忆的题上，**答案在激活里早就可解码**（探针 87.98%），而文本 CoT 要到很晚才透露；用探针置信度早退可省 **68% token（MMLU）/ 33%（GPQA）**，准确率保留 95%+。同一篇论文明确指出：**任务越简单，剧场越多**。
- **反过来**：**CoT-as-computation vs CoT-as-rationalization（[arXiv:2507.05246](https://arxiv.org/abs/2507.05246)）**——任务难到必须靠 CoT 计算时，不忠实消失，CoT 反而可监控。
- **FaithCoT-Bench（ICLR 2026）**、Chen et al. 2025（Anthropic）：不忠实的 CoT **更长、更详细**——「长 = 认真」这个直觉是反的。

⇒ **含义（可以直接落地，见 §4-A）**：我们的输入里既有**计算**（flaky 那轮主模型算出的「定时器总在阈值后」）又有**剧场**（sse 那轮「改完新起的进程所以新鲜」的自我叙述）。**我们目前的策略是一视同仁地忠实压缩**——这会同时犯两个错：丢计算、留剧场。文献给了一个纯 API 就能实现的判别工具：**强制提前回答（forced answering）**。

### 墙 5 · 行动：陈述不能产生证据，探测可以

- **DoVer（[arXiv:2512.06749](https://arxiv.org/html/2512.06749v3)）**：把「故障归因假设」变成**干预**（改消息、改计划）再重放——能验证/否证 30–60% 的假设。核心口号：do-then-verify，因为**归因准确率本身不可信，只有干预可判**。
- **TraceRepair（[arXiv:2604.02647](https://arxiv.org/html/2604.02647v2)）/ TraceCoder（[arXiv:2602.06875](https://arxiv.org/html/2602.06875)）**：专门的 **Probe Agent**——只插日志、不改逻辑，把「变量快照」当证据，再据此生成/排序修复假设。
- **AutoSD（EMSE 2024，[Springer](https://link.springer.com/article/10.1007/s10664-024-10594-x)）**：假设 → 实验脚本 → 真跑 → 结论，循环。

⇒ **含义**：我们 flaky 那一格全员不及格（3.0 / 2–3 / 5.0），**不是文字问题**——需要「在同一次失败运行里打印被等待事件的时刻」这种**新证据**，而我们的制品**只能陈述**，不能制造证据。这是形态级的缺陷。

### 墙 6 · 验证：生成与验证是两种能力，且不自带

- **[arXiv:2602.07594](https://arxiv.org/html/2602.07594)**：生成能力提升**不会**带来自验证能力提升（持续的不对称）；反过来训练自验证可以反哺生成。
- **Stechly et al. / Huang et al.**：无外部反馈的自我纠错基本无效；「看起来在检查」多为 fake verification。
- **QA-based 摘要评估（QAEval, TACL 2021；QuestEval, EMNLP 2021；FEQA/QAGS）**：用「从参考文本生成的问答对能不能在被评文本里被答对」来测量**充分性**——这正是我说的「重建测验」的成熟版本，且它**不需要人评、不需要评委给 Likert**。
- **步级信用（TRCA [arXiv:2608.16156](https://arxiv.org/html/2608.16156) / iStar ICLR 2026 / OPRL [arXiv:2509.19199](https://arxiv.org/html/2509.19199v1)）**：失败轨迹里 >70% 的动作仍带可用的步级信号；把「哪一步坏了」变成可计算的（Evidence / Execution / Invalidity 三类 rubric）。这是「不知哪里不好」在训练层的正式解。

⇒ **含义**：我们现在用「一个同族评委给全局分」来当质量信号——这是文献里最弱的一档。**可换成本地、逐槽、零评委的信号**：稿能不能答出台账里的问题（充分性），以及「这个动作是取证还是空转」（步级 rubric 已被证明可计算）。

---

## 2. 理论侧：把我们手搓的东西接到正式理论上

| 我们的说法 | 正式对应 | 差距在哪 | 能补什么 |
|---|---|---|---|
| 定理 1「状态充分性」（卷一） | **双模拟 / MDP 同态**（Givan 2003；Ravindran & Barto；Castro 2020 的 on-policy bisimulation metric；[JMLR 2024 连续 MDP 同态](https://www.cs.mcgill.ca/~prakash/Pubs/jmlr2024.pdf)） | 我们有「充分统计量」的比喻，没有**正确性条件**，也没有**近似度量** | 双模拟给出「什么时候可以合并两个状态而不改变最优动作」的**判定条件**；lax bisimulation metric 给出**可计算的偏离度**。这正好能当「允许丢什么」的判据 |
| 第二原理「再推导代价 × 决策相关」 | **Wyner–Ziv：解码端有边信息的有损压缩**（Wyner & Ziv, IEEE TIT 1976；[Entropy 2024 结构性质](https://www.mdpi.com/1099-4300/26/4/306)） | 我们的「环境」就是解码端边信息（文件、工具、git），我们从没用这个身份去看它 | 正确的率是 **H(历史 \| 环境)**：凡是环境能重建的，**率应当是零**。这把「压成指针」从技巧变成定义 |
| 卷四 v(i) 与 λ | **任务导向语义通信 / 任务特定率失真**（[Entropy 2025, 27(8):775](https://www.mdpi.com/1099-4300/27/8/775)；[FOL 目标导向语义通信 2026, arXiv:2604.19614](https://arxiv.org/abs/2604.19614)） | 我们的 λ 是拍的；目标是「信息量」而不是「任务失真」 | 正式目标：**min I(历史; 稿) s.t. P(决策错) ≤ ε**，λ 是影子价格。FOL 那篇更进一步：只传对**目标状态**最关键的证据，并保持逻辑可验证性 |
| 「稿」这个格式 | **渐进细化 / 多描述编码**（Goyal, IEEE SPM 2001；[DeepJSCC-l, arXiv:2009.12480](https://pith.science/paper/2009.12480)） | 我们把稿当成**一条**信息；宿主可能截断、丢弃、重排 | 多层编码的定理性质：**任一子集收到都能解出一个可用版本，层数越多越好**；DeepJSCC-l 的实测结论是「加层的损失可忽略」。这直接对上我们「宿主删一半就崩」的脆弱性和「先删理由」的实现 bug |
| 「言过其实要靠宿主拦」 | **持久状态 / 承诺台账**（[Always-On Agents 综述, arXiv:2606.30306](https://arxiv.org/html/2606.30306v1)） | 我们把它当稿的修辞 | 该综述把「未结承诺与义务的台账」列为**一等公民的持久状态**，与记忆并列，因为它必须可追溯到授权它的内部状态 |

---

## 3. 我先前判断里被打掉 / 被证实的

**被打掉**
1. 「先把保留率做高」——**错在目标**。CORE-RAG 说明「好摘要」不存在，存在的是「让下游答对的摘要」；Cartridges 说明文本/剪枝路线的压缩比有硬墙（~2×）。
2. 「长度是编译的输出」（我引卷一）——在**单条文本**形态下是自欺：文献的对应物是**层数**，不是长度。长度是宿主的预算，层数是我们的输出。见 §4-B。
3. 「评委分数是主要读数」——文献里的替代品（QA 充分性、步级 rubric）更便宜也更稳；我上一轮把它当"可选的补充"，实际应是**主读数**。

**被证实**
1. **承诺 > 记忆**：承诺/义务作为一等持久状态，是 2026 年综述的正式结论。
2. **「程序写它能写的」方向对，但只是最便宜的一半**：d9 把确定性部分从模型手里拿走；文献里更强的一半是**把「留什么」交给对下游负责的策略**。
3. **「多轮压稿的价值是效率」**：与上下文腐化（context rot）的证据一致——18 个前沿模型在所有长度上都退化，**干扰项比长度更毒**（[Chroma 2025](https://research.trychroma.com/context-rot)）；「仅长度就伤性能、即使检索完美」（13.9–85%）说明**注意力预算**是真实约束。

---

## 4. 五个可落地的能力级动作（按 能力增益 × 可达性 排序）

> 判据：每条必须让系统**多会做一件事**；带成本；带「什么结果会杀掉它」。

### A. 输入审计：把「剧场」和「计算」分开（成本：每轮 1–3 次 flash 调用）

**做法**：对一段 CoT 取若干前缀（如 1/3、2/3、末段），让副模型**强制提前回答**：「下一步动作是什么？已定的是什么？」。若前缀 k 的答案已经与最终答案一致 ⇒ 之后的部分是**剧场**，标记为可丢；若只有末段才一致 ⇒ 是**计算**，其中的派生量（数字、算式、判读）必须逐字保留。
**文献**：Reasoning Theater 的 forced answering；ProFIL 把「承诺点」定义为**第一个强制回答正确的步**。
**为什么是能力**：编译器第一次**能判断自己的输入质量**，而不是无条件忠实压缩。sse 的「假新鲜担保」属剧场，flaky 的算式属计算——正好把我们两个最贵的失败分开。
**杀掉它**：若在 5 题上，剧场的判定与「删掉后行为变差」不一致（即删了剧场反而更差），此法作废。
**风险**：副模型判「下一步动作」比判「最终答案」更难；先只做二分（这段是不是在复述已定结论），不做全量标注。

### B. 制品分层：把稿写成「多描述」，而不是「一条信息」（成本：0，纯程序 + 离线可验）

**做法**：稿 = 三层，**每层独立可解**：
- **L0（不变量层，~400–600 字）**：承诺（改法三元组 + 状态）、已排除候选与否证句、逐字事实、验收命令与字面预期。**永不因预算被删**（宿主删则整个块视为不可用，宁可短）。
- **L1（现状层）**：本轮增量、判读分支、未解量。
- **L2（指针层）**：文件/行号/命令的出处与详注。
**文献**：多描述编码（Goyal 2001）：任一子集可解、质量随层数增长；渐进细化（DeepJSCC-l）：加层损失可忽略。
**为什么是能力**：宿主可以任意截断/丢弃而不致崩；这同时**从构造上修掉**我们「先删已排除段（=理由）」的实现 bug。
**杀掉它**：若 267 份历史稿分层后，L0 单独过不了闸门（缺三元组/命令/事实），说明分层与我们的形态冲突。

### C. 编译期充分性自检：把「不知哪里不好」变成逐槽信号（成本：每轮 2–4 次 flash 调用）

**做法**：① 用程序把**台账**（已有）渲染成一组固定问句：定了什么/状态档位/排除了什么/理由/仍在依赖的逐字事实/未解量/若结果是 Y′ 走哪条；② 只给副模型**稿**（不给原文、不给台账），让它逐题作答；③ 命中率 = 充分性分；**失分的槽位直接告诉我们要补哪一段**。
**文献**：QAEval / QuestEval / FEQA（QA 基充分性评估，无参考也能算）；CORE-RAG 的「下游准确率即奖励」。
**为什么是能力**：我们第一次有**本地、逐槽、不需要评委**的质量信号；也是 S10.16 说的「同文本同分」问题的终结。
**杀掉它**：若充分性分与任务最终成败无相关性（需一次付费轨迹实验），此法降级为诊断工具。

### D. 制品可执行化：把「验收命令」升级成「探针 + 回填」（成本：host 协议 + 每轮 0–1 次额外汇总）

**做法**：编译产物除了稿，再产出一个**结构化探针**（命令 + 预期字面结果 + 判读分支），由**宿主**在下一轮真正执行，其输出**强制回填**进下一轮的 ctx（而不是靠主模型自愿去跑）。这一步把「陈述」变成「取证」。
**文献**：DoVer（干预 + 重放验证归因）、TraceRepair / TraceCoder（Probe Agent 只插日志不改逻辑）、AutoSD。
**为什么是能力**：它直接攻击我们唯一**文字无解**的失败类（flaky）；也是 `birthFinish` 缺口的自然延伸——我们已经在 finish 处拿到 turnCalls，现在只差「把回执也接回来」。
**杀掉它**：若探针在 5 题里的「预期 vs 实际」判读本身不可靠（副模型或程序判错），退回只做「执行 + 原样展示」。

### E. 让状态住进稳定前缀（成本：0 代码，策略调整）

**做法**：把我们输出的块**固定在消息序列的前部**（与宿主约定为不可改写区），使 prefix cache 永远命中、且不随每轮重写而失效；长命事实**在产生的那一轮就写进 L0**，而不是等压缩时再抽取。
**文献**：compaction 与 prompt caching 的张力、artifact tracking 在各方法里都最弱的实测（2.19–2.45/5）、以及「offload on write, not at compaction」（[Zylos 2026 综述](https://zylos.ai/research/2026-04-21-agent-context-compaction-long-running-sessions/)）。
**为什么是能力**：冲突最小、收益最直接的**系统级**能力——把「每轮重新压缩」变成「一次写入 + 稳定驻留」。
**杀掉它**：若宿主缓存命中率与位置无关（需采样 trace），此条作废。

---

## 5. 需要外部支持才能拿到的（命名后停手）

| 能力 | 依赖 | 为什么不是现在 |
|---|---|---|
| KV/权重的状态通道（C2C / LCF / Cartridges） | 开权重 + 训练适配器 + 服务端支持 | API 插件拿不到 |
| 学出来的压缩策略（RL 对下游奖励） | 可训练的小模型 | 我们的副模型是 API；**次优替代 = 对现有信号做策略搜索**（见下） |
| 激活层探针（精确判定剧场/承诺点） | 白盒 | 只能用 forced answering 近似 |
| 记忆写进权重（Titans） | 训练 | 同上 |

**次优替代（不需要训练、但保留「对下游负责」的精神）**：把可调项（哪些段程序写、层大小、是否附指针、剧场判定的阈值）当**离散策略空间**，用我们已有的**确定性闸门 + 审计不变量 + 重放**当目标做**搜索**（零评委成本）。这是 CORE-RAG 的去训练版。

---

## 6. 建议的下一步（都不动钱）

1. **先做 B（分层）与 C（充分性自检）**：纯程序 + 现有 267 份稿即可离线验证；B 还能顺带把「先删理由」的实现错误从根上解掉。
2. **再做 A（剧场判别）**：需要少量 flash 调用，但**可以先用历史 CoT 离线跑**（traj 记录里没存原文——这点要先修记录，见 LIVE-MEMORY §7）。
3. **D 需要一次 host 协议决定**（是否允许编译产物携带可执行探针并强制回填）；这是产品动作，不是研究动作。
4. **E 是零成本策略调整**，随时可做。
5. 付费项（验证 C 与任务成败的相关性、跨生态泛化）**继续等你批**。

---

## 附录 · 本次引用文献清单

**通道 / 记忆介质**
- Cartridges: Lightweight and general-purpose long context representations via self-study — ICLR 2026, [arXiv:2506.06266](https://www.alphaxiv.org/abs/2506.06266v1)（38.6× 内存 / 648× 压缩 / 「2× 质量墙」）
- Cartridges at Scale — [arXiv:2606.04557](https://arxiv.org/html/2606.04557v1)（分文档 Cartridge 比单体高 30 分）
- Cache-to-Cache (C2C) — ICLR 2026, [arXiv:2510.03215](https://arxiv.org/pdf/2510.03215)
- Latent Cache Flow (LCF) — ICML 2026, [arXiv:2605.22863](https://arxiv.org/abs/2605.22863)
- Titans: Learning to Memorize at Test Time — NeurIPS 2025, [arXiv:2501.00663](https://proceedings.neurips.cc/paper_files/paper/2025/file/a4ca07aa108036f80cbb5b82285fd4b1-Paper-Conference.pdf)
- MemAgent: Multi-Conv RL-based Memory Agent — [arXiv:2507.02259](https://www.emergentmind.com/papers/2507.02259)
- Sleep-time Compute (Letta) — 2025.04 白皮书 / [Fast Company](https://fastcompanyme.com/technology/why-sleep-time-compute-is-the-next-big-leap-in-ai/)
- Memory in the Age of AI Agents（综述，2026.01）— [arXiv:2512.13564](https://mnemoverse.com/docs/research/ai-memory-landscape-2026)
- Always-On Agents: Persistent Memory, State, and Governance — [arXiv:2606.30306](https://arxiv.org/html/2606.30306v1)（承诺台账为一等持久状态）
- Graph-based Agent Memory（综述）— [arXiv:2602.05665](https://arxiv.org/html/2602.05665v1)

**压缩目标 / 学习式压缩**
- CORE-RAG: Performance-Driven Context Compression — ICML 2026, [paper note](https://en.papernotes.org/ICML2026/information_retrieval/less_is_more_elevating_rag_via_performance-driven_context_compression/)
- LLMLingua — [OpenReview](https://openreview.net/pdf?id=ADsEdyI32n)；LLMLingua-2（token 分类）
- Learning to Compress Prompts with Gist Tokens — NeurIPS 2023, [arXiv:2304.08467](https://arxiv.org/pdf/2304.08467)
- Pretraining Context Compressor (PCC) — ACL 2025, [aclanthology](https://aclanthology.org/2025.acl-long.1394.pdf)
- AgentCompress（任务感知路由）— [arXiv:2601.05191](https://arxiv.org/pdf/2601.05191)

**输入质量 / CoT 忠实性**
- Reasoning Theater（Goodfire × Harvard，2026.03）— [goodfire.ai](https://www.goodfire.ai/research/reasoning-theater)
- Drop the Act: Probe-Filtered RL (ProFIL) — [arXiv:2605.11467](https://arxiv.org/html/2605.11467)
- When CoT is Necessary, LMs Struggle to Evade Monitors — [arXiv:2507.05246](https://arxiv.org/pdf/2507.05246)
- FaithCoT-Bench — ICLR 2026, [OpenReview](https://openreview.net/attachment?id=lN3yKqqzF1&name=pdf)
- Chain-of-Thought Monitoring（综述页：Chen et al. 2025, Korbak/Bengio 2025）— [policywindow](https://policywindow.org/wiki/chain-of-thought-monitoring)

**行动 / 探测 / 验证**
- DoVer: Intervention-Driven Auto Debugging — [arXiv:2512.06749](https://arxiv.org/html/2512.06749v3)
- TraceRepair — [arXiv:2604.02647](https://arxiv.org/html/2604.02647v2)；TraceCoder — [arXiv:2602.06875](https://arxiv.org/html/2602.06875)
- AutoSD（LLM 驱动的科学调试）— EMSE 2024, [Springer](https://link.springer.com/article/10.1007/s10664-024-10594-x)
- Learning to Self-Verify Makes LMs Better Reasoners — [arXiv:2602.07594](https://arxiv.org/html/2602.07594)
- TRCA: Transition-wise Rubric Credit Assignment — [arXiv:2608.16156](https://arxiv.org/html/2608.16156)；OPRL — [arXiv:2509.19199](https://arxiv.org/html/2509.19199v1)
- QAEval — TACL 2021, [MIT Press](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00397/106792/Towards-Question-Answering-as-an-Automatic-Metric)；QuestEval — EMNLP 2021, [ACL](https://aclanthology.org/2021.emnlp-main.529.pdf)

**理论**
- Wyner–Ziv 结构性质 — [Entropy 2024, 26(4):306](https://www.mdpi.com/1099-4300/26/4/306)
- Task-Specific Semantic Rate-Distortion — [Entropy 2025, 27(8):775](https://www.mdpi.com/1099-4300/27/8/775)
- Goal-Oriented Semantic Communication for Logical Decision Making — [arXiv:2604.19614](https://arxiv.org/abs/2604.19614)
- Multiple Description Coding（Goyal, IEEE SPM 2001）— [PDF](https://www.vivekgoyal.org/documents/Goyal_SigProcMag2001_MD.pdf)
- Bandwidth-Agile JSCC（渐进细化 / 多描述的学习版）— [arXiv:2009.12480](https://pith.science/paper/2009.12480)
- MDP Homomorphisms / 双模拟 — [JMLR 2024](https://www.cs.mcgill.ca/~prakash/Pubs/jmlr2024.pdf)；[Learning Invariant Representations without Reconstruction, arXiv:2006.10742](https://arxiv.org/html/arxiv:2006.10742)
- PABU: Progress-Aware Belief Update — [arXiv:2602.09138](https://arxiv.org/html/2602.09138v1)
- Context Rot（Chroma 2025）— [research.trychroma.com](https://research.trychroma.com/context-rot)
