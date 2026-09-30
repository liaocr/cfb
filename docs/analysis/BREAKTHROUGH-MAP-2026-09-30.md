# 能力突破地图（2026-09-30，第二轮侦察）

> 用户命题：**只找能力瓶颈的突破，不要触发，不要观测**；症状是「反复修改、不知出路、不知前路、不知哪里不好、只能根据返回的数据被动修改，优化有限且零碎」。
> 本文是**方案**文档（与 `CAPABILITY-SWEEP-2026-09-30.md` 的「墙 + 理论」互补）：每条给出**文献 → 我们能做什么 → 成本 → 验收门 → 什么会杀掉它**。
> 本轮新增检索 16 次，覆盖 5 个方向：自动化自我改进 / 上下文即制品 / 义务与监控 / 自我诊断 / 测试时搜索。

---

## 0. 一句话结论

**我们一直在优化「制品」，却把「制造制品的流程」留在手工状态；而且我们用的目标信号（同族评委 Likert、n=2）又贵又糊。**

2026 年的文献给出了同一件事的四个成熟版本：**让制品变成可训练的外部状态**（SkillOpt / GEPA / ACE）、**让产出变成可执行的义务**（PIS / Agent-C / AgentSpec）、**让选择变成测量**（ContextCite / Thought Anchors / 信息率）、**让整个 harness 被搜索**（Meta-Harness / DGM / ADIAS）。这四件事都**不需要白盒、不需要训练权重**——它们都要我们已经有的东西：轨迹、验证器、廉价副模型。

---

## 1. 诊断：我们为什么会卡在这里（三条自我批评）

