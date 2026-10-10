# 迁移清单（MIGRATION）

> 本文件说明：这个仓库里**有什么**、**没有什么**、以及**没有的东西怎么拿回来**。
> 目的：换一台机器能完整恢复工作状态。

---

## 1. 这次推送补进来的东西

| 路径 | 内容 | 为什么必须入库 |
|---|---|---|
| `.cfb-offline/teacher/` | **花真金白银跑出来的教师稿**（`v4-full.jsonl` 20.8 MB、`v4-extra-434.jsonl` 3.67 MB、`drafts.jsonl`、`v1/v2/v3-off`、`v4-100`、`v4-30`、`v5-30`，共 17 个文件 33 MB） | **不可再生**。重跑要花钱，且提示词一改旧稿即作废 |
| `.cfb-offline/ruler/` | 尺子读数（`report-*.json` 手稿/教师/金标、`pairs-v5.jsonl`、`raw-mine-shortlist.jsonl` 33 MB） | 全部历史结论的原始依据 |
| `.cfb-offline/kaggle-out/` | Kaggle 真机产物：v9 / v10 / v11 的 `dev-generations*.jsonl`、`learning-curve.json`、`eval-sft.json`、`report.json`、训练日志、**以及模型的 config / tokenizer / vocab**（**不含 model.safetensors**，见 §2） | 真机读数的唯一副本，重跑要 GPU 配额 |
| `.cfb-offline/sft/`、`sft-dry/`、`sft-dryrun/`、`sft-smoke/`、`sft-test/` | SFT 数据集各版本（`train.jsonl` / `dev.jsonl` / `report.json` / `eval-sft.json`） | 训练输入，与 Kaggle 上跑的一致 |
| `.cfb-offline/train/` | 飞轮偏好对 `pairs.jsonl`、`selection.jsonl`、`split.json`、`test.jsonl` | 闭环训练的原始对 |
| `.cfb-offline/review/` | 盲审批次与工作表 | 已在库 |
| `.cfb-offline/effect/`、`tasks/`、`policies/` | 效应评测对、任务定义、策略补丁 | 已在库 / 本轮补 |
| `.cfb-offline/rwkv7/`、`hf_rwkv7/` | RWKV7 的 `config.json`、tokenizer、vocab、`ANALYSIS.txt` | 复现推理的最小必要件 |
| `.cfb-offline/_*` | 本轮审计用的全部探针脚本与原始读数（313 个，10.3 MB） | 审计结论的可复算依据 |
| `.cfb-runtime/` | 真机轨迹读数（`traj/` 669 文件 11.1 MB、`bench/`、`probe/`、`mint/`、`micro-candidate/`） | 没了要花 API 才能重造 |

---

## 2. 没有入库的东西，以及怎么拿回来

### 2.1 模型权重（2 × 764,179,920 字节 = 728.78 MiB）

**不进 git 的原因**：GitHub 单文件硬上限 100 MB。这两个文件各 728 MB，用 git-lfs 也要 1.4 GB，超过免费额度（1 GB 存储 / 1 GB 月流量）。

| 模型 | 文件 | 字节 | SHA-256 |
|---|---|---:|---|
| **v9**（当前较好的那个） | `.cfb-offline/kaggle-out/rwkv7-compressor/model/model.safetensors` | 764,179,920 | `342129FA834A76523050EA5E65372FC50771953D7782AAE121CBC211446817BB` |
| **v10**（全面劣于 v9） | `.cfb-offline/kaggle-out/v10/rwkv7-compressor/model/model.safetensors` | 764,179,920 | `8D64231D217E3013172C505050CE0FE27823DF2519F9B77EAF0C1545AFC9F926` |

**注意：两者字节数完全相同（764,179,920）但哈希不同** —— 是同一架构的两次训练，不是同一份文件。

**拿回来的办法（按推荐顺序）**：
1. **Kaggle 数据集**（免费、机制已写好）：`deploy/kaggle/start-rwkv7.py` 与 `deploy/kaggle/start-infer.py` 里的 `MODEL_DATASET` 常量指向 `liaocr/cfb-rwkv7-v9`。把 `model/` 目录打包上传即可（该目录里有现成的 `dataset-metadata.json`）。
2. **HuggingFace**（需 `HF_TOKEN`，当前为空）。
3. **重训**：数据与配置都在库（`deploy/kaggle/train_rwkv7.py` + `.cfb-offline/sft/`），v9 约 30 分钟 / v10 约 77 分钟，消耗 Kaggle GPU 配额。

### 2.2 第三方可重下的内容（故意不入库）

| 路径 | 体积 | 为什么排除 |
|---|---:|---|
| `.cfb-offline/tfwhl/` | 58.2 MB / 2646 文件 | 下载解包的 `transformers` 等 wheel，`pip install` 即可重得 |
| `.cfb-offline/_fla_core/`、`_fla_whl/` | 4.5 MB / 473 文件 | 解包的 `fla-core` / `flash-linear-attention` wheel |
| `.cfb-offline/*.whl` | 1.6 MB | 同上 |
| `**/__pycache__/` | — | 字节码缓存 |

---

## 3. 入库前排除的一个真密钥

`.cfb-offline/_kagtoken.py` 第 6 行**明文写着你的 Kaggle API token**（`KGAT_...`）。

- 已把它**移出仓库**到 `D:\cfb-kagtoken-BACKUP.py`（没删）。
- **该 token 仍应在 Kaggle 账户里轮换一次** —— 它在本机磁盘上以明文存在过。
- 全仓扫描（4516 个文件）确认这是唯一一处真密钥。
- `test/training-ready.selftest.mjs:48` 里的 `sk-1234567890abcdefghijklmnop` 是**故意构造的负例夹具**（测试断言它被 `training-secret-material` 拒绝），不是泄露。
- `.secrets/keys.env` 在本机**不存在**（DeepSeek 凭据没有以文件形式留在仓库里）。

---

## 4. 换机器后的恢复顺序

```bash
git clone https://github.com/liaocr/cfb.git
cd cfb
npm run restore          # 从 transfer/cycle-state.json 恢复 .cfb-offline
npm run manifest:check   # 校验 MANIFEST.sha256 零漂移
npm test                 # 快速自检（Windows 上会按设计跳过 8 项）
```

模型权重按 §2.1 拿回，放到 `.cfb-offline/kaggle-out/rwkv7-compressor/model/` 下即可（可用 SHA-256 核对是否同一份）。

---

## 5. 一句话现状

- **生产侧**（`src/` 24 模块）在库里，完整。
- **教师数据** 33 MB，在库里，完整，**不再需要重花钱**。
- **两个学生模型权重** 1.4 GB，**不在库里**，见 §2.1。
- **E1/E2 外部终验**（把压缩稿喂回目标模型真跑）**从未执行过** —— 对教师、对学生都没有。
