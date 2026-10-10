#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CFB 通用思维链压缩微模型 —— RWKV7-0.1B 监督微调（Kaggle 单文件训练器）。

任务形态
--------
  system   = 压缩提示词（transfer/prompts/teacher2-zh.txt，与产稿时逐字相同）
  user     = [题面] ctx + [思考过程] raw
  assistant= 压缩稿 draft

为什么保留题面 ctx（实测，不是想当然）
--------------------------------------
对 100 条教师稿量过：43% 的稿子里出现了**只在题面、不在思考过程**里的代码味标识符
（如 tests/test_doccmd.py、corsheaders.models）。去掉题面会丢掉这些指代。窗口放宽到
4096 之后带题面能装 97.1%，装得下就没有取舍的必要。

为什么窗口写 4096 而不是 config 里的 2048
------------------------------------------
config.json 的 max_position_embeddings=2048 **在本模型的代码路径上从未被读取**：
  · fla/models/rwkv7/modeling_rwkv7.py 全文 545 行，该字段只出现 1 次（第 151 行），
    在 if attn_spec is not None: 的混合注意力分支里。本模型 config.attn = null -> 走 else
    分支创建 RWKV7Attention，压根不传这个参数。
  · fla/layers/rwkv7.py 全文 355 行：无 RoPE、无位置嵌入、无长度断言；chunk_size=64
    只是分块计算的效率参数。
  · tokenizer 的 model_max_length = 1e33（等于无限）。
  -> 2048 是配置残留，不是架构约束。RWKV 是循环结构，状态固定大小，成本 O(n) 而非 O(n²)。

实测收益 —— ★ 用**底座自己的分词器**量的，不是字符估算
------------------------------------------------------------------
拿 fla-hub 的 rwkv_vocab_v20230424.txt + hf_rwkv_tokenizer.py 在本地实跑（抽 469/4687 个单元）：
  · system 提示词 = 1188 token（**之前按字符估的是 912，低估 30%**）
  · 教师稿中位  = 368 token
  · user（题面+思考过程）p50 1832 / p90 2356 / max 4614

  窗口  2048：可训   0/469 =  0.0%
  窗口  4096：可训 438/469 = 93.4%
  窗口  5120：可训 463/469 = 98.7%
  窗口  6144：可训 468/469 = 99.8%   ← 取这个
  窗口  8192：可训 469/469 = 100.0%

⚠ 为什么不能拿 src/tokens.js 的 0.81/0.26 来算这个窗口：那两个系数是对
  **DeepSeek 的 usage** 做最小二乘拟合出来的，只对 DeepSeek 的分词器成立。
  RWKV 的 World 分词器效率不同 —— 窗口预算只能用 RWKV 自己的读数。

风险（只能实测，不能从源码推断）
--------------------------------
1. RWKV 的"状态容量"固定，序列越长状态越挤 —— 退化是渐进的，不是到点就崩。
2. g1 系列的预训练长度未公开。超过预训练长度属外推，"能跑"不等于"效果不变"。
3. fla 依赖 Triton kernel，需要 sm_70+。
   **Kaggle 的 P100 是 sm_60，会失败；必须选 T4（sm_75）。**

用法
----
  # 冒烟（不训练，只验证环境 + 窗口 + 前向 + 反传 + 生成，目标 30 分钟内出结论）
  python train_rwkv7.py --smoke --data train.jsonl --dev dev.jsonl

  # 真训
  python train_rwkv7.py --data train.jsonl --dev dev.jsonl --out /kaggle/working/rwkv7-compressor

失败即停，绝不静默降级：没有 CUDA、fla 导入失败、数据为空、全部超窗 —— 一律非零退出并打印原因。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

MODEL_ID = "fla-hub/rwkv7-0.1B-g1"
DEFAULT_MAX_LEN = 6144  # 不是 config 里的 2048，理由见模块 docstring（真实分词器实测 99.8%）


# ─────────────────────────── 数据 ───────────────────────────

def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"FATAL: {path}:{i} 不是合法 JSON：{exc}")
    return rows


