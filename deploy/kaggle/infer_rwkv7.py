#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RWKV7 压缩微模型 · 推理端：把任意思维链压成压缩稿。

和 train_rwkv7.py 共用同一套环境前置（fla 引导 / chunk_size）与同一套
chat_template 渲染。训练和推理的格式只要差一个字符，模型就会吐出
"看起来像稿子的垃圾"，而且不会有任何指标报警 —— 所以 render() 是从
训练器里抄过来的，不是重写的。

用法
----
  # 批量：pairs.jsonl 每行 {id, ctx, raw} -> drafts.jsonl 每行 {id, draft, tokens, seconds}
  python infer_rwkv7.py --model model/ --in pairs.jsonl --out drafts.jsonl

  # 单条：题面和思考过程各放一个文件
  python infer_rwkv7.py --model model/ --ctx-file 题面.txt --raw-file 思考.txt

  # 换系统提示词（默认本机找不到就从 GitHub raw 拉 teacher2-zh.txt）
  python infer_rwkv7.py --model model/ --system-file teacher2-zh.txt --in pairs.jsonl

注意
----
* 系统提示词必须与训练时**逐字相同**。它是样例驱动的提示词，样例是模型
  唯一真正读的东西，少一个换行都会让输出漂移。
* 生成是逐条贪心解码，没有批处理。RWKV7 在 T4 上实测约 7 token/s，
  768 token 一条要 ~110 秒。要快就上更小的 --max-new 或更好的卡。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_SYSTEM_URL = (
    "https://raw.githubusercontent.com/liaocr/cfb/main/transfer/prompts/teacher2-zh.txt"
)


# ───────────────────────── 环境前置（与训练器一致） ─────────────────────────

def ensure_fla() -> None:
    """Kaggle 镜像里没有 fla，必须自己装；装哪个包有讲究。

    实测 PyPI wheel 内容（不是猜）：
      · fla-core 0.5.2               = fla/ops + fla/modules + fla/utils，**没有 fla/models**
      · flash-linear-attention 0.5.2 = fla/layers + fla/models，依赖 fla-core==0.5.2
    而 HF 仓库 fla-hub/rwkv7-0.1B-g1 的 modeling_rwkv7.py 只是 157 字符的转发，
    所以 trust_remote_code=True 也救不了。--no-deps + 显式列依赖，避免 pip
    顺手升级 torch/transformers 把环境搞坏。
    """
    try:
        from fla.models.rwkv7 import RWKV7ForCausalLM  # noqa: F401
        return
    except Exception as exc:  # noqa: BLE001
        print(f"· fla.models.rwkv7 缺失（{exc!r}）-> 装 flash-linear-attention==0.5.2", flush=True)
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps",
           "--progress-bar", "off",
           "flash-linear-attention==0.5.2", "fla-core==0.5.2", "einops"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("FATAL: 装 flash-linear-attention 失败：\n" + r.stderr[-3000:])
    from fla.models.rwkv7 import RWKV7ForCausalLM  # noqa: F401


def patch_chunk_size(chunk_size: int) -> None:
    """T4 的 64KB 共享内存装不下 fla 默认的 chunk_size=64。

    fla/layers/rwkv7.py:310 训练时写死 chunk_rwkv7(..., safe_gate=True, chunk_size=64)，
    safe_gate=True 会选 tensorcore 版 intra 反向 kernel，那个 kernel 里 4 个 [BT,BT]
    的 dA 矩阵在 BT=64 时共 32KB，加六个 [BT,BK] 合计 ~96KB > 64KB。
    fla 自己在 dplr/chunk.py:156 写着 "we only support chunk_size=16 when safe_gate=True"。
    推理路径也走同一个 chunk_rwkv7，所以这里同样要压。
    """
    if chunk_size <= 0:
        return
    import fla.layers.rwkv7 as _fla
    _orig = _fla.chunk_rwkv7

    def _small(*a, **kw):
        kw["chunk_size"] = chunk_size
        return _orig(*a, **kw)

    _fla.chunk_rwkv7 = _small
    print(f"· chunk_size {chunk_size}", flush=True)


def load_system(spec: str | None) -> str:
    """系统提示词：本地路径优先，其次 URL，最后 GitHub raw 默认那份。

    只存一份、只读一份。两边各留一份副本必然漂移，而漂移不会报错，
    只会让模型学到一个用不上的映射（build-sft.mjs 里踩过这个坑）。
    """
    cands: list[str] = []
    if spec:
        cands.append(spec)
    cands.append("transfer/prompts/teacher2-zh.txt")
    here = Path(__file__).resolve().parent
    cands.append(str(here / ".." / ".." / "transfer" / "prompts" / "teacher2-zh.txt"))
    for c in cands:
        p = Path(c)
        if p.is_file():
            txt = p.read_text(encoding="utf-8")
            print(f"· 系统提示词 {p}", flush=True)
            break
    else:
        url = spec if (spec or "").startswith("http") else DEFAULT_SYSTEM_URL
        print(f"· 系统提示词从远端拉 {url}", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "cfb-rwkv7-infer"})
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode("utf-8")
    # 与 build-sft.mjs 完全同一套处理：丢掉 # 注释行，保留换行
    return "\n".join(l for l in txt.splitlines() if not l.strip().startswith("#")).strip()


