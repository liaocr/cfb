#!/usr/bin/env python3
"""诊断：为什么"训练损失正常、生成却是空白行"。

对每条 dev 行打印：
  1. prompt 的 token 长度 vs ctx vs max_new ⇒ 生成时是否发生了静默截断；
  2. prompt 末尾 8 个 token 的解码（确认确实以 <|asst|> 结尾）；
  3. teacher-forced 首字预测（单次前向，分别喂「完整 prompt」和「截断 prompt」）⇒ 模型真实认为该写什么；
  4. 三种生成的输出对比：cached+截断 / 无缓存+截断 / cached+不截断。

判读：
  * teacher-forced 首字正常，但 cached 生成是空白 ⇒ KV 缓存路径有 bug；
  * cached 与无缓存结果一致（都空白），而"不截断"正常 ⇒ ctx 截断是元凶；
  * teacher-forced 首字本身就是换行/下划线 ⇒ 模型或数据侧问题（与生成路径无关）。

用法：
  python3 tools/micro-generator/diag-micro-gen.py --ckpt <run目录> \
      --corpus transfer/models/micro-generator-gen-v4 --rows 3 --device cuda
"""
from __future__ import annotations

import argparse, importlib.util, json, sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, Path(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FMT = _load("micro_format", HERE / "micro-format.py")
TM = _load("train_micro_gen", HERE / "train-micro-gen.py")


def pick_ckpt(p: Path) -> Path:
    if p.is_dir():
        for name in ("micro-gen-best.pt", "micro-gen.pt"):
            if (p / name).exists():
                return p / name
        raise SystemExit(f"{p} 下没有 micro-gen-best.pt / micro-gen.pt")
    return p


def brief(s: str, n: int = 160) -> str:
    return (s.strip() or "<空>")[:n].replace("\n", "⏎")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--rows", type=int, default=3)
    ap.add_argument("--device", default=None)
    ap.add_argument("--max-new", type=int, default=200, help="诊断用固定生成长度（不做自适应）")
    args = ap.parse_args()

    ckpt = pick_ckpt(Path(args.ckpt))
    state = torch.load(ckpt, map_location="cpu")
    meta = state.get("meta", {})
    cfg = meta.get("cfg") or json.loads((ckpt.parent / "model-config.json").read_text())

    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(ckpt.parent / "tokenizer.json"))

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    model = TM.MicroGPT(vocab=cfg["vocab"], d=cfg["d_model"], layers=cfg["layers"],
                        heads=cfg["heads"], ctx=cfg["ctx"], ffn_mult=cfg.get("ffn_mult", 4))
    model.load_state_dict(state["model"])
    model.to(device).eval()
    ctx = cfg["ctx"]

    print(json.dumps(dict(ckpt=str(ckpt), ctx=ctx, bestStep=meta.get("bestStep"),
                          device=device, vocab=cfg["vocab"],
                          asstId=tok.token_to_id(FMT.ASST_OPEN), endId=tok.token_to_id(FMT.END)),
                     ensure_ascii=False), flush=True)

    rows = TM.load_rows(Path(args.corpus) / "dev.jsonl.gz")[: args.rows]
    for r in rows:
        prompt, _ = FMT.row_to_texts(r)
        gold = FMT.assistant_text(r)
        pids = tok.encode(prompt).ids
        gids = tok.encode(gold).ids
        max_new = args.max_new
        clip = max(1, ctx - max_new - 1)
        clipped = pids[-clip:]
        cut = len(clipped) < len(pids)
        print(f"\n=== {r.get('unitId')} ===")
        print(f"  prompt {len(pids)} tok · gold {len(gids)} tok · ctx {ctx} · max_new {max_new} "
              f"⇒ 生成时截断到 {len(clipped)} tok {'【发生截断！丢掉 '+str(len(pids)-len(clipped))+' tok】' if cut else '（未截断）'}")
        print(f"  prompt 末尾 8 tok: {[tok.decode([i]) for i in pids[-8:]]}")
        print(f"  gold 开头: {brief(gold, 120)}")

        with torch.no_grad():
            for label, ids in (("完整", pids), ("截断", clipped)):
                logits = model(torch.tensor([ids], device=device))
                top = torch.topk(logits[0, -1].float(), 5)
                tops = [f"{tok.decode([int(i)]).replace(chr(10),'⏎')[:16]}({float(v):.2f})"
                        for v, i in zip(top.values, top.indices)]
                print(f"  [teacher-forced/{label}] 首字 top5: {' | '.join(tops)}", flush=True)

        out_cached_clip = TM.greedy_gen_cached(model, tok, prompt, max_new=max_new, ctx=ctx, device=device)
        out_plain_clip = TM.greedy_gen(model, tok, prompt, max_new=max_new, ctx=ctx, device=device)
        out_cached_full = TM.greedy_gen_cached(model, tok, prompt, max_new=max_new, ctx=99999, device=device)
        print(f"  [cached+截断 ] {len(out_cached_clip):5d}c: {brief(out_cached_clip)}")
        print(f"  [无缓存+截断] {len(out_plain_clip):5d}c: {brief(out_plain_clip)}")
        print(f"  [cached+不截断] {len(out_cached_full):5d}c: {brief(out_cached_full)}")
        print(f"  [一致性] cached+截断 == 无缓存+截断 ? {out_cached_clip == out_plain_clip}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
