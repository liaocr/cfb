#!/usr/bin/env python3
"""从零训练「任务专用微模型」—— 手写小 GPT，不依赖任何预训练权重。

用法（单卡）/（双卡 torchrun 由 deploy 脚本自动选择）：
  python3 micro-tokenizer.py --train <train.jsonl.gz> --vocab-size 16384 --out <dir>/tokenizer.json
  python3 train-micro-gen.py --corpus <v3 目录> --out <dir> --steps 1200

设计要点（为什么这样）：
  * 词表 16,384 由本语料现训（ByteLevel BPE），无多语言冗余；嵌入只占模型极小部分。
  * 全部算力都花在「任务形状」上：文本格式只有 <|sys|>/<|user|>/<|asst|>/<|end|> 四个特殊 token。
  * 自回归 LM，整段（prompt+answer）参与 loss；任务窄，无需复杂掩码。
  * fp16+GradScaler（T4 无 bf16）；CPU 用 float32 便于本地冒烟。
"""
from __future__ import annotations

import argparse, gzip, json, math, os, sys, time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
import importlib.util


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FMT = _load("micro_format", HERE / "micro-format.py")


# ---------------------------------------------------------------- 模型
class RMSNorm(nn.Module):
    def __init__(self, d, eps=1e-5):
        super().__init__()
        self.w = nn.Parameter(torch.ones(d))
        self.eps = eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.w


class Block(nn.Module):
    def __init__(self, d, n_head, ffn_mult=4):
        super().__init__()
        self.ln1, self.ln2 = RMSNorm(d), RMSNorm(d)
        self.attn = nn.MultiheadAttention(d, n_head, batch_first=True)  # 自带 qkv/out 投影
        self.ff = nn.Sequential(nn.Linear(d, ffn_mult * d), nn.GELU(), nn.Linear(ffn_mult * d, d))

    def forward(self, x, attn_mask=None):
        h = self.ln1(x)
        a, _ = self.attn(h, h, h, attn_mask=attn_mask, need_weights=False)
        x = x + a
        return x + self.ff(self.ln2(x))


class MicroGPT(nn.Module):
    def __init__(self, vocab, d=384, layers=6, heads=6, ctx=2048, ffn_mult=4):
        super().__init__()
        self.cfg = dict(vocab=vocab, d_model=d, layers=layers, heads=heads, ctx=ctx, ffn_mult=ffn_mult)
        self.tok_emb = nn.Embedding(vocab, d)
        self.blocks = nn.ModuleList(Block(d, heads, ffn_mult) for _ in range(layers))
        self.ln_f = RMSNorm(d)
        self.head = nn.Linear(d, vocab, bias=False)
        self.head.weight = self.tok_emb.weight  # 权重共享：词表再大也不多占参数
        self.apply(self._init)
        for name, p in self.named_parameters():  # 残差投影缩放，防残差流随深度爆炸
            if name.endswith("out_proj.weight") or name.endswith("ff.2.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * layers))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        x = self.tok_emb(idx)
        # 因果掩码（PyTorch 约定：True = 屏蔽）
        mask = torch.triu(torch.ones(T, T, device=idx.device, dtype=torch.bool), diagonal=1)
        for blk in self.blocks:
            x = blk(x, attn_mask=mask)
        logits = self.head(self.ln_f(x))
        if targets is None:
            return logits
        return logits, F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1), ignore_index=-100)


# ---------------------------------------------------------------- 数据
def load_rows(path: Path):
    with gzip.open(path, "rt") as f:
        return [json.loads(l) for l in f if l.strip()]


def encode_pack(tok, rows, ctx: int, eos_id: int, max_docs: int | None = None):
    """把全部样本编码成一条 token 流，再切成 ctx 长的块（预训练式打包，无 padding 浪费）。"""
    ids: list[int] = []
    for i, r in enumerate(rows):
        if max_docs and i >= max_docs:
            break
        _, full = FMT.row_to_texts(r)
        ids.extend(tok.encode(full).ids)
        ids.append(eos_id)
    n = (len(ids) - 1) // ctx
    chunks = [ids[i * ctx : (i + 1) * ctx] for i in range(max(0, n))]
    return chunks


