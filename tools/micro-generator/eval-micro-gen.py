#!/usr/bin/env python3
"""对已训好的微模型 checkpoint 重跑 dev 生成评测，落盘预测文本（供 7 轴判读）。

特性（v2）：
  * **双卡并行**：`torchrun --nproc_per_node=2` 时按行分片（rank 各做一半），rank0 合并并校验；
  * **进度与 ETA**：每条打印一次（无 KV cache 的实现，逐 token 前向很慢，必须看得见）；
  * **自适应长度**：max_new = min(cap, max(256, gold_tokens × 1.6 + 96))，避免过度生成。

用法（Kaggle，训练完成后新开 cell；推荐双卡）：
  python3 -m torch.distributed.run --nproc_per_node=2 --master_port=29519 \
      tools/micro-generator/eval-micro-gen.py --ckpt <run目录> \
      --corpus transfer/models/micro-generator-gen-v3 --out <run目录> --device cuda --examples 3
  单卡则：python3 tools/micro-generator/eval-micro-gen.py --ckpt … --corpus … --out …
"""
from __future__ import annotations

import argparse, importlib.util, json, os, sys, time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FMT = _load("micro_format", HERE / "micro-format.py")
TM = _load("train_micro_gen", HERE / "train-micro-gen.py")  # 复用 MicroGPT / greedy_gen / anchor_recall / load_rows


def pick_ckpt(ckpt: Path) -> Path:
    if ckpt.is_dir():
        best, last = ckpt / "micro-gen-best.pt", ckpt / "micro-gen.pt"
        if best.exists():
            return best
        assert last.exists(), f"{ckpt} 下没有 micro-gen-best.pt / micro-gen.pt"
        return last
    return ckpt