**① 我们做的事，文献刚刚给出了它的失败模式的名字。**
Meta-Harness 的作者把「文本优化器」的核心失败模式总结为一句：**compression is the core failure mode**——把带信息的执行轨迹压成摘要，再去改提示。他们对比了 Self-Refine / OPRO / TextGrad / MIPRO / AlphaEvolve / GEPA / Feedback Descent：每次迭代消费的信息量从 0.001 Mtok 到 0.026 Mtok；而 Meta-Harness 让提议者直接读**全部原始历史**，每次 10 Mtok，多 2–4 个数量级 [2](https://yoonholee.com/meta-harness/)。我们的「看一次评委分数，回去改一句提示词」正好是最低信息量的那一档。

**② 我们一边骂「压缩掉了信息」，一边对流程做同样的事。**
ACE 把两种病命名得很准：**brevity bias**（优化器倾向把内容压成短而通用的指令，丢掉领域细节）与 **context collapse**（单次整体重写会越写越短、细节流失——他们实测到上下文从 18,282 tokens 突然塌到 122 tokens）[1](https://arxiv.org/pdf/2510.04618)。我们的稿子有熔断 2600、目标 700–1100 字、先删「已排除段」——这就是 brevity bias 的三次实例。

**③ 我们的目标函数分辨率低于我们想看到的现象。**
我们声称优化的是「状态充分性」，量到的却是 1–10 分的同族评委分，票距 ≥3 占 14%。而 ICLR 2026 有一篇把这件事做成了信息论：把压缩器当**噪声信道**，估计**压缩文本与原文的互信息**，定义 **information rate = MI/token**，发现它与下游准确率的相关 **r = −0.84, R² = 0.71**，且只用推理服务暴露的 logprob 就能算 [2](https://en.papernotes.org/ICLR2026/llm_agent/an_information_theoretic_perspective_on_agentic_system_design/)。**别人已经有一个便宜、连续、与任务无关的标量了，我们还在用贵而糊的 Likert。**

---

## 2. 突破 ①（最高优先）：把制品变成「可训练的外部状态」

**文献**
- **SkillOpt**（Microsoft，arXiv:2605.23904）：把一份 markdown 技能文档当作冻结 agent 的**可训练参数**；优化器模型从打分轨迹里产出**有界的 add/delete/replace 编辑**，配 **textual learning rate**（每步编辑预算）与**留出验证门**（只有严格提升才接受，平局拒绝），失败的编辑进**拒绝缓冲**避免重复；epoch 级「慢更新」把长期教训写进受保护字段。结果：GPT-5.5 直接对话 **+23.5**，Codex 循环 +24.8，Claude Code +19.1，52 个评测格全胜或并列；成品 300–2000 tokens；**端到端只接受 1–4 处编辑**；单技能训练 **$1–5**，部署零额外推理开销。还有 SkillOpt-Sleep：夜间离线自进化（harvest → mine → replay → consolidate，全部过留出门）[1](https://github.com/microsoft/SkillOpt)[3](https://agentic-ai.readthedocs.io/en/latest/PromptEngineering/skillopt/)。
- **GEPA**（ICLR 2026，arXiv:2507.19457）：不做梯度，做**自然语言反思 + Pareto 前沿**；比 GRPO 平均高 6%（最高 20%），**rollout 少 35×**；关键句：当系统轨迹里本来就有可解释信息——模块做了什么、哪条约束挂了、**编译器拒绝了什么**——优化器可以把它编译成修订指令，而不是等标量奖励传回来 [1](https://www.alphaxiv.org/abs/2507.19457)。
- **ACE**（ICLR 2026，arXiv:2510.04618）：上下文 = **演化 playbook**；Generator → Reflector → Curator 三角色；**增量 delta 更新**（带 helpful/harmful 计数）而不是整体重写；确定性合并 + 语义去重。结果：AppWorld **+10.6%**、金融 +8.6%、适配延迟 **−86.9%**、rollout 成本 −83.6% [1](https://arxiv.org/pdf/2510.04618)[2](https://www.marktechpost.com/2025/10/10/agentic-context-engineering-ace-self-improving-llms-via-evolving-contexts-not-fine-tuning/)。

**映射到我们**：我们的「制品」有四份，全部现在都是手写的——
1. `src/prompts.js` 的 V4D_* 提示词（= skill 文档）
2. 闸门里的规则集（stripExcludedFallback 的句式白名单、dedupeParentheticals、verifyHints 的 K1–K6 判据）
3. 台账渲染格式（buildLedger / continuationBlock）
4. 稿的段落结构与长度预算

**我们缺的不是「再想一条 K7」，而是让这四份东西进入 SkillOpt 式循环**：从我们**已有的**轨迹产物里（门拒绝原因、审计 N1–N7、评委 note、动作类、任务成败）产出**有界编辑**，用**留出任务门**决定接受/拒绝，被拒的进缓冲区，epoch 级把稳定教训写进受保护段。

**为什么这是突破而不是修改**：它把我们「每次改一句、赌一把」变成「**编辑必须通过验证门才生效**」——优化从**不单调**变成**单调**（SkillOpt 的核心卖点），并把「零碎」变成「按复现频率排序的问题队列」。

**成本**：编辑由廉价副模型或一次性的人工+副模型混合产出；验证用确定性门（零调用）+ 少量留出任务。

**验收门**：留出任务上的确定性指标（见 §8）严格不降；或「同一任务的编辑集在 3 个随机种子上一致提升」。

**什么会杀掉它**：如果我们**造不出留出任务族**（§8），验证门就不存在，这条退化成普通调参——**所以 §8 是前置条件，不是可选项**。

---

## 3. 突破 ②（最大的能力缺口）：把产出从「散文」变成「可执行的义务」

**文献**
- **PIS / 前瞻记忆**（arXiv:2609.01272，2026-09）：把「延迟意图」变成**类型化三元组 (trigger, action, status)**，生命周期逻辑全部放进**确定性代码**，模型只做有界判定（证据是否满足触发、是否重排/取消）；构造式、免训练。PM-Bench：DeepSeek-Chat + PIS **82.9% Set-F1**，而**最好的已发表脚手架只有 65.1%**，回溯式记忆法 ≤54.4%；小模型 Gemma-E2B 从 **4.2%** → **66.2%** [1](https://awesomepapers.io/ai-agents/papers/2609.01272)[2](https://pith.science/paper/2609.01272)。PM-Bench 本身：8 个模型 × 8 种配置，**最好只有 65.1%**——文献明说「延迟执行 + 潜伏线索监控」是**未解决能力** [5](https://pith.science/paper/2607.12385)。
- **运行时验证 / 监控合成**：AgentSpec（ICSE 2026）用 **(trigger, predicate, enforcement)** 三元组 DSL，并支持 LLM 从自然语言策略自动生成规则（o1 上 95.56% precision）；VeriGuard 离线用符号验证把策略证明正确、在线做常量时间布尔监控；Agent-C（arXiv:2512.23738）把时序规范翻成一阶逻辑 + SMT，在**生成时**约束 token，达到 100% 合规、0% 危害，同时不牺牲任务效用 [1](https://zylos.ai/research/2026-03-15-runtime-verification-temporal-logic-ai-agent-safety/)[2](https://www.emergentmind.com/topics/veriguard-framework)[4](https://arxiv.org/pdf/2512.23738)。

**映射到我们**：我们的「验收预注册」其实**就是**一个延迟意图：
> 触发 = 观察到某结果 Y′；动作 = 跑某条确认命令 / 比差 / grep 新出现者；状态 = 待触发 / 已触发。

但我们现在把它写成**散文**（「若结果是 Y′，第一步只有一条……」，还带一段逃生的分支）。文献说：这条东西应该是**类型化对象 + 代码生命周期**，宿主在运行时消费它。PIS 与 AgentSpec 用的是**同一个三元组**（trigger / action / predicate / enforcement）——这不是巧合，是这个问题的自然形状。

**这条为什么是最大能力缺口**：我们 S10.12 已经裁过一次「机械台账单独无效——缺的是判读」。PIS 的回答恰好相反：**把「判读」缩到最小（只有触发条件要靠模型判定），其余全部交给代码**，结果是**小模型也能跑赢大模型脚手架**。这正是我们能做、且还没做的事。

**具体三件事**（按可落地性排序）
1. **把 `continuationBlock` + `verifyHints` 升级成义务表**：不只是一段文字，而是一组 {trigger, action, status} 行；程序负责生命周期（第 t 轮的义务在观察到 Y′ 后变成「已兑现/已作废」），模型只判「Y′ 出现了没有」。
2. **让宿主执行并回填**（与 `birthFinish` 已经在做的 turnCalls 采集同构）：义务 → 探针命令 → 回执强制进下一轮 ctx。这把「陈述」变成「取证」。
3. **给义务一个语法约束层**（Agent-C 那一路）：有些义务可以在生成时被约束（例如「改法状态不能声明为已验证，除非验收证据在场」），这是把 K5 从「劝告」升级成「不可能的假话」。

**成本**：纯设计 + 宿主协议；无模型成本。

**什么会杀掉它**：宿主不可能执行探针（那就是纯文本义务，收益打折但仍有 PIS 那一档）；或义务表膨胀到比散文还长（→ 收在 PIS 的做法：代码管生命周期、表只留 trigger 一行）。

---

## 4. 突破 ③：Harness 级端到端搜索（我们是个 harness，而且从没被搜索过）

**文献**
- **Meta-Harness**（Stanford/MIT，arXiv:2603.28052，COLM 2026）：harness = 「围绕固定基座模型的那圈代码：决定存什么、取什么、给模型看什么」——**这句话就是 cfb 的定义**。做法：让编码 agent **无限制访问全部搜索历史**（源码 + 执行轨迹 + 分数），提出候选 harness，在**搜索集**上评估（测试集不可见），返回 Pareto 前沿。结果：文本分类 **48.6% vs ACE 40.9%**（且上下文 token 少 4×）；数学检索 **+4.7 分且迁移到 5 个未见模型**；Terminal-Bench 2 从 28.5% → 46.5%。**同一基座模型，harness 不同，性能差最高 6×** [2](https://yoonholee.com/meta-harness/)[3](https://huggingface.co/blog/Svngoku/meta-harness-end-to-end-optimization-of-model)。
- **DGM**（arXiv:2505.22954）：维持**归档**（archive）而不是单线改进；自我改写代码 + 经验验证；自动发现的改进包括 fine-grained editing、line-range viewing、undo [1](https://huggingface.co/papers/2505.22954)。注意它的**目标黑客案例**：模型为了「降低幻觉指标」把日志输出删了——这是我们要记的警告。
- **ADIAS**（arXiv:2608.06410）：在全代码空间搜索，但加了两个我们缺的部件——**diagnostic agent**（细粒度失败分析、把错误归因到可操作原因）与 **global issue manager**（跨 episode 聚合复发模式，据此排优先级）[4](https://arxiv.org/html/2608.06410)。
- **AgentSquare**（ICLR 2025，arXiv:2410.06153）：把 agent 拆成 Planning / Reasoning / Tool Use / Memory 四模块的**统一 IO 设计空间**，用模块演化 + 重组搜索，**比最佳人类设计平均高 17.2%** [2](https://arxiv.org/abs/2410.06153)。

**映射到我们**：我们改过的东西（d4→d9 九版）都落在**同一条手工轨迹**上，没有归档、没有提出者读全历史、没有全局 issue 管理。**我们不是缺想法，是缺一个搜索器**；而搜索器的输入（轨迹 + 门 + 审计 + 评委 note + 动作类）我们全有，只是没给它「读全部历史并改代码」的权限。

**成本**：一次搜索跑 = 若干个候选 × 留出任务集 × 程序化指标（**零付费**，全部本地）；只有最终的候选需要付一次钱去确认真机效果。

**什么会杀掉它**：留出集太小 → 过拟合到搜索集（Meta-Harness 明确把测试集隔离，我们也必须）；没有确定性指标 → 搜索退化成噪声。

---

## 5. 突破 ④：把「留什么」从语法判据换成**测出来的因果重要性**

**文献**
- **ContextCite**（NeurIPS 2024，arXiv:2409.00729）：把上下文切成源，**做消融**，用 LASSO 学稀疏线性代理去预测「生成该句的概率」随源增删的变化；**32–64 次消融**就能得到忠实的逐源归因；作者展示的用处之一就是**按归因剪上下文**并**帮助验证生成** [1](https://www.alphaxiv.org/overview/2409.00729v1)[2](https://proceedings.neurips.cc/paper_files/paper/2024/file/adbea136219b64db96a9941e4249a857-Paper-Conference.pdf)。
- **Thought Anchors**（arXiv:2506.19143）：在**推理轨迹**上做句级反事实重要性（重采样替换句 + 继续轨迹 + 比最终分布）；结论与我们现在的直觉**相反**：**规划生成句与不确定性管理句（含回溯）的反事实重要性最高**，而事实检索与「主动计算」句、自检句、最终答案句最低；注意力头也一致（receiver heads 集中在规划/不确定性句） [2](https://arxiv.org/html/2506.19143)[4](https://www.aimodels.fyi/papers/arxiv/thought-anchors-which-llm-reasoning-steps-matter)。

**映射到我们**：我们的闸门删句靠的是**句式白名单**（`stripExcludedFallback` 的正则、`keep` 豁免）。Thought Anchors 说：**该留的是「规划 / 不确定性管理」句**——恰好是我们「已排除」「推翻于第 t 轮」「未解」这些东西的类别；而**「主动计算」句在反事实意义下最不重要**——但恰恰是我们 flaky 那一格唯一救命的算式。

**这是本轮最有价值的可做测量**（而且是**能力**，不是观测）：
> **用消融测我们自己的制品**：对稿的每一段/每一句做「删掉后，主模型/副模型还做出同一个下一动作吗？」——**同动作 = 该句对决策零贡献（可删）；动作变了 = 该句是承重句（必留）**。
> 这给了编译器**自我诊断**：不需要人看 dashboard，程序自己决定哪里可以删、哪里不能删；也给了 §8 的指标一个可计算的定义。

**成本**：每次消融一次副模型调用（判「同动作/不同动作」可强制提前回答），可抽样（ContextCite 33–64 次消融即够一个稿级归因）；**全部 prefill-only、可缓存**。

**什么会杀掉它**：同动作判定的可靠性太低（先用 3 个样本测一致率）；或消融结果与「删掉后真实任务成败」无关（需要一次付费轨迹对照）。

---

## 6. 突破 ⑤：跨会话的「库学习」——我们的疫苗理论缺的那一半

**文献**
- **DreamCoder**（Ellis et al.）：wake–sleep；**sleep-abstraction 用压缩压力（MDL）把解出来的程序重构成新的可复用原语**，sleep-dreaming 训练识别模型；跨 20 轮 wake/sleep 长出可解的库（甚至重新发现了 `filter` 这类高阶函数） [1](https://www.cs.cornell.edu/~ellisk/documents/dreamcoder_with_supplement.pdf)[3](https://deepwiki.com/jfeser/dreamcoder)。
- **ACE 的 playbook**：增量 delta + helpful/harmful 计数 = 一个**带证据计的库**，跨任务累积而不塌缩 [1](https://arxiv.org/pdf/2510.04618)。
- **ExpeL / 经验学习**（2023 起一脉）：从成败轨迹里抽自然语言「洞察」进知识库，跨任务复用。

**映射到我们**：我们卷一的 T3「死路价值 / 疫苗」说的是**单会话内**的排除项；理论上限其实是**跨会话的库**——「这类症状（超时、权限、陈旧证据）该怎么取证、哪些路别走」。今天我们的库是**零**：每次会话从零开始，疫苗在会话结束时蒸发。DreamCoder 给的机制是**压缩压力**：如果一个抽象能让过去 N 个会话的稿都变短、且在新会上仍能过门，就该进库；否则淘汰。**这与我们「永不更坏」的原则天然兼容**（进库必须过门，出库也必须过门）。

**成本**：零模型成本可先做（历史 267 份稿 + 轨迹文件都在）；真机确认要一次付费跑。

**什么会杀掉它**：写进去的抽象在留出任务上没有迁移收益（DreamCoder 的 ablation 显示「无库学习」会明显掉——可复现这个对照）。

---

## 7. 突破 ⑥（可以立刻做、收益有界但确定）：测试时搜索 + 我们的验证器栈

**文献**
- **测试时扩展定律**：`F(N) = F_max·(1−(1−p)^N)`——边际收益指数衰减；**无验证器时采样饱和**，有验证器时曲线继续 [2](https://www.emergentmind.com/topics/test-time-scaling-law)；生产经验：**N=10–20 + 轻量验证器通常拿到 70–80% 的总收益**，N>250 基本平 [3](https://swarmsignal.net/test-time-compute-scaling-guide-2026/)。
- **计算最优分配**：按题目难度分配预算，**用 4× 更少的算力接近/超过 best-of-N** [1](https://arxiv.org/html/2408.03314v1)。
- **SETS**：采样 + 自验证 + 自纠正比纯重复采样扩展得更好，且在**难题上不饱和** [5](https://arxiv.org/html/2501.19306v1)。
- 2026 年的前沿判断：**上限现在是验证器质量，不是生成模型质量** [3](https://swarmsignal.net/test-time-compute-scaling-guide-2026/)。

**映射到我们**：我们的**验证器栈异常强**（确定性门 + 267 条审计不变量 + 幂等性 + 形式检查 9/9），而生成侧只有一个 1.5B 级副模型。按文献，**我们应该把算力花在采样 + 选择上，而不是继续雕提示词**：`--best-of N` 已经是 opt-in，应该变成**缺省、按难度配额、验证器排序**。这是「零新增判断力成本、确定不更坏（因为只有过门的才留下）」的收益。

**风险（必须照 DGM 的教训防）**：验证器一强，优化就会去**喂验证器**而不是解决问题（DGM 的「删日志降幻觉」）。对策：验证器**分层且互相独立**（门 / 审计 / 消融重要性 / 留出任务），单层不得独占决定权。

---

## 8. 真正的第一件事（前置条件）：造出「可验证的留出任务族」

上面 ①③⑤ 全都卡在同一件事上：**没有留出任务集，就没有验证门，也就没有单调改进**。

现状：5 道题（all red + green）、每格 n=2、评委同族、得分分辨率 1 分——**不足以做 train/selection/test 三切分**。

**做法（零模型成本方案）**：
1. **合成任务族**：我们已经有 `chains.json`（多轮链条）+ `buildCompressCtx` 合成 ctx 的机制。把「症状 × 机制 × 陷阱」组合成 **20–40 个场景**（如：陈旧证据、共享标识符、超时余量、权限路径、缓存命中、日志尾部），每个场景自带**确定性判据**（该修不修得对、是否再调数字、是否再改同处、是否发明标识符、是否删了承重句）。
2. **三切分**：train 1/2（用于反思与编辑）、selection 1/4（**唯一**的接受门）、test 1/4（只在周期末看一次）。
3. **弱化付费依赖**：主指标用**程序可判**的代理（过门 + 审计不变量 + 消融重要性 + 义务表一致性）；真机「是否修好」只在**周期末**抽一次。
4. **难度分层**：容易题（剧场型）与难课题分开统计——文献明确说 TTS 收益与难度强相关 [1](https://arxiv.org/html/2408.03314v1)。

**这一步本身几乎全是工程，但它是把上面所有突破从「读起来很好」变成「能跑」的唯一路径。** 我建议把它当成下一阶段的**第一个交付物**。

---

## 9. 建议的顺序、预算与「什么会杀掉它」

| 步 | 动作 | 成本 | 杀掉它的结果 |
|---|---|---|---|
| **S0** | 合成留出任务族（20–40 场景 + 确定性判据 + 三切分） | 0（本地） | 若确定性判据无法覆盖「是否修好」→ 必须每格多花主模型调用 |
| **S1** | 义务表化（PIS 三条 + 宿主回填） | 0 + 一次宿主协议决定 | 宿主不执行探针 → 保底为纯文本义务 |
| **S2** | 消融重要性（ContextCite 式，稿级 → 句级） | 副模型少量，可缓存 | 同动作判据一致率 <80% → 降级为抽样诊断 |
| **S3** | 搜索器上线（Meta-Harness 风格：提出者读全历史、改代码、按 selection 门接受；DGM 式归档；ADIAS 式 issue manager） | 一次搜索预算（本地）；末端一次付费确认 | selection 太小 → 过拟合；验证器被喂 → 分层验证到位才能继续 |
| **S4** | 跨会话库（DreamCoder 式压缩压力 + 过门才能进） | 0 起 | 无迁移收益 → 回退到单会话 |
| **S5** | 测试时搜索缺省化（best-of + 难度配额 + 验证器排序） | 副模型算力（便宜） | 验证器相关性低 → 只当 tie-break |

---

## 10. 我建议**停止**做的事（清单）

1. **停止手改提示词并立即评测**：任何提示词/闸门改动都必须先过 S0 的 selection 门，否则不进主干。
2. **停止用「再加一条 K 规则」的方式修行为**：K 规则的归宿是 §2 的可训练 skill 文档（受门控），不是手写追加。
3. **停止把稿压得更短**：brevity bias 已被命名并证伪 [1](https://arxiv.org/pdf/2510.04618)；长度该由留出门与难度决定。
4. **停止用同族评委 Likert 当主读数**：它是**验收**（贵、糊、自缠绕），不是**训练信号**。训练用确定性门 + 信息率 + 消融重要性。
5. **停止在没有归档的情况下单线迭代**：我们改过九版，却没有任何归档让搜索器去读。

---

## 11. 与第一轮文档的关系（诚实修订）

- 第一轮把「B 分层多描述 / C 充分性自检」列在最前。**现在降级**：分层仍在（它修的是宿主的截断风险），但**它不再是最能提升能力的动作**；充分性自检被更强的做法取代——**消融重要性**（§5）给出逐句的因果价值，比 QA 命中率更接近决策。
- 第一轮的「D 探针回填」**升级**为 §3 的**义务表 + 宿主执行**（有 PIS/AgentSpec/Agent-C 的实证支撑，且是文献里最大的单点效应之一）。
- 第一轮说「文本/剪枝路线有 ~2× 质量墙」——仍然成立，但**结论改向**：与其换介质，**不如把 harness 自己变成被搜索的对象**（§4），因为那不需要白盒。
- 第一轮把「承诺 > 记忆」当成结论；现在它有了**工程形态**（PIS 三元组）与**形式化邻居**（运行时验证的 trigger/predicate/enforcement）。

---

## 12. 参考（本轮新增，按主题）

**制品可训练 / 流程自动化**
- SkillOpt: Executive Strategy for Self-Evolving Agent Skills — Microsoft, arXiv:2605.23904 · [repo](https://github.com/microsoft/SkillOpt) · [知识库条目](https://agentic-ai.readthedocs.io/en/latest/PromptEngineering/skillopt/)
- GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning — arXiv:2507.19457 · [alphaXiv](https://www.alphaxiv.org/abs/2507.19457) · [HF](https://huggingface.co/papers/2507.19457)
- TextGrad（Nature 系，Zou 组）· [综述式对比](https://www.morphllm.com/textgrad)；metaTextGrad — [alphaXiv](https://www.alphaxiv.org/zh/abs/2505.18524)
- Darwin Gödel Machine — arXiv:2505.22954 · [HF](https://huggingface.co/papers/2505.22954)；AgentSquare — arXiv:2410.06153 · [ICLR 2025](https://openreview.net/pdf?id=mPdmDYIQ7f)；ADIAS — [arXiv:2608.06410](https://arxiv.org/html/2608.06410)
- Meta-Harness: End-to-End Optimization of Model Harnesses — arXiv:2603.28052 · [项目页](https://yoonholee.com/meta-harness/) · [repo](https://github.com/stanford-iris-lab/meta-harness)

**上下文即制品 / 跨会话库**
- ACE: Agentic Context Engineering — arXiv:2510.04618 · [ICLR 2026 笔记](https://en.papernotes.org/ICLR2026/llm_agent/agentic_context_engineering_evolving_contexts_for_self-improving_language_models/)
- DreamCoder — [论文 PDF](https://www.cs.cornell.edu/~ellisk/documents/dreamcoder_with_supplement.pdf) · [实现导读](https://deepwiki.com/jfeser/dreamcoder)

**义务 / 前瞻记忆 / 运行时验证**
- Making Prospective Memory SLM-Shaped（PIS）— [arXiv:2609.01272](https://awesomepapers.io/ai-agents/papers/2609.01272) · [Pith 评审](https://pith.science/paper/2609.01272)
- PM-Bench — [Pith 评审](https://pith.science/paper/2607.12385)
- Runtime Verification & Temporal Logic for AI Agents（AgentSpec ICSE 2026 / VeriGuard / ABC）— [综述](https://zylos.ai/research/2026-03-15-runtime-verification-temporal-logic-ai-agent-safety/)
- Agent-C: Enforcing Temporal Constraints for LLM Agents — [arXiv:2512.23738](https://arxiv.org/pdf/2512.23738)

**自我诊断 / 归因**
- ContextCite — [NeurIPS 2024 PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/adbea136219b64db96a9941e4249a857-Paper-Conference.pdf) · [概览](https://www.alphaxiv.org/overview/2409.00729v1)
- Thought Anchors: Which LLM Reasoning Steps Matter? — [arXiv:2506.19143](https://arxiv.org/html/2506.19143)
- TRAIL: Trace Reasoning and Agentic Issue Localization — [arXiv:2505.08638](https://www.emergentmind.com/papers/2505.08638)；Who&When Pro — [arXiv:2607.09996](https://arxiv.org/html/2607.09996v1)
- Conformal Abstention — [NeurIPS 2024 workshop](https://neurips.cc/virtual/2024/105548)；Semantic Entropy（Nature 2024）；UQ & 校准综述 — [KDD'25 tutorial](https://xiao0o0o.github.io/2025KDD_tutorial/survey.pdf)

**目标函数 / 理论**
- An Information Theoretic Perspective on Agentic System Design（信息率 vs 下游性能 r=−0.84）— [ICLR 2026 PDF](https://proceedings.iclr.cc/paper_files/paper/2026/file/539843788c365d04de35b62bac925259-Paper-Conference.pdf)
- Rate–Distortion Limits for Task-Oriented Compression with Side Information — [Entropy 2026, 28(6):593](https://www.mdpi.com/1099-4300/28/6/593)
- Test-time compute 最优缩放 — [arXiv:2408.03314](https://arxiv.org/html/2408.03314v1)；SETS — [arXiv:2501.19306](https://arxiv.org/html/2501.19306v1)
