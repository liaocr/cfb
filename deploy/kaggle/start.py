#!/usr/bin/env python3
"""一键开训：把生成式压缩器内核推到 Kaggle 并立即开跑。

用法（一条命令）：
  curl -sSL https://raw.githubusercontent.com/liaocr/cfb/main/deploy/kaggle/start.py | python3 -

它做四件事：
  1. 找到（必要时安装）kaggle CLI；
  2. 读取 Kaggle 凭据（~/.kaggle/kaggle.json，或 KAGGLE_USERNAME/KAGGLE_KEY 环境变量）；
  3. 下载内核脚本 + 生成 kernel-metadata.json（GPU 开、Internet 开）；
  4. `kaggle kernels push` —— 推送即开跑，并打印运行页面链接。
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

RAW = "https://raw.githubusercontent.com/liaocr/cfb/main/deploy/kaggle/train_gen.py"
SLUG = "cfb-gen-compressor-train"


def run(cmd, **kw):
    return subprocess.run(cmd, **kw)


def find_kaggle():
    exe = shutil.which("kaggle")
    if exe:
        return [exe]
    print("· 未找到 kaggle CLI，正在安装（pip install kaggle）…")
    r = run([sys.executable, "-m", "pip", "install", "--quiet", "kaggle"])
    if r.returncode != 0:
        sys.exit("安装 kaggle CLI 失败；请手动 `pip install kaggle` 后重试。")
    exe = shutil.which("kaggle")
    return [exe] if exe else [sys.executable, "-m", "kaggle"]


def credentials():
    user = os.environ.get("KAGGLE_USERNAME")
    key = os.environ.get("KAGGLE_KEY")
    cfg = Path.home() / ".kaggle" / "kaggle.json"
    if (not user or not key) and cfg.exists():
        try:
            d = json.loads(cfg.read_text())
            user, key = d.get("username"), d.get("key")
        except Exception as exc:
            sys.exit(f"读取 {cfg} 失败：{exc}")
    if not user or not key:
        sys.exit(
            "找不到 Kaggle 凭据。请任选其一：\n"
            "  A) 打开 https://www.kaggle.com/settings/account → Create New Token → 把下载的 kaggle.json 放到 ~/.kaggle/kaggle.json\n"
            "  B) export KAGGLE_USERNAME=你的用户名 KAGGLE_KEY=你的key\n"
            "然后重新执行同一条命令。"
        )
    return user, key


def main():
    kaggle = find_kaggle()
    user, _ = credentials()
    print(f"· Kaggle 用户：{user}")

    work = Path(tempfile.mkdtemp(prefix="cfb-kaggle-"))
    print(f"· 工作目录：{work}")

    print("· 下载内核脚本…")
    with urllib.request.urlopen(RAW, timeout=60) as resp:
        (work / "train_gen.py").write_bytes(resp.read())

    meta = {
        "id": f"{user}/{SLUG}",
        "title": "CFB Gen Compressor Train (round 0, teacher v0.3)",
        "code_file": "train_gen.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "dataset_sources": [],
        "competition_sources": [],
        "kernel_sources": [],
        "model_sources": [],
    }
    (work / "kernel-metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
    print("· 内核元数据：GPU 开 · Internet 开 · 私有")

    print("· 推送到 Kaggle 并开跑…")
    r = subprocess.run([*kaggle, "kernels", "push", "-p", str(work)], text=True)
    if r.returncode != 0:
        sys.exit("推送失败（上一条输出里有原因）。常见：Kaggle 账号未验证手机（开 Internet 需要）或 API token 失效。")

    url = f"https://www.kaggle.com/code/{user}/{SLUG}"
    print("\n✅ 已开跑（约 35–60 分钟）。查看日志与产物：")
    print(f"   {url}")
    print("   跑完在页面 Output 里下载 cfb-gen-compressor-run1.zip（adapter + dev-predictions + run-meta）")
    print(f"   CLI 看状态： kaggle kernels status {user}/{SLUG}")


if __name__ == "__main__":
    main()
