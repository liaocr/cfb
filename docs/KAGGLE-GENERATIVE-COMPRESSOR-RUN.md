# 生成式压缩器 · Kaggle 开训手册（Round 0 · 教师 v0.3「装上尺子」版）

> **一句话**：把「只看稿子就能判」的 7 条尺子装进机械教师 → 用它生成带好形状的压缩目标 → Qwen3-0.6B QLoRA 学形状 → dev（86 个未见仓库）上复算。
> **不需要端点、不需要再准备数据，今天就能在 Kaggle 跑。**

## 0. 本轮口径（按你的指示）

| 装进教师的轴（只看稿子） | 剔除的轴（需要另外跑） |
|---|---|
| **M1** 压缩力度 ≤0.60 · **M3** 闭合判读 · **M4** 可执行验收（逐字命令+两分支） · **M5** 接地精度（无编造锚点） · **M6** 无装置话术 · **M7** 决策不变 · **M8** 落点唯一 | **E1/E2**（真机 ≤6 轮/不输 raw，需目标模型） · **R1/R2**（CFB 台账五件/独立趟数） · **M2**（产线对照稿） |

- 教师 = **尺子的执行器**：先按"信息不丢"抽句（判定行/命令/围栏代码/路径/强结论句，关键锚点覆盖 1.0），再按 7 轴组装/修剪（锚点窗口切片、复述剪枝、预算控制、命令逐 token 接地），产出前**用同一把尺子逐条自检**。
- 因此**之后量学生 = 同源测量**：能测"学没学到形状"，**不构成对尺子本身的验证**。E1/E2 仍是唯一外部终验（未测就是未测）。

## 1. 语料（已生成）

来源：`nvidia/Open-SWE-Traces@f8fb5b3d…` v1.1/openhands，DeepSeek-V4-Flash 行，shards 25–33 普查（21,208 行 → 19,992 个合格出生单元）中切样。

| 文件 | 内容 | 条数 | 大小 |
|---|---|---:|---:|
| `train.jsonl.gz` | **全轴通过**的训练对（system/user:【CONTEXT】+【RAW】→ assistant: 压缩块） | **937（623 仓库）** | 1.9MB |
| `dev.jsonl.gz` | 同分布、仓库不相交（记了每行轴表） | 139（86 仓库；124 条全轴通过） | 285KB |
| `train-nonconforming.jsonl.gz` | 未过全部轴的 106 条（多在 M1 超 0.60——关键锚点句本身太肥；保留信息优先） | 106 | 198KB |
| `corpus-report.json` | 各轴通过率 / 压缩率 / 边界声明 | — | 2KB |

**教师 v0.3 实测**：train 937/937 七轴全过，压缩率中位 **0.41**；dev 124/139 全过，中位 0.44。
（对照：生产微编译器在同一批单元上 M4 = 0/148。）

复现：
```bash
node tools/micro-generator/teach-shape.mjs \
  --units transfer/models/micro-generator-v4flash-scenarios/birth-units-census-batch2.jsonl.gz \
  --units transfer/models/micro-generator-v4flash-scenarios/birth-units-sample.jsonl \
  --mode shape --out-dir transfer/models/micro-generator-gen-v3
```

## 2. 开训：Kaggle 新建 notebook，code 框里粘一条

1. Kaggle → **New Notebook**（新建一个空 notebook 即可）。
2. 右侧设置两下：**Accelerator = GPU T4 × 2**、**Internet = ON**。
3. 第一个 code 框里粘这一条，Shift+Enter：

```bash
!curl -sSL https://raw.githubusercontent.com/liaocr/cfb/main/deploy/kaggle/train_gen.py | python3 -
```

它自己完成：装依赖 → 从 GitHub 拉仓库（含 v3 语料）→ **自动检测 GPU 数：T4×2 走 DDP 双卡（每卡一份数据分片，有效 batch 不变、步数不变，约快 1.7×），DDP 失败自动回退单卡** → QLoRA 训练 → 打印读数 → 结果落盘 `/kaggle/working/RESULTS.txt` → 打包 `cfb-gen-compressor-run1.zip`。
**不需要上传任何东西。**

## 3. 跑完先看三个数（notebook 自动打）

| 读数 | 含义 | 判读线 |
|---|---|---|
| `criticalCoverageMean` | 关键锚点留存（你的「信息不丢」） | **≥0.95 才算没跑歪**；`criticalCoverageMin` ≥0.8 |
| `inventedAnchorsTotal` | 编造的锚点（原文没有） | 越接近 0 越好 |
| `ratioMean` | 生成块/原文 | 教师中位 0.41；学生应在 0.35–0.7（>0.9 只会抄，<0.25 丢太多） |

想看**形状**学没学到：`dev-predictions.jsonl` 每行带 `prediction`，可用上节的 `node tools/micro-generator/forge-birth-units.mjs`-derived 评分器（同尺子）逐条量 M1/M3…M8——记住这是同源测量。

## 4. 常见问题

- **没 GPU 报错** → 设置里 Accelerator 未开。
- **CUDA OOM** → `--max-len 4096 --grad-accum 32`。
- **下载失败** → Internet 未开。
- **产物** → `adapter/`（LoRA+tokenizer）、`dev-predictions.jsonl`、`run-meta.json`、`cfb-gen-compressor-run1.zip`。

## 5. 跑完之后

1. **看形状**：把 dev 预测按 7 轴打分（同源）→ 缺哪条轴就调教师对应部分的表达（比如 M4 的验收行措辞）。
2. **接端点（唯一外部终验）**：压缩块回喂 DeepSeek-V4.1-Flash 跑 E1/E2。
3. **扩规模**：语料可扩到普查全量 ~2 万条（`scan-birth-units.py --total-cap 20000`），教师重建约 0.6 分钟/千条。

## 6. 红线（本轮遵守）

- 没跑真机就不写 E1/E2；没有人工审核就记 `humanReviewerCount=0`；机器生成的目标**不叫金标**。
- 生产资产零改动（只新增文件）；语料行内保留 `unitId/repo/license`，报告记 revision 与来源。