# ---------------------------------------------------------------- 训练
@torch.no_grad()
def greedy_gen(model, tok, prompt: str, max_new=1024, ctx=2048, device="cpu"):
    ids = tok.encode(prompt).ids[-(ctx - max_new - 1):]
    x = torch.tensor([ids], device=device)
    end_id = tok.token_to_id(FMT.END)
    out = []
    for _ in range(max_new):
        with torch.autocast("cuda", dtype=torch.float16, enabled=device.startswith("cuda")):
            logits = model(x[:, -ctx:])
        nxt = int(logits[0, -1].argmax())
        if nxt == end_id:
            break
        out.append(nxt)
        x = torch.cat([x, torch.tensor([[nxt]], device=device)], dim=1)
    return tok.decode(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="含 train.jsonl.gz / dev.jsonl.gz 的目录")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vocab-size", type=int, default=16384)
    ap.add_argument("--tokenizer", default=None, help="已有 tokenizer.json；缺省时自动训练")
    ap.add_argument("--ctx", type=int, default=2048)
    ap.add_argument("--d-model", type=int, default=384)
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--warmup", type=int, default=50)
    ap.add_argument("--steps", type=int, default=1200)
    ap.add_argument("--time-budget-sec", type=float, default=0.0, help=">0 时按墙钟时间提前收工（Kaggle 限时用）")
    ap.add_argument("--limit-docs", type=int, default=0, help="调试：只用前 N 条训练样本")
    ap.add_argument("--eval-limit", type=int, default=0, help="调试：只用前 N 条 dev 样本")
    ap.add_argument("--eval-max-new", type=int, default=1024, help="评测时最长新生成 token 数")
    ap.add_argument("--log-every", type=int, default=10)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    if args.threads:
        torch.set_num_threads(args.threads)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    corpus = Path(args.corpus)

    # --- 分布式（torchrun 自动注入；单进程则为普通训练）
    rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    has_cuda = torch.cuda.is_available()
    if world > 1:
        torch.distributed.init_process_group("nccl" if has_cuda else "gloo")
        if has_cuda:
            torch.cuda.set_device(local_rank)
    device = f"cuda:{local_rank}" if has_cuda else "cpu"
    is_main = rank == 0

    from tokenizers import Tokenizer  # 延迟导入，缺库时给清晰报错

    tok_path = Path(args.tokenizer) if args.tokenizer else out / "tokenizer.json"
    if not tok_path.exists():
        raise SystemExit(f"缺词表 {tok_path}；先跑 micro-tokenizer.py（train-micro-gen.py 不会隐式重训）")
    tok = Tokenizer.from_file(str(tok_path))
    assert tok.get_vocab_size() <= args.vocab_size, f"词表 {tok.get_vocab_size()} > --vocab-size {args.vocab_size}"
    eos_id = tok.token_to_id(FMT.END)

    train_rows = load_rows(corpus / "train.jsonl.gz")
    dev_rows = load_rows(corpus / "dev.jsonl.gz") if (corpus / "dev.jsonl.gz").exists() else []
    if args.limit_docs:
        train_rows = train_rows[: args.limit_docs]
    if args.eval_limit:
        dev_rows = dev_rows[: args.eval_limit]

    chunks = encode_pack(tok, train_rows, args.ctx, eos_id, args.limit_docs or None)
    if is_main:
        n_tok = sum(len(c) for c in chunks)
        print(f"[data] train={len(train_rows)} 条 / {n_tok/1e6:.2f}M tokens / {len(chunks)} 块(ctx={args.ctx})", flush=True)

    model = MicroGPT(args.vocab_size, args.d_model, args.layers, args.heads, args.ctx).to(device)
    if is_main:
        n_par = sum(p.numel() for p in model.parameters())
        emb = model.tok_emb.weight.numel()
        print(f"[model] {n_par/1e6:.2f}M 参数（嵌入 {emb/1e6:.2f}M = {100*emb/n_par:.1f}%，与输出层共享）", flush=True)
        (out / "model-config.json").write_text(json.dumps(model.cfg, indent=2))

    if world > 1:
        model = nn.parallel.DistributedDataParallel(
            model, device_ids=[local_rank] if has_cuda else None)
        chunks_per_rank = chunks[rank::world]  # 极简分片：交错切片，各 rank 数据量一致
    else:
        chunks_per_rank = chunks
    base = model.module if world > 1 else model  # 未包装引用（cfg/存档/评测用）

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.1, betas=(0.9, 0.95))
    use_amp = device.startswith("cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    t0, step, t_start = 0, 0, time.time()
    last_eval = None

    def lr_at(s):  # 线性 warmup + 余弦
        if s < args.warmup:
            return args.lr * (s + 1) / max(1, args.warmup)
        p = min(1.0, (s - args.warmup) / max(1, args.steps - args.warmup))
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))

    model.train()
    order = list(range(len(chunks_per_rank)))
    while step < args.steps:
        if not order:
            order = torch.randperm(len(chunks_per_rank)).tolist()  # 每轮洗牌
        idxs = order[: args.batch]
        order = order[args.batch :]
        x = torch.tensor([chunks_per_rank[i][:-1] for i in idxs], device=device)
        y = torch.tensor([chunks_per_rank[i][1:] for i in idxs], device=device)
        for g in opt.param_groups:
            g["lr"] = lr_at(step)
        with torch.autocast("cuda", dtype=torch.float16, enabled=use_amp):
            _, loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt); scaler.update()
        if is_main and step % args.log_every == 0:
            print(f"[train] step {step}/{args.steps} loss {loss.item():.4f} lr {lr_at(step):.2e} "
                  f"({time.time()-t_start:.0f}s)", flush=True)
        step += 1
        if args.time_budget_sec and time.time() - t_start > args.time_budget_sec:
            if is_main:
                print(f"[train] 到时间预算 {args.time_budget_sec:.0f}s，提前停在 step {step}", flush=True)
            break

    # --- 保存（rank0；先 barrier 防别的 rank 已退出）
    if world > 1:
        torch.distributed.barrier()
    sd = base.state_dict()
    ckpt_meta = dict(step=step, wall_sec=round(time.time() - t_start, 1), cfg=base.cfg,
                     args=vars(args), corpus=str(corpus),
                     train_sha256=_sha256(corpus / "train.jsonl.gz"))
    if is_main:
        torch.save({"model": sd, "meta": ckpt_meta}, out / "micro-gen.pt")
        print(f"[save] {out/'micro-gen.pt'} ({time.time()-t_start:.0f}s 总耗时)", flush=True)

    # --- dev 评测（贪心解码；只看前 --eval-limit 条；仅主 rank，其余 rank 在 barrier 等待）
    if is_main and dev_rows:
        ev = evaluate(model, tok, dev_rows, device, ctx=args.ctx, limit=args.eval_limit,
                      max_new=args.eval_max_new)
        if is_main:
            (out / "dev-metrics.json").write_text(json.dumps(ev, indent=2, ensure_ascii=False))
            print("[eval] " + json.dumps({k: v for k, v in ev.items() if k != "per_sample"},
                                        ensure_ascii=False), flush=True)
    if world > 1:
        torch.distributed.barrier()
        torch.distributed.destroy_process_group()


