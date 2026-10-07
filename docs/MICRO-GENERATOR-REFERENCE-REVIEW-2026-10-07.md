# 九个小模型与训练参考的逐项审读及项目映射（2026-10-07）

> **当前任务**：`raw + ctx -> draft`，从代码代理/用户/工具历史生成简短、接地、保留关键事实与验证状态的进度稿。本文记录的是资料审读与迁移性判断，不是数据准入或模型评测报告。
>
> **边界**：本轮没有下载或导入模型权重/语料，没有调用模型 API、运行推理或训练，也没有改动训练/生产代码。网页和项目中的性能、数据规模、成本及许可证陈述均作为来源方陈述；除文中明确写明的页面/元数据核对外，没有独立复现实验。

## 结论先行

1. 九个链接中，**MiniMind 官方仓库**和 **Qwen3 微调教程**最贴近“如何组织一个小模型训练工程”；**from-minimind-to-more** 的 Tokenizer、Pretrain、SFT 与设计章节适合作为学习索引。它们提供的是工程做法，不是本项目所缺的 CFB 目标数据。
2. **没有一个链接提供了可直接准入的 `raw + ctx -> progress draft` 新家族金标**。UniRec/OpenDoc 是文档 OCR，TurboVLA 是机器人视觉-语言-动作；其他仓库提供通用语言模型训练、模型或通用对话语料，不等于 CFB 进度稿监督数据。
3. 对本项目最可迁移的是：锁定 tokenizer/chat template、显式区分 prompt 与 assistant target、来源与数据处理可追溯、断点续训、逐条长度预检、按家族切分、用目标任务事实完整性而非 loss/通用 benchmark 判定质量。多数安全门槛已在现有 QLoRA/preflight 代码中实现，无须因这些教程改写。
4. **不建议换底座、从头预训练或引入 DPO/RL**。当前仍没有完整来源覆盖且已审核的新家族训练集；继续保持 `train=0`、`dev=0`、`blindPrivate=0`、`excluded=16`，不训练、不宣称通过。

## 阅读范围与证据口径

- 腾讯云文章、知乎文章、RWKV 与 ChatLM 页面已读取其可见正文/模型卡；MiniMind 仓库 README 已读完页面全部分段。
- UniRec 读取了 ModelScope 模型卡及完整 README；另外只核对了论文摘要/引言片段，**没有声称复核论文全部实验或复现指标**。
- `from-minimind-to-more` 是较大的学习笔记仓库。本次读了仓库 README 及与当前训练决策直接相关的 Tokenizer、设计目录、Pretrain、SFT 章节；没有逐篇读完 README 链出的所有架构/RL/优化文章。
- 下文的“可借鉴”是对项目工程原则的判断，不表示采纳了对方代码、训练集、checkpoint 或架构。

## 九项逐一审读

### 1. 腾讯云 OpenDoc-0.1B 文章

