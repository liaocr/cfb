# Kaggle 一键：任务专用微模型（自训词表 + 从零训）

> 这是与 `KAGGLE-GENERATIVE-COMPRESSOR-RUN.md`（Qwen3-0.6B + LoRA）**并列的第二条路线**。
> 两条都保留：微模型回答"我们其实用不了 0.6B 那么多"，Qwen 路线留作参照/上界。

## 为什么会有这条路

对 v3 全语料实测（Qwen3-0.6B 自带词表，151,669 条目）：

| 观察 | 数字 |
| --- | --- |
| 语料真正用到的词表条目 | 30,283（**20%**，即 80% 从未出现） |
| 覆盖 90% / 99% token 需要的条目 | 4,212 / 17,798 |
| 嵌入+输出层参数 | 155.3M，占全模型 **26.1%** |
| 5120 长度训练时 logits 激活（fp16） | 1.55 GB（训练显存大头） |

结论：0.6B 里最大的一块冗余是"通用多语言词表 + 通用预训练能力"，而我们的任务只有
一种形状（context+raw → 压缩稿）。所以直接**自训 16k 词表 + 从零训一个小 GPT**，
把不用的部分全部删掉，而不是在大模型上动刀。

## 规格与超参（train_micro.py 默认）

- 词表：**24,576**（ByteLevel BPE，英文训练文本 + 仓库自带中文种子 `tokenizer-zh-seed.txt`，零 OOV）
  - 实测（v3 dev 139 条，char/token）：Qwen 自带词表 3.784 ~ 我们 16k 纯英 3.542 ~ **我们 24k+种子 3.589**
  - 标识符（11,412 个唯一样本）：Qwen 3.874/26.1% 整词 ~ 我们 24k+种子 3.132/20.9% 整词
  - 中文（留出百科页）：Qwen 1.555 ~ 我们 16k 纯英 0.456（**不可用**）~ 16k+种子 1.111 ~ 24k+种子 0.895
  - 结论：24k 是甜点；32k 只多买 0.03 char/token（中文）却多 4.2M 参数，不做
- 模型：d_model 512 / 8 层 / 8 头 / FFN 4× / ctx 2048，权重共享嵌入 ⇒ **约 37.8M 参数**
  （对比 Qwen3-0.6B：参数 0.6B、可训 10.1M、嵌入占 26%）
- 训练：fp16（T4 无 bf16），AdamW，lr 3e-4，warmup 100，60M tokens ≈ 40 epoch
- 防过拟合仪表（内置）：
  - `--devloss-every 40`：每 40 步算 dev 答案段 CE（与训练 loss 同口径），打印 `gap = dev - train`
  - **gap 掉头向上** = 开始过拟合的实测信号（不看感觉，看曲线）
  - 自动保留 `micro-gen-best.pt`（dev 最优），评测与交付用它，不用最后一版
  - `--early-stop-patience 4`：连续 4 次不改善即停
- 多卡：`torchrun` DDP 用满所有 GPU；每步全局 token 固定 12×2048=24,576，
  换卡数只改 steps（语义与单卡可比）；DDP 失败自动回退单卡

## 一键指令（Kaggle code 框，一条）

先设 **Accelerator = GPU T4 ×2**、**Internet = ON**，然后：

```bash
!curl -sSL https://raw.githubusercontent.com/liaocr/cfb/fdc554e707e44b5510148d4ee3eef45c115d73f2/deploy/kaggle/train_micro.py | python3 -
```

脚本内部固定 checkout `ec82812`（含 v4 语料）（该提交含同一份 tools/语料），URL 指向 `fdc554e7`；
两层都用不可变的提交哈希，避免 raw CDN 缓存导致跑旧代码。

## 产物（/kaggle/working）

- `RESULTS.txt`：GPU 数、实际用时、模型参数、loss 尾段、dev 代理指标、退出码
- `cfb-micro-gen-run1.zip`：`tokenizer.json`、`micro-gen.pt`（含 model-config/meta）、
  `dev-predictions.jsonl`、`dev-metrics.json`、`train.log`
- 模型体积量级：33.6M 参数 fp16 ≈ 67 MB（对比此前 0.6B LoRA 方案产物 ~xx MB）

## 指标口径（必须先说清）

- 本地/dev 的 `anchorRecallMean`、`exact_match`、`charRatio` 是**内部代理**，
  用正则近似"锚点是否存活"，**不是验收**。
- 真验收仍是 7 轴判定（判读环境，逐轴通过率 + 中位 ratio 0.4139 基线）。
- 本轮目标同上轮：**先训出来、把可判读的预测稿交出来**；E1/E2 真机仍不查。

## 实测：过拟合长什么样（刻意做的对照实验）

为了让"会不会只是拟合机器"这个问题有实测答案，本机用 CPU 跑了一个**故意容易过拟合**的配置：
4.48M 参数、**只用 100 条**训练样本（真实 Kaggle 跑是 937 条）、ctx 512。