def _sha256(p: Path):
    import hashlib
    if not p.exists():
        return None
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- 评测
IDENT_RE = None


def _id_re():
    global IDENT_RE
    if IDENT_RE is None:
        import re
        IDENT_RE = re.compile(
            r"[A-Za-z_][A-Za-z0-9_./-]{2,}|[`\"'][^`\"']+[`\"']|\b\d+(?:\.\d+)?\b|[\u4e00-\u9fff]{2,}")
    return IDENT_RE


def anchor_recall(gold: str, pred: str):
    rx = _id_re()
    g = [s.lower() for s in rx.findall(gold)]
    p = " ".join(s.lower() for s in rx.findall(pred))
    if not g:
        return 1.0, 1.0, 0
    hit = sum(1 for s in g if s in p)
    invented = sum(1 for s in rx.findall(pred) if s.lower() not in gold.lower())
    return hit / len(g), invented, len(g)


def evaluate(model, tok, dev_rows, device, ctx=2048, limit=0, max_new=1536):
    """内部代理指标：锚点召回（正则代理）、压缩比、精确匹配。真验收仍是 7 轴判定，不在本地冒充。"""
    gen = model.module if hasattr(model, "module") else model
    gen.eval()
    rows = dev_rows[:limit] if limit else dev_rows
    n_em = 0; tot_g = tot_p = 0; recalls = []; invented = 0
    per = []
    for r in rows:
        prompt, full = FMT.row_to_texts(r)
        pred = greedy_gen(gen, tok, prompt, max_new=max_new, ctx=ctx, device=device)
        gold = FMT.assistant_text(r)
        rec, inv, na = anchor_recall(gold, pred)
        recalls.append(rec); invented += inv
        tot_g += len(gold); tot_p += len(pred)
        em = pred.strip() == gold.strip()
        n_em += em
        per.append(dict(recall=round(rec, 4), invented=inv, n_anchors=na, em=em,
                        gold_len=len(gold), pred_len=len(pred)))
    gen.train()
    recalls_sorted = sorted(recalls)
    med = recalls_sorted[len(recalls_sorted) // 2] if recalls_sorted else 0.0
    return dict(n=len(rows), exact_match=round(n_em / max(1, len(rows)), 4),
                anchorRecallMean=round(sum(recalls) / max(1, len(recalls)), 4),
                anchorRecallMedian=round(med, 4),
                inventedAnchorsTotal=invented,
                charRatioGoldToPred=round(tot_g / max(1, tot_p), 4),
                per_sample=per)


if __name__ == "__main__":
    main()