来源：[文章](https://cloud.tencent.com/developer/article/2625378)。正文介绍面向文档解析的专用小模型/系统，涉及版面分析与识别流水线、UniRec、多任务数据、tokenizer 与监督设计。

- **可借鉴**：先明确任务边界，再把异质子任务拆成有显式 I/O 的阶段；监督字段和数据处理应围绕目标输出设计。作为原则，这支持“先做 CFB 事实/来源标注，再训练摘要器”，而不是把未审文本直接喂给模型。
- **不迁移**：版面检测、OCR/公式识别、视觉 tokenizer 和文档识别数据均不是代码轨迹压缩任务；文章中的准确率、成本或数据量没有在本轮逐项对照论文/代码，不能当作本项目预期指标。
- **决定**：只保留任务分解与标签设计的工程启发；不采用其模型、架构或数据。

### 2. ModelScope UniRec-0.1B

来源：[模型卡](https://www.modelscope.cn/models/topdktu/unirec-0.1b)、[README](https://www.modelscope.cn/models/topdktu/unirec-0.1b/resolve/master/README.md)、[论文摘要/引言](https://arxiv.org/html/2512.21095)。模型卡列出 OCR、表格识别等任务与 Apache-2.0；README 介绍文字/公式识别、分层监督、语义解耦 tokenizer，以及 UniRec40M 数据集。README 还称完整数据下载需要约 3.5 TB 空间；这属于项目方说明，未下载核验。

- **可借鉴**：同一模型可针对多层级目标设计有层次的监督；小模型也需要与任务相称的数据规模和评测集。这个结论只作为通用研究启发。
- **不迁移**：这是 OCR/视觉识别权重，不是可用于文本生成的 decoder LM，也没有进度摘要目标；Apache-2.0 的模型代码/权重许可不自动覆盖第三方训练数据或适配用途。
- **决定**：排除为本项目底座、数据源与质量对照。模型卡和 README 足以判定任务不匹配，不下载权重。

### 3. LLM-From-Scratch-0.1B

来源：[GitHub 仓库](https://github.com/lyxyxyxlx/LLM-From-Scratch-0.1B)。README 介绍约 0.1B 的 decoder-only、LLaMA-style 结构，含 tokenizer、GQA/RoPE/SwiGLU/RMSNorm、DDP/混合精度、断点恢复、预训练/SFT/评测等流程。

- **可借鉴**：训练阶段、配置、checkpoint 与评测应清楚分开；断点恢复要保留优化器/进度状态，而不只是模型权重。
- **重要核验/风险**：README 自述 MIT，但 GitHub API 当前返回 `license: null`、`fork: false`；对 `main` 和 `master` 的 `LICENSE` 请求均为 404。README 的克隆示例还指向 `YuanxinLi0`，与用户给出的 `lyxyxyxlx` 仓库不同。故代码许可、checkpoint/预训练语料来源和仓库关系尚不能据 README 一句话视为已澄清。
- **不迁移**：从头训练需要大量预训练语料；当前没有相应规模、许可和目标域覆盖的语料。约 0.1B 参数本身也不证明它能可靠保留长代码轨迹中的条件、否定、时间与验收事实。
- **决定**：只借鉴训练工程检查点；在来源/许可未澄清前不复用其代码、权重或数据，更不以它替代已有 Qwen3 QLoRA 候选。

### 4. RWKV-7 0.1B G1

来源：[Hugging Face 模型卡](https://huggingface.co/fla-hub/rwkv7-0.1B-g1)。卡片列出约 191M 参数、Apache-2.0、RWKV World tokenizer（65,536 词表），并称训练使用 World v3.5 的 5T+ tokens；这是模型卡陈述，不是本轮核验的数据谱系。卡片还给出特定 EOT/tokenizer 使用注意事项。

- **可借鉴**：轻量模型在边缘部署、长序列处理方面可以有 Transformer 以外的设计选项；应把 tokenizer、结束符与状态管理视为模型契约的一部分。
- **不迁移**：现有训练脚本是 Qwen3/标准 causal-LM 的 QLoRA 路径，不能假定 RWKV/FLA 模型开箱兼容；尚未验证它的加载、LoRA target modules、chat template、生成终止和现有推理 runner。单凭参数量小或模型卡训练量大，不足以证明任务质量。
- **决定**：不切换底座。若未来明确要比较轻量架构，再单独做许可/接口审查和无训练 smoke test，并先通过数据门槛。

### 5. ChatLM-mini-Chinese

来源：[GitHub 仓库](https://github.com/charent/ChatLM-mini-Chinese)。README 描述约 0.2B、T5/text-to-text 路线，含清理/去重、tokenizer、预训练、SFT、DPO 与下游任务示例，也说明样本规模和实际效果有限；仓库 LICENSE 文件为 Apache-2.0。

- **可借鉴**：把文本到文本任务、预训练与指令微调分阶段组织；数据去重和记录来源应与训练脚本一起维护；小模型 README 中公开局限性比只展示单个成功样例更有参考价值。
- **不迁移**：T5 encoder-decoder 与当前 `AutoModelForCausalLM` QLoRA 路径不同；其一般中文问答/任务数据不是代码代理进度稿。仓库代码的 Apache-2.0 不等于其引用/混合的第三方语料均可再分发或商用。
- **决定**：保留流程层面的参考；不导入模型、样本或偏好对，不为此改当前训练脚本。

### 6. 知乎 TurboVLA 文章

来源：[文章](https://zhuanlan.zhihu.com/p/2066564289712894830)，文中引用 [arXiv:2607.27205](https://arxiv.org/abs/2607.27205)。文章讲的是机器人视觉-语言-动作（VLA），包括轻量视觉语言交互与并行动作块生成；“小模型超过大模型”等性能比较是文章/其引用论文中的主张，本轮未从论文代码与评测协议独立验证。

- **可借鉴**：架构应由目标任务需要决定，不应把“必须有更大的通用 LLM”当成默认前提；对可程序化验证的任务，可探索轻量、边界明确的专用执行器。
- **不迁移**：VLA 的视觉表征、交叉注意力和连续动作块与文本轨迹压缩没有直接映射；不能据此给 CFB 选架构，也不能引用其指标作为项目对照。
- **决定**：仅保留“任务匹配优先于参数规模”的一般原则；不移植 TurboVLA 结构或数据。

### 7. MiniMind 官方仓库

来源：[GitHub](https://github.com/jingyaogong/minimind)。README 覆盖模型、tokenizer、JSONL 数据、Pretrain/SFT、LoRA、DPO、PPO/GRPO、tool use、断点恢复和评测。当前 README 列出 64M dense 与 198M-A64M MoE 等版本，并区分 mini/full 训练数据；mini 预训练/SFT 文件分别约 1.2GB/1.6GB，full 文件更大。训练耗时/费用是项目在特定 3090 配置下的报告或估算，不可外推为本项目环境读数。README 也披露小模型存在事实错误、任务能力取舍与有限泛化；其数据许可包含多个来源的各自条件。

- **可借鉴（最实用）**：① train、dev、偏好/RL 阶段和数据格式分开；② 固定随机种子、记录版本、保存完整 checkpoint、支持恢复；③ README 同时给出参数量、数据体量、训练设置和评测误差/污染 caveat；④ tokenizer 对参数量、文本长度与任务兼容性有实际影响。
- **不迁移**：MiniMind 的数据/权重与本项目目标不同；“从头训练 64M”示例仍依赖 GB 级数据，不能据其低成本叙述推导出少数 CFB 样本足以训练。其工具调用/RL 配方也不是当前监督任务所需。
- **决定**：作为训练工程与结果报告方式的主要参考，不复制数据或权重，不改成 MiniMind 底座。

### 8. LLM-tuning

来源：[GitHub 仓库](https://github.com/huangxiaoye6/LLM-tuning)。README 以 Qwen3-0.6B 为例，介绍 LoRA/QLoRA、提示调优与量化等常见微调路径；代码仓库 LICENSE 为 MIT。README 的显存门槛是教程环境建议，不是所有 sequence length、batch、显卡都成立的固定要求。

- **可借鉴**：这与当前 trainer 默认的 `Qwen/Qwen3-0.6B` 候选及 QLoRA 路线最接近，可用于核对常见配置术语与依赖。
- **与本仓现状对照**：本仓 `tools/micro-generator/train_qlora.py` 已要求固定 40-hex 模型 revision、CUDA、严格训练样本预检、family-disjoint train/dev、AI single-reviewer provenance、完整事实/来源覆盖和无冲突目标；对超过 `max_length` 的样本直接报错而非静默截断，并只对 assistant target 计算 loss。教程不是这些数据准入、盲测或质量门槛的替代品。
- **决定**：只作配置交叉参考；不照搬教程流程，不降低现有 fail-closed 闸门。

### 9. from-minimind-to-more 学习笔记

来源：[仓库 README](https://github.com/Tongyun1/from-minimind-to-more)。本次另读了其 Tokenizer、MiniMind 设计目录、Pretrain、SFT 章节。作者明确说明这是个人学习笔记、持续更新的教程，不等同于 MiniMind 官方文档。

- **可借鉴**：对当前监督微调最有用的是：tokenizer 与 chat template 必须固定且匹配；SFT label mask 应只覆盖目标 assistant 文本；先检查渲染和 mask 再训练；保留 optimizer/step 等完整恢复状态；清楚标注输入长度与截断策略。上述原则与当前 trainer 的严格 prompt-prefix mask、token-length preflight 和 checkpoint 记录相符。
- **谨慎点**：教程中的部分推导/代码注释是教学简化，个别 tokenizer、复杂度或训练实现说明不能当作权威技术规范；其例子来自 MiniMind 特定版本，必须回到对应 commit 的实际源码与模型 tokenizer 核对。
- **决定**：作为学习索引和工程 checklist，不复制其中代码，也不据此改动 tokenizer 或 SFT 格式。

## 映射到 CFB 当前路线

| 主题 | 决定 | 当前适用理由 |
|---|---|---|
| 训练目标 | 保留生成式 `raw + ctx -> draft`；先做监督微调，暂不做从头预训练、DPO、PPO/GRPO | 现有任务有明确 draft target；没有足够新家族训练样本，也没有可信 chosen/rejected 偏好对或可扩展奖励验证器。 |
| 底座 | 暂保留代码中的 Qwen3-0.6B QLoRA 候选，不将其表述为已验证的最佳模型 | 它与当前训练/推理代码路径相符；RWKV/T5/UniRec 切换均会增加尚未验证的兼容与评测变量。当前没有运行真实推理或训练。 |
| tokenizer/chat template | 继续使用底座原生 tokenizer 与模板，不另训 tokenizer | 这保持输入编码和 checkpoint 兼容；小规模 CFB 数据不足以证明重训 tokenizer 有收益。 |
| 数据 | 新家族、完整 `raw + ctx` 事实来源、reference claim review、逐条事实标注、split 与盲测注册缺一不可 | 九个来源没有填补这一缺口；通用语料、论文数字或模型输出不能替代源事实审查。Reviewer 继续如实标 `AI single reviewer`，不宣称人工或独立复核。 |
| 评测 | 以新家族、关键事实召回、漏失、无依据/矛盾断言、否定/条件/数值/时间保留和压缩率为主；loss/通用 benchmark 仅作辅助 | 通用语言模型指标不能代表 CFB 任务的可证实性。blind 仍需在预测冻结后按原门槛一次性评估。 |
| 运行工程 | 保留固定 revision、输入/目标哈希、无静默截断、可恢复运行记录、盲测排除等已实现的保护 | 参考项目支持这些可复现做法，但不构成放宽准入规则的理由。 |

## 状态影响与本轮未做

- 本次审读**没有新增长期训练来源或合格训练家族**，也没有改写任何样本、门槛、family split、blind 资产或模型权重。
- 16 个唯一 `raw+ctx` rewrite candidates 仍全部是既有 dev 家族的部分覆盖候选：`train=0`、`dev=0`、`blindPrivate=0`、`excluded=16`；`trainingReady=false`。
- 没有下载/加载上述模型，没有请求模型 API，没有运行推理、训练、Kaggle 或盲测。
- 只有在合格的新家族数据完成来源筛查、AI 单人事实/目标审核、无冲突目标检查、split 冻结与盲测预注册之后，才值得按现有 QLoRA 路径做训练候选。该后续条件不构成现在启动训练的授权。

## 相关本地文件

- 当前来源筛查与准入判断：[`MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md`](MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md)
- 当前家族盘点：[`MICRO-GENERATOR-FAMILY-INVENTORY-2026-10-07.md`](MICRO-GENERATOR-FAMILY-INVENTORY-2026-10-07.md)
- 当前 AI 单人审核记录：[`MICRO-GENERATOR-AI-FIRST-REVIEW-2026-10-07.md`](MICRO-GENERATOR-AI-FIRST-REVIEW-2026-10-07.md)
- QLoRA 预检/训练脚本：[`../tools/micro-generator/train_qlora.py`](../tools/micro-generator/train_qlora.py)