def summarize(recs: list[dict], ckpt: str, elapsed: float) -> dict:
    recalls = sorted(r["proxy"]["recall"] for r in recs)
    n = len(recs)
    tot_g = sum(r["proxy"]["goldLen"] for r in recs)
    tot_p = sum(r["proxy"]["predLen"] for r in recs)
    return dict(
        n=n, exactMatch=round(sum(1 for r in recs if r["proxy"]["em"]) / max(1, n), 4),
        anchorRecallMean=round(sum(recalls) / max(1, n), 4),
        anchorRecallMedian=round(recalls[len(recalls) // 2] if recalls else 0.0, 4),
        anchorRecallP10=round(recalls[max(0, len(recalls) // 10 - 1)] if recalls else 0.0, 4),
        inventedAnchorsTotal=sum(r["proxy"]["invented"] for r in recs),
        charRatioGoldToPred=round(tot_g / max(1, tot_p), 4),
        truncatedOutputs=sum(1 for r in recs if r["proxy"]["truncated"]),
        emptyOutputs=sum(1 for r in recs if not r["prediction"].strip()),
        elapsedSec=round(elapsed, 1), ckpt=ckpt,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, help="run 目录或 .pt 文件")
    ap.add_argument("--corpus", required=True, help="含 dev.jsonl.gz 的目录")
    ap.add_argument("--out", default=None, help="输出目录（默认同 --ckpt 目录）")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--device", default=None, help="cuda | cpu | cuda:N（默认按 rank 自动）")
    ap.add_argument("--cap", type=int, default=1024, help="单条最长新生成 token（自适应上限）")
    ap.add_argument("--max-new", type=int, default=0, help=">0 时固定长度；0=按 gold 自适应")
    ap.add_argument("--examples", type=int, default=3, help="打印几条样例（rank0）")
    ap.add_argument("--gen-mode", choices=["auto", "cached", "plain"], default="auto",
                    help="auto=KV 缓存优先，异常回退；cached/plain=强制指定（用于 A/B）")
    ap.add_argument("--ctx-limit", type=int, default=8192,
                    help="prompt+生成长度上限；超过才截断（默认 8192，避免把长 prompt 静默切头）")
    args = ap.parse_args()

    rank = int(os.environ.get("RANK", 0))
    world = int(os.environ.get("WORLD_SIZE", 1))

    ckpt_p = pick_ckpt(Path(args.ckpt))
    out = Path(args.out) if args.out else ckpt_p.parent
    out.mkdir(parents=True, exist_ok=True)
    state = torch.load(ckpt_p, map_location="cpu")
    meta = state.get("meta", {})
    cfg = meta.get("cfg") or json.loads((ckpt_p.parent / "model-config.json").read_text())

    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(ckpt_p.parent / "tokenizer.json"))

    if world > 1:
        import torch.distributed as dist
        has_cuda = torch.cuda.is_available()
        dist.init_process_group("nccl" if has_cuda else "gloo")
        if has_cuda:
            torch.cuda.set_device(rank % torch.cuda.device_count())
    if args.device:
        device = args.device
        if world > 1 and device == "cuda":  # 多卡时 --device cuda 按 rank 分配，别都挤 cuda:0
            device = f"cuda:{rank % max(1, torch.cuda.device_count())}"
    elif torch.cuda.is_available():
        device = f"cuda:{rank % torch.cuda.device_count()}"
    else:
        device = "cpu"
    is_main = rank == 0

    if is_main:
        print(f"[ckpt] {ckpt_p} · cfg {cfg} · bestStep {meta.get('bestStep', -1)} · world {world}", flush=True)

    model = TM.MicroGPT(vocab=cfg["vocab"], d=cfg["d_model"], layers=cfg["layers"],
                        heads=cfg["heads"], ctx=cfg["ctx"], ffn_mult=cfg.get("ffn_mult", 4))
    model.load_state_dict(state["model"])
    model.to(device).eval()

    dev_rows = TM.load_rows(Path(args.corpus) / "dev.jsonl.gz")
    if args.limit:
        dev_rows = dev_rows[: args.limit]
    my = list(enumerate(dev_rows))[rank::world]      # [(原序号, 行)]，双卡各拿一半
    if is_main:
        print(f"[eval] 共 {len(dev_rows)} 条 · world {world} · 本 rank {len(my)} 条 · device {device}", flush=True)

    t0 = time.time()
    recs: list[tuple[int, dict]] = []
    shard_p = out / f"dev-predictions.shard{rank}.jsonl"
    with open(shard_p, "w") as f:
        for k, (idx, r) in enumerate(my):
            prompt, _ = FMT.row_to_texts(r)
            gold = FMT.assistant_text(r)
            if args.max_new:
                max_new = args.max_new
            else:
                g_tok = len(tok.encode(gold).ids)
                max_new = int(min(args.cap, max(256, g_tok * 1.6 + 96)))
            gen_ctx = args.ctx_limit   # 只是"prompt+生成"的硬上限，不是训练 ctx
            if args.gen_mode == "plain":
                pred = TM.greedy_gen(model, tok, prompt, max_new=max_new, ctx=gen_ctx, device=device)
            elif args.gen_mode == "cached":
                pred = TM.greedy_gen_cached(model, tok, prompt, max_new=max_new, ctx=gen_ctx, device=device)
            else:
                try:
                    pred = TM.greedy_gen_cached(model, tok, prompt, max_new=max_new, ctx=gen_ctx, device=device)
                except Exception as exc:
                    print(f"[warn] KV 缓存生成失败（{type(exc).__name__}: {exc}）；回退慢速实现", flush=True)
                    pred = TM.greedy_gen(model, tok, prompt, max_new=max_new, ctx=gen_ctx, device=device)
            rec, inv, na = TM.anchor_recall(gold, pred)
            truncated = len(tok.encode(pred).ids) >= max_new
            obj = dict(idx=idx, unitId=r.get("unitId"), prediction=pred, gold=gold,
                       proxy=dict(recall=round(rec, 4), nAnchors=na, invented=inv,
                                  em=pred.strip() == gold.strip(),
                                  goldLen=len(gold), predLen=len(pred),
                                  truncated=truncated, maxNew=max_new))
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
            f.flush()
            recs.append((idx, obj))
            el = time.time() - t0
            per = el / (k + 1)
            eta = per * (len(my) - k - 1)
            print(f"[eval r{rank}] {k+1}/{len(my)} · {el:.0f}s（均 {per:.1f}s/条，剩约 {eta/60:.1f} 分钟）"
                  f" · recall {rec:.2f} · gen {len(pred)}c", flush=True)

    if world > 1:
        import torch.distributed as dist
        dist.barrier()

    if is_main:
        merged: dict[int, dict] = {}
        for rk in range(world):
            p = out / f"dev-predictions.shard{rk}.jsonl"
            for line in p.read_text().splitlines():
                if line.strip():
                    o = json.loads(line)
                    merged[o["idx"]] = o
        ordered = [merged[i] for i in sorted(merged)]
        assert len(ordered) == len(dev_rows), f"合并后 {len(ordered)} != {len(dev_rows)}"
        with open(out / "dev-predictions.jsonl", "w") as f:
            for o in ordered:
                o.pop("idx", None)
                f.write(json.dumps(o, ensure_ascii=False) + "\n")
        summary = summarize(ordered, str(ckpt_p), time.time() - t0)
        summary["worldSize"] = world
        summary["genMode"] = args.gen_mode
        summary["ctxLimit"] = args.ctx_limit
        summary["modelCtx"] = cfg.get("ctx")
        (out / "dev-predictions-summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        for rk in range(world):
            (out / f"dev-predictions.shard{rk}.jsonl").unlink(missing_ok=True)
        print("[summary] " + json.dumps(summary, ensure_ascii=False), flush=True)
        if args.examples:
            print("\n=== 样例（前几条，各截 300 字）===", flush=True)
            for o in ordered[: args.examples]:
                print(f"--- {o['unitId']} · recall {o['proxy']['recall']} · "
                      f"ratio {o['proxy']['goldLen']/max(1,o['proxy']['predLen']):.2f}")
                print("GOLD:", o["gold"][:300].replace("\n", " ⏎ "))
                print("PRED:", o["prediction"][:300].replace("\n", " ⏎ ") or "<空>", flush=True)
        print(f"\n[done] 预测已落盘 {out/'dev-predictions.jsonl'}"
              f"（{(out/'dev-predictions.jsonl').stat().st_size/1024:.0f} KB）", flush=True)

    if world > 1:
        import torch.distributed as dist
        dist.barrier()
        dist.destroy_process_group()
    return 0


if __name__ == "__main__":
    sys.exit(main())
