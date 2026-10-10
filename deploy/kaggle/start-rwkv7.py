#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令把 RWKV7 压缩器训练内核推到 Kaggle 并开跑。

用法：
  curl -sSL https://raw.githubusercontent.com/liaocr/cfb/main/deploy/kaggle/start-rwkv7.py | python3 -

它做四件事：
  1. 找到（必要时安装）kaggle CLI；
  2. 读凭据（~/.kaggle/kaggle.json，或 KAGGLE_USERNAME/KAGGLE_KEY）；
  3. 下载内核脚本 + 数据，生成 kernel-metadata.json（**GPU 必须是 T4**、Internet 开）；
  4. kaggle kernels push —— 推送即开跑，打印运行页链接。

⚠ 为什么强制 T4：fla 依赖 Triton kernel，需要 sm_70+。Kaggle 的 P100 是 sm_60，
   kernel 编不出来。训练器自己也会在启动时检查计算能力并拒绝 P100。

⚠ Kaggle 从 raw.githubusercontent.com/liaocr/cfb/main 拉代码 —— **本地 commit 对 Kaggle
   不可见，必须先 push**。否则跑的是旧版本，而且不会有任何报错。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/liaocr/cfb/main"
SLUG = "cfb-rwkv7-compressor"
FILES = {
    "train_rwkv7.py": f"{BASE}/deploy/kaggle/train_rwkv7.py",
    "train.jsonl": f"{BASE}/deploy/kaggle/data/sft-train.jsonl",
    "dev.jsonl": f"{BASE}/deploy/kaggle/data/sft-dev.jsonl",
}


def find_kaggle():
    exe = shutil.which("kaggle")
    if exe:
        return [exe]
    print("· 未找到 kaggle CLI，正在安装（pip install kaggle）…")
    if subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "kaggle"]).returncode != 0:
        sys.exit("安装 kaggle CLI 失败；请手动 pip install kaggle 后重试。")
    exe = shutil.which("kaggle")
    return [exe] if exe else [sys.executable, "-m", "kaggle"]


def credentials():
    user, key = os.environ.get("KAGGLE_USERNAME"), os.environ.get("KAGGLE_KEY")
    cfg = Path.home() / ".kaggle" / "kaggle.json"
    if (not user or not key) and cfg.exists():
        try:
            d = json.loads(cfg.read_text())
            user, key = d.get("username"), d.get("key")
        except Exception as exc:
            sys.exit(f"读取 {cfg} 失败：{exc}")
    if not user or not key:
        sys.exit(
            "找不到 Kaggle 凭据。任选其一：\n"
            "  A) https://www.kaggle.com/settings/account → Create New Token →\n"
            "     把下载的 kaggle.json 放到 ~/.kaggle/kaggle.json\n"
            "  B) export KAGGLE_USERNAME=你的用户名 KAGGLE_KEY=你的key\n"
            "然后重跑同一条命令。"
        )
    return user, key


def main():
    kaggle = find_kaggle()
    user, _ = credentials()
    print(f"· Kaggle 用户：{user}")

    work = Path(tempfile.mkdtemp(prefix="cfb-rwkv7-"))
    print(f"· 工作目录：{work}")
    for name, url in FILES.items():
        print(f"· 下载 {name} …")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cfb-start"})
            with urllib.request.urlopen(req, timeout=180) as r:
                (work / name).write_bytes(r.read())
        except Exception as exc:
            sys.exit(f"下载 {url} 失败：{exc}\n"
                     "（若 data/ 还不存在，先在本地跑 tools/build-sft.mjs 并把结果提交到 "
                     "deploy/kaggle/data/ 再 push。）")

    # 冒烟优先：默认只跑冒烟，验证环境；加 --train 才真训
    mode = "train" if "--train" in sys.argv else "smoke"
    cmd = ["python", "train_rwkv7.py", "--data", "train.jsonl", "--dev", "dev.jsonl"]
    if mode == "smoke":
        cmd += ["--smoke"]
    else:
        cmd += ["--out", "/kaggle/working/rwkv7-compressor"]
    code = " ".join(cmd)

    meta = {
        "id": f"{user}/{SLUG}",
        "title": f"CFB RWKV7 compressor ({mode})",
        "code_file": "train_rwkv7.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "dataset_sources": [],
        "kernel_sources": [],
        "competition_sources": [],
    }
    (work / "kernel-metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"· 推送内核（{mode}）…")
    r = subprocess.run(kaggle + ["kernels", "push", "-p", str(work)])
    if r.returncode != 0:
        sys.exit(f"kaggle kernels push 失败（退出码 {r.returncode}）。")
    print(f"· 已推送。运行页：https://www.kaggle.com/code/{user}/{SLUG}")
    print(f"· 内核入口：{code}")


if __name__ == "__main__":
    main()
