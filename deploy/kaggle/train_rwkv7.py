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
6144 之后带题面能装 99.8%，装得下就没有取舍的必要。

为什么窗口写 6144 而不是 config 里的 2048
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
import datetime
import json
import math
import os
import shutil
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


def fetch(src: str, dest: Path, world: int = 1, is_main: bool = True) -> Path:
    """支持 http(s) URL 与本地路径。

    Kaggle 的 script kernel 不保证 cwd 就是代码所在目录，所以相对路径要依次试：
    当前 cwd → 本脚本所在目录。都不在就报清楚，不要静默读空文件。

    多卡时**只让 0 号下载**，其余 rank 在 barrier 上等（真机实测过的 bug）：
    两个 rank 各自 fetch 到同一个 dest，一个 open("wb") 截断、另一个正在读 ——
    rank1 读到半截文件，read_jsonl 返回 0 行，报 "FATAL: _train.jsonl 是空的"
    然后整轮 torchrun 被 SIGTERM 掉。冒烟 v5 只有 48 行没撞上，真数据集 3.2MB 必撞。
    下载还改成先写 .part 再原子 replace，即使将来有别的读者也不会看到半截文件。
    """
    if src.startswith(("http://", "https://")):
        import urllib.request
        import torch
        dest.parent.mkdir(parents=True, exist_ok=True)
        if world > 1 and not is_main:
            torch.distributed.barrier()   # 等 0 号下完
            return dest
        last = None
        # 真实训练集有近 10MB，raw.githubusercontent 这条链路会偶发重置；
        # 一次就放弃等于白烧一整轮 kernel（含排队 + 装 fla + 载模型）。
        for i in range(4):
            try:
                req = urllib.request.Request(src, headers={"User-Agent": "cfb-rwkv7-trainer"})
                tmp = dest.with_name(dest.name + ".part")
                with urllib.request.urlopen(req, timeout=180) as r, tmp.open("wb") as w:
                    w.write(r.read())
                tmp.replace(dest)
                print(f"· 下载 {src} -> {dest} ({dest.stat().st_size} bytes)", flush=True)
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
                if i < 3:
                    print(f"· 下载失败（{exc!r}），{2 ** i}s 后重试 {i + 2}/4", flush=True)
                    time.sleep(2 ** i)
        else:
            raise SystemExit(f"FATAL: 下载失败 4 次：{src}\n  最后错误：{last!r}")
        if world > 1:
            torch.distributed.barrier()   # 通知其余 rank 可以读了
        return dest
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


def fix_tied_weight_keys(model):
    """把 `_tied_weights_keys` 从 fla 的 list 归一成 transformers 5.x 要的 dict。

    transformers>=5 的 `_get_tied_weight_keys()` 会对每个子模块取
    `_tied_weights_keys` 然后调 `.keys()`（5.x 里它的类型是 dict[str, str]），
    而 fla 0.5.2 全线给的是 list（`_tied_weights_keys = ["lm_head.weight"]`）。
    于是 `save_pretrained` -> `remove_tied_weights_from_state_dict` ->
    `AttributeError: 'list' object has no attribute 'keys'`，**训练完好的一轮全丢**。
    （v8 就是这么没的：训练 10.6 分钟跑完，存档那一步炸了。）

    `from_pretrained` 之所以没事：5.x 的 `get_expanded_tied_weights_keys()` 在
    `if not tie_word_embeddings: return {}` 处提前返回，根本没走到 `.keys()`；
    而 `_get_tied_weight_keys()` 没有这道闸，所以只有存档会炸。

    为什么不无脑填 `{}`：万一 lm_head 与输入嵌入真的共享存储，声明"没有共享"
    只是把同一块写两遍（冗余，不致命）；反过来，把**不**共享的两块谎报成共享，
    save 会删掉 lm_head.weight，重新加载后 LM 头变随机数，而且全程不报错。
    所以先实测是否共享，再决定映射。
    """
    tied = {}
    shared = None
    try:
        out_w = model.get_output_embeddings().weight
        in_w = model.get_input_embeddings().weight
        shared = out_w.data_ptr() == in_w.data_ptr()
        if shared:
            tied = {"lm_head.weight": "model.embeddings.weight"}
    except Exception as e:  # 探测失败不该挡住存档
        print(f"! 共享存储探测失败（按不共享处理）：{type(e).__name__}: {e}", flush=True)
    n = 0
    for _, sub in model.named_modules():
        if isinstance(getattr(sub, "_tied_weights_keys", None), (list, tuple)):
            sub._tied_weights_keys = dict(tied)
            n += 1
    return n, shared


