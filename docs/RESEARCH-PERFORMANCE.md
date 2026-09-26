# 提升主模型表现：第四轮多角度调研与排序方案（v11.12.1，仅文档）

> 主线：cfb 能改写的只有「主模型每段 reasoning 出生时变成什么文本」（外加副模型、CAS 句柄、pre-step 钩子）。
> 本文回答：**在这个杠杆上，怎样让主模型下一步做得更好**，而不只是更省钱。
> 与 [`RESEARCH-COT-SHAPING.md`](RESEARCH-COT-SHAPING.md)（前三轮、S1–S9、§10 x1 实现）不重复；本轮新增 30+ 篇来源，从 7 个角度检索。
> 诚实声明放前面：**没有任何论文直接测过「把思考型模型的历史思维链在 API 层压缩后回灌」**。下面的原则是把相邻证据拼起来推出来的，
> 每一条都给了用 `tools/cf-eval.mjs` 验证的办法。

---

## 0. 结论先行

1. **表现 = 去噪收益 − 离策略代价。** 删掉冗余、过期、被否定的内容能让模型变好（上下文长度本身就伤表现 13.9–85%；R-KV 只留 16% 反而达到 105%）；
   但把模型自己的 token 换成别人写的转述要付代价（转述草稿 −3~4%；只留“可读部分”错误率 +36%；Memento 只留摘要文本 −15pp）。
   ⇒ **逐字抽取（x1）在表现上应当优于改写式摘要（v3）**，不只是更便宜。这是本轮最重要的判断，也是需要最先验证的一条。
2. **历史里最有害、也最可压的是「死分支」。** 历史中的错误会诱发更多错误（self-conditioning），目标漂移的主因是对上下文行为的模式模仿而不是距离；
   失败轨迹更长、充满重复动作。⇒ 被否定/放弃的探索支线**折叠成一句「此路不通 + 原因」**，比「整段保留并贴 ⟨已否定⟩ 标签」更好、也更省。
3. **状态要替代，不要叠加。** SKILL.state：只留显式状态 54.2%，ReAct 46.4%，**状态 + 完整历史反而 41.8%**。⇒ `[状态]` 行只写正文里没有的新信息。
4. **越可逆越敢压。** 删掉的内容能按句柄取回时，激进压缩几乎无风险；而「模型去取回的频率」是一个免费的在线过压缩探针。
5. **cfb「只能在出生时写」的约束恰好是缓存最优形态**（前缀永不改写）。不要去改旧块；跨块整合用「新块声明取代旧结论」来做。

---

## 1. 七个角度的证据

### A. 保留思维链是模型**训练出来的通道**，不能断