def render(tok, messages, add_gen: bool) -> str:
    """底座原生 chat_template。

    RWKV7 g1 的模板把思考开关放在 add_generation_prompt 分支里：
        {% if add_generation_prompt %}
          {% if enable_thinking is defined and enable_thinking == False %}
            Assistant: <think\\n</think>
          {% else %}
            Assistant: <think
    不显式传 enable_thinking=False 就会渲染出**未闭合**的 'Assistant: <think'，
    与关思考产出的教师稿错配。所以这里必须传。
    """
    try:
        return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_gen,
                                       enable_thinking=False)
    except TypeError:
        return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_gen)


def user_block(ctx: str, raw: str) -> str:
    """与 build-sft.mjs 里拼 user 的那两行逐字一致。"""
    return "[题面]\n" + ctx + "\n\n[思考过程]\n" + raw


# ─────────────────────────────── 主流程 ───────────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="训练产出的目录（save_pretrained 的那个）")
    ap.add_argument("--in", dest="inp", default=None, help="输入 jsonl，每行 {id, ctx, raw}")
    ap.add_argument("--out", default=None, help="输出 jsonl；不给就打印到 stdout")
    ap.add_argument("--ctx-file", default=None, help="单条模式的题面文件")
    ap.add_argument("--raw-file", default=None, help="单条模式的思考过程文件")
    ap.add_argument("--system-file", default=None, help="系统提示词：本地路径或 http(s) URL")
    ap.add_argument("--max-new", type=int, default=768)
    ap.add_argument("--dtype", default="fp16", choices=["fp16", "fp32"])
    ap.add_argument("--chunk-size", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 条，0=全部")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    import torch
    if not torch.cuda.is_available():
        raise SystemExit("FATAL: 没有 CUDA。RWKV7 的 fla kernel 只能跑在 GPU 上。")
    cap = torch.cuda.get_device_capability(0)
    if cap[0] < 7:
        raise SystemExit(f"FATAL: sm_{cap[0]}{cap[1]} < sm_70，fla 的 Triton kernel 编不出来。")
    device = torch.device("cuda", 0)
    print(f"· GPU {torch.cuda.get_device_name(0)} · sm_{cap[0]}{cap[1]} · torch {torch.__version__}",
          flush=True)

    ensure_fla()
    patch_chunk_size(args.chunk_size)

    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.float16 if args.dtype == "fp16" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(args.model, trust_remote_code=True, dtype=dtype)
    model.config.use_l2warp = False   # l2warp 只在算 loss 时用，推理不需要，且 fp16 下会崩
    model.eval().to(device)
    print(f"· 模型载入 {args.model} · {args.dtype}", flush=True)

    system = load_system(args.system_file)

    # 输入
    items: list[dict] = []
    if args.inp:
        with open(args.inp, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
    elif args.ctx_file and args.raw_file:
        items.append({"id": "single",
                      "ctx": Path(args.ctx_file).read_text(encoding="utf-8"),
                      "raw": Path(args.raw_file).read_text(encoding="utf-8")})
    else:
        raise SystemExit("FATAL: 要么给 --in，要么同时给 --ctx-file 和 --raw-file。")
    if args.limit:
        items = items[: args.limit]
    if not items:
        raise SystemExit("FATAL: 输入是空的。")

    eos_id = tok.eos_token_id
    out_f = open(args.out, "w", encoding="utf-8") if args.out else None
    t_all = time.time()
    try:
        for i, it in enumerate(items, 1):
            prompt = render(tok, [{"role": "system", "content": system},
                                  {"role": "user", "content": user_block(it.get("ctx", ""),
                                                                         it.get("raw", ""))}], True)
            enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
            n_in = int(enc["input_ids"].shape[1])
            t0 = time.time()
            with torch.no_grad():
                o = model.generate(**enc, max_new_tokens=args.max_new, do_sample=False,
                                   pad_token_id=tok.pad_token_id, eos_token_id=eos_id)
            n_out = int(o.shape[1]) - n_in
            txt = tok.decode(o[0][n_in:], skip_special_tokens=True).strip()
            rec = {"id": it.get("id"), "draft": txt, "promptTokens": n_in,
                   "newTokens": n_out, "seconds": round(time.time() - t0, 1),
                   "truncated": n_out >= args.max_new}
            line = json.dumps(rec, ensure_ascii=False)
            if out_f:
                out_f.write(line + "\n")
                out_f.flush()
            else:
                print(line, flush=True)
            print(f"· {i}/{len(items)} {rec['newTokens']} token / {rec['seconds']}s"
                  f"{' （撞到 --max-new，可能被截断）' if rec['truncated'] else ''}",
                  file=sys.stderr, flush=True)
    finally:
        if out_f:
            out_f.close()
    print(f"· 完成 {len(items)} 条，共 {(time.time()-t_all)/60:.1f} 分钟", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