def fetch(src: str, dest: Path) -> Path:
    """支持 http(s) URL 与本地路径。

    Kaggle 的 script kernel 不保证 cwd 就是代码所在目录，所以相对路径要依次试：
    当前 cwd → 本脚本所在目录。都不在就报清楚，不要静默读空文件。
    """
    if src.startswith(("http://", "https://")):
        import urllib.request
        dest.parent.mkdir(parents=True, exist_ok=True)
        last = None
        # 真实训练集有近 10MB，raw.githubusercontent 这条链路会偶发重置；
        # 一次就放弃等于白烧一整轮 kernel（含排队 + 装 fla + 载模型）。
        for i in range(4):
            try:
                req = urllib.request.Request(src, headers={"User-Agent": "cfb-rwkv7-trainer"})
                with urllib.request.urlopen(req, timeout=180) as r, dest.open("wb") as w:
                    w.write(r.read())
                print(f"· 下载 {src} -> {dest} ({dest.stat().st_size} bytes)", flush=True)
                return dest
            except Exception as exc:  # noqa: BLE001
                last = exc
                if i < 3:
                    print(f"· 下载失败（{exc!r}），{2 ** i}s 后重试 {i + 2}/4", flush=True)
                    time.sleep(2 ** i)
        raise SystemExit(f"FATAL: 下载失败 4 次：{src}\n  最后错误：{last!r}")
    p = Path(src)
    if p.is_file():
        return p
    alt = Path(__file__).resolve().parent / src
    if alt.is_file():
        print(f"· 相对路径落到脚本目录：{alt}", flush=True)
        return alt
    raise SystemExit(f"FATAL: 找不到数据文件 {src}（试过 {p.resolve()} 与 {alt}）")


# ─────────────────────────── 分词 ───────────────────────────

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


def encode(tok, row: dict, max_len: int, eos_id: int):
    """把一行变成 (input_ids, labels)。超窗返回 (None, 0)。

    ★ 掩码边界为什么不直接用 len(prompt_ids)
    BPE 在拼接处会跨边界合并，tok(prompt + draft) 的前 len(prompt_ids) 个 token
    未必等于 tok(prompt)。这里取**最长公共前缀**当边界，并把偏差记下来供观测。
    偏差持续偏大就说明模板或分词器与预期不符，是必须看见的信号。
    """
    msgs = [
        {"role": "system", "content": row["system"]},
        {"role": "user", "content": row["user"]},
        {"role": "assistant", "content": row["assistant"]},
    ]
    prompt = render(tok, msgs[:-1], True)
    # 训练序列 = 推理时真正会看到的前缀 + 目标 + 模板的助手后缀 + eos
    full = prompt + row["assistant"] + "\n\n"
    pids = tok(prompt, add_special_tokens=False)["input_ids"]
    ids = tok(full, add_special_tokens=False)["input_ids"] + [eos_id]
    if len(ids) > max_len:
        return None, 0
    k = 0
    while k < min(len(pids), len(ids)) and pids[k] == ids[k]:
        k += 1
    labels = [-100] * k + ids[k:]
    return (ids, labels), len(pids) - k


def batch_rows(rows: list, batch_size: int):
    """按长度排序后切批，减少 padding 浪费。"""
    order = sorted(range(len(rows)), key=lambda i: len(rows[i][0]))
    out = []
    for s in range(0, len(order), batch_size):
        out.append([rows[i] for i in order[s:s + batch_size]])
    return out


# ─────────────────────────── 主流程 ───────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="RWKV7-0.1B 通用思维链压缩器 SFT")
    ap.add_argument("--data", required=True, help="训练 jsonl（build-sft.mjs 的 train.jsonl）")
    ap.add_argument("--dev", default=None, help="验证 jsonl")
    ap.add_argument("--out", default="/kaggle/working/rwkv7-compressor")
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--max-len", type=int, default=DEFAULT_MAX_LEN)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--warmup", type=float, default=0.03)
    ap.add_argument("--dtype", default="fp16", choices=["fp16", "bf16", "fp32"])
    ap.add_argument("--seed", type=int, default=20261007)
    ap.add_argument("--grad-ckpt", action="store_true", default=True)
    ap.add_argument("--no-grad-ckpt", dest="grad_ckpt", action="store_false")
    ap.add_argument("--gpus", type=int, default=0,
                    help="用几张卡。0=自动（有几张用几张，上限 2）")
    ap.add_argument("--chunk-size", type=int, default=16,
                    help="RWKV7 chunk 模式的 chunk_size。<=0 表示不改，用 fla 默认的 64")
    ap.add_argument("--smoke", action="store_true", help="只验证环境：编码 + 前向 + 一步反传 + 一次生成")
    ap.add_argument("--smoke-steps", type=int, default=3)
    ap.add_argument("--gen-n", type=int, default=20, help="训练后在 dev 上生成多少条稿子供本地尺子打分")
    ap.add_argument("--gen-max-new", type=int, default=768)
    return ap.parse_args(argv)