| 发现 | 数字 | 来源 |
|---|---|---|
| ARC Prize：Provider Adapter 在请求间保留不透明推理状态 + 用原生压缩 | max 档 62.7% → 98.6%；high 档 54.8% → 99.9%；none 档 35.2% → 96.7%；快 3.66×、token −49% | [ARC Astra](https://arcprize.org/blog/astra) |
| OpenAI：Responses API 回传 reasoning items | TAU-bench +5%、SWE-bench +3%，缓存利用率 40% → 80% | [OpenAI cookbook](https://cookbook.openai.com/examples/responses_api/reasoning_items) |
| DeepSeek-V4：带工具时**所有轮次的 reasoning 完整保留，跨用户消息也保留**（V3.2 在新用户消息时丢弃）；无工具对话仍丢弃 | — | [V4 技术报告 §5.1.1](https://arxiv.org/html/2606.19348v1)、[HF 博客](https://huggingface.co/blog/deepseekv4) |
| Claude Opus 4.5+/Sonnet 4.6+ 保留全部历史 thinking；GLM-4.7 推荐 Preserved Thinking 用于 τ²/Terminal/SWE | — | [Claude docs](https://platform.claude.com/docs/en/build-with-claude/thinking) |
| 删掉前轮 CoT 后，非 RL 模型干脆不再用 CoT；RL 思考模型基本免疫 self-conditioning | — | [Illusion of Diminishing Returns, 2509.09677](https://arxiv.org/abs/2509.09677) |

**对 cfb 的含义**：DSH 是带工具的 agent，在 V4 上历史 reasoning **全部**留在上下文里，而且模型是**带着自己的原始 reasoning 被 RL 训练**的。
cfb 的每一次替换都在把这条通道推离训练分布。所以问题不是「要不要保留」，而是「怎样在去噪的同时，尽量不离开模型自己的分布」。
（另：cfb 在 `birth.js` 已记录「DeepSeek API 只查 reasoning_content 字段存在」；第三方博客称「截断/摘要的 reasoning 在部分版本会被拒」，与 cfb 实测不符，但换模型版本时应回归一次。）

### B. 离策略代价：换掉模型自己的 token 要付钱

| 发现 | 数字 | 来源 |
|---|---|---|
| 用转述过的草稿蒸馏 | 约 −3~4% | [Illegible CoT, AF 帖](https://www.alignmentforum.org/posts/GKyyYCs8n2goDcAe2/reasoning-models-sometimes-output-illegible-chains-of) |
| QwQ 只给它自己 CoT 里“可读”的部分 | 错误答案 +36% | 同上 |
| Memento：块被压成摘要后，若摘要只剩文本（重算 KV、丢掉隐式通道） | AIME24 66.1% → 50.8%（−15pp） | [Memento 2604.09852](https://arxiv.org/abs/2604.09852)、[MSR 博客](https://www.microsoft.com/en-us/research/articles/memento-teaching-llms-to-manage-their-own-context/) |
| 模型几乎察觉不到自己的 CoT 被改（删掉后半段也只略高于随机），对自己的和别人的 CoT 一样 | — | [Can Reasoning Models Detect Changes to their CoT, 2606.22085](https://arxiv.org/abs/2606.22085) |
| 注入到推理中间的正确解常被模型忽视/推翻（尤其以 “Alternatively,” 引出时） | — | [LRMs are not thinking straight, 2507.00711](https://pith.science/paper/2507.00711) |

**含义**：
- API 场景下 Memento 的「隐式 KV 通道」**一定会丢**（下一次请求从文本重算 KV），所以压缩后留下的文本必须自己扛住全部信息——**转述越多，丢得越多**。
- 模型不会“起疑”，所以风险不在于它发现被改，而纯粹在信息与分布。
- 往历史里补写纠错时（S3 勘误），**不要写成模型自己的“另一种想法”**，要写成带出处的工具证据。

### C. 去噪确实能**提升**表现（不只是省钱）

| 发现 | 数字 | 来源 |
|---|---|---|
| 仅上下文变长就掉分，即使完美检索、干扰全换成空白或被 mask | −13.9% ~ −85%；先复述证据再答 +4%（RULER, GPT-4o） | [Context Length Alone Hurts, 2510.05381](https://arxiv.org/abs/2510.05381) |
| Chroma：18 个前沿模型全部随输入变长退化，且非线性、有断崖 | — | [Context Rot](https://research.trychroma.com/context-rot) |
| R-KV：按冗余度淘汰推理 KV | 留 10–34% 无损；留 16% 达到 105% | [R-KV 2505.24133](https://arxiv.org/abs/2505.24133) |
| Step Entropy：删掉 80% 低熵步骤（≈40% token）准确率不变；删高熵步骤立即掉分 | — | [2508.03346](https://arxiv.org/abs/2508.03346) |
| InftyThink：分段推理 + 摘要，把冗余探索和错误分支滤掉；用**外部**摘要替换自生成摘要，AIME24 29.48% → 32.40% | InftyThink：Qwen2.5-Math-7B AIME24 +11%；InftyThink+（RL）：1.5B 模型 AIME24 +21% | [InftyThink+ 2602.06960](https://arxiv.org/abs/2602.06960) |
| AgentFold：把 10+ 步失败尝试合并成一句“此路不通”；100 轮后上下文 7k vs ReAct 91k；30B 超过 671B | BrowseComp 36.2 vs 30.0 | [AgentFold 2510.24699](https://arxiv.org/abs/2510.24699) |
| Context-Folding：主动折叠子任务，活动上下文小 10×，优于摘要式基线 | — | [Context-Folding](https://liner.com/review/scaling-longhorizon-llm-agent-via-contextfolding) |
| Observation masking（保留推理和动作，只把旧工具输出换占位符）与 LLM 摘要持平或更好，成本减半；摘要会**掩盖失败信号**导致 agent 在无效循环里打转 | — | [Complexity Trap 2508.21433](https://arxiv.org/abs/2508.21433) |
| AgentDiet：删掉无用/冗余/过期信息 | 输入 token −40~60%，成本 −21~36%，解决率不降 | [AgentDiet 2509.23586](https://www.emergentmind.com/papers/2509.23586) |
| Anthropic context editing / + memory；DeepSeek-V3.2 在 80% 满时 discard-all | +29% / +39%；BrowseComp 53 → 68 | [Anthropic](https://claude.com/blog/context-management)、[Baseten](https://www.baseten.co/blog/deepseek-v3-2/) |

**含义**：删「对后续没用的东西」会让模型变好——前提是删对。高熵的决策点（转折、决定、发现）不能删；低熵的铺陈可以大胆删。

### D. 错误和失败在历史里起什么作用

| 发现 | 来源 |
|---|---|
| **Self-conditioning**：历史里的错误让后续更容易出错，约 20% 错误率开始级联；扩规模不解决 | [2509.09677](https://arxiv.org/abs/2509.09677) |
| **目标漂移主要来自对上下文里行为样例的模式模仿，而不是 token 距离**（把中间段换成等长单 token → 漂移小；换成随机句 → 漂移大） | [Goal Drift 2505.02709](https://arxiv.org/abs/2505.02709) |
| 多轮对话平均 −39%：过早给解、过度依赖自己先前的错误答案；recap/snowball 只能挽回 15–20% | [Lost in Multi-Turn 2505.06120](https://arxiv.org/abs/2505.06120) |
| 失败轨迹比成功轨迹长 12–82%，方差更大；典型反模式：重复相同动作无跟进、连续改代码不测试 | [2511.00197](https://arxiv.org/abs/2511.00197)、[2506.18824](https://arxiv.org/abs/2506.18824) |
| 2,500 条 SWE-bench 轨迹：**search loop** 是最稳定的失败信号 | [TraceProbe 2607.06184](https://arxiv.org/html/2607.06184) |
| 单个根因错误沿轨迹传播；记忆/反思类错误是常见源头；只修根因即可 +26% | [AgentDebug 2509.25370](https://arxiv.org/abs/2509.25370) |
| SKILL.state：显式维护「已测试假设」清单防止重复失败命令 | [SKILL.state](https://www.alphaxiv.org/abs/2608.26263) |

**含义**：一段被否定的探索留在历史里，同时是（a）会被模式模仿的“错误示范”，（b）self-conditioning 的来源，（c）占 token 的噪声。
但**“它被否定了”这件事本身**是防止重走旧路的关键信息（摘要把它弄丢 → 循环）。所以：**保留结论与原因，删掉过程。**

### E. 想太多 / 想太少

| 发现 | 来源 |
|---|---|
| Agent 场景的 overthinking（分析瘫痪、一次发多动作、不验证就收工）与失败强相关；选 overthinking 分低的解 **+~30% 表现、−43% 成本**；推理模型比非推理模型更严重 | [Danger of Overthinking 2502.08235](https://arxiv.org/abs/2502.08235) |
| Underthinking：错误回答里**大多含有一个正确思路，但被过早放弃**；频繁切换思路与答错相关 | [2501.18585](https://arxiv.org/abs/2501.18585) |
| CoT 长度与准确率呈倒 U，模型越强最优长度越短；RL 会把长度校准到最优 | [When More is Less 2502.07266](https://arxiv.org/abs/2502.07266) |

**含义**：历史 reasoning 同时是**风格示范**（D 的模式模仿）。x1 目前在 explore 块**强制保留所有转折句**——这是为了保住信息峰值（思维锚点），
但一串“等等/不对/换个思路”也在示范“频繁切换”。解法不是删转折，而是：**死分支里的转折随分支一起折叠**；只保留最终导向决定的那次转折。
另外，**被放弃但没被证伪**的思路应当标出来（⟨搁置⟩），给模型一个回头的机会，对冲 underthinking。

### F. 状态、复述与目标锚定

| 发现 | 来源 |
|---|---|
| **SKILL.state：只留显式状态 54.2%，ReAct 46.4%，状态 + 完整历史 41.8%**（叠加反而最差） | [SKILL.state](https://www.alphaxiv.org/abs/2608.26263) |
| Anthropic 长时 agent：progress 文件 + JSON 功能清单；模型不太会乱改 JSON；“压缩本身不够” | [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) |
| 先复述证据再作答 +4%；recap 挽回 15–20% 多轮损失 | 见 C、D |

**含义**：状态行的价值在于**替代**被删掉的东西，而不是在保留的原文后面再抄一遍。重复 = 更长 + 两个版本互相竞争注意力。

### G. 可逆性：删了还能取回

| 发现 | 来源 |
|---|---|
| RLM：把长上下文当变量放在环境里、按需窥视，长上下文任务最高 2× 表现，成本相当或更低 | [RLM 2512.24601](https://arxiv.org/abs/2512.24601) |
| Manus：可恢复的压缩（保留 URL/路径，内容可再取）；ReadAgent：要点 + 按需翻回原页 | 见 `RESEARCH-COT-SHAPING.md` §9 |

**含义**：cfb 已有 CAS 句柄且已验证可读回（`handle-probe.js` 的 `readRangeByHandle`）。只要主模型侧确有按句柄读取的工具，就可以压得更狠。

---

## 2. 综合：五条原则（这是本轮自己的推论，不是任何一篇论文的结论）

**① 表现 = 去噪收益 − 离策略代价，逐字抽取把两项同时做到最优。**
C 组说明“删对了会变好”；B 组说明“换成转述会变差”，并且 API 场景没有 Memento 的隐式通道来兜底。
v3（改写式摘要）拿到了去噪收益，但付了全额离策略代价；x1（逐字抽取）拿到去噪收益，离策略代价只剩“句子之间缺了东西”。
⇒ **预测：同等压缩率下 x1 的 successRate ≥ v3。** 若 cf-eval 证实，x1 就是“又好又省”，而不是“省钱但担风险”。

**② 负知识要折叠，不要保留过程。**
死分支 = 最大块的噪声 + 错误示范 + self-conditioning 源；但“此路不通”本身防循环。
AgentFold 的“把失败尝试合并成一句教训”和 Complexity Trap 的“摘要丢失败信号 → 循环”恰好是一枚硬币的两面：**过程删、结论留、原因留。**

**③ 状态替代正文，不叠加。**（SKILL.state 的 41.8%）

**④ 可逆性决定压缩上限；取回率是过压缩的免费探针。**
模型主动按句柄取回 ⇒ 刚才删多了。这个信号不需要任何标注，可以按块类型在线统计，反过来调 keep 比例（闭环）。

**⑤ 顺着宿主的约束走，而不是对抗。**
cfb 只能在出生时写、不能改旧块——这正是 AgentFold 与 Manus 强调的“前缀不变、缓存可复用”。跨块整合不去改旧块，而是在新块里写
“取代 seqK 的结论：……”（带出处），并依赖近因效应让最新块占上风。

---

## 3. 排序方案（按「对表现的预期收益 / 实现成本 / 风险」）

价格影响以 v3 为基准（v3 ≈ +5% 总成本；见 `ECONOMICS-V11.11.md` 与上一轮 x1 定价表）。

### P1 死分支折叠（x1 升级 · 核心）
- **做什么**：副模型额外输出 `branches: [{from, to, status: refuted|abandoned|parked, head, why}]`。拼装时：
  - `refuted`（有工具证据）/ `abandoned`（主模型自己写了“不对/不行/放弃”，`why` 必须在原文逐字出现）⇒ 只留 `head`（假设句）+ `why`（否定原因句），
    分支内部句子（含其中的转折句）全部删去，句末标 `⟨已否定·seqN⟩` 或 `⟨自否定⟩`；
  - `parked`（没被证伪就被放下）⇒ 留 `head`，标 `⟨搁置⟩`。
- **为什么**：D、E 组；AgentFold 的失败折叠。`abandoned` 用主模型**自己的原话**做证据，不依赖工具证据索引 ⇒ 关掉 `extractiveEvidence` 也能用。
- **价格**：删掉的正是块里最长的部分 ⇒ keep 比例下降，**比现在更便宜**。
- **风险**：分支边界判错会删掉有用推理 ⇒ 硬校验：分支内若含标识符（`hardIdentifiers`）且该标识符在分支外未出现，则保留该句。

### P2 失败信号强制保留（x1 · 低成本）
- **做什么**：把错误特征（`Error`、`Traceback`、`exit code`、`失败`、`报错`、`not found`、`permission denied`、`timeout` 等）加入修复规则：
  含这类特征且提到具体对象的句子视同标识符句，必要时补回。
- **为什么**：Complexity Trap（丢失败信号 → 循环）、TraceProbe（search loop 最稳定失败信号）。
- **价格**：每块多几十 token，可忽略。

### P3 按块类型自适应保留比例（x1 · 低成本）
- **做什么**：`extractiveMaxKeepRatio` 拆成按 kind：`closed` 0.3、`exec` 0.35、`explore` 0.55（先作为提示词里的目标，超出上限仍按失败放行）。
- **为什么**：AgentSwing（按情况在 Summary / Discard / Keep-Last-N 之间路由有收益，[2603.27490](https://arxiv.org/abs/2603.27490)）；Step Entropy（低熵可大删，高熵不能删）；
  closed 块的过程已无后续价值，explore 块的过程还在被用。
- **价格**：closed 块更省；explore 块略贵。总体取决于块型分布，trace 里已有 `kind` 可以先统计再定。

### P4 `[状态]` 行去重（x1 · 很低成本）
- **做什么**：拼装时丢掉值已在保留句中逐字出现的 `k=v`；只留被删句子里的变量和用户原话约束。
- **为什么**：SKILL.state 状态 + 历史 41.8%。
- **价格**：更省。

### P5 取回率闭环（需要确认宿主侧读取工具）
- **做什么**：在 trace 里统计主模型按 `art://` 句柄读取的次数（按块 kind、keep 比例分桶）。取回率高的桶提高 keep，接近 0 的桶降低 keep。
- **前提**：主模型能调用按句柄读取的工具（CMB 侧）。若没有，句柄行只对人有用，应把 x1 的 keep 下限定得更保守。
- **为什么**：G 组；原则 ④。

### P6 评测补强（先于任何上线）
在 `cf-eval.mjs` 里增加过程指标（都能从续写的动作和文本直接算）：
- `loopRate`：续写提出的动作与历史中**已失败**的动作相同（比 `avoid` 更自动，不需要手写 fixture 期望）；
- `rederiveRate`：续写重新推导历史中已 ⟨证实⟩ 的结论（信息丢失的信号）；
- `reasoningChars` 与 raw 的差（已有）：用来检验“简洁历史 → 简洁新推理”的示范效应（E 组，未经直接验证的假设）；
- 配对 bootstrap 置信区间。成功/失败二值指标区分 97% 与 99% 需要每组约 800 个任务，**配对的连续指标约 30 个就够**（theclarity.us 对 ARC 结果的统计旁注），
  所以先收 30–50 个真实 CAS fixture，比先扩任务数更有用。

### P7 S3 勘误的写法修正（文档级）
如果以后做“下一块勘误上一块”，勘误必须写成“〔工具证据 seqN〕：X 不成立”，不写成主模型口吻的“另一种想法”（B 组：以 Alternatively 引出的注入常被推翻）。

### 不推荐 / 已排除
| 方案 | 原因 |
|---|---|
| Memento / InftyThink / AgentFold / MEM1 式自我压缩 | 需要训练主模型；cfb 无法训练宿主 |
| TIP（惩罚思路切换的解码） | 需要改主模型 logits，插件拿不到 |
| RLM（上下文做成 REPL 变量） | 要改宿主 agent 结构；复现报告显示深递归会过度思考、成本高 |
| 让主模型在 thinking 里自己写摘要 | 用户已否决（ReasonIF：推理内指令遵循 <25%） |
| 纯规则抽取 | 用户已否决（只作失败兜底） |
| 往每块末尾复述用户目标 | 旧块无法删除，复述会在历史里逐块堆积；约束改为只进 `[状态]` 行（用户原话、逐字） |

---

## 4. 未验证假设（按验证优先级）

1. **H1**：同等压缩率下 x1 的 successRate ≥ v3（原则 ①）。——cf-eval 三路对比，直接可测。
2. **H2**：死分支折叠后 avoidRate / loopRate 不升反降（原则 ②）。——P1 实现后 A/B。
3. **H3**：历史 reasoning 越简洁，新推理越短且不掉分（示范效应）。——看 `reasoningChars` 差。
4. **H4**：去重后的状态行不降低 successRate（原则 ③）。
5. **H5**：取回率与“删多了”相关（原则 ④）。——需要宿主读取工具与在线 trace。

## 5. 与既有决定的关系

- 不改任何缺省值；x1 仍缺省关闭。上一轮提出的“`extractiveEvidence` 关或 4 条、`extractiveMaxKeepRatio` 约 0.4”仍待用户决定。
  P1 的 `abandoned` 分支不依赖工具证据，正好让“关掉证据索引”不再意味着失去否定信息。
- 不使用用户会话的缓存命中数据；经济性仍按 Harness 官方默认参数。
