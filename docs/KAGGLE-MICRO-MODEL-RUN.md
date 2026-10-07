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

- 词表：16,384（ByteLevel BPE，只在 `train.jsonl.gz` 上现训，零 OOV）
- 模型：d_model 512 / 8 层 / 8 头 / FFN 4× / ctx 2048，权重共享嵌入 ⇒ **约 33.6M 参数**
  （对比 Qwen3-0.6B：参数 0.6B、可训 10.1M）
- 训练：fp16（T4 无 bf16），AdamW，lr 3e-4，warmup 100，60M tokens ≈ 40 epoch
- 多卡：`torchrun` DDP 用满所有 GPU；每步全局 token 固定 12×2048=24,576，
  换卡数只改 steps（语义与单卡可比）；DDP 失败自动回退单卡

## 一键指令（Kaggle code 框，一条）

先设 **Accelerator = GPU T4 ×2**、**Internet = ON**，然后：

```
!curl -sSL https://raw.githubusercontent.com/liaocr/cfb/<PIN>/deploy/kaggle/train_micro.py | python3 -
```

（<PIN> 见交付消息里的完整命令；脚本内部再固定 checkout 同一个提交，避免 CDN 缓存跑旧代码。）

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