def reexec_under_torchrun(nproc: int, raw_argv: list) -> int:
    """在 torchrun 下把自己重开 nproc 份，用满所有卡。

    为什么必须这么做（Kaggle 实测，不是推演）：
      Kaggle 的 T4 x2 给的是**两张独立的卡**，torch.cuda.device_count() 报 2；
      但 script kernel 只跑一个进程，model.to("cuda") 和 tensor(device="cuda")
      全都落在 cuda:0 —— 第二张卡从头到尾空转。
      配额是按 session 挂钟时间扣的，不是按 GPU 秒，所以空转一张卡等于白扔一半配额。

    torchrun --standalone 会自己挑一个空闲端口、设好 MASTER_ADDR/LOCAL_RANK，
    然后每个 rank 各自跑一遍本脚本。CFB_DDP=1 用来防止无限递归重开。
    """
    env = dict(os.environ, CFB_DDP="1")
    cmd = [sys.executable, "-m", "torch.distributed.run",
           "--nproc_per_node", str(nproc),
           "--standalone",
           "--master_port", "29517",
           os.path.abspath(__file__)] + list(raw_argv)
    print(f"· 检测到 {nproc} 张卡 —— 单进程只会用 cuda:0，用 torchrun 重开跑满：", flush=True)
    print("  " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, env=env)
    return r.returncode


