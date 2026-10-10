#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 v9 训练产物推上 Kaggle 跑推理，产出 effect-eval 要用的变体稿。

为什么走 Kaggle 而不是本地
--------------------------
本地没有 torch、没有 fla、没有 GPU（实测三个 ModuleNotFoundError）。
RWKV7 的 fla kernel 只能在 GPU 上跑，所以推理必须上 Kaggle。
这和训练用的是同一个内核基础设施，只是换了个入口。

为什么用**已训练好的权重**而不是重训
------------------------------------
train_rwkv7.py 里 --seed 默认 20261007 且 torch.manual_seed(args.seed) 已设，
理论上可复现。但"理论上可复现"是这一整个项目里最不可信的一类断言
（v8 丢过一整轮训练；v9/v10 的 loss 曲线在同样的 5 轮上差 7 倍而原因至今未查清）。
**要测的是 v9 这个真实产物，不是"一个按同样配方重跑出来的东西"。**
所以把 .cfb-offline/kaggle-out/rwkv7-compressor/model 原样上传成数据集。

数据集挂载点
------------
Kaggle 把 dataset 挂在 /kaggle/input/<slug>，但 --dir-mode tar 上传后的
实际布局不能想当然。所以这里**运行时探测**：在 /kaggle/input 下找
同时含 config.json 与 *.safetensors 的目录。找不到就直接报错，
不猜路径 —— 猜错的表现是"加载了一个随机初始化的底座"，
而那个不会报错，只会产出一堆垃圾稿。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SLUG = "cfb-rwkv7-infer"
MODEL_DATASET = "liaocr/cfb-rwkv7-v9"
PAIRS_URL = ("https://raw.githubusercontent.com/liaocr/cfb/main/"
             "deploy/kaggle/data/effect-pairs.jsonl")
OUT_DIR = "/kaggle/working/infer"

# 模型路径探测必须在**内核内**跑（/kaggle/input 只在 Kaggle 上存在）。
FIND_MODEL = '''

def _find_model():
    """在 /kaggle/input 下找模型目录。找不到就报错，绝不猜。"""
    import glob, os
    hits = []
    for pat in ("/kaggle/input/*/config.json", "/kaggle/input/*/*/config.json",
                "/kaggle/input/*/*/*/config.json"):
        for c in glob.glob(pat):
            d = os.path.dirname(c)
            if glob.glob(os.path.join(d, "*.safetensors")):
                hits.append(d)
    if not hits:
        raise SystemExit("FATAL: /kaggle/input 下没有同时含 config.json 与 *.safetensors 的目录。"
                         "数据集没挂上，或者 --dir-mode tar 的布局与预期不同。")
    hits.sort(key=len)
    print("· 模型目录探测到 " + str(len(hits)) + " 个：" + " | ".join(hits), flush=True)
    return hits[0]
'''


def build_kernel(args) -> str:
    src = (HERE / "infer_rwkv7.py").read_text(encoding="utf-8")
    marker = 'if __name__ == "__main__":'
    if marker not in src:
        sys.exit("FATAL: infer_rwkv7.py 里找不到 __main__ 块。")
    body = src[: src.index(marker)].rstrip() + "\n"
    body += FIND_MODEL
    argv = [
        "--model", "__MODEL__",
        "--in", args.pairs,
        "--out", OUT_DIR + "/drafts.jsonl",
        "--max-new", str(args.max_new),
        "--chunk-size", str(args.chunk_size),
    ]
    entry = (
        "\n\n# ── 由 start-infer.py 注入的入口（Kaggle script kernel 不能传命令行参数）──\n"
        "if __name__ == \"__main__\":\n"
        "    import os, urllib.request\n"
        "    os.makedirs(" + json.dumps(OUT_DIR) + ", exist_ok=True)\n"
        "    _argv = [\n"
        + "".join(f"        {json.dumps(a)},\n" for a in argv)
        + "    ]\n"
        "    _argv[_argv.index(\"--model\") + 1] = _find_model()\n"
        "    # --in 是 URL，而 infer_rwkv7.py 用 open() 读它 —— open() 不认 URL。\n"
        "    # 不先落地就会 FileNotFoundError，而那要排队几十分钟才暴露。\n"
        "    _in = _argv[_argv.index(\"--in\") + 1]\n"
        "    if str(_in).startswith(\"http\"):\n"
        "        _dst = " + json.dumps(OUT_DIR) + " + \"/pairs.jsonl\"\n"
        "        _req = urllib.request.Request(_in, headers={\"User-Agent\": \"cfb-rwkv7-infer\"})\n"
        "        with urllib.request.urlopen(_req, timeout=120) as _r:\n"
        "            open(_dst, \"wb\").write(_r.read())\n"
        "        print(\"· 输入已下载 -> \" + _dst + \"（\" + str(os.path.getsize(_dst)) + \" 字节）\", flush=True)\n"
        "        _argv[_argv.index(\"--in\") + 1] = _dst\n"
        "    sys.exit(main(_argv))\n"
    )
    return body + entry


def username() -> str:
    r = subprocess.run([sys.executable, "-m", "kaggle", "config", "view"],
                       capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.strip().startswith("- username:"):
            return line.split(":", 1)[1].strip()
    sys.exit("FATAL: 读不到 Kaggle 用户名。")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", default=PAIRS_URL, help="推理输入 jsonl（本地路径或 URL）")
    ap.add_argument("--max-new", type=int, default=1024,
                    help="单条生成上限 token。教师 p90 是 607、max 750，"
                         "1024 足够；768 会截断（实测 v9 有 10/89 条撞顶）")
    ap.add_argument("--chunk-size", type=int, default=16)
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    user = username()
    kid = f"{user}/{SLUG}"

    if args.status:
        return subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid]).returncode

    code = build_kernel(args)
    work = Path(tempfile.mkdtemp(prefix="cfb-rwkv7-infer-"))
    (work / "kernel.py").write_text(code, encoding="utf-8")
    meta = {
        "id": kid,
        "title": "CFB RWKV7 infer",
        "code_file": "kernel.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "machine_shape": "NvidiaTeslaT4",
        "dataset_sources": [MODEL_DATASET],
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
    }
    (work / "kernel-metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"· 内核 {kid} · 数据集 {MODEL_DATASET} · 合成 kernel.py {len(code)} 字符")
    print(f"· 工作目录 {work}")
    r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "push", "-p", str(work)])
    if r.returncode != 0:
        print(f"FATAL: push 失败（退出码 {r.returncode}）", file=sys.stderr)
        return r.returncode
    print(f"· 已推送。运行页：https://www.kaggle.com/code/{kid}")
    print(f"· 拉产物：python -m kaggle kernels output {kid} -p .cfb-offline/effect/infer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
