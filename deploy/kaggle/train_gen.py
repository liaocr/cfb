#!/usr/bin/env python3
"""Kaggle 内核脚本：一键训练生成式压缩器（Round 0 · 教师 v0.3）。

在 Kaggle 上作为 script kernel 运行（GPU T4×2 + Internet ON）。
流程：装依赖 → 从 GitHub 克隆本仓库（公开）→ 用 v3 教师语料跑 QLoRA → 打印读数 → 打包产物。
"""
import json
import os
import subprocess
import sys
import time

REPO = "https://github.com/liaocr/cfb.git"
WORK = "/kaggle/working"
CLONE = f"{WORK}/cfb"
RUN = f"{WORK}/run1"


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

    print("=== 拉取仓库（含 v3 语料与训练脚本）===", flush=True)
    if not os.path.exists(CLONE):
        sh(f"git clone --depth 1 {REPO} {CLONE}")
    else:
        sh(f"git -C {CLONE} pull --ff-only")

    train = f"{CLONE}/transfer/models/micro-generator-gen-v3/train.jsonl.gz"
    dev = f"{CLONE}/transfer/models/micro-generator-gen-v3/dev.jsonl.gz"
    trainer = f"{CLONE}/tools/micro-generator/train_gen_kaggle.py"
    for f in (train, dev, trainer):
        assert os.path.exists(f), f"缺文件：{f}"

    with open(f"{CLONE}/transfer/models/micro-generator-gen-v3/corpus-report.json") as fh:
        rep = json.load(fh)
    print("语料：train", rep["train"]["rows"], "条 /", rep["train"]["repos"], "仓库 · dev", rep["dev"]["rows"], "条（7 轴全过）", flush=True)

    print("=== 训练 ===", flush=True)
    sh(f"{sys.executable} {trainer} --train {train} --dev {dev} --out {RUN} "
       f"--model-id Qwen/Qwen3-0.6B --epochs 2 --lr 1e-4 --max-len 5120 --batch 1 --grad-accum 16 --eval-samples 12")

    print("=== 读数 ===", flush=True)
    meta = json.load(open(f"{RUN}/run-meta.json"))
    print(json.dumps({k: meta[k] for k in ("trainRows", "trainExamplesUsed", "skippedOverMaxLen",
                                           "finalLossAvg50", "trainingSeconds", "devMetrics")}, ensure_ascii=False, indent=2), flush=True)

    print("=== 打包 ===", flush=True)
    import shutil
    zip_path = shutil.make_archive(f"{WORK}/cfb-gen-compressor-run1", "zip", root_dir=RUN)
    print("产物：", zip_path, os.path.getsize(zip_path), "bytes · 总耗时", int(time.time() - t0), "s", flush=True)
    print("下载：Kaggle 右侧 Output → cfb-gen-compressor-run1.zip（含 adapter/、dev-predictions.jsonl、run-meta.json）", flush=True)


if __name__ == "__main__":
    main()