def main(argv=None) -> int:
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    args = parse_args(raw_argv)

    # ---- 1. 环境：没有 CUDA 直接拒绝，不在 CPU 上假装训练 ----
    import torch
    if not torch.cuda.is_available():
        print("FATAL: 没有 CUDA。Kaggle 请把 Accelerator 设为 GPU T4 x2（P100 是 sm_60，"
              "fla 的 Triton kernel 不支持，会失败）。", file=sys.stderr)
        return 2
    ngpu = torch.cuda.device_count()
    if args.gpus <= 0:
        args.gpus = min(ngpu, 2)
    # 还没进 DDP、且要多卡 ⇒ 先重开自己。必须在建模型之前。
    if args.gpus > 1 and os.environ.get("CFB_DDP") != "1":
        return reexec_under_torchrun(args.gpus, raw_argv)

    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    world = int(os.environ.get("WORLD_SIZE", "1"))
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)
    is_main = local_rank == 0
    if world > 1:
        torch.distributed.init_process_group(backend="nccl")
        # 非 0 号 rank 的 stdout 丢进 devnull：日志只留一份，stderr 不动（报错要看得到）
        if not is_main:
            sys.stdout = open(os.devnull, "w")

    gpu = torch.cuda.get_device_name(local_rank)
    cap = torch.cuda.get_device_capability(local_rank)
    print(f"· GPU {gpu} · sm_{cap[0]}{cap[1]} · torch {torch.__version__} · "
          f"{ngpu} 卡中用了 {world} 张（rank {local_rank}）", flush=True)
    if cap[0] < 7:
        print(f"FATAL: 计算能力 sm_{cap[0]}{cap[1]} < sm_70，fla 的 Triton kernel 无法编译。"
              "换 T4。", file=sys.stderr)
        return 2

    # ---- 2. fla：Kaggle 镜像里**没有** fla，必须自己装 ----
    # 装哪个包有讲究（实测 PyPI wheel 内容，不是猜）：
    #   · fla-core 0.5.2               = fla/ops + fla/modules + fla/utils，**没有 fla/models**
    #   · flash-linear-attention 0.5.2 = fla/layers + fla/models，依赖 fla-core==0.5.2
    # 而 HF 仓库 fla-hub/rwkv7-0.1B-g1 的 modeling_rwkv7.py 只是个 157 字符的转发
    # （from fla.models.rwkv7 import RWKV7ForCausalLM, RWKV7Model, RWKV7Config），
    # 所以 trust_remote_code=True 也救不了 —— 只有 flash-linear-attention 带 fla/models。
    # 用 --no-deps + 显式列依赖，避免 pip 顺手升级 torch/transformers 把镜像搞坏。
    try:
        from fla.models.rwkv7 import RWKV7Config, RWKV7ForCausalLM  # noqa: F401
        print("· fla.models.rwkv7 镜像里已有", flush=True)
    except Exception as exc:
        print(f"· fla.models.rwkv7 缺失（{exc!r}）-> 装 flash-linear-attention==0.5.2", flush=True)
        # --progress-bar off：pip 的进度条里有 ▋ 这类字形，会让 Windows 上的
        # kaggle CLI 在按 GBK 落盘日志时崩掉（日志变成 0 字节，白跑一轮）。
        cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps",
               "--progress-bar", "off",
               "flash-linear-attention==0.5.2", "fla-core==0.5.2", "einops"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(f"· pip install -> exit {r.returncode}", flush=True)
        if r.stdout.strip():
            print(r.stdout[-1500:], flush=True)
        if r.returncode != 0:
            print("FATAL: 装 flash-linear-attention 失败：\n" + r.stderr[-3000:], file=sys.stderr)
            return 2
        try:
            from fla.models.rwkv7 import RWKV7Config, RWKV7ForCausalLM  # noqa: F401
        except Exception as exc2:
            print(f"FATAL: 装完仍导不进 fla.models.rwkv7：{exc2!r}", file=sys.stderr)
            return 2
    import transformers
    print(f"· fla ok · transformers {transformers.__version__}", flush=True)

    # ---- 2b. 把 RWKV7 的 chunk_size 从 64 压到 16（T4 上必须）----
    # fla/layers/rwkv7.py:310 在训练时写死 chunk_rwkv7(..., safe_gate=True, chunk_size=64)。
    # safe_gate=True 会让 chunk_A_bwd.py:505 选 tensorcore 版的 intra 反向 kernel，
    # 那个 kernel 里有 4 个 [BT,BT] 的 dA 矩阵，BT=64 时每个 8KB，加上 q/k/a/b/gi/ge
    # 共 6 个 [BT,BK]，合计 ~96KB。T4 每块只有 64KB shared memory ⇒
    #   triton OutOfResources: Required 98304, Hardware limit 65536
    # 而且那个 kernel 的 @triton.autotune 只扫 num_warps/num_stages，BK 是外部算好传进去的
    # 常量（chunk_A_bwd.py:490），autotune 碰不到 ⇒ 12 个配置全部超限，必然失败。
    # fla 自己在 dplr/chunk.py:156 写着 "we only support chunk_size=16 when safe_gate=True"，
    # 层里却写死 64。降到 16 是回到 fla 自己认可的配置，不是绕过。
    if args.chunk_size and args.chunk_size > 0:
        import fla.layers.rwkv7 as _fla_layer_rwkv7
        _orig_chunk_rwkv7 = _fla_layer_rwkv7.chunk_rwkv7

        def _chunk_rwkv7_small(*a, **kw):
            kw["chunk_size"] = args.chunk_size
            return _orig_chunk_rwkv7(*a, **kw)

        _fla_layer_rwkv7.chunk_rwkv7 = _chunk_rwkv7_small
        print(f"· chunk_size {args.chunk_size}"
              f"（T4 的 64KB 共享内存装不下 fla 默认的 64）", flush=True)
    else:
        print("· chunk_size 保持 fla 默认（64）—— T4 上会 OutOfResources", flush=True)

    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.manual_seed(args.seed)

    # ---- 3. 分词器 ----
    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    if tok.pad_token_id is None:
        print("FATAL: 分词器没有 pad/eos token，无法构造训练批次。", file=sys.stderr)
        return 2
    eos_id = tok.eos_token_id if tok.eos_token_id is not None else 0
    print(f"· tokenizer {type(tok).__name__} · vocab {tok.vocab_size} · "
          f"eos={tok.eos_token_id} pad={tok.pad_token_id}", flush=True)

    # ---- 4. 数据 ----
    data_path = fetch(args.data, Path("/kaggle/working/_train.jsonl"))
    rows_raw = read_jsonl(data_path)
    if not rows_raw:
        print(f"FATAL: {data_path} 是空的。", file=sys.stderr)
        return 2
    for r in rows_raw:
        for k in ("system", "user", "assistant"):
            if not str(r.get(k, "")).strip():
                print(f"FATAL: 数据行缺字段 {k}：{r.get('id')}", file=sys.stderr)
                return 2
    print(f"· 读入 {len(rows_raw)} 行", flush=True)

    t0 = time.time()
    encoded, drifts, lens = [], [], []
    for r in rows_raw:
        pair, drift = encode(tok, r, args.max_len, eos_id)
        if pair is None:
            continue
        encoded.append(pair)
        drifts.append(drift)
        lens.append(len(pair[0]))
    print(f"· 编码完成 {len(encoded)}/{len(rows_raw)} 条（{time.time()-t0:.1f}s）"
          f"· 超窗丢弃 {len(rows_raw)-len(encoded)}", flush=True)
    if not encoded:
        print(f"FATAL: 全部超窗（max_len={args.max_len}）。放宽 --max-len 或换更小的单元。",
              file=sys.stderr)
        return 2
    lens.sort()
    n = len(lens)
    print(f"· token 长度 min {lens[0]} p50 {lens[n//2]} p90 {lens[int(n*0.9)]} max {lens[-1]}"
          f" · 窗口 {args.max_len} 占用 p50 {lens[n//2]/args.max_len:.1%}", flush=True)
    nz = [d for d in drifts if d != 0]
    print(f"· 掩码边界偏差：{len(nz)}/{len(drifts)} 条非零，max {max(drifts) if drifts else 0}"
          f"（持续偏大说明模板/分词器与预期不符，是必须看见的信号）", flush=True)

    dev_encoded = []
    if args.dev:
        dev_path = fetch(args.dev, Path("/kaggle/working/_dev.jsonl"))
        for r in read_jsonl(dev_path):
            pair, _ = encode(tok, r, args.max_len, eos_id)
            if pair is not None:
                dev_encoded.append((r, pair))
        print(f"· dev {len(dev_encoded)} 条", flush=True)

    # ---- 5. 模型 ----
    # 为什么不是"把权重直接载成 fp16"（Kaggle T4 上真跑出来过，不是推演）：
    #   (a) 纯 fp16 权重 + 无 loss scaling -> 浅层梯度大量下溢成 0；AdamW 的 eps=1e-8
    #       也远小于 fp16 在 1e-2 附近的分辨率 -> 学不动。正确配方是 fp32 主权重 +
    #       autocast(fp16) + GradScaler（T4 是 sm_75，只有 fp16 有张量核）。
    #   (b) fla 0.5.2 的 l2_warp 在 fp16/bf16 logits 下 backward 必崩：
    #         fla/modules/l2warp.py:47  glogits.scatter_(-1, ids, maxx * grad_output)
    #         RuntimeError: scatter(): Expected self.dtype to be equal to src.dtype
    #       （glogits 跟着 logits 是 fp16，maxx*grad_output 是 fp32）。
    #       config.json 里根本没有 use_l2warp 这个键，dataclass 默认 True，必须显式关。
    #       复现环境：Kaggle T4 · torch 2.11.0+cu128 · transformers 5.16.1 · fla 0.5.2。
    amp_dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": None}[args.dtype]
    print(f"· 载入 {args.model}（主权重 fp32 · autocast {args.dtype}）…", flush=True)
    model = AutoModelForCausalLM.from_pretrained(args.model, trust_remote_code=True, dtype=torch.float32)
    model.config.use_l2warp = False
    # config.json 里 max_position_embeddings=2048 是配置残留（RWKV7 无位置编码，
    # fla 的代码路径从不读它），但 transformers 的 generate 会拿它当"预定义最大长度"
    # 报越界警告 —— 冒烟里 3522 token 的 prompt 就触发了。改成我们的真实窗口，
    # 既消掉噪音，也避免将来某个版本真去强制它。
    model.config.max_position_embeddings = max(args.max_len, 2048)
    model.to(device)
    if args.grad_ckpt:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False
    nparam = sum(p.numel() for p in model.parameters())
    if world > 1:
        # find_unused_parameters=True：开了 gradient checkpointing 之后，DDP 在第一次
        # 反传前推断不出完整的参数使用图，不打开会直接报 unused parameter 而崩。
        model = torch.nn.parallel.DistributedDataParallel(
            model, device_ids=[local_rank], output_device=local_rank,
            find_unused_parameters=True)
    # generate / dev 一律走未包裹的句柄：DDP 在 forward 里会 broadcast buffer，
    # 那是集合通信 —— 只有 0 号 rank 调 generate 的话，0 号会一直等 1 号，直接挂死。
    base_model = model.module if world > 1 else model
    torch.cuda.reset_peak_memory_stats()
    print(f"· 参数量 {nparam/1e6:.1f}M（全参微调 · fp32 主权重）"
          f"{f' · DDP {world} 卡' if world > 1 else ' · 单卡'}", flush=True)

    def collate(batch):
        maxlen = max(len(x[0]) for x in batch)
        ids, lab, am = [], [], []
        for i, l in batch:
            pad = maxlen - len(i)
            ids.append(i + [tok.pad_token_id] * pad)
            lab.append(l + [-100] * pad)
            am.append([1] * len(i) + [0] * pad)
        return (torch.tensor(ids, device=device), torch.tensor(lab, device=device),
                torch.tensor(am, device=device))

    batches = batch_rows(encoded, args.batch)
    if world > 1:
        # 每张卡分走一部分微批，梯度由 DDP 同步 ⇒ 等价于把有效批再放大 world 倍。
        batches = batches[local_rank::world]
        print(f"· rank {local_rank} 分到 {len(batches)} 个微批", flush=True)
    steps_per_epoch = max(1, len(batches) // args.accum)
    total_steps = max(1, int(steps_per_epoch * args.epochs))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                            lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    warm = max(1, int(total_steps * args.warmup))

    scaler = torch.amp.GradScaler("cuda", enabled=amp_dtype is not None)

    def forward_loss(ids, lab, am, scale=1.0):
        with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
            return model(input_ids=ids, attention_mask=am, labels=lab).loss * scale

    def lr_at(step):
        if step < warm:
            return args.lr * (step + 1) / warm
        prog = (step - warm) / max(1, total_steps - warm)
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * prog)))

    print(f"· 批 {args.batch} × 累积 {args.accum} = 有效批 {args.batch*args.accum}"
          f" · 每轮 {len(batches)} 微批 -> {steps_per_epoch} 步 · 共 {total_steps} 步", flush=True)

    # ---- 6. 冒烟：把"能不能跑"和"跑得好不好"分开 ----
    if args.smoke:
        print("\\n=== 冒烟模式：只验证环境，不训练 ===", flush=True)
        model.train()
        losses, times = [], []
        for step in range(args.smoke_steps):
            ids, lab, am = collate(batches[step % len(batches)])
            torch.cuda.synchronize()
            t1 = time.time()
            loss = forward_loss(ids, lab, am, 1.0 / args.accum)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            opt.zero_grad(set_to_none=True)
            torch.cuda.synchronize()
            dt = time.time() - t1
            times.append(dt)
            losses.append(float(loss.detach()) * args.accum)
            print(f"  step {step+1}/{args.smoke_steps} loss {losses[-1]:.4f} · {dt:.1f}s"
                  f" · 峰值显存 {torch.cuda.max_memory_allocated()/2**30:.2f} GiB", flush=True)
        steady = min(times)
        print(f"· 前向+反传 合计 {sum(times):.1f}s · 首步 {times[0]:.1f}s（含 Triton 首次编译）"
              f" · 最快 {steady:.1f}s/步", flush=True)
        total_micro = total_steps * args.accum
        print(f"· 外推：全量 {total_steps} 步 × 累积 {args.accum} = 每卡 {total_micro} 微批"
              f" 约 {steady*total_micro/60:.0f} 分钟（按最快一步算，首步编译不计；Kaggle 上限 12 小时）",
              flush=True)
        if not all(math.isfinite(x) for x in losses):
            print("FATAL: 损失非有限值。", file=sys.stderr)
            return 3
        # 生成一条，验证 chat_template 与 generate 通路
        if dev_encoded and is_main:
            r, _ = dev_encoded[0]
            base_model.eval()
            with torch.no_grad(), torch.autocast("cuda", dtype=amp_dtype,
                                                 enabled=amp_dtype is not None):
                prompt = render(tok, [{"role": "system", "content": r["system"]},
                                      {"role": "user", "content": r["user"]}], True)
                enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
                g = time.time()
                out = base_model.generate(**enc, max_new_tokens=min(256, args.gen_max_new),
                                     do_sample=False, pad_token_id=tok.pad_token_id,
                                     eos_token_id=eos_id)
                txt = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
            print(f"· 生成通路 ok（{time.time()-g:.1f}s / 256 token）", flush=True)
            print("  ── 未训练模型的输出（应当是一堆不通顺的话，这是对的）──")
            print("  " + txt.strip().replace("\\n", " ")[:400], flush=True)
        # rank1 会先走到这里，rank0 还在生成。加个 barrier 对齐，
        # 否则 rank1 先退出进程，rank0 收尾时 NCCL 会报通信失败。
        if world > 1:
            torch.distributed.barrier()
        print("\\n=== 冒烟通过 ===", flush=True)
        if world > 1:
            torch.distributed.destroy_process_group()
        return 0

    # ---- 7. 训练 ----
    model.train()
    step, micro, epoch = 0, 0, 0
    running, hist = 0.0, []
    t0 = time.time()
    done = False
    while not done:
        for b in batches:
            ids, lab, am = collate(b)
            loss = forward_loss(ids, lab, am, 1.0 / args.accum)
            scaler.scale(loss).backward()
            running += float(loss.detach())
            micro += 1
            if micro % args.accum == 0:
                for gp in opt.param_groups:
                    gp["lr"] = lr_at(step)
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(opt)
                scaler.update()
                opt.zero_grad(set_to_none=True)
                hist.append((step, running, lr_at(step)))
                if step % 10 == 0 or step == total_steps - 1:
                    print(f"  step {step+1}/{total_steps} loss {running:.4f} "
                          f"lr {lr_at(step):.2e} elapsed {(time.time()-t0)/60:.1f}m", flush=True)
                running = 0.0
                step += 1
                if step >= total_steps:
                    done = True
                    break
        epoch += 1
        if epoch > 100:
            break
    print(f"· 训练结束 {step} 步，{(time.time()-t0)/60:.1f} 分钟", flush=True)

    # ---- 8. dev 损失（只 0 号 rank，走未包裹句柄）----
    if dev_encoded and is_main:
        base_model.eval()
        tot, cnt = 0.0, 0
        with torch.no_grad():
            for i in range(0, len(dev_encoded), args.batch):
                chunk = [p for _, p in dev_encoded[i:i + args.batch]]
                ids, lab, am = collate(chunk)
                with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
                    tot += float(base_model(input_ids=ids, attention_mask=am, labels=lab).loss)
                cnt += 1
        print(f"· dev loss {tot/max(1,cnt):.4f}（{len(dev_encoded)} 条）", flush=True)

    # ---- 9. 生成稿子，交给本地尺子打分（不在这里自评）----
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    gen_path = out_dir / "dev-generations.jsonl"
    if dev_encoded and is_main:
        base_model.eval()
        written = 0
        with gen_path.open("w", encoding="utf-8") as f, torch.no_grad(), \
                torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
            for r, _ in dev_encoded[:args.gen_n]:
                prompt = render(tok, [{"role": "system", "content": r["system"]},
                                      {"role": "user", "content": r["user"]}], True)
                enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
                o = base_model.generate(**enc, max_new_tokens=args.gen_max_new, do_sample=False,
                                        pad_token_id=tok.pad_token_id, eos_token_id=eos_id)
                txt = tok.decode(o[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
                f.write(json.dumps({"id": r.get("id"), "raw": r.get("raw", ""),
                                    "ctx": r.get("ctx", ""), "draft": txt.strip()},
                                   ensure_ascii=False) + "\n")
                written += 1
        print(f"· 生成 {written} 条 -> {gen_path}（用 tools/gen-ruler.mjs 本地打分）", flush=True)

    # 两个 rank 同时 save_pretrained 到同一个目录会互相踩，只让 0 号写。
    if is_main:
        base_model.save_pretrained(out_dir / "model")
        tok.save_pretrained(out_dir / "model")
    report = {
        "model": args.model, "params": nparam, "maxLen": args.max_len, "dtype": args.dtype,
        "trainRows": len(rows_raw), "kept": len(encoded), "overWindow": len(rows_raw) - len(encoded),
        "devRows": len(dev_encoded), "steps": step, "epochs": args.epochs, "lr": args.lr,
        "batch": args.batch, "accum": args.accum, "gpu": gpu, "sm": f"sm_{cap[0]}{cap[1]}",
        "minutes": round((time.time() - t0) / 60, 1), "lossTail": hist[-10:],
        "maskDriftNonZero": len(nz),
    }
    # rank1 跳过了 dev 损失和生成，会先到这里 —— 对齐后再收尾，理由同上。
    if world > 1:
        torch.distributed.barrier()
    if is_main:
        (out_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"· 产出 {out_dir}", flush=True)
    if world > 1:
        torch.distributed.destroy_process_group()
    return 0


if __name__ == "__main__":
    sys.exit(main())
