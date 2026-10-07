#!/usr/bin/env python3
"""从零训练「任务专用微模型」—— 手写小 GPT，不依赖任何预训练权重。

带防过拟合仪表：
  * dev 损失曲线（每 N 步只在前向算答案段 CE，几分钟内可完成，不用生成）
  * best checkpoint（按 dev 损失挑），可早停（连续多次不改善即停）
  * 训练结束用 best checkpoint 做生成评测

用法：
  python3 micro-tokenizer.py --train <train.jsonl.gz> [--extra-text <seed.txt>] --vocab-size 24576 --out <dir>/tokenizer.json
  python3 train-micro-gen.py --corpus <v3 目录> --out <dir> --tokenizer <dir>/tokenizer.json
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
        self.attn = nn.MultiheadAttention(d, n_head, batch_first=True)
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
        self.head.weight = self.tok_emb.weight  # 权重共享：词表大也不额外翻倍
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
    """全部样本编码成一条 token 流，切成 ctx 长的块（无 padding 浪费）。"""
    ids: list[int] = []
    for i, r in enumerate(rows):
        if max_docs and i >= max_docs:
            break
        _, full = FMT.row_to_texts(r)
        ids.extend(tok.encode(full).ids)
        ids.append(eos_id)
    n = (len(ids) - 1) // ctx
    return [ids[i * ctx : (i + 1) * ctx] for i in range(max(0, n))]


# ---------------------------------------------------------------- 防过拟合仪表
def dev_loss(base, tok, dev_rows, device, limit=0, max_row_tokens=4096):
    """dev 集答案段 CE（与训练 loss 同口径）。纯前向，代价小。
    返回 (loss, 参与行数, 跳过行数)。"""
    rows = dev_rows[:limit] if limit else dev_rows
    base.eval()
    total, n, skipped = 0.0, 0, 0
    use_amp = device.startswith("cuda")
    with torch.no_grad():
        for r in rows:
            prompt, full = FMT.row_to_texts(r)
            ids = tok.encode(full).ids
            plen = len(tok.encode(prompt).ids)
            if len(ids) > max_row_tokens:      # 超长行截断（prompt 至少留 32 token 的下文）
                ids = ids[:max_row_tokens]
                plen = min(plen, max_row_tokens - 32)
                skipped += 1
            if len(ids) < 8 or plen >= len(ids) - 1:
                skipped += 1
                continue
            x = torch.tensor([ids[:-1]], device=device)
            lab = [(-100 if (t + 1) < plen else ids[t + 1]) for t in range(len(ids) - 1)]
            y = torch.tensor([lab], device=device)
            with torch.autocast("cuda", dtype=torch.float16, enabled=use_amp):
                _, loss = base(x, y)
            total += float(loss.detach()) if loss.dim() == 0 else float(loss.mean().detach())
            n += 1
    base.train()
    return (total / n if n else float("nan")), n, skipped


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
    ap.add_argument("--vocab-size", type=int, default=24576)
    ap.add_argument("--tokenizer", default=None, help="已有 tokenizer.json；缺省时用 out/tokenizer.json")
    ap.add_argument("--ctx", type=int, default=2048)
    ap.add_argument("--d-model", type=int, default=512)
    ap.add_argument("--layers", type=int, default=8)
    ap.add_argument("--heads", type=int, default=8)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--warmup", type=int, default=50)
    ap.add_argument("--steps", type=int, default=1200)
    ap.add_argument("--time-budget-sec", type=float, default=0.0)
    ap.add_argument("--limit-docs", type=int, default=0)
    ap.add_argument("--eval-limit", type=int, default=0)
    ap.add_argument("--eval-max-new", type=int, default=1024)
    ap.add_argument("--dump-predictions", action="store_true", help="评测时落盘 dev-predictions.jsonl")
    # —— 防过拟合仪表 ——
    ap.add_argument("--devloss-every", type=int, default=0, help="每 N 步算一次 dev 损失（0=关闭）")
    ap.add_argument("--devloss-limit", type=int, default=64, help="dev 损失用多少行")
    ap.add_argument("--devloss-max-tokens", type=int, default=4096)
    ap.add_argument("--early-stop-patience", type=int, default=0, help="dev 连续 N 次不改善即停（0=关）")
    ap.add_argument("--log-every", type=int, default=10)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    if args.threads:
        torch.set_num_threads(args.threads)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    corpus = Path(args.corpus)

    rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    has_cuda = torch.cuda.is_available()
    if world > 1:
        torch.distributed.init_process_group("nccl" if has_cuda else "gloo")
        if has_cuda:
            torch.cuda.set_device(local_rank)
    device = f"cuda:{local_rank}" if has_cuda else "cpu"
    is_main = rank == 0

    from tokenizers import Tokenizer

    tok_path = Path(args.tokenizer) if args.tokenizer else out / "tokenizer.json"
    if not tok_path.exists():
        raise SystemExit(f"缺词表 {tok_path}；先跑 micro-tokenizer.py")
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
        model = nn.parallel.DistributedDataParallel(model, device_ids=[local_rank] if has_cuda else None)
        chunks_per_rank = chunks[rank::world]
    else:
        chunks_per_rank = chunks
    base = model.module if world > 1 else model

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.1, betas=(0.9, 0.95))
    use_amp = device.startswith("cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    step, t_start = 0, time.time()

    def lr_at(s):
        if s < args.warmup:
            return args.lr * (s + 1) / max(1, args.warmup)
        p = min(1.0, (s - args.warmup) / max(1, args.steps - args.warmup))
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))

    model.train()
    order: list[int] = []
    curve: list[dict] = []
    best = {"devLoss": float("inf"), "step": -1}
    patience = 0
    stop = False

    def snapshot(tag: str):
        torch.save({"model": base.state_dict(),
                    "meta": dict(step=step, wallSec=round(time.time() - t_start, 1), cfg=base.cfg,
                                 tag=tag, best=best, devLossCurve=curve)}, out / f"micro-gen{tag}.pt")

    while step < args.steps and not stop:
        if not order:
            order = torch.randperm(len(chunks_per_rank)).tolist()
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
        step += 1

        if is_main and step % args.log_every == 0:
            print(f"[train] step {step}/{args.steps} loss {float(loss.detach()):.4f} "
                  f"lr {lr_at(step-1):.2e} ({time.time()-t_start:.0f}s)", flush=True)

        # —— dev 损失仪表（只在主 rank 算；停止标志广播给所有 rank）——
        if dev_rows and args.devloss_every and step % args.devloss_every == 0:
            if is_main:
                dl, ndev, nskip = dev_loss(base, tok, dev_rows, device,
                                           limit=args.devloss_limit, max_row_tokens=args.devloss_max_tokens)
                tl = round(float(loss.detach()), 4)
                curve.append(dict(step=step, trainLoss=tl, devLoss=round(dl, 4), rows=ndev, skipped=nskip))
                print(f"[devloss] step {step} train {tl:.4f} dev {dl:.4f} gap {dl-tl:+.4f} "
                      f"({ndev} 行{('，跳过 '+str(nskip)) if nskip else ''}) — 看 gap 有没有掉头向上", flush=True)
                if dl < best["devLoss"] - 1e-4:
                    best = {"devLoss": dl, "step": step}
                    patience = 0
                    snapshot("-best")
                    print(f"[devloss] ↑ 新最优（step {step}），已存 micro-gen-best.pt", flush=True)
                else:
                    patience += 1
                    if args.early_stop_patience and patience >= args.early_stop_patience:
                        stop = True
                        print(f"[early-stop] dev 连续 {patience} 次未改善；"
                              f"最优 step {best['step']} dev {best['devLoss']:.4f}，停在这里", flush=True)
            if world > 1:
                flag = torch.tensor([1 if stop else 0], device=device)
                torch.distributed.broadcast(flag, 0)
                stop = bool(flag.item())

        if not stop and args.time_budget_sec and time.time() - t_start > args.time_budget_sec:
            if is_main:
                print(f"[train] 到时间预算 {args.time_budget_sec:.0f}s，停在 step {step}", flush=True)
            stop = True
            if world > 1:
                flag = torch.tensor([1], device=device)
                torch.distributed.broadcast(flag, 0)

    if world > 1:
        torch.distributed.barrier()
    if is_main:
        snapshot("")

    # --- dev 生成评测：优先用 best checkpoint（防"最后一版恰好过拟合"）
    if is_main and dev_rows:
        best_p = out / "micro-gen-best.pt"
        if best_p.exists():
            base.load_state_dict(torch.load(best_p, map_location=device)["model"])
            print(f"[eval] 载入 best checkpoint（step {best['step']} dev {best['devLoss']:.4f}）", flush=True)
        ev = evaluate(base, tok, dev_rows, device, ctx=args.ctx, limit=args.eval_limit,
                      max_new=args.eval_max_new,
                      dump_path=(out / "dev-predictions.jsonl") if args.dump_predictions else None)
        ev["devLossCurve"] = curve
        ev["bestDevLoss"] = best["devLoss"]
        ev["bestStep"] = best["step"]
        (out / "dev-metrics.json").write_text(json.dumps(ev, indent=2, ensure_ascii=False))
        print("[eval] " + json.dumps({k: v for k, v in ev.items() if k != "per_sample"}, ensure_ascii=False), flush=True)
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


# ---------------------------------------------------------------- 评测（内部代理）
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


def evaluate(model, tok, dev_rows, device, ctx=2048, limit=0, max_new=1024, dump_path: Path | None = None,
             progress: bool = True):
    """内部代理指标：锚点召回（正则代理）、压缩比、精确匹配。真验收是 7 轴判定，不在本地冒充。
    dump_path 非空时，同时写预测文本（unitId/prediction/gold/proxy），供 7 轴判读。"""
    gen = model.module if hasattr(model, "module") else model
    gen.eval()
    rows = dev_rows[:limit] if limit else dev_rows
    n_em = 0; tot_g = tot_p = 0; recalls = []; invented = 0
    per = []
    dump = open(dump_path, "w") if dump_path else None
    t0 = time.time()
    for i, r in enumerate(rows):
        prompt, full = FMT.row_to_texts(r)
        gold = FMT.assistant_text(r)
        if max_new and max_new > 0:
            eff_new = max_new
        else:  # 自适应：按 gold 长度（无 KV cache 的逐 token 前向很慢，别一律生成满额）
            eff_new = int(min(1024, max(256, len(tok.encode(gold).ids) * 1.6 + 96)))
        pred = greedy_gen(gen, tok, prompt, max_new=eff_new, ctx=ctx, device=device)
        rec, inv, na = anchor_recall(gold, pred)
        recalls.append(rec); invented += inv
        tot_g += len(gold); tot_p += len(pred)
        em = pred.strip() == gold.strip()
        n_em += em
        entry = dict(recall=round(rec, 4), invented=inv, n_anchors=na, em=em,
                     gold_len=len(gold), pred_len=len(pred))
        per.append(entry)
        if dump:
            dump.write(json.dumps(dict(unitId=r.get("unitId"), prediction=pred, gold=gold,
                                       proxy=entry), ensure_ascii=False) + "\n")
            dump.flush()
        if progress:
            el = time.time() - t0
            avg = el / (i + 1)
            print(f"[eval] {i+1}/{len(rows)} · {el:.0f}s（均 {avg:.1f}s/条，剩约 {avg*(len(rows)-i-1)/60:.1f} 分钟）"
                  f" · recall {rec:.2f} · gen {len(pred)}c", flush=True)
    if dump:
        dump.close()
    gen.train()
    rs = sorted(recalls)
    med = rs[len(rs) // 2] if rs else 0.0
    return dict(n=len(rows), exact_match=round(n_em / max(1, len(rows)), 4),
                anchorRecallMean=round(sum(recalls) / max(1, len(recalls)), 4),
                anchorRecallMedian=round(med, 4),
                inventedAnchorsTotal=invented,
                charRatioGoldToPred=round(tot_g / max(1, tot_p), 4),
                per_sample=per)


if __name__ == "__main__":
    main()
