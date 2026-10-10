#!/usr/bin/env python3
"""Kaggle 内核脚本：一键训练生成式压缩器（Round 0 · 教师 v0.3）。

在 Kaggle 上作为 script kernel 运行（GPU T4×2 + Internet ON）。
流程：装依赖 → 从 GitHub 克隆本仓库（公开）→ 用 v5 教师语料跑 QLoRA → 打印读数 → 打包产物。

⚠ 语料版本（v14.25.5 更正）：本脚本原用 **v3**（train 仅 937 条），而 v5 有 **6001 条**（6.4 倍，
   dev 完全相同 —— 139 条、124 条 7 轴全过）。v3 与 v4/v5 的 dev 内容一致但行序不同
   ⇒ 两者的 dev-loss 数字**不可直接比较**。现统一为 v5，与 `deploy/kaggle/train_micro.py` /
   `repred_micro.py` 一致。可用环境变量 `CFB_GEN_CORPUS` 覆盖（如 v4 复现旧读数）。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ★ 本脚本从 GitHub 拉代码 ⇒ **本地未推送的修复，Kaggle 看不见**。
#   跑之前务必确认：`git -C <本仓> status --short` 干净、且 `git log origin/main..main` 为空。
#   可用 CFB_GEN_REPO / CFB_GEN_REF 指向你自己的 fork 或分支。
REPO = os.environ.get("CFB_GEN_REPO", "https://github.com/liaocr/cfb.git")
REF = os.environ.get("CFB_GEN_REF", "main")
WORK = "/kaggle/working"
CLONE = f"{WORK}/cfb"
RUN = f"{WORK}/run1"
# 语料版本：默认 v5（6001 条 train）。v4=3683 条，v3=937 条（旧默认，仅用于复现历史读数）。
CORPUS = os.environ.get("CFB_GEN_CORPUS", "v5")


def sh(cmd, **kw):
    print(f"\n$ {cmd}", flush=True)
    return subprocess.run(cmd, shell=True, check=True, **kw)


def main():
    t0 = time.time()
    print("=== 环境 ===", flush=True)
    import torch
    print("python", sys.version.split()[0], "| torch", torch.__version__, "| cuda", torch.cuda.is_available(),
          "| gpus", torch.cuda.device_count(), flush=True)
    if not torch.cuda.is_available():
        print("FATAL: 没开 GPU。Notebook 设置 → Accelerator → GPU T4 x2 后重跑。", flush=True)
        sys.exit(2)

    print("=== 依赖 ===", flush=True)
    sh(f"{sys.executable} -m pip install --quiet 'transformers>=4.51,<5' 'peft>=0.15,<1' 'accelerate>=1.6,<2' 'bitsandbytes>=0.45,<1'")

    print(f"=== 拉取仓库（含 {CORPUS} 语料与训练脚本）===", flush=True)
    if not os.path.exists(CLONE):
        sh(f"git clone --depth 1 --branch {REF} {REPO} {CLONE}")
    else:
        sh(f"git -C {CLONE} fetch --depth 1 origin {REF} && git -C {CLONE} checkout FETCH_HEAD")

    # ★ 把实际拉到的 commit 打出来并写进产物：否则事后无法判断某次 Kaggle 读数属于哪一版代码。
    commit = subprocess.run(f"git -C {CLONE} rev-parse HEAD", shell=True, capture_output=True,
                            text=True).stdout.strip()
    subject = subprocess.run(f"git -C {CLONE} log -1 --format=%s", shell=True, capture_output=True,
                             text=True).stdout.strip()
    print(f"仓库：{REPO} @ {REF} ⇒ {commit[:12]} {subject}", flush=True)
    Path(f"{WORK}/REPO-COMMIT.txt").write_text(f"{commit}  ({REF})\n{subject}\n", encoding="utf-8")

    corpus_dir = f"{CLONE}/transfer/models/micro-generator-gen-{CORPUS}"
    train = f"{corpus_dir}/train.jsonl.gz"
    dev = f"{corpus_dir}/dev.jsonl.gz"
    trainer = f"{CLONE}/tools/micro-generator/train_gen_kaggle.py"
    for f in (train, dev, trainer):
        assert os.path.exists(f), f"缺文件：{f}（CFB_GEN_CORPUS={CORPUS} 是否正确？可选 v3/v4/v5）"

    with open(f"{corpus_dir}/corpus-report.json") as fh:
        rep = json.load(fh)
    print("语料：train", rep["train"]["rows"], "条 /", rep["train"]["repos"], "仓库 · dev", rep["dev"]["rows"], "条（7 轴全过）", flush=True)

    gpus = torch.cuda.device_count()
    accum = max(1, 16 // gpus)  # 保持有效 batch 不变：单卡 16，双卡 8×2
    print(f"=== 训练（{gpus} 张 GPU · 每卡 batch 1 × accum {accum} ⇒ 有效 batch {accum * gpus}）===", flush=True)
    train_args = (f"--train {train} --dev {dev} --out {RUN} --model-id Qwen/Qwen3-0.6B "
                  f"--epochs 2 --lr 1e-4 --max-len 5120 --batch 1 --grad-accum {accum} --eval-samples 12")
    if gpus >= 2:
        ddp_cmd = (f"{sys.executable} -m torch.distributed.run --nproc_per_node {gpus} "
                   f"--master_port 29517 {trainer} {train_args}")
        r = subprocess.run(ddp_cmd, shell=True, text=True)
        if r.returncode != 0:
            print("!! DDP 失败，回退单卡重跑（日志在上面）", flush=True)
            sh(f"{sys.executable} {trainer} --train {train} --dev {dev} --out {RUN} "
               f"--model-id Qwen/Qwen3-0.6B --epochs 2 --lr 1e-4 --max-len 5120 --batch 1 --grad-accum 16 --eval-samples 12")
    else:
        sh(f"{sys.executable} {trainer} {train_args}")

    print("=== 读数 ===", flush=True)
    meta = json.load(open(f"{RUN}/run-meta.json"))
    print(json.dumps({k: meta[k] for k in ("trainRows", "trainExamplesUsed", "skippedOverMaxLen",
                                           "finalLossAvg50", "trainingSeconds", "devMetrics")}, ensure_ascii=False, indent=2), flush=True)

    summ = {k: meta[k] for k in ("trainRows", "trainExamplesUsed", "skippedOverMaxLen",
                                 "finalLossAvg50", "trainingSeconds")}
    summ.update(meta["devMetrics"])
    # ★ 血缘：没有 commit/语料版本/超参，事后无法判断这个读数属于哪一次实验。
    summ = {"repoCommit": commit, "repoRef": REF, "corpusVersion": CORPUS, **summ,
            "hyperparams": {"modelId": "Qwen/Qwen3-0.6B", "epochs": 2, "lr": 1e-4,
                            "maxLen": 5120, "batch": 1, "gradAccum": accum, "gpus": gpus}}
    Path(f"{WORK}/RESULTS.txt").write_text(json.dumps(summ, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("=== 结果落盘 /kaggle/working/RESULTS.txt ===", flush=True)
    print(json.dumps(summ, ensure_ascii=False, indent=2), flush=True)

    print("=== 打包 ===", flush=True)
    import shutil
    shutil.copy(f"{WORK}/RESULTS.txt", f"{RUN}/RESULTS.txt")
    zip_path = shutil.make_archive(f"{WORK}/cfb-gen-compressor-run1", "zip", root_dir=RUN)
    print("产物：", zip_path, os.path.getsize(zip_path), "bytes · 总耗时", int(time.time() - t0), "s", flush=True)
    print("下载：Kaggle 右侧 Output → cfb-gen-compressor-run1.zip（含 adapter/、dev-predictions.jsonl、run-meta.json）", flush=True)


if __name__ == "__main__":
    main()