| step | trainLoss | devLoss | gap |
|---:|---:|---:|---:|
| 50 | 7.84 | 7.97 | +0.13 |
| 100 | 6.54 | 6.89 | +0.35 |
| 200 | 5.19 | 6.41 | +1.22 |
| 300 | 4.73 | 6.04 | +1.31 |
| 400 | 3.68 | 5.94 | **+2.26** |
| 500 | 3.65 | 5.82 | +2.17 |

读法：train 一路走低，dev 仍在缓降但已经追不上——**gap 从 +0.13 拉大到 +2.2** 就是记忆化的现场指纹。
这正是仪表要抓的东西：不看最终 loss 的绝对值，看 gap 的走向。

对应的防御（已在 Kaggle 脚本里）：
1. `devlossTail` 会打进 `RESULTS.txt`——937 条下如果出现同样的 gap 爆开，说明数据不够，先扩语料；
2. 评测与交付一律用 `micro-gen-best.pt`（按 dev 挑的最优点），不用最后一版；
3. `early-stop-patience 4` 到点自动停。

## 训练跑完：补预测文本 + 打包（当前 session 内，新开一个 cell）

训练器在训练时只存指标；**判读（7 轴）要的是每条 dev 的预测文本**。训练完成后，在同一个
notebook 里新开一个 cell 跑：

```bash
!cd /kaggle/working/cfb-micro-run/repo && git fetch -q origin <SHA> && git checkout -q <SHA> \
  && python3 -m torch.distributed.run --nproc_per_node=2 --master_port=29519 \
     tools/micro-generator/eval-micro-gen.py \
     --ckpt /kaggle/working/cfb-micro-run/out \
     --corpus transfer/models/micro-generator-gen-v3 \
     --out /kaggle/working/cfb-micro-run/out --cap 1024 --examples 3 \
  && cd /kaggle/working/cfb-micro-run/out \
  && zip -q /kaggle/working/preds.zip dev-predictions.jsonl dev-predictions-summary.json \
     model-config.json tokenizer.json \
  && echo ZIPPED
```

要点：**双卡各做一半行**（进度按 rank 打印、带 ETA）；`--cap` 是单条最长生成 token；
zip 不含 `.pt`（权重 150MB，判读用不到，需要时从 Output 单独取）。
训练内评测（原来"评测段静默"的坑）已改为自适应长度 + 逐条进度。

它载入 `micro-gen-best.pt`（按 dev 挑的最优点），对全部 139 条 dev 贪心生成
（每条长度按 gold 自适应 ×1.6+96，上限 2048），落盘 `dev-predictions.jsonl`。
之后从 Kaggle 右侧 Output 下载 `preds.zip` 交回即可做 7 轴判读。

（从下一轮起 `train_micro.py` 默认带 `--dump-predictions`，训练时就直接落盘，不用补跑。）

## 第二轮语料（v4，2026-10-07）

第一轮 937 条在 ~800–900 步出现 dev 平台期（数据吃紧）。已用深度重扫扩容：

| 来源 | 单元 | 教师全轴通过行 |
| --- | ---: | ---: |
| v3（batch2+sample） | — | 937 |
| batch3（shards 31–33） | 1,085 | 844 |
| batch4（shards 25–33 深度重扫，max-units-per-row 2） | 3,078 | 2,491 |
| **合并 v4（去重后）** | — | **3,683 行 / 986 仓库** |

- 固定评测集 = v3 的 dev 139 条（跨轮可比）；合并时对"与评测集同仓库"的行做硬性排除（batch3 挡住 119 行、batch4 挡住 251 行）。
- 中位 ratio 0.4127（与 v3 的 0.4139 一致 ⇒ 教师形状未漂移）。
- 数据边界已探明：v1.1/openhands 仅 **shards 25–33** 含 DeepSeek-V4-Flash 的 reasoning 块；shards 0–24 为 Qwen3.6-27B（无 reasoning），v1.0/v1.2/sweagent/minisweagent 探测为 0 单元。
- 一键命令不变（默认语料已切 v4，落 RESULTS.txt 会带 corpus 出身证明）。

## 与 Qwen 路线的取舍

| | Qwen3-0.6B + LoRA | 微模型（自训词表） |
| --- | --- | --- |
| 训练参数 | 10.1M（LoRA） | 33.6M（全量，但从零） |
| 依赖 | transformers/peft/bitsandbytes 4-bit | 只要 tokenizers + torch |
| 显存 | 4-bit ~1.2GB 权重 + 1.55GB logits | 直接 fp16，无 4-bit |
| 词表冗余 | 80% 未用、嵌入占 26% | 0 冗余（16k 全部来自语料） |
| 风险 | 依赖 Qwen 的通用能力（更稳） | 从零、语料只有 937 条（欠拟合风险） |
| 产物 | ~600MB+ | ~67MB |

**下一步建议**：两条都跑（各一条指令，Kaggle 免费额度足够）。以微模型为主，
若欠拟合（dev 代理 recall 明显低于 Qwen 路线），先用 census 批次3扩语料再重训，
而不是回头改 Qwen 架构。