def verify_saved_weights(model, md: Path) -> str:
    """把刚写出去的权重读回来跟内存里的逐块对齐，返回一行摘要。

    `save_pretrained` 有太多"悄悄少写一块"的路径（tied 判定、dtype 转换、分片），
    只看它没抛异常是不够的 —— 少一块 lm_head 它也不抛。
    """
    from safetensors.torch import load_file
    live = model.state_dict()
    got = {}
    for f in sorted(md.glob("*.safetensors")):
        got.update(load_file(str(f)))
    if not got:
        raise RuntimeError(f"{md} 里没有任何 *.safetensors")
    missing = sorted(set(live) - set(got))
    extra = sorted(set(got) - set(live))
    shape_bad = sorted(k for k in got if k in live and tuple(got[k].shape) != tuple(live[k].shape))
    if missing or extra or shape_bad:
        raise RuntimeError(
            f"权重不齐：缺 {len(missing)} {missing[:4]} / 多 {len(extra)} {extra[:4]} / "
            f"形状不符 {len(shape_bad)} {shape_bad[:4]}")
    worst, worst_k, dt = 0.0, None, []
    for k, v in got.items():
        if v.dtype != live[k].dtype:
            dt.append(f"{k}:{live[k].dtype}->{v.dtype}")
        d = float((v.float() - live[k].detach().float().cpu()).abs().max())
        if d > worst:
            worst, worst_k = d, k
    note = f" · {len(dt)} 块 dtype 变了 {dt[:2]}" if dt else ""
    if worst > 1e-3:
        raise RuntimeError(f"写出去后对不上：max|Δ|={worst:.3e} @ {worst_k}{note}")
    return f"{len(got)} 块 · max|Δ|={worst:.2e} @ {worst_k}{note}"


def fixup_tokenizer_dir(md: Path, tok) -> str:
    """把词表补成 `vocab_files_names` 声明的那个文件名。

    fla-hub 的 `RwkvTokenizer.save_vocabulary()` 把词表**硬编码**写成 `vocab.txt`，
    可它自己声明的 `VOCAB_FILES_NAMES = {"vocab_file": "rwkv_vocab_v20230424.txt"}`；
    而 `PreTrainedTokenizer.save_pretrained()` 又会把 `vocab_file` 这个键从
    tokenizer_config.json 里 pop 掉（tokenization_utils_base.py:2067-2068 —— 它属于
    "按约定解析"的文件名，不该写进配置）。
    两边对不上：存出来的目录 `AutoTokenizer.from_pretrained(dir)` 会去找
    `rwkv_vocab_v20230424.txt`，而目录里只有 `vocab.txt`，**而且这一步不报错**，
    只在真正加载时才炸。所以这里按它声明的名字把原始词表补一份。
    """
    vfn = getattr(type(tok), "vocab_files_names", None) or {}
    name = vfn.get("vocab_file")
    if not name:
        return "词表未补（拿不到 vocab_files_names）"
    cands = []
    ik = getattr(tok, "init_kwargs", None) or {}
    if ik.get("vocab_file"):
        cands.append(Path(ik["vocab_file"]))
    hub = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))) / "hub"
    if hub.is_dir():  # 兜底：直接去 HF 缓存里翻
        cands += sorted(hub.glob(f"**/{name}"))
    srcp = next((c for c in cands if c.is_file()), None)
    if srcp is None:
        return f"词表未补（找不到源，试过 {[str(c) for c in cands[:3]]}）"
    dst = md / name
    shutil.copyfile(srcp, dst)
    return f"词表 {dst.name} <- {srcp}（{dst.stat().st_size} B）"


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
    ap.add_argument("--gen-budget", type=float, default=0,
                    help="生成阶段的时间预算（秒），0=不限。缓存不生效时防止生成阶段拖垮整轮")
    ap.add_argument("--ckpt-steps", default="",
                    help="学习曲线快照的步数，逗号分隔（如 40,120）。到点就 dev loss + 生成一次，然后接着训。空=不快照")
    ap.add_argument("--ckpt-gen-n", type=int, default=0,
                    help="快照点生成多少条（0=用 --gen-n）。曲线上的点要同 n 才能相比")
    ap.add_argument("--no-gen-cache", dest="gen_cache", action="store_false", default=True,
                    help="生成时不用状态缓存（慢一个数量级，只在缓存自检失败时才有意义）")
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
        # 超时必须显式给。默认 30 分钟，而生成阶段只让 0 号跑，其余 rank 全挂在
        # 第 840 行那个 barrier 上等 —— 生成一超 30 分钟，rank1 先超时死，整轮在
        # 最后一步翻车（产物还在，但 report.json 写不下去）。
        torch.distributed.init_process_group(
            backend="nccl", timeout=datetime.timedelta(hours=3))
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
    def _fla_ready() -> bool:
        try:
            from fla.models.rwkv7 import RWKV7Config, RWKV7ForCausalLM  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False

    if _fla_ready():
        print("· fla.models.rwkv7 镜像里已有", flush=True)
    else:
        # 多卡时**只让 0 号装**。两个 rank 同时往同一个 site-packages 里 pip install
        # 是在赌 pip 的原子性：赢了没奖，输了整轮白跑（排队 + 下载 + 编译全废）。
        # 共享文件系统 ⇒ 两边 _fla_ready() 结果必然一致 ⇒ 分支对称，barrier 不会错配。
        if world > 1 and not is_main:
            torch.distributed.barrier()   # 等 0 号装完
        else:
            print("· fla.models.rwkv7 缺失 -> 装 flash-linear-attention==0.5.2", flush=True)
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
                print("FATAL: 装 flash-linear-attention 失败：\n" + r.stderr[-3000:],
                      file=sys.stderr)
                # 失败也要走到 barrier：否则非 0 号会一直挂在上面，直到 torchrun 超时。
                if world > 1:
                    torch.distributed.barrier()
                return 2
            if world > 1:
                torch.distributed.barrier()   # 通知其余 rank 可以导入了
        if not _fla_ready():
            print("FATAL: 装完仍导不进 fla.models.rwkv7", file=sys.stderr)
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
    data_path = fetch(args.data, Path("/kaggle/working/_train.jsonl"), world, is_main)
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
        dev_path = fetch(args.dev, Path("/kaggle/working/_dev.jsonl"), world, is_main)
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
    # ⚠ DDP 下每张卡必须走**同样多**的步数，否则先跑完的那张卡会在下一次集合通信上
    #   永久等待 —— 表现为整轮静默挂死：日志停在最后一个 step，没有报错、没有 OOM、没有超时。
    #   412 条 / 批 4 = 103 个微批，2 卡切片后是 52 和 51，各自 //4 得 13 和 12 步：**步数不等**。
    #   v9 的 256 条恰好是 32/32，把这个问题盖住了 —— 数据一变就会发作。
    #   所以先按 accum*world 把全局微批裁到整除，再切分，两边步数必然相同。
    per_step = args.accum * world
    n_micro = (len(batches) // per_step) * per_step
    dropped = len(batches) - n_micro
    if dropped:
        print(f"· 全局 {len(batches)} 个微批，为对齐 DDP 步数裁掉尾部 {dropped} 个"
              f"（每轮少 {dropped * args.batch} 条，约 {dropped * args.batch / max(1, len(encoded)):.1%}）", flush=True)
    batches = batches[:n_micro]
    if world > 1:
        # 每张卡分走一部分微批，梯度由 DDP 同步 ⇒ 等价于把有效批再放大 world 倍。
        batches = batches[local_rank::world]
        print(f"· rank {local_rank} 分到 {len(batches)} 个微批", flush=True)
    steps_per_epoch = max(1, n_micro // per_step)
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

    # ---- 5b. 把 dev loss 与生成抽成函数 ----
    # 为什么必须抽出来：学习曲线要在每个快照点跑**同一段**代码。
    # 各写一份的后果不是报错，是"曲线上的点和终点用了不同的判据"，而那种差异
    # 在图上看起来就像"训练中途变差了"。同源测量是这套东西的底线。
    def dev_loss():
        if not (dev_encoded and is_main):
            return None
        base_model.eval()
        tot, cnt = 0.0, 0
        with torch.no_grad():
            for i in range(0, len(dev_encoded), args.batch):
                chunk = [p for _, p in dev_encoded[i:i + args.batch]]
                ids, lab, am = collate(chunk)
                with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
                    tot += float(base_model(input_ids=ids, attention_mask=am, labels=lab).loss)
                cnt += 1
        return tot / max(1, cnt)

    def gen_once(row, max_new, cache):
        prompt = render(tok, [{"role": "system", "content": row["system"]},
                              {"role": "user", "content": row["user"]}], True)
        enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(device)
        t = time.time()
        with torch.no_grad(), torch.autocast("cuda", dtype=amp_dtype,
                                             enabled=amp_dtype is not None):
            o = base_model.generate(**enc, max_new_tokens=max_new, do_sample=False,
                                    use_cache=cache, pad_token_id=tok.pad_token_id,
                                    eos_token_id=eos_id)
        return (tok.decode(o[0][enc["input_ids"].shape[1]:], skip_special_tokens=True),
                time.time() - t)

    def generate(n, path):
        """生成 n 条稿子。**必须能被重复调用** —— 学习曲线每个点都调一次。"""
        if not (dev_encoded and is_main and n > 0):
            return 0
        base_model.eval()
        written, t_gen = 0, time.time()
        with path.open("w", encoding="utf-8") as f:
            for r, _ in dev_encoded[:n]:
                if args.gen_budget and time.time() - t_gen > args.gen_budget:
                    print(f"  · 生成到时间预算 {args.gen_budget:.0f}s，余 "
                          f"{n - written} 条不生成（样本变少，尺子上的置信区间会变宽）", flush=True)
                    break
                try:
                    txt, dt = gen_once(r, args.gen_max_new, args.gen_cache)
                except Exception as exc:  # noqa: BLE001
                    if not args.gen_cache:
                        raise
                    print(f"  · 缓存生成失败（{exc!r}）-> 回退到不开缓存", flush=True)
                    args.gen_cache = False
                    txt, dt = gen_once(r, args.gen_max_new, False)
                f.write(json.dumps({"id": r.get("id"), "raw": r.get("raw", ""),
                                    "ctx": r.get("ctx", ""), "draft": txt.strip()},
                                   ensure_ascii=False) + "\n")
                f.flush()
                written += 1
                print(f"  gen {written}/{n} · {len(txt)} 字 · {dt:.1f}s", flush=True)
        print(f"  · 生成 {written} 条 -> {path.name}（{time.time() - t_gen:.0f}s）", flush=True)
        return written

    # 缓存自检：只在**真要生成**的时候跑。
    # v9 的实测结论是反的：开缓存 31.0s / 不开 6.7s，**开缓存慢 4.6 倍**，
    # 而输出逐字一致。当时的代码只在"输出不一致"时才关缓存，从不在"变慢"时关 ——
    # 于是 v9 全程跑的是慢路径，生成阶段 34,687 token / 1164s = 29.8 token/s。
    # 所以这里加上"变慢就关"。两条判据都不能省：一条保正确性，一条保速度。
    if args.gen_n > 0 and dev_encoded and is_main and args.gen_cache:
        try:
            # ⚠ 必须**先热一次**再计时。v9 的自检拿到的是
            #   不开 6.7s / 开 31.0s，看起来“开缓存慢 4.6 倍”，
            #   但同一轮全量生成实测只有 29.8 token/s —— 比那个自检快 3 倍。
            #   两个数字打架，说明 6.7s 里大头是 **Triton 首次编译**，不是吞吐。
            #   拿没热过的数字去比快慢，得到的是编译时间的差，不是吞吐的差。
            gen_once(dev_encoded[0][0], 16, False)
            gen_once(dev_encoded[0][0], 16, True)
            a, ta = gen_once(dev_encoded[0][0], 64, False)
            b, tb = gen_once(dev_encoded[0][0], 64, True)
            same = a == b
            print(f"· 缓存自检 64 token：不开 {ta:.1f}s / 开 {tb:.1f}s"
                  f"（开/不开 = {tb / max(ta, 1e-6):.2f}x，热机后）· 输出{'逐字一致' if same else '不一致'}",
                  flush=True)
            if not same:
                print("  警告：开缓存后输出变了 -> 回退到不开缓存（慢，但不冒正确性的险）",
                      flush=True)
                args.gen_cache = False
            elif tb > ta * 1.2:
                # 20% 宽容：这两次采样本身就有抖动，卡在 1.0 会把噪声当信号。
                print("  开缓存确实更慢（热机后对比）-> 关掉", flush=True)
                args.gen_cache = False
        except Exception as exc:  # noqa: BLE001
            print(f"· 缓存自检就崩了（{exc!r}）-> 全程不开缓存", flush=True)
            args.gen_cache = False
        finally:
            torch.cuda.empty_cache()

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

    # ---- 7c. 学习曲线点 ----
    #
    # 为什么要有这个：上一轮只有**一个终点**（步数 40），于是“欠训”和“目标函数不对”
    # 这两个完全不同的诊断在数据上**不可分离**。一条曲线就能分开：
    #   曲线还在上升  => 欠训，加步数/加数据有用；
    #   曲线平了    => 不是欠训，问题在目标函数（交叉熵表达不了“这一个 token 是致命的”）。
    # 曲线上每个点都要同 n 才能相比 —— n 不同的两点没有可比性，这一点必须写死在这里。
    ckpt_set = set()
    if args.ckpt_steps:
        try:
            ckpt_set = {int(x) for x in str(args.ckpt_steps).replace("，", ",").split(",") if x.strip()}
        except ValueError:
            print(f"FATAL: --ckpt-steps 解析不了：{args.ckpt_steps!r}", file=sys.stderr)
            return 2
        ckpt_set = {x for x in ckpt_set if 0 < x < total_steps}
        print(f"· 学习曲线快照步数：{sorted(ckpt_set)}（共 {total_steps} 步）", flush=True)
    curve = []
    ckpt_gen_n = args.ckpt_gen_n or args.gen_n
    # out_dir 必须在循环**之前**就存在 —— 曲线点要往里写文件。
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    def curve_point(at_step):
        """在一个步数上采一个点。**两个 rank 都必须调用** —— 里面有 barrier。"""
        was_training = model.training
        dl = dev_loss()
        # 生成期间必须关梯度检查点：transformers 会因为它与 use_cache 不兼容而把状态缓存一并关掉，
        # 于是每吐一个 token 都重算整段 prompt（O(n^2)）。这不是推演，是冒烟 v5 实测：256 token 37.5s。
        if args.grad_ckpt:
            base_model.gradient_checkpointing_disable()
        try:
            n = generate(ckpt_gen_n, out_dir / f"dev-generations-step{at_step}.jsonl")
        finally:
            if args.grad_ckpt:
                base_model.gradient_checkpointing_enable()
        if is_main:
            rec = {"step": at_step, "devLoss": None if dl is None else round(dl, 4),
                   "genRows": n, "genFile": f"dev-generations-step{at_step}.jsonl",
                   "minutes": round((time.time() - t0) / 60, 1)}
            curve.append(rec)
            print(f"· 【学习曲线】step {at_step} · dev loss "
                  f"{rec['devLoss']} · 生成 {n} 条 · 已用 {rec['minutes']}m", flush=True)
            (out_dir / "learning-curve.json").write_text(
                json.dumps(curve, ensure_ascii=False, indent=2), encoding="utf-8")
        # 回到训练模式。不恢复的话后面的 step 全在 eval 模式下跑 ——
        # 不会报错，只是 BatchNorm/Dropout 行为变了，而 RWKV7 里 dropout 确实存在。
        if was_training:
            model.train()
        if world > 1:
            torch.distributed.barrier()

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
                # 快照点插在**参数已更新之后、下一步之前**，否则读到的是上一步的权重。
                # 这种偏一步的错不会报错，只会让曲线整体左移。
                if step in ckpt_set:
                    curve_point(step)
                if step >= total_steps:
                    done = True
                    break
        epoch += 1
        if epoch > 100:
            break
    print(f"· 训练结束 {step} 步，{(time.time()-t0)/60:.1f} 分钟", flush=True)

    # ---- 7b. 先存档，再做 dev / 生成 ----
    # 顺序是有意的：生成阶段要跑十几分钟，中途任何异常（OOM、缓存不兼容、
    # 下载被打断）都会让一整轮训练白跑。先把权重落盘，后面崩了模型也还在。
    # 两个 rank 同时 save_pretrained 到同一目录会互相踩，只让 0 号写。
    #
    # 但存档**绝不能反过来杀掉评测**。v8 的教训：save_pretrained 抛了
    # AttributeError（fla 的 _tied_weights_keys 是 list，transformers 5.x 要 dict），
    # 异常一路穿出 main()，把已经跑完的 10.6 分钟训练和还没跑的 dev/生成一起带走。
    # 所以：先修根因，再整块兜住，最后还有一条 torch.save 的兜底。
    # out_dir 已在 7c 里建好（曲线点要用）。
    if world > 1:
        torch.distributed.barrier()
    if is_main:
        md = out_dir / "model"
        md.mkdir(parents=True, exist_ok=True)
        n_fix, tied_shared = fix_tied_weight_keys(base_model)
        print(f"· _tied_weights_keys 归一 {n_fix} 个模块 · "
              f"lm_head 与输入嵌入共享存储={tied_shared}", flush=True)
        ok = False
        try:
            base_model.save_pretrained(md)
            tok.save_pretrained(md)
            print(f"· {fixup_tokenizer_dir(md, tok)}", flush=True)
            print(f"· 存档校验 {verify_saved_weights(base_model, md)}", flush=True)
            print(f"· 已存档 {md}", flush=True)
            ok = True
        except Exception as e:
            print(f"! save_pretrained 失败：{type(e).__name__}: {e}", flush=True)
        if not ok:
            # 兜底：至少把原始权重留下来，别让一整轮训练白跑。
            try:
                raw = out_dir / "model_raw_state_dict.pt"
                torch.save(base_model.state_dict(), raw)
                base_model.config.save_pretrained(md)
                tok.save_pretrained(md)
                fixup_tokenizer_dir(md, tok)
                print(f"· 兜底存档 {raw}（标准布局没写成，推理端要改读法）", flush=True)
            except Exception as e:
                print(f"! 兜底存档也失败：{type(e).__name__}: {e}", flush=True)

    # 关掉梯度检查点。它在 eval 下本来就不生效，但 transformers 会因为
    # "gradient checkpointing 与 use_cache 不兼容" 把生成的状态缓存一并关掉 ——
    # 于是每吐一个 token 都要把整段 prompt 重算一遍（O(n^2)）。
    # 冒烟 v5 里 256 token 花了 37.5s（约 6.8 token/s）就是这么来的。
    if args.grad_ckpt:
        base_model.gradient_checkpointing_disable()

    # ---- 8. dev 损失（只 0 号 rank，走未包裹句柄）----
    dl_final = dev_loss()
    if dl_final is not None:
        print(f"· dev loss {dl_final:.4f}（{len(dev_encoded)} 条）", flush=True)

    # ---- 9. 生成稿子，交给本地尺子打分（不在这里自评）----
    # 路径与学习曲线终点一致，不另起一个名字 —— 名字不一致的后果是本地脚本拿不到文件，
    # 而拿不到文件不会报错，只会静默地去评一个不存在的东西。
    gen_path = out_dir / "dev-generations.jsonl"
    gen_rows = generate(args.gen_n, gen_path)
    if gen_rows:
        print(f"· 生成 {gen_rows} 条 -> {gen_path}（用 tools/eval-sft.mjs 本地打分）", flush=True)

    report = {
        "model": args.model, "params": nparam, "maxLen": args.max_len, "dtype": args.dtype,
        "trainRows": len(rows_raw), "kept": len(encoded), "overWindow": len(rows_raw) - len(encoded),
        "devRows": len(dev_encoded), "steps": step, "epochs": args.epochs, "lr": args.lr,
        "batch": args.batch, "accum": args.accum, "gpu": gpu, "sm": f"sm_{cap[0]}{cap[1]}",
        "minutes": round((time.time() - t0) / 60, 1), "lossTail": hist[-10:],
        "maskDriftNonZero": len(nz),
        "genRows": gen_rows, "genCache": bool(args.gen_cache), "genBudget": args.gen_budget,
        "devLossFinal": None if dl_final is None else round(dl_final, 4),
        "curve": curve, "ckptSteps": sorted(ckpt_set), "ckptGenN": ckpt_gen_n,
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
